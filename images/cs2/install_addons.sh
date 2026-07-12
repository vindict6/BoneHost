#!/bin/bash
# Installs / refreshes Metamod:Source, CounterStrikeSharp and default plugins.
# Installed versions are pinned in $DATA/.addon-versions.json so a normal boot
# is a no-op; a scheduled or manual update pass (FORCE_ADDON_UPDATE=1) refreshes
# whichever components the subscriber selected.
set -euo pipefail

DATA=/home/steam/cs2data
GAME="$DATA/game/csgo"
VERS="$DATA/.addon-versions.json"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
log() { echo "[addons:$SERVER_ID] $*"; }
[[ -f "$VERS" ]] || echo '{}' > "$VERS"

pin()   { jq --arg k "$1" --arg v "$2" '.[$k]=$v' "$VERS" > "$VERS.tmp" && mv "$VERS.tmp" "$VERS"; }
pinned(){ jq -r --arg k "$1" '.[$k] // ""' "$VERS"; }

gh_asset_url() { # repo, match -> browser_download_url of latest release asset
  curl -fsSL -H 'User-Agent: bonehost' "https://api.github.com/repos/$1/releases/latest" \
    | jq -r --arg m "$2" '[.assets[] | select(.name | contains($m)) | .browser_download_url][0] // empty'
}
gh_tag() { curl -fsSL -H 'User-Agent: bonehost' "https://api.github.com/repos/$1/releases/latest" | jq -r '.tag_name // empty'; }

FORCE="${FORCE_ADDON_UPDATE:-0}"
F_MM="${ADDON_UPDATE_METAMOD:-0}"
F_CSS="${ADDON_UPDATE_CSSHARP:-0}"

# ---------- Metamod:Source ----------
if [[ "${INSTALL_METAMOD:-0}" == "1" ]]; then
  latest=$(curl -fsSL "$MM_LATEST_INDEX" | tr -d '\r\n' || true)
  have=$(pinned metamod)
  if [[ -n "$latest" && ( -z "$have" || ( "$FORCE" == "1" && "$F_MM" == "1" && "$have" != "$latest" ) ) ]]; then
    log "metamod: installing $latest (had: ${have:-none})"
    base="${MM_LATEST_INDEX%/*}"
    curl -fsSL "$base/$latest" -o "$TMP/mm.tar.gz"
    mkdir -p "$GAME" && tar -xzf "$TMP/mm.tar.gz" -C "$GAME"
    # Ensure gameinfo.gi loads metamod (idempotent)
    GI="$DATA/game/csgo/gameinfo.gi"
    if [[ -f "$GI" ]] && ! grep -q 'csgo/addons/metamod' "$GI"; then
      sed -i 's|Game_LowViolence\tcsgo_lv|Game_LowViolence\tcsgo_lv\n\t\t\tGame\tcsgo/addons/metamod|' "$GI"
      grep -q 'csgo/addons/metamod' "$GI" || log "WARNING: could not patch gameinfo.gi — patch it manually once"
    fi
    pin metamod "$latest"
  else
    log "metamod: keeping ${have:-none} (latest: ${latest:-unknown})"
  fi
fi

# ---------- CounterStrikeSharp ----------
if [[ "${INSTALL_CSSHARP:-0}" == "1" ]]; then
  tag=$(gh_tag "$CSS_REPO" || true)
  have=$(pinned cssharp)
  if [[ -n "$tag" && ( -z "$have" || ( "$FORCE" == "1" && "$F_CSS" == "1" && "$have" != "$tag" ) ) ]]; then
    url=$(gh_asset_url "$CSS_REPO" "${CSS_ASSET_MATCH:-with-runtime-linux}")
    if [[ -n "$url" ]]; then
      log "counterstrikesharp: installing $tag (had: ${have:-none})"
      curl -fsSL "$url" -o "$TMP/css.zip"
      unzip -oq "$TMP/css.zip" -d "$TMP/css"
      src=$(find "$TMP/css" -type d -name addons | head -1)
      [[ -n "$src" ]] && cp -a "$src/." "$GAME/addons/" && pin cssharp "$tag" || log "WARNING: unexpected CSS zip layout"
    fi
  else
    log "counterstrikesharp: keeping ${have:-none} (latest: ${tag:-unknown})"
  fi
fi

# ---------- default plugins (FakeRcon, SimpleAdmin, …) ----------
install_plugin() { # name repo match enabled
  local name="$1" repo="$2" match="$3" enabled="$4"
  [[ "$enabled" == "1" ]] || { log "$name: disabled for this server"; return 0; }
  [[ -d "$GAME/addons/counterstrikesharp" ]] || { log "$name: skipped (CounterStrikeSharp not installed)"; return 0; }
  local tag have url
  tag=$(gh_tag "$repo" || true); have=$(pinned "plugin_$name")
  if [[ -n "$tag" && ( -z "$have" || ( "$FORCE" == "1" && "$F_CSS" == "1" && "$have" != "$tag" ) ) ]]; then
    url=$(gh_asset_url "$repo" "$match")
    [[ -n "$url" ]] || { log "$name: no matching release asset on $repo — check config.json addons"; return 0; }
    log "$name: installing $tag from $repo"
    curl -fsSL "$url" -o "$TMP/$name.zip" || { log "$name: download failed"; return 0; }
    unzip -oq "$TMP/$name.zip" -d "$TMP/$name"
    # Accept either a full addons/ tree or a bare plugin folder.
    if [[ -d "$TMP/$name/addons" ]]; then
      cp -a "$TMP/$name/addons/." "$GAME/addons/"
    else
      mkdir -p "$GAME/addons/counterstrikesharp/plugins/$name"
      cp -a "$TMP/$name/." "$GAME/addons/counterstrikesharp/plugins/$name/"
    fi
    pin "plugin_$name" "$tag"
  else
    log "$name: keeping ${have:-none} (latest: ${tag:-unknown})"
  fi
}

if [[ -n "${PLUGINS_JSON:-}" ]]; then
  count=$(echo "$PLUGINS_JSON" | jq 'length')
  for ((i=0; i<count; i++)); do
    p_name=$(echo "$PLUGINS_JSON" | jq -r ".[$i].name")
    p_repo=$(echo "$PLUGINS_JSON" | jq -r ".[$i].repo")
    p_match=$(echo "$PLUGINS_JSON" | jq -r ".[$i].asset_match")
    enabled=1
    [[ "$p_name" == "FakeRcon" && "${INSTALL_FAKERCON:-1}" != "1" ]] && enabled=0
    [[ "$p_name" == "CS2-SimpleAdmin" && "${INSTALL_SIMPLEADMIN:-1}" != "1" ]] && enabled=0
    install_plugin "$p_name" "$p_repo" "$p_match" "$enabled"
  done
fi

log "addon pass complete: $(cat "$VERS")"
