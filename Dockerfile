# ============================================================================
#  Multi-stage Dockerfile for the Blockchain Voting Node
# ============================================================================
#
#  Stage 1 (builder)  — install ALL deps + compile TypeScript → dist/
#  Stage 2 (runtime)  — copy compiled JS + production deps only
#
#  Using node:18-alpine for a small, stable image.
# ============================================================================

# ---------------------
# Stage 1 — Build
# ---------------------
FROM node:18-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ---------------------
# Stage 2 — Production
# ---------------------
FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY public/ ./public/

EXPOSE 3000 6000

CMD ["npm", "start"]
