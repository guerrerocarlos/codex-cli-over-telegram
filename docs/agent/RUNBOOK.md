# Agent Runbook

## Health Check

Reasoning controls in an OpenAI-bound topic: `/reasoning` shows the selection,
`/reasoning high` sets it, and `/reasoning default` clears it. Applies next run.
Verify with `npm run build` and `node --test tests/reasoning.test.mjs`.

```bash
curl -fsS http://127.0.0.1:8787/health
```

Expected production metadata fields:

- `branch`
- `commitHash`
- `deployedAt`
- `telegramBotStarted`

The endpoint returns HTTP `503` until the Telegram bot has completed startup and long-polling is active. A response with only the HTTP health server up is not considered healthy.

## Per-Topic Folder Restriction

Inside a bound Telegram topic:

```text
/restrict on
/restrict off
```

`/restrict on` forces that topic to ignore `CODEX_ALWAYS_YOLO`, keeps read-only topics read-only, maps write-capable topics to `workspace-write`, and removes the Telegram manager MCP bridge from app-server runs. `/where` and `/status` show the current restriction state.

## Per-Topic Mention-Only Mode

Inside a bound Telegram topic:

```text
/mention on
/mention off
```

`/mention on` keeps ordinary group chatter from starting or steering Codex unless the message mentions the bot username. Explicit commands such as `/ask`, `/queue`, and `/plan` still trigger Codex. Uploads without a bot mention are ignored instead of staged. `/where` and `/status` show the current mention-only state.

## Verify Manager Bridge Chat Scope

When topic creation or `telegram_manager.list_topics` appears to use the wrong Telegram group, replay the bridge with the intended chat id pinned:

```bash
MANAGER_BRIDGE_CHAT_ID=-1004477958494 node dist/managerBridgeMcp.js
```

Send MCP `initialize`, then call `list_topics`. The returned topics should belong to the pinned chat. App-server runs depend on `mcp_servers.telegram_manager.env_vars` forwarding `MANAGER_BRIDGE_URL`, `MANAGER_BRIDGE_TOKEN`, and `MANAGER_BRIDGE_CHAT_ID` into the stdio MCP process.

## Service Status

```bash
systemctl is-active codex-cli-over-telegram.service
systemctl is-enabled codex-cli-over-telegram.service
systemctl status codex-cli-over-telegram.service --no-pager
```

The production unit is the system service in `/etc/systemd/system/`. A disabled or inactive `systemctl --user status codex-cli-over-telegram.service` result does not describe the production bot.

## Manager Topic Settings and Scoped Maintenance

The `telegram_manager` MCP exposes `set_topic_mode` and `set_topic_model` for topics bound to the current Telegram chat. Modes are limited to `read-only` and `workspace-write`; unrestricted `danger-full-access` is not available through the manager bridge. Model selections are checked against the configured provider catalog. Both settings apply to future runs. `list_topics` reports the stored and effective sandbox mode plus topic model preference.

To start a Codex session with writes scoped to this checkout:

```bash
scripts/codex-service.sh codex
```

One-command server setup and guarded update (run from the `gnu` account in a normal host terminal where `sudo` works):

```bash
scripts/codex-service.sh setup-and-update
```

The command installs a root-owned fixed helper and a sudo rule limited to its `prepare` and `restart` operations. It fast-forwards a clean `main` checkout from `origin/main`, runs tests/build, preserves and reapplies the known `src/fleetSnapshot.ts` local edit, ignores only superseded run225 for restart preflight and startup recovery, restarts the exact service, and requires `/health` to report the deployed commit. It refuses other dirty files and local commits not pushed to origin. It never replays run225 or changes its database row. `update` can be run later after setup. `codex` separately launches a repo-scoped writable Codex session.

## Approve a New Telegram User

When an unknown user messages the bot in an approved chat, the bot sends an approval card to the configured management topic. An already approved operator must select **Approve user**. The user ID is appended to `ALLOWED_TELEGRAM_USER_IDS_FILE` and is active immediately.

## Use Text-only Mode

Inside a bound topic, use:

```text
/textonly on
```

This hides technical execution output and diffs from that topic. Use `/textonly off` to restore normal technical output.

If a topic reports `Reconnecting...`, inspect that topic's recent runs in `data/state.sqlite`. App-server `error` notifications can be retry notices; only `turn/completed` determines the turn's final status. Do not replay printer cron jobs automatically because they may duplicate physical output.

## Restart/Deploy

```bash
systemctl start codex-cli-over-telegram-deploy.service
```

The deploy script restarts the system unit and waits for `/health` to return `ok: true` with `telegramBotStarted: true`.

## Inspect Active Runs

```bash
node - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('data/state.sqlite', { readonly: true });
console.log(JSON.stringify(db.prepare(`
  SELECT r.id, r.binding_id, b.topic_name, b.chat_id, b.message_thread_id,
         b.repo_path, r.status, r.started_at, r.completed_at, r.error_message,
         substr(r.prompt, 1, 240) AS prompt
  FROM runs r
  JOIN topic_bindings b ON b.id = r.binding_id
  WHERE r.status IN ('queued', 'running')
  ORDER BY r.id
`).all(), null, 2));
NODE
```

## Inspect Generated Images

Codex image generation may create files in the global cache instead of the bound repo:

```bash
find ~/.codex/generated_images -type f \
  \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' \) \
  -printf '%TY-%Tm-%Td %TH:%TM:%TS %s %p\n' | sort | tail -n 40
```

If a Telegram topic says images were shown but Telegram did not receive them, compare the run's Codex thread id with the cache subdirectory under `~/.codex/generated_images/`.

## Inspect Chat Migration Failures

```bash
journalctl -u codex-cli-over-telegram.service -n 200 --no-pager -o short-iso \
  | rg 'migrate_to_chat_id|group chat was upgraded|telegram chat migrated'
```

If Telegram reports `migrate_to_chat_id`, update durable rows that still point at the old chat id:

```bash
node - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('data/state.sqlite');
const oldChatId = -5568898498;
const newChatId = -1004361900873;
const newBindingId = 32;
const now = new Date().toISOString();
db.prepare('UPDATE cron_jobs SET chat_id = ?, binding_id = ?, last_error = NULL, updated_at = ? WHERE chat_id = ?')
  .run(newChatId, newBindingId, now, oldChatId);
NODE
```

## Inspect Missing Telegram Threads

Permanent Telegram errors such as `message thread not found` usually mean a bound topic was deleted or the binding points at the wrong group. They should not crash the service, but they still require live-state cleanup:

```bash
journalctl -u codex-cli-over-telegram.service -n 200 --no-pager -o short-iso \
  | rg 'message thread not found|failed to send restart resume notice|run queue task failed'
```

Then inspect the affected binding/run in SQLite:

```bash
RUN_ID=1252
node - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('data/state.sqlite', { readonly: true });
const runId = Number(process.env.RUN_ID);
console.log(JSON.stringify(db.prepare(`
  SELECT r.id, r.status, r.error_message, b.id AS binding_id, b.topic_name,
         b.chat_id, b.message_thread_id, b.repo_path
  FROM runs r
  JOIN topic_bindings b ON b.id = r.binding_id
  WHERE r.id = ?
`).get(runId), null, 2));
NODE
```

## Inspect Recent Messages For A Chat

```bash
CHAT_ID=-1004391890477
node - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('data/state.sqlite', { readonly: true });
const chatId = Number(process.env.CHAT_ID);
console.log(JSON.stringify(db.prepare(`
  SELECT tm.id, tm.chat_id, tm.message_thread_id, b.topic_name,
         tm.direction, tm.author_name, tm.text, tm.created_at,
         tm.telegram_message_id
  FROM topic_messages tm
  LEFT JOIN topic_bindings b
    ON b.chat_id = tm.chat_id AND b.message_thread_id = tm.message_thread_id
  WHERE tm.chat_id = ?
  ORDER BY tm.id DESC
  LIMIT 100
`).all(chatId), null, 2));
NODE
```

## Inspect Stuck Telegram Sends

If messages appear stuck while runs are active, check for repeated send retries:

```bash
journalctl -u codex-cli-over-telegram.service --since '30 minutes ago' --no-pager -o short-iso \
  | rg 'telegram send transient failure|telegram send failed|dropping message|telegram send rate limited'
```

The send queue now drops one outbound message after repeated transient or rate-limit failures, then continues with later messages. Dropped sends are logged with chat id, topic id, error, and a short text preview. Run-output sends treat a dropped queue result as a delivery failure. If a run is marked completed but the user reports no visible reply, inspect the run `final_message` and the journal for dropped Telegram sends, then resend the saved final message after the transport is healthy.

## Inspect Plugin And App Approvals

Codex app-server plugin permission requests should appear in the same bound Telegram topic as the active run. Use the inline buttons to approve for the current turn, approve for the current Codex session, or deny the request. The app-server protocol supports `turn` and `session` scopes, not a permanent forever scope.

App and connector install/connect prompts can arrive as `mcpServer/elicitation/request`, not only `item/permissions/requestApproval`. These should also appear in the active Telegram topic as app approval requests.

Recent approval requests and resolutions are audited in SQLite:

```bash
node - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('data/state.sqlite', { readonly: true });
console.log(JSON.stringify(db.prepare(`
  SELECT timestamp, chat_id, message_thread_id, event_type, details_json
  FROM audit_events
  WHERE event_type IN (
    'permission_approval_requested',
    'permission_approval_resolved',
    'elicitation_approval_requested',
    'elicitation_approval_resolved'
  )
  ORDER BY id DESC
  LIMIT 20
`).all(), null, 2));
NODE
```

If a connector approval does not show, inspect logs for declined app-server requests:

```bash
journalctl -u codex-cli-over-telegram.service --since '30 minutes ago' --no-pager -o short-iso \
  | rg 'mcpServer/elicitation/request|app-server elicitation approval requested|declining app-server request'
```

## Unsupported model recovery

- Run `npm run build` and `node --test tests/modelFallback.test.mjs tests/reasoning.test.mjs` for fallback and existing reasoning regression coverage.
- The fallback recognizes only `The '<model>' model is not supported when using Codex with a ChatGPT account.` or the exact 400 invalid_request_error envelope. It resolves the repo-effective model via `config/read`; no alternate model is hard-coded.
- It retries once before observed work and persists the explicit model for later resumes. Check `unsupported_model_fallback` audit entries, final run status and topic model. Quota, network, generic model errors and post-work failures never trigger this retry.
- Build/push does not activate code already loaded in the bridge. Drain active and queued workers, then follow the existing restart procedure and verify health commit plus a controlled no-tools rejection fixture. Never restart during active work merely to activate this improvement.
- Until activation, `/model <configured-supported-model>` in the affected topic explicitly changes resumed-thread selection. `/model default` clears the override but can retain a stale resumed-thread model. `/new` clears conversational soft state when a new thread is appropriate.

- Rollout note for the 2026-10-20 fix: the working tree contains an unrelated modification to `src/fleetSnapshot.ts`. Local verification rebuilt ignored `dist` from this mixed working tree. Activate from a clean checkout of the intended committed revision, or separately verify and include that modification first. Do not restart against these mixed build artifacts by accident.
