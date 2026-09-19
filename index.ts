import { mcpServer } from './mcp-server';
import { AetherBridge } from './bridge-server';
import { AetherSignalingServer } from './webrtc-signaling';
import { WebSocketPool } from './websocket-pool';
import winston from 'winston';
import dotenv from 'dotenv';

dotenv.config();

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'aetherstate-orchestrator' },
    transports: [new winston.transports.Console()]
});

async function main() {
    logger.info('Starting AetherState v2.0...');

    const required = ['JWT_PUBLIC_KEY', 'REDIS_URL', 'POSTGRES_URL'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    const bridgePool = new WebSocketPool({
        maxPoolSize: parseInt(process.env.WS_POOL_MAX_SIZE || '50'),
        uri: `ws://localhost:${process.env.BRIDGE_PORT || '8080'}`,
        heartbeatInterval: parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000'),
        connectionTimeout: parseInt(process.env.WS_CONNECTION_TIMEOUT || '10000'),
        acquireTimeout: 5000,
        maxConnectionAge: 300000,
        reconnectAttempts: 3,
        reconnectDelay: 1000
    });

    const bridge = new AetherBridge({
        redisUrl: process.env.REDIS_URL!,
        postgresUrl: process.env.POSTGRES_URL!,
        docTTL: parseInt(process.env.DOC_TTL || '1800000'),
        maxDocSize: parseInt(process.env.MAX_DOC_SIZE || '10000'),
        snapshotInterval: parseInt(process.env.SNAPSHOT_INTERVAL || '300000'),
        enableEmbedding: process.env.ENABLE_EMBEDDING !== 'false',
        postgresPoolSize: parseInt(process.env.POSTGRES_POOL_SIZE || '10')
    });

    await bridge.initialize();

    const signaling = new AetherSignalingServer({
        port: parseInt(process.env.SIGNALING_PORT || '8081'),
        jwtPublicKey: (process.env.JWT_PUBLIC_KEY || '').replace(/\\n/g, '\n').trim(),
        heartbeatInterval: parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000'),
        peerTimeout: parseInt(process.env.PEER_TIMEOUT || '120000'),
        maxPeersPerDoc: parseInt(process.env.MAX_PEERS_PER_DOC || '50'),
        enableMetrics: process.env.ENABLE_METRICS !== 'false',
        cellularMeshSize: parseInt(process.env.CELLULAR_MESH_SIZE || '8'),
        enableCellularMesh: process.env.ENABLE_CELLULAR_MESH === 'true'
    });

    signaling.startHeartbeat();
    signaling.startCleanup();

    (mcpServer as any).bridgePool = bridgePool;

    const mcpPort = parseInt(process.env.MCP_PORT || '3000');
    mcpServer.listen(mcpPort, () => {
        logger.info(`MCP Server listening on port ${mcpPort}`);
    });

    const shutdown = async (signal: string) => {
        logger.info(`Received ${signal}, shutting down gracefully...`);

        await bridge.shutdown();
        signaling.shutdown();
        await bridgePool.shutdown();

        logger.info('Shutdown complete');
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    logger.info('AetherState v2.0 is running');
}

main().catch(err => {
    logger.error('Failed to start AetherState', { error: err.message });
    process.exit(1);
});
