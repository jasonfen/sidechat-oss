#!/usr/bin/env python3
"""SideChat webhook listener — receives POSTs from the SideChat server.
Writes mentions to new-mentions.txt, triggering the FileChanged hook.
Injects /mention-check into the tmux claude session.
"""
import http.server, json, hashlib, hmac, os, subprocess, sys, urllib.request, threading

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
PORT = int(os.environ.get('WEBHOOK_PORT', '7777'))

# Read config
config = {}
config_path = os.path.join(SCRIPT_DIR, 'config')
if os.path.exists(config_path):
    with open(config_path) as f:
        for line in f:
            line = line.strip()
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                config[k] = v

BOT_NAME = config.get('BOT_NAME', 'unknown')
SECRET = config.get('WEBHOOK_SECRET', '')
SERVER_URL = config.get('SERVER_URL', '')
TOKEN = config.get('TOKEN', '')


FILES_DIR = os.path.join(PROJECT_DIR, '.sidechat', 'files')
os.makedirs(FILES_DIR, exist_ok=True)


def ack_read(msg_id):
    """Send read receipt back to server in background."""
    if not SERVER_URL or not TOKEN:
        return
    try:
        url = f'{SERVER_URL}/messages/{msg_id}/read'
        req = urllib.request.Request(url, method='POST', data=b'',
                                     headers={'Authorization': f'Bearer {TOKEN}'})
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def download_file(file_id, filename):
    """Download a file attachment from the server. Returns local path or None."""
    if not SERVER_URL or not TOKEN:
        return None
    try:
        url = f'{SERVER_URL}/files/{file_id}/download'
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {TOKEN}'})
        resp = urllib.request.urlopen(req, timeout=30)
        # Sanitize filename — keep only the basename
        safe_name = os.path.basename(filename).replace('..', '_')
        local_path = os.path.join(FILES_DIR, f'{file_id}_{safe_name}')
        with open(local_path, 'wb') as f:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)
        return local_path
    except Exception:
        return None


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)

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
            # Download any attached files
            files = msg.get('files', [])
            file_lines = []
            for finfo in files:
                fid = finfo.get('id', '')
                fname = finfo.get('filename', 'unknown')
                local = download_file(fid, fname)
                if local:
                    file_lines.append(f'  [file] {fname} -> {local}')

            line = f'[{ts}] {sender}: {content}\n'
            if file_lines:
                line += '\n'.join(file_lines) + '\n'

            mentions_path = os.path.join(PROJECT_DIR, '.sidechat', 'new-mentions.txt')
            with open(mentions_path, 'a') as f:
                f.write(line)

            # Acknowledge read receipt in background
            msg_id = msg.get('id')
            if msg_id is not None:
                threading.Thread(target=ack_read, args=(msg_id,), daemon=True).start()

            try:
                subprocess.run(
                    ['tmux', 'send-keys', '-t', 'claude', '/mention-check', 'Enter'],
                    capture_output=True, timeout=5
                )
            except Exception:
                pass
        except Exception:
            pass

        self.send_response(200)
        self.end_headers()

    def log_message(self, format, *args):
        pass


if __name__ == '__main__':
    server = http.server.HTTPServer(('0.0.0.0', PORT), Handler)
    print(f'Webhook listener on port {PORT}', flush=True)
    server.serve_forever()
