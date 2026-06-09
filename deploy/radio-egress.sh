#!/usr/bin/env bash
#
# Scoped container egress hardening for the Nimiq Radio stack.
#
# Blocks the radio containers from reaching the cloud metadata endpoint and the
# RFC1918 private ranges (SSRF defense for yt-dlp, which resolves its own DNS and
# follows redirects), WITHOUT touching any other container or app on this host.
#
# Enforced from the HOST via Docker's DOCKER-USER chain, so:
#   - a compromised radio container CANNOT remove these rules (no in-container
#     NET_ADMIN — that approach would also risk neighbours on a shared bridge);
#   - the rules are scoped to the radionet subnet, so your other apps are untouched;
#   - they survive container restart/rebuild (host-side), and a systemd unit
#     re-applies them on boot after dockerd is up (see radio-egress.service).
#
# Idempotent: safe to re-run. All radio logic lives in dedicated RADIO-EGRESS[6]
# chains that we flush-and-refill, so re-runs never disturb other DOCKER-USER rules.
#
# IMPORTANT: SUBNET must match the `radionet` subnet pinned in docker-compose.yml.
set -euo pipefail

SUBNET="172.28.0.0/24"        # radionet IPv4 subnet — keep in sync with docker-compose.yml
METADATA="169.254.169.254"    # Hetzner Cloud (and ~every provider's) metadata IP
SUBNET6="fd00:28::/64"        # only used if you opt the radio stack into IPv6 (see DEPLOY.md)

apply4() {
  iptables -N DOCKER-USER 2>/dev/null || true          # Docker normally creates it; be defensive
  iptables -N RADIO-EGRESS 2>/dev/null || iptables -F RADIO-EGRESS

  # 1) Intra-stack traffic (server <-> bgutil <-> web) stays allowed. MUST be first:
  #    the docker subnet itself sits inside 172.16/12, which we drop just below.
  iptables -A RADIO-EGRESS -d "$SUBNET"       -j RETURN
  # 2) Cloud metadata + every private range -> DROP.
  iptables -A RADIO-EGRESS -d "$METADATA"     -j DROP
  iptables -A RADIO-EGRESS -d 169.254.0.0/16  -j DROP
  iptables -A RADIO-EGRESS -d 10.0.0.0/8      -j DROP
  iptables -A RADIO-EGRESS -d 172.16.0.0/12   -j DROP
  iptables -A RADIO-EGRESS -d 192.168.0.0/16  -j DROP
  # 3) Everything else (YouTube, AcoustID, Nimiq RPC, ...) falls through -> allowed.
  iptables -A RADIO-EGRESS -j RETURN

  # Evaluate the radio chain only for radio-originated traffic; guard against dupes.
  iptables -C DOCKER-USER -s "$SUBNET" -j RADIO-EGRESS 2>/dev/null \
    || iptables -I DOCKER-USER -s "$SUBNET" -j RADIO-EGRESS
  echo "radio-egress: applied IPv4 rules for $SUBNET"
}

apply6() {
  # The radio stack is IPv4-only by default, so there is no v6 egress to filter.
  # If Docker has no ip6tables DOCKER-USER chain, skip silently. These rules only
  # bite if you later enable IPv6 on radionet (then set SUBNET6 to match).
  ip6tables -L DOCKER-USER -n >/dev/null 2>&1 || {
    echo "radio-egress: no ip6tables DOCKER-USER chain; skipping v6 (radio stack is IPv4-only)"
    return 0
  }
  ip6tables -N RADIO-EGRESS6 2>/dev/null || ip6tables -F RADIO-EGRESS6
  ip6tables -A RADIO-EGRESS6 -d "$SUBNET6" -j RETURN     # intra-stack v6 (if enabled)
  ip6tables -A RADIO-EGRESS6 -d fc00::/7   -j DROP       # ULA, incl. fd00::/8
  ip6tables -A RADIO-EGRESS6 -d fe80::/10  -j DROP       # link-local
  ip6tables -A RADIO-EGRESS6 -d ::1/128    -j DROP       # loopback
  ip6tables -A RADIO-EGRESS6 -j RETURN
  ip6tables -C DOCKER-USER -s "$SUBNET6" -j RADIO-EGRESS6 2>/dev/null \
    || ip6tables -I DOCKER-USER -s "$SUBNET6" -j RADIO-EGRESS6
  echo "radio-egress: applied IPv6 rules for $SUBNET6"
}

apply4
apply6
