#!/bin/bash
# download-attachments.sh (2.8.7): an expired token re-auths once and retries;
# a failed download leaves no file. Stubs curl and sc-auth.sh; no network.
# Run: bash test/download-attachments.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
mkdir -p "$T/bin" "$T/sc"
cp "$REPO/install/download-attachments.sh" "$T/sc/"
# curl stub: 401 unless the bearer token is "fresh"; on 200 writes the -o file.
cat > "$T/bin/curl" <<EOF
#!/bin/bash
while [[ \$# -gt 0 ]]; do case "\$1" in -H) tok="\${2#Authorization: Bearer }"; shift ;; -o) out="\$2"; shift ;; esac; shift; done
echo "\$tok" >> "$T/calls"
if [[ "\$tok" == fresh ]]; then echo data > "\$out"; printf 200; else echo denied > "\$out"; printf 401; fi
EOF
chmod +x "$T/bin/curl"
printf '#!/bin/bash\n[[ -n "${AUTH_FAILS:-}" ]] && exit 1\nsed -i.bak "s/^TOKEN=.*/TOKEN=fresh/" "%s/sc/config"\n' "$T" > "$T/sc/sc-auth.sh"
chmod +x "$T/sc/sc-auth.sh"
export PATH="$T/bin:$PATH"

run() {  # run <token>
  rm -rf "$T/calls" "$T/sc/files"
  printf 'SERVER_URL=http://stub\nTOKEN=%s\n' "$1" > "$T/sc/config"
  printf '[{"id":"a","filename":"x.md"},{"id":"b","filename":"y.md"}]' |
    SIDECHAT_DIR="$T/sc" TOKEN="$1" SERVER_URL=http://stub bash "$T/sc/download-attachments.sh"
  CALLS=$(cat "$T/calls" 2>/dev/null)
}

run fresh
[[ $(cat "$T/sc/files/a_x.md") == data && $(wc -l <<<"$CALLS") == 2 ]] || fail "plain download: calls=$CALLS"
run stale
[[ $(cat "$T/sc/files/a_x.md") == data && $(cat "$T/sc/files/b_y.md") == data && "$CALLS" == $'stale\nfresh\nfresh' ]] || fail "401 not re-authed once: calls=$CALLS"
AUTH_FAILS=1 run stale
[[ ! -e "$T/sc/files/a_x.md" && ! -e "$T/sc/files/b_y.md" ]] || fail "failed download left a file"
echo "ok: download-attachments"
