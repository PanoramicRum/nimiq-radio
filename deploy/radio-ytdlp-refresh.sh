#!/usr/bin/env bash
#
# Weekly yt-dlp refresh for the Nimiq Radio stack.
#
# YouTube breaks stale yt-dlp versions within weeks. The server container self-updates
# yt-dlp on every start (see apps/server/docker-entrypoint.sh), so "staying current"
# reduces to "restart the container on a schedule" — which is what this script does,
# driven by radio-ytdlp-refresh.timer. The bgutil PO-token sidecar is refreshed in the
# same pass: the entrypoint upgrades the CLIENT plugin weekly, and upstream expects
# plugin and sidecar versions to match, so the sidecar must not stay pinned at whatever
# `:latest` meant on deploy day. A restart costs listeners a few seconds; the stream
# resumes and the queue survives (persisted in the tracks volume).
#
# This is the safety net for quiet weeks with no deploys — the exact scenario that
# caused the July 2026 outage (stale image, YouTube changed, nobody deployed).
#
# IMPORTANT: REPO_DIR must point at the checkout that holds docker-compose.yml.
set -euo pipefail

REPO_DIR="/opt/nimiq-radio"   # <- adjust to your checkout (where docker-compose.yml lives)

cd "$REPO_DIR"

# Keep the PO-token sidecar in step with the client plugin the entrypoint is about to upgrade.
docker compose pull -q bgutil
docker compose up -d bgutil    # no-op unless the pulled image changed

docker compose restart server

# The entrypoint's self-update takes up to ~2 min; wait for its final version line so the
# journal records the POST-update version (restart returns before the update finishes).
version_line=""
for _ in $(seq 1 30); do
  version_line=$(docker compose logs --since 5m server 2>/dev/null | grep -Eo 'entrypoint: yt-dlp ([0-9].*|BROKEN)' | tail -1)
  [[ -n "$version_line" ]] && break
  sleep 5
done
echo "radio-ytdlp-refresh: server restarted; ${version_line:-version line not seen within 150s — check docker compose logs server}"
