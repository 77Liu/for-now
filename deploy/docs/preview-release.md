# Preview 部署、回退与验证

从受审仓库根目录执行文中的相对路径命令；服务器命令须在已有授权覆盖范围内执行。返回[部署地图](../README.md)。

## Deploy

Install the independently reviewed guard with
`sudo /bin/bash deploy/install-release-fence.sh` before using the updated deployer (see
[production guard installation](../README.md#deploy-updates)). Publish an explicitly
reviewed branch under `preview/*`, then issue a fresh `preview` decision through
`/usr/local/lib/for-now-release/release-fence.mjs issue` with `--action deploy`, the
reviewed full SHA, current Preview SHA (or 40 zeroes when absent), and the previous
Preview attempt ID as the CAS precondition. Set `reviewed_preview_branch` to the reviewed `preview/*` branch and use the returned JSON `attemptId`:

```bash
sudo DEPLOY_BRANCH="$reviewed_preview_branch" RELEASE_ATTEMPT_ID="$issued_attempt_id" \
  RELEASE_CANDIDATE_SHA="$reviewed_sha" for-now-preview-deploy deploy
```

The deployer fetches the independent bare mirror, archives the branch commit
into a new candidate, runs `npm ci`, `npm run build:runtime`, then `npm prune --omit=dev`, checks JavaScript and shell
syntax, validates the versioned Prompt catalog, and creates deterministic gzip
files for public text assets. Only a completed immutable candidate receives a
`.preview-deploy-ready` marker.

After candidate validation it snapshots Preview-managed configuration, installs
the Preview unit/snippet, atomically switches
`/opt/for-now-preview/app`, restarts only `for-now-preview.service`, and polls:

```text
http://127.0.0.1:4175/preview/readyz
```

Nginx reloads only after readiness succeeds. Re-running the same branch commit
reuses the marked immutable release and does not run `npm ci` again, but requires
a fresh attempt ID. Replaying an old, completed or invalidated same-SHA command
fails. The fetched SHA is checked before candidate dependency installation.
The independently installed guarded deploy entry is preserved even when a
rollback target contains an old pre-fence deploy script. Preview checks only its
own decision and active SHA; it cannot claim production.
Use `invalidate --target preview --expected-attempt-id "$issued_attempt_id"` to
cancel. A revoked worker stops before its next shared effect; configuration
already installed before cancellation must be recovered by the new owner.

## Rollback

Issue a fresh `preview` decision with `--action rollback`, candidate SHA equal
to the completed rollback target, baseline SHA equal to current Preview, and the
previous attempt ID as CAS precondition. Then roll back to the recorded previous
Preview release:

```bash
sudo DEPLOY_BRANCH="$reviewed_preview_branch" RELEASE_ATTEMPT_ID="$issued_attempt_id" \
  RELEASE_CANDIDATE_SHA="$rollback_sha" for-now-preview-deploy rollback
```

Or select a completed release by its full 40-character commit:

```bash
sudo DEPLOY_BRANCH="$reviewed_preview_branch" RELEASE_ATTEMPT_ID="$issued_attempt_id" \
  RELEASE_CANDIDATE_SHA="$rollback_sha" for-now-preview-deploy rollback "$rollback_sha"
```

Rollback uses the same atomic switch, restart, and readiness gate. A failed
deploy or failed rollback that still owns its decision restores only the former
Preview symlink, Preview
environment version, Preview service/snippet, and prior Preview
service state. If no former Preview release exists, the Preview service is
stopped. Production code, service, environment, and data are never rollback
targets.

## Verification

Run the local simulation before installation:

```bash
npm run test:deploy:preview
```

The regression uses command shims and temporary directories. It performs no
network request, deployment, push, provider call, or remote command. It covers
installation, candidate validation, static gzip, same-commit idempotency,
explicit rollback, health-failure rollback, branch/env rejection, and byte-level
production symlink/service/env/data isolation.

After an authorized real installation, separately verify:

```bash
curl -fsS http://127.0.0.1:4175/preview/readyz
curl -fsSI https://77liu.top/preview/ | grep -i x-robots-tag
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://77liu.top/preview/api/admin/v1/snapshot
sudo systemctl status for-now-preview.service
```

The expected snapshot status is `404`. Real installation and live verification must be covered by the current authorization; an existing applicable continuous authorization need not be requested again.

Run browser journeys against the public Preview URL with the explicit remote
guard. Credentials stay in the process environment and must not be committed:

```bash
E2E_ALLOW_REMOTE_PREVIEW=1 \
E2E_APP_URL=https://77liu.top/preview/ \
E2E_USERNAME=... E2E_PASSWORD=... \
npm run test:journeys:live -- verify
```

The live journey runner accepts no other public origin or path.
