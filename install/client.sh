#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=".sidechat"

echo "=== SideChat Client Installer ==="
echo ""

# Server URL — passed as argument, env var, or prompted
if [[ -n "${1:-}" ]]; then
  SIDECHAT_URL="$1"
elif [[ -n "${SIDECHAT_URL:-}" ]]; then
  true  # already set via env
else
  read -rp "SideChat server URL (e.g. http://myserver:3000): " SIDECHAT_URL < /dev/tty
fi

# Strip trailing slash
SIDECHAT_URL="${SIDECHAT_URL%/}"

if [[ -z "$SIDECHAT_URL" ]]; then
  echo "ERROR: Server URL is required" >&2
  echo "Usage: client.sh <server-url>" >&2
  exit 1
fi

echo "Server: $SIDECHAT_URL"
echo ""

# Check prerequisites
for cmd in curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is required but not installed." >&2
    echo "  macOS: brew install $cmd" >&2
    echo "  Linux: apt install $cmd" >&2
    exit 1
  fi
done

# --- Clean up old installation ---

# Remove old root-level scripts from previous versions
for old_script in sc-post.sh sc-poll.sh sc-watch.sh; do
  if [[ -f "$old_script" ]]; then
    rm -f "$old_script"
    echo "  removed old $old_script from repo root"
  fi
done

# If .sidechat is a file (old config format), remove it
if [[ -f "$SCRIPT_DIR" && ! -d "$SCRIPT_DIR" ]]; then
  rm -f "$SCRIPT_DIR"
  echo "  removed old .sidechat config file"
fi

# Remove old SideChat block from CLAUDE.md so we can write the latest version
if [[ -f CLAUDE.md ]]; then
  sed -i '/## SideChat — Autonomous Status Posting/,/other instance.*work\./d' CLAUDE.md
  # Also remove any v2 auth block so we can rewrite it
  sed -i '/## SideChat/,/sc-post\.sh will re-authenticate/d' CLAUDE.md
  # Clean up any trailing blank lines left by the sed
  sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' CLAUDE.md
fi

# --- Install ---

mkdir -p "$SCRIPT_DIR"
echo "Downloading shell scripts to $SCRIPT_DIR/..."
for script in sc-post.sh sc-poll.sh sc-watch.sh sc-notify.sh sc-auth.sh; do
  curl -fsSL "$SIDECHAT_URL/install/$script" -o "$SCRIPT_DIR/$script"
  chmod +x "$SCRIPT_DIR/$script"
  echo "  $SCRIPT_DIR/$script"
done

# --- SSH Key Registration ---

KEY_PATH="$HOME/.ssh/id_ed25519"

if [[ ! -f "${KEY_PATH}.pub" ]]; then
  echo ""
  read -rp "No Ed25519 SSH key found. Generate one now? [y/N] " GENERATE < /dev/tty
  if [[ "$GENERATE" =~ ^[Yy]$ ]]; then
    ssh-keygen -t ed25519 -f "$KEY_PATH" -N ""
    echo "  key generated at $KEY_PATH"
  else
    echo "ERROR: Ed25519 key required for SideChat authentication" >&2
    exit 1
  fi
fi

PUBLIC_KEY=$(cat "${KEY_PATH}.pub")
HOSTNAME_DEFAULT=$(hostname)

echo ""
read -rp "Bot name [${HOSTNAME_DEFAULT}]: " BOT_NAME < /dev/tty
BOT_NAME="${BOT_NAME:-$HOSTNAME_DEFAULT}"

echo "Registering with SideChat server..."
REG_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$SIDECHAT_URL/register" \
  -H "Content-Type: application/json" \
  -d "{\"name\": $(echo "$BOT_NAME" | jq -Rs .), \"public_key\": $(echo "$PUBLIC_KEY" | jq -Rs .)}")

HTTP_CODE=$(echo "$REG_RESPONSE" | tail -1)
BODY=$(echo "$REG_RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
  echo "ERROR: Registration failed ($HTTP_CODE): $BODY" >&2
  exit 1
fi

FINGERPRINT=$(echo "$BODY" | jq -r '.fingerprint')

cat > "$SCRIPT_DIR/config" <<EOF
SERVER_URL=$SIDECHAT_URL
BOT_NAME=$BOT_NAME
FINGERPRINT=$FINGERPRINT
KEY_PATH=$KEY_PATH
EOF

echo "  config written to $SCRIPT_DIR/config"

# --- .gitignore ---

if [[ -f .gitignore ]]; then
  if ! grep -q '^\.sidechat/$' .gitignore; then
    echo '.sidechat/' >> .gitignore
    echo "  .sidechat/ added to .gitignore"
  fi
else
  echo '.sidechat/' > .gitignore
  echo "  .gitignore created with .sidechat/"
fi

# --- CLAUDE.md ---

CLAUDE_BLOCK="## SideChat — Autonomous Status Posting

A shared chat channel is running at $SIDECHAT_URL.
Post status updates autonomously. To post: write your message to .sidechat/message.txt
then run .sidechat/sc-post.sh (no arguments). This allows the command to be auto-approved.

## Authentication

Authentication uses SSH public key challenge-response.

Before posting, ensure you have a valid session token:
1. Run .sidechat/sc-auth.sh to exchange your SSH key signature for a session token
2. Token is stored in .sidechat/config and read automatically by sc-post.sh
3. Tokens expire after 24 hours; sc-post.sh will re-authenticate automatically on 401

**Post when you:**
- Start working on a new feature, module, or task
- Complete a meaningful unit of work
- Discover something the other instance should know (API contract, schema, interface)
- Hit a blocker that might affect the other side
- Finish for the session

**Post format:** One or two sentences. Be concrete. Include file names or function
names when relevant.
Example: \"Starting auth module — implementing POST /login in src/auth.ts\"

**Poll for updates:** Run .sidechat/sc-poll.sh before starting any new task to check
what the other instance has done. Check again if you are about to define a shared
interface.

**@Mentions:** You can mention other users with @username. Use @username when you
need their attention on something specific.

**Monitor mentions:** Run .sidechat/sc-notify.sh & to start a background monitor.
When someone @mentions you, it appends to .sidechat/notifications. Check this file
periodically to see if anyone needs your attention.

**Do not post:** Every minor step, commentary, or status that does not affect the
other instance's work."

printf '\n%s\n' "$CLAUDE_BLOCK" >> CLAUDE.md
echo "  SideChat entry added to CLAUDE.md"

# --- Done ---

echo ""
echo "=== Registration submitted ==="
echo "Fingerprint: ${FINGERPRINT:0:16}..."
echo ""
echo "Awaiting admin approval. Once approved, run:"
echo "  .sidechat/sc-auth.sh"
echo ""
echo "After authentication:"
echo "  Post:    .sidechat/sc-post.sh \"message\""
echo "  Poll:    .sidechat/sc-poll.sh"
echo "  Watch:   .sidechat/sc-watch.sh"
echo "  Monitor: .sidechat/sc-notify.sh &  (background @mention monitor)"
