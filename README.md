# AetherState

> **AetherState** is a real-time collaborative platform that enables Conflict-free Replicated Data Type (CRDT) based synchronization between human users and AI agents across distributed edge nodes. It combines WebRTC peer-to-peer mesh networking, dual-tier persistence (Redis hot-cache + PostgreSQL durable store), and JWT-based access control to provide a production-grade infrastructure for human-AI collaborative editing.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)

---

## Table of Contents

1. [Abstract](#abstract)
2. [Architecture Overview](#architecture-overview)
3. [Key Features](#key-features)
4. [Technology Stack](#technology-stack)
5. [Installation](#installation)
6. [Configuration](#configuration)
7. [Usage](#usage)
8. [API Reference](#api-reference)
9. [WebRTC Signaling Protocol](#webrtc-signaling-protocol)
10. [Security Model](#security-model)
11. [Deployment](#deployment)
12. [Monitoring & Observability](#monitoring--observability)
13. [Contributing](#contributing)
14. [License](#license)
15. [Changelog](#changelog)
16. [References](#references)

---

## Abstract

AetherState addresses the fundamental challenge of real-time collaborative state synchronization in distributed systems where both human users and autonomous AI agents operate as first-class peers. Traditional client-server architectures introduce latency bottlenecks and single points of failure. AetherState solves this by:

- **CRDT-based state merging** using the Yjs library, which guarantees strong eventual consistency without coordination
- **WebRTC mesh networking** for direct peer-to-peer communication, reducing server load and latency
- **Cellular mesh topology** for scaling beyond small-group collaboration (8+ peers per document)
- **Dual-tier persistence** with Redis for hot in-memory state and PostgreSQL for durable, queryable operation history
- **JWT-based document-level access control** with asymmetric RS256 signing

This architecture is suitable for research in collaborative editing, distributed AI agent coordination, edge computing, and real-time collaborative systems.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │  Browser    │  │  Browser    │  │  AI Agent   │  │  Mobile     │      │
│  │  (Human)    │  │  (Human)    │  │  (LangChain)│  │  (Human)    │      │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘      │
│         │                │                │                │                 │
│         │ HTTPS/WSS     │ HTTPS/WSS     │ HTTPS/WSS     │ HTTPS/WSS      │
│         ▼                ▼                ▼                ▼                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API GATEWAY (MCP Server)                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  • JWT Authentication (RS256)                                       │    │
│  │  • Document-Level Access Control (docIds claim)                     │    │
│  │  • Rate Limiting (per-actor, per-IP)                                │    │
│  │  • Input Validation (Zod schemas)                                     │    │
│  │  • Audit Logging (structured Winston)                               │    │
│  │  • CORS + Helmet Security Headers                                   │    │
│  └────────────────────┬────────────────────────────────────────────────┘    │
└───────────────────────┼───────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              BRIDGE SERVER                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  • Yjs CRDT Engine (Conflict-free Replicated Data Types)            │    │
│  │  • Document State Management (in-memory + persistence)              │    │
│  │  • Operation Broadcasting (EventEmitter → WebRTC mesh)              │    │
│  │  • Idempotency Tracking (duplicate operation detection)               │    │
│  │  • Semantic Embedding Indexing (async, non-blocking)                  │    │
│  └────────────────────┬────────────────────────────────────────────────┘    │
└───────────────────────┼───────────────────────────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        ▼                               ▼
┌───────────────┐           ┌───────────────────┐
│    Redis      │           │    PostgreSQL     │
│  (Hot Cache)  │           │  (Durable Store)  │
│               │           │                   │
│ • doc state   │           │ • doc snapshots   │
│ • TTL expiry  │           │ • operation log   │
│ • pub/sub     │           │ • actor history   │
│ • metrics     │           │ • vector search   │
└───────────────┘           └───────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           WEBRTC SIGNALING SERVER                            │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  • Peer Discovery & Authentication (JWT over WebSocket)               │    │
│  │  • ICE/SDP Relay (offer/answer/ice-candidate forwarding)              │    │
│  │  • Document Membership Tracking                                       │    │
│  │  • Heartbeat & Timeout Management                                     │    │
│  │  • Cellular Mesh Topology (optional, for 8+ peers)                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Features

### 1. CRDT-Based State Synchronization

AetherState uses **Yjs** (Nédelec et al., 2016), a mature CRDT implementation that provides:

- **Conflict-free merging**: Concurrent edits from multiple peers merge deterministically without coordination
- **Delta updates**: Only changed data is transmitted, minimizing bandwidth
- **O(M+S) space complexity**: Where M = active characters and S = metadata overhead
- **Offline support**: Changes queue locally and sync when connectivity returns

### 2. Dual-Tier Persistence

| Tier | Technology | Purpose | Latency |
|------|-----------|---------|---------|
| **Hot Cache** | Redis | In-memory document state, real-time sync | <1ms |
| **Durable Store** | PostgreSQL | Snapshots, operation history, audit trail | <10ms |

This design ensures that:
- Server restarts do not lose document state (PostgreSQL recovery)
- Real-time performance is maintained (Redis hot cache)
- Operation history is queryable for audit and semantic search

### 3. WebRTC Mesh Networking

- **Full mesh**: Direct peer-to-peer connections between all document participants (default, up to 8 peers)
- **Cellular mesh**: Partitioned sub-meshes for scaling beyond 8 peers per document
- **NAT traversal**: ICE candidate relay through the signaling server
- **Fallback**: WebSocket transport when WebRTC is unavailable

### 4. Security Model

- **RS256 JWT**: Asymmetric signing with RSA public key verification
- **Document-level ACL**: Each token specifies accessible document IDs (wildcard `*` supported)
- **Rate limiting**: Per-actor and per-IP request throttling
- **Audit logging**: Every mutation logged with actor ID, timestamp, IP, and user agent
- **Input validation**: Zod schemas enforce type safety and size limits
- **CORS + Helmet**: Configurable origin whitelist and security headers

### 5. AI Agent Integration

LangChain-compatible callback handler that:
- Captures chain inputs/outputs in the CRDT document
- Records LLM prompts and generations
- Tracks tool invocations with input/output
- Enforces retention policies (configurable max history entries)
- Handles circular references and size limits safely

---

## Technology Stack

| Component | Technology | Version | Rationale |
|-----------|-----------|---------|-----------|
| Runtime | Node.js | ≥18.0.0 | Native WebSocket, async/await, performance |
| Language | TypeScript | 5.3 | Type safety, IntelliSense, maintainability |
| CRDT Engine | Yjs | 13.6.8 | Mature, delta sync, O(M+S) complexity |
| Hot Cache | Redis | 7.x | Pub/sub, TTL, in-memory performance |
| Durable Store | PostgreSQL | 16.x | ACID transactions, JSONB, vector search |
| WebSocket | ws | 8.14.2 | Native Node.js, minimal overhead |
| Auth | jsonwebtoken | 9.0.2 | RS256, industry standard |
| Validation | Zod | 3.22.4 | Type inference, composable schemas |
| Rate Limit | express-rate-limit | 7.1.5 | Battle-tested, configurable |
| Security | Helmet | 7.1.0 | Comprehensive security headers |
| Logging | Winston | 3.11.0 | Structured JSON, multiple transports |
| AI Integration | LangChain | 0.0.200 | Callback hooks, chain tracing |

---

## Installation

### Prerequisites

- **Node.js** ≥ 18.0.0
- **Redis** 7.x (or Docker)
- **PostgreSQL** 16.x (or Docker)
- **OpenSSL** (for JWT key generation)

### Option 1: Docker Compose (Recommended)

```bash
# Clone the repository
git clone https://github.com/yourusername/aetherstate.git
cd aetherstate

# Copy and configure environment
cp .env.example .env
# Edit .env with your JWT_PUBLIC_KEY

# Start all services (Redis, PostgreSQL, MCP, Bridge, Signaling)
docker-compose up -d

# Verify health
curl http://localhost:3000/health
curl http://localhost:8080/health
curl http://localhost:8082/metrics
```

### Option 2: Manual Installation

```bash
# 1. Clone repository
git clone https://github.com/yourusername/aetherstate.git
cd aetherstate

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your credentials

# 4. Start Redis and PostgreSQL
redis-server
pg_ctl start -D /usr/local/var/postgres

# 5. Build TypeScript
npm run build

# 6. Start services (in separate terminals)
npm run start:mcp      # Port 3000
npm run start:bridge   # Port 8080
npm run start:signaling # Port 8081
```

---

## Configuration

### Generating JWT Keys

```bash
# Generate RSA key pair
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem

# Set public key in .env (paste contents of public.pem)
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_PUBLIC_KEY` | **Yes** | — | RSA public key in PEM format |
| `REDIS_URL` | **Yes** | — | Redis connection URL |
| `POSTGRES_URL` | **Yes** | — | PostgreSQL connection URL |
| `MCP_PORT` | No | `3000` | MCP server port |
| `BRIDGE_PORT` | No | `8080` | Bridge server port |
| `SIGNALING_PORT` | No | `8081` | WebRTC signaling port |
| `DOC_TTL` | No | `1800000` | Document TTL (ms) |
| `MAX_DOC_SIZE` | No | `10000` | Max operations before snapshot |
| `SNAPSHOT_INTERVAL` | No | `300000` | Snapshot cycle (ms) |
| `WS_POOL_MAX_SIZE` | No | `50` | Max WebSocket connections |
| `RATE_LIMIT_MAX_REQUESTS` | No | `60` | Requests per minute |
| `ALLOWED_ORIGINS` | No | `http://localhost:3000` | CORS origins |
| `ENABLE_EMBEDDING` | No | `true` | Semantic indexing |
| `ENABLE_CELLULAR_MESH` | No | `false` | Cellular mesh topology |
| `CELLULAR_MESH_SIZE` | No | `8` | Peers per cell |
| `LOG_LEVEL` | No | `info` | Logging verbosity |

---

## Usage

### 1. Obtain a JWT Token

```bash
# Using your private key, sign a token with document access claims
# Claims structure:
# {
#   "sub": "user-123",
#   "docIds": ["doc-456", "doc-789"],
#   "iat": 1700000000,
#   "exp": 1700003600
# }
```

### 2. Connect to WebRTC Signaling

```javascript
const token = 'your-jwt-token';
const ws = new WebSocket(`wss://localhost:8081?token=${token}`);

ws.onopen = () => {
    // Join a document
    ws.send(JSON.stringify({
        type: 'join',
        docId: 'doc-456'
    }));
};

ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'joined') {
        console.log('Peers in document:', msg.payload.peers);
        // Initiate WebRTC peer connections...
    }
};
```

### 3. Mutate a Document (HTTP API)

```bash
curl -X POST http://localhost:3000/docs/doc-456/mutate \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "content.title",
    "value": "Collaborative Research Notes"
  }'
```

### 4. AI Agent Integration (LangChain)

```typescript
import { CRDTCallbackHandler } from 'aetherstate/crdt-callback';
import * as Y from 'yjs';

const doc = new Y.Doc();
const handler = new CRDTCallbackHandler({
    doc,
    agentId: 'agent-001',
    maxHistoryEntries: 1000,
    maxEntrySize: 1024 * 1024
});

// Attach to your LangChain chain
const chain = new LLMChain({ llm, prompt, callbacks: [handler] });
```

---

## API Reference

### MCP Server Endpoints

#### `GET /health`
Returns service health status.

**Response:**
```json
{
    "status": "healthy",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "version": "2.0.0"
}
```

#### `POST /docs/:docId/mutate`
Mutates a document key-value pair.

**Headers:**
- `Authorization: Bearer <jwt_token>`
- `Content-Type: application/json`

**Body:**
```json
{
    "key": "content.title",
    "value": "New Title"
}
```

**Response:**
```json
{
    "status": "accepted",
    "docId": "doc-456",
    "key": "content.title",
    "actorId": "user-123"
}
```

#### `GET /docs/:docId`
Retrieves document metadata.

**Headers:**
- `Authorization: Bearer <jwt_token>`

### Bridge Server Endpoints

#### `POST /mutate`
Direct bridge mutation (internal use).

**Body:**
```json
{
    "docId": "doc-456",
    "key": "content.title",
    "value": "New Title",
    "actorId": "user-123",
    "idempotencyKey": "unique-op-123"
}
```

#### `GET /docs/:docId`
Retrieves full document state.

**Response:**
```json
{
    "data": {
        "content.title": "New Title",
        "content.body": "Document body..."
    },
    "meta": {
        "lastAccessed": "1700000000000",
        "operationCount": "42",
        "actorCount": "3"
    }
}
```

### Signaling Server WebSocket Protocol

#### `join`
```json
{
    "type": "join",
    "docId": "doc-456"
}
```

#### `offer` / `answer` / `ice-candidate`
WebRTC signaling messages forwarded to target peer.
```json
{
    "type": "offer",
    "docId": "doc-456",
    "targetPeerId": "peer-789",
    "payload": { /* SDP offer */ }
}
```

#### `broadcast`
Broadcasts a message to all peers in a document.
```json
{
    "type": "broadcast",
    "docId": "doc-456",
    "payload": { /* Yjs update */ }
}
```

---

## WebRTC Signaling Protocol

### Connection Flow

```
Peer A                                    Peer B
  │                                        │
  │─── WebSocket connect ─────────────────▶│
  │   (JWT auth via query param)           │
  │                                        │
  │─── join {docId} ──────────────────────▶│
  │                                        │
  │◄── joined {peers: [B]} ────────────────│
  │                                        │
  │─── offer {sdp, targetPeerId: B} ──────▶│
  │   (forwarded via signaling server)     │
  │                                        │
  │◄── answer {sdp, targetPeerId: A} ─────│
  │                                        │
  │─── ice-candidate ─────────────────────▶│
  │◄── ice-candidate ─────────────────────│
  │                                        │
  │◄═══ WebRTC DataChannel established ════▶│
  │   (direct P2P, no server relay)        │
  │                                        │
  │◄─── Yjs sync messages ────────────────▶│
```

### Cellular Mesh Topology (Optional)

When `ENABLE_CELLULAR_MESH=true`, peers are partitioned into cells of size `CELLULAR_MESH_SIZE` (default 8):

```
Document: "doc-456" (20 peers)

┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│    Cell 1       │    │    Cell 2       │    │    Cell 3       │
│  (8 peers)      │◄──►│  (8 peers)      │◄──►│  (4 peers)      │
│                 │    │                 │    │                 │
│  P1 ── P2       │    │  P9 ── P10      │    │  P17 ─ P18      │
│  │ \  │        │    │  │ \  │         │    │  │ \  │         │
│  P3 ── P4       │    │  P11 ─ P12      │    │  P19 ─ P20      │
│  │ \  │        │    │  │ \  │         │    │                 │
│  P5 ── P6       │    │  P13 ─ P14      │    │                 │
│  │ \  │        │    │  │ \  │         │    │                 │
│  P7 ── P8       │    │  P15 ─ P16      │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
       ▲                      ▲                      ▲
       └──────────────────────┴──────────────────────┘
                    Cell Relay Peers
```

Each cell maintains full mesh internally. Cell relay peers forward messages between cells, reducing the overall connection count from O(N²) to O(N·C) where C = cell size.

---

## Security Model

### Authentication

All endpoints require JWT tokens signed with RS256 (RSA + SHA-256). The token payload must include:

```json
{
    "sub": "user-123",           // Actor ID
    "docIds": ["doc-456"],       // Accessible documents (or "*" for all)
    "iat": 1700000000,           // Issued at
    "exp": 1700003600            // Expiration
}
```

### Authorization

- **Document-level**: Tokens specify exactly which documents the actor can access
- **Wildcard support**: `"docIds": ["*"]` grants access to all documents
- **Scope enforcement**: Every mutation is validated against the token's docIds claim

### Rate Limiting

| Endpoint | Window | Max Requests | Key |
|----------|--------|-------------|-----|
| Global | 15 min | 1000 | IP address |
| Mutate | 1 min | 60 | Actor ID |

### Audit Logging

Every mutation is logged with:
- Actor ID (`sub` claim)
- Document ID
- Operation key and value (truncated)
- IP address and user agent
- Timestamp (ISO 8601)
- HTTP status code

---

## Deployment

### Production Checklist

- [ ] Generate strong RSA 2048+ key pair for JWT
- [ ] Configure Redis with AOF persistence (`appendonly yes`)
- [ ] Enable PostgreSSL with TLS certificates
- [ ] Set up log aggregation (ELK, Loki, or CloudWatch)
- [ ] Configure monitoring (Prometheus + Grafana)
- [ ] Set up alerts for error rates and latency
- [ ] Load test with expected traffic patterns
- [ ] Review rate limits for your use case
- [ ] Enable Redis authentication (`requirepass`)
- [ ] Set up PostgreSQL backup strategy (WAL archiving)
- [ ] Configure firewall rules (only expose necessary ports)
- [ ] Enable Docker health checks

### Scaling Strategy

**Horizontal scaling** is achieved by:

1. **Stateless MCP servers**: Run multiple instances behind a load balancer
2. **Shared Redis**: All instances connect to the same Redis cluster
3. **PostgreSQL read replicas**: Offload read queries to replicas
4. **WebRTC offloading**: Once P2P is established, servers are not in the data path

```yaml
# docker-compose.scale.yml
services:
  mcp-server:
    deploy:
      replicas: 3
    environment:
      - REDIS_URL=redis://redis-cluster:6379
  bridge-server:
    deploy:
      replicas: 3
```

---

## Monitoring & Observability

### Health Endpoints

| Service | Endpoint | Port |
|---------|----------|------|
| MCP Server | `GET /health` | 3000 |
| Bridge Server | `GET /health` | 8080 |
| Signaling Server | `GET /health` | 8082 |

### Metrics Endpoints

| Service | Endpoint | Key Metrics |
|---------|----------|-------------|
| MCP Server | `GET /metrics` | Uptime, memory usage |
| Bridge Server | `GET /metrics` | Documents, operations, actors, Redis/PG connectivity |
| Signaling Server | `GET /metrics` | Peers, documents, connections, cells |

### WebSocket Pool Metrics

```json
{
    "totalConnections": 42,
    "idleConnections": 15,
    "pendingRequests": 0,
    "failedConnections": 3,
    "avgAcquireTime": 12,
    "healthyConnections": 40
}
```

---

## Contributing

We welcome contributions from the research and open-source community.

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** changes (`git commit -m 'Add amazing feature'`)
4. **Push** to branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Development Setup

```bash
npm install
npm run dev        # Start all services in watch mode
npm test           # Run test suite
npm run lint       # Run ESLint
npm run typecheck  # TypeScript type checking
```

---

## License

MIT License — see [LICENSE](LICENSE) file.

---

## Changelog

### v2.0.0 (2024-XX-XX)

**Major Release — Production-Ready Architecture**

- **CRDT Engine**: Replaced custom implementation with Yjs (Nédelec et al., 2016)
- **Dual Persistence**: Added Redis hot-cache + PostgreSQL durable store
- **WebRTC Signaling**: Full signaling server with JWT auth and peer management
- **Cellular Mesh**: Optional topology for scaling beyond 8 peers per document
- **Security Hardening**: Rate limiting, input validation, audit logging, CORS, Helmet
- **WebSocket Pool**: Connection health checks, heartbeat, reconnection, metrics
- **Docker Compose**: One-command deployment with all services
- **Structured Logging**: Winston-based JSON logging with rotation
- **CRDT Callback Handler**: Safe LangChain integration with retention policies

### v1.0.0 (Initial)

- Basic WebSocket pooling concept
- JWT middleware sketch
- In-memory bridge prototype
- Conceptual CRDT integration

---

## References

1. Nédelec, B., Molli, P., Desmontils, E., & Blair, G. (2016). *Conflict-free Replicated Data Types for Collaborative Applications*. In Proceedings of the 2016 ACM Conference on Supporting Group Work (GROUP '16).

2. Baquero, C., & Shapiro, M. (2014). *Conflict-free Replicated Data Types*. In SSS 2014: Proceedings of the 16th International Symposium on Stabilization, Safety, and Security of Distributed Systems.

3. Shapiro, M., Preguiça, N., Baquero, C., & Zawirski, M. (2011). *A comprehensive study of Convergent and Commutative Replicated Data Types*. Research Report RR-7506, INRIA.

4. IETF. (2015). *RFC 7519: JSON Web Token (JWT)*. https://tools.ietf.org/html/rfc7519

5. W3C. (2021). *WebRTC 1.0: Real-Time Communication Between Browsers*. https://www.w3.org/TR/webrtc/

6. Yjs Documentation. (2023). *Yjs CRDT Documentation*. https://docs.yjs.dev/

---

## Citation

If you use AetherState in your research, please cite:

```bibtex
@software{aetherstate2024,
  title = {AetherState: Real-Time Collaborative CRDT Platform for Human-AI Co-Editing},
  author = {Your Name},
  year = {2024},
  version = {2.0.0},
  url = {https://github.com/yourusername/aetherstate}
}
```

---

**Built with ❤️ for the distributed systems research community.**
