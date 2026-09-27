#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if ! id for-now >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/for-now --shell /usr/sbin/nologin for-now
fi

install -d -o for-now -g for-now -m 0750 /opt/for-now /opt/for-now/releases
install -d -o for-now -g for-now -m 0700 /srv/for-now/data /home/for-now/.ssh
install -d -o root -g root -m 0700 /var/backups/for-now
install -d -o root -g root -m 0755 /var/www/app-portal /etc/nginx/snippets

if [ ! -f /home/for-now/.ssh/gitee_deploy ]; then
  sudo -u for-now ssh-keygen -q -t ed25519 -N "" -C "for-now-server-deploy" -f /home/for-now/.ssh/gitee_deploy
fi

install -o root -g root -m 0644 "$script_dir/for-now.service" /etc/systemd/system/for-now.service
install -o root -g root -m 0644 "$script_dir/for-now-backup.service" /etc/systemd/system/for-now-backup.service
install -o root -g root -m 0644 "$script_dir/for-now-backup.timer" /etc/systemd/system/for-now-backup.timer
install -o root -g root -m 0755 "$script_dir/deploy.sh" /usr/local/sbin/for-now-deploy
install -o root -g root -m 0755 "$script_dir/backup-to-oss.sh" /usr/local/sbin/for-now-backup
install -o root -g root -m 0644 "$script_dir/portal.html" /var/www/app-portal/index.html
install -o root -g root -m 0644 "$script_dir/nginx-for-now.conf" /etc/nginx/snippets/for-now.conf
if [ ! -f /etc/for-now.env ]; then
  install -o root -g root -m 0600 "$script_dir/for-now.env.example" /etc/for-now.env
fi
systemctl daemon-reload

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer must be installed as /usr/bin/node before deployment." >&2
elif [ "$(node -p 'Number(process.versions.node.split(\".\")[0])')" -lt 20 ]; then
  echo "Current Node.js is too old. Install Node.js 20 or newer before deployment." >&2
fi

echo
echo "Add this public key to Gitee as a read-only deploy key:"
cat /home/for-now/.ssh/gitee_deploy.pub
echo
echo "Then set INVITE_CODE_HASH in /etc/for-now.env and run: sudo for-now-deploy"
