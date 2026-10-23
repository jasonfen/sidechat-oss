#!/bin/bash
# sc-post.sh --file (2.8.6): an expired token re-auths once and retries the
# upload, then posts. Stubs curl and sc-auth.sh; no network. Run: bash test/sc-post-upload.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
mkdir -p "$T/bin" "$T/sc"
cp "$REPO/install/sc-post.sh" "$T/sc/"
echo hi > "$T/f.txt"
# curl stub: 401 unless the bearer token is "fresh"; uploads return {"id":"f1"}.
cat > "$T/bin/curl" <<EOF
#!/bin/bash
for a in "\$@"; do case "\$a" in "Authorization: Bearer "*) tok="\${a#Authorization: Bearer }" ;; http*) url="\$a" ;; esac; done
echo "\$tok \$url" >> "$T/calls"
[[ "\$tok" == fresh ]] || { printf '\n401'; exit 0; }
[[ "\$url" == */files/upload ]] && printf '{"id":"f1"}\n200' || printf '{"id":9}\n201'
EOF
chmod +x "$T/bin/curl"
printf '#!/bin/bash\n[[ -n "${AUTH_FAILS:-}" ]] && exit 1\nsed -i.bak "s/^TOKEN=.*/TOKEN=fresh/" "%s/sc/config"\n' "$T" > "$T/sc/sc-auth.sh"
chmod +x "$T/sc/sc-auth.sh"
export PATH="$T/bin:$PATH"

run() {  # run <token>
  rm -f "$T/calls"
  printf 'SERVER_URL=http://stub\nTOKEN=%s\n' "$1" > "$T/sc/config"
  ERR=$(bash "$T/sc/sc-post.sh" --file "$T/f.txt" msg 2>&1 >/dev/null); RC=$?
  CALLS=$(cat "$T/calls" 2>/dev/null)
}

run fresh
[[ $RC == 0 && $(wc -l <<<"$CALLS") == 2 ]] || fail "plain upload: rc=$RC calls=$CALLS"
run stale
[[ $RC == 0 && "$CALLS" == $'stale http://stub/files/upload\nfresh http://stub/files/upload\nfresh http://stub/message' ]] || fail "401 upload not re-authed: rc=$RC calls=$CALLS err=$ERR"
AUTH_FAILS=1 run stale
[[ $RC == 1 && "$ERR" == *"File upload failed (401)"* ]] || fail "failed re-auth not reported: rc=$RC err=$ERR"
echo "ok: sc-post-upload"
