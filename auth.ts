import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import winston from 'winston';
import fs from 'fs';

// Winston file transports do not create their directory — ensure it exists.
fs.mkdirSync('logs', { recursive: true });

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'aetherstate-auth' },
    transports: [new winston.transports.Console()],
});

export interface DocClaims {
    sub: string;
    docIds: string[];
    iat: number;
    exp: number;
}

export interface AuthenticatedRequest extends Request {
    actorId?: string;
    claims?: DocClaims;
}

function validateJwtConfig(): string {
    let publicKey = process.env.JWT_PUBLIC_KEY;
    if (!publicKey) {
        throw new Error('JWT_PUBLIC_KEY environment variable is required');
    }
    publicKey = publicKey.replace(/\\n/g, '\n').trim();
    if (!publicKey.includes('BEGIN PUBLIC KEY') && !publicKey.includes('BEGIN RSA PUBLIC KEY')) {
        throw new Error('JWT_PUBLIC_KEY must be a valid PEM formatted public key');
    }
    return publicKey;
}

const JWT_PUBLIC_KEY = validateJwtConfig();

/**
 * RS256 JWT middleware enforcing document-level access (ADR-004:
 * "JWT across MCP, Bridge, Signaling").
 *
 * Shared by the MCP server and the bridge — the bridge re-verifies the
 * caller's token itself (defense in depth; its port is published in
 * docker-compose), so there is exactly one auth scheme, not two.
 *
 * `getDocId` extracts the target document id from the request: MCP routes
 * carry it in `req.params.docId`, the bridge's `POST /mutate` carries it in
 * `req.body.docId`.
 *
 * Behavior: 401 on missing/invalid/malformed token, 403 when the token's
 * `docIds` claim does not include the target document (or `*`).
 */
export function verifyDocAccess(getDocId: (req: Request) => string | undefined) {
    return async function verifyDocAccessMiddleware(
        req: AuthenticatedRequest,
        res: Response,
        next: NextFunction
    ) {
        const authHeader = req.headers.authorization;

        if (!authHeader?.startsWith('Bearer ')) {
            logger.warn('Missing or invalid authorization header', {
                ip: req.ip,
                path: req.path,
            });
            return res.status(401).json({ error: 'Missing bearer token' });
        }

        const token = authHeader.slice(7);
        let claims: DocClaims;

        try {
            claims = jwt.verify(token, JWT_PUBLIC_KEY, {
                algorithms: ['RS256'],
                clockTolerance: 30,
            }) as DocClaims;
        } catch (err) {
            logger.warn('JWT verification failed', {
                ip: req.ip,
                error: err instanceof Error ? err.message : 'Unknown error',
            });
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        if (!claims.sub || !Array.isArray(claims.docIds)) {
            logger.warn('Malformed JWT claims', { ip: req.ip });
            return res.status(401).json({ error: 'Malformed token claims' });
        }

        const docId = getDocId(req);
        // A request that names no document cannot be authorized for one.
        if (docId === undefined || (!claims.docIds.includes('*') && !claims.docIds.includes(docId))) {
            logger.warn('Unauthorized document access attempt', {
                actorId: claims.sub,
                docId,
                allowedDocs: claims.docIds,
            });
            return res.status(403).json({ error: 'Not authorized for this document' });
        }

        req.actorId = claims.sub;
        req.claims = claims;
        next();
    };
}
