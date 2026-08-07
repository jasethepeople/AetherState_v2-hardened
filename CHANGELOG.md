# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2024-XX-XX

### Added
- **Yjs CRDT Engine**: Production-grade CRDT implementation replacing custom prototype
- **Dual-Tier Persistence**: Redis hot-cache + PostgreSQL durable store with automatic failover
- **WebRTC Signaling Server**: Full peer discovery, NAT traversal, and ICE relay
- **Cellular Mesh Topology**: Optional partitioned mesh for scaling beyond 8 peers per document
- **WebSocket Pool**: Connection health checks, heartbeat, reconnection, metrics, graceful shutdown
- **Rate Limiting**: Per-actor and per-IP request throttling via express-rate-limit
- **Input Validation**: Zod schemas with type inference and size limits
- **Audit Logging**: Structured Winston logging of all mutations with actor ID, IP, timestamp
- **Security Headers**: Helmet.js with CSP, HSTS, X-Frame-Options
- **CORS**: Configurable origin whitelist
- **Docker Compose**: One-command deployment with Redis, PostgreSQL, and all services
- **Health Checks**: HTTP health endpoints for all services
- **Metrics Endpoints**: Operational metrics for monitoring
- **CRDT Callback Handler**: LangChain integration with retention policies and safe serialization
- **Idempotency**: Duplicate operation detection and deduplication
- **Document TTL**: Automatic cleanup of inactive documents
- **Snapshot Cycle**: Periodic persistence of dirty documents
- **PostgreSQL Schema**: Document snapshots and operation history tables
- **Graceful Shutdown**: SIGTERM/SIGINT handling with final snapshot

### Changed
- Replaced custom AetherDoc CRDT with Yjs (Nédelec et al., 2016)
- Replaced in-memory-only storage with Redis + PostgreSQL dual persistence
- Replaced basic WebSocket handling with production pool manager
- Replaced simple JWT middleware with comprehensive security model
- Replaced console logging with structured Winston JSON logging

### Fixed
- Memory leaks from unbounded document Maps
- Race conditions on shared document state (Yjs handles concurrency)
- Stale WebSocket connections accumulating in pool
- Missing input validation on mutation endpoints
- Missing error handling in callback handlers
- No persistence across server restarts

## [1.0.0] - 2024-XX-XX

### Added
- Initial architecture concept
- Basic WebSocket pool sketch
- JWT middleware prototype
- In-memory bridge server
- Conceptual CRDT integration
- Sample README
