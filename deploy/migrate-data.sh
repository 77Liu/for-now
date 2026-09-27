#!/usr/bin/env bash
set -euo pipefail

target=${1:-}
if [ -z "$target" ]; then
  echo "Usage: $0 user@server" >&2
  exit 1
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ssh_key=${SSH_KEY:-"$root/.secrets/for-now-deploy"}
ssh_port=${SSH_PORT:-22}
ssh_args=(-i "$ssh_key" -p "$ssh_port" -o IdentitiesOnly=yes)

if [ ! -f "$ssh_key" ]; then
  echo "SSH key not found: $ssh_key" >&2
  exit 1
fi

remote_prepare='
set -e
if sudo test -f /srv/for-now/data/auth.json; then
  echo "Refusing migration: cloud registration already exists." >&2
  exit 2
fi
sudo install -d -o for-now -g for-now -m 0700 /srv/for-now/data
if sudo test -f /srv/for-now/data/store.json; then
  sudo cp -a /srv/for-now/data "/srv/for-now/data.pre-migration.$(date +%Y%m%d%H%M%S)"
fi
sudo tar -xzf - -C /srv/for-now/data
sudo chown -R for-now:for-now /srv/for-now/data
sudo chmod 0700 /srv/for-now/data
sudo find /srv/for-now/data -type f -name "*.json" -exec chmod 0600 {} +
'

tar -C "$root/data" -czf - store.json llm-settings.json attachments \
  | ssh "${ssh_args[@]}" "$target" "$remote_prepare"

echo "Data and attachments migrated. The first invited account will become their owner."
