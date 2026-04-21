#!/usr/bin/env bash
# install-mcp.sh — Phase 3 bootstrapper.
#
# Mints a scope=mcp bearer token against the SideChat server using the same
# Ed25519 challenge-response the sidechat shell client uses, and prints a
# ready-to-paste `claude mcp add` one-liner with the token injected.
#
# Binary preference (no bun required for end-users):
#   The script first probes GitHub Releases for a prebuilt `sidechat-mcp-$PLATFORM`
#   binary matching the caller's OS/arch and the server's version. If found and
#   sha256 matches, that binary is cached under ~/.sidechat/mcp/ and registered
#   as the MCP subprocess. If the probe fails (no network, no matching asset,
#   checksum mismatch) the script falls back to `bun run mcp/src/server.ts`.
#
# Prereqs:
#   - sidechat client already installed (~/.sidechat/config exists with
#     SERVER_URL, FINGERPRINT, KEY_PATH). Run install/client.sh first if not.
#   - `curl`, `jq`, `ssh-keygen` on $PATH.
#   - `bun` on $PATH *only* if the binary probe fails and you need the
#     `bun run`-based fallback.
#
# Usage:
#   ./install-mcp.sh                      # reads ~/.sidechat/config, prints the one-liner
#   ./install-mcp.sh --apply              # runs the `claude mcp add` itself
#   ./install-mcp.sh --name <n>           # override MCP server name (default: sidechat)
#   ./install-mcp.sh --no-binary          # skip binary probe, force bun-run path
#
# The minted token inherits SideChat's SESSION_TTL_HOURS (24h by default).
# Re-run this script when the token expires and the MCP server starts 401ing.

set -euo pipefail

SIDECHAT_DIR="${SIDECHAT_DIR:-$HOME/.sidechat}"
CONFIG="$SIDECHAT_DIR/config"
BIN_CACHE="$SIDECHAT_DIR/mcp"
RELEASE_REPO="${SIDECHAT_RELEASE_REPO:-jasonfen/sidechat-oss}"

APPLY=false
MCP_NAME="sidechat"
SERVER_SRC_DIR_OVERRIDE=""
USE_BINARY=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true; shift ;;
    --name) MCP_NAME="$2"; shift 2 ;;
    --server-src-dir) SERVER_SRC_DIR_OVERRIDE="$2"; shift 2 ;;
    --no-binary) USE_BINARY=false; shift ;;
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

for cmd in curl jq ssh-keygen; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' is required on \$PATH." >&2
    exit 1
  fi
done

# --- Binary probe ----------------------------------------------------------
# If a release binary matches our platform + the server's MCP client version,
# use it. Falls back to `bun run` otherwise.

MCP_BIN=""
if $USE_BINARY; then
  # Detect platform suffix used by the release workflow.
  case "$(uname -s)" in
    Linux)  _os=linux ;;
    Darwin) _os=darwin ;;
    *)      _os="" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  _arch=x64 ;;
    arm64|aarch64) _arch=arm64 ;;
    *)             _arch="" ;;
  esac

  if [[ -n "$_os" && -n "$_arch" ]]; then
    PLATFORM="${_os}-${_arch}"
    # Read SERVER_URL from config to find the server's pinned client build.
    # Graceful fallback: if /install/mcp-version isn't reachable, use :latest.
    _server_url=$(awk -F= '$1=="SERVER_URL"{print $2}' "$CONFIG" 2>/dev/null || echo "")
    EXPECTED_SHA=""
    if [[ -n "$_server_url" ]]; then
      EXPECTED_SHA=$(curl -fsS --max-time 3 "$_server_url/install/mcp-version" 2>/dev/null \
        | jq -r '.expected_client_build_sha // empty' 2>/dev/null || true)
    fi
    REL_TAG="latest"
    [[ -n "$EXPECTED_SHA" && "$EXPECTED_SHA" != "null" ]] && REL_TAG="v$EXPECTED_SHA"

    mkdir -p "$BIN_CACHE"
    CACHED_BIN="$BIN_CACHE/sidechat-mcp-${PLATFORM}-${REL_TAG}"
    CACHED_SUMS="$BIN_CACHE/SHA256SUMS-${REL_TAG}"

    if [[ ! -x "$CACHED_BIN" ]]; then
      echo "Probing GitHub Releases for sidechat-mcp-${PLATFORM} (${REL_TAG})..."
      _api_base="https://api.github.com/repos/${RELEASE_REPO}/releases"
      if [[ "$REL_TAG" == "latest" ]]; then _api="$_api_base/latest"; else _api="$_api_base/tags/$REL_TAG"; fi
      _meta=$(curl -fsSL --max-time 10 "$_api" 2>/dev/null || true)
      # Resilience: if the tagged release is missing (server's expected_sha
      # points at a version not yet released, or a rollback situation),
      # fall back to /releases/latest with a warning so drift is visible.
      if [[ -z "$_meta" && "$REL_TAG" != "latest" ]]; then
        echo "  WARN: release $REL_TAG not found; falling back to /releases/latest." >&2
        _meta=$(curl -fsSL --max-time 10 "$_api_base/latest" 2>/dev/null || true)
      fi
      _bin_url=$(echo "$_meta" | jq -r ".assets[]? | select(.name==\"sidechat-mcp-${PLATFORM}\") | .browser_download_url" 2>/dev/null || true)
      _sums_url=$(echo "$_meta" | jq -r '.assets[]? | select(.name=="SHA256SUMS") | .browser_download_url' 2>/dev/null || true)
      if [[ -n "$_bin_url" && "$_bin_url" != "null" ]]; then
        if curl -fsSL --max-time 60 "$_bin_url" -o "$CACHED_BIN.partial" 2>/dev/null; then
          if [[ -n "$_sums_url" && "$_sums_url" != "null" ]] \
             && curl -fsSL --max-time 10 "$_sums_url" -o "$CACHED_SUMS" 2>/dev/null; then
            _want=$(awk -v n="sidechat-mcp-${PLATFORM}" '$2==n{print $1}' "$CACHED_SUMS")
            _got=$(sha256sum "$CACHED_BIN.partial" | awk '{print $1}')
            if [[ -n "$_want" && "$_want" == "$_got" ]]; then
              chmod +x "$CACHED_BIN.partial"
              mv "$CACHED_BIN.partial" "$CACHED_BIN"
              echo "  OK: cached $CACHED_BIN"
            else
              echo "  WARN: sha256 mismatch (want=$_want got=$_got), falling back to bun-run." >&2
              rm -f "$CACHED_BIN.partial"
            fi
          else
            # No SHA256SUMS asset: accept on download success only (legacy path).
            chmod +x "$CACHED_BIN.partial"
            mv "$CACHED_BIN.partial" "$CACHED_BIN"
            echo "  OK (unchecked): cached $CACHED_BIN"
          fi
        else
          echo "  WARN: download failed, falling back to bun-run." >&2
          rm -f "$CACHED_BIN.partial"
        fi
      else
        echo "  No matching asset in release $REL_TAG; falling back to bun-run."
      fi
    fi

    [[ -x "$CACHED_BIN" ]] && MCP_BIN="$CACHED_BIN"
  fi
fi

# --- Source-tree fallback (used when MCP_BIN is empty) ---------------------

MCP_SRC_DIR=""
if [[ -z "$MCP_BIN" ]]; then
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
    echo "ERROR: no binary available for this platform and couldn't find mcp/src/server.ts." >&2
    echo "  Pass --server-src-dir <path>, set SIDECHAT_OSS_DIR, or wait for a release build." >&2
    exit 1
  fi

  if ! command -v bun &>/dev/null; then
    echo "ERROR: bun is required on \$PATH for the source fallback, and no platform binary was found." >&2
    exit 1
  fi

  if [[ ! -d "$MCP_SRC_DIR/node_modules/@modelcontextprotocol/sdk" ]]; then
    echo "Installing MCP server dependencies in $MCP_SRC_DIR..."
    ( cd "$MCP_SRC_DIR" && bun install --silent )
  fi
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

# Construct the command the operator should run. Use -e flags so the token
# never touches a file on disk outside the caller's invocation + Claude
# Code's own MCP config. `--` separates Claude Code's flags from the
# subprocess command line (required by `claude mcp add`).
if [[ -n "$MCP_BIN" ]]; then
  CMD=(claude mcp add "$MCP_NAME" -s user
       -e "SIDECHAT_URL=$SERVER_URL"
       -e "SIDECHAT_TOKEN=$TOKEN"
       -- "$MCP_BIN")
else
  BUN_BIN="$(command -v bun)"
  MCP_ENTRY="$MCP_SRC_DIR/src/server.ts"
  CMD=(claude mcp add "$MCP_NAME" -s user
       -e "SIDECHAT_URL=$SERVER_URL"
       -e "SIDECHAT_TOKEN=$TOKEN"
       -- "$BUN_BIN" run "$MCP_ENTRY")
fi

echo ""
echo "  Minted scope=mcp token (expires $EXPIRES)."
echo ""
echo "  Register the MCP server with Claude Code:"
echo ""
# Build a clean copy-pasteable one-liner: quote each arg with %q only when it
# needs it. We do this manually to avoid printf %q's aggressive backslashing
# on simple args.
printable=""
for a in "${CMD[@]}"; do
  case "$a" in
    *[!a-zA-Z0-9_/.:=,-]*|"") printable+=" $(printf '%q' "$a")" ;;
    *) printable+=" $a" ;;
  esac
done
echo "   $printable"
echo ""

if $APPLY; then
  echo "  --apply set — running the above now..."
  # Remove any previous registration so --apply is idempotent.
  claude mcp remove "$MCP_NAME" -s user >/dev/null 2>&1 || true
  "${CMD[@]}"
  echo ""
  echo "  Done. Verify with: claude mcp list"
fi
