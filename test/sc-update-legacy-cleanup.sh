#!/usr/bin/env bash
# Check for the legacy sidechat-monitor cleanup block in install/sc-update.sh.
# Runs the block against a throwaway CLAUDE_CONFIG_DIR with a stub `claude`.
# Run: bash test/sc-update-legacy-cleanup.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
sed -n '/^# Retire the legacy sidechat-monitor plugin/,/^# Monitor wake-path script drift/p' "$ROOT/install/sc-update.sh" | sed '$d' > "$T/block.sh"
[[ -s "$T/block.sh" ]] || { echo "FAIL: block not found in sc-update.sh"; exit 1; }

mkdir -p "$T/bin"
printf '#!/bin/sh\necho "$@" >> "$CALLS"\n' > "$T/bin/claude"; chmod +x "$T/bin/claude"
run() { CALLS="$T/calls" CLAUDE_CONFIG_DIR="$T/cfg" PATH="$T/bin:$PATH" bash -c 'set -euo pipefail; source "$1"' _ "$T/block.sh"; }
fail() { echo "FAIL: $1"; exit 1; }

# 1. full legacy state is cleaned and unrelated settings survive
mkdir -p "$T/cfg/plugins/cache/sidechat-oss/x"
cat > "$T/cfg/settings.json" <<'J'
{"model":"m","enabledPlugins":{"sidechat-monitor@sidechat-oss":false,"other@mk":true},
 "extraKnownMarketplaces":{"sidechat-oss":{"source":{"source":"url","url":"u"}},"other":{"source":{"source":"github","repo":"r"}}},
 "statusLine":{"type":"command","command":"x"}}
J
out="$(run)"
[[ "$out" == *"Retired the legacy sidechat-monitor plugin"* ]] || fail "no cleanup message"
grep -q 'plugin uninstall sidechat-monitor@sidechat-oss' "$T/calls" || fail "plugin not uninstalled"
grep -q 'plugin marketplace remove sidechat-oss' "$T/calls" || fail "marketplace not removed"
[[ ! -e "$T/cfg/plugins/cache/sidechat-oss" ]] || fail "cache dir left behind"
! grep -q 'sidechat' "$T/cfg/settings.json" || fail "stale settings entries left"
jq -e '.model=="m" and .enabledPlugins["other@mk"]==true and .extraKnownMarketplaces.other and .statusLine.type=="command"' "$T/cfg/settings.json" >/dev/null || fail "unrelated settings changed"

# 2. second run is a silent no-op
: > "$T/calls"
[[ -z "$(run)" && ! -s "$T/calls" ]] || fail "second run was not a no-op"

# 3. invalid settings.json is left alone and the block does not abort
mkdir -p "$T/cfg/plugins/cache/sidechat-oss"; echo '{ "sidechat-oss": broken' > "$T/cfg/settings.json"
run >/dev/null || fail "block aborted on invalid settings"
grep -q 'broken' "$T/cfg/settings.json" && [[ ! -e "$T/cfg/settings.json.tmp" ]] || fail "invalid settings was modified"
echo "ok: legacy plugin cleanup"
