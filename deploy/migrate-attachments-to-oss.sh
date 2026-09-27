#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

set -a
source /etc/for-now.env
set +a

: "${DATA_DIR:=/srv/for-now/data}"
: "${OSS_ATTACHMENT_BUCKET:?OSS_ATTACHMENT_BUCKET is required}"
: "${OSS_ATTACHMENT_PREFIX:=for-now-attachments}"
: "${OSS_ENDPOINT:?OSS_ENDPOINT is required}"
: "${OSS_REGION:?OSS_REGION is required}"

destination="oss://$OSS_ATTACHMENT_BUCKET/${OSS_ATTACHMENT_PREFIX#/}"
destination=${destination%/}
uploaded_files=0
uploaded_bytes=0

upload_directory() {
  owner=$1
  directory=$2
  [ -d "$directory" ] || return 0
  count=$(find "$directory" -maxdepth 1 -type f | wc -l)
  bytes=$(find "$directory" -maxdepth 1 -type f -printf '%s\n' | awk '{sum+=$1} END {print sum+0}')
  [ "$count" -gt 0 ] || return 0
  ossutil cp "$directory/" "$destination/$owner/" --recursive --force \
    --mode EcsRamRole --endpoint "$OSS_ENDPOINT" --region "$OSS_REGION"
  uploaded_files=$((uploaded_files + count))
  uploaded_bytes=$((uploaded_bytes + bytes))
}

upload_directory local "$DATA_DIR/attachments"
if [ -d "$DATA_DIR/users" ]; then
  while IFS= read -r user_dir; do
    upload_directory "$(basename "$user_dir")" "$user_dir/attachments"
  done < <(find "$DATA_DIR/users" -mindepth 1 -maxdepth 1 -type d | sort)
fi

remote=$(ossutil ls "$destination/" --recursive --mode EcsRamRole --endpoint "$OSS_ENDPOINT" --region "$OSS_REGION")
remote_files=$(printf "%s\n" "$remote" | awk '$1 ~ /^[0-9]{4}-/ {count++} END {print count+0}')
remote_bytes=$(printf "%s\n" "$remote" | awk '$1 ~ /^[0-9]{4}-/ {sum+=$5} END {print sum+0}')
if [ "$remote_files" -lt "$uploaded_files" ] || [ "$remote_bytes" -lt "$uploaded_bytes" ]; then
  echo "OSS attachment verification failed." >&2
  exit 1
fi

install -o for-now -g for-now -m 0600 /dev/null "$DATA_DIR/.attachments-migrated-to-oss"
printf "Attachment migration verified: localFiles=%s localBytes=%s remoteFiles=%s remoteBytes=%s\n" \
  "$uploaded_files" "$uploaded_bytes" "$remote_files" "$remote_bytes"
