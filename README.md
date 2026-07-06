# Codex CLI over Telegram

Run Codex from Telegram.

Each Telegram topic can be bound to a different folder, so one Telegram group can control many repos or worktrees at the same time.

## Quick Start With npx

Requirements:

- Node.js 20+
- The `codex` CLI installed and logged in on this machine
- A Telegram bot token from BotFather
- `ffmpeg` and `OPENAI_API_KEY` for Telegram voice transcription

Create a `.env` file:

```bash
mkdir -p ~/.codex-cli-over-telegram
cd ~/.codex-cli-over-telegram
nano .env
```

Paste this:

```text
TELEGRAM_BOT_TOKEN=123456:telegram-token
ALLOWED_TELEGRAM_USER_IDS=
ALLOWED_TELEGRAM_USER_IDS_FILE=./data/allowed-telegram-users.txt
ALLOWED_TELEGRAM_CHAT_IDS=
ALLOWED_TELEGRAM_CHAT_IDS_FILE=./data/allowed-telegram-chats.txt
TELEGRAM_APPROVAL_CHAT_ID=
TELEGRAM_APPROVAL_MESSAGE_THREAD_ID=0
ALLOWED_REPO_ROOTS=/home/you
DATABASE_PATH=./state.sqlite
CODEX_BACKEND=app-server
DEFAULT_MODEL_PROVIDER=openai
OPENAI_TIERED_MODELS=gpt-5.5
OPENAI_SERVICE_TIERS=fast,flex
XAI_MODELS=grok-build-0.1,grok-4.3
GROK_AGENT_COMMAND=grok
GROK_AGENT_ARGS=agent,stdio
CLAUDE_MODELS=sonnet,opus,fable
CLAUDE_ACP_COMMAND=./node_modules/.bin/claude-agent-acp
CLAUDE_ACP_ARGS=
ALLOW_UNTHREADED_CHATS=true
CODEX_ALWAYS_YOLO=false
TELEGRAM_SEND_INTERVAL_MS=3500
TELEGRAM_AGENT_STREAMING=true
TELEGRAM_STREAM_FLUSH_MS=1000
TELEGRAM_STREAM_MIN_CHARS=120
MAX_TELEGRAM_FILE_BYTES=20971520
OPENAI_API_KEY=
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-transcribe
FFMPEG_BIN=ffmpeg
```

To use Grok Build through ACP, install and sign in as the service user:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

For systemd, use an absolute `GROK_AGENT_COMMAND` such as `/home/gnu/.local/bin/grok` if `grok` is not on the service `PATH`.

To use Claude through ACP, install this app's dependencies and authenticate Claude for the service user:

```bash
npm install
claude auth
```

The default `CLAUDE_ACP_COMMAND` uses the repo-local `./node_modules/.bin/claude-agent-acp` adapter installed by npm. Set `CLAUDE_MODELS` to the Claude model aliases you want to show in `/models`.

Start Codex CLI over Telegram:

```bash
npx github:guerrerocarlos/codex-cli-over-telegram
```

Send any message to the bot. If `ALLOWED_TELEGRAM_USER_IDS` or `ALLOWED_TELEGRAM_CHAT_IDS` is blank, Codex CLI over Telegram replies with the exact IDs to put in `.env`.

If an authorized user talks to the bot from a new, unauthorized group, the bot sends an approval request with an inline button to `TELEGRAM_APPROVAL_CHAT_ID`. When `TELEGRAM_APPROVAL_CHAT_ID` is blank, the first allowed chat is used, with `TELEGRAM_APPROVAL_MESSAGE_THREAD_ID=0` targeting the main topic. Approved chats are appended to `ALLOWED_TELEGRAM_CHAT_IDS_FILE` and become active immediately without editing the systemd env file.

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
/create ~/new-project-folder
/where
/provider
/provider xai
/provider claude
/models
/model
/model gpt-5.5
/model gpt-5.5 fast
/model xai:grok-build-0.1
/model claude:sonnet
/plan outline the implementation before editing
/planon
/planoff
/mode read
/mode write
/status
/stop
/new
/compact
/dashboard
/topics
/todo
/work
/work_add prepare launch checklist
/work_done 7 verified in production
/work_blocked 8 waiting on credentials
/diff
/commit Commit message
/push
/ask do something specific
/queue do this after the current run
/cron 0 * * * * check whether the task is complete and continue if needed
/cron support 0 9 * * 1-5 summarize open support work
/cron list
/cron off 3
```

Normal messages in a bound chat/topic are sent to Codex. During an active app-server run, normal messages are sent as steering notes to the current turn. Use `/queue <prompt>` when you want the message to wait as the next turn, similar to queueing in the Codex TUI. Use `/ask` if Telegram privacy mode prevents the bot from seeing ordinary group messages.

Use `/create <folder>` to create a new folder inside `ALLOWED_REPO_ROOTS`, create a Telegram forum topic, and bind that new topic to the folder. If the folder already exists, the bot still creates and binds the topic and reports that it reused the existing folder. Relative paths are created under the first allowed root; `~/...` and absolute paths are accepted when they stay inside an allowed root. The bot must be allowed to manage forum topics, and `ALLOW_UNTHREADED_CHATS=true` is required when Telegram sends the general topic without a `message_thread_id`.

Every bound topic behaves the same way, including the general topic when unthreaded chats are enabled and bound. Use `/dashboard` to see topic activity across the chat, `/topics` to list bound topics, and `/todo` to show explicit work items plus running, queued, and failed runs. Use `/work_add <title>` inside a bound topic to create a persistent work item, or `/work_add <topic-id-or-name> <title>` from a manager topic. Use `/work`, `/work all`, `/work_done <id> <evidence>`, `/work_blocked <id> <reason>`, and `/work_cancel <id> <reason>` to supervise that queue.

Use `/cron` to attach recurring prompts to a topic with standard five-field cron syntax. In a bound topic, `/cron 0 * * * * <prompt>` schedules that topic; from a manager topic, `/cron <topic-id-or-name> 0 * * * * <prompt>` schedules another bound topic. Use `/cron list` to inspect schedules and `/cron off <id>` to disable one.

In app-server mode, Codex runs get a local `telegram_manager` MCP bridge with tools to list topics, queue prompts into topics, create bound topics, create/list/disable cron jobs, create/list/update/complete work items, and read recently stored topic messages. Telegram does not expose arbitrary old topic history to bots, so message history tools can only return messages observed after this bot-side storage was enabled.

The bot publishes its slash-command menu to Telegram on startup, so newly added commands may require a service restart before they appear in Telegram's `/` picker.

Images, documents, audio, video, and other Telegram files are saved into the bound repository's `.context/` directory using the original filename when Telegram provides one, then sent to Codex as local paths only once there is text to act on. Uploads with captions start a run immediately and use the caption as the instruction. Uploads without captions are staged for the next text message or captioned upload in that topic. A caption starting with `/ask` is also supported.

Voice messages are saved into `.context/`, converted with `ffmpeg` when Telegram sends an OpenAI-unsupported audio container, transcribed with the OpenAI API, saved as a `.transcript.txt` file, and then sent to Codex as the user's prompt. Set `OPENAI_API_KEY` before using voice transcription.

The bot pins the message that triggers each run and leaves the latest prompt pinned after completion so the task remains easy to find.

If the service restarts while runs are queued or active, it requeues those saved runs on startup and posts a notice in each affected Telegram topic. Queued runs start from the saved prompt. Interrupted running runs resume the saved Codex thread with a continue-style prompt instead of replaying the original prompt from scratch.

Use `/compact` to ask Codex app-server to compact the current topic's saved thread. Use `/new` to clear the saved thread id for the topic; the next prompt starts a new Codex thread with clean context. `/status` shows the latest thread context token usage once Codex has reported it for that topic.

## YOLO Mode

To make every Codex run use `danger-full-access` with approvals disabled:

```text
CODEX_ALWAYS_YOLO=true
```

Restart Codex CLI over Telegram after changing it.

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

Codex CLI over Telegram includes a systemd service named `codex-cli-over-telegram`.

Pick the Linux user that should own Codex auth, config, repos, and runtime state. The examples below use variables so you can use your own account.

```bash
export SERVICE_USER="$USER"
export SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
export SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
export APP_DIR="$SERVICE_HOME/codex-cli-over-telegram"
export STATE_DIR="$SERVICE_HOME/.local/state/codex-cli-over-telegram"
```

1. Clone the repo into the service directory:

```bash
cd "$SERVICE_HOME"
git clone https://github.com/guerrerocarlos/codex-cli-over-telegram.git
cd "$APP_DIR"
npm install
```

2. Make sure Codex works as the service user:

```bash
codex --version
codex
```

Log in or finish Codex setup if the CLI prompts you. The service uses `$SERVICE_HOME/.codex`.

3. Install the systemd unit:

```bash
sudo install -d -m 0750 -o root -g "$SERVICE_GROUP" /etc/codex-cli-over-telegram
sudo install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_DIR"
sudo cp deploy/systemd/codex-cli-over-telegram.service /etc/systemd/system/codex-cli-over-telegram.service
sudo sed -i \
  -e "s|^User=.*|User=$SERVICE_USER|" \
  -e "s|^Group=.*|Group=$SERVICE_GROUP|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
  -e "s|^Environment=HOME=.*|Environment=HOME=$SERVICE_HOME|" \
  -e "s|^ExecStart=.*|ExecStart=/usr/bin/node $APP_DIR/dist/index.js|" \
  /etc/systemd/system/codex-cli-over-telegram.service
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
ALLOWED_TELEGRAM_USER_IDS_FILE=./data/allowed-telegram-users.txt
ALLOWED_TELEGRAM_CHAT_IDS=-1001234567890
ALLOWED_TELEGRAM_CHAT_IDS_FILE=./data/allowed-telegram-chats.txt
TELEGRAM_APPROVAL_CHAT_ID=
TELEGRAM_APPROVAL_MESSAGE_THREAD_ID=0
ALLOWED_REPO_ROOTS=/path/to/allowed/repos
DATABASE_PATH=/path/to/service-home/.local/state/codex-cli-over-telegram/state.sqlite
CODEX_BIN=codex
CODEX_BACKEND=app-server
DEFAULT_MODEL_PROVIDER=openai
OPENAI_TIERED_MODELS=gpt-5.5
OPENAI_SERVICE_TIERS=fast,flex
XAI_MODELS=grok-build-0.1,grok-4.3
GROK_AGENT_COMMAND=/home/gnu/.local/bin/grok
GROK_AGENT_ARGS=agent,stdio
CLAUDE_MODELS=sonnet,opus,fable
CLAUDE_ACP_COMMAND=/path/to/app/node_modules/.bin/claude-agent-acp
CLAUDE_ACP_ARGS=
DEFAULT_SANDBOX_MODE=read-only
CODEX_ALWAYS_YOLO=false
ALLOW_UNTHREADED_CHATS=true
MAX_PARALLEL_RUNS=4
MAX_TELEGRAM_MESSAGE_CHARS=3500
TELEGRAM_SEND_INTERVAL_MS=3500
TELEGRAM_AGENT_STREAMING=true
TELEGRAM_STREAM_FLUSH_MS=1000
TELEGRAM_STREAM_MIN_CHARS=120
MAX_TELEGRAM_FILE_BYTES=20971520
OPENAI_API_KEY=sk-...
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-transcribe
FFMPEG_BIN=ffmpeg
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8787
MANAGER_REPO_PATH=~/topic-zero
MANAGER_BRIDGE_TOKEN=
```

Then lock it down:

```bash
sudo chown root:"$SERVICE_GROUP" /etc/codex-cli-over-telegram/env
sudo chmod 0640 /etc/codex-cli-over-telegram/env
```

5. Deploy, enable startup, and start the service:

```bash
SERVICE_USER="$SERVICE_USER" SERVICE_GROUP="$SERVICE_GROUP" APP_DIR="$APP_DIR" STATE_DIR="$STATE_DIR" ./scripts/deploy.sh
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

Codex CLI over Telegram exposes:

```bash
curl -fsS http://127.0.0.1:8787/health
```

## Fleet Portability

The live SQLite database remains the runtime source of truth for topic bindings, Codex thread ids, cron jobs, work items, and recent runs. For portability, export a sanitized snapshot into a manager repository:

```bash
npm run build
npm run fleet:export -- \
  --manifest ~/inglesconliza-manager/fleet.json \
  --database ~/codex-cli-over-telegram/data/state.sqlite \
  --out ~/inglesconliza-manager/snapshots/telegram-state/latest.json
```

For a daily backup that commits and pushes the manager repo:

```bash
MANAGER_REPO=~/inglesconliza-manager \
DATABASE_PATH=~/codex-cli-over-telegram/data/state.sqlite \
./scripts/backup-fleet-state.sh
```

This repo also includes systemd units for this backup:

```bash
sudo cp deploy/systemd/codex-cli-over-telegram-fleet-backup.service /etc/systemd/system/
sudo cp deploy/systemd/codex-cli-over-telegram-fleet-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now codex-cli-over-telegram-fleet-backup.timer
```

The timer runs daily at `03:17` local time and uses `Persistent=true`, so missed backups run after the machine comes back online.

On another machine, clone the manager repo and use its manifest to clone missing repos and restore known topic bindings:

```bash
npm run fleet:restore -- \
  --manifest ~/inglesconliza-manager/fleet.json \
  --database ~/codex-cli-over-telegram/data/state.sqlite \
  --clone
```

Add `--create-topics` when the target Telegram group needs new forum topics and `TELEGRAM_BOT_TOKEN` is available. Existing `codexThreadId` values are exported as soft state only; the durable recovery path is repo-owned context such as `AGENTS.md` and `docs/agent/STATE.md`.

## Security

Telegram access to Codex CLI over Telegram is remote control of your allowed folders.

Keep these tight:

```text
ALLOWED_TELEGRAM_USER_IDS=
ALLOWED_TELEGRAM_USER_IDS_FILE=./data/allowed-telegram-users.txt
ALLOWED_TELEGRAM_CHAT_IDS=
ALLOWED_TELEGRAM_CHAT_IDS_FILE=./data/allowed-telegram-chats.txt
TELEGRAM_APPROVAL_CHAT_ID=
TELEGRAM_APPROVAL_MESSAGE_THREAD_ID=0
ALLOWED_REPO_ROOTS=
```

Only enable `CODEX_ALWAYS_YOLO=true` on a machine and Telegram group you fully trust.
