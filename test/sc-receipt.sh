#!/bin/bash
# sc-receipt.sh (2.8.5): an expired token re-auths once and retries; a `read`
# that still fails prints the error and exits 1; `engaged` warns but exits 0.
# Stubs curl and sc-auth.sh; no network. Run: bash test/sc-receipt.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
mkdir -p "$T/bin" "$T/sc"
cp "$REPO/install/sc-receipt.sh" "$T/sc/"
# curl stub: 401 unless the bearer token is "fresh", then $CODE; logs each call.
cat > "$T/bin/curl" <<EOF
#!/bin/bash
for a in "\$@"; do case "\$a" in "Authorization: Bearer "*) tok="\${a#Authorization: Bearer }" ;; http*) url="\$a" ;; esac; done
echo "\$tok \$url" >> "$T/calls"
[[ "\$tok" == fresh ]] && printf '%s' "\$CODE" || printf 401
EOF
chmod +x "$T/bin/curl"
printf '#!/bin/bash\n[[ -n "${AUTH_FAILS:-}" ]] && exit 1\nsed -i.bak "s/^TOKEN=.*/TOKEN=fresh/" "%s/sc/config"\n' "$T" > "$T/sc/sc-auth.sh"
chmod +x "$T/sc/sc-auth.sh"
export PATH="$T/bin:$PATH"

run() {  # run <token> <code> <args...>
  local tok="$1" code="$2"; shift 2
  rm -f "$T/calls"
  printf 'SERVER_URL=http://stub\nTOKEN=%s\n' "$tok" > "$T/sc/config"
  ERR=$(CODE="$code" bash "$T/sc/sc-receipt.sh" "$@" 2>&1 >/dev/null); RC=$?
  CALLS=$(cat "$T/calls" 2>/dev/null)
}

run fresh 200 read --id 7
[[ $RC == 0 && "$CALLS" == "fresh http://stub/messages/7/read" ]] || fail "plain read: rc=$RC calls=$CALLS"
run stale 200 read --id 7
[[ $RC == 0 && $(wc -l <<<"$CALLS") == 2 && "$CALLS" == *"fresh http://stub/messages/7/read" ]] || fail "401 not re-authed: rc=$RC calls=$CALLS"
grep -q '^TOKEN=fresh' "$T/sc/config" || fail "config token not refreshed"
AUTH_FAILS=1 run stale 200 read --id 7
[[ $RC == 1 && "$ERR" == *"read 7 failed (HTTP 401)"* ]] || fail "failed re-auth not reported: rc=$RC err=$ERR"
run fresh 500 read --id 7
[[ $RC == 1 && "$ERR" == *"HTTP 500"* ]] || fail "500 not reported: rc=$RC err=$ERR"
run fresh 500 engaged --id 7
[[ $RC == 0 && "$ERR" == *"engaged 7 failed"* ]] || fail "engaged should warn, exit 0: rc=$RC err=$ERR"
printf '1\n2\n' > "$T/ids"
run stale 200 read --ids-file "$T/ids"
[[ $RC == 0 && $(grep -c '^stale' <<<"$CALLS") == 1 && ! -e "$T/ids" ]] || fail "batch: one re-auth for the batch, file removed: rc=$RC calls=$CALLS"
echo "ok: sc-receipt"
