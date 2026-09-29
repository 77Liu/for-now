#!/usr/bin/env bash
set -euo pipefail
umask 0077

exec 9>/run/lock/for-now-backup.lock
flock -n 9 || exit 0

set -a
source /etc/for-now.env
set +a

: "${DATA_DIR:=/srv/for-now/data}"
: "${OSS_DESTINATION:?OSS_DESTINATION is required}"
: "${OSS_ENDPOINT:?OSS_ENDPOINT is required}"
: "${OSS_REGION:?OSS_REGION is required}"
if [ "${PERSISTENCE_BACKEND:-json}" = postgres ]; then
  : "${PG_BACKUP_DATABASE_URL:?PG_BACKUP_DATABASE_URL is required for PostgreSQL backups}"
fi

backup_dir=/var/backups/for-now
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$backup_dir/for-now-$stamp.tar.gz"
checksum="$archive.sha256"
service_was_active=0
export_stage=

mkdir -p "$backup_dir"
if systemctl is-active --quiet for-now.service; then
  service_was_active=1
  systemctl stop for-now.service
fi

restore_service() {
  if [ -n "$export_stage" ]; then rm -rf "$export_stage"; export_stage=; fi
  if [ "$service_was_active" -eq 1 ]; then
    systemctl start for-now.service
  fi
}
trap restore_service EXIT

if [ "${PERSISTENCE_BACKEND:-json}" = postgres ]; then
  export_stage=$(mktemp -d "$backup_dir/.postgres-export.XXXXXX")
  export_args=(--data-dir "$DATA_DIR" --output-dir "$export_stage/source")
  if [ "${ATTACHMENT_STORAGE:-local}" = oss ]; then export_args+=(--allow-remote-attachments); fi
  /usr/local/bin/node /opt/for-now/app/scripts/export-postgres.mjs "${export_args[@]}"
  if [ -d "$DATA_DIR/logs" ]; then cp -a "$DATA_DIR/logs" "$export_stage/source/"; fi
  for user_directory in "$export_stage/source/users/"*; do
    [ -d "$user_directory" ] || continue
    source_logs="$DATA_DIR/users/$(basename "$user_directory")/logs"
    if [ -d "$source_logs" ]; then cp -a "$source_logs" "$user_directory/"; fi
  done
  /usr/local/bin/node /opt/for-now/app/scripts/stage-backup-data.mjs \
    --source-dir "$export_stage/source" --output-dir "$export_stage/data" \
    --materialized --source-storage postgres-export
else
  export_stage=$(mktemp -d "$backup_dir/.json-export.XXXXXX")
  stage_args=(--source-dir "$DATA_DIR" --output-dir "$export_stage/data" --source-storage "${ATTACHMENT_STORAGE:-local}")
  if [ "${ATTACHMENT_STORAGE:-local}" = oss ]; then stage_args+=(--allow-remote-attachments); fi
  /usr/local/bin/node /opt/for-now/app/scripts/stage-backup-data.mjs "${stage_args[@]}"
fi
tar --exclude='*.tmp' -C "$export_stage/data" -czf "$archive" .
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
