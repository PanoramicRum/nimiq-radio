# Nimiq Radio

**One shared radio. Everyone hears the same song at the same moment.**

Paste a link from YouTube, SoundCloud, Bandcamp, or Audius, pay 1 NIM with
[Nimiq Pay](https://nimiq.com), and your song joins the queue for every listener. When the
queue is empty, the radio plays a built-in public-domain (CC0) library so it's never silent.

**🔴 Live demo: [radio.nimiqapps.com](https://radio.nimiqapps.com)**

<p align="center">
  <img src="assets/demo.gif" alt="Adding a song to Nimiq Radio and paying with Nimiq Pay" width="320">
</p>

> **Demo notice:** this deployment is a prototype for **testing purposes only** — there is no
> intention to circumvent or violate the terms of service of any media content provider.
> See [LEGAL.md](LEGAL.md) for the full copyright/ToS notice.

## Features

- **Shared live queue** — WebSocket-synced playback position, so every listener is on the
  same beat; Media Session API keeps the stream alive on locked phones.
- **Four sources** — YouTube, SoundCloud, Bandcamp, and Audius, all through one
  yt-dlp pipeline with a strict URL allowlist (SSRF-hardened).
- **Nimiq payments** — pay-to-queue and pay-to-boost, verified on-chain against the
  configured address. Free mode when no address is set. Collected NIM is staked and
  eventually donated to a music foundation chosen by the Nimiq community.
- **Real metadata** — AcoustID audio fingerprinting corrects artist/title/album; cover art
  from the Cover Art Archive.
- **Never silent** — CC0 filler library (FreePD) plays whenever no user song is queued.
- **Self-healing media pipeline** — yt-dlp self-updates on every container start plus a
  weekly refresh timer; a canary probe watches YouTube health (`/healthz` + Prometheus
  metrics) and failures log operator-actionable errors instead of generic ones.
- **Telegram bot** — posts now-playing updates to a community group and answers
  `/queue`, `/listen`, and friends.

## Layout

```
apps/web         Vite + React SPA (the mini app UI)
apps/server      Fastify backend: queue engine, yt-dlp/ffmpeg pipeline, payments, metrics
apps/bot         Telegram community bot (polls the public API; runs separately)
packages/shared  TypeScript types + zod schemas shared by web and server
deploy/          Egress hardening + yt-dlp refresh systemd units, filler fetcher
```

## Quickstart (local dev)

Prerequisites: Node 22+, pnpm 9+, Docker + Compose (the media pipeline needs
yt-dlp + Deno + ffmpeg, which the server image provides — the host toolchain is not used).

```bash
cp .env.example .env              # sensible defaults; payments stay off without RECIPIENT_ADDRESS
docker compose build server
docker compose up -d              # bgutil PO-token sidecar + server on 127.0.0.1:3000
docker compose --profile init run --rm filler-fetch   # one-time: fetch the CC0 filler library

pnpm install
pnpm --filter @radio/web dev      # http://localhost:5173 (proxies /api, /static, /ws to :3000)
```

Paste a link, and the song downloads, transcodes, and starts playing for every connected tab.

Smoke-test the API directly:

```bash
curl -X POST localhost:3000/api/prepare-song \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
# -> {"success":true,"trackUrl":"/static/tracks/<id>.m4a","title":"...","duration":...}
```

> The server must run in Docker for downloads to work: `pnpm --filter @radio/server dev`
> starts the HTTP server, but the pipeline needs the image's yt-dlp + Deno + ffmpeg.

## Production

See [DEPLOY.md](DEPLOY.md) for the full guide: Compose profiles, reverse proxy, SSRF egress
hardening, and — important on datacenter IPs — keeping yt-dlp fresh (self-update on start,
weekly refresh timer) plus the **"YouTube stopped working" runbook**. Operational state is
visible at `/healthz` (YouTube canary) and `/metrics` (Prometheus).

## Testing

```bash
pnpm test        # vitest across server, bot, and shared packages
pnpm typecheck
```

## Legal

Nimiq Radio downloads and rebroadcasts third-party media; operating it publicly carries
real legal responsibilities. Read [LEGAL.md](LEGAL.md) — copyright/ToS notice, filler
licensing, retention policy, payments disclosure, and takedown contact — before deploying
anywhere others can reach.
