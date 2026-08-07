import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

interface PendingRequest {
    resolve: (ws: WebSocket) => void;
    reject: (err: Error) => void;
    isActive: boolean;
    timer: NodeJS.Timeout;
    createdAt: number;
}

interface PoolMetrics {
    totalConnections: number;
    idleConnections: number;
    pendingRequests: number;
    failedConnections: number;
    avgAcquireTime: number;
    healthyConnections: number;
}

interface PoolConfig {
    maxPoolSize: number;
    uri: string;
    heartbeatInterval?: number;
    connectionTimeout?: number;
    acquireTimeout?: number;
    maxConnectionAge?: number;
    reconnectAttempts?: number;
    reconnectDelay?: number;
    reconnectBackoffMultiplier?: number;
}

class WebSocketPool extends EventEmitter {
    private connections: WebSocket[] = [];
    private currentTotalConnections = 0;
    private waiting: PendingRequest[] = [];
    private maxPoolSize: number;
    private uri: string;
    private heartbeatInterval: number;
    private connectionTimeout: number;
    private acquireTimeout: number;
    private maxConnectionAge: number;
    private reconnectAttempts: number;
    private reconnectDelay: number;
    private reconnectBackoffMultiplier: number;
    private failedConnections = 0;
    private acquireTimes: number[] = [];
    private connectionAges: Map<WebSocket, number> = new Map();
    private heartbeatTimers: Map<WebSocket, NodeJS.Timeout> = new Map();
    private isShuttingDown = false;
    private lastPongTimestamps: Map<WebSocket, number> = new Map();

    constructor(config: PoolConfig) {
        super();
        this.maxPoolSize = config.maxPoolSize;
        this.uri = config.uri;
        this.heartbeatInterval = config.heartbeatInterval || 30000;
        this.connectionTimeout = config.connectionTimeout || 10000;
        this.acquireTimeout = config.acquireTimeout || 5000;
        this.maxConnectionAge = config.maxConnectionAge || 300000;
        this.reconnectAttempts = config.reconnectAttempts || 3;
        this.reconnectDelay = config.reconnectDelay || 1000;
        this.reconnectBackoffMultiplier = config.reconnectBackoffMultiplier || 2;
    }

    async acquire(): Promise<WebSocket> {
        if (this.isShuttingDown) {
            throw new Error('Pool is shutting down');
        }

        const startTime = Date.now();

        while (this.connections.length > 0) {
            const ws = this.connections.pop()!;
            if (await this.validateConnection(ws)) {
                this.recordAcquireTime(Date.now() - startTime);
                this.connectionAges.set(ws, Date.now());
                return ws;
            }
            this.destroyConnection(ws);
        }

        if (this.currentTotalConnections < this.maxPoolSize) {
            this.currentTotalConnections++;
            try {
                const ws = await this.createNewConnection();
                this.recordAcquireTime(Date.now() - startTime);
                this.connectionAges.set(ws, Date.now());
                return ws;
            } catch (err) {
                this.currentTotalConnections--;
                this.failedConnections++;
                this.emit('connectionFailed', err);
                throw err;
            }
        }

        return new Promise<WebSocket>((resolve, reject) => {
            const request: PendingRequest = {
                resolve, reject, isActive: true,
                timer: setTimeout(() => {
                    if (request.isActive) {
                        request.isActive = false;
                        this.waiting = this.waiting.filter(r => r !== request);
                        reject(new Error(`WebSocket pool acquisition timed out after ${this.acquireTimeout}ms`));
                    }
                }, this.acquireTimeout),
                createdAt: Date.now()
            };
            this.waiting.push(request);
        });
    }

    release(ws: WebSocket): void {
        if (this.isShuttingDown) {
            this.destroyConnection(ws);
            return;
        }

        if (!this.isConnectionHealthy(ws)) {
            this.destroyConnection(ws);
            return;
        }

        const age = Date.now() - (this.connectionAges.get(ws) || 0);
        if (age > this.maxConnectionAge) {
            this.destroyConnection(ws);
            return;
        }

        while (this.waiting.length > 0) {
            const nextRequest = this.waiting.shift()!;
            if (nextRequest.isActive) {
                nextRequest.isActive = false;
                clearTimeout(nextRequest.timer);
                nextRequest.resolve(ws);
                return;
            }
        }

        this.connections.push(ws);
    }

    private async createNewConnection(): Promise<WebSocket> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.uri, {
                handshakeTimeout: this.connectionTimeout
            });

            const timeout = setTimeout(() => {
                ws.terminate();
                reject(new Error(`Connection timeout after ${this.connectionTimeout}ms`));
            }, this.connectionTimeout);

            ws.once('open', () => {
                clearTimeout(timeout);
                this.setupHeartbeat(ws);
                this.emit('connectionCreated');
                resolve(ws);
            });

            ws.once('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            ws.once('close', () => {
                this.handleConnectionClose(ws);
            });
        });
    }

    private setupHeartbeat(ws: WebSocket): void {
        this.lastPongTimestamps.set(ws, Date.now());

        const timer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                const lastPong = this.lastPongTimestamps.get(ws) || 0;
                if (Date.now() - lastPong > this.heartbeatInterval * 2) {
                    this.destroyConnection(ws);
                    return;
                }
                ws.ping();
            }
        }, this.heartbeatInterval);
        this.heartbeatTimers.set(ws, timer);

        ws.on('pong', () => {
            this.lastPongTimestamps.set(ws, Date.now());
        });
    }

    private async validateConnection(ws: WebSocket): Promise<boolean> {
        return ws.readyState === WebSocket.OPEN;
    }

    private isConnectionHealthy(ws: WebSocket): boolean {
        if (ws.readyState !== WebSocket.OPEN) return false;
        const lastPong = this.lastPongTimestamps.get(ws) || 0;
        return Date.now() - lastPong <= this.heartbeatInterval * 2;
    }

    private destroyConnection(ws: WebSocket): void {
        const timer = this.heartbeatTimers.get(ws);
        if (timer) {
            clearInterval(timer);
            this.heartbeatTimers.delete(ws);
        }
        this.lastPongTimestamps.delete(ws);
        this.connectionAges.delete(ws);

        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.terminate();
        }

        this.currentTotalConnections--;
        this.emit('connectionDestroyed');
    }

    private handleConnectionClose(ws: WebSocket): void {
        this.destroyConnection(ws);
        const idx = this.connections.indexOf(ws);
        if (idx !== -1) {
            this.connections.splice(idx, 1);
        }
    }

    private recordAcquireTime(duration: number): void {
        this.acquireTimes.push(duration);
        if (this.acquireTimes.length > 100) {
            this.acquireTimes.shift();
        }
    }

    getMetrics(): PoolMetrics {
        const avgTime = this.acquireTimes.length > 0
            ? this.acquireTimes.reduce((a, b) => a + b, 0) / this.acquireTimes.length
            : 0;

        const healthy = this.connections.filter(ws => this.isConnectionHealthy(ws)).length;

        return {
            totalConnections: this.currentTotalConnections,
            idleConnections: this.connections.length,
            pendingRequests: this.waiting.filter(r => r.isActive).length,
            failedConnections: this.failedConnections,
            avgAcquireTime: Math.round(avgTime),
            healthyConnections: healthy
        };
    }

    async shutdown(): Promise<void> {
        this.isShuttingDown = true;

        this.waiting.forEach(req => {
            if (req.isActive) {
                req.isActive = false;
                clearTimeout(req.timer);
                req.reject(new Error('Pool is shutting down'));
            }
        });
        this.waiting = [];

        [...this.connections].forEach(ws => this.destroyConnection(ws));
        this.connections = [];

        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

export { WebSocketPool, PoolConfig, PoolMetrics };
