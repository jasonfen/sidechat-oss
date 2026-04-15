#!/usr/bin/env bash
# Update SideChat client scripts from the server.
# Pulls latest versions of all scripts, hooks, and commands without
# re-registering or modifying config/credentials.
#
# Usage:
#   .sidechat/sc-update.sh
#   .sidechat/sc-update.sh --restart   # also restart webhook service

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config"

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

RESTART=false
[[ "${1:-}" == "--restart" ]] && RESTART=true

echo "=== SideChat Update ==="
echo "Server: $SERVER_URL"
echo ""

# Update scripts
echo "Updating scripts..."
for script in sc-post.sh sc-poll.sh sc-notify.sh sc-auth.sh sc-listen.sh sc-mention-watcher.sh sc-cleanup.sh sc-webhook-listener.sh sc-webhook-register.sh sc-webhook-server.py sc-update.sh sc-receipt.sh; do
  if curl -fsSL "$SERVER_URL/install/$script" -o "$SCRIPT_DIR/$script.new" 2>/dev/null; then
    mv "$SCRIPT_DIR/$script.new" "$SCRIPT_DIR/$script"
    chmod +x "$SCRIPT_DIR/$script"
    echo "  $script"
  else
    rm -f "$SCRIPT_DIR/$script.new"
    echo "  $script (not available, skipped)"
  fi
done

# Update hooks
echo "Updating hooks..."
mkdir -p "$SCRIPT_DIR/hooks"
for hook in post-push.sh post-message.sh on-new-mentions.sh; do
  if curl -fsSL "$SERVER_URL/install/hooks/$hook" -o "$SCRIPT_DIR/hooks/$hook.new" 2>/dev/null; then
    mv "$SCRIPT_DIR/hooks/$hook.new" "$SCRIPT_DIR/hooks/$hook"
    chmod +x "$SCRIPT_DIR/hooks/$hook"
    echo "  hooks/$hook"
  else
    rm -f "$SCRIPT_DIR/hooks/$hook.new"
  fi
done

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

# Restart webhook service if requested or if sc-webhook-server.py was updated
if [[ "$RESTART" == "true" ]] && systemctl is-active sidechat-webhook.service &>/dev/null; then
  sudo systemctl restart sidechat-webhook.service 2>/dev/null && \
    echo "Restarted sidechat-webhook.service" || true
fi

echo ""
echo "=== Update complete ==="
echo "Config and credentials unchanged."
