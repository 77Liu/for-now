#!/usr/bin/env bash
# Installed separately from release contents; a candidate cannot replace its own guard.
release_fence_resolve_directory() {
  local link=$1 destination
  if [ ! -e "$link" ] && [ ! -L "$link" ]; then return; fi
  destination=$(readlink -f "$link" 2>/dev/null) || {
    echo "Release link cannot be resolved." >&2; return 1
  }
  if [ -z "$destination" ] || [ ! -d "$destination" ]; then
    echo "Release link is not an existing directory." >&2; return 1
  fi
  printf '%s\n' "$destination"
}
release_fence_current_sha() {
  local destination name
  destination=$(release_fence_resolve_directory "$release_fence_link") || return
  if [ -z "$destination" ]; then printf '%040d\n' 0; return; fi
  name=${destination##*/}
  if ! [[ "$name" =~ ^([a-f0-9]{40})(-|$) ]]; then
    echo "Active release has no immutable commit identity." >&2; return 1
  fi
  printf '%s\n' "${BASH_REMATCH[1]}"
}
release_fence_call() {
  local operation=$1 actual
  actual=$(release_fence_current_sha) || return
  /usr/local/bin/node /usr/local/lib/for-now-release/release-fence.mjs "$operation" \
    --target "$release_fence_target" --attempt-id "$RELEASE_ATTEMPT_ID" \
    --candidate-sha "$RELEASE_CANDIDATE_SHA" --action "$release_fence_action" \
    --actual-sha "$actual" --pid "$$"
}
release_fence_cleanup() {
  if [ "${release_fence_owned:-0}" = 1 ]; then
    /usr/local/bin/node /usr/local/lib/for-now-release/release-fence.mjs abandon \
      --target "$release_fence_target" --attempt-id "$RELEASE_ATTEMPT_ID" --pid "$$" || true
    release_fence_owned=0
  fi
}
release_fence_init() {
  release_fence_target=$1; release_fence_link=$2; release_fence_action=${3:-deploy}
  : "${RELEASE_ATTEMPT_ID:?An approved release attempt is required}"
  : "${RELEASE_CANDIDATE_SHA:?The approved full candidate SHA is required}"
  release_fence_call claim || return
  release_fence_owned=1
  trap release_fence_cleanup EXIT
}
release_guard() {
  if ! release_fence_call verify; then
    echo "Release authority changed; stopping this worker before the next effect." >&2
    release_fence_cleanup
    exit 1
  fi
  "$@"
}
release_fence_begin_rollback() {
  local decision
  decision=$(release_fence_call rollback) || {
    echo "Old worker cannot roll back a superseding release decision." >&2
    release_fence_cleanup
    return 1
  }
  read -r RELEASE_ATTEMPT_ID RELEASE_CANDIDATE_SHA <<< "$decision"
  release_fence_action=rollback
}
release_fence_finish() {
  release_fence_call complete || return
  release_fence_owned=0
}
