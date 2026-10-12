#!/usr/bin/env bash
set -euo pipefail

repo_url=${REPO_URL:-git@gitee.com:Liu_772021/for-now.git}
branch=${DEPLOY_BRANCH:-main}
base=/opt/for-now
mirror=$base/repository.git
releases=$base/releases
current=$base/app
ssh_key=/home/for-now/.ssh/gitee_deploy
git_ssh="ssh -i $ssh_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

case "$branch" in
  explore/*|checkpoint/*)
    echo "Non-release branches cannot be used as production release candidates: $branch" >&2
    exit 1
    ;;
esac
if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi
if [ ! -f "$ssh_key" ]; then
  echo "Missing $ssh_key. Run prepare-server.sh and add its public key as a read-only Gitee deploy key." >&2
  exit 1
fi
if [ ! -x /usr/bin/ffmpeg ]; then
  echo "FFmpeg is required for M4A speech transcription." >&2
  exit 1
fi
for key in OSS_ATTACHMENT_BUCKET OSS_ENDPOINT OSS_REGION FEISHU_ALERT_WEBHOOK PLATFORM_SERVICE_TOKEN_HASH; do
  if ! grep -Eq "^${key}=.+" /etc/for-now.env; then
    echo "Missing $key in /etc/for-now.env." >&2
    exit 1
  fi
done
if ! grep -Eq '^PLATFORM_SERVICE_TOKEN_HASH=[a-f0-9]{64}$' /etc/for-now.env; then
  echo "PLATFORM_SERVICE_TOKEN_HASH must be a lowercase SHA-256 digest." >&2
  exit 1
fi
if ! grep -Eq '^FEISHU_ALERT_WEBHOOK=https://(open\.feishu\.cn|open\.larkoffice\.com|open\.larksuite\.com)/open-apis/bot/v2/hook/[A-Za-z0-9_-]+/?$' /etc/for-now.env; then
  echo "FEISHU_ALERT_WEBHOOK must be an HTTPS Feishu custom-bot webhook." >&2
  exit 1
fi

source /usr/local/lib/for-now-release/release-fence.sh
release_fence_init production "$current" deploy

release_guard mkdir -p "$mirror" "$releases"
release_guard chown root:root "$base" "$releases"
release_guard chown -R for-now:for-now "$mirror"
release_guard chmod 0755 "$base" "$releases"
release_guard chmod 0700 "$mirror"
if [ ! -d "$mirror" ]; then
  release_guard sudo -u for-now env GIT_SSH_COMMAND="$git_ssh" git clone --mirror "$repo_url" "$mirror"
else
  release_guard sudo -u for-now env GIT_SSH_COMMAND="$git_ssh" git --git-dir="$mirror" fetch --prune origin
fi

commit=$(release_guard sudo -u for-now git --git-dir="$mirror" rev-parse "refs/heads/$branch")
if [ "$commit" != "$RELEASE_CANDIDATE_SHA" ]; then echo "Fetched commit differs from approved candidate." >&2; exit 1; fi
if [ -n "${DEPLOY_EXPECTED_COMMIT:-}" ] && [ "$commit" != "$DEPLOY_EXPECTED_COMMIT" ]; then
  echo "Release branch changed; expected commit does not match. Deployment stopped." >&2
  exit 1
fi
release="$releases/$commit"
previous=$(release_fence_resolve_directory "$current")
if [ ! -f "$release/.deploy-ready" ]; then
  candidate=$(release_guard mktemp -d "$releases/.${commit}.XXXXXX")
  cleanup_candidate() { rm -rf "$candidate"; release_fence_cleanup; }
  trap cleanup_candidate EXIT
  release_guard sudo -u for-now git --git-dir="$mirror" archive "$commit" | tar -x -C "$candidate"
  forbidden=$(/usr/bin/find "$candidate/public" -mindepth 1 -maxdepth 1 -name 'explore*' -print -quit)
  if [ -n "$forbidden" ]; then
    echo "Production release contains local exploration assets: ${forbidden#"$candidate/"}" >&2
    exit 1
  fi
  release_guard chown -R for-now:for-now "$candidate"
  release_guard sudo -u for-now /usr/local/bin/npm --prefix "$candidate" ci
  release_guard sudo -u for-now /usr/local/bin/npm --prefix "$candidate" run build:runtime
  release_guard sudo -u for-now /usr/local/bin/npm --prefix "$candidate" prune --omit=dev
  /usr/local/bin/node --check "$candidate/server.mjs"
  while IFS= read -r module_file; do
    /usr/local/bin/node --check "$module_file"
  done < <(/usr/bin/find "$candidate/src" "$candidate/public/frontend" -type f -name '*.mjs')
  /usr/local/bin/node --check "$candidate/public/app.js"
  /usr/local/bin/node --check "$candidate/scripts/monitor-health.mjs"
  /usr/local/bin/node --check "$candidate/.build/typescript/monitor/monitor-journal-context.mjs"
  /usr/local/bin/node --check "$candidate/.build/typescript/monitor/monitor-host-metrics.mjs"
  /usr/local/bin/node --check "$candidate/scripts/validate-restored-data.mjs"
  /usr/local/bin/node --check "$candidate/scripts/oss-attachment-smoke.mjs"
  /usr/local/bin/node --check "$candidate/scripts/aliyun-segmentation-smoke.mjs"
  /usr/local/bin/node --check "$candidate/scripts/postgres-runtime-preflight.mjs"
  /usr/local/bin/node "$candidate/scripts/prompt-catalog-regression.mjs"
  /bin/bash -n "$candidate/deploy/backup-to-oss.sh" "$candidate/deploy/restore-drill.sh" \
    "$candidate/deploy/migrate-attachments-to-oss.sh"
  while IFS= read -r -d '' text_file; do
    release_guard true
    /usr/bin/gzip -n -6 -c "$text_file" > "${text_file}.gz"
  done < <(/usr/bin/find "$candidate/public" -type f \
    \( -name '*.css' -o -name '*.html' -o -name '*.js' -o -name '*.mjs' \
       -o -name '*.svg' -o -name '*.webmanifest' \) -print0)
  release_guard touch "$candidate/.deploy-ready"
  release_guard chown -R root:root "$candidate"
  release_guard chmod 0755 "$candidate"
  if [ -e "$release" ]; then
    release="$releases/${commit}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  fi
  release_guard mv "$candidate" "$release"
  trap release_fence_cleanup EXIT
fi
release_guard chown -R root:root "$release"
release_guard chmod 0755 "$release"
if [ -n "$previous" ] && [ -d "$previous" ]; then
  release_guard chown -R root:root "$previous"
  release_guard chmod 0755 "$previous"
fi

media_profile=${DEPLOY_MEDIA_CONFIG:-/etc/for-now-media-delivery.json}
if [ -n "${DEPLOY_MEDIA_CONFIG:-}" ] || [ -e "$media_profile" ]; then
  if [ ! -f "$release/deploy/apply-media-config.mjs" ]; then
    echo "Candidate lacks the media configuration deploy hook." >&2
    exit 1
  fi
  /usr/local/bin/node "$release/deploy/apply-media-config.mjs" \
    "$media_profile" /etc/for-now.env /etc/for-now-media-cdn.key "$release" --check
fi

# A PostgreSQL cutover is a separate offline procedure. Generic code rollback
# must never start a JSON-only release against the old, now stale JSON files.
if grep -Eq '^PERSISTENCE_BACKEND=postgres$' /etc/for-now.env; then
  if [ ! -f "$release/src/shared/persistence/postgres-runtime.mjs" ] || \
     [ -z "$previous" ] || [ ! -f "$previous/src/shared/persistence/postgres-runtime.mjs" ]; then
    echo "PostgreSQL deployment requires a database-capable candidate and rollback release; complete the offline cutover procedure first." >&2
    exit 1
  fi
  (
    set -a
    source /etc/for-now.env
    set +a
    exec runuser --preserve-environment -u for-now -- \
      /usr/local/bin/node "$release/scripts/postgres-runtime-preflight.mjs"
  )
fi

# Keep config and version together with the previous code on every failure path.
rollback_dir=$(release_guard mktemp -d "$base/.deploy-rollback.XXXXXX")
managed_files=(
  /etc/for-now.env
  /etc/for-now-media-delivery.json
  /etc/systemd/system/for-now.service
  /etc/systemd/system/for-now-backup.service
  /etc/systemd/system/for-now-backup.timer
  /etc/systemd/system/for-now-monitor.service
  /etc/systemd/system/for-now-monitor-journal-context.service
  /etc/systemd/system/for-now-monitor.timer
  /etc/systemd/system/for-now-host-metrics.service
  /usr/local/lib/for-now/monitor-journal-context.mjs
  /usr/local/sbin/for-now-backup
  /usr/local/sbin/for-now-restore-drill
  /usr/local/sbin/for-now-migrate-attachments
  /var/www/app-portal/index.html
  /etc/nginx/snippets/for-now.conf
  /etc/nginx/snippets/acme-challenge.conf
  /etc/nginx/sites-available/dysf
)
for index in "${!managed_files[@]}"; do
  file=${managed_files[$index]}
  if [ -e "$file" ]; then release_guard cp -p "$file" "$rollback_dir/$index"; fi
done
switched=0
monitor_was_enabled=0
if systemctl is-enabled --quiet for-now-monitor.timer 2>/dev/null; then monitor_was_enabled=1; fi
host_metrics_was_enabled=0
host_metrics_was_active=0
if systemctl is-enabled --quiet for-now-host-metrics.service 2>/dev/null; then host_metrics_was_enabled=1; fi
if systemctl is-active --quiet for-now-host-metrics.service 2>/dev/null; then host_metrics_was_active=1; fi
rollback() {
  status=$?
  trap - EXIT
  set +e
  release_fence_begin_rollback || { rm -rf "$rollback_dir"; exit "$status"; }
  for index in "${!managed_files[@]}"; do
    file=${managed_files[$index]}
    if [ -e "$rollback_dir/$index" ]; then release_guard cp -p "$rollback_dir/$index" "$file"; else release_guard rm -f "$file"; fi
  done
  release_guard systemctl daemon-reload
  if [ "$monitor_was_enabled" -eq 1 ]; then release_guard systemctl enable --now for-now-monitor.timer
  else release_guard systemctl disable --now for-now-monitor.timer; fi
  if [ "$host_metrics_was_enabled" -eq 1 ]; then release_guard systemctl enable for-now-host-metrics.service
  else release_guard systemctl disable for-now-host-metrics.service; fi
  if [ "$host_metrics_was_active" -eq 1 ]; then release_guard systemctl restart for-now-host-metrics.service
  else release_guard systemctl stop for-now-host-metrics.service; fi
  if [ "$switched" -eq 1 ]; then
    if [ -n "$previous" ] && [ -d "$previous" ]; then
      release_guard ln -sfn "$previous" "$base/.app-rollback"
      release_guard mv -Tf "$base/.app-rollback" "$current"
      if ! release_guard systemctl restart for-now.service || ! curl -fsS http://127.0.0.1:4173/readyz >/dev/null 2>&1; then
        echo "Previous release restored but recovery is unhealthy; inspect for-now.service." >&2
      fi
    else
      release_guard rm -f "$current"
      release_guard systemctl stop for-now.service
      echo "No previous release exists; service stopped." >&2
    fi
  fi
  nginx -t && release_guard systemctl reload nginx
  rm -rf "$rollback_dir"
  release_fence_cleanup
  echo "Deployment failed; code/config rollback attempted." >&2
  exit "$status"
}
trap rollback EXIT
if [ -n "${DEPLOY_MEDIA_CONFIG:-}" ] || [ -e "$media_profile" ]; then
  release_guard /usr/local/bin/node "$release/deploy/apply-media-config.mjs" \
    "$media_profile" /etc/for-now.env /etc/for-now-media-cdn.key "$release" \
    --apply-fenced "$release_fence_target" "$RELEASE_ATTEMPT_ID" "$RELEASE_CANDIDATE_SHA" \
    "$(release_fence_current_sha)" "$$"
fi
release_guard install -o root -g root -m 0644 "$release/deploy/for-now.service" /etc/systemd/system/for-now.service
release_guard install -o root -g root -m 0644 "$release/deploy/for-now-backup.service" /etc/systemd/system/for-now-backup.service
release_guard install -o root -g root -m 0644 "$release/deploy/for-now-backup.timer" /etc/systemd/system/for-now-backup.timer
release_guard install -o root -g root -m 0644 "$release/deploy/for-now-monitor.service" /etc/systemd/system/for-now-monitor.service
release_guard install -d -o root -g for-now -m 0750 /var/lib/for-now-monitor-journal
release_guard install -d -o root -g root -m 0755 /usr/local/lib/for-now
release_guard install -o root -g root -m 0644 "$release/deploy/for-now-monitor-journal-context.service" /etc/systemd/system/for-now-monitor-journal-context.service
release_guard install -o root -g root -m 0644 "$release/.build/typescript/monitor/monitor-journal-context.mjs" /usr/local/lib/for-now/monitor-journal-context.mjs
release_guard install -o root -g root -m 0644 "$release/deploy/for-now-monitor.timer" /etc/systemd/system/for-now-monitor.timer
release_guard install -o root -g root -m 0644 "$release/deploy/for-now-host-metrics.service" /etc/systemd/system/for-now-host-metrics.service
release_guard install -o root -g root -m 0755 "$release/deploy/backup-to-oss.sh" /usr/local/sbin/for-now-backup
release_guard install -o root -g root -m 0755 "$release/deploy/restore-drill.sh" /usr/local/sbin/for-now-restore-drill
release_guard install -o root -g root -m 0755 "$release/deploy/migrate-attachments-to-oss.sh" /usr/local/sbin/for-now-migrate-attachments
release_guard install -o root -g root -m 0644 "$release/deploy/portal.html" /var/www/app-portal/index.html
release_guard install -o root -g root -m 0644 "$release/deploy/nginx-for-now.conf" /etc/nginx/snippets/for-now.conf
release_guard install -o root -g root -m 0644 "$release/deploy/nginx-acme-challenge.conf" /etc/nginx/snippets/acme-challenge.conf
if [ -f /etc/letsencrypt/live/123.57.140.24/fullchain.pem ] && \
   [ -f /etc/letsencrypt/live/123.57.140.24/privkey.pem ] && \
   [ -f /etc/letsencrypt/live/77liu.top/fullchain.pem ] && \
   [ -f /etc/letsencrypt/live/77liu.top/privkey.pem ]; then
  release_guard install -o root -g root -m 0644 "$release/deploy/nginx-dysf.conf" /etc/nginx/sites-available/dysf
fi
release_guard systemctl daemon-reload
nginx -t
release_guard ln -sfn "$release" "$base/.app-next"
release_guard mv -Tf "$base/.app-next" "$current"
switched=1

if grep -q '^APP_VERSION=' /etc/for-now.env; then
  release_guard sed -i "s/^APP_VERSION=.*/APP_VERSION=${commit:0:12}/" /etc/for-now.env
else
  release_guard true
  printf 'APP_VERSION=%s\n' "${commit:0:12}" >> /etc/for-now.env
fi

release_guard systemctl restart for-now.service
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4173/readyz >/dev/null 2>&1; then
    release_guard systemctl reload nginx
    release_guard systemctl enable --now for-now-monitor.timer
    release_guard systemctl enable --now for-now-host-metrics.service
    trap release_fence_cleanup EXIT
    rm -rf "$rollback_dir"
    # Keep both the active release and the immediate rollback target.
    while IFS= read -r stale; do
      if [ "$stale" != "$release" ] && [ "$stale" != "$previous" ]; then release_guard rm -rf "$stale"; fi
    done < <(find "$releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +6 | cut -d' ' -f2-)
    release_fence_finish
    echo "Deployed ${commit:0:12}"
    exit 0
  fi
  sleep 1
done

echo "Health check failed." >&2
exit 1
