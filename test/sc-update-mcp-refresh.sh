#!/bin/bash
# sc-update.sh's MCP refresh (2.8.3): drift on the fixed link only repoints it
# (--binary-only, Reconnect is enough); an older versioned registration or a
# token near expiry gets a full --apply (restart). install-mcp.sh --binary-only
# repoints the link from a cached binary without minting a token.
# Stubs curl, claude and install-mcp.sh; no network. Run: bash test/sc-update-mcp-refresh.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
mkdir -p "$T/bin" "$T/sc/mcp"
printf '#!/bin/bash\necho "{\\"expected_client_build_sha\\":\\"$EXPECT\\"}"\n' > "$T/bin/curl"
chmod +x "$T/bin/curl"
export PATH="$T/bin:$PATH" HOME="$T"
sed -n '/^# MCP client binary drift probe/,/^# Retire the legacy sidechat-monitor plugin/p' "$REPO/install/sc-update.sh" > "$T/block.sh"
printf '#!/bin/bash\necho "$*" >> %s/calls\n' "$T" > "$T/sc/install-mcp.sh"; chmod +x "$T/sc/install-mcp.sh"

run() {  # run <registered command> <server expects> [token-expires]
  rm -f "$T/calls" "$T/sc/mcp/token-expires"
  [[ -n "${3:-}" ]] && echo "$3" > "$T/sc/mcp/token-expires"
  jq -n --arg c "$1" '{mcpServers: {sidechat: {command: $c}}}' > "$T/.claude.json"
  OUT=$(EXPECT="$2" SCRIPT_DIR="$T/sc" SERVER_URL=http://stub bash "$T/block.sh")
  CALLS=$(cat "$T/calls" 2>/dev/null)
}
soon=$(jq -rn 'now + 3*86400 | todate'); later=$(jq -rn 'now + 20*86400 | todate')
touch "$T/sc/mcp/sidechat-mcp-linux-x64-v2.8.3"; ln -sfn sidechat-mcp-linux-x64-v2.8.3 "$T/sc/mcp/sidechat-mcp"

run "$T/sc/mcp/sidechat-mcp" 2.8.4 "$later"
[[ "$CALLS" == --binary-only && "$OUT" == *Reconnect* ]] || fail "link drift: calls=$CALLS out=$OUT"
run "$T/sc/mcp/sidechat-mcp" 2.8.3 "$later"
[[ -z "$CALLS" && -z "$OUT" ]] || fail "link, no drift: calls=$CALLS out=$OUT"
run "$T/sc/mcp/sidechat-mcp" 2.8.3 "$soon"
[[ "$CALLS" == --apply && "$OUT" == *Restart* ]] || fail "token due: calls=$CALLS out=$OUT"
run "$T/sc/mcp/sidechat-mcp-linux-x64-v2.8.3" 2.8.3
[[ "$CALLS" == --apply ]] || fail "versioned path not moved to the link: calls=$CALLS"
run "/usr/bin/bun" 2.8.3
[[ "$CALLS" == --apply ]] || fail "bun-run path with drift: calls=$CALLS"

# install-mcp.sh --binary-only: cached binary, link repointed, no token minted
D="$T/inst"; mkdir -p "$D/mcp"; cp "$REPO/install/install-mcp.sh" "$D/"
printf 'SERVER_URL=http://stub\nFINGERPRINT=x\n' > "$D/config"
case "$(uname -s)-$(uname -m)" in Linux-x86_64) P=linux-x64 ;; Linux-aarch64) P=linux-arm64 ;; Darwin-arm64) P=darwin-arm64 ;; *) P=darwin-x64 ;; esac
printf '#!/bin/sh\n' > "$D/mcp/sidechat-mcp-$P-v2.8.4"; chmod +x "$D/mcp/sidechat-mcp-$P-v2.8.4"
printf '#!/bin/sh\n' > "$D/mcp/sidechat-mcp-$P-v2.8.3"; chmod +x "$D/mcp/sidechat-mcp-$P-v2.8.3"
ln -sfn "sidechat-mcp-$P-v2.8.3" "$D/mcp/sidechat-mcp"
EXPECT=2.8.4 SIDECHAT_DIR="$D" bash "$D/install-mcp.sh" --binary-only >/dev/null || fail "--binary-only exited non-zero"
[[ "$(readlink "$D/mcp/sidechat-mcp")" == "sidechat-mcp-$P-v2.8.4" ]] || fail "link not repointed: $(readlink "$D/mcp/sidechat-mcp")"
[[ ! -e "$D/mcp/sidechat-mcp-$P-v2.8.3" ]] || fail "old binary not pruned"
[[ ! -e "$D/mcp/token-expires" ]] || fail "--binary-only minted a token"
echo "ok: sc-update-mcp-refresh"
