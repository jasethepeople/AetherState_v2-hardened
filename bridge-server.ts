import express, { Request, Response } from 'express';
import { createClient, RedisClientType } from 'redis';
import { Pool, PoolClient } from 'pg';
import { EventEmitter } from 'events';
import winston from 'winston';
import * as Y from 'yjs';

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'aetherstate-bridge' },
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/bridge-error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/bridge-combined.log' })
    ]
});

interface DocumentState {
    doc: Y.Doc;
    syncState: any;
    lastAccessed: number;
    createdAt: number;
    actorIds: Set<string>;
    operationCount: number;
    dirty: boolean;
}

interface MutationRequest {
    docId: string;
    key: string;
    value: any;
    actorId: string;
    timestamp: number;
    idempotencyKey?: string;
}

interface BridgeConfig {
    redisUrl: string;
    postgresUrl: string;
    docTTL: number;
    maxDocSize: number;
    snapshotInterval: number;
    enableEmbedding: boolean;
    postgresPoolSize: number;
}

class AetherBridge extends EventEmitter {
    private docStates: Map<string, DocumentState> = new Map();
    private redis: RedisClientType;
    private pgPool: Pool;
    private config: BridgeConfig;
    private isShuttingDown = false;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private snapshotInterval: NodeJS.Timeout | null = null;
    private processedOps: Set<string> = new Set();
    private pgInitialized = false;

    constructor(config: BridgeConfig) {
        super();
        this.config = {
            redisUrl: config.redisUrl || 'redis://localhost:6379',
            postgresUrl: config.postgresUrl || 'postgresql://localhost:5432/aetherstate',
            docTTL: config.docTTL || 30 * 60 * 1000,
            maxDocSize: config.maxDocSize || 10000,
            snapshotInterval: config.snapshotInterval || 5 * 60 * 1000,
            enableEmbedding: config.enableEmbedding ?? true,
            postgresPoolSize: config.postgresPoolSize || 10
        };

        this.redis = createClient({ url: this.config.redisUrl });
        this.pgPool = new Pool({
            connectionString: this.config.postgresUrl,
            max: this.config.postgresPoolSize,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });

        this.setupRedisHandlers();
        this.setupPgHandlers();
    }

    private setupRedisHandlers(): void {
        this.redis.on('error', (err) => {
            logger.error('Redis error', { error: err.message });
            this.emit('redisError', err);
        });
        this.redis.on('connect', () => {
            logger.info('Connected to Redis');
            this.emit('redisConnected');
        });
    }

    private setupPgHandlers(): void {
        this.pgPool.on('error', (err) => {
            logger.error('PostgreSQL pool error', { error: err.message });
            this.emit('pgError', err);
        });
    }

    async initialize(): Promise<void> {
        await this.redis.connect();
        await this.initPostgres();
        this.startCleanupTimer();
        this.startSnapshotTimer();
        logger.info('Bridge initialized', { config: { ...this.config, postgresUrl: '[REDACTED]' } });
    }

    private async initPostgres(): Promise<void> {
        const client = await this.pgPool.connect();
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS documents (
                    doc_id VARCHAR(255) PRIMARY KEY,
                    state BYTEA NOT NULL,
                    operation_count INTEGER DEFAULT 0,
                    actor_count INTEGER DEFAULT 0,
                    last_accessed TIMESTAMP DEFAULT NOW(),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS operations (
                    id SERIAL PRIMARY KEY,
                    doc_id VARCHAR(255) REFERENCES documents(doc_id) ON DELETE CASCADE,
                    actor_id VARCHAR(255) NOT NULL,
                    op_key VARCHAR(512) NOT NULL,
                    op_value JSONB,
                    idempotency_key VARCHAR(255) UNIQUE,
                    embedding VECTOR(1536),
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_operations_doc_id ON operations(doc_id);
                CREATE INDEX IF NOT EXISTS idx_operations_idempotency ON operations(idempotency_key);
                CREATE INDEX IF NOT EXISTS idx_documents_last_accessed ON documents(last_accessed);
            `);

            this.pgInitialized = true;
            logger.info('PostgreSQL schema initialized');
        } finally {
            client.release();
        }
    }

    async mutate(req: MutationRequest): Promise<{ ok: boolean; actorId: string; opId: string }> {
        const { docId, key, value, actorId, idempotencyKey } = req;

        if (idempotencyKey && this.processedOps.has(idempotencyKey)) {
            logger.info('Duplicate operation detected, skipping', { idempotencyKey });
            return { ok: true, actorId, opId: idempotencyKey };
        }

        if (!docId || !key || typeof value === 'undefined') {
            throw new Error('Missing required fields: docId, key, or value');
        }

        let state = this.docStates.get(docId);
        if (!state) {
            state = await this.loadOrCreateDocument(docId);
        }

        state.lastAccessed = Date.now();
        state.actorIds.add(actorId);
        state.operationCount++;
        state.dirty = true;

        const opId = idempotencyKey || `${docId}:${actorId}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;

        try {
            const yMap = state.doc.getMap('data');
            yMap.set(key, value);

            const update = Y.encodeStateAsUpdate(state.doc);

            await this.persistToRedis(docId, state, update);
            await this.persistToPostgres(docId, state, update, actorId, key, value, opId);

            if (idempotencyKey) {
                this.processedOps.add(idempotencyKey);
                if (this.processedOps.size > 10000) {
                    const toRemove = Array.from(this.processedOps).slice(0, 5000);
                    toRemove.forEach(k => this.processedOps.delete(k));
                }
            }

            this.broadcastToMesh(docId, update, actorId);

            if (this.config.enableEmbedding) {
                this.indexOperation(docId, key, value, actorId, opId).catch(err => {
                    logger.error('Embedding indexing failed', { docId, error: err.message });
                });
            }

            logger.info('Mutation applied', { docId, key, actorId, opId });
            return { ok: true, actorId, opId };

        } catch (err) {
            logger.error('Mutation failed', { docId, key, actorId, error: (err as Error).message });
            throw err;
        }
    }

    private async loadOrCreateDocument(docId: string): Promise<DocumentState> {
        const redisData = await this.redis.get(`aetherstate:doc:${docId}`);
        const doc = new Y.Doc();

        if (redisData) {
            try {
                const buffer = Buffer.from(redisData, 'base64');
                Y.applyUpdate(doc, new Uint8Array(buffer));
                logger.info('Document loaded from Redis', { docId });
            } catch (err) {
                logger.warn('Redis load failed, trying PostgreSQL', { docId });
            }
        }

        if (!redisData) {
            try {
                const client = await this.pgPool.connect();
                try {
                    const result = await client.query(
                        'SELECT state FROM documents WHERE doc_id = $1',
                        [docId]
                    );
                    if (result.rows.length > 0) {
                        const buffer = result.rows[0].state;
                        Y.applyUpdate(doc, new Uint8Array(buffer));
                        logger.info('Document loaded from PostgreSQL', { docId });
                    }
                } finally {
                    client.release();
                }
            } catch (err) {
                logger.warn('PostgreSQL load failed, creating new document', { docId });
            }
        }

        const state: DocumentState = {
            doc,
            syncState: {},
            lastAccessed: Date.now(),
            createdAt: Date.now(),
            actorIds: new Set(),
            operationCount: 0,
            dirty: false
        };

        this.docStates.set(docId, state);
        return state;
    }

    private async persistToRedis(docId: string, state: DocumentState, update: Uint8Array): Promise<void> {
        try {
            const base64 = Buffer.from(update).toString('base64');
            await this.redis.setEx(
                `aetherstate:doc:${docId}`,
                Math.ceil(this.config.docTTL / 1000),
                base64
            );
        } catch (err) {
            logger.error('Redis persist failed', { docId, error: (err as Error).message });
        }
    }

    private async persistToPostgres(
        docId: string,
        state: DocumentState,
        update: Uint8Array,
        actorId: string,
        key: string,
        value: any,
        opId: string
    ): Promise<void> {
        if (!this.pgInitialized) return;

        const client = await this.pgPool.connect();
        try {
            await client.query('BEGIN');

            await client.query(`
                INSERT INTO documents (doc_id, state, operation_count, actor_count, last_accessed, updated_at)
                VALUES ($1, $2, $3, $4, NOW(), NOW())
                ON CONFLICT (doc_id) DO UPDATE SET
                    state = EXCLUDED.state,
                    operation_count = EXCLUDED.operation_count,
                    actor_count = EXCLUDED.actor_count,
                    last_accessed = NOW(),
                    updated_at = NOW()
            `, [docId, Buffer.from(update), state.operationCount, state.actorIds.size]);

            await client.query(`
                INSERT INTO operations (doc_id, actor_id, op_key, op_value, idempotency_key, created_at)
                VALUES ($1, $2, $3, $4, $5, NOW())
                ON CONFLICT (idempotency_key) DO NOTHING
            `, [docId, actorId, key, JSON.stringify(value), opId]);

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            logger.error('PostgreSQL persist failed', { docId, error: (err as Error).message });
        } finally {
            client.release();
        }
    }

    private broadcastToMesh(docId: string, update: Uint8Array, actorId: string): void {
        this.emit('broadcast', {
            docId,
            update: Buffer.from(update).toString('base64'),
            actorId,
            timestamp: Date.now()
        });
    }

    private async indexOperation(docId: string, key: string, value: any, actorId: string, opId: string): Promise<void> {
        const textContent = typeof value === 'string' ? value : JSON.stringify(value);
        logger.debug('Indexing operation', {
            docId, key, actorId, opId, contentLength: textContent.length
        });
    }

    async getDocument(docId: string): Promise<{ data: any; meta: any } | null> {
        let state = this.docStates.get(docId);

        if (!state) {
            state = await this.loadOrCreateDocument(docId);
        }

        state.lastAccessed = Date.now();

        const yMap = state.doc.getMap('data');
        const data: Record<string, any> = {};
        yMap.forEach((value, key) => {
            data[key] = value;
        });

        const meta = await this.redis.hGetAll(`aetherstate:meta:${docId}`);

        return { data, meta };
    }

    private startCleanupTimer(): void {
        this.cleanupInterval = setInterval(() => {
            this.cleanupOldDocuments();
        }, 60000);
    }

    private cleanupOldDocuments(): void {
        const now = Date.now();
        let cleaned = 0;

        for (const [docId, state] of this.docStates.entries()) {
            if (now - state.lastAccessed > this.config.docTTL) {
                if (state.dirty) {
                    const update = Y.encodeStateAsUpdate(state.doc);
                    this.persistToRedis(docId, state, update).catch(err => {
                        logger.error('Final persist failed', { docId, error: (err as Error).message });
                    });
                }
                state.doc.destroy();
                this.docStates.delete(docId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.info('Cleaned up old documents', { cleaned, remaining: this.docStates.size });
        }
    }

    private startSnapshotTimer(): void {
        this.snapshotInterval = setInterval(() => {
            this.snapshotAllDocuments();
        }, this.config.snapshotInterval);
    }

    private async snapshotAllDocuments(): Promise<void> {
        logger.debug('Starting snapshot cycle');
        const promises = Array.from(this.docStates.entries())
            .filter(([_, state]) => state.dirty)
            .map(async ([docId, state]) => {
                const update = Y.encodeStateAsUpdate(state.doc);
                await this.persistToRedis(docId, state, update);
                await this.persistToPostgres(docId, state, update, 'system', 'snapshot', {}, `snapshot:${docId}:${Date.now()}`);
                state.dirty = false;
            });

        await Promise.all(promises);
        logger.debug('Snapshot cycle complete');
    }

    getMetrics(): { documents: number; operations: number; actors: number; redisConnected: boolean; pgConnected: boolean } {
        let totalOps = 0;
        let totalActors = 0;

        for (const state of this.docStates.values()) {
            totalOps += state.operationCount;
            totalActors += state.actorIds.size;
        }

        return {
            documents: this.docStates.size,
            operations: totalOps,
            actors: totalActors,
            redisConnected: this.redis.isOpen,
            pgConnected: this.pgInitialized
        };
    }

    async shutdown(): Promise<void> {
        this.isShuttingDown = true;
        logger.info('Bridge shutting down...');

        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        if (this.snapshotInterval) clearInterval(this.snapshotInterval);

        await this.snapshotAllDocuments();

        for (const state of this.docStates.values()) {
            state.doc.destroy();
        }
        this.docStates.clear();

        await this.redis.quit();
        await this.pgPool.end();

        logger.info('Bridge shutdown complete');
    }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'aetherstate-bridge',
        timestamp: new Date().toISOString()
    });
});

const bridge = new AetherBridge({
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    postgresUrl: process.env.POSTGRES_URL || 'postgresql://localhost:5432/aetherstate',
    docTTL: parseInt(process.env.DOC_TTL || '1800000'),
    maxDocSize: parseInt(process.env.MAX_DOC_SIZE || '10000'),
    snapshotInterval: parseInt(process.env.SNAPSHOT_INTERVAL || '300000'),
    enableEmbedding: process.env.ENABLE_EMBEDDING !== 'false',
    postgresPoolSize: parseInt(process.env.POSTGRES_POOL_SIZE || '10')
});

app.post('/mutate', async (req: Request, res: Response) => {
    try {
        const result = await bridge.mutate(req.body as MutationRequest);
        res.json(result);
    } catch (err) {
        logger.error('Mutate error', { error: (err as Error).message, body: req.body });
        res.status(400).json({ error: (err as Error).message });
    }
});

app.get('/docs/:docId', async (req: Request, res: Response) => {
    try {
        const doc = await bridge.getDocument(req.params.docId);
        if (!doc) {
            return res.status(404).json({ error: 'Document not found' });
        }
        res.json(doc);
    } catch (err) {
        logger.error('Get document error', { error: (err as Error).message });
        res.status(500).json({ error: (err as Error).message });
    }
});

app.get('/metrics', (req, res) => {
    res.json(bridge.getMetrics());
});

const PORT = process.env.BRIDGE_PORT || 8080;

async function start() {
    await bridge.initialize();

    app.listen(PORT, () => {
        logger.info(`Bridge server running on port ${PORT}`);
    });

    process.on('SIGTERM', async () => {
        await bridge.shutdown();
        process.exit(0);
    });

    process.on('SIGINT', async () => {
        await bridge.shutdown();
        process.exit(0);
    });
}

start().catch(err => {
    logger.error('Failed to start bridge', { error: err.message });
    process.exit(1);
});

export { AetherBridge, BridgeConfig, MutationRequest };
