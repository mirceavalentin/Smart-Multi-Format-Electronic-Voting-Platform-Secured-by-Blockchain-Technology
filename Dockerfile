# ============================================================================
#  Multi-stage Dockerfile for the Blockchain Voting Node
# ============================================================================
#
#  Stage 1 (builder)  — install ALL deps + compile TypeScript → dist/
#  Stage 2 (runtime)  — copy compiled JS + production deps only
#
#  Using node:18-alpine for a small, secure image.
#  The P2P WebSocket server port (6000) has been removed because inter-node
#  communication now goes through RabbitMQ rather than direct WebSocket
#  connections. Only the HTTP port (3000) is exposed.

# ─── Stage 1: Build ─────────────────────────────────────────────────────────
FROM node:18-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ─── Stage 2: Runtime ───────────────────────────────────────────────────────
FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY public/ ./public/

# HTTP API / web UI port. RabbitMQ connection is outbound-only (no EXPOSE needed).
EXPOSE 3000

CMD ["npm", "start"]
