# Agent Runbook

## Health Check

```bash
curl -fsS http://127.0.0.1:8787/health
```

Expected production metadata fields:

- `branch`
- `commitHash`
- `deployedAt`

## Per-Topic Folder Restriction

Inside a bound Telegram topic:

```text
/restrict on
/restrict off
```

`/restrict on` forces that topic to ignore `CODEX_ALWAYS_YOLO`, keeps read-only topics read-only, maps write-capable topics to `workspace-write`, and removes the Telegram manager MCP bridge from app-server runs. `/where` and `/status` show the current restriction state.

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

## Restart/Deploy

```bash
systemctl start codex-cli-over-telegram-deploy.service
```

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
