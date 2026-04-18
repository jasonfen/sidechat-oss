#!/usr/bin/env bash
set -euo pipefail

# SideChat Server Bootstrap
# Usage: curl -fsSL https://raw.githubusercontent.com/jasonfen/sidechat-oss/main/install-server.sh | bash
#   --docker      install via Docker Compose (pulls ghcr.io/jasonfen/sidechat-oss:latest)
#   --bun         install via bun+systemd (clones repo, runs locally)
#   (no flag)     auto: Docker if `docker compose` is present and bun isn't, else bun

SIDECHAT_DIR="${SIDECHAT_DIR:-/opt/sidechat}"
REPO_URL="https://github.com/jasonfen/sidechat-oss.git"
IMAGE="ghcr.io/jasonfen/sidechat-oss:latest"
MODE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --docker) MODE="docker"; shift ;;
    --bun)    MODE="bun";    shift ;;
    *)        echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

echo ""
echo "  ╔══════════════════════════════════╗"
echo "  ║   SideChat Server Installer      ║"
echo "  ╚══════════════════════════════════╝"
echo ""

has_docker_compose() { command -v docker &>/dev/null && docker compose version &>/dev/null; }

# Pick mode if not forced: prefer Docker when present (closer to prod); offer
# bun fallback interactively only when a terminal is attached and docker is
# unavailable.
if [[ -z "$MODE" ]]; then
  if has_docker_compose; then
    MODE="docker"
  elif command -v bun &>/dev/null || [[ -r /dev/tty ]]; then
    MODE="bun"
  else
    echo "ERROR: neither 'docker compose' nor 'bun' available, and no tty to prompt." >&2
    echo "  Install docker (recommended) or re-run with --bun on a machine with bun." >&2
    exit 1
  fi
fi
echo "  Install mode: $MODE"
echo ""

prompt_admin_creds() {
  # Sets ADMIN_USER and ADMIN_HASH in the caller's scope.
  local pw confirm
  read -rp "  Admin username [admin]: " ADMIN_USER < /dev/tty
  ADMIN_USER="${ADMIN_USER:-admin}"
  while true; do
    read -rsp "  Admin password (min 8 chars): " pw < /dev/tty; echo ""
    if [[ ${#pw} -lt 8 ]]; then echo "  Password must be at least 8 characters" >&2; continue; fi
    read -rsp "  Confirm password: " confirm < /dev/tty; echo ""
    if [[ "$pw" != "$confirm" ]]; then echo "  Passwords do not match" >&2; continue; fi
    break
  done
  # Hash bcrypt — Docker mode hashes inside a throwaway container so the host
  # doesn't need bun; bun mode uses the host's bun.
  if [[ "$MODE" == "docker" ]]; then
    ADMIN_HASH=$(docker run --rm --entrypoint bun "$IMAGE" -e "console.log(await Bun.password.hash('$pw', {algorithm: 'bcrypt'}))")
  else
    ADMIN_HASH=$(bun -e "console.log(await Bun.password.hash('$pw', {algorithm: 'bcrypt'}))")
  fi
}

if [[ "$MODE" == "docker" ]]; then
  # --- Docker install path ---
  if ! has_docker_compose; then
    echo "ERROR: 'docker compose' not available. Install docker + compose plugin." >&2
    exit 1
  fi
  mkdir -p "$SIDECHAT_DIR"
  cd "$SIDECHAT_DIR"

  read -rp "  Server port [3000]: " PORT < /dev/tty; PORT="${PORT:-3000}"
  read -rp "  Data directory [/var/sidechat]: " DATA_DIR < /dev/tty; DATA_DIR="${DATA_DIR:-/var/sidechat}"
  mkdir -p "$DATA_DIR"
  # Default PUBLIC_URL to the machine's first non-loopback IPv4
  DETECTED_IP=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)
  DEFAULT_URL="http://${DETECTED_IP:-localhost}:$PORT"
  echo ""
  echo "  Public URL — what a *new client* would curl to reach this server."
  echo "  Use http:// for a trusted network (LAN, Tailscale). Use https:// only if you"
  echo "  terminate TLS in front (Tailscale Serve, Caddy, Cloudflare, etc.)."
  read -rp "  Public URL [$DEFAULT_URL]: " PUBLIC_URL < /dev/tty
  PUBLIC_URL="${PUBLIC_URL:-$DEFAULT_URL}"
  PUBLIC_URL="${PUBLIC_URL%/}"
  echo ""
  prompt_admin_creds

  cat > "$SIDECHAT_DIR/docker-compose.yml" <<YAML
services:
  sidechat:
    image: $IMAGE
    container_name: sidechat
    restart: unless-stopped
    ports:
      - "$PORT:3000"
    volumes:
      - $DATA_DIR:/var/sidechat
    environment:
      PORT: "3000"
      PUBLIC_URL: "$PUBLIC_URL"
      ADMIN_USER: "$ADMIN_USER"
      ADMIN_PASSWORD_HASH: "$ADMIN_HASH"
      DB_PATH: "/var/sidechat/sidechat.db"
      ARCHIVE_DIR: "/var/sidechat/archives"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      start_period: 10s
YAML
  chmod 600 "$SIDECHAT_DIR/docker-compose.yml"   # contains bcrypt hash

  echo "  Pulling image + starting stack..."
  ( cd "$SIDECHAT_DIR" && docker compose pull && docker compose up -d )

  # Wait for health
  for i in $(seq 1 20); do
    if curl -fsS -m 3 "http://localhost:$PORT/health" >/dev/null 2>&1; then break; fi
    sleep 2
  done

  echo ""
  echo "  ╔══════════════════════════════════════════════════╗"
  echo "  ║   SideChat is ready (Docker)                     ║"
  echo "  ╚══════════════════════════════════════════════════╝"
  echo ""
  echo "  Compose:        $SIDECHAT_DIR/docker-compose.yml"
  echo "  Admin console:  $PUBLIC_URL/admin"
  echo "  Health check:   $PUBLIC_URL/health"
  echo ""
  echo "  Install a client (from any other machine):"
  echo "    curl -fsSL https://raw.githubusercontent.com/jasonfen/sidechat-oss/main/install/client.sh | bash -s -- $PUBLIC_URL"
  echo ""
  exit 0
fi

# --- Prerequisites (bun mode) ---

if ! command -v git &>/dev/null; then
  echo "ERROR: git is required. Install it first:" >&2
  echo "  apt install git  |  brew install git  |  dnf install git" >&2
  exit 1
fi

# --- Install Bun if needed ---

if ! command -v bun &>/dev/null; then
  echo "[1/5] Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  # Source the new path
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    echo "ERROR: Bun installation failed" >&2
    exit 1
  fi
  echo "  Bun $(bun --version) installed"
else
  echo "[1/5] Bun $(bun --version) found"
fi

# --- Clone or update repo ---

if [[ -d "$SIDECHAT_DIR" && -f "$SIDECHAT_DIR/server.ts" ]]; then
  if [[ -d "$SIDECHAT_DIR/.git" ]]; then
    echo "[2/5] Updating existing git installation at $SIDECHAT_DIR..."
    cd "$SIDECHAT_DIR"
    git pull --ff-only
  else
    # Existing non-git install (e.g. Ansible-deployed) — replace with git clone
    echo "[2/5] Found existing non-git installation at $SIDECHAT_DIR"
    BACKUP="${SIDECHAT_DIR}.v1-backup.$(date +%Y%m%d%H%M%S)"
    echo "  Backing up to $BACKUP"
    # Preserve .env and data files
    cp -a "$SIDECHAT_DIR" "$BACKUP"
    # Save .env before replacing
    ENV_BACKUP=""
    if [[ -f "$SIDECHAT_DIR/.env" ]]; then
      ENV_BACKUP=$(cat "$SIDECHAT_DIR/.env")
    fi
    rm -rf "$SIDECHAT_DIR"
    git clone "$REPO_URL" "$SIDECHAT_DIR"
    cd "$SIDECHAT_DIR"
    # Restore .env if it existed
    if [[ -n "$ENV_BACKUP" ]]; then
      echo "$ENV_BACKUP" > "$SIDECHAT_DIR/.env"
      chmod 600 "$SIDECHAT_DIR/.env"
      echo "  Restored .env from previous install"
    fi
    echo "  Previous installation backed up and replaced with git clone"
  fi
else
  echo "[2/5] Cloning SideChat to $SIDECHAT_DIR..."
  if [[ -d "$SIDECHAT_DIR" ]]; then
    echo "  WARNING: $SIDECHAT_DIR exists but has no server.ts"
    echo "  Backing up to ${SIDECHAT_DIR}.bak"
    mv "$SIDECHAT_DIR" "${SIDECHAT_DIR}.bak"
  fi
  git clone "$REPO_URL" "$SIDECHAT_DIR"
  cd "$SIDECHAT_DIR"
fi

# --- Install dependencies ---

echo "[3/5] Installing dependencies..."
bun install --silent

# --- Admin credentials ---

ENV_FILE="$SIDECHAT_DIR/.env"

if [[ -f "$ENV_FILE" && -s "$ENV_FILE" ]] && grep -q '^ADMIN_PASSWORD_HASH=' "$ENV_FILE"; then
  echo "[4/5] Existing v2 .env found — keeping current configuration"
elif [[ -f "$ENV_FILE" && -s "$ENV_FILE" ]]; then
  echo "[4/5] Found v1 .env (API key auth) — upgrading to v2"
  echo "  Old .env backed up to ${ENV_FILE}.v1"
  cp "$ENV_FILE" "${ENV_FILE}.v1"
  # Preserve port and archive dir from v1 if set
  V1_PORT=$(grep '^PORT=' "$ENV_FILE" | cut -d= -f2 || true)
  V1_ARCHIVE=$(grep '^ARCHIVE_DIR=' "$ENV_FILE" | cut -d= -f2 || true)
  rm "$ENV_FILE"
  # Fall through to credential setup below with v1 defaults
  _V1_PORT="${V1_PORT:-3000}"
  _V1_ARCHIVE="${V1_ARCHIVE:-/var/sidechat/archives}"
  _V1_UPGRADE=1
fi

if [[ ! -f "$ENV_FILE" || ! -s "$ENV_FILE" ]]; then
  echo "[4/5] Setting up admin credentials..."
  echo ""

  read -rp "  Admin username [admin]: " ADMIN_USER < /dev/tty
  ADMIN_USER="${ADMIN_USER:-admin}"

  while true; do
    read -rsp "  Admin password (min 8 chars): " ADMIN_PASS < /dev/tty
    echo ""
    if [[ ${#ADMIN_PASS} -lt 8 ]]; then
      echo "  Password must be at least 8 characters" >&2
      continue
    fi
    read -rsp "  Confirm password: " ADMIN_CONFIRM < /dev/tty
    echo ""
    if [[ "$ADMIN_PASS" != "$ADMIN_CONFIRM" ]]; then
      echo "  Passwords do not match" >&2
      continue
    fi
    break
  done

  ADMIN_HASH=$(bun -e "console.log(await Bun.password.hash('$ADMIN_PASS', {algorithm: 'bcrypt'}))")

  DEFAULT_PORT="${_V1_PORT:-3000}"
  read -rp "  Server port [$DEFAULT_PORT]: " PORT < /dev/tty
  PORT="${PORT:-$DEFAULT_PORT}"

  DEFAULT_DATA="${_V1_ARCHIVE:-/var/sidechat/archives}"
  DEFAULT_DATA="${DEFAULT_DATA%/archives}"  # strip /archives suffix for data dir
  read -rp "  Data directory [$DEFAULT_DATA]: " DATA_DIR < /dev/tty
  DATA_DIR="${DATA_DIR:-$DEFAULT_DATA}"

  mkdir -p "${DATA_DIR}/archives" 2>/dev/null || true

  cat > "$ENV_FILE" <<EOF
PORT=$PORT
DB_PATH=${DATA_DIR}/sidechat.db
ADMIN_USER=$ADMIN_USER
ADMIN_PASSWORD_HASH=$ADMIN_HASH
SESSION_TTL_HOURS=24
NONCE_TTL_SECONDS=60
ADMIN_SESSION_TTL_HOURS=8
ARCHIVE_DIR=${DATA_DIR}/archives
EOF

  chmod 600 "$ENV_FILE"
  echo ""
  echo "  .env written to $ENV_FILE"
fi

# --- Systemd (optional) ---

echo "[5/5] Setup complete"
echo ""

INSTALL_SYSTEMD="n"
if command -v systemctl &>/dev/null; then
  read -rp "  Install as systemd service? [y/N]: " INSTALL_SYSTEMD < /dev/tty
fi

if [[ "$INSTALL_SYSTEMD" =~ ^[Yy]$ ]]; then
  BUN_PATH=$(which bun)
  cat > /tmp/sidechat.service <<EOF
[Unit]
Description=SideChat
After=network.target

[Service]
Type=simple
WorkingDirectory=$SIDECHAT_DIR
ExecStart=$BUN_PATH run server.ts
Restart=always
RestartSec=5
EnvironmentFile=$SIDECHAT_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

  if [[ $EUID -eq 0 ]]; then
    mv /tmp/sidechat.service /etc/systemd/system/sidechat.service
    systemctl daemon-reload
    systemctl enable sidechat
    systemctl start sidechat
    echo "  sidechat.service installed and started"
  else
    echo ""
    echo "  Service file written to /tmp/sidechat.service"
    echo "  Run as root to install:"
    echo "    sudo mv /tmp/sidechat.service /etc/systemd/system/"
    echo "    sudo systemctl daemon-reload && sudo systemctl enable --now sidechat"
  fi
fi

# --- Done ---

# Read port from .env for the output
source "$ENV_FILE" 2>/dev/null || true
DISPLAY_PORT="${PORT:-3000}"

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║   SideChat is ready                              ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""
echo "  Start:          cd $SIDECHAT_DIR && bun run server.ts"
echo "  Admin console:  http://localhost:$DISPLAY_PORT/admin"
echo "  Observer login:  http://localhost:$DISPLAY_PORT/watch/login"
echo "  Health check:   http://localhost:$DISPLAY_PORT/health"
echo ""
echo "  Client install (from other machines):"
echo "    curl -fsSL http://<this-server>:$DISPLAY_PORT/install/client.sh | bash"
echo ""
