#!/usr/bin/env bash
set -euo pipefail

service_name="${SERVICE_NAME:-codex-cli-over-telegram}"
service_user="${SERVICE_USER:-gnu}"
env_dir="${ENV_DIR:-/etc/codex-cli-over-telegram}"
env_file="$env_dir/env"
unit_path="/etc/systemd/system/$service_name.service"
sudoers_path="/etc/sudoers.d/$service_name-trusted-wsl"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

if ! id "$service_user" >/dev/null 2>&1; then
  echo "Unknown SERVICE_USER: $service_user" >&2
  exit 1
fi

if [ ! -f "$unit_path" ]; then
  echo "Missing systemd unit: $unit_path" >&2
  exit 1
fi

if [ ! -f "$env_file" ]; then
  echo "Missing env file: $env_file" >&2
  exit 1
fi

sed -i \
  -e "s|^NoNewPrivileges=.*|NoNewPrivileges=false|" \
  -e "s|^PrivateTmp=.*|PrivateTmp=false|" \
  -e "s|^ProtectSystem=.*|ProtectSystem=false|" \
  -e "/^ReadWritePaths=/d" \
  "$unit_path"

if grep -q "^CODEX_ALWAYS_YOLO=" "$env_file"; then
  sed -i "s|^CODEX_ALWAYS_YOLO=.*|CODEX_ALWAYS_YOLO=true|" "$env_file"
else
  printf '\nCODEX_ALWAYS_YOLO=true\n' >>"$env_file"
fi

cat >"$sudoers_path" <<EOF
$service_user ALL=(ALL) NOPASSWD:ALL
EOF
chmod 0440 "$sudoers_path"
visudo -cf "$sudoers_path" >/dev/null

systemctl daemon-reload
systemctl restart "$service_name.service"
systemctl status "$service_name.service" --no-pager
