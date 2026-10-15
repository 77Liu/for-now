# Cloud deployment

The cloud service is the canonical data source. Code is deployed from Gitee;
runtime data lives only in `/srv/for-now/data`; OSS receives consistent backup
archives. Never synchronize a live data directory in both directions.

The isolated online Preview has separate code, service, environment, and data
boundaries. Its installation, deploy, rollback, and verification procedure is
documented in [`README-preview.md`](README-preview.md).

The current production backend is PostgreSQL 16.15. This candidate requires
separate data/auth/AI-budget/recovery roles, offline export, and a protected
single-write boundary documented in
[`knowledge/postgres-migration.md`](../knowledge/postgres-migration.md).
Generic deploy rollback rejects a PostgreSQL configuration if either candidate
or previous code lacks the runtime adapter. PostgreSQL backups require
`PG_BACKUP_DATABASE_URL`; the cloud restore drill validates the exported logical
JSON and attachments, while a fresh-database restore remains a separate gate.

The `for_now` database contains the migrated production state. Existing
schema-admin, migration, runtime-data, runtime-auth, and read-only recovery
logins have passed production privilege checks. This candidate additionally
requires a runtime-budget login and `AI_BUDGET_DATABASE_URL`; provision and
verify them before deployment. Credentials remain only in root-owned
`0700/0600` server files and connection URLs in `/etc/for-now.env`. PostgreSQL
starts automatically, and `/srv/for-now/data/.persistence-mode.json` prevents
direct reuse of the stale JSON write source. Cutover and recovery evidence is
recorded in
[`docs/versions/v0.2.1/evidence/production-cutover.json`](../docs/versions/v0.2.1/evidence/production-cutover.json).

## Access model

- Nginx keeps the existing application at `/`.
- `/apps/` is a small application router.
- HTTP requests and HTTPS requests to the public IP redirect to `https://77liu.top`.
- Domain HTTPS `/now/` proxies to this Node service and requires an invited account.
- Domain HTTPS `/platform/` proxies to the
  independently deployed read-only platform console on `127.0.0.1:4280`.
- `/now/api/admin/v1/snapshot` is blocked at Nginx. Only the local platform
  process can call it with its service token.

Let's Encrypt issues certificates for both `77liu.top` and the public IPv4
address. Nginx uses the domain certificate for the application and retains the
IP certificate for a trusted redirect to the canonical domain. Certbot renews
both automatically. The ECS security group must allow inbound TCP 80 and 443.

The production domain cutover completed on 2026-09-29 as an Nginx-only change.
`https://77liu.top/now/` returned 200 with a matching certificate; domain HTTP
and public-IP HTTPS returned 308 to the canonical domain. `certbot renew
--dry-run` succeeded and the renewal timer was enabled. The pre-change server
configuration is `/etc/nginx/sites-available/dysf.before-domain-20260929-175523`.
No application release or data change was part of that operation.

## Initial server setup

1. Install Node.js 20 or newer and npm at `/usr/local/bin/node` and
   `/usr/local/bin/npm`, plus Git, Nginx, Certbot 5.4 or newer, ossutil 2, and
   FFmpeg at `/usr/bin/ffmpeg`. FFmpeg is required to normalize private M4A
   recordings before streaming ASR; deployment fails closed when it is absent.
2. Attach an ECS RAM role with separate least-privilege access to
   `for-now-backups/*` and `for-now-attachments/*`. The exact attachment policy
   is documented in `knowledge/operations-capacity.md`.
3. Run `sudo deploy/prepare-server.sh`.
4. Add the printed public key to Gitee as a read-only deploy key.
5. Set `INVITE_CODE_HASH`, `PLATFORM_SERVICE_TOKEN_HASH`, OSS attachment settings,
   `FEISHU_ALERT_WEBHOOK`, `VOLCENGINE_SPEECH_API_KEY`,
   `VOLCENGINE_ACCESS_KEY_ID`, and `VOLCENGINE_SECRET_ACCESS_KEY` in
   `/etc/for-now.env`. Store only the invitation
   and platform-token SHA-256 digests, not their plaintext values, and keep
   `COOKIE_SECURE=1`. The matching platform token plaintext belongs only in
   `/etc/for-now-platform.env`. Keep
   `ATTACHMENT_STORAGE=local` until the migration sequence below succeeds.
   Use a least-privilege visual-service sub-user instead of a root-account
   Access Key. Detailed service and smoke-test instructions are in
   `knowledge/volcengine-integration.md`.
   Keep `INCREMENTAL_SYNC_ENABLED=1` for the normal client cursor-polling path.
   Set it to `0` only as a temporary frontend rollback: durable writes continue
   to use the same API and server-side sync ledger, while the browser falls back
   to the existing write-followed-by-refresh behavior. After changing it,
   restart the application and verify that “我的 → 同步状态” reports that
   incremental sync is disabled before admitting traffic.
6. Include `/etc/nginx/snippets/acme-challenge.conf` in the port-80 server,
   reload Nginx, then issue the IP and domain certificates:

   ```bash
   sudo certbot certonly --webroot -w /var/www/letsencrypt \
     --ip-address 123.57.140.24 --preferred-profile shortlived \
     --non-interactive --agree-tos --register-unsafely-without-email \
     --deploy-hook "systemctl reload nginx"
   sudo certbot certonly --webroot -w /var/www/letsencrypt \
     -d 77liu.top --deploy-hook "systemctl reload nginx"
   ```

7. Install `deploy/nginx-dysf.conf` as `/etc/nginx/sites-available/dysf`, then
   run `sudo nginx -t && sudo systemctl reload nginx`.
8. Install the reviewed release guard and issue a production attempt as described under “Deploy updates”, then run the deployer with that attempt.
9. Before the first account is registered, migrate the existing local data with
   `deploy/migrate-data.sh user@server`.
10. Verify `sudo /usr/local/sbin/for-now-backup`, then enable the timer with
   `sudo systemctl enable --now for-now-backup.timer`.
11. Complete the private attachment migration below, run
   `sudo /usr/local/sbin/for-now-restore-drill`, and send one real Feishu test
   alert before enabling invitations.

`prepare-server.sh` does not install or provision PostgreSQL. Before the v0.2.0
cutover, choose a PostgreSQL 16 host, verify its capacity and network/TLS
boundary, and create the separate schema-admin, migration, runtime-data,
runtime-auth, and read-only recovery roles described in
[`knowledge/postgres-migration.md`](../knowledge/postgres-migration.md). Do not
set `PERSISTENCE_BACKEND=postgres` until the latest JSON/OSS snapshot, full
migration, independent restore, and rollback checks have passed.

## Read-only platform console

The platform console is a separate orphan branch (`platform/main`) and systemd
service in the same Gitee repository. Its deployment instructions live in that
branch's `README.md`. The main application exposes one aggregate endpoint for it:

- direct loopback access only, with no `X-Forwarded-For`;
- `Authorization: Bearer ...` checked against
  `PLATFORM_SERVICE_TOKEN_HASH`;
- counts, status, timings and cost only;
- no record content, model prompt/response, attachment body or credential.

Deploy the main application first, then the platform console. Verify that the
public `/now/api/admin/v1/snapshot` path returns 404 before opening
`https://77liu.top/platform/`. Keep `MONITOR_PLATFORM_ENABLED=0` while the
platform service does not exist. After its `/readyz` and public login smoke
tests pass, set the value to `1` and run `for-now-monitor.service` once; only
then leave the five-minute timer enabled for platform monitoring.

ossutil uses `--mode EcsRamRole` and the Beijing internal endpoint from
`/etc/for-now.env`; no long-lived AccessKey is stored on disk.

## Historical keepsake media migration

Legacy keepsakes are never rewritten during application startup. Stop the
application before applying a migration, load the same environment used by the
service, and first generate a read-only plan:

```bash
sudo -u for-now /bin/bash -c '
  set -a
  source /etc/for-now.env
  set +a
  npm run migrate:keepsake-media -- --dry-run
'
```

Review the per-account blocked count and retain the printed `planSha256`. Apply
only that exact plan:

```bash
sudo -u for-now /bin/bash -c '
  set -a
  source /etc/for-now.env
  set +a
  npm run migrate:keepsake-media -- --apply \
    --expected-plan-sha256 REVIEWED_SHA256
'
```

For OSS, dry-run requires both the original and legacy cutout in primary object
storage; a local fallback does not count as migration evidence. Apply creates
the four WebP derivatives and updates the record only if its paths and versions
still match the reviewed plan. It preserves the old `cutoutPath` and object for
rollback. Final deletion requires a later backup, restore drill, observation
window, and separate approval.

## Private attachment migration

The OSS bucket must remain private. After the RAM role can list, put, get and
delete only under `for-now-attachments/*`, run a harmless object probe, then
copy existing local images while writes are stopped:

```bash
sudo /bin/bash -c '
  set -a
  source /etc/for-now.env
  set +a
  exec runuser --preserve-environment -u for-now -- \
    /usr/local/bin/node /opt/for-now/app/scripts/oss-attachment-smoke.mjs
'
sudo systemctl stop for-now.service
sudo /usr/local/sbin/for-now-migrate-attachments
sudo sed -i 's/^ATTACHMENT_STORAGE=.*/ATTACHMENT_STORAGE=oss/' /etc/for-now.env
sudo systemctl start for-now.service
curl -fsS http://127.0.0.1:4173/readyz
```

Do not delete the local attachment directories during this release. They are
the rollback copy and the application can read them when an old object is not
yet present. Verify authenticated upload/read, record pages, and a restore drill
before scheduling any cleanup.

## Monitoring and restore

`for-now-monitor.timer` checks the service, disk, backup age, consecutive AI
failures and daily AI cost every five minutes. The deployment enables it after a
healthy application restart. JSON mode reads account usage files; PostgreSQL
mode requires `PG_BACKUP_DATABASE_URL` and reads usage through that cross-schema
SELECT-only role. A PostgreSQL read failure fails the monitor run instead of
silently reporting zero cost. Test the Feishu channel without printing its
webhook or secret:

```bash
sudo /bin/bash -c '
  set -a
  source /etc/for-now.env
  set +a
  release=$(readlink -f /opt/for-now/app)
  cd "$release"
  exec runuser --preserve-environment -u for-now -- \
    /usr/local/bin/node scripts/monitor-health.mjs --test-alert
'
sudo /usr/local/sbin/for-now-restore-drill
```

Thresholds, test expectations, current production capacity and the last real
restore result are maintained in `knowledge/operations-capacity.md`.

## Deploy updates

### 受保护的私有媒体分发接入

云资源与对象验收见 [v0.5.9 版本记录](../docs/versions/v0.5.9/README.md)。
应用分发须绑定完成独立审查的完整候选、实际应用验收和新 production decision。
先按发布记录安装独立 guard、核验旧部署 worker 已停止，再签发精确候选与当前
生产 SHA 的 attempt。安装 guard 不等于部署应用，Preview 与生产决定分开记录。

在包含本版部署交付的已审 main 提交目录执行：

```bash
bash deploy/deploy-with-media.sh <40位受审main提交SHA> <32位新production-attempt-ID>
```

入口核对四份本地文件与受审 Git 对象，使用项目 SSH 专用钥匙与严格 known_hosts，
只上传非敏感 profile 和哈希清单到 root 私有临时目录。远端核对 profile 哈希及
独立安装的 for-now-deploy 字节；不上传或运行候选内的部署脚本，不自行签发决定。
guard 在配置应用、profile 持久化、切换和回滚等共享副作用前重查代次；陈旧
worker 被拒绝，不能恢复新决定的配置。

CDN key 留在服务器 /etc/for-now-media-cdn.key，root:root/0600，不进入参数、
笔记本、源码或输出。候选 helper 校验源存储、配置映射与 delivery validator，
再原子写入 /etc/for-now.env 的 MEDIA_*。只读 --check 不改配置；非法配置、
旧候选、公开权限或符号链接均拒绝。成功后 /etc/for-now-media-delivery.json
以0600持久化，后续正常受guard部署继续应用；失败按当前有效决定恢复原环境
与 profile 的原内容或原缺失状态。

回到 proxy 需要受审配置操作：移除持久 profile 并设置 MEDIA_DELIVERY_MODE=proxy，
再按新的发布决定重启。原件、即时撤销对象仍遵循现有 proxy 策略；有 profile 时
后续部署会再次启用分发。代码回滚不替代数据库/附件恢复。

```bash
npm run test:media-deploy
npm run test:deploy
```

本轮不处理媒体证书续期、自动化或提醒，Owner已明确暂缓；云配置报告与合成
对象通过不能代替实际账户、浏览器媒体、删除撤权和热缓存有效期的应用验收。

After review and authorization, install the guard from the reviewed checkout:

```bash
sudo /bin/bash deploy/install-release-fence.sh
```

The installer stores both guarded deploy entries in `/usr/local/sbin` and the
CLI and helper outside candidate releases under
`/usr/local/lib/for-now-release`, with private root-owned decision state under
`/var/lib/for-now-release`. It refuses installation while either target has an
execution receipt or a decision writer. Use this installer from a verified checkout when upgrading an older
installation; pushing a candidate does not install the guard or entries. Runtime
deployment and rollback never replace the independently installed deploy entries,
so recovery to a pre-fence release cannot remove enforcement.

The release owner first reads `production` with the installed CLI, then issues a
new attempt for the reviewed full 40-character candidate SHA and current active
SHA (the first 40 characters of the active release directory; 40 zeroes for a
first installation). Pass the previous `attemptId` as `--expected-attempt-id` on
all later issue/invalidate operations; omit it only if no prior decision exists:

```bash
sudo /usr/local/bin/node /usr/local/lib/for-now-release/release-fence.mjs issue \
  --target production --candidate-sha "$reviewed_sha" --baseline-sha "$active_sha" \
  --action deploy --expected-attempt-id "$previous_attempt_id"
sudo RELEASE_ATTEMPT_ID="$issued_attempt_id" RELEASE_CANDIDATE_SHA="$reviewed_sha" \
  for-now-deploy
```

The returned JSON supplies `issued_attempt_id`; approvals last one hour and are
single use. Fetch must resolve to the approved SHA before candidate build. Each
shared write/restart checks the attempt, worker PID and active SHA again.
Repeating a completed or invalidated attempt fails even for the same candidate;
a reviewed same-SHA retry requires a fresh issue and still reuses ready assets.
Candidate rejection or rollback invalidates the old attempt. Owner cancellation
uses `invalidate --target production --expected-attempt-id "$issued_attempt_id"`.
An authorized automatic rollback advances to a new attempt; a worker whose
authority was superseded cannot restore its old configuration or symlinks. If
cancellation follows partial configuration changes, the new owner must inspect
and recover them with a fresh decision. Never delete or steal an execution receipt
while its worker is alive. Production and Preview decisions are independent.

The deploy script rejects both `explore/*` and `checkpoint/*`; an intermediate
checkpoint must first pass the release review and be promoted through an
authorized release branch.

The deploy command builds dependencies in a new candidate directory, validates
JavaScript and the versioned prompt catalog, then runs a read-only PostgreSQL
runtime preflight when `PERSISTENCE_BACKEND=postgres`. The preflight verifies
that data, auth and AI-budget connections use distinct compatible roles, that
the budget singleton exists, and that each role has exactly its permitted
privileges. Only then does deployment mark the immutable release ready, switch
the active symlink, restart systemd, and check `/readyz`. Re-running the same
commit never runs `npm ci` inside the active release. Failure after configuration
installation, while the worker still owns its decision, restores the previous code, managed service/Nginx files, deployment
backup tools, and `/etc/for-now.env` (including `APP_VERSION`). An unhealthy recovery is
reported explicitly; the deployment remains failed. Data is not rolled back by
this script. Take and verify a data backup before a release with migrations.

`PROMPT_CATALOG_VERSION` may pin any immutable version included under
`prompts/versions/`; leave it empty to use `prompts/manifest.json` `activeVersion`.
Changing the pin requires a service restart, and a missing or modified catalog
causes startup and candidate validation to fail rather than falling back.

An older installed deployer may lack dependency installation, modular checks or
fencing. Before deployment, transfer and verify the reviewed checkout and run its
`deploy/install-release-fence.sh`; do not bootstrap only a candidate deploy script.
The separately installed guard, core and both deploy entries form one reviewed
tooling unit. Its upgrade is blocked while any deployment owns an execution
receipt. Application release success and code/config rollback do not change it.

These are future release instructions, not evidence of a deployment. Local
rollback control flow is covered by `npm run test:deploy`; real systemd/Nginx
recovery still requires target-environment validation.
Production RAM credentials have completed a real
`SegmentHDCommonImage → GetAsyncJobResult → PNG download` smoke test.

Log locations, retention, privacy and remaining operational checks are maintained
in `knowledge/observability.md`.

For local UI development against canonical cloud data:

```bash
UPSTREAM_ORIGIN=https://77liu.top/now ./启动.command
```

The local Node process serves local frontend files and proxies API, session, SSE,
and attachment traffic to the cloud.

媒体 helper 只允许只读 `--check` 或绑定 production attempt、完整候选、活跃基线及父部署 PID 的 `--apply-fenced`。候选模块加载和私有临时文件 fsync 在锁外完成；随后导入独立安装的 guard，在与 issue/invalidate 共用的决策锁内重新校验并同步提交 env 与持久 profile。撤销先取得锁时，两文件均不提交；提交先取得锁时，撤销等待临界区结束。两个 rename 并非跨文件崩溃事务；中途 I/O/进程故障由原有受当前决策约束的备份与回滚处理，不允许旧 worker 撤回新的发布决定。
