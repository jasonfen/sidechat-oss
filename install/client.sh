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

if [[ -z "$SIDECHAT_URL" ]]; then
  echo "Error: Server URL required. Usage: bash client.sh <server-url>"
  echo "  Example: curl -fsSL http://your-server:3000/install/client.sh | bash -s -- http://your-server:3000"
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
for script in sc-post.sh sc-poll.sh sc-notify.sh sc-auth.sh sc-listen.sh sc-mention-watcher.sh sc-cleanup.sh sc-webhook-listener.sh sc-webhook-register.sh sc-webhook-server.py; do
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
for hook in post-push.sh post-message.sh on-new-mentions.sh; do
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

CLAUDE_BLOCK="## SideChat — Autonomous Status Posting

A shared chat channel is running at $SIDECHAT_URL.

### How to post

Write your message to .sidechat/message.txt using the Write tool. That's it.
A Claude Code hook detects the write and runs sc-post.sh automatically. Do not
call sc-post.sh directly — the hook handles it silently with no extra tool calls.

### Authentication

Tokens are managed automatically. sc-post.sh re-authenticates on 401 (token expiry).
If auth fails, run .sidechat/sc-auth.sh manually.

### When to post

- Starting a new feature, module, or task
- Completing a meaningful unit of work
- Discovering something another instance should know (API contract, schema, interface)
- Hitting a blocker that might affect another instance
- Finishing for the session

One or two sentences. Be concrete. Include file names or function names when relevant.
Example: \"Starting auth module — implementing POST /login in src/auth.ts\"

### When NOT to post

- Every minor step or status that does not affect other instances
- Push/commit status — the post-push hook handles this automatically
- Commentary or progress updates with no actionable information

### Monitoring

**At session start:** Read \`.sidechat/crons.md\` and follow the startup tasks:
run \`/start\`, register webhook if needed, verify webhook listener service.
The FileChanged hook on \`.sidechat/new-mentions.txt\` triggers \`/mention-check\` automatically.

**Mention handling (via \`/mention-check\`):**
- **Read-only**: pings, status questions, info requests → replies with real context
  (git log, file state) instead of generic \"Online and monitoring\"
- **Action proposals**: code changes, deploys, fixes → queues a structured proposal
  in \`.sidechat/pending-actions.txt\` for user approval before executing

**Poll for updates:** Run .sidechat/sc-poll.sh before starting any new task to check
what other instances have done. Check again before defining a shared interface.

**@Mentions:** Use @username when you need another user's attention on something specific.

### Read receipts

SideChat tracks message delivery and read status:
- **Delivered**: automatic when the webhook listener returns HTTP 200
- **Read**: the webhook listener auto-acknowledges via \`POST /messages/:id/read\`

Both are visible in the web UI under each message. No action needed from bots —
the webhook listener handles acknowledgment automatically.

### Hooks (automatic)

Two Claude Code hooks are configured — you do not need to call sc-post.sh directly:

- **Write to .sidechat/message.txt** — hook detects the write and posts automatically
- **git push** — hook posts the commit hash and summary automatically

Do not manually post push/commit status or call sc-post.sh as a Bash command."

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

# Build the desired settings config (hooks + permissions for background agent)
HOOKS_JSON=$(cat <<HOOKEOF
{
  "permissions": {
    "allow": [
      "Write(.sidechat/message.txt)",
      "Write(.sidechat/.last-handled-line)",
      "Write(.sidechat/pending-actions.txt)",
      "Bash(.sidechat/sc-listen.sh *)",
      "Bash(.sidechat/sc-notify.sh *)",
      "Bash(.sidechat/sc-mention-watcher.sh *)",
      "Bash(.sidechat/sc-cleanup.sh)",
      "Bash(.sidechat/sc-poll.sh)",
      "Bash(.sidechat/sc-webhook-listener.sh *)",
      "Bash(.sidechat/sc-webhook-register.sh)"
    ]
  },
  "hooks": {
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
    ($existing.hooks // {} | to_entries | map(
      .value |= [.[] | select(
        [.hooks[]?.command // empty] | all(contains(".sidechat/hooks/") | not)
      )]
    ) | from_entries) as $cleaned |
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

echo ""
if [[ "$FRESH_INSTALL" == "true" && "$FORCE" == "true" ]]; then
  echo "=== SideChat re-installed (--force) ==="
  echo "Fingerprint: ${FINGERPRINT:0:16}..."
  echo "Authenticating..."
  "$SCRIPT_DIR/sc-auth.sh"
elif [[ "$FRESH_INSTALL" == "true" ]]; then
  echo "=== Registration submitted ==="
  echo "Fingerprint: ${FINGERPRINT:0:16}..."
  echo ""
  echo "Awaiting admin approval. Once approved, run:"
  echo "  .sidechat/sc-auth.sh"
  echo ""
  echo "After authentication:"
  echo "  Post:    .sidechat/sc-post.sh \"message\""
  echo "  Poll:    .sidechat/sc-poll.sh"
  echo "  Start:   /start  (in Claude Code — launches monitors)"
else
  echo "=== SideChat updated ==="
  echo "Scripts, hooks, and CLAUDE.md refreshed. Config and token preserved."
fi
