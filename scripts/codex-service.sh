#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
service="codex-cli-over-telegram.service"
sudoers_file="/etc/sudoers.d/codex-cli-over-telegram-restart"
helper_path="/usr/local/sbin/codex-cli-over-telegram-maintenance"

usage() {
  cat <<'EOF'
Usage: scripts/codex-service.sh <codex|grant-reload|update|setup-and-update>

  codex       Start Codex with write access scoped to this repository.
  grant-reload Install a sudo rule allowing guarded service restart and Codex CLI update.
  update      Fast-forward from origin/main, run tests/build, check active runs, restart, and verify health.
  setup-and-update Install narrow access and perform the guarded update.
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
    temp_helper="$(mktemp)"
    temp_rule="$(mktemp)"
    trap 'rm -f "$temp_helper" "$temp_rule"' EXIT
    cat > "$temp_helper" <<'ROOT_HELPER'
#!/usr/bin/env bash
set -euo pipefail
env_file="/etc/codex-cli-over-telegram/env"
deploy_file="/etc/codex-cli-over-telegram/deploy.env"
app_dir="/home/gnu/codex-cli-over-telegram"
case "${1:-}" in
  prepare)
    [[ $# -eq 1 && -f "$env_file" ]] || exit 2
    current="$(awk -F= '$1 == "CODEX_SUPERSEDED_RUN_IDS" { print $2; exit }' "$env_file")"
    declare -A seen=()
    ids=()
    for id in 225 ${current//,/ }; do
      [[ "$id" =~ ^[0-9]+$ ]] || { echo "Invalid superseded run id in service env" >&2; exit 1; }
      if [[ -z "${seen[$id]+x}" ]]; then ids+=("$id"); seen[$id]=1; fi
    done
    tmp="$(mktemp /etc/codex-cli-over-telegram/env.XXXXXX)"
    trap 'rm -f "$tmp"' EXIT
    awk -F= '$1 != "CODEX_SUPERSEDED_RUN_IDS" { print }' "$env_file" > "$tmp"
    joined="$(IFS=,; printf '%s' "${ids[*]}")"
    printf 'CODEX_SUPERSEDED_RUN_IDS=%s\n' "$joined" >> "$tmp"
    chown root:gnu "$tmp"
    chmod 0640 "$tmp"
    mv -f "$tmp" "$env_file"
    ;;
  restart)
    [[ $# -eq 1 ]] || exit 2
    branch="$(/usr/sbin/runuser -u gnu -- /usr/bin/git -C "$app_dir" branch --show-current)"
    commit="$(/usr/sbin/runuser -u gnu -- /usr/bin/git -C "$app_dir" rev-parse HEAD)"
    [[ "$branch" == main && "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid deployment revision" >&2; exit 1; }
    deployed_at="$(/usr/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
    tmp="$(mktemp /etc/codex-cli-over-telegram/deploy.env.XXXXXX)"
    trap 'rm -f "$tmp"' EXIT
    printf 'DEPLOY_BRANCH=%s\nDEPLOY_COMMIT_HASH=%s\nDEPLOYED_AT=%s\n' "$branch" "$commit" "$deployed_at" > "$tmp"
    chown root:gnu "$tmp"
    chmod 0640 "$tmp"
    mv -f "$tmp" "$deploy_file"
    /usr/bin/systemctl restart codex-cli-over-telegram.service
    ;;
  update-cli)
    [[ $# -eq 1 ]] || exit 2
    /usr/bin/codex update
    ;;
  *) exit 2 ;;
esac
ROOT_HELPER
    bash -n "$temp_helper"
    user="$(id -un)"
    rule="$user ALL=(root) NOPASSWD: $helper_path prepare, $helper_path restart, $helper_path update-cli"
    printf '%s\n' "$rule" > "$temp_rule"
    visudo -cf "$temp_rule"
    sudo install -o root -g root -m 0755 "$temp_helper" "$helper_path"
    sudo install -o root -g root -m 0440 "$temp_rule" "$sudoers_file"
    sudo visudo -cf "$sudoers_file"
    rm -f "$temp_rule" "$temp_helper"
    trap - EXIT
    echo "Installed narrow permission: this user can restart $service and update the Codex CLI through the fixed helper."
    ;;
  setup-and-update)
    "$0" grant-reload
    "$0" update
    ;;
  update|reload)
    shift
    if [[ $# -ne 0 ]]; then usage; exit 2; fi
    if [[ "$(id -un)" != "gnu" ]]; then echo "Run from the gnu account that owns the service checkout." >&2; exit 1; fi
    preserved_stash=""
    initial_status="$(git -C "$repo_dir" status --porcelain=v1 --untracked-files=all)"
    if [[ -n "$initial_status" ]]; then
      while IFS= read -r line; do
        [[ "${line:3}" == "src/fleetSnapshot.ts" ]] || {
          echo "Refusing update: only the known src/fleetSnapshot.ts edit can be preserved automatically." >&2
          git -C "$repo_dir" status --short >&2
          exit 1
        }
      done <<< "$initial_status"
      git -C "$repo_dir" stash push -m "codex-service update preserves fleetSnapshot edit" -- src/fleetSnapshot.ts >/dev/null
      preserved_stash="$(git -C "$repo_dir" rev-parse -q --verify refs/stash)"
      restore_preserved() {
        if ! git -C "$repo_dir" stash pop --index "$preserved_stash"; then
          echo "The local fleetSnapshot edit remains safely preserved in stash $preserved_stash; resolve it manually." >&2
        fi
      }
      trap restore_preserved EXIT
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
import fs from 'node:fs';
import dotenv from 'dotenv';
const env = dotenv.parse(fs.readFileSync('/etc/codex-cli-over-telegram/env'));
const superseded = new Set(['225', ...(env.CODEX_SUPERSEDED_RUN_IDS || '').split(',').map(value => value.trim()).filter(Boolean)]);
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
try {
  const active = db.prepare("SELECT id, status FROM runs WHERE status IN ('queued','running') ORDER BY id").all()
    .filter(run => !superseded.has(String(run.id)));
  if (active.length) {
    console.error(`Refusing restart: ${active.length} queued/running task(s) exist: ${JSON.stringify(active)}`);
    process.exitCode = 1;
  }
} finally { db.close(); }
NODE
    fi
    sudo -n "$helper_path" prepare
    sudo -n "$helper_path" restart
    expected_commit="$(git -C "$repo_dir" rev-parse HEAD)"
    for attempt in {1..20}; do
      if health="$(curl -fsS http://127.0.0.1:8787/health 2>/dev/null)" && \
        node -e 'const h=JSON.parse(process.argv[1]); process.exit(h.ok && h.telegramBotStarted && h.commitHash === process.argv[2] ? 0 : 1)' "$health" "$expected_commit"; then
        printf '%s\n' "$health"
        if [[ -n "$preserved_stash" ]]; then restore_preserved; trap - EXIT; fi
        exit 0
      fi
      sleep 2
    done
    echo "Restart ran, but Telegram health did not become ready. Inspect journalctl -u $service." >&2
    exit 1
    ;;
  *) usage; exit 2 ;;
esac
