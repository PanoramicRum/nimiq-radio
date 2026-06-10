# Deploying Nimiq Radio

Production runs three containers via Docker Compose (`--profile prod`):

- **server** — Fastify backend (yt-dlp + AcoustID + payments), bound to `127.0.0.1` only.
- **bgutil** — PO-token provider sidecar for yt-dlp on datacenter IPs.
- **web** — nginx serving the built SPA and proxying `/api`, `/static`, `/ws` to `server`.

A reverse proxy on the host (Caddy/nginx/Traefik) terminates TLS for your domain and forwards to
the web container's localhost port. Same-origin, so the SPA uses relative URLs and WebSockets work.

## Prerequisites

- **Docker Engine + Compose v2.** Fresh Ubuntu/Debian box: `curl -fsSL https://get.docker.com | sh`.
- **DNS**: an `A` (and `AAAA` for IPv6) record for your domain → the server's public IP, in place
  *before* the reverse proxy first starts (Caddy needs it resolving to issue the TLS certificate).
- **Host firewall** allowing only `22`, `80`, `443`. The stack binds `127.0.0.1` only, so nothing
  else is public — UFW is enough: `ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable`.
- **A reverse proxy with automatic HTTPS** — examples assume **host-level Caddy**, the natural single
  TLS terminator when the box will host several mini-apps (add one site block per app).

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
#     CORS_ORIGIN=https://radio.nimiqapps.com

# 2) Cookies file (the compose bind-mount needs it to exist; gitignored, so create it
#    from the template on a fresh clone). Leave it as-is for no cookies, or paste a real
#    Netscape cookies.txt from a throwaway account for datacenter-IP robustness.
cp secrets/cookies.txt.example secrets/cookies.txt

# 3) Build + start (server + bgutil + web)
docker compose --profile prod up -d --build

# 4) Populate the always-on Creative-Commons filler library (public-domain CC0 music the radio
#    plays whenever no user song is queued). Idempotent; re-run after editing the manifest.
#    Uses the server image (node + ffmpeg), writes into the tracks volume — no host deps needed.
docker compose --profile init run --rm filler-fetch
```

The radio is silent until step 4 runs (it then plays the CC0 library, shown as "Added by the
radio", until a user submits a song). To curate the library, edit
`apps/server/filler/manifest.json` (add tracks / genres) and re-run step 4.

Then point your reverse proxy at the web container. Caddy example (`/etc/caddy/Caddyfile`):

```
radio.nimiqapps.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8780
}
```

Reload Caddy (`systemctl reload caddy`) — it will obtain a certificate automatically once DNS
resolves to the server.

## Egress hardening (SSRF defense, scoped to the radio stack)

`yt-dlp` resolves its own DNS and follows redirects, so the in-app host allowlist can't fully stop a
malicious URL from steering egress at the cloud metadata endpoint (`169.254.169.254` → credential
theft) or your private network. We block that at the **host** via Docker's `DOCKER-USER` chain,
scoped to the radio stack's pinned subnet — so it's enforced *outside* the container (a compromise
can't flush it) and leaves your other apps on the box untouched. No `NET_ADMIN` is granted to any
container.

```bash
# From the repo root on the VPS. First confirm iptables and Docker share a backend (modern Ubuntu
# uses nft for both). "OK" -> continue; "WARN" -> see the iptables-backend note below.
sudo iptables -L DOCKER-USER -n >/dev/null 2>&1 \
  && echo "OK: iptables sees Docker's DOCKER-USER chain" \
  || echo "WARN: iptables/Docker backend mismatch (nft vs legacy)"

sudo install -m 0755 deploy/radio-egress.sh      /usr/local/sbin/radio-egress.sh
sudo install -m 0644 deploy/radio-egress.service /etc/systemd/system/radio-egress.service
sudo systemctl daemon-reload
sudo systemctl enable --now radio-egress.service        # applies now + on every boot
```

Verify it took effect (after `docker compose --profile prod up -d`):

```bash
sudo iptables -L DOCKER-USER -n            # shows: -s 172.28.0.0/24 -> RADIO-EGRESS
sudo iptables -L RADIO-EGRESS -n           # shows the RETURN/DROP rules

# Metadata + private ranges blocked, public + intra-stack still work:
docker compose exec server sh -c 'curl -sS -m3 http://169.254.169.254/ ; echo " exit=$?"'   # expect non-zero (blocked)
docker compose exec server sh -c 'curl -sS -m6 -o /dev/null -w "youtube=%{http_code}\n" https://www.youtube.com'  # expect 200/30x
docker compose exec server sh -c 'curl -sS -m3 -o /dev/null -w "bgutil=%{http_code}\n" http://bgutil:4416/ping'   # expect a response (intra-stack allowed)
```

Notes:
- The rules target `172.28.0.0/24` (the `radionet` subnet in `docker-compose.yml`). If you change
  that subnet — or `docker compose up` reports an overlap and you pick another — update `SUBNET` in
  `deploy/radio-egress.sh` to match. Verify the live subnet with:
  `docker network inspect "$(docker network ls --format '{{.Name}}' | grep radionet)" -f '{{(index .IPAM.Config 0).Subnet}}'`.
- **iptables backend (nft vs legacy):** modern Ubuntu ships `iptables` as the nft shim and current
  Docker uses nft too, so they match. If the check above printed `WARN`, Docker is on a different
  backend than your `iptables` command — point `iptables` at the one Docker uses
  (`sudo update-alternatives --config iptables`, pick the matching legacy/nft variant) and re-run.
  Otherwise the rules write to a table that's never consulted (a silent no-op).
- **Re-apply after recreating the network:** the systemd unit re-applies on every boot, but if you
  `docker compose down && up` (which recreates `radionet`) without rebooting, run
  `sudo systemctl restart radio-egress` afterward.
- The radio stack is **IPv4-only** by design: its containers never originate IPv6, so there's no v6
  egress surface to filter even though the host has IPv6 (public IPv6 clients reach Caddy on the
  host, which proxies to the container over IPv4 loopback). The script's v6 section is a no-op unless
  you deliberately enable IPv6 on `radionet`.

## Updating

```bash
git pull
docker compose --profile prod up -d --build
# If apps/server/filler/manifest.json changed, refresh the filler library too:
docker compose --profile init run --rm filler-fetch
```

## Notes

- The backend binds `127.0.0.1:${HOST_PORT:-3000}` — not publicly exposed; the web tier reaches it
  internally as `server:3000`.
- Media is kept in the `tracks` Docker volume, TTL- and disk-cap-evicted (`FILE_TTL_MIN`,
  `DISK_CAP_MB`).
- On low-RAM hosts, add swap before the first build (`vite` + image builds can spike memory).
