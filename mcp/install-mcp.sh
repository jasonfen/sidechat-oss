#!/usr/bin/env bash
# install-mcp.sh — Phase 3 bootstrapper.
#
# Mints a scope=mcp bearer token against the SideChat server using the same
# Ed25519 challenge-response the sidechat shell client uses, and prints a
# ready-to-paste `claude mcp add` one-liner with the token injected.
#
# Prereqs:
#   - sidechat client already installed in the target user's home (i.e.
#     ~/.sidechat/config exists with SERVER_URL, FINGERPRINT, KEY_PATH).
#     Run install/client.sh first if not.
#   - `bun` on $PATH (the one-liner runs the MCP server via `bun run`). If we
#     ever ship prebuilt binaries via GH Releases this script should prefer
#     them; for now it's bun-source only.
#   - `jq`, `ssh-keygen`, `curl` on $PATH.
#
# Usage:
#   ./install-mcp.sh                      # reads ~/.sidechat/config, prints the one-liner
#   ./install-mcp.sh --apply              # runs the `claude mcp add` itself (stdin-y)
#   ./install-mcp.sh --name <n>           # override MCP server name (default: sidechat)
#
# The minted token inherits SideChat's SESSION_TTL_HOURS (24h by default).
# Re-run this script when the token expires and the MCP server starts 401ing.

set -euo pipefail

SIDECHAT_DIR="${SIDECHAT_DIR:-$HOME/.sidechat}"
CONFIG="$SIDECHAT_DIR/config"

APPLY=false
MCP_NAME="sidechat"
SERVER_SRC_DIR_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true; shift ;;
    --name) MCP_NAME="$2"; shift 2 ;;
    --server-src-dir) SERVER_SRC_DIR_OVERRIDE="$2"; shift 2 ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# --- Prereq checks ---------------------------------------------------------

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: $CONFIG not found." >&2
  echo "  Run install/client.sh first so the bot is registered + approved." >&2
  exit 1
fi

for cmd in curl jq ssh-keygen bun; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' is required on \$PATH." >&2
    exit 1
  fi
done

# Locate the MCP server source tree. Preference order:
#   1. --server-src-dir flag
#   2. $SIDECHAT_OSS_DIR env var
#   3. <script dir>/.. (when this script lives inside a sidechat-oss clone)
#   4. error
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "$SERVER_SRC_DIR_OVERRIDE" ]]; then
  MCP_SRC_DIR="$SERVER_SRC_DIR_OVERRIDE"
elif [[ -n "${SIDECHAT_OSS_DIR:-}" && -f "$SIDECHAT_OSS_DIR/mcp/src/server.ts" ]]; then
  MCP_SRC_DIR="$SIDECHAT_OSS_DIR/mcp"
elif [[ -f "$SCRIPT_DIR/src/server.ts" ]]; then
  MCP_SRC_DIR="$SCRIPT_DIR"
else
  echo "ERROR: couldn't find mcp/src/server.ts. Pass --server-src-dir <path> or set SIDECHAT_OSS_DIR." >&2
  exit 1
fi

# Ensure dependencies are installed in that src dir
if [[ ! -d "$MCP_SRC_DIR/node_modules/@modelcontextprotocol/sdk" ]]; then
  echo "Installing MCP server dependencies in $MCP_SRC_DIR..."
  ( cd "$MCP_SRC_DIR" && bun install --silent )
fi

# --- Challenge-response with scope=mcp -------------------------------------

# shellcheck disable=SC1090
source "$CONFIG"

: "${SERVER_URL:?SERVER_URL not in $CONFIG}"
: "${FINGERPRINT:?FINGERPRINT not in $CONFIG}"
: "${KEY_PATH:?KEY_PATH not in $CONFIG}"

CHALLENGE=$(curl -sf "$SERVER_URL/auth/challenge?fingerprint=$FINGERPRINT") \
  || { echo "ERROR: /auth/challenge failed. Bot may not be approved, or the server is down." >&2; exit 1; }
NONCE=$(echo "$CHALLENGE" | jq -r '.nonce')
if [[ -z "$NONCE" || "$NONCE" == "null" ]]; then
  echo "ERROR: $(echo "$CHALLENGE" | jq -r '.error // "bad challenge response"')" >&2
  exit 1
fi

SSH_SIG=$(printf '%s' "$NONCE" | ssh-keygen -Y sign -f "$KEY_PATH" -n sidechat 2>/dev/null)
SIG=$(echo "$SSH_SIG" | grep -v '^-----' | tr -d '\n')

TOKEN_RESPONSE=$(curl -sf -X POST "$SERVER_URL/auth/token?scope=mcp" \
  -H "Content-Type: application/json" \
  -d "{\"fingerprint\":\"$FINGERPRINT\",\"nonce\":\"$NONCE\",\"signature\":\"$SIG\"}")

TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.token')
SCOPE=$(echo "$TOKEN_RESPONSE" | jq -r '.scope')
EXPIRES=$(echo "$TOKEN_RESPONSE" | jq -r '.expires_at')
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "ERROR: $(echo "$TOKEN_RESPONSE" | jq -r '.error // "token exchange failed"')" >&2
  exit 1
fi

if [[ "$SCOPE" != "mcp" ]]; then
  echo "WARNING: server returned scope='$SCOPE', expected 'mcp'. Is the server < 2.3.0?" >&2
fi

# --- Emit the `claude mcp add` command -------------------------------------

BUN_BIN="$(command -v bun)"
MCP_ENTRY="$MCP_SRC_DIR/src/server.ts"

# Construct the command the operator should run. Use --env flags so the token
# never touches a file on disk outside the caller's invocation + Claude
# Code's own MCP config.
CMD=(claude mcp add "$MCP_NAME" -s user
     --env "SIDECHAT_URL=$SERVER_URL"
     --env "SIDECHAT_TOKEN=$TOKEN"
     "$BUN_BIN" run "$MCP_ENTRY")

echo ""
echo "  Minted scope=mcp token (expires $EXPIRES)."
echo ""
echo "  Register the MCP server with Claude Code:"
echo ""
printf '    %q ' "${CMD[@]}"
echo ""
echo ""

if $APPLY; then
  echo "  --apply set — running the above now..."
  "${CMD[@]}"
  echo ""
  echo "  Done. Verify with: claude mcp list"
fi
