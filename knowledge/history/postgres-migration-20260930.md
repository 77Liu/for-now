# PostgreSQL 2026-09-30 迁移历史

2026-10-17 从执行正文迁出的原始阶段记录。以下“当前”、部署状态、角色/连接限制和剩余项均指当时；原失败和未完成结论保留，不代表今日状态。当前执行入口见[数据库地图](../postgres-migration.md)。

### 生产前置条件

**当前状态（2026-09-30 生产备份演练后）**：PostgreSQL 16.15 集群
`16/fornowtrial` 仅监听本机，40 连接/512 MiB 上限，仍为手动启动。
正式数据库 `for_now` 已建表，现有基线表均为空；独立角色已验证。最新完成的
OSS 备份已在两套隔离库完成无损导入、导出、恢复和候选 HTTP 验证，演练库
与私有副本均已清理。生产应用继续 JSON 单写，尚未接线或切换。
配置与证据见 [`operations-capacity.md`](../operations-capacity.md) 和
[`production-postgres-recovery-2026-09-30.json`](../../docs/versions/v0.2.0/evidence/production-postgres-recovery.json)。

正式角色如下，均为 `NOSUPERUSER / NOBYPASSRLS / NOCREATEDB / NOCREATEROLE`：

| 角色 | 权限 |
| --- | --- |
| `for_now_owner` | NOLOGIN，数据库、两个 schema、表和受控开户函数的 owner |
| `for_now_schema` | 独立登录，NOINHERIT；显式 `SET ROLE for_now_owner` 后管理 schema |
| `for_now_migration` | 两个 schema 的 USAGE 和表 SELECT/INSERT/UPDATE/DELETE；非 owner |
| `for_now_data` | 仅 `for_now` 的 USAGE 和租户表读写；不得访问 `site_ai_budget`；8 连接上限 |
| `for_now_auth` | 仅 `for_now_auth` 的 USAGE、表读写及开户函数 EXECUTE；8 连接上限 |
| `for_now_budget` | 仅 `for_now` 的 USAGE 和 `site_ai_budget` SELECT/UPDATE；不得访问租户表或认证 schema；2 连接上限 |
| `for_now_backup` | 两个 schema 的 USAGE 和表 SELECT；没有写权限 |

六个登录角色使用独立随机密码，只在 ECS
`/etc/for-now-postgres/credentials.json` 保存（目录 `0700`、文件
`0600 root:root`）；尚未写入或接入 `/etc/for-now.env`。除 data/auth 外
登录角色均为 2 连接上限。数据库和 public schema 已撤销 PUBLIC 默认权限。
建表命令使用 schema 身份时必须在受控连接中显式设置 owner 角色；不能把
schema 身份作为运行连接。最终切换前仍需配置运行/恢复连接、备份/监控、
自动启动，冻结新的 JSON/OSS 快照并复验。

以下保留同日试装前的承载评估过程：

生产切换前必须先由人工确定 PostgreSQL 16 的承载方式和维护责任。2026-09-30
只读核对显示当前 ECS 未安装 `postgres`/`psql`、没有 PostgreSQL systemd
单元或 5432 监听，同时可用内存仅约 302–303 MiB；不得在该实例上直接同机
安装数据库并假设容量充足。可选方案是使用网络受限的托管 PostgreSQL，或
先扩容 ECS 后按 `knowledge/operations-capacity.md` 重新验证内存、磁盘、
备份时长和故障恢复。

同日 08:45 经用户授权停止并禁用未保留的 OpenClaw 网关及仅服务于
Olympics 的 MySQL 后，两轮共 10 次可用内存采样提高到 977～990 MiB，`dysf`、
主应用和中台均保持健康。由此，同机 PostgreSQL 16 可进入低并发 MVP
受控验证，不再要求必须先扩容；但当前 Ubuntu 22.04 软件源只提供
PostgreSQL 14，数据库仍未安装。若采用同机方案，应按
`knowledge/operations-capacity.md` 的受限连接、内存边界和至少 400 MiB
稳定余量执行完整迁移、备份恢复和负载复测。当前 1.57 GiB 仅作为最低限度
试运行规格，长期同机生产推荐至少 4 GiB；托管 PostgreSQL 仍是故障隔离更好
且不需要维护 PGDG 软件源的优先方案。

## 验证证据与剩余范围

本地 PostgreSQL 16.14 已验证：Store v15 全领域、两账户完整批次、认证/schema 授权、密钥分区、生命周期/幂等顺序与扩展、JSON `null` 响应、所有独立文档逐字段往返、附件大小/哈希、同数量内容篡改拦截、整批回滚、源文件漂移拦截，以及关系导出后在第二个全新数据库恢复。`scripts/postgres-runtime-checks.mjs` 进一步覆盖注册失败原子性、跨连接并发、运行断连、多次提交、HTTP 账户/配置/回收站/附件、自动回答默认关闭、设置并发、四类小物派生路径、进程重启、唯一写源、扩展保留、停写导出和恢复数据库的完整关系及附件字节。`npm run test:postgres` 同时运行持久幂等账本的重启与跨进程专项。全部使用合成数据，不连接真实供应商。

| 数据或能力 | 剩余工作 |
| --- | --- |
| 本地运行与恢复 | 已接通并验证；当前使用账户级兼容适配器和单应用实例，不支持多进程调度或增量备份 |
| 生产附件与备份 | 当前 OSS 34 对象已逐字节读取核验；快照 30 附件经两库恢复及 HTTP 比对通过，发布窗口重查变化；云端 PG 备份作业仍待配置 |
| 生产迁移 | 3 账户/11 会话的生产备份演练通过；剩余新快照冻结、停写窗口、连接配置、正式切换与观察 |

真实数据库验证命令与环境安装见 `system-testing.md`。G2 本地数据库门已通过，但不等于 P0-16 生产正式切换完成；生产快照、OSS、迁移、回滚和观察仍按发布门执行。

## 2026-09-30 v0.2.1 生产切换结果

本节是当前生产状态；前文“手动启动、未接线、正式库为空、生产仍为 JSON”
均为切换前历史证据：

- 生产版本为 `v0.2.1 / 6adff978e5fe`，`PERSISTENCE_BACKEND=postgres`；
  data/auth/backup 连接使用同库独立最小角色，数据库服务已配置自动启动。
- 本次候选新增预算角色和 `AI_BUDGET_DATABASE_URL`；在配置该角色并完成权限
  复验前不得部署候选版本。本文不代表该配置已经写入生产。
- 冻结源摘要为
  `3022793f96297004516db2170b678609d37161c2281a43dc26ac5682ab1cfc79`，
  内容摘要为
  `2f3e99474c98e90c684fdbc8f7b6362ae0b9b178b6b5ae4df026f21325b5aafa`。
  正式导入覆盖 3 个账户、12 个会话、260 个业务对象、89 个关系和 30 个
  附件 inventory；重复执行只验真并返回 `reused=true`。
- 停写窗口从 07:01:56Z 到 07:05:28Z，共 212 秒。17 个公开业务集合的
  数量和内容 SHA-256 与停写快照逐项一致，既有浏览器会话继续有效。
- 写入冒烟使用空内部账户创建最小行动，服务重启后读取成功，随后删除并永久
  清理；测试业务记录和临时会话均已移除。
- 切换前后均完成 OSS 备份与逻辑恢复；正式库还分别通过导入后和写入后的
  `pg_dump -Fc` 全库恢复及 19 张表逐表行数/内容摘要比对。
- 旧 JSON 文件只作为回滚副本保留，`.persistence-mode.json` 固定为
  `postgres`。数据库开始正式写入后不得删除标记或直接改回 JSON；任何数据
  回滚都必须先导出并核验 PostgreSQL 新增数据。

完整脱敏证据见
[`v0.2.1-production-cutover-2026-09-30.json`](../../docs/versions/v0.2.1/evidence/production-cutover.json)。
