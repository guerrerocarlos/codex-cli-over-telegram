# Telegram Codex Wrapper Implementation

## Goal

Build a Telegram bot that lets an authorized user control Codex on an always-on development machine without opening an SSH session. The bot should support many repositories from one Telegram forum group by binding each Telegram topic to its own Codex workspace and conversation.

The core routing model is:

```text
Telegram chat_id + message_thread_id -> repo path + Codex thread/session + run queue
```

Each Telegram topic behaves like a separate Codex workspace console. Messages sent in that topic are routed to the Codex thread bound to that topic, and bot responses are posted back into the same topic.

## Source Interfaces

Use documented programmatic surfaces instead of the interactive terminal UI:

- Codex SDK: preferred long-term integration because it supports programmatic threads and repeated turns.
- Codex app-server: default backend for richer client features such as streamed events, interrupts, active-turn steering, and explicit thread lifecycle control.
- `codex exec --json`: fallback because it is stable, scriptable, and emits machine-readable JSONL events.

Do not embed, scrape, or drive the Ratatui terminal UI. Telegram is the UI, and Codex should be controlled through SDK/app-server/exec.

Relevant docs:

- Codex SDK: `https://developers.openai.com/codex/sdk`
- Codex app-server: `https://developers.openai.com/codex/app-server`
- Codex non-interactive mode: `https://developers.openai.com/codex/noninteractive`
- Telegram Bot API message topics: `https://core.telegram.org/bots/api`

## High-Level Architecture

```text
Telegram forum group
        |
        | updates with chat_id + message_thread_id
        v
Telegram bot service
        |
        | validates sender, command, topic binding, repo lock
        v
SQLite state store
        |
        | dispatches prompt or command
        v
Codex backend adapter
        |
        | SDK/app-server or codex exec --json
        v
local repo checkout / git worktree / local tools
```

The bot service is the only network-facing integration. Codex runs locally on the host and should not expose app-server directly to the public internet.

## Technology Choices

Use TypeScript for the first implementation:

- Runtime: Node.js 20 or newer.
- Telegram library: `grammy`.
- Database: SQLite using `better-sqlite3` or `drizzle-orm` with SQLite.
- Codex integration:
  - Default: app-server stdio adapter.
  - Fallback: `codex exec --json` child process adapter.
- Process supervisor: systemd for a VPS or always-on Linux dev machine.
- Optional HTTP server: Fastify for `/health` and metrics.

Python is also viable with `python-telegram-bot` and `openai-codex`, but TypeScript keeps the Telegram bot and Codex SDK integration in one ecosystem.

## Telegram Setup

1. Create a bot with BotFather.
2. Add the bot to a Telegram supergroup.
3. Enable forum topics in the group.
4. Make the bot an admin if it needs to create, rename, or manage topics.
5. Configure the bot token as `TELEGRAM_BOT_TOKEN`.
6. Configure allowed Telegram users:

```text
ALLOWED_TELEGRAM_USER_IDS=12345678,23456789
ALLOWED_TELEGRAM_CHAT_IDS=-1001234567890
```

Every incoming message must pass both checks:

- The `from.id` is allowlisted.
- The `chat.id` is allowlisted.

For group forum topics, Telegram includes `message_thread_id` on messages posted inside a topic. When replying, the bot must pass the same `message_thread_id` to `sendMessage`.

## Topic Model

One Telegram topic maps to one logical Codex session.

```text
Topic "todex"
  chat_id: -1001234567890
  message_thread_id: 42
  repo_path: /home/gnu/todex
  codex_thread_id: thr_...
  sandbox_mode: workspace-write
  status: idle

Topic "api-service"
  chat_id: -1001234567890
  message_thread_id: 77
  repo_path: /srv/api-service
  codex_thread_id: thr_...
  sandbox_mode: read-only
  status: running
```

Do not run multiple write-capable Codex turns against the same working tree at the same time. If two topics need to work on the same repository concurrently, create separate git worktrees and bind each topic to a different worktree path.

## Process Model

Do not literally keep one permanent OS-level Codex process per Telegram topic unless the app-server adapter requires it. Prefer this model:

- One long-running Telegram bot process.
- One SQLite database.
- One Codex thread/session record per Telegram topic.
- One in-memory queue per topic.
- One repo-level write lock per repo path.
- Codex runs are started only when a prompt or command needs them.

This keeps idle topics cheap while preserving separate conversation state.

## SQLite Schema

### `authorized_users`

```sql
CREATE TABLE authorized_users (
  telegram_user_id INTEGER PRIMARY KEY,
  username TEXT,
  created_at TEXT NOT NULL
);
```

### `topic_bindings`

```sql
CREATE TABLE topic_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_thread_id INTEGER NOT NULL,
  topic_name TEXT,
  repo_path TEXT NOT NULL,
  codex_thread_id TEXT,
  sandbox_mode TEXT NOT NULL DEFAULT 'read-only',
  approval_policy TEXT NOT NULL DEFAULT 'never',
  status TEXT NOT NULL DEFAULT 'idle',
  created_by_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chat_id, message_thread_id)
);
```

### `runs`

```sql
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  binding_id INTEGER NOT NULL REFERENCES topic_bindings(id),
  telegram_message_id INTEGER,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  codex_run_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  exit_code INTEGER,
  final_message TEXT,
  error_message TEXT
);
```

### `repo_locks`

```sql
CREATE TABLE repo_locks (
  repo_path TEXT PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  lock_mode TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
```

### `audit_events`

```sql
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  telegram_user_id INTEGER,
  chat_id INTEGER,
  message_thread_id INTEGER,
  event_type TEXT NOT NULL,
  details_json TEXT NOT NULL
);
```

## Bot Commands

### Required MVP Commands

```text
/bind <absolute_repo_path>
```

Bind the current Telegram topic to a repository path. The path must exist, be inside an allowlisted root, and be a git repository unless explicitly configured otherwise.

```text
/where
```

Show the current topic binding, Codex thread/session ID, sandbox mode, active run status, and git branch.

```text
/new
```

Start a fresh Codex thread/session for this topic without changing the repo binding.

```text
/mode read
/mode write
```

Set sandbox mode for future prompts in this topic:

- `read`: `read-only`
- `write`: `workspace-write`

Do not expose `danger-full-access` as a normal command.

```text
/status
```

Show whether the topic has a queued or running Codex turn.

```text
/stop
```

Interrupt the active Codex run for this topic if the backend supports interruption. For `codex exec`, terminate the child process group.

```text
/diff
```

Run `git diff --stat` and `git diff --shortstat`, then optionally send the full diff as a file if it exceeds Telegram message limits.

```text
/commit <message>
```

Commit changes in the bound repo. This should only commit changes inside the bound repo and should refuse if the repo has suspicious unrelated changes unless the user passes an explicit override command.

```text
/help
```

Show command syntax.

### Useful Follow-Up Commands

```text
/branch
/branch <name>
/pull
/push
/logs <run_id>
/threads
/resume <codex_thread_id>
/unbind
/lock
/unlock
/worktree <branch_or_name>
```

`/push` should be explicit. The general project preference is to commit and push at task completion, but a Telegram-controlled bot should still make the action visible in the topic.

## Plain Message Handling

If a message is not a command:

1. Validate sender and chat.
2. Require `message_thread_id`.
3. Load the topic binding.
4. Refuse if the topic is not bound.
5. Enqueue the prompt for that topic.
6. If no run is active for the topic, start the next run.
7. Reply in the same topic with progress and final result.

Example:

```text
User in topic "todex":
  review the current diff and fix any obvious test failure

Bot:
  Started run #184 in /home/gnu/todex on branch main with workspace-write.

Bot:
  Running tests...

Bot:
  Completed run #184.
  Summary:
  ...
```

## Concurrency Rules

### Per-Topic Queue

Only one Codex turn can run per Telegram topic at a time. Additional messages are queued.

### Per-Repo Write Lock

Only one write-capable run can operate on a repo path at a time.

Rules:

- `read-only` runs can run concurrently with other `read-only` runs.
- `workspace-write` runs require an exclusive lock for the repo path.
- If a repo is locked, the bot tells the user which topic/run holds the lock.
- Locks must expire or be recoverable after process crashes.

### Worktree Recommendation

For many simultaneous tasks on one repository, use git worktrees:

```bash
git worktree add ../todex-feature-a -b codex/feature-a
git worktree add ../todex-feature-b -b codex/feature-b
```

Then bind separate Telegram topics:

```text
Topic A: /bind /home/gnu/todex-feature-a
Topic B: /bind /home/gnu/todex-feature-b
```

## Codex Backend Adapter

Define an internal interface so the Telegram layer is independent from the Codex control mechanism:

```ts
type SandboxMode = "read-only" | "workspace-write";

interface CodexRunRequest {
  bindingId: number;
  repoPath: string;
  prompt: string;
  codexThreadId?: string;
  sandboxMode: SandboxMode;
  approvalPolicy: "never";
}

interface CodexRunEvent {
  type:
    | "started"
    | "progress"
    | "command_started"
    | "command_completed"
    | "file_changed"
    | "agent_message_delta"
    | "completed"
    | "failed";
  text?: string;
  raw?: unknown;
}

interface CodexBackend {
  run(request: CodexRunRequest): AsyncIterable<CodexRunEvent>;
  interrupt(bindingId: number): Promise<void>;
}
```

### Default: Codex app-server

The implementation uses `codex app-server --stdio` locally and drives the V2 protocol:

- `initialize`
- `thread/start`
- `thread/resume`
- `turn/start`
- `turn/steer`
- `turn/interrupt`

This supports active-turn steering: if a user sends an ordinary Telegram message
while a run is active in the same topic, the bot attempts `turn/steer` instead
of queueing the message as the next run.

Approval and elicitation server requests are currently declined automatically
because the bot runs with `approvalPolicy = "never"` and has not implemented
Telegram approve/deny buttons yet.

### Fallback: `codex exec --json`

Use `child_process.spawn`:

```bash
codex exec --json \
  --cd "$REPO_PATH" \
  --sandbox read-only \
  --ask-for-approval never \
  "$PROMPT"
```

For write mode:

```bash
codex exec --json \
  --cd "$REPO_PATH" \
  --sandbox workspace-write \
  --ask-for-approval never \
  "$PROMPT"
```

Implementation details:

- Parse `stdout` as JSONL.
- Treat `stderr` as progress/debug output, but do not spam Telegram.
- Extract final agent messages from completed agent message events.
- Store the Codex session/thread ID if present in `thread.started`.
- Use `codex exec resume <SESSION_ID>` only when the session ID is known and compatible with the current repo.
- Kill the entire child process group on `/stop`.

Phase 1 limitation: interactive approvals are not practical. Use narrow sandbox modes and explicit bot commands instead.

### Phase 2: Codex SDK or App-Server

Move to SDK/app-server once the MVP works.

Benefits:

- Persistent Codex threads per Telegram topic.
- Cleaner streaming events.
- More reliable interruption.
- Better support for approvals and steering active turns.
- Easier resume/fork behavior.

App-server should be started locally over stdio or a Unix socket. Do not expose it directly to the public internet. If WebSocket is needed, bind only to localhost or a private mesh network and require app-server auth.

## Telegram Output Strategy

Telegram messages have practical length limits, and noisy streaming makes topics hard to read. Use a compact default:

- Send one "started" message.
- Edit or replace a short status message for progress.
- Send notable command starts/completions.
- Send final response.
- Send large diffs/logs as documents.

Recommended output modes:

```text
/verbose on
/verbose off
```

Default `verbose off` should summarize:

- active command
- files changed
- tests run
- final message

Verbose mode can show more raw Codex events.

## Security Model

Telegram control of Codex is equivalent to remote control of a development machine. Treat it as sensitive.

Required protections:

- Allowlist Telegram user IDs.
- Allowlist Telegram chat IDs.
- Allowlist repository root directories, for example `/home/gnu` and `/srv/dev`.
- Require absolute paths for `/bind`.
- Refuse symlink escapes outside allowed roots.
- Default to `read-only`.
- Require `/mode write` before edits.
- Do not expose `danger-full-access` in normal commands.
- Never print secrets, token files, or full environment variables.
- Do not pass OpenAI or Codex credentials as broad process-wide env vars.
- Store Telegram bot token in an environment file readable only by the service user.
- Run the bot as a non-root user.
- Keep Codex sandboxing enabled.

Recommended repository allowlist:

```text
ALLOWED_REPO_ROOTS=/home/gnu,/srv/dev
```

Path validation must resolve real paths before checking:

```text
requested path -> realpath -> startsWith any ALLOWED_REPO_ROOTS
```

## Approval Handling

MVP:

- Use `approval_policy=never`.
- Control safety through sandbox mode and command allowlists.
- If Codex cannot complete a task without an approval, it should fail and report the reason.

Enhanced app-server mode:

- Convert approval requests into Telegram inline buttons:
  - Approve once
  - Deny
  - Show details
- Only the original authorized user or a configured admin can approve.
- Store all approvals in `audit_events`.
- Time out approvals after a short duration.

## Git Operations

Codex may modify files, but the bot should own explicit git lifecycle commands.

### `/diff`

Run:

```bash
git status --short
git diff --stat
git diff --shortstat
```

Send full diff only when requested or as an attached file.

### `/commit <message>`

Before committing:

1. Verify repo is bound to the current topic.
2. Verify no other write run is active.
3. Show `git status --short`.
4. Stage only files under the repo.
5. Commit with the provided message.
6. Report commit hash.

The bot should not commit unrelated changes unless the user explicitly asks it to include them.

### `/push`

Push current branch:

```bash
git push origin HEAD
```

Report remote and branch. If no upstream exists, fail with a clear message and suggest:

```bash
git push -u origin HEAD
```

The project preference says task completion should commit and push changes. For bot UX, implement that as an explicit visible action at the end of a Telegram task:

```text
Codex completed the task and produced changes.
Suggested next actions:
  /diff
  /commit <message>
  /push
```

If automatic commit/push is enabled later, make it topic-specific and visible:

```text
/autopush on
/autopush off
```

## Health Endpoint

Because this bot is a backend service, expose deployment metadata on `/health`.

Response:

```json
{
  "ok": true,
  "service": "telegram-codex-wrapper",
  "branch": "main",
  "commitHash": "full-git-commit-hash",
  "deployedAt": "2026-06-11T13:45:00.000Z"
}
```

Inject metadata at deploy time:

```bash
export DEPLOY_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
export DEPLOY_COMMIT_HASH="$(git rev-parse HEAD)"
export DEPLOYED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
```

The service should only return `unknown` for these fields in local development.

## Configuration

Environment variables:

```text
TELEGRAM_BOT_TOKEN=
ALLOWED_TELEGRAM_USER_IDS=
ALLOWED_TELEGRAM_CHAT_IDS=
ALLOWED_REPO_ROOTS=/home/gnu,/srv/dev
DATABASE_PATH=/var/lib/telegram-codex-wrapper/state.sqlite
CODEX_BIN=codex
DEFAULT_SANDBOX_MODE=read-only
MAX_PARALLEL_RUNS=4
MAX_TELEGRAM_MESSAGE_CHARS=3500
HEALTH_PORT=8787
DEPLOY_BRANCH=unknown
DEPLOY_COMMIT_HASH=unknown
DEPLOYED_AT=unknown
```

Store secrets in a systemd environment file:

```text
/etc/telegram-codex-wrapper/env
```

Permissions:

```bash
sudo chown root:codexbot /etc/telegram-codex-wrapper/env
sudo chmod 0640 /etc/telegram-codex-wrapper/env
```

## systemd Service

Example unit:

```ini
[Unit]
Description=Telegram Codex Wrapper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=codexbot
Group=codexbot
WorkingDirectory=/opt/telegram-codex-wrapper
EnvironmentFile=/etc/telegram-codex-wrapper/env
ExecStart=/usr/bin/node /opt/telegram-codex-wrapper/dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/telegram-codex-wrapper /home/gnu /srv/dev

[Install]
WantedBy=multi-user.target
```

Adjust `ReadWritePaths` to the exact repository roots the bot is allowed to manage.

## Deployment Script

`scripts/deploy.sh` should:

1. Run tests.
2. Build the TypeScript project.
3. Compute deployment metadata.
4. Write or update the systemd environment file.
5. Restart the service.
6. Verify `/health`.

Pseudo-flow:

```bash
#!/usr/bin/env bash
set -euo pipefail

npm ci
npm test
npm run build

branch="$(git rev-parse --abbrev-ref HEAD)"
commit_hash="$(git rev-parse HEAD)"
deployed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

sudo install -d -m 0750 -o root -g codexbot /etc/telegram-codex-wrapper
sudo tee /etc/telegram-codex-wrapper/deploy.env >/dev/null <<EOF
DEPLOY_BRANCH=$branch
DEPLOY_COMMIT_HASH=$commit_hash
DEPLOYED_AT=$deployed_at
EOF

sudo systemctl restart telegram-codex-wrapper
curl -fsS http://127.0.0.1:8787/health
```

The production environment file can include both secret config and deploy metadata, or systemd can load two files:

```ini
EnvironmentFile=/etc/telegram-codex-wrapper/env
EnvironmentFile=/etc/telegram-codex-wrapper/deploy.env
```

## Error Handling

Common user-facing errors:

- Topic is not bound: "Use `/bind <repo path>` in this topic first."
- User not authorized: ignore or send a generic denial.
- Repo lock held: "Repo is busy in topic X, run #Y."
- Codex command failed: include exit code and final stderr summary.
- Prompt too long: ask user to attach a file or split the request.
- Telegram send failed: retry with exponential backoff.
- Process crashed: mark active runs as failed on restart unless the backend can resume them.

On service startup:

1. Open SQLite.
2. Mark any `running` runs as `failed` with `error_message='service restarted'`.
3. Clear stale repo locks.
4. Start polling Telegram.
5. Start HTTP health server.

## Logging and Audit

Log structured JSON to stdout for systemd/journald:

```json
{
  "level": "info",
  "event": "run_started",
  "chatId": -1001234567890,
  "messageThreadId": 42,
  "repoPath": "/home/gnu/todex",
  "runId": 184
}
```

Audit events to persist:

- `/bind`
- `/mode`
- prompt submitted
- run started
- run completed or failed
- `/stop`
- approval decision
- commit
- push

Never store raw secrets in audit logs.

## MVP Build Plan

### Milestone 1: Bot Skeleton

- Create TypeScript project.
- Add `grammy`, SQLite, and health server.
- Implement config loading and allowlist checks.
- Implement `/health`.
- Implement `/help`.

### Milestone 2: Topic Binding

- Add SQLite schema and migrations.
- Implement `/bind`, `/where`, `/mode`, `/new`, `/unbind`.
- Validate repo paths and git repositories.
- Reply in the correct `message_thread_id`.

### Milestone 3: Codex Exec Adapter

- Implement `CodexBackend` using `codex exec --json`.
- Parse JSONL events.
- Send compact progress updates.
- Store run records.
- Implement `/stop`.

### Milestone 4: Git Helpers

- Implement `/status`, `/diff`, `/commit`, `/push`.
- Add repo locks for write runs.
- Add careful staging and commit reporting.

### Milestone 5: Multi-Repo Hardening

- Add per-topic queues.
- Add repo-level read/write lock behavior.
- Add stale lock cleanup.
- Add worktree guidance in `/help`.

### Milestone 6: App-Server or SDK Adapter

- Add a second `CodexBackend` implementation.
- Persist and resume Codex thread IDs.
- Add approval support through Telegram inline buttons if app-server events expose approval requests.
- Add active-turn steering if supported.

## Example User Flow

Create a Telegram topic called `todex`, then:

```text
/bind /home/gnu/todex
/mode write
review the current repo and make a plan, but do not edit yet
implement the first step
/diff
/commit Add Telegram Codex wrapper implementation plan
/push
```

Create another topic called `api-service`, then:

```text
/bind /srv/api-service
/mode read
summarize the recent failures from the test logs
```

Both topics can be used from the same group. The bot keeps their Codex thread/session state separate.

## Open Questions

- Should the bot auto-create Telegram topics for known repositories, or should topics be created manually?
- Should `/commit` and `/push` be separate commands, or should topic-level `/autopush on` be supported?
- Should the first implementation use `codex exec --json` only, or start directly with SDK/app-server?
- Should repository bindings be restricted to a static allowlist instead of root-based validation?
- Should Codex approvals be exposed in Telegram from day one, or deferred until the app-server adapter?

## Recommendation

Build the MVP with `codex exec --json` first. It proves the Telegram workflow, topic routing, repository locking, and operational model with the least moving parts. Keep the Codex backend behind an interface so SDK/app-server can replace `codex exec` once the bot UX is validated.
