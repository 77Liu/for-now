# v0.5.16 独立复审返修（第二轮）

日期：2026-10-20。独立复审对象 `6dace45ac660c64f905f2b80c9c15a112755c8e0`，tree `92b96c8970a8fd7b0c791abc04c6fc52c81d9d68`；本轮返修候选 `106fc4168eb4ab06411644b03a2c4fd5027b3e74`，tree `e363448ecd0a6acbc5f0665235dd418ad9e8b6e6`，分支 `feat/v0.5.16-sync-latency`。规则基线 `9c4916`。

## 结论

Owner/独立复审对 `6dace45a` 给出「不通过」：原 12 项中 8 项可关闭，R1、R6、R9、R11 仍是部分修复，并复现 F1–F5 五个缺陷；另指出关键回调仍大量 `any`，消费者漏处理事件不会在类型检查期失败。本轮按拍板逐项修正，并把三处关键交接补完整：**摘要与详情、旧记录与完整身份、持久账目与内存额度**。

本报告是开发侧返修与验证结论，**不替代独立复审**，也不改写 Owner 已给出的原失败结论。上一份回执 [`2026-10-20-v0516-independent-remediation.md`](2026-10-20-v0516-independent-remediation.md) 对 R1/R6/R9/R11 的 `PASS` 自评已被本次复审推翻，其对应行以本报告为准；历史结论保留，不改写为通过。

控制面保持「返修待独立复审」，**不恢复 `READY_WAIT_OWNER`**，也不授予 push、tag、Release、Preview 或生产部署权限。

## 逐项结果

| 编号 | 原项 | 复审缺陷 | 修正 | 直接证据 |
| --- | --- | --- | --- | --- |
| F1 | R1 | 列表接入摘要后，正文增量仍把**完整详情**写进列表缓存，同水位恢复列表再次报 `SYNC_ENTITY_VERSION_CONFLICT` | 列表范围只接受摘要契约：详情型增量不再合并进 `thoughtPage`，改为置失效后按现有有界 rebase 恢复；恢复合并不再继承已失效范围的缓存，避免同游标伪冲突；`applyEntry` 的同版本真实冲突校验保留 | [`record-sync.mts`](../public/frontend/state/record-sync.mts#L234) 合并边界与 [增量分支](../public/frontend/state/record-sync.mts#L318)；回归「详情型增量→列表失效→同水位安全恢复→同版本内容不一致仍抛真冲突」 |
| F2 | R11 | 唯一性判断只看已选父项；书籍与思绪同 ID、只选书籍时，旧思绪批注缺 `parentCollection` 被推断为书籍子项，一起被逻辑永久清理 | 归属唯一性核对改为覆盖**全部可见条目的候选父身份**，候选集随扩展增长；同 ID 多类型（歧义）返回空身份，**不自动扩展** | [`trash/index.mjs`](../src/modules/trash/index.mjs#L31) 唯一性核对与 [expanded](../src/modules/trash/index.mjs#L62)；回归「同 ID 歧义不串选」+「单一候选身份旧记录仍正常扩展」 |
| F3 | R9 | 两个旧读数在途 → 已完成调用入账 → 中间请求释放后清掉内存状态 → 旧读数按零重建状态，上限 2 却允许「已完成 1＋活动 2」 | 取消「无活动即删状态」的危险清理，改为只清理同账户其它日期且无活动的桶；新增账户/日期串行边界，把**准入读取、预留与结算交接**放进同一临界区，旧读数不再能基于过期快照同时放行 | [`usage.mjs`](../src/modules/ai/usage.mjs#L387) `reserveAttempt`；回归「旧读数在途的三并发只放行 1 个」 |
| F4 | R9 | A 已写账、内存预留未提交 → B 读到新账目记入 observed → A commit 又计入 committed，同一调用占两份额度，上限 2、实际完成 1、活动 0 仍被拒 | 写账发起（`retain`）即把该调用从在途转为本账户/日期已记录，`settled` 置位使后续 `commit`/`release` 幂等空转；准入计数取 `max(持久读数, 已记录)`，一次调用只占一份额度 | [`usage.mjs`](../src/modules/ai/usage.mjs#L409) 结算交接；回归覆盖真实「先写账、后 commit」窗口 |
| F5 | R6 | 正在查看 A → B 改正文 → 返回 `filter` → 状态层确认 A 未失效（`staleScopeKeys=[]`），循环仍无条件 rebase，扩大读取范围 | 删除无条件 `serverRequiresRebase`（不再按 `refetch`/`operation` 猜测），恢复只依据状态层实际失效范围 `staleScopeKeys`；`filter` 失效范围仍由状态层按实际受影响筛选 scope 计算 | [`incremental-sync.mts`](../public/frontend/shared/incremental-sync.mts#L543)；回归「修改 B 不重读 A」：只恢复一次且游标推进 |
| Q1 | 类型契约 | 关键回调大量 `any`；独立副本删除 `record-error` 分支后类型检查仍通过 | `data-sync-runtime.mts` 282 → 422 行，关键回调改为具名结构类型（同步指标、scope、批次、rebase、控制器等）；状态事件消费改穷尽 `switch` + `assertNever`，漏处理分支在 `typecheck:frontend` 期失败 | 实测删除 `case "record-error"` 报 `TS2345 ... not assignable to parameter of type 'never'`，随后恢复该分支；`tsc --noEmit -p tsconfig.frontend-runtime.json` 通过 |

## 三处关键交接

1. **摘要与详情**：列表范围只接受摘要契约，详情型增量只使其失效；失效范围不继承旧缓存，同水位恢复正常且不产生伪冲突。同版本真实内容不一致仍报 `SYNC_ENTITY_VERSION_CONFLICT`。
2. **旧记录与完整身份**：回收展开的唯一性核对从「已选父身份」扩展为「全部候选父身份」，歧义不扩展；有明确唯一候选时旧记录仍按既有机制展开。
3. **持久账目与内存额度**：准入、预留与结算交接进入同一账户/日期串行边界；在途读取不再被状态清理丢弃；写账发起即结算交接，取消多份计数叠加，越限与误拦不再同时出现。

## 验证

绑定候选 `106fc41` / tree `e363448`。

- `npm test --silent`（主回归全量）：PASS。
- `npm run check --silent`：PASS；213 个文档链接、134 个活动模块、243 条归属路由、1154 个维护文本文件与 5 个地图文档。
- 受影响专项全 PASS：`test:record-sync`（含 `record-sync-v2-regression`、`sync-coordinator-regression`）、`trash-regression`、`ai-domain-regression`、`test:pwa`、`test:frontend-shared`、`test:frontend-application`、`test:frontend-ports`、`test:page-router`、`test:ai-budget`、`test:entrypoints`。
- `npm run test:frontend`（`system-test.mjs frontend`，真实 Chrome 旅程直接跑在本候选上）：PASS；40 项、0 失败、`101709ms`，含桌面/响应式 UI `74272ms`、移动平台仿真 `8276ms`、URL/历史契约与 PWA 壳层闭包（93 个缓存模块）。
- 发布保护与工程门全 PASS：`test:release-fence`、`test:commit-gate`、`test:release-state-startup-gate`（自检）、`test:control-plane`（控制面入口自检）、`test:boundaries`。
- 保留失败（同候选、同命令，不掩盖）：第 2 次在 `postgres-runtime-checks.mjs:1741` 失败（F9 长轮询未在 `waitMs=1500` 内推进游标），第 3 次在 `thought-paging-build-regression` 的 `assertStartupRejects` 失败（子进程退出码 `null !== 0`）。两次均发生在主机 load average 12–19、可用内存不足 100MB 期间，失败点分别在同步唤醒长轮询与子进程启动检查，与本次改动的四个文件无关；同一份代码在负载正常的第 1 次与第 4 次通过相同断言。重跑理由为「观察抖动需要确认」，不以重跑次数把失败改记为通过。

## 未重建的门（明确缺口）

- **候选级四账户有状态门未在新候选重建。** `release-state-startup-gate verify` 要求脱敏快照记录的候选 SHA/tree 与当前候选一致；现有快照 `artifacts/local/v0516-startup-snapshot-6dace45.json`（sha256 `f8e57ba2…`）绑定 `6dace45/92b96c`，对本候选直接拒绝（`Snapshot and local runtime candidate SHA/tree do not match`）。按证据有效性规则，上次的 default/`v0516-combined` 结论随业务代码变化失效，需以新候选重新采集脱敏快照（需生产只读源 URL）后重跑，本轮未执行、本轮也未访问生产环境。

## 保留边界

Safari、安装态 PWA、移动真机、生产负载与生产放量未验；浏览器 500ms P75 缺口继续保留，不由 PG P75 代替。AI 调用额度相关修复只在本地隔离 PostgreSQL 与替身端口上验证，未做真实付费 provider 调用；94 条真实语料未重建、未重跑。`AI_AUDIT_DB_ENABLED`、`SYNC_ACCOUNT_WAKE_ENABLED`、`AI_QUEUE_ENABLED` 等开关默认仍为关闭。

## 外部动作

本轮未 push、未 tag、未创建 Release、未做 Preview 或生产部署，未执行生产业务写入，未访问生产环境，未调用真实付费 provider。控制面更新只经 `npm run coordination:update -- apply --input` 唯一入口。
