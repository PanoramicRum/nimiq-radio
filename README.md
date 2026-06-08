# Nimiq Radio

A shared radio web app where everyone listens to one queue. Users submit YouTube
links and (later) pay NIM to add/boost songs. Built as a Nimiq Pay Mini App.

See the full implementation plan referenced in [Project_description.md](Project_description.md)
and the Nimiq docs in [docs/nimiq-mini-apps/](docs/nimiq-mini-apps/).

## Status: Phase 1 — media pipeline MVP

Paste a YouTube URL → the server downloads + transcodes to MP3 → the browser plays it.
No queue, no payments yet (those are Phases 2–4).

## Layout

```
apps/web      Vite + React SPA (the mini app UI)
apps/server   Fastify backend: prepare-song, yt-dlp/ffmpeg pipeline, static MP3 serving
packages/shared  TypeScript types + zod schemas shared by web and server
```

## Prerequisites

- Node 22+, pnpm 9+
- Docker + Docker Compose (the media pipeline needs yt-dlp + Deno + ffmpeg, which the
  Docker image provides — the host toolchain is **not** used for downloading)

## Run the backend (Docker — the real pipeline)

```bash
cp .env.example .env            # optional; sensible defaults exist
docker compose build server     # also runs a build-time smoke test (yt-dlp/deno/ffmpeg)
docker compose up               # starts the bgutil PO-token sidecar + server on :3000
```

Test it:

```bash
curl -X POST localhost:3000/api/prepare-song \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
# -> {"success":true,"trackUrl":"/static/tracks/<id>.mp3","title":...,"duration":...}

curl -H 'Range: bytes=0-1023' -I localhost:3000/static/tracks/<id>.mp3
# -> 206 Partial Content, Accept-Ranges: bytes, Content-Type: audio/mpeg
```

## Run the frontend (dev)

```bash
pnpm install
pnpm --filter @radio/web dev    # http://localhost:5173 (proxies /api and /static to :3000)
```

Paste a YouTube URL, click **Download / Prepare Song**, and the audio player appears.

> Note: the server **must** run in Docker for downloads to work — the host's `yt-dlp`
> is too old and Deno isn't installed. `pnpm --filter @radio/server dev` will start the
> HTTP server but downloads will fail unless your host has a recent yt-dlp + Deno.

## Deployment note (datacenter IPs)

YouTube frequently blocks datacenter IPs. The compose file already wires the
**bgutil PO-token sidecar**; for stubborn blocks, drop a real `secrets/cookies.txt`
(see `secrets/cookies.txt.example`). SSRF egress hardening is documented in
`docker-compose.yml`.

See [LEGAL.md](LEGAL.md) for the copyright/ToS notice.
