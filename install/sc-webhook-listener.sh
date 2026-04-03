#!/bin/bash
# sc-webhook-listener.sh — receives webhook POSTs from SideChat server
# Writes mentions to new-mentions.txt, triggering the FileChanged hook.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG="$SCRIPT_DIR/config"
PID_FILE="$SCRIPT_DIR/.webhook-listener.pid"
PORT="${WEBHOOK_PORT:-7777}"

if [[ ! -f "$CONFIG" ]]; then echo "Missing config"; exit 1; fi
source "$CONFIG"

WEBHOOK_SECRET="${WEBHOOK_SECRET:-}"

# Check for existing instance
if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    exit 0
  fi
  rm -f "$PID_FILE"
fi

python3 -c "
import http.server, json, hashlib, hmac, sys, os

PORT = int(os.environ.get('WEBHOOK_PORT', '7777'))
BOT_NAME = '$BOT_NAME'
SECRET = '$WEBHOOK_SECRET'
PROJECT_DIR = '$PROJECT_DIR'

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)

        # Verify HMAC signature if secret is set
        if SECRET:
            sig = self.headers.get('X-SideChat-Signature', '')
            expected = 'sha256=' + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(sig, expected):
                self.send_response(401)
                self.end_headers()
                return

        try:
            data = json.loads(body)
            msg = data.get('message', {})
            sender = msg.get('sender', 'unknown')
            content = msg.get('content', '')
            ts = msg.get('timestamp', '')
            if ts:
                ts = ts.replace('T', ' ')[:19]
            line = f'[{ts}] {sender}: {content}\n'

            mentions_path = os.path.join(PROJECT_DIR, '.sidechat', 'new-mentions.txt')
            with open(mentions_path, 'a') as f:
                f.write(line)

            # Inject /mention-check into tmux claude session if it exists
            import subprocess
            try:
                subprocess.run(
                    ['tmux', 'send-keys', '-t', 'claude', '/mention-check', 'Enter'],
                    capture_output=True, timeout=5
                )
            except Exception:
                pass  # no tmux session or not available
        except Exception:
            pass

        self.send_response(200)
        self.end_headers()

    def log_message(self, format, *args):
        pass  # silence request logs

server = http.server.HTTPServer(('0.0.0.0', PORT), Handler)
sys.stdout.write(f'Webhook listener on port {PORT}\n')
sys.stdout.flush()
server.serve_forever()
" &

LISTENER_PID=$!
echo "$LISTENER_PID" > "$PID_FILE"
disown "$LISTENER_PID"
echo "Webhook listener started (PID $LISTENER_PID, port $PORT)"
