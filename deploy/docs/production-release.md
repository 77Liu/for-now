# 生产候选部署与回退

从受审仓库根目录执行文中的相对路径命令；服务器命令须在已有授权覆盖范围内执行。返回[部署地图](../README.md)。

## Deploy updates

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
```

Set `reviewed_branch` to the reviewed release/hotfix branch. The returned JSON field `attemptId` supplies `issued_attempt_id`; attempts expire after one hour by default and are
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

The deployer requires an explicit `DEPLOY_BRANCH`: `release/*` or `hotfix/*` for candidates; `main` is only for redeploying an already formal version. Missing, malformed, and other branches are rejected. Branch movement that changes the approved SHA also stops deployment.

After successful deployment, complete observation before promoting main, then merge the formal main node back to develop according to the [release SOP](../../SOP/release-and-observation.md). The deployer never promotes main or creates a formal Release.

### 执行部署：选择一个入口

更新媒体 profile 时使用下方媒体入口；不更新 profile 时，在服务器执行：

```bash
sudo RELEASE_ATTEMPT_ID="$issued_attempt_id" RELEASE_CANDIDATE_SHA="$reviewed_sha" \
  DEPLOY_BRANCH="$reviewed_branch" for-now-deploy
```

两个入口都消费同一类单次 attempt，不能连续执行二者或重放已完成的 attempt。观察及 main 晋级按发布 SOP 执行。

### 受保护的私有媒体分发接入

云资源与对象验收见 [v0.5.9 版本记录](../../docs/versions/v0.5.9/README.md)。
应用分发须绑定完成独立审查的完整候选、实际应用验收和受现有授权覆盖的新 production attempt。
先按发布记录安装独立 guard、核验旧部署 worker 已停止，再签发精确候选与当前
生产 SHA 的 attempt。安装 guard 不等于部署应用，Preview 与生产决定分开记录。

完成上文 guard 核验和 attempt 签发后，在包含本版部署交付的受审候选目录执行，显式传入已推送的 `release/*`（热修候选为 `hotfix/*`）分支；该分支须解析为获准完整 SHA，无需先合入 main：

```bash
bash deploy/deploy-with-media.sh "$reviewed_sha" "$issued_attempt_id" "$reviewed_branch"
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

云配置报告与合成对象通过不能代替实际账户、浏览器媒体、删除撤权和热缓存有效期的应用验收；当前未完成事项以控制面为准。

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
Real provider and credential validation must reference evidence for the applicable environment; these instructions are not a success receipt.

Log locations, retention, privacy and remaining operational checks are maintained
in `knowledge/observability.md`.

For local UI development against canonical cloud data:

```bash
UPSTREAM_ORIGIN=https://77liu.top/now ./启动.command
```

The local Node process serves local frontend files and proxies API, session, SSE,
and attachment traffic to the cloud.

媒体 helper 只允许只读 `--check` 或绑定 production attempt、完整候选、活跃基线及父部署 PID 的 `--apply-fenced`。候选模块加载和私有临时文件 fsync 在锁外完成；随后导入独立安装的 guard，在与 issue/invalidate 共用的决策锁内重新校验并同步提交 env 与持久 profile。撤销先取得锁时，两文件均不提交；提交先取得锁时，撤销等待临界区结束。两个 rename 并非跨文件崩溃事务；中途 I/O/进程故障由原有受当前决策约束的备份与回滚处理，不允许旧 worker 撤回新的发布决定。
