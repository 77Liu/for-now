#!/bin/bash

set -euo pipefail

readonly TEAM_ID="Y4C56M94J3"
readonly TIME_ZONE="Asia/Shanghai"
readonly WINDOW_START=100
readonly WINDOW_END=800
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly PROJECT="$ROOT/ios/App/App.xcodeproj"
readonly SCHEME="App"
readonly TEST_TARGET="AppUITests/DevicePerformanceAcceptanceTests"

usage() {
  cat <<'EOF'
Usage:
  scripts/ios-device-performance.sh plan
  scripts/ios-device-performance.sh build
  scripts/ios-device-performance.sh test

Required environment:
  CIKE_IOS_PERF_ENABLED=1
  CIKE_IOS_PERF_ISOLATED=1
  CIKE_IOS_PERF_TEST_URL=https://isolated.example.test/app/
  CIKE_IOS_PERF_SHADOW_USERNAME=<shadow account>
  CIKE_IOS_PERF_SHADOW_PASSWORD=<shadow password>
  CIKE_IOS_DEVICE_NAME=<connected iPhone name>

Optional environment:
  CIKE_IOS_CANDIDATE_SHA=<expected commit; defaults to HEAD>
  CIKE_IOS_PERF_OUTPUT_DIR=<artifact root; defaults under artifacts/>

The build and test actions only run from 01:00 inclusive to 08:00 exclusive
in Asia/Shanghai. The plan action never builds, installs, or runs tests.
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

in_execution_window() {
  local current
  current="$(TZ="$TIME_ZONE" date +%H%M)"
  ((10#$current >= WINDOW_START && 10#$current < WINDOW_END))
}

assert_execution_window() {
  in_execution_window || fail "device actions are restricted to 01:00-08:00 Asia/Shanghai"
}

validate_environment() {
  [[ "${CIKE_IOS_PERF_ENABLED:-}" == "1" ]] \
    || fail "CIKE_IOS_PERF_ENABLED must equal 1"
  [[ "${CIKE_IOS_PERF_ISOLATED:-}" == "1" ]] \
    || fail "CIKE_IOS_PERF_ISOLATED must equal 1"
  [[ -n "${CIKE_IOS_PERF_TEST_URL:-}" ]] \
    || fail "CIKE_IOS_PERF_TEST_URL is required"
  [[ -n "${CIKE_IOS_PERF_SHADOW_USERNAME:-}" ]] \
    || fail "CIKE_IOS_PERF_SHADOW_USERNAME is required"
  [[ -n "${CIKE_IOS_PERF_SHADOW_PASSWORD:-}" ]] \
    || fail "CIKE_IOS_PERF_SHADOW_PASSWORD is required"
  [[ -n "${CIKE_IOS_DEVICE_NAME:-}" ]] \
    || fail "CIKE_IOS_DEVICE_NAME is required"

  local host
  if [[ "$CIKE_IOS_PERF_TEST_URL" =~ ^https://([^/@:\#]+)(:[0-9]+)?(/[^#]*)?$ ]]; then
    host="${BASH_REMATCH[1]}"
  else
    fail "CIKE_IOS_PERF_TEST_URL must be a credential-free HTTPS URL without a fragment"
  fi
  host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
  host="${host%.}"
  [[ "$host" != "77liu.top" && "$host" != *.77liu.top ]] \
    || fail "production hosts are forbidden"
}

candidate_sha() {
  local head expected
  head="$(git -C "$ROOT" rev-parse HEAD)"
  expected="${CIKE_IOS_CANDIDATE_SHA:-$head}"
  expected="$(git -C "$ROOT" rev-parse "${expected}^{commit}" 2>/dev/null)" \
    || fail "CIKE_IOS_CANDIDATE_SHA does not resolve to a commit"
  [[ "$expected" == "$head" ]] || fail "candidate SHA must match the checked-out HEAD"
  [[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=all)" ]] \
    || fail "candidate worktree must be clean"
  printf '%s' "$head"
}

redact_stream() {
  sed -E \
    -e 's/[[:xdigit:]]{8}-[[:xdigit:]]{16}/<redacted-device-id>/g' \
    -e 's/[[:xdigit:]]{8}(-[[:xdigit:]]{4}){3}-[[:xdigit:]]{12}/<redacted-device-id>/g' \
    -e 's/[[:xdigit:]]{40}/<redacted-hex-id>/g'
}

run_in_window() {
  assert_execution_window
  set +e
  "$@" > >(redact_stream) 2>&1 &
  local command_pid=$!
  local timed_out=0
  while kill -0 "$command_pid" 2>/dev/null; do
    sleep 1
    if ! in_execution_window; then
      timed_out=1
      kill -TERM "$command_pid" 2>/dev/null
      break
    fi
  done
  wait "$command_pid"
  local status=$?
  set -e
  if ((timed_out)); then
    fail "device action was stopped at the end of the 01:00-08:00 window"
  fi
  return "$status"
}

load_device_metadata() {
  local inventory count
  inventory="$(mktemp "${TMPDIR:-/tmp}/cike-xcdevice.XXXXXX")"
  if ! xcrun xcdevice list 2>/dev/null | plutil -convert json -o "$inventory" -; then
    rm -f "$inventory"
    fail "unable to read connected iPhone metadata"
  fi
  count="$(jq --arg name "$CIKE_IOS_DEVICE_NAME" \
    '[.[] | select(.platform == "com.apple.platform.iphoneos"
      and .simulator == false and .available == true and .name == $name)] | length' \
    "$inventory")"
  if [[ "$count" != "1" ]]; then
    rm -f "$inventory"
    fail "CIKE_IOS_DEVICE_NAME must match exactly one available physical iPhone"
  fi
  DEVICE_MODEL="$(jq -r --arg name "$CIKE_IOS_DEVICE_NAME" \
    '.[] | select(.platform == "com.apple.platform.iphoneos"
      and .simulator == false and .available == true and .name == $name)
      | (.modelName // "Unknown iPhone")' "$inventory")"
  DEVICE_MODEL_CODE="$(jq -r --arg name "$CIKE_IOS_DEVICE_NAME" \
    '.[] | select(.platform == "com.apple.platform.iphoneos"
      and .simulator == false and .available == true and .name == $name)
      | (.modelCode // "unknown")' "$inventory")"
  IOS_VERSION="$(jq -r --arg name "$CIKE_IOS_DEVICE_NAME" \
    '.[] | select(.platform == "com.apple.platform.iphoneos"
      and .simulator == false and .available == true and .name == $name)
      | .operatingSystemVersion' "$inventory")"
  rm -f "$inventory"
}

write_command_file() {
  local output="$1"
  shift
  {
    printf '#!/bin/bash\n'
    printf '# Generated command contains no credentials or device identifier.\n'
    printf 'xcodebuild'
    printf ' %q' "$@"
    printf '\n'
  } > "$output"
  chmod 600 "$output"
}

write_metadata() {
  local output="$1"
  local action="$2"
  local status="$3"
  local result_bundle="$4"
  local sha="$5"
  local xcode_version xcode_build
  xcode_version="$(xcodebuild -version | sed -n '1s/^Xcode //p')"
  xcode_build="$(xcodebuild -version | sed -n '2s/^Build version //p')"
  jq -n \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg action "$action" \
    --arg status "$status" \
    --arg resultBundle "$result_bundle" \
    --arg teamID "$TEAM_ID" \
    --arg deviceModel "$DEVICE_MODEL" \
    --arg deviceModelCode "$DEVICE_MODEL_CODE" \
    --arg iOSVersion "$IOS_VERSION" \
    --arg xcodeVersion "$xcode_version" \
    --arg xcodeBuild "$xcode_build" \
    --arg candidateSHA "$sha" \
    '{
      schemaVersion: 1,
      generatedAt: $generatedAt,
      action: $action,
      status: $status,
      resultBundle: $resultBundle,
      teamID: $teamID,
      deviceModel: $deviceModel,
      deviceModelCode: $deviceModelCode,
      iOSVersion: $iOSVersion,
      xcodeVersion: $xcodeVersion,
      xcodeBuild: $xcodeBuild,
      candidateSHA: $candidateSHA,
      isolatedTestEnvironment: true,
      udidRecorded: false
    }' > "$output"
}

print_plan() {
  local sha="$1"
  cat <<EOF
Candidate: $sha
Team: $TEAM_ID
Window: 01:00-08:00 $TIME_ZONE
Destination selector: platform=iOS,name=<CIKE_IOS_DEVICE_NAME>

Signed build-for-testing:
  scripts/ios-device-performance.sh build

Signed physical-device acceptance test:
  scripts/ios-device-performance.sh test

Only $TEST_TARGET is selected. Credentials and the test URL are inherited from
the required environment and are not written to generated commands or metadata.
EOF
}

run_action() {
  local action="$1"
  local sha="$2"
  local short_sha timestamp output_root output_dir derived_data result_bundle metadata command_file
  short_sha="${sha:0:12}"
  timestamp="$(TZ="$TIME_ZONE" date +%Y%m%d-%H%M%S)"
  output_root="${CIKE_IOS_PERF_OUTPUT_DIR:-$ROOT/artifacts/ios-device-performance}"
  output_dir="$output_root/$timestamp-$short_sha-$action"
  derived_data="$output_dir/DerivedData"
  result_bundle="$output_dir/$action.xcresult"
  metadata="$output_dir/metadata.json"
  command_file="$output_dir/xcodebuild-command.sh"
  mkdir -p "$output_dir"
  output_dir="$(cd "$output_dir" && pwd)"
  derived_data="$output_dir/DerivedData"
  result_bundle="$output_dir/$action.xcresult"
  metadata="$output_dir/metadata.json"
  command_file="$output_dir/xcodebuild-command.sh"

  load_device_metadata
  write_metadata "$metadata" "$action" "prepared" "$result_bundle" "$sha"

  run_in_window npx --no-install cap sync ios

  local -a arguments=(
    -project "$PROJECT"
    -scheme "$SCHEME"
    -configuration Debug
    -destination "platform=iOS,name=$CIKE_IOS_DEVICE_NAME"
    -derivedDataPath "$derived_data"
    -clonedSourcePackagesDirPath "$ROOT/.xcode-packages"
    -allowProvisioningUpdates
    -resultBundlePath "$result_bundle"
    "DEVELOPMENT_TEAM=$TEAM_ID"
    CODE_SIGN_STYLE=Automatic
  )
  if [[ "$action" == "build" ]]; then
    arguments+=(build-for-testing)
  else
    arguments+=("-only-testing:$TEST_TARGET" test)
  fi
  write_command_file "$command_file" "${arguments[@]}"

  local status="passed"
  if ! run_in_window xcodebuild "${arguments[@]}"; then
    status="failed"
  fi
  write_metadata "$metadata" "$action" "$status" "$result_bundle" "$sha"

  printf 'Result bundle: %s\n' "$result_bundle"
  printf 'Metadata: %s\n' "$metadata"
  printf 'Generated command: %s\n' "$command_file"
  [[ "$status" == "passed" ]] || exit 1
}

main() {
  local action="${1:-}"
  case "$action" in
    plan|build|test)
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac

  require_command git
  require_command jq
  require_command npx
  require_command plutil
  require_command xcodebuild
  require_command xcrun
  validate_environment

  if [[ "$action" != "plan" ]]; then
    assert_execution_window
  fi

  local sha
  sha="$(candidate_sha)"
  if [[ "$action" == "plan" ]]; then
    print_plan "$sha"
    exit 0
  fi

  run_action "$action" "$sha"
}

main "$@"
