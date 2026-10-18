#!/usr/bin/env bash
# Check the webhook-listener retirement block in install/sc-update.sh: it
# removes the listener files, clears the registration once, and is a silent
# no-op afterwards. Stubs curl/pkill; the systemd branch needs a real unit
# file under /etc and is not exercised here.
# Run: bash test/sc-update-webhook-retire.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
sed -n '/^# Retire the client webhook listener/,/^# Re-auth to publish/p' "$ROOT/install/sc-update.sh" | sed '$d' > "$T/block.sh"
[[ -s "$T/block.sh" ]] || { echo "FAIL: block not found in sc-update.sh"; exit 1; }
grep -q '/etc/systemd/system/sidechat-webhook.service' "$T/block.sh" || { echo "FAIL: unit path changed"; exit 1; }
[[ ! -e /etc/systemd/system/sidechat-webhook.service ]] || { echo "SKIP: host still has the real unit"; exit 0; }

mkdir -p "$T/bin" "$T/sc"
for c in curl pkill; do printf '#!/bin/sh\necho "%s $*" >> "$CALLS"\n' "$c" > "$T/bin/$c"; chmod +x "$T/bin/$c"; done
run() { CALLS="$T/calls" PATH="$T/bin:$PATH" SCRIPT_DIR="$T/sc" TOKEN=t SERVER_URL=http://s \
  bash -c 'set -euo pipefail; source "$1"' _ "$T/block.sh"; }
fail() { echo "FAIL: $1"; exit 1; }

# 1. an old install loses its listener files and its registration
touch "$T/sc/sc-webhook-server.py" "$T/sc/sc-webhook-listener.sh" "$T/sc/sc-webhook-register.sh" \
  "$T/sc/.webhook-listener.pid" "$T/sc/crons.md" "$T/sc/config"
out="$(run)"
[[ "$out" == *"Cleared this bot's webhook registration"* ]] || fail "no registration-cleared message"
grep -q 'curl .*-X DELETE .*http://s/webhook' "$T/calls" || fail "registration not deleted"
grep -q "pkill -f $T/sc/sc-webhook-server.py" "$T/calls" || fail "listener not killed by its own path"
[[ "$(ls -A "$T/sc")" == "config" ]] || fail "listener files left behind: $(ls -A "$T/sc")"

# 2. second run: no message, no DELETE
: > "$T/calls"
[[ -z "$(run)" ]] || fail "second run printed output"
! grep -q DELETE "$T/calls" || fail "second run deleted the registration again"
echo "ok: webhook listener retirement"
