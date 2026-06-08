# syntax=docker/dockerfile:1

# ── Build the SPA ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app

# Install deps first (layer-cached on manifests + lockfile).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile --filter "@radio/web..."

# Sources + build. @radio/shared exports its TS source, so Vite compiles it directly —
# no separate shared build step. VITE_API_BASE defaults to "" (same-origin relative URLs).
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN pnpm --filter @radio/web build

# ── Serve static files + proxy the API to the backend container ────────────
FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
