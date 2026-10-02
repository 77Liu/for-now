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
ready_wait_seconds=${BACKUP_READY_TIMEOUT_SECONDS:-30}
service_was_active=0
export_stage=
success_dir=/var/lib/for-now-monitor
success_marker="$success_dir/last-backup-success"
success_marker_tmp=

case "$ready_wait_seconds" in
  ''|*[!0-9]*|0)
    echo "BACKUP_READY_TIMEOUT_SECONDS must be a positive integer." >&2
    exit 2
    ;;
esac

cleanup_temporary_files() {
  if [ -n "$export_stage" ]; then rm -rf "$export_stage"; export_stage=; fi
  if [ -n "$success_marker_tmp" ]; then rm -f "$success_marker_tmp"; success_marker_tmp=; fi
}

recover_on_exit() {
  status=$?
  trap - EXIT
  set +e
  cleanup_temporary_files
  if [ "$service_was_active" -eq 1 ]; then
    if ! systemctl start for-now.service; then
      echo "Backup failed and for-now.service recovery also failed." >&2
    fi
  fi
  exit "$status"
}

wait_for_service_ready() {
  deadline=$((SECONDS + ready_wait_seconds))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --connect-timeout 1 --max-time 1 http://127.0.0.1:4173/readyz >/dev/null 2>&1; then
      return 0
    fi
    if [ "$SECONDS" -lt "$deadline" ]; then sleep 1; fi
  done
  echo "for-now.service did not become ready within $ready_wait_seconds seconds." >&2
  return 1
}

trap recover_on_exit EXIT

mkdir -p "$backup_dir"
if systemctl is-active --quiet for-now.service; then
  service_was_active=1
  systemctl stop for-now.service
fi

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
cleanup_temporary_files

if [ "$service_was_active" -eq 1 ]; then
  systemctl start for-now.service
  wait_for_service_ready
fi

ossutil cp "$archive" "$OSS_DESTINATION/" --mode EcsRamRole --endpoint "$OSS_ENDPOINT" --region "$OSS_REGION"
ossutil cp "$checksum" "$OSS_DESTINATION/" --mode EcsRamRole --endpoint "$OSS_ENDPOINT" --region "$OSS_REGION"
find "$backup_dir" -type f -name 'for-now-*.tar.gz*' -mtime +7 -delete
install -d -o for-now -g for-now -m 0700 "$success_dir"
success_marker_tmp=$(mktemp "$success_dir/.last-backup-success.XXXXXX")
chown for-now:for-now "$success_marker_tmp"
chmod 0600 "$success_marker_tmp"
mv "$success_marker_tmp" "$success_marker"
success_marker_tmp=
trap - EXIT
