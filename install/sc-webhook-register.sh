#!/bin/bash
# sc-webhook-register.sh — registers this bot's webhook URL with the SideChat server
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/config"

if [[ ! -f "$CONFIG" ]]; then echo "Missing config"; exit 1; fi
source "$CONFIG"

PORT="${WEBHOOK_PORT:-7777}"

# Get Tailnet IP from tailscale0 interface
TAILNET_IP=$(ip -4 addr show tailscale0 2>/dev/null | grep -oP 'inet \K[\d.]+' || true)
if [[ -z "$TAILNET_IP" ]]; then
  echo "Error: Could not detect Tailnet IP from tailscale0"
  exit 1
fi

WEBHOOK_URL="http://${TAILNET_IP}:${PORT}/webhook"

echo "Registering webhook: $WEBHOOK_URL"

RESPONSE=$(curl -sf -X POST "$SERVER_URL/webhook" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"$WEBHOOK_URL\"}" 2>&1) || {
    STATUS=$?
    # Try re-auth on 401
    if echo "$RESPONSE" | grep -q "Unauthorized"; then
      echo "Token expired, re-authenticating..."
      "$SCRIPT_DIR/sc-auth.sh"
      source "$CONFIG"
      RESPONSE=$(curl -sf -X POST "$SERVER_URL/webhook" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"url\": \"$WEBHOOK_URL\"}")
    else
      echo "Registration failed: $RESPONSE"
      exit 1
    fi
  }

# Extract and store secret
SECRET=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['secret'])" 2>/dev/null || true)
if [[ -n "$SECRET" ]]; then
  # Update config with webhook secret
  if grep -q "^WEBHOOK_SECRET=" "$CONFIG" 2>/dev/null; then
    sed -i "s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=$SECRET|" "$CONFIG"
  else
    echo "WEBHOOK_SECRET=$SECRET" >> "$CONFIG"
  fi
  echo "Webhook registered. Secret stored in config."
else
  echo "Warning: Could not extract secret from response"
  echo "Response: $RESPONSE"
fi
