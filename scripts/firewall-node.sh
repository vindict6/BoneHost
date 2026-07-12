#!/usr/bin/env bash
# BoneHost game-node firewall — idempotent, applied automatically on every deploy.
#
# Policy:
#   PUBLIC INTERNET  →  27015–29000 tcp+udp ONLY (game ports + per-container SSH)
#   TAILNET ONLY     →  everything backend: host SSH (22), agent (9090), anything else
#   EVERYTHING ELSE  →  denied
#
# Note on Docker: published container ports bypass UFW via Docker's own iptables
# chain. That's fine here — the only published ports on a node are inside the
# public 27015–29000 range (by design; see config.json port ranges) and the
# agent, which docker-compose.node.yml binds to the Tailscale IP exclusively.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }
ip link show tailscale0 >/dev/null 2>&1 || { echo "tailscale0 not found — install/start Tailscale first (https://tailscale.com/download)"; exit 1; }
command -v ufw >/dev/null || apt-get install -y ufw

ufw default deny incoming
ufw default allow outgoing

# Backend rides the tailnet only. Host SSH included — you connect via Tailscale.
ufw allow in on tailscale0 comment 'bonehost: tailnet backend (host ssh, agent 9090)'

# The only public surface: game traffic + per-container subscriber SSH.
ufw allow 27015:29000/tcp comment 'bonehost: game + container ssh'
ufw allow 27015:29000/udp comment 'bonehost: game traffic'

# Retire rules from older BoneHost layouts if present.
ufw delete allow 2022/tcp >/dev/null 2>&1 || true
ufw delete allow 22/tcp   >/dev/null 2>&1 || true

ufw --force enable
ufw status verbose
echo "[firewall-node] applied."
