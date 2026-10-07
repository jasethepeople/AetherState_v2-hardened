# AetherState (hardened fork)

A hardened fork of [AetherState_v2](../aetherstate_v2/README.md): the same real-time Yjs CRDT collaboration platform (WebRTC mesh, Redis + PostgreSQL, MCP gateway), with a completed security review applied on top.

## Features

Everything from the upstream fork, plus the security-review findings:

- **RS256 JWT auth middleware** (`auth.ts`) — document-level access control via `verifyDocAccess`, enforcing the `docIds` claim with asymmetric signatures instead of shared secrets.
- **`/metrics` lockdown** — both the bridge server (`bridge-server.ts:504`) and the MCP server (`mcp-server.ts:166`) now require the privileged access check instead of exposing server telemetry openly.
- **Test suite** — 29 tests across 5 Jest files: `bridge-auth.test.ts` (11), `crdt-callback.test.ts` (5), `mcp-proxy.test.ts` (7), `webrtc-signaling.test.ts` (2), `websocket-pool.test.ts` (4).
- **Review report** — `docs/REVIEW-REPORT.md` documents the full security review findings and fixes.
- **Strict TypeScript** — passes `tsc` under strict settings (`jest.config.js`, `tsconfig.json` in repo).

## Tech stack

Same as upstream: Node.js ≥ 18, TypeScript 5.3, Express 4, `ws`, Yjs 13, `jsonwebtoken` (RS256), Redis, PostgreSQL, Zod, Winston, Helmet. Test tooling: Jest 29, ts-jest.

## Getting started

```bash
npm install
cp .env.example .env   # JWT_PUBLIC_KEY (RSA public key, PEM), DATABASE_URL, Redis settings
npm run build
npm start
```

Run the test suite with `npx jest`. `docker-compose.yml` provisions Redis 7 and PostgreSQL 16.

## Project structure

```
├── auth.ts               # RS256 JWT middleware (new in this fork)
├── bridge-server.ts      # CRDT engine + persistence (hardened: metrics locked down)
├── mcp-server.ts         # MCP gateway (hardened: metrics locked down)
├── webrtc-signaling.ts   # WebRTC peer signaling
├── websocket-pool.ts     # WebSocket connection management
├── crdt-callback.ts      # CRDT change callbacks
├── *.test.ts             # 29 Jest tests
├── jest.config.js        # test config (new in this fork)
├── docs/REVIEW-REPORT.md # security review findings and fixes
└── docker-compose.yml
```

## Status

Completed hardened fork. The security review is finished and documented, the 29-test suite is in the repo, and the strict-tsc build is part of the workflow. Per the GitHub description: full security review, RS256 JWT auth, `/metrics` lockdown, 29 tests, strict tsc clean.
