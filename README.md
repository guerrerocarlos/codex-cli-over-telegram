# Todex

Run Codex from Telegram.

Each Telegram topic can be bound to a different folder, so one Telegram group can control many repos or worktrees at the same time.

## Quick Start With npx

Requirements:

- Node.js 20+
- The `codex` CLI installed and logged in on this machine
- A Telegram bot token from BotFather

Create a `.env` file:

```bash
mkdir -p ~/.todex
cd ~/.todex
nano .env
```

Paste this:

```text
TELEGRAM_BOT_TOKEN=123456:telegram-token
ALLOWED_TELEGRAM_USER_IDS=
ALLOWED_TELEGRAM_CHAT_IDS=
ALLOWED_REPO_ROOTS=/home/you
DATABASE_PATH=./state.sqlite
CODEX_BACKEND=app-server
ALLOW_UNTHREADED_CHATS=true
CODEX_ALWAYS_YOLO=false
TELEGRAM_SEND_INTERVAL_MS=1500
```

Start Todex:

```bash
npx github:guerrerocarlos/codex-cli-over-telegram
```

Send any message to the bot. If `ALLOWED_TELEGRAM_USER_IDS` or `ALLOWED_TELEGRAM_CHAT_IDS` is blank, Todex replies with the exact IDs to put in `.env`.

Update `.env`, restart the command, then bind a folder:

```text
/bind ~/my-project
```

Now send a normal Telegram message:

```text
summarize this repo
```

## Daily Use

Useful commands:

```text
/bind ~/path/to/project
/where
/models
/model
/model gpt-5.5
/plan on
/plan off
/mode read
/mode write
/status
/stop
/new
/diff
/commit Commit message
/push
/ask do something specific
```

Normal messages in a bound chat/topic are sent to Codex. Use `/ask` if Telegram privacy mode prevents the bot from seeing ordinary group messages.

## YOLO Mode

To make every Codex run use `danger-full-access` with approvals disabled:

```text
CODEX_ALWAYS_YOLO=true
```

Restart Todex after changing it.

## Run From A Clone

```bash
git clone https://github.com/guerrerocarlos/codex-cli-over-telegram.git
cd codex-cli-over-telegram
npm install
cp .env.example .env
npm run dev
```

Production-style local run:

```bash
npm run build
npm start
```

## Run At Boot

Todex includes a systemd service named `codex-cli-over-telegram`.

The service runs as user `gnu`, uses `/home/gnu` as `HOME`, and runs the app from `/home/gnu/codex-cli-over-telegram`.

Install the service:

```bash
sudo install -d -m 0750 -o root -g gnu /etc/codex-cli-over-telegram
sudo install -d -m 0750 -o gnu -g gnu /home/gnu/.local/state/codex-cli-over-telegram
sudo cp deploy/systemd/codex-cli-over-telegram.service /etc/systemd/system/codex-cli-over-telegram.service
sudo systemctl daemon-reload
```

Put production env vars in:

```bash
sudo nano /etc/codex-cli-over-telegram/env
sudo chown root:gnu /etc/codex-cli-over-telegram/env
sudo chmod 0640 /etc/codex-cli-over-telegram/env
```

For the systemd service, set:

```text
DATABASE_PATH=/home/gnu/.local/state/codex-cli-over-telegram/state.sqlite
```

Deploy and enable startup:

```bash
./scripts/deploy.sh
sudo systemctl enable codex-cli-over-telegram
sudo systemctl status codex-cli-over-telegram --no-pager
```

## Health Check

Todex exposes:

```bash
curl -fsS http://127.0.0.1:8787/health
```

## Security

Telegram access to Todex is remote control of your allowed folders.

Keep these tight:

```text
ALLOWED_TELEGRAM_USER_IDS=
ALLOWED_TELEGRAM_CHAT_IDS=
ALLOWED_REPO_ROOTS=
```

Only enable `CODEX_ALWAYS_YOLO=true` on a machine and Telegram group you fully trust.
