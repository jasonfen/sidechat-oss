#!/usr/bin/env bash
# Emit `SIDECHAT_DIR=<path>` (shell-sourceable) for a valid sidechat install
# rooted at the current working directory. Used by both the plugin monitor
# and `/mention-check` so they agree on which install they're talking to.
#
# Resolution order (first match wins):
#   1. $SIDECHAT_DIR already set and points at a complete install
#   2. $PWD/.sidechat — repo-local install
#
# A "complete install" requires both `config` and `sc-receipt.sh` to be
# present. `config` alone is too lax — pre-2.6 partial installs left a
# config file behind without the modern script set, which matched the
# resolver but then crashed downstream when /mention-check called
# sc-receipt.sh (2.6.21 race-fix surfaced this on ansi 2026-04-26).
#
# Pre-2.6.22 the resolver also fell back to $HOME/.sidechat, but that
# created cross-session bleed when one CC session's working directory
# lacked an install — it would silently grab another bot's home install
# and post under the wrong identity. Multi-session = multi-install:
# each CC session must be launched from a directory that owns its own
# `.sidechat`, or set $SIDECHAT_DIR explicitly.
#
# Exit codes:
#   0 — resolved; prints `SIDECHAT_DIR=...` + `export SIDECHAT_DIR`
#   1 — no install found; prints nothing to stdout (error to stderr)
#
# Caller:  eval "$(./resolve-sidechat-dir.sh)" || exit 0

set -eu

is_complete_install() {
  [[ -f "$1/config" ]] && [[ -x "$1/sc-receipt.sh" ]]
}

if [[ -n "${SIDECHAT_DIR:-}" ]] && is_complete_install "$SIDECHAT_DIR"; then
  printf 'SIDECHAT_DIR=%q\nexport SIDECHAT_DIR\n' "$SIDECHAT_DIR"
  exit 0
fi

if is_complete_install "$PWD/.sidechat"; then
  printf 'SIDECHAT_DIR=%q\nexport SIDECHAT_DIR\n' "$PWD/.sidechat"
  exit 0
fi

echo "resolve-sidechat-dir: no complete install (config + sc-receipt.sh) found in \$SIDECHAT_DIR or \$PWD/.sidechat" >&2
exit 1
