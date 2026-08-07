# =============================================================================
# AetherState v2.0 — Production Container
# =============================================================================

FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript to JavaScript
RUN npm run build

# =============================================================================
# Production stage
# =============================================================================
FROM node:20-alpine

WORKDIR /app

# Install wget for healthchecks
RUN apk add --no-cache wget

# Copy production dependencies only
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy built artifacts from builder stage
COPY --from=builder /app/dist ./dist

# Create logs directory
RUN mkdir -p logs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:3000/health || wget --quiet --tries=1 --spider http://localhost:8080/health || wget --quiet --tries=1 --spider http://localhost:8081/health || exit 1

# Expose all service ports
EXPOSE 3000 8080 8081 8082

# Run the orchestrator by default
CMD ["node", "dist/index.js"]
