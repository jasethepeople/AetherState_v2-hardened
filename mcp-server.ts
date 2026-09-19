import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import { z } from 'zod';
import winston from 'winston';
import { WebSocketPool } from './websocket-pool';

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'aetherstate-mcp' },
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' })
    ]
});

interface DocClaims {
    sub: string;
    docIds: string[];
    iat: number;
    exp: number;
}

interface AuthenticatedRequest extends Request {
    actorId?: string;
    claims?: DocClaims;
}

const mutateSchema = z.object({
    key: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_\/\-\.]+$/),
    value: z.any().refine(
        (val) => {
            const str = JSON.stringify(val);
            return str.length <= 1024 * 1024;
        },
        { message: 'Value exceeds 1MB size limit' }
    )
});

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { error: 'Too many requests from this IP' },
    standardHeaders: true,
    legacyHeaders: false,
});

const mutateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: (req: AuthenticatedRequest) => req.actorId || req.ip || 'unknown',
    message: { error: 'Mutation rate limit exceeded' },
    standardHeaders: true,
});

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

async function verifyDocAccess(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
        logger.warn('Missing or invalid authorization header', {
            ip: req.ip,
            path: req.path,
            docId: req.params.docId
        });
        return res.status(401).json({ error: 'Missing bearer token' });
    }

    const token = authHeader.slice(7);
    let claims: DocClaims;

    try {
        claims = jwt.verify(token, JWT_PUBLIC_KEY, {
            algorithms: ['RS256'],
            clockTolerance: 30
        }) as DocClaims;
    } catch (err) {
        logger.warn('JWT verification failed', {
            ip: req.ip,
            error: err instanceof Error ? err.message : 'Unknown error',
            docId: req.params.docId
        });
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (!claims.sub || !Array.isArray(claims.docIds)) {
        logger.warn('Malformed JWT claims', { ip: req.ip, docId: req.params.docId });
        return res.status(401).json({ error: 'Malformed token claims' });
    }

    const { docId } = req.params;
    if (!claims.docIds.includes('*') && !claims.docIds.includes(docId)) {
        logger.warn('Unauthorized document access attempt', {
            actorId: claims.sub,
            docId,
            allowedDocs: claims.docIds
        });
        return res.status(403).json({ error: 'Not authorized for this document' });
    }

    req.actorId = claims.sub;
    req.claims = claims;
    next();
}

function auditLog(action: string) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        const originalSend = res.send.bind(res);
        res.send = function(body: any) {
            logger.info('Audit log', {
                action,
                actorId: req.actorId,
                docId: req.params.docId,
                statusCode: res.statusCode,
                ip: req.ip,
                userAgent: req.get('user-agent'),
                timestamp: new Date().toISOString()
            });
            return originalSend(body);
        };
        next();
    };
}

function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
    logger.error('Unhandled error', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method
    });
    res.status(500).json({ error: 'Internal server error' });
}

const mcpServer = express();

mcpServer.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            connectSrc: ["'self'", "wss:", "ws:"],
        }
    }
}));

mcpServer.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

mcpServer.use(express.json({ limit: '1mb' }));
mcpServer.use(globalLimiter);

mcpServer.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '2.0.0'
    });
});

mcpServer.get('/metrics', (req, res) => {
    res.json({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: Date.now()
    });
});

mcpServer.post(
    '/docs/:docId/mutate',
    mutateLimiter,
    verifyDocAccess,
    auditLog('DOCUMENT_MUTATE'),
    async (req: AuthenticatedRequest, res: Response) => {
        try {
            const validated = mutateSchema.parse(req.body);
            const { key, value } = validated;
            const { docId } = req.params;
            const actorId = req.actorId!;

            logger.info('Processing mutation', { docId, key, actorId });

            const bridgePool = (req as any).bridgePool as WebSocketPool;
            if (!bridgePool) {
                throw new Error('Bridge pool not configured');
            }

            const bridge = await bridgePool.acquire();
            try {
                await sendToBridge(bridge, docId, key, value, actorId);
                res.json({ status: 'accepted', docId, key, actorId });
            } finally {
                bridgePool.release(bridge);
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                logger.warn('Validation failed', { errors: err.errors });
                return res.status(400).json({
                    error: 'Validation failed',
                    details: err.errors
                });
            }
            throw err;
        }
    }
);

mcpServer.get(
    '/docs/:docId',
    verifyDocAccess,
    auditLog('DOCUMENT_READ'),
    async (req: AuthenticatedRequest, res: Response) => {
        const { docId } = req.params;
        res.json({
            docId,
            status: 'active',
        });
    }
);

async function sendToBridge(
    bridge: any,
    docId: string,
    key: string,
    value: any,
    actorId: string
): Promise<void> {
    return new Promise((resolve, reject) => {
        const message = JSON.stringify({
            type: 'mutate',
            docId,
            key,
            value,
            actorId,
            timestamp: Date.now()
        });

        bridge.send(message, (err: Error | undefined) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

mcpServer.use(errorHandler);

export { mcpServer, logger };
