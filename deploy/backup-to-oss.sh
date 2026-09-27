#!/usr/bin/env bash
set -euo pipefail

exec 9>/run/lock/for-now-backup.lock
flock -n 9 || exit 0

set -a
source /etc/for-now.env
set +a

: "${DATA_DIR:=/srv/for-now/data}"
: "${OSS_DESTINATION:?OSS_DESTINATION is required}"
: "${OSS_ENDPOINT:?OSS_ENDPOINT is required}"
: "${OSS_REGION:?OSS_REGION is required}"

backup_dir=/var/backups/for-now
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$backup_dir/for-now-$stamp.tar.gz"
checksum="$archive.sha256"
service_was_active=0

mkdir -p "$backup_dir"
if systemctl is-active --quiet for-now.service; then
  service_was_active=1
  systemctl stop for-now.service
fi

restore_service() {
  if [ "$service_was_active" -eq 1 ]; then
    systemctl start for-now.service
  fi
}
trap restore_service EXIT

tar --exclude='*.tmp' -C "$DATA_DIR" -czf "$archive" .
sha256sum "$archive" > "$checksum"
restore_service
service_was_active=0
trap - EXIT

ossutil cp "$archive" "$OSS_DESTINATION/" --mode EcsRamRole --endpoint "$OSS_ENDPOINT" --region "$OSS_REGION"
ossutil cp "$checksum" "$OSS_DESTINATION/" --mode EcsRamRole --endpoint "$OSS_ENDPOINT" --region "$OSS_REGION"
install -d -o for-now -g for-now -m 0700 /var/lib/for-now-monitor
touch /var/lib/for-now-monitor/last-backup-success
chown for-now:for-now /var/lib/for-now-monitor/last-backup-success
chmod 0600 /var/lib/for-now-monitor/last-backup-success
find "$backup_dir" -type f -name 'for-now-*.tar.gz*' -mtime +7 -delete
