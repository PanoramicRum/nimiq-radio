# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

# ── System deps: ffmpeg + python venv (for yt-dlp) + deno (yt-dlp's JS runtime) ──
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv ffmpeg curl unzip ca-certificates libchromaprint-tools \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp in an isolated venv:
#  - "[default]" pulls yt-dlp-ejs (the JS challenge solver) and sidesteps PEP 668,
#  - bgutil-ytdlp-pot-provider is the CLIENT plugin that talks to the bgutil sidecar
#    (the sidecar alone does nothing without it),
#  - YouTube breaks older versions fast, so default to the latest at build time AND
#    self-update on every container start (see docker-entrypoint.sh; the venv is
#    chowned to the app user below to allow that). For a fully reproducible image,
#    pass --build-arg YTDLP_VERSION=2026.xx.xx and set YTDLP_AUTO_UPDATE=false.
ARG YTDLP_VERSION=
RUN python3 -m venv /opt/ytdlp \
    && /opt/ytdlp/bin/pip install --no-cache-dir -U \
         "yt-dlp[default]${YTDLP_VERSION:+==${YTDLP_VERSION}}" \
         bgutil-ytdlp-pot-provider

# Vendored fix for yt-dlp's Audius extractor: Audius added an artwork `mirrors` LIST that makes the
# extractor emit a list-valued thumbnail, crashing every Audius download ("'list' object has no
# attribute 'startswith'"). Idempotent + non-fatal; no-ops once a yt-dlp release ships the upstream
# fix. Kept at a stable in-image path because the entrypoint re-applies it after every runtime
# yt-dlp self-update (an upgrade overwrites the patched file). See deploy/patches/audius-thumbnails.py.
COPY deploy/patches/audius-thumbnails.py /opt/ytdlp/patches/audius-thumbnails.py
RUN /opt/ytdlp/bin/python /opt/ytdlp/patches/audius-thumbnails.py

# The app user owns the venv so the entrypoint's runtime self-update works unprivileged.
# Chowned HERE — in the stable pre-source section, right after the venv's content is final —
# so the copied-up layer is built once and cached; chowning after the app-source COPY would
# re-duplicate the whole venv into a fresh layer on every source edit.
RUN useradd --create-home --uid 10001 app && chown -R app:app /opt/ytdlp

# Deno >= 2 — the only JS runtime yt-dlp enables by default; required for YouTube.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

ENV PATH="/opt/ytdlp/bin:/usr/local/bin:${PATH}"

# Fail the build early if the media toolchain isn't actually runnable.
RUN yt-dlp --version && deno --version && ffmpeg -version | head -n 1 && fpcalc -version

RUN corepack enable

WORKDIR /app

# Install deps first (Docker layer cache keyed on manifests + lockfile).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile --filter "@radio/server..."

# App sources (web is not needed in the server image).
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TRACKS_DIR=/tmp/radio-tracks

RUN mkdir -p /tmp/radio-tracks \
    && chown -R app:app /app /tmp/radio-tracks
COPY --chmod=0755 apps/server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER app

WORKDIR /app/apps/server
EXPOSE 3000
# The entrypoint self-updates yt-dlp (see docker-entrypoint.sh), then execs the CMD — tsx
# directly, no pnpm/corepack at runtime (that did a flaky network download on every container
# start; deps incl. tsx are already installed at build time). CMD stays overridable so
# `docker compose run server sh` and a compose `command:` key behave normally.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node_modules/.bin/tsx", "src/index.ts"]
