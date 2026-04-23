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
for script in sc-post.sh sc-poll.sh sc-notify.sh sc-auth.sh sc-listen.sh sc-cleanup.sh sc-webhook-listener.sh sc-webhook-register.sh sc-webhook-server.py sc-update.sh sc-receipt.sh install-mcp.sh resolve-sidechat-dir.sh; do
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
for hook in post-push.sh post-message.sh on-new-mentions.sh sessionstart-poll.sh stop-poll.sh; do
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
  STOP_HOOK="$SCRIPT_DIR/hooks/stop-poll.sh"
  CANONICAL=$(cat <<CANON
{
  "hooks": {
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "$SESSIONSTART_HOOK", "timeout": 10}]}
    ],
    "Stop": [
      {"hooks": [{"type": "command", "command": "$STOP_HOOK", "timeout": 10}]}
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

# Refresh the ## SideChat block inside the bot's CLAUDE.md. Pre-2.6.10 this
# only happened at client.sh install time; existing bots stayed frozen at
# whatever block shipped with their initial install. Now /install/claude-md-block
# is the single source of truth and sc-update keeps the local copy in sync.
# Strip regex and append order match client.sh so legacy blocks get cleanly
# replaced; foreign CLAUDE.md content (non-SideChat) stays untouched.
CLAUDE_MD="$(dirname "$SCRIPT_DIR")/CLAUDE.md"
if CLAUDE_BLOCK=$(curl -fsSL "$SERVER_URL/install/claude-md-block" 2>/dev/null); then
  CLAUDE_BLOCK="${CLAUDE_BLOCK//\$SERVER_URL/$SERVER_URL}"
  # Only rewrite if the block actually differs — keeps noise out of the
  # sc-update output on steady state.
  NEW_HASH=$(printf '%s' "$CLAUDE_BLOCK" | sha256sum | awk '{print $1}')
  CURRENT_BLOCK=""
  if [[ -f "$CLAUDE_MD" ]] && grep -q "^## SideChat" "$CLAUDE_MD"; then
    CURRENT_BLOCK=$(awk '/^## SideChat/,/^Do not manually post/' "$CLAUDE_MD")
  fi
  CURRENT_HASH=$(printf '%s' "$CURRENT_BLOCK" | sha256sum | awk '{print $1}')
  if [[ "$NEW_HASH" != "$CURRENT_HASH" ]]; then
    echo "Refreshing CLAUDE.md SideChat block..."
    if [[ -f "$CLAUDE_MD" ]] && grep -q "^## SideChat" "$CLAUDE_MD"; then
      sed '/^## SideChat/,/^Do not manually post/d' "$CLAUDE_MD" > "$CLAUDE_MD.tmp" && mv "$CLAUDE_MD.tmp" "$CLAUDE_MD"
      sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$CLAUDE_MD" > "$CLAUDE_MD.tmp" && mv "$CLAUDE_MD.tmp" "$CLAUDE_MD"
    fi
    printf '\n%s\n' "$CLAUDE_BLOCK" >> "$CLAUDE_MD"
    echo "  CLAUDE.md SideChat block updated"
  fi
fi

# Record the server's current build SHA for client-version tracking
if SERVER_VER=$(curl -fsSL "$SERVER_URL/install/version" 2>/dev/null); then
  echo "${SERVER_VER}" | tr -d '\r\n' > "$SCRIPT_DIR/sc-version.txt"
  echo "Recorded version: $(cat "$SCRIPT_DIR/sc-version.txt")"
  rm -f "$SCRIPT_DIR/update-available"
fi

# MCP client binary drift probe. sc-update.sh syncs install-mcp.sh to disk but
# doesn't run it; the registered MCP subprocess stays pinned to whatever
# version the operator last installed. Pre-2.6.9 that gap went unnoticed
# because /mention-check never reached for the MCP tool surface. Now: compare
# the version embedded in ~/.claude.json's sidechat-mcp command path against
# the server's expected_client_build_sha and refresh on drift. The running CC
# session still holds the old subprocess in memory; user must restart CC to
# see the new tool surface.
if command -v jq &>/dev/null && [[ -f "$HOME/.claude.json" ]] && [[ -x "$SCRIPT_DIR/install-mcp.sh" ]]; then
  CURRENT_MCP_CMD=$(jq -r '.mcpServers.sidechat.command // empty' "$HOME/.claude.json" 2>/dev/null)
  if [[ -n "$CURRENT_MCP_CMD" ]]; then
    # Binary filename ends in -v<VERSION>; legacy/dev paths without that
    # suffix are treated as drift so the next run lands on a versioned binary.
    CURRENT_MCP_VER=$(basename "$CURRENT_MCP_CMD" | sed -n 's/.*-v\([0-9][0-9.]*\)$/\1/p')
    SERVER_EXPECTS=$(curl -fsS --max-time 3 "$SERVER_URL/install/mcp-version" 2>/dev/null \
      | jq -r '.expected_client_build_sha // empty' 2>/dev/null)
    if [[ -n "$SERVER_EXPECTS" && "$CURRENT_MCP_VER" != "$SERVER_EXPECTS" ]]; then
      echo "MCP drift: registered=v${CURRENT_MCP_VER:-<none>}, server expects=v$SERVER_EXPECTS. Refreshing..."
      if SIDECHAT_DIR="$SCRIPT_DIR" bash "$SCRIPT_DIR/install-mcp.sh" --apply >/dev/null 2>&1; then
        echo "  ⚠ MCP binary updated to v$SERVER_EXPECTS. Restart your Claude Code session to pick up the new tool surface (the running process still holds the old MCP subprocess)."
      else
        echo "  MCP refresh failed (run install-mcp.sh --apply manually)."
      fi
    fi
  fi
fi

# sidechat-monitor plugin refresh. Asks CC for the latest version from the
# sidechat-oss marketplace. Quiet no-op when plugin is absent (operator hasn't
# run install-mcp.sh --apply on 2.6.11+ yet) or already up to date. Running
# CC session still holds the old plugin state; `/reload-plugins` (or restart)
# activates the update.
if command -v claude &>/dev/null; then
  if claude plugin list 2>/dev/null | grep -q "sidechat-monitor@sidechat-oss"; then
    # marketplace update pulls the latest manifest, then plugin update installs
    # if there's a newer version. Both are cheap when steady-state.
    claude plugin marketplace update sidechat-oss >/dev/null 2>&1 || true
    if claude plugin update sidechat-monitor@sidechat-oss 2>&1 | grep -qE "Successfully updated|Updated|already up to date"; then
      # Only print the reload hint when the update actually changed something.
      # Otherwise this line would fire on every sc-update run.
      if claude plugin update sidechat-monitor@sidechat-oss 2>&1 | grep -qvE "already up to date"; then
        echo "  ⚠ sidechat-monitor plugin updated. Run /reload-plugins in your Claude Code session (or restart) to activate."
      fi
    fi
  fi
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
