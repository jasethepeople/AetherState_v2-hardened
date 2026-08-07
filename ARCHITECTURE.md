# AetherState Architecture Decision Records

## ADR-001: CRDT Library Selection

**Status**: Accepted
**Date**: 2024-XX-XX

### Context

The original AetherState prototype included a conceptual CRDT implementation but no actual algorithm. We needed to select a production-grade CRDT library.

### Decision

Use **Yjs** (Nédelec et al., 2016) as the CRDT engine.

### Rationale

| Criteria | Yjs | Automerge | Custom |
|----------|-----|-----------|--------|
| Maturity | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐ |
| Performance | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ |
| Delta sync | ✅ | ✅ | ❌ |
| Offline support | ✅ | ✅ | ❌ |
| TypeScript | ✅ | ✅ | ✅ |
| Community | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐ |
| Space complexity | O(M+S) | O(N) | Unknown |

Yjs offers the best combination of maturity, performance, and community support. Its struct-store optimization achieves O(M+S) space complexity where M = active characters and S = metadata, compared to Automerge's O(N) where N = total operations.

### Consequences

- **Positive**: Battle-tested, well-documented, active community
- **Positive**: Delta-based sync minimizes bandwidth
- **Negative**: Less flexible than a custom implementation for novel CRDT types
- **Mitigation**: Yjs is extensible via custom types if needed

---

## ADR-002: Dual-Tier Persistence

**Status**: Accepted
**Date**: 2024-XX-XX

### Context

The original prototype stored all state in-memory, causing total data loss on server restart. We needed a persistence strategy balancing performance and durability.

### Decision

Implement **dual-tier persistence** with Redis (hot cache) and PostgreSQL (durable store).

### Rationale

| Tier | Technology | Purpose | RPO | RTO |
|------|-----------|---------|-----|-----|
| Hot | Redis | Real-time sync, sub-millisecond reads | ~5 min (snapshot interval) | <1s |
| Warm | Redis AOF | Crash recovery | 0 (append-only) | <10s |
| Cold | PostgreSQL | Durable snapshots, audit history | 0 | <10s |

Redis handles real-time performance. PostgreSQL provides ACID guarantees, queryable history, and disaster recovery. The bridge loads from Redis first (fast), falls back to PostgreSQL (durable), and writes to both.

### Consequences

- **Positive**: Sub-millisecond reads for active documents
- **Positive**: Full durability with PostgreSQL snapshots
- **Positive**: Queryable operation history for audit and research
- **Negative**: Increased operational complexity (two databases)
- **Mitigation**: Docker Compose handles orchestration; both are standard infrastructure

---

## ADR-003: WebRTC Mesh Topology

**Status**: Accepted
**Date**: 2024-XX-XX

### Context

WebRTC enables direct peer-to-peer communication, but full mesh scales poorly (O(N²) connections). We needed a topology strategy.

### Decision

Implement **full mesh** as default (up to 8 peers), with **cellular mesh** as optional scaling strategy.

### Rationale

Research (BrickSync, 2024) shows that for small groups (≤8), full mesh provides the lowest latency and simplest implementation. For larger groups, cellular mesh partitions peers into sub-meshes of size C, reducing connections to O(N·C).

| Topology | Connections | Latency | Complexity | Use Case |
|----------|------------|---------|------------|----------|
| Full mesh | N(N-1)/2 | Lowest | Low | ≤8 peers |
| Star | N-1 | Medium | Medium | Central relay |
| Cellular mesh | ~N·C | Low | Medium | >8 peers |
| SFU | N | Medium | High | Video conferencing |

### Consequences

- **Positive**: Simple default for research and small deployments
- **Positive**: Scalable path for production use
- **Negative**: Cellular mesh requires relay peer selection algorithm
- **Mitigation**: Relay selection based on network proximity (future enhancement)

---

## ADR-004: Authentication Strategy

**Status**: Accepted
**Date**: 2024-XX-XX

### Context

The system needs to authenticate both human users (browsers) and AI agents (services) across multiple services (MCP, Bridge, Signaling).

### Decision

Use **RS256 JWT** with document-level claims.

### Rationale

| Approach | Pros | Cons |
|----------|------|------|
| RS256 JWT | Asymmetric, no shared secrets, standard | Requires key management |
| HS256 JWT | Simple, symmetric | Shared secret risk |
| OAuth2 | Rich ecosystem | Complex, overkill for P2P |
| mTLS | Strong auth | Certificate management overhead |

RS256 allows the signing key (private) to remain on the auth server while verification keys (public) are distributed to all services. Document-level claims (`docIds`) enable fine-grained authorization without a central policy server.

### Consequences

- **Positive**: No shared secrets between services
- **Positive**: Document-level ACL without external policy check
- **Negative**: Key rotation requires coordination
- **Mitigation**: Support JWKS endpoint for dynamic key rotation (future)

---

## ADR-005: Rate Limiting Strategy

**Status**: Accepted
**Date**: 2024-XX-XX

### Context

Mutation endpoints are vulnerable to abuse. We needed rate limiting that works for both human users and automated agents.

### Decision

Implement **per-actor rate limiting** with **per-IP fallback**.

### Rationale

Human users are identified by JWT `sub` claim (actor ID). AI agents also use JWT tokens with actor IDs. Per-actor limiting prevents individual actors from overwhelming the system. Per-IP fallback catches unauthenticated or misconfigured clients.

| Limit | Window | Scope | Purpose |
|-------|--------|-------|---------|
| 60 req/min | 1 minute | Actor ID | Prevent individual actor abuse |
| 1000 req/15min | 15 minutes | IP address | Prevent DDoS from single IP |

### Consequences

- **Positive**: Fair resource allocation across actors
- **Positive**: DDoS protection at network layer
- **Negative**: Shared IP environments (NAT, proxies) may hit limits
- **Mitigation**: Configurable limits, X-Forwarded-For support (future)
