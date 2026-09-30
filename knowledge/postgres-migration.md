# PostgreSQL 迁移与校验

本文件维护迁移的数据映射、命令和边界。迭代状态见 `README-TODO.md`，串并行准入见 `modularization-design.md` 第 11 节。S1 映射与 S2 本地运行/恢复已实现；生产及默认配置仍使用 JSON，导入命令不会自动切换应用写源。

## 已实现的业务 store 映射

`src/shared/persistence/store-mapping.mjs` 将业务实体映射为带领域类型的关系行：

| 表 | 含义与约束 |
| --- | --- |
| `store_fields` | 顶层字段及其数组、对象、普通值形态；区分缺失、空数组与 null |
| `store_objects` | 每个业务对象和嵌套内容独立成行；含集合、类型、ID、父对象、所属字段、顺序、正文/状态/版本索引及原始字段 |
| `store_relations` | 思绪根、日记草稿、任务目标/子目标/结果/重试、通知任务、生成来源等引用；外键包含账户 |
| `store_attachment_refs` | 每个附件路径的拥有对象、字段和原始值路径；包含回收站、待清理项和未知扩展内的路径 |
| `resource_lifecycle` | 每个业务资源的草稿/正式、活跃/删除/正式化/永久清理状态与历史；显式保存数组位置和完整原始 payload |
| `idempotency_ledger` | 90 天请求键、请求哈希、原始响应与期限；显式保存数组位置和完整原始 payload，支持 JSON `null` 响应 |
| `account_snapshots` / `migration_runs` | 原始解析快照、源文件哈希及迁移证据；业务重建不依赖快照表 |

覆盖 `checkins`、`dailyRecords`、`captures`、`journals`、`thoughts`、`chats`、`books`、`keepsakes`、`quotes`、`experiments`、`analyses`、`customMetrics`、`trash`、`attachmentCleanup`、`aiTasks`、`notifications`、`actions`、`habits`、`habitCheckins`、`feedback`、`validationLedger`。`journalDraft`、`onboarding`、`commercialization` 保存为账户级对象。

思绪备注和追问、各体裁批注/漂流批注、批注回复和神鸡对话、日记回望、读书笔记均拆为有父外键和顺序的独立行，不再只嵌在所属业务对象中。父外键不可跨账户或集合；ID 按所属集合/父对象隔离，允许不同体裁使用相同 ID。

原始时间、版本、用户文本、模型文本及推理保留原值；查询用索引列不得代替原始字段。未知字段按原结构保存，不做静默清洗。回收站 `payload` 是用于恢复的历史文档，完整保留，同时提取其中的附件路径；不将已删文档误当作活跃记录。附件引用扫描沿用当前应用的完整 `/attachments/<filename>` 字符串规则，尚不解析 Markdown 内联 URL；完整批次额外读取这些路径对应的实物。

思绪根、嵌套所有权、草稿编辑目标及排队/运行任务的必要目标引用缺失时拒绝导入。终态任务、通知和来源追踪可以指向已清理对象；此类引用显式记为 `historical`，保留目标 ID，不伪造活跃对象。未知关系字段仍保留在原始字段内，后续领域新增关系时须更新映射与测试。

早期 `entries`、`entry_blocks`、`thought_follow_ups`、`thought_remarks`、`annotations` 核对投影已从导入/验证路径移除，schema 初始化会删除这些旧投影表。思绪与嵌套内容只使用正式 `store_objects` 关系模型；原始证据仍在迁移快照内。

## 独立文件与附件

`document-mapping.mjs` 定义无损映射，`postgres-documents.mjs` 负责关系读写，`postgres-bundle.mjs` 编排批次事务：

| 来源 | 正式映射 |
| --- | --- |
| `auth.json` | 独立 `for_now_auth` schema：`users` 每账户一行，用户名规范键唯一、密码哈希独列；`sessions` 每摘要一行、外键指向账户；扩展与原始时间保留，顶层字段单独存放 |
| `llm-settings.json` | `account_documents` 标记存在性；`document_fields` 保留字段形态；每个档位、场景、回答风格写入 `document_records`；`apiKey` 仅在 `document_secrets`，不复制进普通字段/记录/迁移快照 |
| `ai-usage.json` | 每次调用按原 ID 独立成行，场景/模型/状态可查询；Token、费用、价格快照及扩展与调用同行保存 |
| `ai-cost-plan.json` | 每场景一行，全局预算、汇率和扩展字段独立保存 |
| 附件 | `attachment_inventory` 保存路径、实际存储来源、对象键、字节数、SHA-256 和状态；包含有效引用、回收站引用、清理队列以及本地未引用文件 |

认证查询发生在确定账户之前，不能假装使用租户 RLS。`for_now_auth` 通过独立 schema/专用角色授权；租户数据角色不得获得其权限。密码哈希和会话摘要不返回业务接口。账户配置、密钥、附件清单仍由强制 RLS 隔离。数据库秘密需要由数据库访问权限、备份访问控制和磁盘加密保护；这里的分表不等同于应用层加密。

缺失的可选设置/用量/成本文件与存在的空对象有区别，不凭空补齐默认值；无效 JSON、重复调用/场景/身份、大小写重名、孤儿会话或不安全账户路径均拒绝导入。认证和配置未知字段保留，数组顺序及 JSON null 不丢失。

附件检查默认只读本地。显式选择 OSS 后逐个读取对象并计算 SHA-256；远端不存在而本地可读时，按现有应用回退语义标记实际来源为 `local`，不伪称 OSS 存活。有效/回收站引用缺失阻止导入；只有全部引用均来自清理队列时允许 `missing_cleanup`。符号链接与非普通文件拒绝盘点。清单不枚举整个 OSS 桶的无引用对象，也不执行删除。正式 OSS 实物证据须在发布演练时获取，本地 mock 不代替生产证据。

## 校验与覆盖保护

1. 解析源文件与传入 store 必须相同；`sourceSha256` 标识原始文件字节，`contentSha256` 标识键排序后的 JSON 内容。对象键顺序不影响内容哈希，数组顺序必须一致。
2. 生成迁移计划时立即做往返重建；重复 ID、错误集合类型、孤儿引用或有损 JSON 值拒绝进入数据库。
3. 默认完整批次将所有账户、认证、配置、用量和附件清单放在同一事务中；批次锁与逐账户锁共同防止重复导入。旧 `--store-only` 诊断模式仍逐账户提交，不能当作完整迁移。
4. 导入后核对数量、每行字段、顺序、所有权、关系、附件清单及重建内容哈希。生命周期和幂等元数据也保存显式位置与原始 payload；旧表升级只能从账户快照恢复这些列，证据不足时拒绝启动。任一不符整事务回滚。
5. 同一源哈希再次导入时，校验实际数据后复用原迁移记录；不删除重建，不自动“修复”已经损坏的目标。
6. 目标有不同快照时默认拒绝。只有指定单一账户及当前目标源哈希才能替换影子副本；有业务数据但缺失快照证据时拒绝覆盖。
7. 所有租户表均启用并强制 RLS；每个事务使用 `SET LOCAL` 等价的 `set_config(..., true)` 绑定账户。导入角色禁止 superuser、BYPASSRLS、表 owner 或继承 owner 权限。
8. 完整批次对源文件的相对路径/原始字节及内容计算两个哈希。导入前和提交前重新检查文件与附件，发现漂移即回滚；实际操作仍要求冻结写入，不能用前后哈希代替停写。
9. 完整批次重复执行会验证认证、文档集合、所有映射行和附件清单。替换必须提供当前批次源哈希，且不得改变账户集合；没有迁移证据的认证或独立文档不得覆盖。
10. 数据库进入运行态后，认证 `runtime_state` 和账户 `runtime_started_at` 拦截完整/单账户旧 JSON 导入，即使提供旧哈希也拒绝覆盖。运行数据目录写入 `.persistence-mode.json`；切回 JSON 必须在全新目录恢复、核验新增数据，不能直接复用旧 JSON。

原始字节快照仍须由外部备份保全，JSONB 导出不会复现原文件的空格、键排列等格式。迁移日志不输出正文或数据库连接串。

## 命令与角色

### 生产前置条件

**当前状态（2026-09-30 生产备份演练后）**：PostgreSQL 16.15 集群
`16/fornowtrial` 仅监听本机，40 连接/512 MiB 上限，仍为手动启动。
正式数据库 `for_now` 已建表，19 张表均为空；独立角色已验证。最新完成的
OSS 备份已在两套隔离库完成无损导入、导出、恢复和候选 HTTP 验证，演练库
与私有副本均已清理。生产应用继续 JSON 单写，尚未接线或切换。
配置与证据见 [`operations-capacity.md`](operations-capacity.md) 和
[`production-postgres-recovery-2026-09-30.json`](../reports/production-postgres-recovery-2026-09-30.json)。

正式角色如下，均为 `NOSUPERUSER / NOBYPASSRLS / NOCREATEDB / NOCREATEROLE`：

| 角色 | 权限 |
| --- | --- |
| `for_now_owner` | NOLOGIN，数据库、两个 schema、表和受控开户函数的 owner |
| `for_now_schema` | 独立登录，NOINHERIT；显式 `SET ROLE for_now_owner` 后管理 schema |
| `for_now_migration` | 两个 schema 的 USAGE 和表 SELECT/INSERT/UPDATE/DELETE；非 owner |
| `for_now_data` | 仅 `for_now` 的 USAGE 和表读写；8 连接上限 |
| `for_now_auth` | 仅 `for_now_auth` 的 USAGE、表读写及开户函数 EXECUTE；8 连接上限 |
| `for_now_backup` | 两个 schema 的 USAGE 和表 SELECT；没有写权限 |

五个登录角色使用独立随机密码，只在 ECS
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

无论采用哪种承载方式，都必须准备同一 PostgreSQL 16 数据库中的独立 schema
管理、迁移、运行数据、运行认证和只读恢复身份；运行身份必须满足非 owner、
`NOSUPERUSER`、`NOBYPASSRLS`，并只获得下述最小权限。连接串仅写入权限
`0600` 的生产环境文件，不进入 Git、报告或命令输出。完成网络/TLS、备份、
监控和恢复责任确认后，才进入最新 JSON/OSS 冻结与迁移窗口。

只读校验：

```bash
npm run migrate:postgres -- --dry-run --data-dir /path/to/isolated-copy
```

建表与数据导入分开执行，凭据通过受控环境注入：

```bash
# PG_SCHEMA_DATABASE_URL：仅用于建表的管理连接
npm run migrate:postgres -- --init-schema

# DATABASE_URL：已授权的非 owner 迁移角色
npm run migrate:postgres -- --data-dir /path/to/isolated-copy
```

建表后由数据库管理者创建独立登录角色。完整迁移角色需要 `for_now`、`for_now_auth` 两个 schema 的 USAGE 及其表的 SELECT/INSERT/UPDATE/DELETE；不授予表所有权或 schema CREATE。运行阶段拆成只访问 `for_now` 的数据角色和只访问 `for_now_auth` 的认证角色。新增表后重新核对授权。

更新已存在的完整影子批次：

```bash
npm run migrate:postgres -- --data-dir /path/to/isolated-copy --expected-target-sha256 PREVIOUS_BUNDLE_SOURCE_SHA256
```

该参数只控制影子导入覆盖，不代表获准覆盖生产数据库。正式写入切换仍遵循发布流程。

`ATTACHMENT_STORAGE=oss` 必须同时显式传入 `--allow-remote-attachments`；默认不得访问真实供应商。原来的单账户业务 store 检查可用 `--store-only --account-id ACCOUNT`，该模式不包含独立文件与附件实物，不构成 S1 全量证据。

## PostgreSQL 运行与恢复

`PERSISTENCE_BACKEND=json|postgres` 默认 `json`。PostgreSQL 模式需要 `DATABASE_URL`（数据角色）及 `AUTH_DATABASE_URL`（认证角色）。两者必须同库、不同角色、非 owner / NOSUPERUSER / NOBYPASSRLS，且互相没有对方 schema 的 USAGE。运行模式拒绝 `LOCAL_TEST_MODE` 与上游代理，禁止经 JSON 文件读写业务、认证或配置；日志与附件二进制仍可使用本地文件。

由建表管理员授予数据角色 `for_now` 的 USAGE 和运行表 SELECT/INSERT/UPDATE/DELETE。认证角色仅获 `for_now_auth` 的 USAGE 和认证表读写，并单独授予 `EXECUTE ON FUNCTION for_now_auth.provision_account(text,jsonb,jsonb)`。该 SECURITY DEFINER 函数固定 search_path、默认拒绝 PUBLIC，只能为已经插入身份表的新账户初始化映射，不能读取或替换既有账户。注册的身份、会话、业务初值和独立文档在同一认证事务提交；失败整体回滚。

运行语义：

- `postgres-runtime.mjs` 提供 `read/update/transact`，使用正式关系行重建业务对象，不读取或更新迁移快照。当前兼容适配器每次提交替换该账户的业务映射行；独立文档单独提交。领域级定向更新/数据库分页属于后续接口收口与性能工作，未宣称已实现。
- 所有账户写入使用数据库 advisory lock；锁跨显式 `commit()` 保留。每个 commit 是真实持久点，后续失败不回滚已完成的附件清理意图。账户 revision 以 compare-and-swap 拦截锁外冲突，读取使用 REPEATABLE READ 一致快照，事务内 `SET LOCAL` 绑定 RLS。
- 配置读改写、用量追加均在账户锁内完成；归一化保留迁移扩展，若会丢弃数组记录则拒绝。数据角色不能读取认证 schema，认证角色不能直接读租户内容。
- 上传先登记 `uploading` 与预期大小/哈希，再写二进制并验真为 `verified`；中断上传在启动时核对实物，保留有效文件或清除未写入的预留。业务不能引用其他账户或未验证的附件。永久清理在首个 commit 持久化任务，再删除文件并提交结果；失败可重试。
- 当前调度、供应商全局额度和流式去重仍按单进程设计；每个数据库只允许一个应用实例，第二实例启动失败。应用锁连接丢失时退出，避免失去排他性继续写入。跨连接 repository 并发已验证，不等于支持多实例调度。
- `/readyz` 检查数据库和应用锁连接；数据库不可用时返回 503。已有 JSON 数据但无完整迁移证据时拒绝启动，缺失迁移账户不会初始化成空库。

停应用后，用独立非 owner/NOBYPASSRLS 恢复角色（两个 schema 的 USAGE 与 SELECT，不授予写权限）导出：

```bash
# PG_BACKUP_DATABASE_URL 由环境注入，不在命令或日志中打印。
npm run export:postgres -- --data-dir /path/to/data --output-dir /path/to/new-export
```

OSS 模式还需显式 `--allow-remote-attachments`。导出取得应用排他锁；运行中拒绝导出。REPEATABLE READ 读取身份、每账户关系行、文档与附件清单，逐文件核对 SHA-256/大小，全部通过后原子发布新目录；失败清除临时输出。新目录包含兼容 JSON 恢复文档、附件和 `export-manifest.json`，不包含旧写源标记，也不依赖迁移快照；输出不是线上第二写源。

恢复时在**全新数据库**初始化 schema/角色，再对新导出目录执行完整导入，切换隔离应用验证。禁止清空运行标记后重导旧快照。`deploy/backup-to-oss.sh` 已增加停写导出分支，PG 模式要求 `PG_BACKUP_DATABASE_URL`；云端备份作业和真实 OSS 尚需发布阶段演练。现有 `restore-drill.sh` 只证明导出的 JSON 兼容读取，显式清空数据库连接；新数据库恢复由 PostgreSQL 专项另验。

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
[`v0.2.1-production-cutover-2026-09-30.json`](../reports/v0.2.1-production-cutover-2026-09-30.json)。
