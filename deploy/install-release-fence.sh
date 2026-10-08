#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "Run as root." >&2; exit 1; fi
source_root=$(cd "$(dirname "$0")/.." && pwd)
destination=/usr/local/lib/for-now-release
state_directory=/var/lib/for-now-release
/usr/local/bin/node --check "$source_root/scripts/release-fence.mjs"
/usr/local/bin/node --check "$source_root/scripts/lib/release-fence.mjs"
for script in release-fence.sh deploy.sh deploy-preview.sh; do
  /bin/bash -n "$source_root/deploy/$script"
done
install -d -o root -g root -m 0700 "$state_directory"
owned_locks=()
cleanup_install_locks() {
  for lock in "${owned_locks[@]}"; do rmdir "$lock"; done
}
trap cleanup_install_locks EXIT
# Share the core's decision locks, closing the check/claim race during upgrades.
for target in production preview; do
  lock="$state_directory/$target.json.lock"
  if ! mkdir -m 0700 "$lock"; then
    echo "A $target fence writer is active; guard upgrade is blocked." >&2
    exit 1
  fi
  owned_locks+=("$lock")
done
for target in production preview; do
  if [ -e "$state_directory/$target.json.execution" ]; then
    echo "A $target deployment owns the execution lock; guard upgrade is blocked." >&2
    exit 1
  fi
done
install -d -o root -g root -m 0755 "$destination" "$destination/lib"
install -d -o root -g root -m 0700 /var/lib/for-now-release
install -o root -g root -m 0644 "$source_root/scripts/release-fence.mjs" "$destination/release-fence.mjs"
install -o root -g root -m 0644 "$source_root/scripts/lib/release-fence.mjs" "$destination/lib/release-fence.mjs"
install -o root -g root -m 0644 "$source_root/deploy/release-fence.sh" "$destination/release-fence.sh"
# Runtime releases never replace or roll back these independently reviewed entries.
install -d -o root -g root -m 0755 /usr/local/sbin
install -o root -g root -m 0755 "$source_root/deploy/deploy.sh" /usr/local/sbin/for-now-deploy
install -o root -g root -m 0755 "$source_root/deploy/deploy-preview.sh" /usr/local/sbin/for-now-preview-deploy
echo "Release guard and deploy entries installed. No approval issued and no application changed."
