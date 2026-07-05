#!/usr/bin/env bash
set -euo pipefail

app_dir="${APP_DIR:-/home/gnu/codex-cli-over-telegram}"
manager_repo="${MANAGER_REPO:-/home/gnu/inglesconliza-manager}"
database_path="${DATABASE_PATH:-$app_dir/data/state.sqlite}"
manifest_path="${FLEET_MANIFEST:-$manager_repo/fleet.json}"
push_flag="${PUSH_FLEET_BACKUP:-true}"

args=(
  fleet:backup
  --
  --manager-repo "$manager_repo"
  --manifest "$manifest_path"
  --database "$database_path"
)

if [ "$push_flag" = "true" ]; then
  args+=(--push)
fi

npm --prefix "$app_dir" run "${args[@]}"
