# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Install dependencies (leverage layer cache)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/
RUN pnpm install --frozen-lockfile --prod=false

# Copy source and build
COPY tsconfig.base.json ./
COPY packages/server ./packages/server
COPY packages/client ./packages/client

RUN pnpm --filter @homectl/server build
RUN pnpm --filter @gagnatdev/homectl-auth-client build

# Prune dev dependencies
RUN pnpm --filter @homectl/server deploy --prod --legacy /app/deploy

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

WORKDIR /app

# Copy pruned production deps + built output
COPY --from=builder /app/deploy .

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

CMD ["node", "dist/index.js"]
