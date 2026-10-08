#!/usr/bin/env bash
set -euo pipefail

export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin

repo_url=${REPO_URL:-git@gitee.com:Liu_772021/for-now.git}
branch=${DEPLOY_BRANCH:-preview/main}
action=${1:-deploy}
selector=${2:-}
base=/opt/for-now-preview
mirror=$base/repository.git
releases=$base/releases
current=$base/app
previous_link=$base/previous
data_dir=/srv/for-now-preview/data
env_file=/etc/for-now-preview.env
service_file=/etc/systemd/system/for-now-preview.service
nginx_file=/etc/nginx/snippets/for-now-preview.conf
runtime_user=for-now-preview
runtime_home=/home/for-now-preview
ssh_key=$runtime_home/.ssh/gitee_deploy
git_ssh="ssh -i $ssh_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
ready_url=http://127.0.0.1:4175/preview/readyz

usage() {
  echo "Usage: for-now-preview-deploy [deploy | rollback [40-character-commit]]" >&2
  exit 2
}

case "$action" in
  deploy)
    [ -z "$selector" ] || usage
    ;;
  rollback)
    if [ -n "$selector" ] && ! [[ "$selector" =~ ^[a-f0-9]{40}$ ]]; then usage; fi
    ;;
  *)
    usage
    ;;
esac

case "$branch" in
  preview/*)
    [ "$branch" != "preview/" ] || usage
    ;;
  *)
    echo "Preview deployment only accepts preview/* branches: $branch" >&2
    exit 1
    ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi
if ! id "$runtime_user" >/dev/null 2>&1; then
  echo "Missing system user $runtime_user. Complete the Preview installation first." >&2
  exit 1
fi
if [ ! -f "$env_file" ]; then
  echo "Missing $env_file. Install and review the Preview environment first." >&2
  exit 1
fi
if [ "$(/usr/bin/stat -c '%U:%G %a' "$env_file")" != "root:root 600" ]; then
  echo "$env_file must be owned by root:root with mode 0600." >&2
  exit 1
fi
if [ "$action" = "deploy" ] && [ ! -f "$ssh_key" ]; then
  echo "Missing $ssh_key. Install a Preview-only read-only deploy key." >&2
  exit 1
fi
if [ ! -x /usr/bin/ffmpeg ]; then
  echo "FFmpeg is required for M4A speech transcription." >&2
  exit 1
fi

validate_environment() {
  local keys line key value
  keys=$(release_guard mktemp)
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ""|\#*) continue ;;
    esac
    if [[ "$line" == *$'\r'* ]] || ! [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      rm -f "$keys"
      echo "Invalid line in $env_file; use unexported KEY=value entries without leading whitespace." >&2
      return 1
    fi
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    if grep -Fqx "$key" "$keys"; then
      rm -f "$keys"
      echo "Duplicate $key in $env_file." >&2
      return 1
    fi
    printf '%s\n' "$key" >> "$keys"
    case "$key" in
      DATABASE_URL|AUTH_DATABASE_URL|AI_BUDGET_DATABASE_URL|UPSTREAM_ORIGIN)
        rm -f "$keys"
        echo "$key is forbidden in the Preview environment." >&2
        return 1
        ;;
      NODE_ENV|PORT|TZ|DATA_DIR|APP_BASE_PATH|APP_VERSION|INCREMENTAL_SYNC_ENABLED|PROMPT_CATALOG_VERSION|\
      PERSISTENCE_BACKEND|ATTACHMENT_STORAGE|AUTH_REQUIRED|COOKIE_SECURE|INVITE_CODE_HASH|\
      PERIODIC_ANALYSIS_ENABLED|SPEECH_CACHE_SWEEP_ENABLED|RUNTIME_MEMORY_SAMPLE_INTERVAL_MS|\
      AI_AUDIT_RETENTION_DAYS|AI_AUDIT_TEXT_LIMIT|AI_GLOBAL_QPS|AI_GLOBAL_CONCURRENCY|\
      AI_USER_DAILY_CALL_LIMIT|AI_COST_CNY_PER_USD|AI_USER_DAILY_COST_LIMIT_CNY|\
      SEGMENTATION_GLOBAL_QPS|SEGMENTATION_GLOBAL_CONCURRENCY|SPEECH_GLOBAL_QPS|\
      SPEECH_GLOBAL_CONCURRENCY|OCR_GLOBAL_QPS|OCR_GLOBAL_CONCURRENCY|\
      DOCUMENT_PARSE_GLOBAL_QPS|DOCUMENT_PARSE_GLOBAL_CONCURRENCY|ATTACHMENT_USER_QUOTA_BYTES|\
      DEEPSEEK_API_KEY|DEEPSEEK_API_URL|ALIBABA_CLOUD_ACCESS_KEY_ID|\
      ALIBABA_CLOUD_ACCESS_KEY_SECRET|ALIBABA_CLOUD_ECS_RAM_ROLE|ALIBABA_CLOUD_IMDSV1_DISABLED|\
      VOLCENGINE_SPEECH_API_KEY|VOLCENGINE_SPEECH_PROJECT_NAME|VOLCENGINE_TTS_DEFAULT_VOICE|\
      VOLCENGINE_ACCESS_KEY_ID|VOLCENGINE_SECRET_ACCESS_KEY|VOLCENGINE_SESSION_TOKEN|\
      VOLCENGINE_TTS_ENDPOINT|VOLCENGINE_TTS_SUBMIT_ENDPOINT|VOLCENGINE_TTS_QUERY_ENDPOINT|\
      VOLCENGINE_ASR_STREAM_ENDPOINT|VOLCENGINE_ASR_SUBMIT_ENDPOINT|VOLCENGINE_ASR_QUERY_ENDPOINT|\
      VOLCENGINE_VISUAL_ENDPOINT|VOLCENGINE_VISUAL_REGION)
        ;;
      *)
        rm -f "$keys"
        echo "$key is not in the Preview environment allowlist." >&2
        return 1
        ;;
    esac
  done < "$env_file"
  rm -f "$keys"

  for requirement in \
    NODE_ENV=production \
    PORT=4175 \
    DATA_DIR=/srv/for-now-preview/data \
    APP_BASE_PATH=/preview \
    PERSISTENCE_BACKEND=json \
    ATTACHMENT_STORAGE=local \
    AUTH_REQUIRED=1 \
    COOKIE_SECURE=1
  do
    if ! grep -Fqx "$requirement" "$env_file"; then
      echo "$env_file must contain exactly $requirement." >&2
      return 1
    fi
  done

  value=$(sed -n 's/^INVITE_CODE_HASH=//p' "$env_file")
  if ! [[ "$value" =~ ^[a-f0-9]{64}$ ]]; then
    echo "INVITE_CODE_HASH must be a lowercase SHA-256 digest in $env_file." >&2
    return 1
  fi

  for requirement in \
    DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions \
    VOLCENGINE_TTS_ENDPOINT=https://openspeech.bytedance.com/api/v3/tts/unidirectional \
    VOLCENGINE_TTS_SUBMIT_ENDPOINT=https://openspeech.bytedance.com/api/v3/tts/submit \
    VOLCENGINE_TTS_QUERY_ENDPOINT=https://openspeech.bytedance.com/api/v3/tts/query \
    VOLCENGINE_ASR_STREAM_ENDPOINT=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async \
    VOLCENGINE_ASR_SUBMIT_ENDPOINT=https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit \
    VOLCENGINE_ASR_QUERY_ENDPOINT=https://openspeech.bytedance.com/api/v3/auc/bigmodel/query \
    VOLCENGINE_VISUAL_ENDPOINT=https://visual.volcengineapi.com
  do
    key=${requirement%%=*}
    value=${requirement#*=}
    if grep -q "^${key}=" "$env_file" && ! grep -Fqx "${key}=${value}" "$env_file"; then
      echo "$key may only use the reviewed official provider endpoint in Preview." >&2
      return 1
    fi
  done
}

source /usr/local/lib/for-now-release/release-fence.sh
release_fence_init preview "$current" "$action"

validate_environment

release_guard mkdir -p "$base" "$mirror" "$releases" "$data_dir"
release_guard chown "root:root" "$base" "$releases"
release_guard chown "$runtime_user:$runtime_user" "$mirror" "$data_dir"
release_guard chmod 0755 "$base" "$releases"
release_guard chmod 0700 "$mirror" "$data_dir"

preview_run() {
  runuser -u "$runtime_user" -- env -i HOME="$runtime_home" PATH="$PATH" \
    /bin/sh -c 'cd "$HOME" && exec "$@"' sh "$@"
}

preview_git() {
  preview_run env GIT_SSH_COMMAND="$git_ssh" git "$@"
}

candidate=
cleanup_candidate() {
  if [ -n "$candidate" ] && [ -d "$candidate" ]; then rm -rf "$candidate"; fi
  release_fence_cleanup
}

target=
target_commit=
if [ "$action" = "deploy" ]; then
  if [ ! -f "$mirror/HEAD" ]; then
    release_guard preview_git clone --mirror "$repo_url" "$mirror"
  else
    release_guard preview_git --git-dir="$mirror" fetch --prune origin
  fi

  target_commit=$(preview_git --git-dir="$mirror" rev-parse --verify "refs/heads/$branch^{commit}")
  if ! [[ "$target_commit" =~ ^[a-f0-9]{40}$ ]]; then
    echo "Preview branch did not resolve to a 40-character commit." >&2
    exit 1
  fi
  if [ "$target_commit" != "$RELEASE_CANDIDATE_SHA" ]; then echo "Preview target differs from approved candidate." >&2; exit 1; fi
  target=$releases/$target_commit
  if [ ! -f "$target/.preview-deploy-ready" ] || \
     ! grep -Fqx "preview-deploy-v1 $target_commit" "$target/.preview-deploy-ready"; then
    candidate=$(release_guard mktemp -d "$releases/.${target_commit}.XXXXXX")
    trap cleanup_candidate EXIT
    release_guard preview_git --git-dir="$mirror" archive "$target_commit" | tar -x -C "$candidate"
    release_guard chown -R "$runtime_user:$runtime_user" "$candidate"
    release_guard preview_run npm --prefix "$candidate" ci --omit=dev

    /usr/local/bin/node --check "$candidate/server.mjs"
    /usr/local/bin/node --check "$candidate/admin-snapshot.mjs"
    while IFS= read -r -d '' source_file; do
      /usr/local/bin/node --check "$source_file"
    done < <(/usr/bin/find "$candidate/src" "$candidate/public" "$candidate/scripts" -type f \
      \( -name '*.js' -o -name '*.mjs' \) -print0)
    while IFS= read -r -d '' shell_file; do
      /bin/bash -n "$shell_file"
    done < <(/usr/bin/find "$candidate/deploy" -type f -name '*.sh' -print0)
    preview_run /usr/local/bin/node "$candidate/scripts/prompt-catalog-regression.mjs"

    while IFS= read -r -d '' text_file; do
      release_guard true
      /usr/bin/gzip -n -6 -c "$text_file" > "${text_file}.gz"
    done < <(/usr/bin/find "$candidate/public" -type f \
      \( -name '*.css' -o -name '*.html' -o -name '*.js' -o -name '*.mjs' \
         -o -name '*.svg' -o -name '*.webmanifest' \) -print0)
    printf 'preview-deploy-v1 %s\n' "$target_commit" > "$candidate/.preview-deploy-ready"
    release_guard chown -R "root:root" "$candidate"
    release_guard chmod 0755 "$candidate"
    if [ -e "$target" ]; then
      target="$releases/${target_commit}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    fi
    release_guard mv "$candidate" "$target"
    candidate=
    trap release_fence_cleanup EXIT
  fi
else
  if [ -n "$selector" ]; then
    target=$releases/$selector
  else
    target=$(release_fence_resolve_directory "$previous_link")
  fi
  case "$target" in
    "$releases"/*) ;;
    *)
      echo "No valid previous Preview release is available." >&2
      exit 1
      ;;
  esac
  if [ ! -f "$target/.preview-deploy-ready" ]; then
    echo "Rollback target is not a completed Preview release: $target" >&2
    exit 1
  fi
  read -r marker_version target_commit marker_extra < "$target/.preview-deploy-ready"
  if [ "$marker_version" != "preview-deploy-v1" ] || \
     ! [[ "$target_commit" =~ ^[a-f0-9]{40}$ ]] || [ -n "${marker_extra:-}" ]; then
    echo "Rollback target has an invalid Preview release marker: $target" >&2
    exit 1
  fi
  if [ -n "$selector" ] && [ "$selector" != "$target_commit" ]; then
    echo "Rollback target commit does not match its release marker." >&2
    exit 1
  fi
fi

if [ "$target_commit" != "$RELEASE_CANDIDATE_SHA" ]; then echo "Preview target differs from approved candidate." >&2; exit 1; fi

for required_file in \
  deploy/for-now-preview.service \
  deploy/nginx-for-now-preview.conf
do
  if [ ! -f "$target/$required_file" ]; then
    echo "Preview release is missing $required_file." >&2
    exit 1
  fi
done

active=$(release_fence_resolve_directory "$current")
saved_previous=$(release_fence_resolve_directory "$previous_link")
rollback_dir=$(release_guard mktemp -d "$base/.preview-deploy-rollback.XXXXXX")
managed_files=(
  "$env_file"
  "$service_file"
  "$nginx_file"
)
for index in "${!managed_files[@]}"; do
  file=${managed_files[$index]}
  if [ -e "$file" ]; then release_guard cp -p "$file" "$rollback_dir/$index"; fi
done
service_was_enabled=0
service_was_active=0
if systemctl is-enabled --quiet for-now-preview.service 2>/dev/null; then service_was_enabled=1; fi
if systemctl is-active --quiet for-now-preview.service 2>/dev/null; then service_was_active=1; fi
switched=0

restore_link() {
  local destination=$1 link=$2 temporary=$3
  if [ -n "$destination" ] && [ -d "$destination" ]; then
    release_guard ln -sfn "$destination" "$temporary"
    release_guard mv -Tf "$temporary" "$link"
  else
    release_guard rm -f "$temporary" "$link"
  fi
}

rollback_failed_deployment() {
  status=$?
  trap - EXIT
  set +e
  release_fence_begin_rollback || { rm -rf "$rollback_dir"; exit "$status"; }
  for index in "${!managed_files[@]}"; do
    file=${managed_files[$index]}
    if [ -e "$rollback_dir/$index" ]; then release_guard cp -p "$rollback_dir/$index" "$file"; else release_guard rm -f "$file"; fi
  done
  if [ "$switched" -eq 1 ]; then
    restore_link "$active" "$current" "$base/.app-recovery"
    restore_link "$saved_previous" "$previous_link" "$base/.previous-recovery"
  fi
  release_guard systemctl daemon-reload
  if [ "$service_was_enabled" -eq 1 ]; then release_guard systemctl enable for-now-preview.service
  else release_guard systemctl disable for-now-preview.service; fi
  if [ "$service_was_active" -eq 1 ] && [ -n "$active" ]; then
    if ! release_guard systemctl restart for-now-preview.service || ! curl -fsS "$ready_url" >/dev/null 2>&1; then
      echo "Previous Preview release was restored but is unhealthy; inspect for-now-preview.service." >&2
    fi
  else
    release_guard systemctl stop for-now-preview.service
  fi
  nginx -t && release_guard systemctl reload nginx
  rm -rf "$rollback_dir"
  release_fence_cleanup
  echo "Preview deployment failed; only Preview code/configuration was rolled back." >&2
  exit "$status"
}
trap rollback_failed_deployment EXIT

release_guard install -o root -g root -m 0644 "$target/deploy/for-now-preview.service" "$service_file"
release_guard install -o root -g root -m 0644 "$target/deploy/nginx-for-now-preview.conf" "$nginx_file"
release_guard systemctl daemon-reload
nginx -t

switched=1
if [ "$active" != "$target" ]; then
  restore_link "$active" "$previous_link" "$base/.previous-next"
  restore_link "$target" "$current" "$base/.app-next"
fi

next_env=$(release_guard mktemp /etc/.for-now-preview.env.XXXXXX)
awk -v version="${target_commit:0:12}" '
  BEGIN { found = 0 }
  /^APP_VERSION=/ {
    if (!found) print "APP_VERSION=" version
    found = 1
    next
  }
  { print }
  END { if (!found) print "APP_VERSION=" version }
' "$env_file" > "$next_env"
release_guard install -o root -g root -m 0600 "$next_env" "$env_file"
rm -f "$next_env"

release_guard systemctl enable for-now-preview.service
release_guard systemctl restart for-now-preview.service
for attempt in $(seq 1 30); do
  if curl -fsS "$ready_url" >/dev/null 2>&1; then
    release_guard systemctl reload nginx
    trap release_fence_cleanup EXIT
    rm -rf "$rollback_dir"
    release_fence_finish
    echo "$action Preview ${target_commit:0:12}"
    exit 0
  fi
  sleep 1
done

echo "Preview health check failed at $ready_url." >&2
exit 1
