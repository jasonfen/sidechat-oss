#!/bin/bash
# Poller + guard check: singleton, channel guard, orphan exit, self-reload, STILL-PENDING,
# stop-poll lock probe. Stub curl, no network. Run: bash test/mention-monitor-singleton.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'pkill -f "$T/" 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/hooks" "$T/bin"
cp "$REPO/install/sidechat-mention-monitor.sh" "$REPO/install/channel-active.sh" "$T/"; cp "$REPO/install/hooks/stop-poll.sh" "$REPO/install/hooks/sessionstart-autoarm-monitor.sh" "$T/hooks/"
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
# this test may itself run under a real claude: only the stub below counts as the owner
export SIDECHAT_OWNER_COMM=stubowner
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
# owner guard: poller under a bash -c wrapper under the owner process. Kill
# the owner; the wrapper survives (reparented to init), so a bare $PPID check would
# keep polling. The poller must still exit.
rm -f "$T/.mention-monitor-seen"; echo '{"count":0,"messages":[]}' > "$STUB_JSON"
cat > "$T/stubowner" <<STUB
#!/bin/bash
bash -c 'bash "\$0" >/dev/null 2>&1 & echo \$! > "\$1"; wait' "$T/sidechat-mention-monitor.sh" "$T/owner.pid"
STUB
chmod +x "$T/stubowner"
"$T/stubowner" & CL=$!
sleep 2
OP=$(cat "$T/owner.pid"); kill -0 "$OP" || fail "owner-guard poller did not start"
kill -9 $CL; wait $CL 2>/dev/null; sleep 4
kill -0 "$OP" 2>/dev/null && { kill "$OP"; fail "poller outlived its owner (wrapper still alive)"; }

# exit mode: one arm announces the whole batch then exits; STILL-PENDING alone does not end the run
rm -f "$T/.mention-monitor-seen"
cat > "$STUB_JSON" <<'J'
{"count":2,"server_now":"2026-10-04T17:00:00.000Z","messages":[
 {"id":1,"sender":"bob","content":"one","timestamp":"2026-10-04T17:00:00.000Z"},
 {"id":2,"sender":"amy","content":"two","timestamp":"2026-10-04T17:00:00.000Z"}]}
J
out=$(SIDECHAT_MONITOR_EXIT_ON_MENTION=1 timeout 8 bash "$T/sidechat-mention-monitor.sh"); rc=$?
[[ $rc == 0 ]] || fail "exit mode did not exit on its own (rc $rc)"
[[ $(grep -c '^MENTION' <<<"$out") == 2 ]] || fail "exit mode did not announce the whole batch: $out"
echo 5 > "$T/.mention-monitor-seen"
echo '{"count":1,"server_now":"2026-10-04T17:00:00.000Z","messages":[{"id":5,"sender":"bob","content":"old","timestamp":"2026-10-04T16:00:00.000Z"}]}' > "$STUB_JSON"
out=$(SIDECHAT_MONITOR_EXIT_ON_MENTION=1 timeout 4 bash "$T/sidechat-mention-monitor.sh"); rc=$?
[[ $rc == 124 ]] || fail "STILL-PENDING alone ended the run (rc $rc)"
grep -q '^STILL-PENDING 5' <<<"$out" || fail "STILL-PENDING not printed in exit mode"

# channel guard: a poller armed inside a channel session exits at once
printf '#!/bin/bash\nbash %s\n' "$T/sidechat-mention-monitor.sh" > "$T/stubowner"
out=$(timeout 5 "$T/stubowner" --dangerously-load-development-channels server:sidechat); rc=$?
[[ $rc == 0 && "$out" == CHANNEL-ACTIVE* ]] || fail "poller ran in a channel session (rc $rc): $out"

# auto-arm hook picks the arm call from WAKE_PATH
for cfg in "WAKE_PATH=background:run_in_background" "WAKE_PATH=monitor:timeout_ms" "X=1:timeout_ms"; do
  printf 'TOKEN=t\nSERVER_URL=http://stub\n%s\n' "${cfg%%:*}" > "$T/config"
  bash "$T/hooks/sessionstart-autoarm-monitor.sh" | grep -q "${cfg##*:}" || fail "autoarm hook for ${cfg%%:*}"
done
printf 'TOKEN=t\nSERVER_URL=http://stub\nWAKE_PATH=background\n' > "$T/config"
bash "$T/hooks/sessionstart-autoarm-monitor.sh" | grep -q 'timeout_ms' && fail "background mode still gives the Monitor call"
echo "OK"
