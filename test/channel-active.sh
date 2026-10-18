#!/bin/bash
# channel-active.sh: true only when the owning claude was started with the
# channel flag naming this server. Stub claude, no network.
# Run: bash test/channel-active.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
printf '#!/bin/bash\nbash %s\n' "$REPO/install/channel-active.sh" > "$T/claude"; chmod +x "$T/claude"
fail() { echo "FAIL: $*"; exit 1; }
yes() { "$T/claude" "$@" || fail "expected active: $*"; }
no() { ! "$T/claude" "$@" || fail "expected inactive: $*"; }

yes --dangerously-load-development-channels server:sidechat --continue
yes --dangerously-load-development-channels=server:sidechat
yes --channels plugin:sidechat@mk
no --continue -- "prompt about server:sidechat"
no --dangerously-load-development-channels server:sidechat-uat
no --dangerously-load-development-channels server:other
# no claude ancestor (named so the real session running this test is not found)
! SIDECHAT_OWNER_COMM=no-such-owner bash "$REPO/install/channel-active.sh" || fail "active outside a channel session"
echo "ok: channel-active"
