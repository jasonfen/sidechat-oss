#!/usr/bin/env bash
# Update SideChat client scripts from the server.
# Pulls latest versions of all scripts, hooks, and commands without
# re-registering or modifying config/credentials.
#
# Behavior:
#  - If sc-update.sh itself changes during a run, re-execs the new copy once
#    with --no-self-update so subsequent script-list additions take effect on
#    the same invocation.
#  - Always restarts the webhook listener at the end so a new
#    sc-webhook-server.py takes effect (the long-lived python process doesn't
#    pick up disk changes on its own).
#  - Records the server's current build SHA in sc-version.txt for future
#    auth-token requests (see sc-auth.sh) and update-available checks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"
SELF="${BASH_SOURCE[0]}"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: config not found at $CONFIG" >&2
  echo "Run client.sh first to register." >&2
  exit 1
fi

source "$CONFIG"

if [[ -z "${SERVER_URL:-}" ]]; then
  echo "ERROR: SERVER_URL not set in config" >&2
  exit 1
fi

NO_SELF_UPDATE=false
[[ "${1:-}" == "--no-self-update" ]] && NO_SELF_UPDATE=true

echo "=== SideChat Update ==="
echo "Server: $SERVER_URL"
echo ""

# Snapshot self for self-update detection
SELF_HASH_BEFORE=""
[[ -f "$SCRIPT_DIR/sc-update.sh" ]] && SELF_HASH_BEFORE=$(sha256sum "$SCRIPT_DIR/sc-update.sh" | awk '{print $1}')

# Update scripts
echo "Updating scripts..."
for script in sc-post.sh sc-poll.sh sc-notify.sh sc-auth.sh sc-listen.sh sc-mention-watcher.sh sc-cleanup.sh sc-webhook-listener.sh sc-webhook-register.sh sc-webhook-server.py sc-update.sh sc-receipt.sh install-mcp.sh; do
  if curl -fsSL "$SERVER_URL/install/$script" -o "$SCRIPT_DIR/$script.new" 2>/dev/null; then
    mv "$SCRIPT_DIR/$script.new" "$SCRIPT_DIR/$script"
    chmod +x "$SCRIPT_DIR/$script"
    echo "  $script"
  else
    rm -f "$SCRIPT_DIR/$script.new"
    echo "  $script (not available, skipped)"
  fi
done

# If sc-update.sh changed and we haven't already re-exec'd, hand off to the new copy
SELF_HASH_AFTER=$(sha256sum "$SCRIPT_DIR/sc-update.sh" | awk '{print $1}')
if [[ "$NO_SELF_UPDATE" == "false" && "$SELF_HASH_BEFORE" != "$SELF_HASH_AFTER" ]]; then
  echo ""
  echo "sc-update.sh itself changed — re-exec'ing new copy to apply new behavior..."
  exec "$SCRIPT_DIR/sc-update.sh" --no-self-update
fi

# Update hooks
echo "Updating hooks..."
mkdir -p "$SCRIPT_DIR/hooks"
for hook in post-push.sh post-message.sh on-new-mentions.sh sessionstart-poll.sh; do
  if curl -fsSL "$SERVER_URL/install/hooks/$hook" -o "$SCRIPT_DIR/hooks/$hook.new" 2>/dev/null; then
    mv "$SCRIPT_DIR/hooks/$hook.new" "$SCRIPT_DIR/hooks/$hook"
    chmod +x "$SCRIPT_DIR/hooks/$hook"
    echo "  hooks/$hook"
  else
    rm -f "$SCRIPT_DIR/hooks/$hook.new"
  fi
done

# Re-merge canonical sidechat hooks into .claude/settings.local.json so any
# newly-shipped hooks (e.g. sessionstart-poll.sh) get wired up on update,
# not just on fresh client.sh install. Idempotent: strips any existing
# sidechat hook entries (matched by `.sidechat/hooks/` command path) then
# re-appends the canonical set. Foreign hooks untouched. Skipped cleanly
# if jq is missing or settings.local.json doesn't exist (sc-update.sh
# shouldn't create a settings file the bot doesn't already have).
SETTINGS_FILE="$(dirname "$SCRIPT_DIR")/.claude/settings.local.json"
if [[ -f "$SETTINGS_FILE" ]] && command -v jq &>/dev/null; then
  echo "Re-merging sidechat hooks into $SETTINGS_FILE..."
  PUSH_HOOK="$SCRIPT_DIR/hooks/post-push.sh"
  MSG_HOOK="$SCRIPT_DIR/hooks/post-message.sh"
  MENTION_HOOK="$SCRIPT_DIR/hooks/on-new-mentions.sh"
  SESSIONSTART_HOOK="$SCRIPT_DIR/hooks/sessionstart-poll.sh"
  CANONICAL=$(cat <<CANON
{
  "hooks": {
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "$SESSIONSTART_HOOK", "timeout": 10}]}
    ],
    "FileChanged": [
      {"matcher": ".sidechat/new-mentions.txt",
       "hooks": [{"type": "command", "command": "$MENTION_HOOK", "timeout": 5}]}
    ],
    "PostToolUse": [
      {"matcher": "Bash",
       "hooks": [{"type": "command", "command": "$PUSH_HOOK", "timeout": 10}]},
      {"matcher": "Write",
       "hooks": [{"type": "command", "command": "$MSG_HOOK", "timeout": 10}]}
    ]
  }
}
CANON
  )
  jq '
    . as $existing | input as $new |
    ($existing.hooks // {} | to_entries | map(
      .value |= [.[] |
        .hooks |= [.[] | select(.command // "" | contains(".sidechat/hooks/") | not)] |
        select(.hooks | length > 0)
      ]
    ) | from_entries) as $cleaned |
    ([$cleaned, ($new.hooks // {})] | map(to_entries) | add | group_by(.key) | map(
      {key: .[0].key, value: (map(.value) | add)}
    ) | from_entries) as $merged |
    $existing | .hooks = $merged
  ' "$SETTINGS_FILE" <(echo "$CANONICAL") > "$SETTINGS_FILE.tmp" \
    && mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE" \
    && echo "  hooks merged (non-sidechat hooks preserved)" \
    || { echo "  merge failed (settings.local.json unchanged)"; rm -f "$SETTINGS_FILE.tmp"; }
fi

# Update commands
echo "Updating commands..."
COMMANDS_DIR="$(dirname "$SCRIPT_DIR")/.claude/commands"
mkdir -p "$COMMANDS_DIR"
for cmd in start.md mention-check.md; do
  if curl -fsSL "$SERVER_URL/install/commands/$cmd" -o "$COMMANDS_DIR/$cmd.new" 2>/dev/null; then
    mv "$COMMANDS_DIR/$cmd.new" "$COMMANDS_DIR/$cmd"
    echo "  $cmd"
  else
    rm -f "$COMMANDS_DIR/$cmd.new"
  fi
done

# Record the server's current build SHA for client-version tracking
if SERVER_VER=$(curl -fsSL "$SERVER_URL/install/version" 2>/dev/null); then
  echo "${SERVER_VER}" | tr -d '\r\n' > "$SCRIPT_DIR/sc-version.txt"
  echo "Recorded version: $(cat "$SCRIPT_DIR/sc-version.txt")"
  rm -f "$SCRIPT_DIR/update-available"
fi

# Re-auth + restart in one step if we already have a token. sc-auth.sh handles
# the listener restart itself (so the new code AND new token take effect on a
# single bounce). For never-authed clients, restart the listener directly so
# they don't lose the new sc-webhook-server.py code.
if [[ -n "${TOKEN:-}" ]] && [[ -x "$SCRIPT_DIR/sc-auth.sh" ]]; then
  echo "Re-authenticating to publish version + restart listener..."
  "$SCRIPT_DIR/sc-auth.sh" >/dev/null 2>&1 && echo "  done" || echo "  sc-auth failed (run manually)"
else
  # Systemd first — pgrep matches the systemd process too, so user-fork
  # would race against the systemd auto-restart for :7777.
  if systemctl is-active sidechat-webhook.service &>/dev/null; then
    echo "Restarting sidechat-webhook.service..."
    sudo systemctl restart sidechat-webhook.service 2>/dev/null || true
  elif pgrep -f sc-webhook-server.py >/dev/null 2>&1; then
    echo "Restarting webhook listener..."
    pkill -f sc-webhook-server.py 2>/dev/null || true
    sleep 1
    rm -f "$SCRIPT_DIR/.webhook-listener.pid"
    "$SCRIPT_DIR/sc-webhook-listener.sh" >/dev/null 2>&1 || true
  fi
fi

echo ""
echo "=== Update complete ==="
echo "Config and credentials unchanged."
