#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

set -a
source /etc/for-now.env
set +a

: "${OSS_DESTINATION:?OSS_DESTINATION is required}"
: "${OSS_ENDPOINT:?OSS_ENDPOINT is required}"
: "${OSS_REGION:?OSS_REGION is required}"
: "${INVITE_CODE_HASH:?INVITE_CODE_HASH is required}"

port=${RESTORE_DRILL_PORT:-4273}
base=/opt/for-now
release=$(readlink -f "$base/app")
work=$(mktemp -d /var/tmp/for-now-restore-drill.XXXXXX)
launcher=""

cleanup() {
  if [ -n "$launcher" ]; then
    kill -TERM -- "-$launcher" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$launcher" 2>/dev/null || break
      sleep .1
    done
    kill -KILL -- "-$launcher" 2>/dev/null || true
    wait "$launcher" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

if lsof -t -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Restore drill port $port is already in use." >&2
  exit 1
fi

archive_uri=$(ossutil ls "$OSS_DESTINATION/" --mode EcsRamRole --endpoint "$OSS_ENDPOINT" --region "$OSS_REGION" \
  | awk '$NF ~ /for-now-[0-9TZ]+\.tar\.gz$/ {print $NF}' | sort | tail -n 1)
if [ -z "$archive_uri" ]; then
  echo "No backup archive found in $OSS_DESTINATION." >&2
  exit 1
fi

ossutil cp "$archive_uri" "$work/backup.tar.gz" --mode EcsRamRole --endpoint "$OSS_ENDPOINT" --region "$OSS_REGION" >/dev/null
ossutil cp "$archive_uri.sha256" "$work/backup.sha256" --mode EcsRamRole --endpoint "$OSS_ENDPOINT" --region "$OSS_REGION" >/dev/null
expected=$(awk '{print $1}' "$work/backup.sha256")
actual=$(sha256sum "$work/backup.tar.gz" | awk '{print $1}')
if [ "$expected" != "$actual" ]; then
  echo "Backup checksum mismatch." >&2
  exit 1
fi

mkdir "$work/data"
tar -xzf "$work/backup.tar.gz" -C "$work/data"
find "$work/data" -type d -exec chmod 0700 {} +
find "$work/data" -type f -exec chmod 0600 {} +
chown -R for-now:for-now "$work"

validation=$(sudo -u for-now /usr/local/bin/node "$release/scripts/validate-restored-data.mjs" "$work/data")
session_token=$(printf "%s" "$validation" | /usr/local/bin/node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).sessionToken')
expected_records=$(printf "%s" "$validation" | /usr/local/bin/node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).records')
expected_collection_evidence=$(printf "%s" "$validation" | /usr/local/bin/node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).collectionEvidence)')
first_attachment=$(printf "%s" "$validation" | /usr/local/bin/node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).firstAttachment')

setsid sudo -u for-now env \
  NODE_ENV=test DATA_DIR="$work/data" PORT="$port" APP_BASE_PATH=/restore-test \
  PERSISTENCE_BACKEND=json DATABASE_URL= AUTH_DATABASE_URL= PG_BACKUP_DATABASE_URL= \
  AUTH_REQUIRED=1 INVITE_CODE_HASH="$INVITE_CODE_HASH" COOKIE_SECURE=0 UPSTREAM_ORIGIN= \
  ATTACHMENT_STORAGE=local OSS_ATTACHMENT_BUCKET= OSS_ATTACHMENT_PREFIX= \
  OSS_ENDPOINT= OSS_REGION= ALIBABA_CLOUD_ECS_RAM_ROLE= \
  /usr/local/bin/node "$release/server.mjs" >"$work/server.out" 2>"$work/server.err" &
launcher=$!

ready=0
for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:$port/restore-test/readyz" >/dev/null 2>&1; then ready=1; break; fi
  sleep .1
done
if [ "$ready" -ne 1 ]; then
  cat "$work/server.err" >&2
  exit 1
fi

state=$(curl -fsS -H "Cookie: for_now_session=$session_token" "http://127.0.0.1:$port/restore-test/api/state")
actual_records=$(printf "%s" "$state" | /usr/local/bin/node -pe '
const value=JSON.parse(require("fs").readFileSync(0,"utf8"));
["checkins","dailyRecords","captures","journals","thoughts","chats","books","keepsakes","quotes","experiments","analyses","customMetrics","actions","habits","habitCheckins","feedback","validationLedger"]
  .reduce((sum,key)=>sum+(Array.isArray(value[key])?value[key].length:0),0)
')
if [ "$actual_records" != "$expected_records" ]; then
  echo "Restored API record count mismatch." >&2
  exit 1
fi
actual_collection_evidence=$(printf "%s" "$state" | /usr/local/bin/node -e '
const crypto=require("node:crypto"),value=JSON.parse(require("fs").readFileSync(0,"utf8"));
const objectValue=input=>input!==null&&typeof input==="object"&&!Array.isArray(input);
const canonical=input=>Array.isArray(input)?`[${input.map(canonical).join(",")}]`:objectValue(input)?`{${Object.keys(input).sort().map(key=>`${JSON.stringify(key)}:${canonical(input[key])}`).join(",")}}`:JSON.stringify(input);
const digest=input=>crypto.createHash("sha256").update(canonical(input)).digest("hex");
const collections=["checkins","dailyRecords","captures","journals","thoughts","chats","books","keepsakes","quotes","experiments","analyses","customMetrics","actions","habits","habitCheckins","feedback","validationLedger"];
process.stdout.write(JSON.stringify(Object.fromEntries(collections.map(key=>[key,{count:(value[key]||[]).length,idsSha256:digest((value[key]||[]).map(item=>String(item?.id||"")).sort()),contentSha256:digest(value[key]||[])}]))));
')
if [ "$actual_collection_evidence" != "$expected_collection_evidence" ]; then
  differences=$(EXPECTED_COLLECTION_EVIDENCE="$expected_collection_evidence" \
    ACTUAL_COLLECTION_EVIDENCE="$actual_collection_evidence" /usr/local/bin/node -e '
const expected=JSON.parse(process.env.EXPECTED_COLLECTION_EVIDENCE);
const actual=JSON.parse(process.env.ACTUAL_COLLECTION_EVIDENCE);
const changed=Object.keys(expected).filter(key=>JSON.stringify(expected[key])!==JSON.stringify(actual[key]));
process.stdout.write(JSON.stringify(Object.fromEntries(changed.map(key=>[key,{expected:expected[key],actual:actual[key]}]))));
')
  echo "Restored API collection evidence mismatch: $differences" >&2
  exit 1
fi
if [ -n "$first_attachment" ]; then
  curl -fsS -H "Cookie: for_now_session=$session_token" \
    "http://127.0.0.1:$port/restore-test$first_attachment" -o "$work/attachment.bin"
  test -s "$work/attachment.bin"
fi

summary=$(printf "%s" "$validation" | /usr/local/bin/node -pe '
const value=JSON.parse(require("fs").readFileSync(0,"utf8"));
JSON.stringify({users:value.users,totalRecords:value.totalRecords,attachmentReferences:value.attachmentReferences,localAttachments:value.localAttachments})
')
printf "Logical JSON restore drill passed (PostgreSQL restore is a separate database drill): archive=%s checksum=ok data=%s apiRecords=%s attachmentHttp=%s\n" \
  "$(basename "$archive_uri")" "$summary" "$actual_records" "$([ -n "$first_attachment" ] && echo passed || echo not-applicable)"
