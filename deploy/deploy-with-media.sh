#!/usr/bin/env bash
set -euo pipefail
# A fresh production decision is issued separately for this fixed candidate.
expected=${1:-}
attempt=${2:-}
if [ "$#" -ne 2 ] || [[ ! "$expected" =~ ^[a-f0-9]{40}$ ]] || [[ ! "$attempt" =~ ^[a-f0-9]{32}$ ]]; then
  echo "Usage: deploy-with-media.sh <full reviewed main SHA> <fresh production attempt ID>" >&2
  exit 1
fi
project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
identity="$project/.secrets/for-now-deploy"
target=root@123.57.140.24
[ -f "$identity" ] || { echo "Missing protected deployment identity." >&2; exit 1; }
for file in deploy.sh media-delivery.production.json apply-media-config.mjs deploy-with-media.sh; do
  reviewed=$(git -C "$project" cat-file blob "$expected:deploy/$file" | shasum -a 256 | awk '{print $1}')
  local_hash=$(shasum -a 256 "$project/deploy/$file" | awk '{print $1}')
  if [ "$reviewed" != "$local_hash" ]; then
    echo "Local deploy/$file differs from the reviewed commit; stopped before upload." >&2
    exit 1
  fi
done
deployer_hash=$(shasum -a 256 "$project/deploy/deploy.sh" | awk '{print $1}')
ssh_options=(-i "$identity" -o UserKnownHostsFile="$project/.secrets/known_hosts" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10)
stage=$(ssh "${ssh_options[@]}" "$target" 'umask 077; mktemp -d /root/for-now-media-stage.XXXXXXXX')
if [[ ! "$stage" =~ ^/root/for-now-media-stage\.[A-Za-z0-9]{8}$ ]]; then
  echo "Unexpected remote staging path; stopped." >&2
  exit 1
fi
manifest=$(mktemp "${TMPDIR:-/tmp}/for-now-media-manifest.XXXXXX")
cleanup() {
  rm -f -- "$manifest"
  ssh "${ssh_options[@]}" "$target" "rm -rf -- '$stage'" || true
}
trap cleanup EXIT
(cd "$project/deploy"; shasum -a 256 media-delivery.production.json) > "$manifest"
scp "${ssh_options[@]}" "$project/deploy/media-delivery.production.json" "$target:$stage/"
scp "${ssh_options[@]}" "$manifest" "$target:$stage/SHA256SUMS"
# Only the independently installed guarded entry may write env/profile or switch code.
ssh "${ssh_options[@]}" "$target" \
  "cd '$stage' && chmod 600 media-delivery.production.json SHA256SUMS && sha256sum -c SHA256SUMS && test \"\$(sha256sum /usr/local/sbin/for-now-deploy | cut -d ' ' -f 1)\" = '$deployer_hash' && RELEASE_ATTEMPT_ID='$attempt' RELEASE_CANDIDATE_SHA='$expected' DEPLOY_BRANCH=main DEPLOY_EXPECTED_COMMIT='$expected' DEPLOY_MEDIA_CONFIG='$stage/media-delivery.production.json' /usr/local/sbin/for-now-deploy"
