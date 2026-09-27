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

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi
if [ ! -f "$ssh_key" ]; then
  echo "Missing $ssh_key. Run prepare-server.sh and add its public key as a read-only Gitee deploy key." >&2
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
if [ ! -d "$release" ]; then
  mkdir -p "$release"
  sudo -u for-now git --git-dir="$mirror" archive "$commit" | tar -x -C "$release"
  chown -R for-now:for-now "$release"
fi

/usr/local/bin/node --check "$release/server.mjs"
/usr/local/bin/node --check "$release/public/app.js"
ln -sfn "$release" "$base/.app-next"
mv -Tf "$base/.app-next" "$current"

if grep -q '^APP_VERSION=' /etc/for-now.env; then
  sed -i "s/^APP_VERSION=.*/APP_VERSION=${commit:0:12}/" /etc/for-now.env
else
  printf 'APP_VERSION=%s\n' "${commit:0:12}" >> /etc/for-now.env
fi

systemctl restart for-now.service
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4173/readyz >/dev/null; then
    find "$releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +6 | cut -d' ' -f2- | xargs -r rm -rf
    echo "Deployed ${commit:0:12}"
    exit 0
  fi
  sleep 1
done

if [ -n "$previous" ] && [ -d "$previous" ]; then
  ln -sfn "$previous" "$base/.app-rollback"
  mv -Tf "$base/.app-rollback" "$current"
  systemctl restart for-now.service
fi
echo "Health check failed; previous release restored." >&2
exit 1
