#!/usr/bin/env bash
# BoneHost head-unit (mini PC) firewall — idempotent, applied on every deploy.
#
# Policy:
#   PUBLIC INTERNET  →  80/443 only (the panel behind Cloudflare / Caddy).
#                       Using a Cloudflare Tunnel instead? Set PANEL_PUBLIC_HTTP=0
#                       in /opt/bonehost/.env and even these close.
#   TAILNET ONLY     →  host SSH and everything else
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }
ip link show tailscale0 >/dev/null 2>&1 || { echo "tailscale0 not found — install/start Tailscale first"; exit 1; }
command -v ufw >/dev/null || apt-get install -y ufw

PUBLIC_HTTP=1
[[ -f /opt/bonehost/.env ]] && grep -q '^PANEL_PUBLIC_HTTP=0' /opt/bonehost/.env && PUBLIC_HTTP=0

ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0 comment 'bonehost: tailnet backend (host ssh)'

if [[ "$PUBLIC_HTTP" == "1" ]]; then
  ufw allow 80/tcp  comment 'bonehost: acme/redirect'
  ufw allow 443/tcp comment 'bonehost: panel https'
else
  ufw delete allow 80/tcp  >/dev/null 2>&1 || true
  ufw delete allow 443/tcp >/dev/null 2>&1 || true
  echo "[firewall-panel] Tunnel mode: no public ports."
fi
ufw delete allow 22/tcp >/dev/null 2>&1 || true

ufw --force enable
ufw status verbose
echo "[firewall-panel] applied."
