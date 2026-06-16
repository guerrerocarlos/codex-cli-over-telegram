#!/usr/bin/env bash
set -euo pipefail

service_name="${SERVICE_NAME:-codex-cli-over-telegram}"
service_user="${SERVICE_USER:-gnu}"
service_group="${SERVICE_GROUP:-gnu}"
app_dir="${APP_DIR:-/home/gnu/codex-cli-over-telegram}"
env_dir="${ENV_DIR:-/etc/codex-cli-over-telegram}"
state_dir="${STATE_DIR:-/home/gnu/.local/state/codex-cli-over-telegram}"
health_url="${HEALTH_URL:-http://127.0.0.1:8787/health}"
env_file_source="${ENV_FILE_SOURCE:-}"
unit_source="${UNIT_SOURCE:-deploy/systemd/codex-cli-over-telegram.service}"
unit_path="/etc/systemd/system/$service_name.service"
service_home="$(getent passwd "$service_user" | cut -d: -f6)"
read_write_paths="${READ_WRITE_PATHS:-$service_home}"

npm ci
npm test
npm run build

branch="$(git rev-parse --abbrev-ref HEAD)"
commit_hash="$(git rev-parse HEAD)"
deployed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

sudo install -d -m 0755 -o "$service_user" -g "$service_group" "$app_dir"
sudo install -d -m 0750 -o root -g "$service_group" "$env_dir"
sudo install -d -m 0750 -o "$service_user" -g "$service_group" "$state_dir"
if [ ! -f "$env_dir/env" ]; then
  if [ -z "$env_file_source" ] && [ -f ".env" ]; then
    env_file_source=".env"
  fi

  if [ -z "$env_file_source" ]; then
    echo "Missing $env_dir/env. Set ENV_FILE_SOURCE=/path/to/env for first deploy." >&2
    exit 1
  fi

  sudo install -m 0640 -o root -g "$service_group" "$env_file_source" "$env_dir/env"
fi
source_dir="$(pwd -P)"
app_dir_real="$(cd "$app_dir" && pwd -P)"
sudo tee "$env_dir/deploy.env" >/dev/null <<EOF
DEPLOY_BRANCH=$branch
DEPLOY_COMMIT_HASH=$commit_hash
DEPLOYED_AT=$deployed_at
EOF
sudo chown root:"$service_group" "$env_dir/deploy.env"
sudo chmod 0640 "$env_dir/deploy.env"

sudo install -m 0644 -o root -g root "$unit_source" "$unit_path"
sudo sed -i \
  -e "s|^User=.*|User=$service_user|" \
  -e "s|^Group=.*|Group=$service_group|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=$app_dir|" \
  -e "s|^Environment=HOME=.*|Environment=HOME=$service_home|" \
  -e "s|^Environment=PATH=.*|Environment=PATH=$service_home/.local/bin:$service_home/.grok/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin|" \
  -e "s|^ExecStart=.*|ExecStart=/usr/bin/node $app_dir/dist/index.js|" \
  -e "s|^ReadWritePaths=.*|ReadWritePaths=$read_write_paths|" \
  "$unit_path"
sudo systemctl daemon-reload

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
for attempt in {1..20}; do
  if health_response="$(curl -fsS "$health_url" 2>/dev/null)"; then
    printf '%s\n' "$health_response"
    exit 0
  fi
  sleep 1
done

echo "Service did not become healthy at $health_url" >&2
sudo systemctl status "$service_name" --no-pager >&2 || true
exit 1
