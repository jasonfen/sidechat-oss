#!/usr/bin/env bash
# Usage: curl -fsSL <server>/install/client.sh | bash -s -- [--name <botname>] [--force] [<server-url>]
set -euo pipefail

SIDECHAT_URL=""
SCRIPT_DIR=".sidechat"
CLI_BOT_NAME=""
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) CLI_BOT_NAME="$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) SIDECHAT_URL="$1"; shift ;;
  esac
done

if [[ -z "$SIDECHAT_URL" && -f "$SCRIPT_DIR/config" ]]; then
  SIDECHAT_URL=$(grep '^SERVER_URL=' "$SCRIPT_DIR/config" | cut -d= -f2-)
fi

# Prompt for URL if not supplied — supports the GitHub-raw install path where
# the user curls `raw.githubusercontent.com/.../client.sh` and the server URL
# can't be inferred from the curl target.
if [[ -z "$SIDECHAT_URL" && -r /dev/tty && "${CLAUDECODE:-}" != "1" ]]; then
  read -rp "Server URL (e.g. http://sidechat.local:3000): " SIDECHAT_URL < /dev/tty
  SIDECHAT_URL="${SIDECHAT_URL%/}"
fi

if [[ -z "$SIDECHAT_URL" ]]; then
  echo "Error: Server URL required. Usage: bash client.sh <server-url>"
  echo "  Example: curl -fsSL http://your-server:3000/install/client.sh | bash -s -- http://your-server:3000"
  echo "  Or:      curl -fsSL https://raw.githubusercontent.com/jasonfen/sidechat-oss/main/install/client.sh | bash -s -- http://your-server:3000"
  exit 1
fi

# Detect Claude Code — interactive prompts won't work inside the Bash tool
if [[ "${CLAUDECODE:-}" == "1" ]]; then
  NEEDS_INTERACTIVE=false
  # Need bot name if no config exists and --name wasn't provided
  if [[ ! -f "$SCRIPT_DIR/config" && -z "$CLI_BOT_NAME" ]]; then
    NEEDS_INTERACTIVE=true
  fi
  # Need SSH key generation prompt if no key exists
  if [[ ! -f "$HOME/.ssh/id_ed25519.pub" ]]; then
    NEEDS_INTERACTIVE=true
  fi

  if [[ "$NEEDS_INTERACTIVE" == "true" ]]; then
    echo "ERROR: client.sh needs interactive input but is running inside Claude Code." >&2
    echo "" >&2
    echo "Run in a regular terminal with:" >&2
    echo "  curl -fsSL $SIDECHAT_URL/install/client.sh | bash -s -- --name <botname>" >&2
    echo "" >&2
    echo "Or tell the user to run:  ! curl -fsSL $SIDECHAT_URL/install/client.sh | bash -s -- --name <botname>" >&2
    exit 1
  fi
fi

echo "=== SideChat Client Installer ==="
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

# ssh-keygen is required for authentication (signing)
if ! command -v ssh-keygen &>/dev/null; then
  echo "ERROR: ssh-keygen is required but not found" >&2
  exit 1
fi

# --- Clean up old installation ---

# Remove old root-level scripts from previous versions
for old_script in sc-post.sh sc-poll.sh sc-watch.sh sc-mention-monitor.sh; do
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
# Use temp file for portability (macOS sed -i requires different syntax than GNU)
if [[ -f CLAUDE.md ]]; then
  sed '/## SideChat — Autonomous Status Posting/,/push\/commit status\./d' CLAUDE.md > CLAUDE.md.tmp && mv CLAUDE.md.tmp CLAUDE.md
  sed '/## SideChat — Autonomous Status Posting/,/the hook covers that\./d' CLAUDE.md > CLAUDE.md.tmp && mv CLAUDE.md.tmp CLAUDE.md
  sed '/## SideChat — Autonomous Status Posting/,/other instance.*work\./d' CLAUDE.md > CLAUDE.md.tmp && mv CLAUDE.md.tmp CLAUDE.md
  sed '/## SideChat/,/sc-post\.sh will re-authenticate/d' CLAUDE.md > CLAUDE.md.tmp && mv CLAUDE.md.tmp CLAUDE.md
  sed '/## SideChat/,/sc-post\.sh as a Bash command\./d' CLAUDE.md > CLAUDE.md.tmp && mv CLAUDE.md.tmp CLAUDE.md
fi

# Remove obsolete scripts from .sidechat/
for old in sc-watch.sh sc-mention-monitor.sh; do
  rm -f "$SCRIPT_DIR/$old"
done

# --- Install ---

mkdir -p "$SCRIPT_DIR" "$SCRIPT_DIR/hooks"
echo "Downloading shell scripts to $SCRIPT_DIR/..."
for script in sc-post.sh sc-poll.sh sc-auth.sh sc-cleanup.sh sc-webhook-listener.sh sc-webhook-register.sh sc-webhook-server.py sc-update.sh sc-receipt.sh install-mcp.sh resolve-sidechat-dir.sh; do
  curl -fsSL "$SIDECHAT_URL/install/$script" -o "$SCRIPT_DIR/$script"
  chmod +x "$SCRIPT_DIR/$script"
  echo "  $SCRIPT_DIR/$script"
done

# Kill stale processes from previous installation
if [[ "$FORCE" == "true" && -f "$SCRIPT_DIR/config" ]]; then
  echo "Cleaning up stale processes..."
  "$SCRIPT_DIR/sc-cleanup.sh" 2>/dev/null || true
fi

# Download hooks
for hook in post-push.sh post-message.sh on-new-mentions.sh sessionstart-poll.sh stop-poll.sh aggressive-pickup.sh; do
  curl -fsSL "$SIDECHAT_URL/install/hooks/$hook" -o "$SCRIPT_DIR/hooks/$hook"
  chmod +x "$SCRIPT_DIR/hooks/$hook"
  echo "  $SCRIPT_DIR/hooks/$hook"
done

# --- SSH Key Registration ---

FRESH_INSTALL=false
if [[ -f "$SCRIPT_DIR/config" && "$FORCE" != "true" ]]; then
  # Existing install — preserve config, skip registration
  echo "Existing config found at $SCRIPT_DIR/config — skipping registration"
  source "$SCRIPT_DIR/config"
else
  FRESH_INSTALL=true
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
  HOSTNAME_DEFAULT=$(hostname -s 2>/dev/null || hostname | sed 's/\.local$//')

  echo ""
  if [[ -n "$CLI_BOT_NAME" ]]; then
    BOT_NAME="$CLI_BOT_NAME"
    echo "Bot name: $BOT_NAME"
  else
    read -rp "Bot name [${HOSTNAME_DEFAULT}]: " BOT_NAME < /dev/tty
    BOT_NAME="${BOT_NAME:-$HOSTNAME_DEFAULT}"
  fi

  echo "Registering with SideChat server..."
  REG_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "$SIDECHAT_URL/register" \
    -H "Content-Type: application/json" \
    -d "{\"name\": $(printf '%s' "$BOT_NAME" | jq -Rs .), \"public_key\": $(printf '%s' "$PUBLIC_KEY" | jq -Rs .)}")

  HTTP_CODE=$(echo "$REG_RESPONSE" | tail -1)
  BODY=$(echo "$REG_RESPONSE" | sed '$d')

  if [[ "$HTTP_CODE" == "409" && "$FORCE" == "true" ]]; then
    echo "  Already registered (409) — --force: skipping registration, writing config"
    # Compute fingerprint same as server: sha256(raw 32-byte ed25519 key).hex
    # Public key blob: 4-byte type length + "ssh-ed25519" (11 bytes) + 4-byte key length + 32-byte key
    # Skip first 19 bytes (4+11+4), hash the remaining 32 bytes
    SHA_CMD="sha256sum"
    command -v sha256sum &>/dev/null || SHA_CMD="shasum -a 256"
    FINGERPRINT=$(awk '{print $2}' "${KEY_PATH}.pub" | base64 -d | tail -c 32 | $SHA_CMD | awk '{print $1}')
  elif [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
    echo "ERROR: Registration failed ($HTTP_CODE): $BODY" >&2
    exit 1
  else
    FINGERPRINT=$(echo "$BODY" | jq -r '.fingerprint')
  fi

  cat > "$SCRIPT_DIR/config" <<EOF
SERVER_URL=$SIDECHAT_URL
BOT_NAME=$BOT_NAME
FINGERPRINT=$FINGERPRINT
KEY_PATH=$KEY_PATH
EOF

  echo "  config written to $SCRIPT_DIR/config"
fi

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

# Fetch the canonical block from the server (single source of truth introduced
# in 2.6.10). $SERVER_URL inside the template gets substituted to this bot's
# SIDECHAT_URL so the block reads correctly on bots pointed at non-prod
# servers. Falls back to a one-line pointer if the fetch fails — operators can
# re-run client.sh once the server is reachable.
if CLAUDE_BLOCK=$(curl -fsSL "$SIDECHAT_URL/install/claude-md-block" 2>/dev/null); then
  CLAUDE_BLOCK="${CLAUDE_BLOCK//\$SERVER_URL/$SIDECHAT_URL}"
else
  CLAUDE_BLOCK="## SideChat — Autonomous Status Posting

Block unreachable at install time. Re-run this installer against $SIDECHAT_URL
once the server is reachable to populate the SideChat CLAUDE.md content.

Do not manually post push/commit status or call sc-post.sh as a Bash command."
fi

if grep -q "## SideChat" CLAUDE.md 2>/dev/null; then
  # Remove existing SideChat block and replace with updated version
  sed '/^## SideChat/,/^Do not manually post/d' CLAUDE.md > CLAUDE.md.tmp && mv CLAUDE.md.tmp CLAUDE.md
  # Strip trailing blank lines left behind
  sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' CLAUDE.md > CLAUDE.md.tmp && mv CLAUDE.md.tmp CLAUDE.md
fi
printf '\n%s\n' "$CLAUDE_BLOCK" >> CLAUDE.md
echo "  SideChat entry added to CLAUDE.md"

# --- /start command ---

COMMANDS_DIR=".claude/commands"
mkdir -p "$COMMANDS_DIR"
for cmd_file in start.md mention-check.md; do
  curl -fsSL "$SIDECHAT_URL/install/commands/$cmd_file" -o "$COMMANDS_DIR/$cmd_file"
  echo "  $COMMANDS_DIR/$cmd_file"
done

# --- Session startup config ---

cat > "$SCRIPT_DIR/crons.md" <<'CRONSEOF'
# SideChat — Session Startup Tasks

Recreate these after every restart. They are session-scoped.

## 1. Run /start

Launches SSE listener, polling backup, and mention watcher as background
processes. The mention watcher writes to `.sidechat/new-mentions.txt` when
a new @mention arrives, and the FileChanged hook triggers `/mention-check`.

## 2. Register webhook (if not already registered)

Run `.sidechat/sc-webhook-register.sh` to register this bot's webhook URL
with the server. This enables instant mention delivery — the server POSTs
directly to this bot instead of relying on polling. Only needs to run once
per server URL change or secret rotation.

## 3. Verify webhook listener

The webhook listener runs as a systemd service (`sidechat-webhook.service`)
and auto-starts on boot. Check with `systemctl status sidechat-webhook.service`.
If not running, start with `sudo systemctl start sidechat-webhook.service`.
CRONSEOF
echo "  $SCRIPT_DIR/crons.md"

# --- Claude Code hooks ---

HOOKS_DIR=".claude"
mkdir -p "$HOOKS_DIR"

SETTINGS_FILE="$HOOKS_DIR/settings.local.json"
PUSH_HOOK="$(pwd)/$SCRIPT_DIR/hooks/post-push.sh"
MSG_HOOK="$(pwd)/$SCRIPT_DIR/hooks/post-message.sh"
MENTION_HOOK="$(pwd)/$SCRIPT_DIR/hooks/on-new-mentions.sh"
SESSIONSTART_HOOK="$(pwd)/$SCRIPT_DIR/hooks/sessionstart-poll.sh"
STOP_HOOK="$(pwd)/$SCRIPT_DIR/hooks/stop-poll.sh"
AGGRESSIVE_HOOK="$(pwd)/$SCRIPT_DIR/hooks/aggressive-pickup.sh"

# Build the desired settings config (hooks + permissions for background agent)
HOOKS_JSON=$(cat <<HOOKEOF
{
  "permissions": {
    "allow": [
      "Write(.sidechat/message.txt)",
      "Write(.sidechat/.last-handled-line)",
      "Write(.sidechat/pending-actions.txt)",
      "Bash(.sidechat/sc-cleanup.sh)",
      "Bash(.sidechat/sc-poll.sh)",
      "Bash(.sidechat/sc-webhook-listener.sh *)",
      "Bash(.sidechat/sc-webhook-register.sh)",
      "Bash(.sidechat/sc-receipt.sh *)"
    ]
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$SESSIONSTART_HOOK",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$STOP_HOOK",
            "timeout": 10
          }
        ]
      }
    ],
    "FileChanged": [
      {
        "matcher": ".sidechat/new-mentions.txt",
        "hooks": [
          {
            "type": "command",
            "command": "$MENTION_HOOK",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$PUSH_HOOK",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "$MSG_HOOK",
            "timeout": 10
          }
        ]
      },
      {
        "hooks": [
          {
            "type": "command",
            "command": "$AGGRESSIVE_HOOK",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
HOOKEOF
)

if [[ -f "$SETTINGS_FILE" ]]; then
  # Merge settings: combine permissions (deduplicated), merge hooks per event type.
  # Removes existing sidechat hooks (matched by .sidechat/hooks/ in command path),
  # then appends the new sidechat hooks. Preserves all non-sidechat hooks.
  jq '
    . as $existing | input as $new |
    # Filter sidechat commands from inner hooks arrays, drop entries with no commands left
    ($existing.hooks // {} | to_entries | map(
      .value |= [.[] |
        .hooks |= [.[] | select(.command // "" | contains(".sidechat/hooks/") | not)] |
        select(.hooks | length > 0)
      ]
    ) | from_entries) as $cleaned |
    # Concatenate cleaned + new per event type
    ([$cleaned, ($new.hooks // {})] | map(to_entries) | add | group_by(.key) | map(
      {key: .[0].key, value: (map(.value) | add)}
    ) | from_entries) as $merged |
    (($existing.permissions.allow // []) + ($new.permissions.allow // []) | unique) as $perms |
    $existing | .permissions.allow = $perms | .hooks = $merged
  ' "$SETTINGS_FILE" <(echo "$HOOKS_JSON") > "$SETTINGS_FILE.tmp" && mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
  echo "  settings updated in $SETTINGS_FILE (hooks merged, non-sidechat hooks preserved)"
else
  echo "$HOOKS_JSON" | jq . > "$SETTINGS_FILE"
  echo "  $SETTINGS_FILE created with hooks and permissions"
fi

# --- Systemd service for webhook listener ---

WEBHOOK_SERVICE="/etc/systemd/system/sidechat-webhook.service"
WEBHOOK_SERVER_PATH="$(pwd)/$SCRIPT_DIR/sc-webhook-server.py"

# Kill any old manually-launched webhook listener holding the port
if [[ -f "$SCRIPT_DIR/.webhook-listener.pid" ]]; then
  OLD_PID=$(cat "$SCRIPT_DIR/.webhook-listener.pid")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null
    echo "  killed old webhook listener (PID $OLD_PID)"
  fi
  rm -f "$SCRIPT_DIR/.webhook-listener.pid"
fi
if command -v fuser &>/dev/null; then
  fuser -k 7777/tcp 2>/dev/null && echo "  killed process on port 7777" || true
fi

if command -v systemctl &>/dev/null; then
  SERVICE_CONTENT="[Unit]
Description=SideChat Webhook Listener
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$(pwd)
ExecStart=/usr/bin/python3 $WEBHOOK_SERVER_PATH
Restart=on-failure
RestartSec=10
Environment=HOME=$HOME

[Install]
WantedBy=multi-user.target"

  NEED_INSTALL=false
  if [[ ! -f "$WEBHOOK_SERVICE" ]]; then
    NEED_INSTALL=true
  elif ! diff -q <(echo "$SERVICE_CONTENT") "$WEBHOOK_SERVICE" &>/dev/null; then
    NEED_INSTALL=true
  fi

  if [[ "$NEED_INSTALL" == "true" ]]; then
    if [[ "$(id -u)" == "0" ]] || sudo -n true 2>/dev/null; then
      echo "$SERVICE_CONTENT" | sudo tee "$WEBHOOK_SERVICE" > /dev/null
      sudo systemctl daemon-reload
      sudo systemctl enable --now sidechat-webhook.service
      echo "  sidechat-webhook.service installed and started"
    else
      echo "  NOTE: webhook systemd service requires sudo to install."
      echo "  Run manually:"
      echo "    sudo tee $WEBHOOK_SERVICE << 'EOF'"
      echo "$SERVICE_CONTENT"
      echo "EOF"
      echo "    sudo systemctl daemon-reload && sudo systemctl enable --now sidechat-webhook.service"
    fi
  else
    echo "  sidechat-webhook.service already up to date"
  fi
fi

# --- Done ---

# Helper: register/refresh MCP when we have an approved + authenticated
# client and `claude` CLI is available. Skipped cleanly if claude isn't on
# PATH (the shell-only install still works; user can run install-mcp.sh
# later when they install Claude Code).
register_mcp_if_ready() {
  if ! command -v claude &>/dev/null; then
    echo ""
    echo "Note: \`claude\` CLI not found on PATH — skipping MCP registration."
    echo "  Install Claude Code, then run: .sidechat/install-mcp.sh --apply"
    return 0
  fi
  if [[ ! -x "$SCRIPT_DIR/install-mcp.sh" ]]; then
    echo "Note: install-mcp.sh missing from $SCRIPT_DIR — skipping MCP registration."
    return 0
  fi
  echo ""
  echo "Registering MCP server with Claude Code..."
  SIDECHAT_DIR="$SCRIPT_DIR" "$SCRIPT_DIR/install-mcp.sh" --apply --name sidechat \
    || echo "  (MCP registration returned non-zero — run .sidechat/install-mcp.sh --apply manually to retry)"
}

echo ""
if [[ "$FRESH_INSTALL" == "true" && "$FORCE" == "true" ]]; then
  echo "=== SideChat re-installed (--force) ==="
  echo "Fingerprint: ${FINGERPRINT:0:16}..."
  echo "Authenticating..."
  "$SCRIPT_DIR/sc-auth.sh"
  register_mcp_if_ready
elif [[ "$FRESH_INSTALL" == "true" ]]; then
  echo "=== Registration submitted ==="
  echo "Fingerprint: ${FINGERPRINT:0:16}..."
  echo ""
  echo "Awaiting admin approval. Once approved, run:"
  echo "  .sidechat/sc-auth.sh               # mint session token"
  echo "  .sidechat/install-mcp.sh --apply   # register the MCP server"
  echo ""
  echo "After authentication:"
  echo "  Post:    .sidechat/sc-post.sh \"message\""
  echo "  Poll:    .sidechat/sc-poll.sh"
  echo "  Start:   /start  (in Claude Code — launches monitors)"
else
  echo "=== SideChat updated ==="
  echo "Scripts, hooks, and CLAUDE.md refreshed. Config and token preserved."
  register_mcp_if_ready
fi
