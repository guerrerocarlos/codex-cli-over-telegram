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

1. Clone the repo into the service directory:

```bash
cd /home/gnu
git clone https://github.com/guerrerocarlos/codex-cli-over-telegram.git
cd /home/gnu/codex-cli-over-telegram
npm install
```

2. Make sure Codex works as `gnu`:

```bash
codex --version
codex
```

Log in or finish Codex setup if the CLI prompts you. The service uses `/home/gnu/.codex`.

3. Install the systemd unit:

```bash
sudo install -d -m 0750 -o root -g gnu /etc/codex-cli-over-telegram
sudo install -d -m 0750 -o gnu -g gnu /home/gnu/.local/state/codex-cli-over-telegram
sudo cp deploy/systemd/codex-cli-over-telegram.service /etc/systemd/system/codex-cli-over-telegram.service
sudo systemctl daemon-reload
```

4. Create the production env file:

```bash
sudo nano /etc/codex-cli-over-telegram/env
```

Use this shape:

```text
TELEGRAM_BOT_TOKEN=123456:telegram-token
ALLOWED_TELEGRAM_USER_IDS=12345678
ALLOWED_TELEGRAM_CHAT_IDS=-1001234567890
ALLOWED_REPO_ROOTS=/home/gnu
DATABASE_PATH=/home/gnu/.local/state/codex-cli-over-telegram/state.sqlite
CODEX_BIN=codex
CODEX_BACKEND=app-server
DEFAULT_SANDBOX_MODE=read-only
CODEX_ALWAYS_YOLO=false
ALLOW_UNTHREADED_CHATS=true
MAX_PARALLEL_RUNS=4
MAX_TELEGRAM_MESSAGE_CHARS=3500
TELEGRAM_SEND_INTERVAL_MS=1500
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8787
```

Then lock it down:

```bash
sudo chown root:gnu /etc/codex-cli-over-telegram/env
sudo chmod 0640 /etc/codex-cli-over-telegram/env
```

5. Deploy, enable startup, and start the service:

```bash
./scripts/deploy.sh
sudo systemctl enable codex-cli-over-telegram
sudo systemctl restart codex-cli-over-telegram
sudo systemctl status codex-cli-over-telegram --no-pager
```

Useful checks:

```bash
curl -fsS http://127.0.0.1:8787/health
journalctl -u codex-cli-over-telegram -f
```

After editing `/etc/codex-cli-over-telegram/env`, restart the service:

```bash
sudo systemctl restart codex-cli-over-telegram
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
