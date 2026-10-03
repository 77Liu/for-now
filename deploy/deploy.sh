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

mkdir -p "$releases"
chown -R for-now:for-now "$base"
if [ ! -d "$mirror" ]; then
  sudo -u for-now env GIT_SSH_COMMAND="$git_ssh" git clone --mirror "$repo_url" "$mirror"
else
  sudo -u for-now env GIT_SSH_COMMAND="$git_ssh" git --git-dir="$mirror" fetch --prune origin
fi

commit=$(sudo -u for-now git --git-dir="$mirror" rev-parse "refs/heads/$branch")
release="$releases/$commit"
previous=$(readlink -f "$current" 2>/dev/null || true)
if [ ! -f "$release/.deploy-ready" ]; then
  candidate=$(mktemp -d "$releases/.${commit}.XXXXXX")
  cleanup_candidate() { rm -rf "$candidate"; }
  trap cleanup_candidate EXIT
  sudo -u for-now git --git-dir="$mirror" archive "$commit" | tar -x -C "$candidate"
  forbidden=$(/usr/bin/find "$candidate/public" -mindepth 1 -maxdepth 1 -name 'explore*' -print -quit)
  if [ -n "$forbidden" ]; then
    echo "Production release contains local exploration assets: ${forbidden#"$candidate/"}" >&2
    exit 1
  fi
  chown -R for-now:for-now "$candidate"
  sudo -u for-now /usr/local/bin/npm --prefix "$candidate" ci --omit=dev
  /usr/local/bin/node --check "$candidate/server.mjs"
  while IFS= read -r module_file; do
    /usr/local/bin/node --check "$module_file"
  done < <(/usr/bin/find "$candidate/src" "$candidate/public/frontend" -type f -name '*.mjs')
  /usr/local/bin/node --check "$candidate/public/app.js"
  /usr/local/bin/node --check "$candidate/scripts/monitor-health.mjs"
  /usr/local/bin/node --check "$candidate/scripts/validate-restored-data.mjs"
  /usr/local/bin/node --check "$candidate/scripts/oss-attachment-smoke.mjs"
  /usr/local/bin/node --check "$candidate/scripts/aliyun-segmentation-smoke.mjs"
  /usr/local/bin/node --check "$candidate/scripts/postgres-runtime-preflight.mjs"
  /usr/local/bin/node "$candidate/scripts/prompt-catalog-regression.mjs"
  /bin/bash -n "$candidate/deploy/backup-to-oss.sh" "$candidate/deploy/restore-drill.sh" \
    "$candidate/deploy/migrate-attachments-to-oss.sh"
  while IFS= read -r -d '' text_file; do
    /usr/bin/gzip -n -6 -c "$text_file" > "${text_file}.gz"
  done < <(/usr/bin/find "$candidate/public" -type f \
    \( -name '*.css' -o -name '*.html' -o -name '*.js' -o -name '*.mjs' \
       -o -name '*.svg' -o -name '*.webmanifest' \) -print0)
  touch "$candidate/.deploy-ready"
  chown -R for-now:for-now "$candidate"
  if [ -e "$release" ]; then
    release="$releases/${commit}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  fi
  mv "$candidate" "$release"
  trap - EXIT
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
rollback_dir=$(mktemp -d "$base/.deploy-rollback.XXXXXX")
managed_files=(
  /etc/for-now.env
  /etc/systemd/system/for-now.service
  /etc/systemd/system/for-now-backup.service
  /etc/systemd/system/for-now-backup.timer
  /etc/systemd/system/for-now-monitor.service
  /etc/systemd/system/for-now-monitor.timer
  /usr/local/sbin/for-now-backup
  /usr/local/sbin/for-now-restore-drill
  /usr/local/sbin/for-now-migrate-attachments
  /var/www/app-portal/index.html
  /etc/nginx/snippets/for-now.conf
  /etc/nginx/snippets/acme-challenge.conf
  /etc/nginx/sites-available/dysf
  /usr/local/sbin/for-now-deploy
)
for index in "${!managed_files[@]}"; do
  file=${managed_files[$index]}
  if [ -e "$file" ]; then cp -p "$file" "$rollback_dir/$index"; fi
done
switched=0
monitor_was_enabled=0
if systemctl is-enabled --quiet for-now-monitor.timer 2>/dev/null; then monitor_was_enabled=1; fi
rollback() {
  status=$?
  trap - EXIT
  set +e
  for index in "${!managed_files[@]}"; do
    file=${managed_files[$index]}
    if [ -e "$rollback_dir/$index" ]; then cp -p "$rollback_dir/$index" "$file"; else rm -f "$file"; fi
  done
  systemctl daemon-reload
  if [ "$monitor_was_enabled" -eq 1 ]; then systemctl enable --now for-now-monitor.timer
  else systemctl disable --now for-now-monitor.timer; fi
  if [ "$switched" -eq 1 ]; then
    if [ -n "$previous" ] && [ -d "$previous" ]; then
      ln -sfn "$previous" "$base/.app-rollback"
      mv -Tf "$base/.app-rollback" "$current"
      if ! systemctl restart for-now.service || ! curl -fsS http://127.0.0.1:4173/readyz >/dev/null 2>&1; then
        echo "Previous release restored but recovery is unhealthy; inspect for-now.service." >&2
      fi
    else
      rm -f "$current"
      systemctl stop for-now.service
      echo "No previous release exists; service stopped." >&2
    fi
  fi
  nginx -t && systemctl reload nginx
  rm -rf "$rollback_dir"
  echo "Deployment failed; code/config rollback attempted." >&2
  exit "$status"
}
trap rollback EXIT
install -o root -g root -m 0644 "$release/deploy/for-now.service" /etc/systemd/system/for-now.service
install -o root -g root -m 0644 "$release/deploy/for-now-backup.service" /etc/systemd/system/for-now-backup.service
install -o root -g root -m 0644 "$release/deploy/for-now-backup.timer" /etc/systemd/system/for-now-backup.timer
install -o root -g root -m 0644 "$release/deploy/for-now-monitor.service" /etc/systemd/system/for-now-monitor.service
install -o root -g root -m 0644 "$release/deploy/for-now-monitor.timer" /etc/systemd/system/for-now-monitor.timer
install -o root -g root -m 0755 "$release/deploy/backup-to-oss.sh" /usr/local/sbin/for-now-backup
install -o root -g root -m 0755 "$release/deploy/restore-drill.sh" /usr/local/sbin/for-now-restore-drill
install -o root -g root -m 0755 "$release/deploy/migrate-attachments-to-oss.sh" /usr/local/sbin/for-now-migrate-attachments
install -o root -g root -m 0644 "$release/deploy/portal.html" /var/www/app-portal/index.html
install -o root -g root -m 0644 "$release/deploy/nginx-for-now.conf" /etc/nginx/snippets/for-now.conf
install -o root -g root -m 0644 "$release/deploy/nginx-acme-challenge.conf" /etc/nginx/snippets/acme-challenge.conf
if [ -f /etc/letsencrypt/live/123.57.140.24/fullchain.pem ] && \
   [ -f /etc/letsencrypt/live/123.57.140.24/privkey.pem ] && \
   [ -f /etc/letsencrypt/live/77liu.top/fullchain.pem ] && \
   [ -f /etc/letsencrypt/live/77liu.top/privkey.pem ]; then
  install -o root -g root -m 0644 "$release/deploy/nginx-dysf.conf" /etc/nginx/sites-available/dysf
fi
systemctl daemon-reload
nginx -t
ln -sfn "$release" "$base/.app-next"
mv -Tf "$base/.app-next" "$current"
switched=1

if grep -q '^APP_VERSION=' /etc/for-now.env; then
  sed -i "s/^APP_VERSION=.*/APP_VERSION=${commit:0:12}/" /etc/for-now.env
else
  printf 'APP_VERSION=%s\n' "${commit:0:12}" >> /etc/for-now.env
fi

systemctl restart for-now.service
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4173/readyz >/dev/null 2>&1; then
    systemctl reload nginx
    systemctl enable --now for-now-monitor.timer
    install -o root -g root -m 0755 "$release/deploy/deploy.sh" /usr/local/sbin/for-now-deploy
    trap - EXIT
    rm -rf "$rollback_dir"
    # Keep both the active release and the immediate rollback target.
    while IFS= read -r stale; do
      if [ "$stale" != "$release" ] && [ "$stale" != "$previous" ]; then rm -rf "$stale"; fi
    done < <(find "$releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +6 | cut -d' ' -f2-)
    echo "Deployed ${commit:0:12}"
    exit 0
  fi
  sleep 1
done

echo "Health check failed." >&2
exit 1
