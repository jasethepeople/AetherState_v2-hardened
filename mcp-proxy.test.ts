import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync } from 'crypto';

const STUB_PORT = 18080;

const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

interface SeenRequest {
    method?: string;
    url?: string;
    authorization?: string;
    body?: any;
}
const seen: SeenRequest[] = [];

// Stub bridge: records what the MCP forwards and answers like the real one.
const stubBridge: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => {
        raw += chunk;
    });
    req.on('end', () => {
        seen.push({
            method: req.method,
            url: req.url,
            authorization: req.headers.authorization,
            body: raw ? JSON.parse(raw) : undefined,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/mutate') {
            res.end(JSON.stringify({ ok: true, actorId: 'agent-1', opId: 'stub-op-1' }));
        } else {
            res.end(JSON.stringify({ data: { k: 'v' }, meta: {} }));
        }
    });
});

// Env must precede the require: BRIDGE_URL and JWT_PUBLIC_KEY are read at
// module load. require (not import) is deliberate — imports are hoisted above
// these lines.
process.env.JWT_PUBLIC_KEY = keys.publicKey;
process.env.BRIDGE_URL = `http://localhost:${STUB_PORT}`;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { mcpServer } = require('./mcp-server');

const sign = (sub: string, docIds: string[]) =>
    jwt.sign({ sub, docIds }, keys.privateKey, { algorithm: 'RS256', expiresIn: '1h' });

describe('MCP proxy forwards the caller Authorization header (H1 ruling)', () => {
    let mcp: Server;
    let base: string;

    beforeAll(async () => {
        await new Promise<void>((resolve) => stubBridge.listen(STUB_PORT, resolve));
        await new Promise<void>((resolve) => {
            mcp = mcpServer.listen(0, () => resolve());
        });
        base = `http://localhost:${(mcp.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise((resolve) => mcp.close(resolve));
        await new Promise((resolve) => stubBridge.close(resolve));
    });

    beforeEach(() => {
        seen.length = 0;
    });

    test('mutate forwards the exact caller token to the bridge', async () => {
        const token = sign('agent-1', ['doc-1']);
        const res = await fetch(`${base}/docs/doc-1/mutate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ key: 'k', value: 'v' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.status).toBe('accepted');
        expect(body.opId).toBe('stub-op-1');
        // The bridge must see the END-USER's token, not an MCP identity.
        expect(seen).toHaveLength(1);
        expect(seen[0].method).toBe('POST');
        expect(seen[0].url).toBe('/mutate');
        expect(seen[0].authorization).toBe(`Bearer ${token}`);
        expect(seen[0].body).toMatchObject({ docId: 'doc-1', key: 'k', actorId: 'agent-1' });
    });

    test('document read forwards the caller token to the bridge', async () => {
        const token = sign('agent-1', ['*']);
        const res = await fetch(`${base}/docs/doc-1`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ data: { k: 'v' }, meta: {} });
        expect(seen).toHaveLength(1);
        expect(seen[0].method).toBe('GET');
        expect(seen[0].authorization).toBe(`Bearer ${token}`);
    });

    test("MCP's own 401 fires before the bridge is ever contacted", async () => {
        const res = await fetch(`${base}/docs/doc-1/mutate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'k', value: 'v' }),
        });
        expect(res.status).toBe(401);
        expect(seen).toHaveLength(0);
    });

    test("MCP's own 403 fires before the bridge is ever contacted", async () => {
        const token = sign('agent-1', ['other-doc']);
        const res = await fetch(`${base}/docs/doc-1/mutate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ key: 'k', value: 'v' }),
        });
        expect(res.status).toBe(403);
        expect(seen).toHaveLength(0);
    });

    test("MCP's GET /metrics without a token -> 401", async () => {
        const res = await fetch(`${base}/metrics`);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Missing bearer token' });
    });

    test("MCP's GET /metrics with a non-privileged token -> 403", async () => {
        const token = sign('agent-1', ['other-doc']);
        const res = await fetch(`${base}/metrics`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Not authorized for this document' });
    });

    test("MCP's GET /metrics with a wildcard token -> 200", async () => {
        const token = sign('agent-1', ['*']);
        const res = await fetch(`${base}/metrics`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual(
            expect.objectContaining({
                uptime: expect.any(Number),
                memory: expect.any(Object),
                timestamp: expect.any(Number),
            })
        );
    });
});
