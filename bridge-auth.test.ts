import { generateKeyPairSync } from 'crypto';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import { Server } from 'http';

const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Env must precede the require: auth.ts validates JWT_PUBLIC_KEY at module
// load. require (not import) is deliberate — imports are hoisted above these
// lines.
process.env.JWT_PUBLIC_KEY = keys.publicKey;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { bridgeApp, bridgeInstance } = require('./bridge-server');

const sign = (sub: string, docIds: string[]) =>
    jwt.sign({ sub, docIds }, keys.privateKey, { algorithm: 'RS256', expiresIn: '1h' });

describe('bridge RS256 document auth (H1 ruling)', () => {
    let server: Server;
    let base: string;

    beforeAll(async () => {
        await new Promise<void>((resolve) => {
            server = bridgeApp.listen(0, () => resolve());
        });
        base = `http://localhost:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('POST /mutate without a token -> 401', async () => {
        const res = await fetch(`${base}/mutate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ docId: 'doc-1', key: 'k', value: 'v' }),
        });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Missing bearer token' });
    });

    test('POST /mutate with a token for another document -> 403', async () => {
        const token = sign('agent-1', ['other-doc']);
        const res = await fetch(`${base}/mutate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ docId: 'doc-1', key: 'k', value: 'v' }),
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Not authorized for this document' });
    });

    test('POST /mutate with an invalid token -> 401', async () => {
        const res = await fetch(`${base}/mutate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-jwt' },
            body: JSON.stringify({ docId: 'doc-1', key: 'k', value: 'v' }),
        });
        expect(res.status).toBe(401);
    });

    test('POST /mutate with a valid token -> 200, actorId taken from the token', async () => {
        const spy = jest
            .spyOn(bridgeInstance, 'mutate')
            .mockResolvedValue({ ok: true, actorId: 'agent-1', opId: 'op-1' });
        const token = sign('agent-1', ['doc-1']);
        const res = await fetch(`${base}/mutate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            // A forged actorId in the body must not win over the token's sub.
            body: JSON.stringify({
                docId: 'doc-1',
                key: 'k',
                value: 'v',
                actorId: 'forged-actor',
                timestamp: Date.now(),
            }),
        });
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ docId: 'doc-1', actorId: 'agent-1' })
        );
    });

    test('GET /docs/:docId without a token -> 401', async () => {
        const res = await fetch(`${base}/docs/doc-1`);
        expect(res.status).toBe(401);
    });

    test('GET /docs/:docId with a token for another document -> 403', async () => {
        const token = sign('agent-1', ['other-doc']);
        const res = await fetch(`${base}/docs/doc-1`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(403);
    });

    test('GET /docs/:docId with a valid token -> 200', async () => {
        const spy = jest
            .spyOn(bridgeInstance, 'getDocument')
            .mockResolvedValue({ data: { k: 'v' }, meta: {} });
        const token = sign('agent-1', ['*']);
        const res = await fetch(`${base}/docs/doc-1`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ data: { k: 'v' }, meta: {} });
        expect(spy).toHaveBeenCalledWith('doc-1');
    });

    test('GET /health stays unauthenticated', async () => {
        const res = await fetch(`${base}/health`);
        expect(res.status).toBe(200);
    });

    test('GET /metrics without a token -> 401', async () => {
        const res = await fetch(`${base}/metrics`);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Missing bearer token' });
    });

    test('GET /metrics with a token for another document -> 403', async () => {
        const token = sign('agent-1', ['other-doc']);
        const res = await fetch(`${base}/metrics`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Not authorized for this document' });
    });

    test('GET /metrics with a wildcard token -> 200', async () => {
        const token = sign('agent-1', ['*']);
        const res = await fetch(`${base}/metrics`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual(
            expect.objectContaining({
                documents: expect.any(Number),
                operations: expect.any(Number),
                actors: expect.any(Number),
                redisConnected: expect.any(Boolean),
                pgConnected: expect.any(Boolean),
            })
        );
    });
});
