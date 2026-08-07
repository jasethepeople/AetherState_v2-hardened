# Contributing to AetherState

Thank you for your interest in contributing to AetherState! This project welcomes contributions from researchers, developers, and practitioners in distributed systems, CRDTs, and real-time collaboration.

## Development Setup

```bash
# 1. Fork and clone
git clone https://github.com/yourusername/aetherstate.git
cd aetherstate

# 2. Install dependencies
npm install

# 3. Copy environment template
cp .env.example .env
# Edit .env with your credentials

# 4. Start development services
npm run dev
```

## Code Style

- **TypeScript**: Strict mode enabled. All code must pass `tsc --noEmit`
- **Linting**: ESLint with `@typescript-eslint` rules. Run `npm run lint`
- **Formatting**: Use 4 spaces for indentation, 120 character line width
- **Naming**: `PascalCase` for classes, `camelCase` for functions/variables, `SCREAMING_SNAKE_CASE` for constants

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Watch mode
npm run test:watch
```

## Pull Request Process

1. **Fork** the repository and create a feature branch
2. **Write** tests for new functionality
3. **Ensure** all tests pass (`npm test`)
4. **Lint** your code (`npm run lint`)
5. **Type-check** your code (`npm run typecheck`)
6. **Document** new features in README.md
7. **Update** CHANGELOG.md with your changes
8. **Submit** a pull request with a clear description

## Commit Messages

Use conventional commits format:

```
feat: add cellular mesh topology support
fix: resolve WebSocket pool memory leak
docs: update API reference for signaling protocol
refactor: simplify CRDT callback handler
test: add bridge server integration tests
```

## Areas for Contribution

### High Priority
- [ ] WebRTC data channel encryption (DTLS)
- [ ] Operational Transform (OT) fallback for legacy clients
- [ ] Redis pub/sub for cross-instance document sync
- [ ] PostgreSQL read replica support
- [ ] Prometheus metrics exporter
- [ ] OpenAPI/Swagger documentation

### Research Directions
- [ ] CRDT garbage collection strategies
- [ ] Causal consistency benchmarks
- [ ] WebRTC mesh topology optimization algorithms
- [ ] Semantic embedding model integration (local LLMs)
- [ ] Edge computing deployment patterns

### Documentation
- [ ] Architecture decision records (ADRs)
- [ ] Performance benchmarking guide
- [ ] Security audit checklist
- [ ] Deployment runbooks

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Credit original authors when building on prior work
- Respect academic attribution standards

## Questions?

Open an issue or discussion on GitHub. For security concerns, please email security@aetherstate.dev.
