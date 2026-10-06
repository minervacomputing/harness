# Minerva run worker. Built as minerva-worker:<tag> and started by the supervisor's container provider
# with a read-only root filesystem, no capabilities, and no network: only a Unix socket to the gateway.
FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=512
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER 1000:1000
ENTRYPOINT ["node", "/app/src/main.ts"]
