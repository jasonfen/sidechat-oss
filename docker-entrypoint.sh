#!/bin/sh
set -eu

DATA_DIR="$(dirname "${DB_PATH:-/var/sidechat/sidechat.db}")"
HASH_FILE="${DATA_DIR}/admin_password.hash"
mkdir -p "$DATA_DIR"

# Helper: bcrypt-hash whatever is passed as $1 using Bun.password.
hash_pw() {
  bun -e "console.log(await Bun.password.hash(process.argv[1],{algorithm:'bcrypt'}))" "$1"
}

if [ -n "${ADMIN_PASSWORD_HASH:-}" ]; then
  :  # operator supplied hash directly — use as-is
elif [ -n "${ADMIN_PASSWORD:-}" ]; then
  ADMIN_PASSWORD_HASH="$(hash_pw "$ADMIN_PASSWORD")"
  unset ADMIN_PASSWORD      # don't leak plaintext to the server process
elif [ -s "$HASH_FILE" ]; then
  ADMIN_PASSWORD_HASH="$(cat "$HASH_FILE")"
else
  PW="$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)"
  ADMIN_PASSWORD_HASH="$(hash_pw "$PW")"
  printf '%s' "$ADMIN_PASSWORD_HASH" > "$HASH_FILE"
  chmod 600 "$HASH_FILE"
  cat >&2 <<EOF
================================================================
 SideChat: generated admin credentials (shown once)
   username: ${ADMIN_USER:-admin}
   password: ${PW}
 Hash persisted to ${HASH_FILE} inside the data volume.
 Set ADMIN_PASSWORD (plain) or ADMIN_PASSWORD_HASH to override.
================================================================
EOF
fi

export ADMIN_PASSWORD_HASH
exec "$@"
