import { mcpServer } from './mcp-server';
// NOTE (review 2026-10-02): bridge-server no longer boots on import; index.ts
// initializes this same bridge instance and serves its HTTP app, so there is
// exactly one bridge per process. (The old WebSocketPool wiring was removed:
// mutations now go MCP -> bridge over HTTP, and the pool pointed at the
// bridge's HTTP-only port.)
import { bridgeInstance as bridge, bridgeApp } from './bridge-server';
import { AetherSignalingServer } from './webrtc-signaling';
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

    await bridge.initialize();

    const bridgePort = parseInt(process.env.BRIDGE_PORT || '8080');
    bridgeApp.listen(bridgePort, () => {
        logger.info(`Bridge server running on port ${bridgePort}`);
    });

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

    // (mcpServer as any).bridgePool wiring removed 2026-10-02: the MCP server
    // now forwards mutations to the bridge over HTTP (BRIDGE_URL); the pool
    // handle was read from the wrong object and the pool targeted an
    // HTTP-only port, so every mutation failed.

    const mcpPort = parseInt(process.env.MCP_PORT || '3000');
    mcpServer.listen(mcpPort, () => {
        logger.info(`MCP Server listening on port ${mcpPort}`);
    });

    const shutdown = async (signal: string) => {
        logger.info(`Received ${signal}, shutting down gracefully...`);

        await bridge.shutdown();
        signaling.shutdown();

        logger.info('Shutdown complete');
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
        logger.error('Unhandled promise rejection', { reason });
    });

    logger.info('AetherState v2.0 is running');
}

main().catch(err => {
    logger.error('Failed to start AetherState', { error: err.message });
    process.exit(1);
});
