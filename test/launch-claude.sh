#!/bin/bash
# launch-claude.sh: resume when a conversation exists, fall back to a fresh one
# when --continue exits 1 at once, pass options through, prompt stays positional.
# Stub claude, no network. Run: bash test/launch-claude.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/.sidechat"; cp "$REPO/install/launch-claude.sh" "$T/.sidechat/"
cat > "$T/claude" <<'STUB'
#!/bin/bash
echo "$PWD|$*" >> "$STUB_LOG"
if [[ " $* " == *" --continue "* && ! -f "$STUB_CONVO" ]]; then exit 1; fi
exit "${STUB_RC:-0}"
STUB
chmod +x "$T/claude"
export CLAUDE_BIN="$T/claude" STUB_LOG="$T/log" STUB_CONVO="$T/convo"
fail() { echo "FAIL: $*"; exit 1; }
run() { : > "$STUB_LOG"; bash "$T/.sidechat/launch-claude.sh" "$@"; }

# no conversation yet: --continue fails, second call starts fresh; both end with -- <prompt>
run --permission-mode bypassPermissions; rc=$?
[[ $rc == 0 ]] || fail "rc $rc after fallback"
[[ $(wc -l < "$STUB_LOG") == 2 ]] || fail "expected 2 claude calls, got $(wc -l < "$STUB_LOG")"
sed -n 1p "$STUB_LOG" | grep -q -- "--continue --permission-mode bypassPermissions -- (session start" || fail "first call shape: $(sed -n 1p "$STUB_LOG")"
sed -n 2p "$STUB_LOG" | grep -q -- "|--permission-mode bypassPermissions -- (session start" || fail "fresh call shape: $(sed -n 2p "$STUB_LOG")"
sed -n 2p "$STUB_LOG" | grep -q -- "--continue" && fail "fresh call still has --continue"

# runs from the project root (parent of .sidechat), wherever it was launched from
(cd / && run); grep -q "^$T|" "$STUB_LOG" || fail "did not cd to project root"

# conversation exists: one call, a real exit code passes through, no retry
touch "$STUB_CONVO"; STUB_RC=3 run --allowedTools Bash Monitor; rc=$?
[[ $rc == 3 ]] || fail "rc $rc, wanted 3 passed through"
[[ $(wc -l < "$STUB_LOG") == 1 ]] || fail "retried after a normal exit"
grep -q -- "--continue --allowedTools Bash Monitor -- (session start" "$STUB_LOG" || fail "variadic option not followed by --: $(cat "$STUB_LOG")"

# custom prompt
SIDECHAT_ARM_PROMPT="arm now" run; grep -q -- "-- arm now" "$STUB_LOG" || fail "SIDECHAT_ARM_PROMPT ignored"
echo "OK"
