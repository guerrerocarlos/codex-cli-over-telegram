#!/usr/bin/env bash
set -euo pipefail

service_name="${SERVICE_NAME:-codex-cli-over-telegram}"
app_dir="${APP_DIR:-/opt/codex-cli-over-telegram}"
env_dir="${ENV_DIR:-/etc/codex-cli-over-telegram}"
state_dir="${STATE_DIR:-/var/lib/codex-cli-over-telegram}"
health_url="${HEALTH_URL:-http://127.0.0.1:8787/health}"

npm ci
npm test
npm run build

branch="$(git rev-parse --abbrev-ref HEAD)"
commit_hash="$(git rev-parse HEAD)"
deployed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

sudo install -d -m 0755 -o root -g root "$app_dir"
sudo install -d -m 0750 -o root -g codexbot "$env_dir"
sudo install -d -m 0750 -o codexbot -g codexbot "$state_dir"
sudo tee "$env_dir/deploy.env" >/dev/null <<EOF
DEPLOY_BRANCH=$branch
DEPLOY_COMMIT_HASH=$commit_hash
DEPLOYED_AT=$deployed_at
EOF

sudo rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude data \
  ./ "$app_dir/"

sudo npm --prefix "$app_dir" ci --omit=dev
sudo systemctl restart "$service_name"
curl -fsS "$health_url"
