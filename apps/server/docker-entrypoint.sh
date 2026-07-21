#!/bin/sh
#
# Container entrypoint: refresh yt-dlp, then start the server (or exec the given command).
#
# YouTube breaks stale yt-dlp versions within weeks, and the image's copy is frozen at
# build time — so by default the latest release is pulled on every container start.
# That makes `docker compose restart server` the entire recovery story for the next
# YouTube breakage (and radio-ytdlp-refresh.timer does it weekly). Guarded by a
# timeout, a graceful offline fallback, and a repair pass: pip upgrades by removing
# the old install before laying down the new one, so a mid-upgrade kill (timeout,
# restart during the window, ENOSPC) can leave the venv without a working yt-dlp —
# verify and reinstall before starting.
#
#   YTDLP_AUTO_UPDATE=false  -> skip the self-update entirely (reproducible/pinned mode;
#                               pair with --build-arg YTDLP_VERSION=... at build time)
#   YTDLP_CHANNEL=nightly    -> track yt-dlp pre-releases (when stable lags a YouTube change)
set -eu

PIP=/opt/ytdlp/bin/pip
apply_patch() {
  # Vendored Audius fix; idempotent, must re-run after any yt-dlp (re)install.
  /opt/ytdlp/bin/python /opt/ytdlp/patches/audius-thumbnails.py || true
}

if [ "${YTDLP_AUTO_UPDATE:-true}" != "false" ]; then
  PRE=""
  if [ "${YTDLP_CHANNEL:-stable}" = "nightly" ]; then
    PRE="--pre"
  fi
  echo "entrypoint: self-updating yt-dlp (channel: ${YTDLP_CHANNEL:-stable}, was: $(yt-dlp --version 2>/dev/null || echo unknown))"
  timeout 120 "$PIP" install -q -U --no-cache-dir $PRE "yt-dlp[default]" bgutil-ytdlp-pot-provider \
    || echo "entrypoint: yt-dlp self-update failed or offline"
  apply_patch
fi

# Repair pass: verify the binary actually runs; reinstall if an interrupted upgrade broke it.
# --force-reinstall because pip may still think the package is installed (intact metadata,
# broken/missing files) and would otherwise no-op with "requirement already satisfied".
# On a failed repair the server still starts (the radio keeps playing filler/other sources;
# the canary + error logs surface the broken downloader loudly).
if ! yt-dlp --version >/dev/null 2>&1; then
  echo "entrypoint: yt-dlp is missing or broken after the update attempt — reinstalling"
  if timeout 180 "$PIP" install -q --no-cache-dir --force-reinstall "yt-dlp[default]" bgutil-ytdlp-pot-provider; then
    apply_patch
  else
    echo "entrypoint: REPAIR FAILED — downloads will not work; restart the container to retry"
  fi
fi

# Always log the active version: greppable evidence for "which yt-dlp was running when it broke".
echo "entrypoint: yt-dlp $(yt-dlp --version 2>/dev/null || echo BROKEN)"

# Exec the image CMD (or a compose `command:` / `docker compose run server <cmd>` override) —
# the normal server start lives in the Dockerfile's CMD, not here.
exec "$@"
