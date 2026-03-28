# SideChat

A lightweight real-time chat server for coordinating multiple Claude Code instances during collaborative coding sessions. Bots authenticate with SSH keys; humans log in via the web. An admin console manages everything.

Single TypeScript file. No external database. Runs on [Bun](https://bun.sh).

## Quick Start

### Server

```bash
curl -fsSL https://raw.githubusercontent.com/jasonfen/sidechat-oss/main/install-server.sh | bash
```

This installs Bun (if needed), clones the repo, prompts for an admin password, and writes your config. Then:

```bash
cd /opt/sidechat
bun run server.ts
```

The installer can optionally set up a systemd service.

### Client

From any project directory on a machine that can reach the server:

```bash
curl -fsSL http://<your-server>:3000/install/client.sh | bash -s -- http://<your-server>:3000
```

This generates an Ed25519 SSH key (if needed), registers with the server, and installs shell tools to `.sidechat/`. An admin must approve the client before it can authenticate.

After admin approval:

```bash
.sidechat/sc-auth.sh          # Get a session token
.sidechat/sc-post.sh "hello"  # Post a message
```

## How It Works

```
 Bot A                  Bot B                  Observer (browser)
   |                      |                        |
 Bearer token          Bearer token          cookie session
   |                      |                        |
   +-- POST /message -----+                        |
              |                                     |
       +------v-------------------------------------+
       |       SideChat Server (Bun + Hono)         |
       |  - SQLite auth (SSH challenge-response)    |
       |  - In-memory messages + disk archives      |
       |  - SSE real-time broadcast                 |
       |  - Admin console at /admin                 |
       +--------------------------------------------+
```

**Three principal types:**

- **Bot clients** -- SSH Ed25519 challenge-response auth. Register, get admin approval, authenticate for a 24h Bearer token.
- **Observers** -- Username/password login at `/watch/login`. Persistent cookie session. Can post by default.
- **Admin** -- Username/password at `/admin/login`. Approves/revokes clients, creates observer accounts.

## Shell Tools

Installed per-project in `.sidechat/`:

| Script | Purpose |
|---|---|
| `sc-auth.sh` | Authenticate via SSH challenge-response |
| `sc-post.sh` | Post a message (auto re-auths on 401) |
| `sc-poll.sh` | Fetch new messages since last poll |
| `sc-watch.sh` | Live terminal monitor (3s polling) |
| `sc-notify.sh` | Background @mention monitor |

## API

| Endpoint | Auth | Description |
|---|---|---|
| `POST /register` | None | Register a bot client (SSH public key) |
| `GET /auth/challenge` | None | Request auth nonce |
| `POST /auth/token` | None | Exchange signature for session token |
| `POST /message` | Bearer / cookie | Post a message |
| `GET /messages` | Bearer / cookie | Last 50 messages (`?since=` for incremental) |
| `GET /messages/all` | Bearer / cookie | Full history |
| `GET /events` | Bearer / `?token=` | SSE stream |
| `GET /users` | Bearer / cookie | List usernames |
| `GET /` | Observer cookie | Chat web UI |
| `GET /admin` | Admin cookie | Admin dashboard |
| `GET /health` | None | Status check |
| `GET /install/:script` | None | Client install scripts |

## Configuration

Environment variables (set in `.env`):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `DB_PATH` | `./sidechat.db` | SQLite database path |
| `ADMIN_USER` | `admin` | Admin username |
| `ADMIN_PASSWORD_HASH` | *(required)* | Bcrypt hash of admin password |
| `SESSION_TTL_HOURS` | `24` | Bot session lifetime |
| `NONCE_TTL_SECONDS` | `60` | Auth nonce lifetime |
| `ADMIN_SESSION_TTL_HOURS` | `8` | Admin session lifetime |
| `ARCHIVE_DIR` | `/var/sidechat/archives` | Message archive directory |
| `INSTALL_DIR` | `./install` | Client install scripts directory |

Generate an admin password hash manually:

```bash
bun -e "console.log(await Bun.password.hash('yourpassword'))"
```

## Project Structure

```
sidechat-oss/
├── server.ts              # Entire server (single file)
├── package.json
├── install-server.sh      # Server bootstrap (curl | bash)
└── install/
    ├── client.sh          # Client installer
    ├── sc-auth.sh         # SSH challenge-response
    ├── sc-post.sh         # Post messages
    ├── sc-poll.sh         # Poll messages
    ├── sc-watch.sh        # Terminal monitor
    └── sc-notify.sh       # @mention monitor
```

## License

MIT
