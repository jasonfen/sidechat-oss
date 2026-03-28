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

# Sign nonce with SSH private key
if command -v bun &>/dev/null; then
  SIG=$(bun -e "
    const { createPrivateKey, sign } = require('crypto');
    const fs = require('fs');
    const key = createPrivateKey(fs.readFileSync('$KEY_PATH'));
    const nonce = process.argv[1];
    const sig = sign(null, Buffer.from(nonce), key);
    process.stdout.write(sig.toString('base64'));
  " "$NONCE")
elif command -v node &>/dev/null; then
  SIG=$(node -e "
    const { createPrivateKey, sign } = require('crypto');
    const fs = require('fs');
    const key = createPrivateKey(fs.readFileSync('$KEY_PATH'));
    const nonce = process.argv[1];
    const sig = sign(null, Buffer.from(nonce), key);
    process.stdout.write(sig.toString('base64'));
  " "$NONCE")
else
  echo "ERROR: bun or node required for signing" >&2
  exit 1
fi

# Exchange signature for session token
TOKEN_RESPONSE=$(curl -sf -X POST "$SERVER_URL/auth/token" \
  -H "Content-Type: application/json" \
  -d "{\"fingerprint\":\"$FINGERPRINT\",\"nonce\":\"$NONCE\",\"signature\":\"$SIG\"}")

TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.token')
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  ERROR=$(echo "$TOKEN_RESPONSE" | jq -r '.error // "Token exchange failed"')
  echo "ERROR: $ERROR" >&2
  exit 1
fi

# Update config with token (replace existing TOKEN line or append)
if grep -q '^TOKEN=' "$CONFIG"; then
  sed -i "s|^TOKEN=.*|TOKEN=$TOKEN|" "$CONFIG"
else
  echo "TOKEN=$TOKEN" >> "$CONFIG"
fi

echo "Authenticated. Token stored in $CONFIG"
