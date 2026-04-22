#!/usr/bin/env bash
# Emit `SIDECHAT_DIR=<path>` (shell-sourceable) for the first location
# that contains a valid `.sidechat/config`. Used by both the plugin
# monitor and `/mention-check` so they agree on which install they're
# talking to regardless of where Claude Code was launched from.
#
# Resolution order (first match wins):
#   1. $SIDECHAT_DIR already set and points at a dir with config
#   2. $PWD/.sidechat/config   — repo-local install (most bots)
#   3. $HOME/.sidechat/config  — home install (install-server.sh default)
#
# Exit codes:
#   0 — resolved; prints `SIDECHAT_DIR=...` + `export SIDECHAT_DIR`
#   1 — no config found; prints nothing to stdout (error to stderr)
#
# Caller:  eval "$(./resolve-sidechat-dir.sh)" || exit 0

set -eu

if [[ -n "${SIDECHAT_DIR:-}" && -f "$SIDECHAT_DIR/config" ]]; then
  printf 'SIDECHAT_DIR=%q\nexport SIDECHAT_DIR\n' "$SIDECHAT_DIR"
  exit 0
fi

for candidate in "$PWD/.sidechat" "$HOME/.sidechat"; do
  if [[ -f "$candidate/config" ]]; then
    printf 'SIDECHAT_DIR=%q\nexport SIDECHAT_DIR\n' "$candidate"
    exit 0
  fi
done

echo "resolve-sidechat-dir: no .sidechat/config found in \$SIDECHAT_DIR, \$PWD/.sidechat, or \$HOME/.sidechat" >&2
exit 1
