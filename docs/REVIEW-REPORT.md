# AetherState_v2 — Deep Review Report

**Repo:** `github.com/jasethepeople/aetherstate_v2` (public, MIT), cloned 2026-10-02 into `~/workspace/aetherstate_v2/`
**Reviewer:** subagent (same treatment as the LISPMIND deep-repair job)
**Date:** 2026-10-02
**Scope:** all 6 TypeScript sources (~1,900 lines), package.json, tsconfig, Dockerfile, docker-compose.yml, .env.example, ARCHITECTURE.md, IMPLEMENTATION_SUMMARY.md, README.md

**Method:** full read of every source file, then defect-by-defect analysis. Severity: CRITICAL (system cannot work as documented), HIGH (data loss / security / crash), MEDIUM (wrong behavior, broken contract), LOW (hygiene).

**Up-front honesty:** `IMPLEMENTATION_SUMMARY.md` claims "production-ready" and a checked-off security checklist. The code does not support that claim: the MCP→bridge mutation path is broken in two independent ways, the MCP container can never start under docker-compose, the bridge has no auth despite ADR-004, and there are zero tests. This report lists what's actually wrong.

---

## CRITICAL

### C1. MCP mutations can never reach the bridge — `req.bridgePool` is never set (mcp-server.ts)
The `/docs/:docId/mutate` handler reads the pool from `(req as any).bridgePool`, but `index.ts` sets it on the **express app object**: `(mcpServer as any).bridgePool = bridgePool`. No middleware ever copies it onto the request. Every mutation throws `'Bridge pool not configured'` → HTTP 500. **Every MCP mutation is broken, deterministically.**

### C2. MCP→bridge transport targets a server that doesn't exist (architecture)
`index.ts` builds the `WebSocketPool` with `uri: ws://localhost:${BRIDGE_PORT}` — but `bridge-server.ts` exposes **only** an Express HTTP server. There is no WebSocket server on the bridge. Even with C1 fixed, the `ws` handshake to an HTTP-only port fails and `sendToBridge` rejects. Additionally `bridge-server.ts`'s `broadcastToMesh` emits EventEmitter events that nothing listens to — there is no mesh broadcast on the wire. The documented mutation path (MCP → bridge) is broken by design, in **both** topologies: the orchestrator (`index.ts`) and docker-compose (where services run in separate containers and `index.ts` isn't used at all — the MCP container has no bridge address configured whatsoever).

### C3. MCP server can never start under docker-compose (mcp-server.ts)
`docker-compose.yml` runs the MCP container as `npm run start:mcp` → `node dist/mcp-server.js`, but `mcp-server.ts` has **no `listen()` call and no `require.main` guard** — the module only defines the app. The container process runs to completion and exits; the `/health` healthcheck can never pass. (Bridge and signaling both have standalone entry points; MCP was forgotten.)

### C4. Bridge PostgreSQL schema requires pgvector, which isn't provided (bridge-server.ts)
`initPostgres()` creates `operations.embedding VECTOR(1536)`. `VECTOR` requires the pgvector extension; `docker-compose.yml` uses stock `postgres:16-alpine` (no pgvector) and no `CREATE EXTENSION` is issued. On a fresh deploy, `CREATE TABLE` throws → `initialize()` rejects → the bridge never starts. The column is also **never written** — `indexOperation()` is a stub that only logs. A dead column that can prevent boot.

## HIGH

### H1. Bridge has zero authentication (bridge-server.ts)
`POST /mutate`, `GET /docs/:docId`, and `/metrics` are wide open — no JWT, no API key. ADR-004 explicitly requires RS256 JWT "across multiple services (MCP, Bridge, Signaling)"; the security checklist in IMPLEMENTATION_SUMMARY.md claims "Document-level access control" as implemented. Only MCP and signaling enforce it. Anyone who can reach the bridge port can read/write any document. (Fix direction is a design decision — flagged for ruling rather than changed unilaterally; see §5.)
**Update 2026-10-02:** user ruled Option A — implemented, see "H1 implementation" section. Bridge document endpoints now enforce the shared RS256 middleware; MCP forwards the caller's `Authorization` header.

### H2. WebSocket pool connection accounting can go negative (websocket-pool.ts)
`currentTotalConnections` is decremented in `destroyConnection()`, which is reachable twice for one connection: (a) `acquire()`'s catch block decrements, then the socket's `'close'` event fires → `handleConnectionClose` → `destroyConnection` decrements again; (b) a checked-out socket closes remotely → `handleConnectionClose` decrements, then the holder's `release()` finds it unhealthy → `destroyConnection` decrements again. A negative count defeats the `currentTotalConnections < maxPoolSize` guard, permitting unbounded connection creation. Also `reconnectAttempts`/`reconnectDelay`/`reconnectBackoffMultiplier` are configured but **no reconnect logic exists** — IMPLEMENTATION_SUMMARY.md's "configurable reconnect with exponential backoff" is false.

### H3. Signaling peer map keyed by JWT `sub` allows session confusion (webrtc-signaling.ts)
`this.peers.set(peerId, ...)` with `peerId = claims.sub || randomUUID()`. A second connection presenting the same `sub` **overwrites** the first peer entry; the first socket's `'close'` handler then calls `handlePeerDisconnect(peerId)`, which deletes and disconnects the *second* peer. Peer IDs must be server-generated (`randomUUID()` always); `sub` belongs in a separate `actorId` field.

### H4. Importing bridge-server.ts boots a second bridge (bridge-server.ts)
The module bottom unconditionally runs `start()` → `new AetherBridge(...)` + `initialize()` + `app.listen()`. `index.ts` imports the module (to get the `AetherBridge` class) and then constructs **another** bridge and calls `initialize()` again: two Redis clients, two pg pools, double schema init, double timers, duplicate SIGTERM handlers. Standalone boot must be guarded by `if (require.main === module)`.

## MEDIUM

### M1. Winston file transports assume `logs/` exists (bridge-server.ts, mcp-server.ts)
Both configure `winston.transports.File({ filename: 'logs/...' })`. Winston does not create the directory; on a fresh clone without docker (Dockerfile does `mkdir -p logs`, plain `npm start` does not) the transport errors at startup. Fix: `mkdirSync('logs', { recursive: true })` before creating the logger.

### M2. Per-actor rate limiting doesn't work as documented (mcp-server.ts)
Route order is `mutateLimiter, verifyDocAccess, ...`, so the limiter's `keyGenerator: req => req.actorId || req.ip` always sees `actorId === undefined` and falls back to IP. ADR-005 promises per-actor limiting. Fix: run `verifyDocAccess` before `mutateLimiter`.

### M3. `GET /docs/:docId` returns a stub (mcp-server.ts)
Returns `{ docId, status: 'active' }` without touching the bridge. The README documents a document-read API; this endpoint pretends to be it. Fix: proxy to the bridge's real `GET /docs/:docId`.

### M4. `safeSerialize` computes `originalSize` outside the try (crdt-callback.ts)
`const originalSize = JSON.stringify(data).length` runs before the `try`; circular input throws `TypeError` there, bypassing the careful circular-safe fallback inside the `try` (the caller's catch still handles it, but the "safe" path is defeated). Fix: move inside `try`.

### M5. `crdt-callback.ts` ignores its own config + is unwired
`pathPrefix` is accepted but the root map is hardcoded to `'agents'`; `enableCompression` is accepted and never used. The handler is exported but instantiated nowhere in the repo. Yjs subdocument usage (`rootMap.set(agentId, new Y.Doc())`) needs empirical verification that the nested doc is usable/syncable without an explicit `load()` — to be tested after `npm install`.

### M6. `loadOrCreateDocument` skips the Postgres fallback on corrupt Redis data (bridge-server.ts)
If `redisData` exists but fails `Y.applyUpdate`, the code warns and continues with an empty doc; the Postgres fallback only runs when `!redisData`. A corrupt cache entry permanently shadows the durable copy for that process lifetime.

### M7. `getDocument` returns a `meta` hash that is never populated (bridge-server.ts)
`meta` comes from `redis.hGetAll('aetherstate:meta:...')`, but nothing ever writes that hash — always `{}`. Dead contract.

### M8. Full-state snapshot on every mutation (bridge-server.ts)
`mutate()` calls `Y.encodeStateAsUpdate(state.doc)` — the **full** document state, not the incremental update — then writes it to Redis, Postgres, and `broadcastToMesh` on every single key-set. Correct (Yjs merges full state fine) but O(doc) per op in bandwidth and storage; the variable name `update` is misleading. Performance note, not a correctness bug. Left as-is (redesigning the sync protocol is out of scope).

## LOW

- **L1.** `package.json` `repository.url` / `bugs.url` still point at `yourusername/aetherstate` placeholders.
- **L2.** `webrtc-signaling.ts` `shutdown()` closes the `WebSocketServer` but not the underlying HTTP server; standalone block handles SIGTERM but not SIGINT and uses inline `require('http')`.
- **L3.** `webrtc-signaling.ts` `SignalMessage.type` doesn't include the server-sent `'connected'`/`'joined'`/`'error'`/etc. message types (masked by `any` in `sendToPeer`).
- **L4.** `index.ts` has no `unhandledRejection` handler.
- **L5.** `websocket-pool.ts` `release()` handing a connection to a waiter doesn't refresh its `connectionAges` entry (stale age → premature destroy).
- **L6.** `websocket-pool.ts` `validateConnection` is `async` but only checks `readyState` (could check pong freshness); `shutdown()` sleeps 1000ms for no reason and doesn't destroy checked-out connections.
- **L7.** `mcp-server.ts` `sendToBridge` is fire-and-forget with no ack/correlation — superseded by the HTTP-forwarding fix.
- **L8.** `Dockerfile` uses deprecated `npm ci --only=production` (works; `--omit=dev` preferred). Not changed.
- **L9.** `crdt-callback.ts` `peer.metadata = claims` (signaling) stores full JWT claims on the peer object — minor data-minimization note.

## What was NOT broken (verified by reading)

- Signaling JWT verification (`RS256` pinned, `docIds` ACL on join, per-message doc membership checks) is sound, modulo H3.
- MCP's zod schema, helmet/cors setup, audit-log wrapper, and centralized error handler are correctly wired, modulo M2/M3/C1.
- Bridge's Postgres upsert uses parameterized queries (no SQL injection); Redis keys are namespaced; idempotency dedup is coherent.
- `tsconfig` is strict; no `any`-leaks beyond the noted spots.

---

## Repair log

All fixes are uncommitted working-tree changes in `~/workspace/aetherstate_v2/` (git HEAD untouched at `0d5ab32`). Nothing under `.git` was altered.

### mcp-server.ts (C1, C2, C3, M2, M3 + one found during verification)
- **C3:** added `if (require.main === module)` standalone boot with `mcpServer.listen(MCP_PORT)` — `npm run start:mcp` (docker-compose) now actually serves.
- **C1+C2:** deleted the broken WebSocketPool forwarding (`(req as any).bridgePool` was never set; the pool targeted the bridge's HTTP-only port). Mutations are now forwarded via HTTP POST to `BRIDGE_URL` (default `http://localhost:8080`) using the bridge's real `/mutate` endpoint, with a 10s abort timeout. New `BridgeError` carries the bridge's status code.
- **M3:** `GET /docs/:docId` now proxies the bridge's real endpoint instead of returning `{docId, status:'active'}`; bridge 404s pass through as 404.
- **M2:** middleware order fixed to `verifyDocAccess` → `mutateLimiter` so per-actor rate limiting (ADR-005) actually keys on `actorId`.
- Async handlers now call `next(err)` instead of bare `throw` (Express 4 drops async rejections; requests previously hung).
- `errorHandler` honors `BridgeError.statusCode` (502 unreachable / 404 passthrough); unknown errors stay opaque 500s.
- Removed the now-dead `WebSocketPool` import and `sendToBridge`.
- `logs/` directory is created before the winston file transports (M1).

### bridge-server.ts (H4, C4, M1, M6)
- **H4:** module-bottom `start()` guarded by `if (require.main === module)` — importing the module no longer boots a duplicate bridge. The single module-level bridge instance and its Express app are exported as `bridgeInstance`/`bridgeApp` for the orchestrator.
- **C4:** removed the `embedding VECTOR(1536)` column (pgvector not provided by the compose Postgres; nothing ever wrote the column). Schema init now succeeds on stock `postgres:16`.
- **M6:** corrupt Redis data no longer shadows Postgres — the Postgres fallback runs whenever the Redis load didn't succeed.
- `logs/` directory creation (M1).

### index.ts
- Removed the dead `WebSocketPool` creation and the `(mcpServer as any).bridgePool` assignment; uses the single exported `bridgeInstance`/`bridgeApp` (one bridge per process, HTTP served on `BRIDGE_PORT`).
- Added `unhandledRejection` logging (L4).

### websocket-pool.ts (H2, L5)
- **H2:** `destroyConnection()` is now idempotent via a `WeakSet` — the `'close'`-event path and the `acquire()`-catch path can no longer double-decrement `currentTotalConnections` (it went to -1 and defeated the pool-size guard). The catch block no longer decrements manually; the `'error'` handler destroys explicitly.
- **L5:** waiter handoff refreshes the connection's age.
- Note: `reconnectAttempts`/`reconnectDelay`/`reconnectBackoffMultiplier` remain accepted-but-unused config — no reconnect logic ever existed (IMPLEMENTATION_SUMMARY.md's claim is false). Left as config surface; not implemented (would be new behavior).

### webrtc-signaling.ts (H3, L2)
- **H3:** peer IDs are now always `randomUUID()`; the JWT `sub` is stored separately as `actorId`. Same-sub double connections no longer collide/disconnect each other.
- **L2:** `shutdown()` now also closes the underlying HTTP server (previously left the socket bound and the event loop alive — this hung the jest run).

### crdt-callback.ts (M4, M5)
- **M5 (confirmed by experiment):** nested `Y.Doc` inside the agents map does **not** replicate its content on sync (subdoc semantics) — history was silently lost to peers. Replaced with a nested `Y.Map`, which replicates correctly for both full-state and incremental updates (verified empirically).
- `pathPrefix` config is now honored (was hardcoded `'agents'`).
- **M4:** `originalSize` is best-effort inside the serialization flow; circular input now reaches the `'[Circular Reference]'` fallback instead of throwing past it.

### package.json / docker-compose.yml
- Fixed `repository`/`bugs`/`homepage` placeholder URLs (`yourusername` → `jasethepeople/aetherstate_v2`).
- Added `BRIDGE_URL=http://bridge-server:8080` to the compose MCP service.

### Tests added (were zero)
- `jest.config.js` (ts-jest).
- `websocket-pool.test.ts` — acquire/release recycle, waiter handoff, double-destroy accounting (regression for H2), failed-connection accounting.
- `crdt-callback.test.ts` — cross-doc history replication (regression for M5), circular-input safety, truncation, retention cap, pathPrefix.
- `webrtc-signaling.test.ts` — same-sub double connection gets distinct peer IDs and both survive (regression for H3); tokenless connections rejected with 4001.

## Verification

- `npx tsc --noEmit` — clean (strict).
- Full clean rebuild: `rm -rf node_modules dist && npm install` (624 packages) → `npm run build` — exit 0.
- `npx jest --ci` — **3 suites, 11 tests, all pass**.
- Boot checks (built `dist`, throwaway RSA keypair, no infra):
  - `node dist/mcp-server.js` standalone — **listens** (C3 fixed): `/health` 200, `/metrics` 200, no-token mutate 401, bad key 400 (zod), valid-token mutate with bridge down 502 `Bridge unreachable`, doc read with bridge down 502, wrong-doc claim 403.
  - `node dist/webrtc-signaling.js` standalone — listens; `/health` + `/metrics` 200; real WS connect with RS256 JWT → `connected` with UUID peerId → `join` → `joined` with peerCount.
  - `node dist/bridge-server.js` — without Redis/Postgres it retries connections and logs `Redis error` (no code crash; fails for the right reason). Full mutation path through Redis+Postgres is **infra-dependent, not verified here**.
- `git log` unchanged (HEAD `0d5ab32`); `git status` shows only modified/untracked working-tree files.

## H1 implementation (user ruling 2026-10-02: Option A)

The user ruled **Option A**: add RS256 auth to the bridge, with the MCP forwarding the caller's `Authorization` header. Implemented and verified:

**New file `auth.ts`** — the single shared auth module. `verifyDocAccess(getDocId)` is a middleware factory implementing the exact verification logic the MCP server previously had inline (RS256 via `JWT_PUBLIC_KEY`, 30s clock tolerance, `sub` + `docIds` claim shape checks, `*` wildcard, 401 on missing/invalid/malformed token, 403 when the token's `docIds` don't cover the target document). `getDocId` extracts the target document: MCP passes `req => req.params.docId`, the bridge's `POST /mutate` passes `req => req.body?.docId`. `DocClaims`/`AuthenticatedRequest` moved here from `mcp-server.ts`. One scheme, not two — no drift possible.

**`mcp-server.ts`** — local `DocClaims`/`AuthenticatedRequest`/`validateJwtConfig`/`verifyDocAccess` deleted; imports the shared middleware (`verifyDocAccess(req => req.params.docId)` on both routes — identical behavior to before, verified by the unchanged existing tests). `forwardToBridge(path, body, authHeader?)` now takes the caller's `Authorization` header and forwards it to the bridge, so the bridge sees the end-user's token, not an MCP-service identity. Both proxy call sites pass `req.headers.authorization`.

**`bridge-server.ts`** — `POST /mutate` and `GET /docs/:docId` now run the shared `verifyDocAccess` (defense in depth; the bridge port is published in docker-compose). The mutate handler attributes the operation to the verified token's `sub` (`req.actorId ?? body.actorId`) instead of trusting the body's `actorId`, which a direct caller could forge. `/health` stays open; `/metrics` lockdowns (2026-10-02, user-approved): the bridge's `GET /metrics` (`bridge-server.ts:501`) and the MCP's `GET /metrics` (`mcp-server.ts:166`) now both run the shared `verifyDocAccess(() => '*')` — server-level telemetry requiring the `*` wildcard claim (401 no/invalid token, 403 non-privileged token). No monitoring-scraper contract keeps either open (Prometheus/Grafana is on the project's TODO list; compose defines no scraper). `/health` remains open on both.

**Tests** — 12 new, all passing alongside the 11 existing (23/23 total, 5/5 suites):
- `bridge-auth.test.ts` (8): `/mutate` 401 no-token / 403 wrong-doc / 401 bad-token / 200 valid-token with `actorId` asserted from the token sub despite a forged body value; `/docs/:docId` 401 / 403 / 200; `/health` open. The 200-path tests mock `bridgeInstance.mutate`/`getDocument` (no Redis/Postgres in this environment — the middleware under test runs before any storage touch).
- `mcp-proxy.test.ts` (4): stub-bridge HTTP server captures what the MCP forwards — mutate and read both arrive with the *exact* caller `Bearer` token (asserted byte-equal), MCP's own 401/403 fire before the bridge is ever contacted (stub sees zero requests).

**Verification** — `npx tsc --noEmit` clean (strict), `npm run build` exit 0, `npx jest`: 5 suites / 23 tests green. No commits or pushes; all changes are uncommitted working-tree modifications.

### /metrics auth lockdown (2026-10-02, user-approved)

The one hole left by the H1 ruling: both servers' `GET /metrics` endpoints were unauthenticated while every other endpoint required RS256 auth. Checked first for a legitimate reason to keep them open (monitoring scraper contract): none — Prometheus/Grafana integration is on the project's TODO list (`README.md`, `CONTRIBUTING.md`), and `docker-compose.yml` defines no scraper against either endpoint.

- **`bridge-server.ts:501`** — `GET /metrics` now runs `verifyDocAccess(() => '*')` from the shared `auth.ts` (same middleware as the other bridge endpoints). Server-level telemetry, not document-scoped: `getDocId` returns `'*'`, so only tokens carrying the wildcard claim get 200; doc-specific tokens get 403; missing/invalid get 401. No new auth scheme, no `auth.ts` changes. +3 tests in `bridge-auth.test.ts` (401/403/200, metrics shape asserted).
- **`mcp-server.ts:166`** — `GET /metrics` now runs the identical `verifyDocAccess(() => '*')` (the MCP already imported it). Same semantics. +3 tests in `mcp-proxy.test.ts` (401/403/200, `uptime`/`memory`/`timestamp` shape asserted). Note: the 401 message asserted is the shared middleware's literal `'Missing bearer token'` string.
- **Verification** — `npx tsc --noEmit` clean (strict), `npm run build` exit 0, `npx jest`: 5 suites / **29 tests green** (26 → 29 with the 3 new MCP tests; the 3 bridge tests were already in). Full mutation path through real Redis/Postgres remains unverifiable in this environment (auth runs before any storage touch, so the 401/403 paths are fully verified). No commits or pushes.

## Remaining gaps / needs-user-ruling

1. **H1 — RESOLVED** (see "H1 implementation" above).
2. **Infra-dependent, not verifiable in this environment:** end-to-end mutation through real Redis + PostgreSQL (dual-tier persistence, snapshot cycle, TTL cleanup); WebRTC P2P between real browser peers (signaling only verified); LangChain callback against a live model; `docker-compose up` full-stack boot (no docker daemon here — the compose file was edited but never executed).
3. **Known dead surface left intentionally:** `WebSocketPool` is now unused by the mutation path (kept as a fixed, tested utility); `reconnectAttempts`-style options are accepted but unimplemented; `crdt-callback.ts` is exported but instantiated nowhere; `GET /docs/:docId` returns `meta: {}` (the `aetherstate:meta:*` Redis hash is never written — M7); per-mutation full-state snapshots to Postgres/Redis (M8, O(doc) per op) is correct but wasteful — changing the sync protocol would be a redesign.
4. Minor hygiene not touched: `Dockerfile`'s deprecated `npm ci --only=production` (works), `SignalMessage` type not covering server-sent message kinds, winston `metadata: claims` storing full JWT claims on peer objects.
