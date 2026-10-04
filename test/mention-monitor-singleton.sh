#!/bin/bash
# Poller + guard check: singleton, orphan exit, self-reload, STILL-PENDING,
# stop-poll lock probe. Stub curl, no network. Run: bash test/mention-monitor-singleton.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'pkill -f "$T/" 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/hooks" "$T/bin"
cp "$REPO/install/sidechat-mention-monitor.sh" "$T/"; cp "$REPO/install/hooks/stop-poll.sh" "$T/hooks/"
printf 'TOKEN=t\nSERVER_URL=http://stub\n' > "$T/config"; echo 1.0.0 > "$T/sc-version.txt"
printf '#!/bin/bash\ncat >/dev/null\n' > "$T/download-attachments.sh"; chmod +x "$T/download-attachments.sh"
cat > "$T/bin/curl" <<'STUB'
#!/bin/bash
case "$*" in
  *pending-mentions*) cat "$STUB_JSON" ;;
  *install/version*) echo 1.0.0 ;;
esac
STUB
chmod +x "$T/bin/curl"
export PATH="$T/bin:$PATH" STUB_JSON="$T/pending.json" SIDECHAT_MONITOR_INTERVAL=1
echo '{"count":0,"messages":[]}' > "$STUB_JSON"
fail() { echo "FAIL: $*"; exit 1; }
count() { grep -c "$1" "$2" || true; }

# singleton: a second arm says ALREADY-RUNNING, the first keeps running
bash "$T/sidechat-mention-monitor.sh" > "$T/out" 2>&1 & P=$!
sleep 1
[[ "$(timeout 5 bash "$T/sidechat-mention-monitor.sh")" == ALREADY-RUNNING* ]] || fail "second arm silent"
kill -0 $P || fail "first poller died"
# stop-poll is silent while the poller holds the lock
[[ -z "$(bash "$T/hooks/stop-poll.sh")" ]] || fail "stop-poll not silent with lock held"

# MENTION once, STILL-PENDING once (old id pre-seeded as seen), none for the fresh id
kill $P; wait $P 2>/dev/null
cat > "$STUB_JSON" <<'J'
{"count":2,"server_now":"2026-10-04T17:00:00.000Z","messages":[
 {"id":1,"sender":"bob","content":"fresh","timestamp":"2026-10-04T17:00:00.000Z"},
 {"id":2,"sender":"amy","content":"old","timestamp":"2026-10-04T16:40:00.000Z"}]}
J
echo 2 > "$T/.mention-monitor-seen"
bash "$T/sidechat-mention-monitor.sh" > "$T/out" 2>&1 & P=$!
sleep 4
[[ $(count '^MENTION 1 from bob' "$T/out") == 1 ]] || fail "MENTION 1 not exactly once"
[[ $(count '^STILL-PENDING 2 from amy' "$T/out") == 1 ]] || fail "STILL-PENDING 2 not exactly once"
[[ $(count 'STILL-PENDING 1' "$T/out") == 0 && $(count '^MENTION 2' "$T/out") == 0 ]] || fail "stray announcement"

# self-reload: same pid survives a file rewrite
echo "# touched" >> "$T/sidechat-mention-monitor.sh"
sleep 3
grep -q '^MONITOR-RELOADED' "$T/out" || fail "no MONITOR-RELOADED"
kill -0 $P || fail "pid changed on reload"
kill $P; wait $P 2>/dev/null

# orphan: poller whose parent shell exits must exit itself within a few cycles
rm -f "$T/.mention-monitor-seen"; echo '{"count":0,"messages":[]}' > "$STUB_JSON"
bash -c 'bash "$0" >/dev/null 2>&1 & echo $! > "$1"; sleep 0.3' "$T/sidechat-mention-monitor.sh" "$T/pid"
sleep 4
kill -0 "$(cat "$T/pid")" 2>/dev/null && fail "orphan still alive"

# lock free + pending mention: stop-poll blocks the turn
echo '{"count":1,"messages":[{"id":3,"sender":"bob","content":"hi","timestamp":"2026-10-04T17:00:00.000Z"}]}' > "$STUB_JSON"
bash "$T/hooks/stop-poll.sh" | grep -q '"decision": "block"' || fail "stop-poll did not block with lock free"
echo "OK"
