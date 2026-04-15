#!/usr/bin/env bash
# Authenticate with SideChat server via SSH challenge-response
# Stores session token in .sidechat/config

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: config not found at $CONFIG" >&2
  echo "Run client.sh first to register." >&2
  exit 1
fi

source "$CONFIG"

# Request challenge nonce
CHALLENGE=$(curl -sf "$SERVER_URL/auth/challenge?fingerprint=$FINGERPRINT")
if [[ -z "$CHALLENGE" ]]; then
  echo "ERROR: Challenge request failed. Client may not be approved yet." >&2
  exit 1
fi

NONCE=$(echo "$CHALLENGE" | jq -r '.nonce')
if [[ -z "$NONCE" || "$NONCE" == "null" ]]; then
  ERROR=$(echo "$CHALLENGE" | jq -r '.error // "Unknown error"')
  echo "ERROR: $ERROR" >&2
  exit 1
fi

# Sign nonce with SSH key using ssh-keygen (works on all platforms)
SSH_SIG=$(printf '%s' "$NONCE" | ssh-keygen -Y sign -f "$KEY_PATH" -n sidechat 2>/dev/null)
if [[ -z "$SSH_SIG" ]]; then
  echo "ERROR: ssh-keygen signing failed" >&2
  exit 1
fi

# Extract base64 body (strip PEM armor headers)
SIG=$(echo "$SSH_SIG" | grep -v '^-----' | tr -d '\n')

# Exchange signature for session token. Send our installed-script version
# (recorded by sc-update.sh) so the server can show per-bot version status.
SCRIPT_DIR_LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_VERSION=$(cat "$SCRIPT_DIR_LOCAL/sc-version.txt" 2>/dev/null || echo "")
VERSION_HEADER=()
[[ -n "$CLIENT_VERSION" ]] && VERSION_HEADER=(-H "X-SideChat-Client-Version: $CLIENT_VERSION")
TOKEN_RESPONSE=$(curl -sf -X POST "$SERVER_URL/auth/token" \
  -H "Content-Type: application/json" \
  "${VERSION_HEADER[@]}" \
  -d "{\"fingerprint\":\"$FINGERPRINT\",\"nonce\":\"$NONCE\",\"signature\":\"$SIG\"}")

TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.token')
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  ERROR=$(echo "$TOKEN_RESPONSE" | jq -r '.error // "Token exchange failed"')
  echo "ERROR: $ERROR" >&2
  exit 1
fi

# Update config with token (replace existing TOKEN line or append)
if grep -q '^TOKEN=' "$CONFIG"; then
  sed "s|^TOKEN=.*|TOKEN=$TOKEN|" "$CONFIG" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
else
  echo "TOKEN=$TOKEN" >> "$CONFIG"
fi

echo "Authenticated. Token stored in $CONFIG"

# Restart webhook listener to pick up new token (if managed by systemd)
if systemctl is-active sidechat-webhook.service &>/dev/null; then
  sudo systemctl restart sidechat-webhook.service 2>/dev/null && \
    echo "Restarted sidechat-webhook.service with new token" || true
fi
