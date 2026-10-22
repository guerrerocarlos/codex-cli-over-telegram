#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
service="codex-cli-over-telegram.service"
helper_path="/usr/local/sbin/codex-cli-over-telegram-maintenance"

[[ "$(id -un)" == "gnu" ]] || { echo "Run from the gnu account that owns the service checkout." >&2; exit 1; }
command -v codex >/dev/null || { echo "codex CLI not found in PATH" >&2; exit 1; }

db_path="$(node --input-type=module - "$repo_dir" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
const root = process.argv[2];
let env = {};
try { env = dotenv.parse(fs.readFileSync('/etc/codex-cli-over-telegram/env')); } catch {}
console.log(path.resolve(root, env.DATABASE_PATH || './data/state.sqlite'));
NODE
)"

active_runs_present() {
  [[ -f "$db_path" ]] || return 1
  node --input-type=module - "$db_path" <<'NODE'
import Database from 'better-sqlite3';
import fs from 'node:fs';
import dotenv from 'dotenv';
const env = dotenv.parse(fs.readFileSync('/etc/codex-cli-over-telegram/env'));
const superseded = new Set(['225', ...(env.CODEX_SUPERSEDED_RUN_IDS || '').split(',').map(value => value.trim()).filter(Boolean)]);
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
try {
  const active = db.prepare("SELECT id, status FROM runs WHERE status IN ('queued','running') ORDER BY id").all()
    .filter(run => !superseded.has(String(run.id)));
  if (active.length) {
    console.log(JSON.stringify(active));
  }
  process.exitCode = active.length ? 0 : 1;
} finally { db.close(); }
NODE
}

if active="$(active_runs_present)"; then
  echo "Skipping Codex CLI update: queued/running task(s) exist: $active"
  exit 0
fi
before="$(codex --version)"
sudo -n "$helper_path" update-cli
after="$(codex --version)"
printf 'Codex CLI version: %s -> %s\n' "$before" "$after"

[[ "$before" != "$after" ]] || exit 0
if active="$(active_runs_present)"; then
  echo "Codex CLI updated without restart: queued/running task(s) started: $active"
  exit 0
fi
sudo -n "$helper_path" restart
expected_commit="$(git -C "$repo_dir" rev-parse HEAD)"
for attempt in {1..20}; do
  if health="$(curl -fsS http://127.0.0.1:8787/health 2>/dev/null)" && \
    node -e 'const h=JSON.parse(process.argv[1]); process.exit(h.ok && h.telegramBotStarted && h.commitHash === process.argv[2] ? 0 : 1)' "$health" "$expected_commit"; then
    printf '%s\n' "$health"
    exit 0
  fi
  sleep 2
done
echo "Codex CLI updated, but Telegram health did not become ready. Inspect journalctl -u $service." >&2
exit 1
