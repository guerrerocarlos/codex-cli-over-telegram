# Codex over Telegram

Control local Codex sessions from Telegram forum topics. Each Telegram topic can be bound to a different git repository or worktree, so one Telegram group can manage many repos at the same time.

## What Works

- Telegram forum topic routing with `chat_id + message_thread_id`
- Allowlisted Telegram users and chats
- Per-topic repo binding
- Per-topic Codex session tracking through app-server or `codex exec --json`
- Codex app-server backend for richer event streaming, resume, interrupt, and active-turn steering
- Per-topic run queue
- Repo write lock for `workspace-write` runs
- `/health` endpoint with deployment metadata
- Commands for binding, mode switching, status, stopping, diff, commit, and push

## Requirements

- Node.js 20+
- A working `codex` CLI on the host
- Codex authenticated on the host, for example with `codex login`
- A Telegram bot token from BotFather
- A Telegram supergroup with forum topics enabled

## Local Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```text
TELEGRAM_BOT_TOKEN=123456:telegram-token
ALLOWED_TELEGRAM_USER_IDS=12345678
ALLOWED_TELEGRAM_CHAT_IDS=-1001234567890
ALLOWED_REPO_ROOTS=/home/gnu,/srv/dev
DATABASE_PATH=./data/state.sqlite
CODEX_BIN=codex
CODEX_BACKEND=app-server
DEFAULT_SANDBOX_MODE=read-only
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8787
```

You can leave `ALLOWED_TELEGRAM_USER_IDS` and
`ALLOWED_TELEGRAM_CHAT_IDS` blank for the first run. In that bootstrap mode,
the bot replies to any message with the exact user ID and chat ID values to add
to `.env`.

Find your Telegram IDs by sending a message to the bot and temporarily logging updates, or by using a known ID helper bot. Use only IDs you trust.

## Run

```bash
npm run dev
```

In another terminal:

```bash
curl -fsS http://127.0.0.1:8787/health
```

For production:

```bash
npm run build
npm start
```

`CODEX_BACKEND=app-server` is the default and recommended backend. It runs
`codex app-server --stdio` locally for each active Telegram run and uses
`thread/start`, `thread/resume`, `turn/start`, `turn/steer`, and
`turn/interrupt`.

Use `CODEX_BACKEND=exec` to fall back to `codex exec --json`. The exec backend is
stable and simple, but it cannot steer an active turn.

## Telegram Usage

Create a forum topic in your Telegram group, then send:

```text
/bind /home/gnu/todex
/mode read
summarize this repository
```

For write-capable Codex runs:

```text
/mode write
implement the smallest useful README improvement
/diff
/commit Improve README
/push
```

Each topic has its own binding:

```text
Topic: codex-over-telegram
  /bind /home/gnu/todex

Topic: api-service
  /bind /srv/dev/api-service

Topic: mobile-app
  /bind /srv/dev/mobile-app
```

Use git worktrees if two topics need to work on the same repo concurrently.

## Commands

```text
/help
/bind <absolute_repo_path>
/where
/mode read
/mode write
/new
/status
/stop
/diff
/commit <message>
/push
/unbind
```

Any ordinary text message in a bound topic becomes a Codex prompt.

When the app-server backend is active, ordinary text sent while a run is already
running in that topic is sent as a steering note to the active turn instead of
being queued as the next run.

## Security Defaults

- The bot ignores non-allowlisted users and chats.
- `/bind` only accepts absolute paths under `ALLOWED_REPO_ROOTS`.
- Bound paths must be git repositories.
- The default sandbox is `read-only`.
- Write mode uses `workspace-write`, never `danger-full-access`.
- The Codex app-server is not exposed publicly.

Telegram access to this bot is equivalent to remote control of the allowed repositories. Keep the bot token private and keep the allowlists tight.

## Production With systemd

Install files somewhere like:

```bash
sudo mkdir -p /opt/telegram-codex-wrapper
sudo rsync -a --delete ./ /opt/telegram-codex-wrapper/
```

Create a service user:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin codexbot
```

Create `/etc/telegram-codex-wrapper/env`:

```text
TELEGRAM_BOT_TOKEN=123456:telegram-token
ALLOWED_TELEGRAM_USER_IDS=12345678
ALLOWED_TELEGRAM_CHAT_IDS=-1001234567890
ALLOWED_REPO_ROOTS=/home/gnu,/srv/dev
DATABASE_PATH=/var/lib/telegram-codex-wrapper/state.sqlite
CODEX_BIN=codex
DEFAULT_SANDBOX_MODE=read-only
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8787
```

Then:

```bash
sudo install -d -m 0750 -o codexbot -g codexbot /var/lib/telegram-codex-wrapper
sudo install -d -m 0750 -o root -g codexbot /etc/telegram-codex-wrapper
sudo chown root:codexbot /etc/telegram-codex-wrapper/env
sudo chmod 0640 /etc/telegram-codex-wrapper/env
sudo cp deploy/systemd/telegram-codex-wrapper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-codex-wrapper
```

The service user must be able to run `codex` and access the repositories you bind. If you use ChatGPT auth, authenticate Codex for the service account or use an environment where `codex exec` can reuse valid credentials.

## Deployment Metadata

`/health` returns:

```json
{
  "ok": true,
  "service": "telegram-codex-wrapper",
  "branch": "main",
  "commitHash": "full-commit-hash",
  "deployedAt": "2026-06-11T13:45:00Z"
}
```

Use `scripts/deploy.sh` to build, write deployment metadata, restart the service, and verify health.

## Development Checks

```bash
npm test
npm run build
```
