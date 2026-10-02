import { WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync } from 'crypto';
import { AetherSignalingServer } from './webrtc-signaling';

const PORT = 18081;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitForType(ws: WebSocket, type: string, timeout = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
        const onMsg = (data: Buffer) => {
            try {
                const m = JSON.parse(data.toString());
                if (m.type === type) {
                    clearTimeout(timer);
                    ws.off('message', onMsg);
                    resolve(m);
                }
            } catch {
                /* ignore malformed */
            }
        };
        ws.on('message', onMsg);
    });
}

describe('AetherSignalingServer peer identity', () => {
    let server: AetherSignalingServer;
    let publicKey: string;
    let privateKey: string;

    beforeAll(() => {
        const keys = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        publicKey = keys.publicKey;
        privateKey = keys.privateKey;
        server = new AetherSignalingServer({
            port: PORT,
            jwtPublicKey: publicKey,
            heartbeatInterval: 30000,
            peerTimeout: 120000,
            maxPeersPerDoc: 50,
            enableMetrics: false,
            cellularMeshSize: 8,
            enableCellularMesh: false,
        });
    });

    afterAll(() => {
        server.shutdown();
    });

    test('two connections with the same JWT sub get distinct peer ids and both survive', async () => {
        const token = jwt.sign({ sub: 'agent-1', docIds: ['*'] }, privateKey, {
            algorithm: 'RS256',
            expiresIn: '1h',
        });

        const ws1 = new WebSocket(`ws://localhost:${PORT}?token=${token}`);
        const connected1 = await waitForType(ws1, 'connected');
        const ws2 = new WebSocket(`ws://localhost:${PORT}?token=${token}`);
        const connected2 = await waitForType(ws2, 'connected');

        expect(connected1.payload.peerId).toBeDefined();
        expect(connected2.payload.peerId).toBeDefined();
        // Regression test for the sub-keyed peer map: identical subs must not
        // collide, or ws1's disconnect would kill ws2's session.
        expect(connected2.payload.peerId).not.toBe(connected1.payload.peerId);

        ws1.close();
        await sleep(300);

        // ws2 must still be a live peer: ping -> pong.
        ws2.send(JSON.stringify({ type: 'ping' }));
        const pong = await waitForType(ws2, 'pong');
        expect(pong.type).toBe('pong');

        ws2.close();
        await sleep(100);
    });

    test('connections without a token are rejected', async () => {
        const ws = new WebSocket(`ws://localhost:${PORT}`);
        const closed = await new Promise<number>((resolve) =>
            ws.on('close', (code: number) => resolve(code))
        );
        expect(closed).toBe(4001);
    });
});
