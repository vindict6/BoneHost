#!/bin/bash
# BoneHost CS2 entrypoint.
# Env contract (set by the panel): SERVER_ID GAME_PORT MAXPLAYERS MAP GAME_TYPE GAME_MODE
#   GSLT UPDATE_ON_START INSTALL_METAMOD INSTALL_CSSHARP INSTALL_FAKERCON INSTALL_SIMPLEADMIN
#   RCON_PASSWORD MM_LATEST_INDEX CSS_REPO CSS_ASSET_MATCH PLUGINS_JSON
#   SSH_PORT SSH_PASSWORD  (per-container SSH/SFTP for the subscriber)
#   FORCE_ADDON_UPDATE ADDON_UPDATE_METAMOD ADDON_UPDATE_CSSHARP
set -euo pipefail

DATA=/home/steam/cs2data
GAME="$DATA/game/csgo"
STEAMCMD=/home/steam/steamcmd/steamcmd.sh
log() { echo "[bonehost:$SERVER_ID] $*"; }

# ---------- 0. per-container SSH, then drop root ----------
# The container IS the jail: subscribers SSH into their own game container,
# never the host. sshd is bootstrapped as root (password + host keys need it),
# after which this script re-execs itself as `steam` for everything else.
if [[ "$(id -u)" == "0" ]]; then
  if [[ -n "${SSH_PORT:-}" && -n "${SSH_PASSWORD:-}" ]]; then
    echo "steam:${SSH_PASSWORD}" | chpasswd

    # Host keys persist in the data volume so fingerprints survive recreation.
    HK="$DATA/.ssh-host"
    mkdir -p "$HK"
    for t in ed25519 rsa; do
      [[ -f "$HK/ssh_host_${t}_key" ]] || ssh-keygen -q -t "$t" -N '' -f "$HK/ssh_host_${t}_key"
    done
    chown -R root:root "$HK"; chmod 600 "$HK"/ssh_host_*_key

    # Subscriber-supplied public key (managed from the dashboard)
    if [[ -f "$DATA/panel-cfg/authorized_keys" ]]; then
      mkdir -p /home/steam/.ssh
      cp -f "$DATA/panel-cfg/authorized_keys" /home/steam/.ssh/authorized_keys
      chown -R steam:steam /home/steam/.ssh
      chmod 700 /home/steam/.ssh; chmod 600 /home/steam/.ssh/authorized_keys
    fi

    cat > /etc/ssh/sshd_config.d/bonehost.conf <<SSHEOF
Port ${SSH_PORT}
HostKey ${HK}/ssh_host_ed25519_key
HostKey ${HK}/ssh_host_rsa_key
AllowUsers steam
PermitRootLogin no
PasswordAuthentication yes
PubkeyAuthentication yes
MaxAuthTries 4
LoginGraceTime 30
ClientAliveInterval 120
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
Subsystem sftp internal-sftp
SSHEOF
    /usr/sbin/sshd -e
    log "sshd up on :${SSH_PORT} (user steam, container-jailed)"
  fi
  chown steam:steam "$DATA" 2>/dev/null || true
  exec setpriv --reuid=steam --regid=steam --init-groups "$0" "$@"
fi

# ---------- 1. install / update CS2 ----------
if [[ ! -x "$DATA/game/bin/linuxsteamrt64/cs2" || "${UPDATE_ON_START:-1}" == "1" ]]; then
  log "steamcmd: validating/updating CS2 (app 730)…"
  "$STEAMCMD" +force_install_dir "$DATA" +login anonymous +app_update 730 validate +quit \
    || { log "steamcmd failed — retrying once"; "$STEAMCMD" +force_install_dir "$DATA" +login anonymous +app_update 730 validate +quit; }
fi

# ---------- 2. addons (Metamod / CounterStrikeSharp / plugins) ----------
/home/steam/install_addons.sh

# ---------- 3. sync panel-managed configs ----------
mkdir -p "$GAME/cfg"
if [[ -f "$DATA/panel-cfg/server.cfg" ]]; then
  cp -f "$DATA/panel-cfg/server.cfg" "$GAME/cfg/server.cfg"
  cp -n "$DATA/panel-cfg/custom.cfg" "$GAME/cfg/custom.cfg" 2>/dev/null || true
  [[ -f "$GAME/cfg/custom.cfg" ]] || touch "$GAME/cfg/custom.cfg"
fi

CSS_CFG="$GAME/addons/counterstrikesharp/configs"
if [[ -d "$CSS_CFG" && -f "$DATA/panel-cfg/admins.json" ]]; then
  cp -f "$DATA/panel-cfg/admins.json" "$CSS_CFG/admins.json"
fi

SA_DIR="$CSS_CFG/plugins/CS2-SimpleAdmin"
if [[ "${INSTALL_SIMPLEADMIN:-0}" == "1" && -f "$DATA/panel-cfg/simpleadmin.json" && -d "$GAME/addons/counterstrikesharp" ]]; then
  mkdir -p "$SA_DIR"
  # Merge panel DB settings over the plugin's shipped defaults if present.
  if [[ -f "$SA_DIR/CS2-SimpleAdmin.json" ]]; then
    jq -s '.[0] * .[1]' "$SA_DIR/CS2-SimpleAdmin.json" "$DATA/panel-cfg/simpleadmin.json" > "$SA_DIR/.merged.json" \
      && mv "$SA_DIR/.merged.json" "$SA_DIR/CS2-SimpleAdmin.json"
  else
    cp -f "$DATA/panel-cfg/simpleadmin.json" "$SA_DIR/CS2-SimpleAdmin.json"
  fi
fi

# FakeRcon reads rcon_password from the server; make sure it's in the cfg.
grep -q '^rcon_password' "$GAME/cfg/server.cfg" 2>/dev/null \
  || echo "rcon_password \"${RCON_PASSWORD:-}\"" >> "$GAME/cfg/server.cfg"

# ---------- 4. launch ----------
ARGS=(
  -dedicated
  -console
  -port "${GAME_PORT:-27015}"
  -maxplayers "${MAXPLAYERS:-10}"
  +map "${MAP:-de_dust2}"
  +game_type "${GAME_TYPE:-0}"
  +game_mode "${GAME_MODE:-1}"
  +exec server.cfg
)
[[ -n "${GSLT:-}" ]] && ARGS+=(+sv_setsteamaccount "$GSLT")

log "launching cs2 ${ARGS[*]}"
cd "$DATA/game/bin/linuxsteamrt64"
exec ./cs2 "${ARGS[@]}"
