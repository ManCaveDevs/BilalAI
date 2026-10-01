# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

# ---- run ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/data/bilal.db \
    HEALTH_FILE=/data/heartbeat \
    AUDIO_DIR=/app/assets/audio
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY assets ./assets
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
# Healthy while the scheduler has ticked in the last 60 seconds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const t=+require('fs').readFileSync(process.env.HEALTH_FILE,'utf8');process.exit(Date.now()-t<60000?0:1)"
CMD ["node", "dist/src/index.js"]
