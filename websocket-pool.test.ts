import { WebSocketServer, WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { WebSocketPool } from './websocket-pool';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WebSocketPool', () => {
    let wss: WebSocketServer;
    let port: number;

    beforeAll((done) => {
        wss = new WebSocketServer({ port: 0 }, () => {
            port = (wss.address() as AddressInfo).port;
            done();
        });
        wss.on('connection', (ws) => {
            ws.on('message', (m) => ws.send(m));
        });
    });

    afterAll((done) => {
        wss.close(() => done());
    });

    test('acquire returns an open connection and release recycles it', async () => {
        const pool = new WebSocketPool({ maxPoolSize: 5, uri: `ws://localhost:${port}` });
        const ws = await pool.acquire();
        expect(ws.readyState).toBe(WebSocket.OPEN);
        pool.release(ws);
        expect(pool.getMetrics().idleConnections).toBe(1);
        const ws2 = await pool.acquire();
        expect(ws2.readyState).toBe(WebSocket.OPEN);
        pool.release(ws2);
        await pool.shutdown();
    });

    test('remote close of a checked-out connection does not corrupt accounting', async () => {
        const pool = new WebSocketPool({ maxPoolSize: 5, uri: `ws://localhost:${port}` });
        const ws = await pool.acquire();
        // Server terminates the connection while it is checked out.
        wss.clients.forEach((c) => c.terminate());
        await new Promise<void>((resolve) => ws.once('close', () => resolve()));
        await sleep(50);
        // The holder releases the now-dead socket; destroyConnection runs a
        // second time for the same socket and must be idempotent.
        pool.release(ws);
        const m = pool.getMetrics();
        expect(m.totalConnections).toBe(0);
        expect(m.totalConnections).toBeGreaterThanOrEqual(0);
        await pool.shutdown();
    });

    test('failed connection attempts do not corrupt accounting', async () => {
        // Nothing listens on port 1 -> ECONNREFUSED.
        const pool = new WebSocketPool({
            maxPoolSize: 5,
            uri: 'ws://localhost:1',
            connectionTimeout: 2000,
        });
        await expect(pool.acquire()).rejects.toThrow();
        // 'error' rejects (count--) and the subsequent 'close' event must not
        // decrement again.
        await sleep(200);
        expect(pool.getMetrics().totalConnections).toBe(0);
        await pool.shutdown();
    });

    test('waiters are handed released connections', async () => {
        const pool = new WebSocketPool({ maxPoolSize: 1, uri: `ws://localhost:${port}` });
        const ws1 = await pool.acquire();
        const pending = pool.acquire();
        expect(pool.getMetrics().pendingRequests).toBe(1);
        pool.release(ws1);
        const ws2 = await pending;
        expect(ws2.readyState).toBe(WebSocket.OPEN);
        pool.release(ws2);
        await pool.shutdown();
    });
});
