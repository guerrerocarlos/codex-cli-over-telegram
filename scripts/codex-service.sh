#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
service="codex-cli-over-telegram.service"
sudoers_file="/etc/sudoers.d/codex-cli-over-telegram-restart"

usage() {
  cat <<'EOF'
Usage: scripts/codex-service.sh <codex|grant-reload|update>

  codex       Start Codex with write access scoped to this repository.
  grant-reload Install a sudo rule allowing only restart of this exact service.
  update      Fast-forward from origin/main, run tests/build, check active runs, restart, and verify health.
EOF
}

case "${1:-}" in
  codex)
    shift
    command -v codex >/dev/null || { echo "codex CLI not found in PATH" >&2; exit 1; }
    exec codex --sandbox workspace-write --ask-for-approval never \
      -c sandbox_workspace_write.network_access=true -C "$repo_dir" "$@"
    ;;
  grant-reload)
    if [[ "$(id -u)" -eq 0 ]]; then echo "Run this command as your normal user, without sudo." >&2; exit 1; fi
    command -v sudo >/dev/null || { echo "sudo is required" >&2; exit 1; }
    command -v visudo >/dev/null || { echo "visudo is required to validate the rule" >&2; exit 1; }
    user="$(id -un)"
    rule="$user ALL=(root) NOPASSWD: /usr/bin/systemctl restart $service"
    temp_rule="$(mktemp)"
    trap 'rm -f "$temp_rule"' EXIT
    printf '%s\n' "$rule" > "$temp_rule"
    visudo -cf "$temp_rule"
    sudo install -o root -g root -m 0440 "$temp_rule" "$sudoers_file"
    sudo visudo -cf "$sudoers_file"
    echo "Installed narrow permission: this user can restart only $service through systemctl."
    ;;
  update|reload)
    shift
    if [[ $# -ne 0 ]]; then usage; exit 2; fi
    if [[ "$(id -un)" != "gnu" ]]; then echo "Run from the gnu account that owns the service checkout." >&2; exit 1; fi
    if [[ -n "$(git -C "$repo_dir" status --porcelain)" ]]; then
      echo "Refusing service reload: checkout has uncommitted changes. Commit or preserve them first." >&2
      git -C "$repo_dir" status --short >&2
      exit 1
    fi
    if [[ "$(git -C "$repo_dir" branch --show-current)" != "main" ]]; then echo "Refusing service reload: expected the main branch." >&2; exit 1; fi
    git -C "$repo_dir" fetch --quiet origin main
    read -r ahead behind < <(git -C "$repo_dir" rev-list --left-right --count HEAD...origin/main)
    if [[ "$ahead" -ne 0 ]]; then
      echo "Refusing service update: local main has commits not present on origin/main." >&2
      exit 1
    fi
    if [[ "$behind" -gt 0 ]]; then git -C "$repo_dir" merge --ff-only origin/main; fi
    npm ci
    npm test
    npm run build
    node --test tests/*.test.mjs
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
    if [[ -f "$db_path" ]]; then
      node --input-type=module - "$db_path" <<'NODE'
import Database from 'better-sqlite3';
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
try {
  const active = db.prepare("SELECT id, status FROM runs WHERE status IN ('queued','running') ORDER BY id").all();
  if (active.length) {
    console.error(`Refusing restart: ${active.length} queued/running task(s) exist: ${JSON.stringify(active)}`);
    process.exitCode = 1;
  }
} finally { db.close(); }
NODE
    fi
    sudo -n /usr/bin/systemctl restart "$service"
    for attempt in {1..20}; do
      if health="$(curl -fsS http://127.0.0.1:8787/health 2>/dev/null)" && \
        node -e 'const h=JSON.parse(process.argv[1]); process.exit(h.ok && h.telegramBotStarted && h.commitHash ? 0 : 1)' "$health"; then
        printf '%s\n' "$health"
        exit 0
      fi
      sleep 2
    done
    echo "Restart ran, but Telegram health did not become ready. Inspect journalctl -u $service." >&2
    exit 1
    ;;
  *) usage; exit 2 ;;
esac
