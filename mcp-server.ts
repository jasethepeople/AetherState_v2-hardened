import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import { z } from 'zod';
import winston from 'winston';
import fs from 'fs';
import { verifyDocAccess, AuthenticatedRequest } from './auth';

// Winston file transports do not create their directory — ensure it exists.
fs.mkdirSync('logs', { recursive: true });

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

// NOTE (review 2026-10-02): mutations are forwarded to the bridge over HTTP.
// The bridge exposes POST /mutate and GET /docs/:docId; the previous code
// tried to reach it through a WebSocket pool aimed at the bridge's HTTP-only
// port, with the pool handle read from the wrong object (req instead of the
// app) — every mutation failed. HTTP forwarding uses the API the bridge
// actually speaks.
const BRIDGE_URL = (process.env.BRIDGE_URL || 'http://localhost:8080').replace(/\/$/, '');

class BridgeError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

async function forwardToBridge(path: string, body: any | undefined, authHeader?: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        // Ruling 2026-10-02 (H1): the bridge enforces RS256 auth itself
        // (defense in depth — its port is published). Forward the caller's
        // original Authorization header so the bridge sees the end-user's
        // token, not an MCP-service identity.
        if (authHeader) {
            headers['Authorization'] = authHeader;
        }
        const resp = await fetch(`${BRIDGE_URL}${path}`, {
            method: body ? 'POST' : 'GET',
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new BridgeError(resp.status, `Bridge request failed: ${resp.status} ${text}`.trim());
        }
        return await resp.json();
    } catch (err) {
        if (err instanceof BridgeError) throw err;
        throw new BridgeError(502, `Bridge unreachable: ${(err as Error).message}`);
    } finally {
        clearTimeout(timer);
    }
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
    // NOTE (review 2026-10-02): bridge failures carry their own status
    // (502 unreachable, 404 from the bridge, ...). Only truly unknown errors
    // become opaque 500s.
    if (err instanceof BridgeError) {
        return res.status(err.statusCode).json({ error: err.message });
    }
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

mcpServer.get('/metrics', verifyDocAccess(() => '*'), (req, res) => {
    res.json({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: Date.now()
    });
});

// NOTE (review 2026-10-02): verifyDocAccess runs BEFORE mutateLimiter so the
// limiter's keyGenerator actually sees req.actorId (per-actor limiting per
// ADR-005). Previously the limiter ran first and always fell back to IP.
mcpServer.post(
    '/docs/:docId/mutate',
    verifyDocAccess(req => req.params.docId),
    mutateLimiter,
    auditLog('DOCUMENT_MUTATE'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const validated = mutateSchema.parse(req.body);
            const { key, value } = validated;
            const { docId } = req.params;
            const actorId = req.actorId!;

            logger.info('Processing mutation', { docId, key, actorId });

            const result = await forwardToBridge('/mutate', {
                docId,
                key,
                value,
                actorId,
                timestamp: Date.now(),
            }, req.headers.authorization);
            res.json({ status: 'accepted', docId, key, actorId, opId: result?.opId });
        } catch (err) {
            if (err instanceof z.ZodError) {
                logger.warn('Validation failed', { errors: err.errors });
                return res.status(400).json({
                    error: 'Validation failed',
                    details: err.errors
                });
            }
            // Express 4 does not catch async rejections — hand them to the
            // centralized error handler explicitly.
            next(err);
        }
    }
);

mcpServer.get(
    '/docs/:docId',
    verifyDocAccess(req => req.params.docId),
    auditLog('DOCUMENT_READ'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            // NOTE (review 2026-10-02): this used to return a stub
            // { docId, status: 'active' }. Proxy the bridge's real endpoint.
            const doc = await forwardToBridge(
                `/docs/${encodeURIComponent(req.params.docId)}`,
                undefined,
                req.headers.authorization
            );
            res.json(doc);
        } catch (err) {
            if (err instanceof BridgeError && err.statusCode === 404) {
                return res.status(404).json({ error: 'Document not found' });
            }
            next(err);
        }
    }
);

mcpServer.use(errorHandler);

// NOTE (review 2026-10-02): the module previously never called listen(), so
// `npm run start:mcp` (used by docker-compose) started a process that did
// nothing and exited. Standalone boot only when run directly; index.ts
// manages the app itself when orchestrating.
if (require.main === module) {
    const port = parseInt(process.env.MCP_PORT || '3000');
    mcpServer.listen(port, () => {
        logger.info(`MCP Server listening on port ${port}`);
    });
}

export { mcpServer, logger };
