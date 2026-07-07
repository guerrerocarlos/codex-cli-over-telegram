# Agent Runbook

## Health Check

```bash
curl -fsS http://127.0.0.1:8787/health
```

Expected production metadata fields:

- `branch`
- `commitHash`
- `deployedAt`

## Service Status

```bash
systemctl is-active codex-cli-over-telegram.service
systemctl status codex-cli-over-telegram.service --no-pager
```

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
