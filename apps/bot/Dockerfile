# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

RUN corepack enable
WORKDIR /app

# Install deps first (Docker layer cache keyed on manifests + lockfile).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/bot/package.json ./apps/bot/package.json
RUN pnpm install --frozen-lockfile --filter "@radio/bot..."

# App sources (no ffmpeg/yt-dlp/deno — the bot only reads the radio HTTP API + talks to Telegram).
COPY packages/shared ./packages/shared
COPY apps/bot ./apps/bot

ENV NODE_ENV=production \
    STATE_FILE_PATH=/data/bot-state.json

# Non-root user + a writable /data for the persisted notification state (a docker volume).
RUN mkdir -p /data \
    && useradd --create-home --uid 10001 app \
    && chown -R app:app /app /data
USER app

WORKDIR /app/apps/bot
# Outbound-only (long-polling) — no EXPOSE. Run tsx directly (no corepack at runtime).
CMD ["node_modules/.bin/tsx", "src/index.ts"]
