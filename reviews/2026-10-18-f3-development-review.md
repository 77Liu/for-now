# 当前开发审查：F3 记录级持久化

审查时间：2026-10-18 13:09（UTC+8）。**当前为实现中，未达到阶段出口；不能将已有测试通过记录外推到本次未提交实现。**

## 审查对象与开发进展

- 分支：`feat/v0.5.16-sync-latency`，HEAD 仍为 `b1a62ae81fdd729969052ee5bfc72fe6d0765172`，没有新增提交。
- 控制面：revision 439，v0.5.16 阶段 5/11，F3 `IN_PROGRESS`；blockers 仍为空，尚未纳入上轮及本次审查发现。
- 实际代码：新增 `AccountUnitOfWork`、独立同步 head/changes 表、条件行写、幂等回执；接入通知已读/全部已读、任务取消、思绪编辑/删除/创建和 AI 写回。`RECORD_COMMAND_ALLOWLIST` 默认空。
- 已看到的新增验证：UoW、通知与思绪真实 PG 用例、producer coverage 声明；三类实体仍 `f9Ready=false`，不能宣称完整记录级同步已就绪。
- 本轮审查期间，主开发继续补充内容块删除，随后新增自动回答任务创建及延迟输入绑定。最后这些自动回答变化只作差分核对，尚未取得成功的组合运行证据。
- 既有 F9/UI/知识文档差分继续存在；本次未把它们误判为 F3 新增范围，也未修改任何业务源码或控制面。

验证在临时复制的工作区快照中执行。第一次快照约 13:03；第二次纳入约 13:06 的内容块删除变更。下述四个 PG 探针在两版均复现；最后核对时，其相关删除、生命周期、排序和任务取消逻辑未被自动回答新增代码修复。由于主开发持续修改，不宣称对之后的整个工作区拥有固定候选验收结论。

## 已复现的新增问题

### F3-01 / P1：删除旧记录成功后，剩余思绪无法重建

位置：[store-mapping.mjs](../src/shared/persistence/store-mapping.mjs) 的 `ordered`（审查时 447–455 行）；[thought-graph.mjs](../src/shared/persistence/thought-record-repository.mts) 的 `removeRows`（73–83 行）；[schema](../src/shared/persistence/postgres-schema.sql) 的 `record-commands-v1`。

新 schema 允许 position 为空，但未转换旧行；新删除也不改变剩余旧 position。重建逻辑只要发现剩余行的 position 都是整数，仍要求它们从 0 连续。

**真实 PG 复现：**存入两条旧结构思绪，position 分别为 0、1；通过真实思绪命令删除第一条，事务成功提交。第二条仍为 position 1，使用真实持久化重建器读取时报 `Non-contiguous positions: thoughts`。

影响：一次合法删除可能让之后的整账户读取/保存无法继续，需修复数据库映射才能恢复。现有新增测试删除了全部旧思绪后再创建，没有覆盖“删除其中一条，保留另一条旧记录”。

建议：真正完成旧排序约束退场，统一支持新旧混合数据；不要为修复而重新编号全账户。补首项、中项、末项删除及旧新行混合读取/重启回归。

### F3-02 / P1：生命周期匹配遗漏父对象，会改坏另一思绪的批注状态

位置：[thought-graph.mjs](../src/shared/persistence/thought-record-repository.mts) 的 `markThoughtLifecycleDeleted`（257–294 行）；[account-unit-of-work.mts](../src/shared/persistence/account-unit-of-work.mts) 的 `findByResourceIds`（453–468 行）。

查询只限定账户与 resourceId，随后只比较 resourceType+resourceId，没有用包含父对象的完整 resourceKey。

**真实 PG 复现：**思绪 A、B 各有 ID 相同的批注；删除 A 后，A、B 的批注生命周期都被标成 deleted，并被写入 A 的 trashId。B 的批注实体仍然存在，形成实体与生命周期矛盾。

这是同账户内不同父记录的误写，不是跨账户越权。项目契约明确要求完整父对象身份。

建议：按目标闭包中的完整 resourceKey 查询及更新，不以全局唯一子 ID 为前提；补不同父对象同 ID 的删除/恢复测试。

### F3-03 / P2：取消单个任务仍读取并锁定整个通知集合

位置：[tasks.mjs](../src/modules/tasks/record-commands.mts) 的 `cancel`（59–60 行）；[account-unit-of-work.mts](../src/shared/persistence/account-unit-of-work.mts) 的 `findByCollection`（257–266 行）。思绪 AI 写回的 `readTaskClosure` 也使用相同全通知读取。

**真实 PG 复现：**一个目标任务、60 条通知，其中 59 条无关；取消一次读取 61 条对象，只更新 2 条。查询没有分页或目标 taskId 条件，并使用 `FOR UPDATE`。

影响：单任务命令成本随无关通知历史增长，不符合本次 F3 的精准业务闭包要求。现有 SQL 断言仅排除 store_fields/整账户清写，不能证明没有整集合读取。

建议：通过已有 notification→task 关系或按 taskId 的有界领域查询取得目标通知；回归断言与无关数据规模无关的读取量。

### F3-04 / P1（F9 接入前必须关闭）：删除的 ChangeSet 漏掉连带任务和通知

位置：[thoughts.mjs](../src/app/record-commands/thoughts.mjs) 的 `remove`；[thought-graph.mjs](../src/shared/persistence/thought-record-repository.mts) 的 `persistMappedClosure`。

删除会复用领域逻辑取消任务、更新通知并建立回收记录，实际映射也持久化这些变化，但显式 ChangeSet 只追加思绪根删除。

**真实 PG 复现：**删除一个带 queued 任务和通知的思绪后，两者数据库状态均为 cancelled；`record_changes` 只有一条 thoughtChain/delete，没有 task/notification 变化。

当前 F9 仍关闭，因此本次没有声称已经发生线上漏同步。但这是供 F9 使用的生产者数据不完整，不能把 `chain delete=record` 等标记当作所有变化完整的证明。UoW 仅校验“有写就有至少一条 change”，无法验证实际实体覆盖。

建议：各领域命令明确返回本次所有同步实体变化，应用层统一提交；测试核对实际变更身份与 ChangeSet，而不只核对根节点。

## 当前测试状态

|检查|实际结果及边界|
|---|---|
|`npm run build:runtime --silent`|两次捕获快照均完成构建；不代表最后新增的自动回答路径已验收|
|`record-command-producer-coverage-regression.mjs`|初次快照 PASS；它主要验证静态声明及源码模式，不是行为完整性证明|
|`runtime-infrastructure-regression.mjs`|初次快照 PASS|
|`git diff --check`|PASS|
|`node scripts/check-modules.mjs`|FAIL：`scripts/postgres-runtime-checks.mjs` 深层导入 `src/app/record-commands/notifications.mjs`，绕过 app 公开入口|
|首次 `test:postgres:stable`|FAIL：`captures.length` 实际 13、预期 12，位于当时 `postgres-runtime-checks.mjs:1001`|
|更新内容块删除后的 `test:postgres:stable`|FAIL：`pruned.value.version` 实际 4、预期 3，位于该快照 `postgres-runtime-checks.mjs:658`|
|独立真实 PG 探针|上述 F3-01 至 F3-04 均复现；使用隔离 PostgreSQL 16.14 和合成数据|

首次 PG 失败的原因可直接追溯：新增思绪测试向共享账户插入一条来源 capture 后没有清理，后续 12 次新增仍按空集合断言。第二次失败出现在内容块删除版本契约，需统一命令返回、持久版本与测试预期；不能直接将其改记为通过。两次失败意味着之后的 PG 测试链未全部执行。

工程差距：4 个新增 record-commands 文件及 coverage 脚本仍是 `.mjs`，未遵循新增源码使用 TypeScript 的现行规则；业务命令与生命周期判断主要放在 app 中，通过通用对象端口读写，尚未完整落成方案要求的领域 typed command/repository。类型构建成功不代表这些新增 JS 已受类型校验。

## 上轮问题与待完成部分

上轮的会话撤销竞态、用量恢复载荷丢失、并发改密死锁和统计时区错位，相关认证/审计/用量实现文件与 `b1a62ae` 完全一致，**4 项均未关闭**。详见[此前提交审查](2026-10-18-f7bd64-b1a62a-review.md)。

AI 写回生产调用链在 `stableTaskWriteback` 中仍调用 `repository.read()` 读取账户内容，再用账户 revision 守卫；目前只能证明写回事务是局部写，不能宣称整个写回路径消除了全账户读取。自动回答、内容块删除及附件编辑正在补齐，仍需要真实入口的失败恢复和旧数据组合验证。

建议先修两项直接破坏数据一致性的 F3-01/F3-02，修复测试门，并关闭 F3-03/F3-04；同步将上轮缺陷纳入主控追踪。完成后以固定候选重验，确认无回归，再判定阶段出口。当前没有需要 Owner 新裁定的产品选项，属于实现和验证问题。
