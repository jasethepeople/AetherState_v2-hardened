import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import jwt from 'jsonwebtoken';
import winston from 'winston';
import { randomUUID } from 'crypto';

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'aetherstate-signaling' },
    transports: [new winston.transports.Console()]
});

interface Peer {
    id: string;
    ws: WebSocket;
    docIds: Set<string>;
    lastSeen: number;
    metadata: Record<string, any>;
    connectedPeers: Set<string>;
}

interface SignalMessage {
    type: 'join' | 'leave' | 'offer' | 'answer' | 'ice-candidate' | 'ping' | 'pong' | 'broadcast' | 'cell-neighbors' | 'cell-relay';
    docId?: string;
    targetPeerId?: string;
    payload?: any;
    timestamp?: number;
}

interface SignalingConfig {
    port: number;
    jwtPublicKey: string;
    heartbeatInterval: number;
    peerTimeout: number;
    maxPeersPerDoc: number;
    enableMetrics: boolean;
    cellularMeshSize: number;
    enableCellularMesh: boolean;
}

class AetherSignalingServer {
    private wss: WebSocketServer;
    private peers: Map<string, Peer> = new Map();
    private docPeers: Map<string, Set<string>> = new Map();
    private config: SignalingConfig;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private cleanupTimer: NodeJS.Timeout | null = null;
    private cellAssignments: Map<string, Map<string, Set<string>>> = new Map(); // docId -> cellId -> Set<peerId>

    constructor(config: SignalingConfig) {
        this.config = {
            port: config.port || 8081,
            jwtPublicKey: config.jwtPublicKey,
            heartbeatInterval: config.heartbeatInterval || 30000,
            peerTimeout: config.peerTimeout || 120000,
            maxPeersPerDoc: config.maxPeersPerDoc || 50,
            enableMetrics: config.enableMetrics ?? true,
            cellularMeshSize: config.cellularMeshSize || 8,
            enableCellularMesh: config.enableCellularMesh ?? false
        };

        const server = createServer();
        this.wss = new WebSocketServer({ server });

        this.setupWebSocketHandlers();

        server.listen(this.config.port, () => {
            logger.info(`Signaling server listening on port ${this.config.port}`);
        });
    }

    private setupWebSocketHandlers(): void {
        this.wss.on('connection', (ws: WebSocket, req) => {
            const url = new URL(req.url || '', `http://${req.headers.host}`);
            const token = url.searchParams.get('token') || req.headers['authorization']?.toString().replace('Bearer ', '');

            if (!token) {
                logger.warn('Connection attempt without token');
                ws.close(4001, 'Authentication required');
                return;
            }

            let claims: any;
            try {
                claims = jwt.verify(token, this.config.jwtPublicKey, { algorithms: ['RS256'] });
            } catch (err) {
                logger.warn('Invalid token', { error: (err as Error).message });
                ws.close(4002, 'Invalid token');
                return;
            }

            const peerId = claims.sub || randomUUID();
            const peer: Peer = {
                id: peerId,
                ws,
                docIds: new Set(),
                lastSeen: Date.now(),
                metadata: claims,
                connectedPeers: new Set()
            };

            this.peers.set(peerId, peer);
            logger.info('Peer connected', { peerId, docIds: claims.docIds });

            ws.on('message', (data: Buffer) => {
                try {
                    const message: SignalMessage = JSON.parse(data.toString());
                    this.handleMessage(peerId, message);
                } catch (err) {
                    logger.warn('Invalid message format', { peerId, error: (err as Error).message });
                    this.sendToPeer(peerId, {
                        type: 'error',
                        payload: { message: 'Invalid message format' }
                    });
                }
            });

            ws.on('close', () => {
                this.handlePeerDisconnect(peerId);
            });

            ws.on('error', (err) => {
                logger.error('WebSocket error', { peerId, error: err.message });
                this.handlePeerDisconnect(peerId);
            });

            this.sendToPeer(peerId, {
                type: 'connected',
                payload: { peerId, timestamp: Date.now(), cellularMeshEnabled: this.config.enableCellularMesh }
            });
        });
    }

    private handleMessage(peerId: string, message: SignalMessage): void {
        const peer = this.peers.get(peerId);
        if (!peer) return;

        peer.lastSeen = Date.now();

        switch (message.type) {
            case 'join':
                this.handleJoin(peerId, message);
                break;
            case 'leave':
                this.handleLeave(peerId, message);
                break;
            case 'offer':
            case 'answer':
            case 'ice-candidate':
                this.handleSignal(peerId, message);
                break;
            case 'ping':
                this.sendToPeer(peerId, { type: 'pong', timestamp: Date.now() });
                break;
            case 'broadcast':
                this.handleBroadcast(peerId, message);
                break;
            case 'cell-neighbors':
                this.handleCellNeighbors(peerId, message);
                break;
            case 'cell-relay':
                this.handleCellRelay(peerId, message);
                break;
            default:
                logger.warn('Unknown message type', { peerId, type: message.type });
        }
    }

    private handleJoin(peerId: string, message: SignalMessage): void {
        const { docId } = message;
        if (!docId) {
            this.sendToPeer(peerId, {
                type: 'error',
                payload: { message: 'docId required for join' }
            });
            return;
        }

        const peer = this.peers.get(peerId)!;

        const authorizedDocs = peer.metadata.docIds || [];
        if (!authorizedDocs.includes('*') && !authorizedDocs.includes(docId)) {
            this.sendToPeer(peerId, {
                type: 'error',
                payload: { message: 'Not authorized for this document' }
            });
            return;
        }

        const docPeerSet = this.docPeers.get(docId) || new Set();
        if (docPeerSet.size >= this.config.maxPeersPerDoc) {
            this.sendToPeer(peerId, {
                type: 'error',
                payload: { message: 'Document peer limit reached' }
            });
            return;
        }

        docPeerSet.add(peerId);
        this.docPeers.set(docId, docPeerSet);
        peer.docIds.add(docId);

        if (this.config.enableCellularMesh) {
            this.assignPeerToCell(docId, peerId);
        }

        const existingPeers = Array.from(docPeerSet)
            .filter(id => id !== peerId)
            .map(id => ({ peerId: id }));

        this.sendToPeer(peerId, {
            type: 'joined',
            payload: {
                docId,
                peers: existingPeers,
                peerCount: docPeerSet.size,
                cellularMesh: this.config.enableCellularMesh ? this.getCellAssignment(docId, peerId) : null
            }
        });

        this.broadcastToDoc(docId, {
            type: 'peer-joined',
            payload: { peerId, docId }
        }, peerId);

        logger.info('Peer joined document', { peerId, docId, peerCount: docPeerSet.size });
    }

    private assignPeerToCell(docId: string, peerId: string): void {
        let cells = this.cellAssignments.get(docId);
        if (!cells) {
            cells = new Map();
            this.cellAssignments.set(docId, cells);
        }

        // Find cell with least peers or create new
        let targetCell: string | null = null;
        let minSize = Infinity;

        for (const [cellId, peers] of cells.entries()) {
            if (peers.size < this.config.cellularMeshSize && peers.size < minSize) {
                minSize = peers.size;
                targetCell = cellId;
            }
        }

        if (!targetCell) {
            targetCell = `cell-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
            cells.set(targetCell, new Set());
        }

        cells.get(targetCell)!.add(peerId);
    }

    private getCellAssignment(docId: string, peerId: string): { cellId: string; neighbors: string[] } | null {
        const cells = this.cellAssignments.get(docId);
        if (!cells) return null;

        for (const [cellId, peers] of cells.entries()) {
            if (peers.has(peerId)) {
                const neighbors = Array.from(peers).filter(id => id !== peerId);
                return { cellId, neighbors };
            }
        }
        return null;
    }

    private handleCellNeighbors(peerId: string, message: SignalMessage): void {
        const { docId } = message;
        if (!docId) return;

        const assignment = this.getCellAssignment(docId, peerId);
        if (assignment) {
            this.sendToPeer(peerId, {
                type: 'cell-neighbors',
                payload: assignment
            });
        }
    }

    private handleCellRelay(peerId: string, message: SignalMessage): void {
        const { docId, targetPeerId, payload } = message;
        if (!docId || !targetPeerId) return;

        // In cellular mesh, relay through cell neighbors if direct connection fails
        const assignment = this.getCellAssignment(docId, peerId);
        if (assignment && assignment.neighbors.includes(targetPeerId)) {
            this.sendToPeer(targetPeerId, {
                type: 'cell-relay',
                payload: { ...payload, fromPeerId: peerId }
            });
        }
    }

    private handleLeave(peerId: string, message: SignalMessage): void {
        const { docId } = message;
        if (!docId) return;

        this.removePeerFromDoc(peerId, docId);
    }

    private handleSignal(fromPeerId: string, message: SignalMessage): void {
        const { targetPeerId, payload, docId } = message;

        if (!targetPeerId) {
            this.sendToPeer(fromPeerId, {
                type: 'error',
                payload: { message: 'targetPeerId required' }
            });
            return;
        }

        const fromPeer = this.peers.get(fromPeerId);
        const targetPeer = this.peers.get(targetPeerId);

        if (!targetPeer) {
            this.sendToPeer(fromPeerId, {
                type: 'error',
                payload: { message: 'Target peer not found' }
            });
            return;
        }

        if (docId && (!fromPeer?.docIds.has(docId) || !targetPeer.docIds.has(docId))) {
            this.sendToPeer(fromPeerId, {
                type: 'error',
                payload: { message: 'Peers not in same document' }
            });
            return;
        }

        this.sendToPeer(targetPeerId, {
            type: message.type,
            payload: {
                ...payload,
                fromPeerId
            }
        });
    }

    private handleBroadcast(peerId: string, message: SignalMessage): void {
        const { docId, payload } = message;
        if (!docId) return;

        const peer = this.peers.get(peerId);
        if (!peer?.docIds.has(docId)) {
            this.sendToPeer(peerId, {
                type: 'error',
                payload: { message: 'Not joined to document' }
            });
            return;
        }

        this.broadcastToDoc(docId, {
            type: 'broadcast',
            payload: {
                ...payload,
                fromPeerId: peerId
            }
        }, peerId);
    }

    private broadcastToDoc(docId: string, message: any, excludePeerId?: string): void {
        const peerSet = this.docPeers.get(docId);
        if (!peerSet) return;

        for (const peerId of peerSet) {
            if (peerId !== excludePeerId) {
                this.sendToPeer(peerId, message);
            }
        }
    }

    private sendToPeer(peerId: string, message: any): void {
        const peer = this.peers.get(peerId);
        if (!peer || peer.ws.readyState !== WebSocket.OPEN) return;

        try {
            peer.ws.send(JSON.stringify(message));
        } catch (err) {
            logger.error('Failed to send message', { peerId, error: (err as Error).message });
        }
    }

    private removePeerFromDoc(peerId: string, docId: string): void {
        const docPeerSet = this.docPeers.get(docId);
        if (docPeerSet) {
            docPeerSet.delete(peerId);
            if (docPeerSet.size === 0) {
                this.docPeers.delete(docId);
                this.cellAssignments.delete(docId);
            }
        }

        // Remove from cell assignment
        const cells = this.cellAssignments.get(docId);
        if (cells) {
            for (const [cellId, peers] of cells.entries()) {
                peers.delete(peerId);
                if (peers.size === 0) {
                    cells.delete(cellId);
                }
            }
        }

        const peer = this.peers.get(peerId);
        if (peer) {
            peer.docIds.delete(docId);
        }

        this.broadcastToDoc(docId, {
            type: 'peer-left',
            payload: { peerId, docId }
        });

        logger.info('Peer left document', { peerId, docId });
    }

    private handlePeerDisconnect(peerId: string): void {
        const peer = this.peers.get(peerId);
        if (!peer) return;

        for (const docId of peer.docIds) {
            this.removePeerFromDoc(peerId, docId);
        }

        this.peers.delete(peerId);
        logger.info('Peer disconnected', { peerId });
    }

    startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            this.peers.forEach((peer, peerId) => {
                if (peer.ws.readyState === WebSocket.OPEN) {
                    this.sendToPeer(peerId, { type: 'ping', timestamp: Date.now() });
                }
            });
        }, this.config.heartbeatInterval);
    }

    startCleanup(): void {
        this.cleanupTimer = setInterval(() => {
            const now = Date.now();
            const timeout = this.config.peerTimeout;

            for (const [peerId, peer] of this.peers.entries()) {
                if (now - peer.lastSeen > timeout) {
                    logger.warn('Peer timed out', { peerId, lastSeen: peer.lastSeen });
                    peer.ws.terminate();
                    this.handlePeerDisconnect(peerId);
                }
            }
        }, 30000);
    }

    getMetrics(): { peers: number; documents: number; connections: number; cells: number } {
        let cellCount = 0;
        for (const cells of this.cellAssignments.values()) {
            cellCount += cells.size;
        }

        return {
            peers: this.peers.size,
            documents: this.docPeers.size,
            connections: Array.from(this.peers.values()).filter(p => p.ws.readyState === WebSocket.OPEN).length,
            cells: cellCount
        };
    }

    shutdown(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);

        this.peers.forEach((peer) => {
            peer.ws.close(1000, 'Server shutting down');
        });

        this.wss.close();
        logger.info('Signaling server shut down');
    }
}

if (require.main === module) {
    const jwtPublicKey = process.env.JWT_PUBLIC_KEY;
    if (!jwtPublicKey) {
        console.error('JWT_PUBLIC_KEY environment variable required');
        process.exit(1);
    }

    const server = new AetherSignalingServer({
        port: parseInt(process.env.SIGNALING_PORT || '8081'),
        jwtPublicKey,
        heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '30000'),
        peerTimeout: parseInt(process.env.PEER_TIMEOUT || '120000'),
        maxPeersPerDoc: parseInt(process.env.MAX_PEERS_PER_DOC || '50'),
        enableMetrics: process.env.ENABLE_METRICS !== 'false',
        cellularMeshSize: parseInt(process.env.CELLULAR_MESH_SIZE || '8'),
        enableCellularMesh: process.env.ENABLE_CELLULAR_MESH === 'true'
    });

    server.startHeartbeat();
    server.startCleanup();

    const http = require('http');
    const metricsServer = http.createServer((req: any, res: any) => {
        if (req.url === '/metrics') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(server.getMetrics()));
        } else if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'healthy' }));
        }
    });

    metricsServer.listen(parseInt(process.env.METRICS_PORT || '8082'));

    process.on('SIGTERM', () => {
        server.shutdown();
        process.exit(0);
    });
}

export { AetherSignalingServer, SignalingConfig, SignalMessage, Peer };
