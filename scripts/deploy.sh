#!/usr/bin/env bash
set -euo pipefail

service_name="${SERVICE_NAME:-codex-cli-over-telegram}"
service_user="${SERVICE_USER:-gnu}"
service_group="${SERVICE_GROUP:-gnu}"
app_dir="${APP_DIR:-/home/gnu/codex-cli-over-telegram}"
env_dir="${ENV_DIR:-/etc/codex-cli-over-telegram}"
state_dir="${STATE_DIR:-/home/gnu/.local/state/codex-cli-over-telegram}"
health_url="${HEALTH_URL:-http://127.0.0.1:8787/health}"

npm ci
npm test
npm run build

branch="$(git rev-parse --abbrev-ref HEAD)"
commit_hash="$(git rev-parse HEAD)"
deployed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

sudo install -d -m 0755 -o "$service_user" -g "$service_group" "$app_dir"
sudo install -d -m 0750 -o root -g "$service_group" "$env_dir"
sudo install -d -m 0750 -o "$service_user" -g "$service_group" "$state_dir"
source_dir="$(pwd -P)"
app_dir_real="$(cd "$app_dir" && pwd -P)"
sudo tee "$env_dir/deploy.env" >/dev/null <<EOF
DEPLOY_BRANCH=$branch
DEPLOY_COMMIT_HASH=$commit_hash
DEPLOYED_AT=$deployed_at
EOF

if [ "$source_dir" != "$app_dir_real" ]; then
  sudo rsync -a --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude data \
    ./ "$app_dir/"
  sudo chown -R "$service_user:$service_group" "$app_dir"

  sudo -u "$service_user" npm --prefix "$app_dir" ci --omit=dev
fi
sudo systemctl restart "$service_name"
curl -fsS "$health_url"
