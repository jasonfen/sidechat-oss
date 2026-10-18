#!/bin/bash
# The MCP version (CLIENT_BUILD_SHA / MCP_EXPECTED_CLIENT_BUILD_SHA) moves only
# when the MCP's code changes, so a script-only release doesn't make every bot
# re-download the binary and restart. Fails when the two pins disagree, or when
# mcp/ differs from the release the pins name without being bumped to this one.
# Run: bash test/mcp-version.sh (needs the v* tags: git fetch --tags)
set -u
cd "$(dirname "$0")/.." || exit 1
mcp=$(sed -n 's/^const CLIENT_BUILD_SHA = "\(.*\)";/\1/p' mcp/src/server.ts)
srv=$(sed -n 's/^const MCP_EXPECTED_CLIENT_BUILD_SHA = "\(.*\)";/\1/p' server.ts)
pkg=$(jq -r .version package.json)
fail() { echo "FAIL: $*"; exit 1; }
[[ -n "$mcp" && "$mcp" == "$srv" ]] || fail "mcp CLIENT_BUILD_SHA=$mcp but server MCP_EXPECTED_CLIENT_BUILD_SHA=$srv"
# Bumped to this release: its binaries are built from this tree.
[[ "$mcp" == "$pkg" ]] && { echo "ok: mcp-version ($mcp, bumped)"; exit 0; }
git rev-parse -q --verify "refs/tags/v$mcp" >/dev/null || fail "no tag v$mcp to compare mcp/ against (git fetch --tags)"
git diff --quiet "v$mcp" -- mcp/ ':(exclude)mcp/test' \
  || fail "mcp/ changed since v$mcp: set CLIENT_BUILD_SHA and MCP_EXPECTED_CLIENT_BUILD_SHA to $pkg"
echo "ok: mcp-version ($mcp, unchanged since v$mcp)"
