# Deploying Nimiq Radio

Production runs three containers via Docker Compose (`--profile prod`):

- **server** — Fastify backend (yt-dlp + AcoustID + payments), bound to `127.0.0.1` only.
- **bgutil** — PO-token provider sidecar for yt-dlp on datacenter IPs.
- **web** — nginx serving the built SPA and proxying `/api`, `/static`, `/ws` to `server`.

A reverse proxy on the host (Caddy/nginx/Traefik) terminates TLS for your domain and forwards to
the web container's localhost port. Same-origin, so the SPA uses relative URLs and WebSockets work.

## Prerequisites

- Docker + Docker Compose v2.
- A DNS `A`/`AAAA` record for your domain → the server's public IP.
- A reverse proxy with automatic HTTPS (examples below assume Caddy).

## Steps

```bash
git clone https://github.com/PanoramicRum/nimiq-radio.git
cd nimiq-radio

# 1) Production config (never commit this file)
cp .env.example .env
#   then edit .env and set at least:
#     NODE_ENV=production
#     NIMIQ_NETWORK=mainnet
#     RECIPIENT_ADDRESS=NQ...        # where payments land (real NIM on mainnet!)
#     PRICE_NIM=1
#     MIN_CONFIRMATIONS=10
#     ACOUSTID_API_KEY=...           # https://acoustid.org/new-application
#     WEB_PORT=8780                  # localhost port the reverse proxy targets
#     CORS_ORIGIN=https://radio.example.com

# 2) (optional) real YouTube cookies for datacenter-IP robustness
#    paste a Netscape cookies.txt into secrets/cookies.txt (else leave the placeholder)

# 3) Build + start (server + bgutil + web)
docker compose --profile prod up -d --build
```

Then point your reverse proxy at the web container. Caddy example (`/etc/caddy/Caddyfile`):

```
radio.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8780
}
```

Reload Caddy (`systemctl reload caddy`) — it will obtain a certificate automatically once DNS
resolves to the server.

## Updating

```bash
git pull
docker compose --profile prod up -d --build
```

## Notes

- The backend binds `127.0.0.1:${HOST_PORT:-3000}` — not publicly exposed; the web tier reaches it
  internally as `server:3000`.
- Media is kept in the `tracks` Docker volume, TTL- and disk-cap-evicted (`FILE_TTL_MIN`,
  `DISK_CAP_MB`).
- On low-RAM hosts, add swap before the first build (`vite` + image builds can spike memory).
