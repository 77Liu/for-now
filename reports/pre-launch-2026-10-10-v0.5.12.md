# V0.5.12 发布门禁记录

状态：G1-G7 已完成。P00、日压缩/七天趋势与前端全门通过；PostgreSQL 16.14 四项检查及后端完整门在实现/测试 tree `2466bfa0ebabf7de40844efad8a7665529c00e99` 通过。后续 nullable API 契约专项回归通过，代码独立 review 为 GO。Preview、生产备份/恢复、schema initializer、Gitee Release 与生产部署均已完成；生产压缩扫描已按硬限额启用，限定观察通过。

唯一发行说明正文为 [release-v0.5.12-2026-10-10.md](release-v0.5.12-2026-10-10.md)。

## 发布对象

- 产品线：Web/PWA。
- 基线：V0.5.11 发布后提交 `fb72e71451bfb76d98914e006f39d71704f3bf06`，生产回滚候选 `v0.5.11` / `5c839e432012090011043e5c16ab823724add2af`。
- 冻结代码候选：`229df17bb876464f60d5c28f10258582aa857c90`，tree `f6fdcca0e66f2c06904565cc7953e671b421ae00`；该 SHA 是已完成独立 review 的运行时代码对象。最终发布提交 `4359648b41608429832e2ce4897bd12163a5d812`，tree `3acb46da5e8cb609f41adcb1c866434736208380`，仅含发布文档收口；运行时代码与冻结代码候选一致。Gitee main、Preview、tag 和生产活动版本均核验为该发布 SHA。
- 版本元数据已由唯一版本生成器设为 `0.5.12`；PWA 与 iOS 元数据一致，构建号递增到 9。本版不构建或分发 iOS 原生制品。
- 范围：持久日压缩、七天趋势及其回答上下文、历史稳定表达补充、PostgreSQL 全站额度原子预留/结算、脱敏调度观测。

## 验证证据

- `node scripts/system-test.mjs record-compressions`：14 项全通过，新增用户可见的七日日摘要、授权来源、真实覆盖日期与缺失日期回归。
- `ai-budget-regression.mjs`、`ai-budget-runtime-regression.mjs`、PostgreSQL 双 runtime AI 预算回归通过，覆盖并发调用/费用上限、取消释放、结算、未知成本和旧版仅更新预算文档仍保留 sidecar 额度账。
- `postgres-record-compression-rollback-regression.mjs` 使用本地临时 PostgreSQL：新版本写入与读取、模拟旧版保留未知字段并修改其他记录、当前版本再次读写均通过。
- `record-compression-token-bound-regression.mjs`、`ai-provider-regression.mjs`、`runtime-infrastructure-regression.mjs`、`release-metadata-regression.mjs` 与 metadata `--check` 通过。
- `user-journey-regression.mjs smoke`：17/17 自动 journeys 通过；已有用户补答真实 headless Chrome 使用 loopback provider mock，精确核对五条许可 sourceId/原文、排除预置历史/profile，确认 claim 仅在用户操作后 active，并保留来源任务与原文 span。
- `user-journey-regression.mjs daily`：22 条中 21 条自动覆盖，日压缩/趋势与完整前端桌面、响应式、认证隔离均通过；唯一 partial 为 `local-online-snapshot`。日压缩 Journey 的聊天/复盘引用 UI、AI 摘要披露、七日覆盖和测试默认配置关闭扫描均有对应回归。
- 更广的 release-tier Journey 矩阵为 24 条中 21 条自动覆盖；`local-online-snapshot`、`private-media-distribution` 与 `responsive-visual-accessibility` 保持 partial。后两项属于 release-tier 矩阵，不属于 daily tier。
- 感知任务指纹刷新专项覆盖同事务新任务、版本变化、既有任务、非 queued 状态、事务提交、幂等重放和撤权后的 stale 结果。
- `node scripts/system-test.mjs frontend` 全门通过。后端全门在实现/测试 tree `2466bfa0ebabf7de40844efad8a7665529c00e99` 通过，包含隔离部署和 Preview 模拟；API nullable 改动后专项 API 契约与模块检查通过。当前候选的一次复验通过 API、恢复和 release fence，按影响范围未重复已通过且未受改动影响的部署回滚模拟。
- PostgreSQL 16.14 本地集成通过：`ai-budget-postgres-regression.mjs`、`postgres-integration.mjs`、`persistence-ledger-postgres-regression.mjs` 与 `postgres-record-compression-rollback-regression.mjs`。
- 最终独立 reviewer 对运行时代码差异给出 GO；记录见迭代计划。测试 tree `2466bfa0ebabf7de40844efad8a7665529c00e99` 是 nullable API 契约变更前的完整后端实现/测试快照；当前差异后的 API 专项与模块回归已通过。生产备份、恢复、initializer 和 runtime 角色预检均已完成。
- 生产 PostgreSQL 16.15 initializer 幂等执行，data/auth/budget runtime 角色预检通过。生产前备份与 SHA-256 校验通过；JSON/附件投影恢复演练通过（4 用户、481 条投影记录、109 个附件引用、115 个本地附件、264 条公开 API 投影记录），另以生产归档在隔离 PostgreSQL 16.15 恢复 4 个账户、306 条业务数据库记录，预算 sidecar 与单例检查通过，临时库及角色已清理。这两组数字来自不同恢复路径和数据投影口径。
- 生产 owner 设置的 DeepSeek 凭据仅用于两次合成夹具请求，第二次 HTTP 200 且返回内容；未发送生产用户正文，密钥未打印、持久化或纳入证据。生产压缩扫描已按 `RECORD_COMPRESSION_ENABLED=1`、每日 ¥1、每次 ¥0.25、每日 4 次、每轮回填 1 天启用。
- G6 生产观察于 2026-10-10 14:01:02 至 14:31:13（Asia/Shanghai）完成，持续 30 分 11 秒，31/31 个一分钟样本齐全。每个样本均核对候选/ready SHA、systemd active、服务 PID/重启数、公网 `/now/` 状态及脱敏压缩账本；SHA 均为 `4359648b41608429832e2ce4897bd12163a5d812`，PID 始终为 `870806`，重启为 0、服务 active、公网 200，无 readiness 或入口失败。观察窗口压缩调用 0 次、成本 ¥0、等待 0。验收矩阵中的 `local-online-snapshot`、`private-media-distribution` 与 `responsive-visual-accessibility` 仍为 partial。

## 迁移、备份与回滚

- PostgreSQL schema initializer 将幂等增加 `site_ai_budget.record_compression_quota`。部署必须先运行 initializer，再启动严格角色预检；不得跳过或以应用启动失败后再补迁移。
- `.511` 旧代码只更新既有预算 `document`，不会删除新 sidecar 配额账。业务记录 mapping 的旧版 round-trip 由独立 PostgreSQL fixture 验证。
- G5 已制作并校验新鲜生产数据库与附件备份，并完成 JSON/附件投影和隔离 PostgreSQL 两种恢复演练；对象数口径分别记录在上文。
- 代码回滚目标是 `.511` tag。若 `.512` 已写入压缩结果，回滚后旧版需保留未知 store entity；本版只增加预算账 sidecar，切回 `.511` 不清除该列。代码回滚不能替代数据恢复。

## 生产扫描配置

生产配置已核验 DeepSeek API URL、凭据存在性和模型路由（不记录密钥）。当前生效值为 `RECORD_COMPRESSION_ENABLED=1`、`RECORD_COMPRESSION_DAILY_BUDGET_CNY=1`、`RECORD_COMPRESSION_PER_CALL_BUDGET_CNY=0.25`、`RECORD_COMPRESSION_DAILY_INVOCATION_LIMIT=4`、`RECORD_COMPRESSION_MAX_BACKFILL_DATES_PER_SCAN=1`；应用另有不可由环境配置抬高的同等硬上限。扫描输出接入脱敏日志和预算等待指标；预算超出或成本未知时维持有界等待或 fail-stop。

## G4-G7 记录

- G4 独立 review：代码 GO；冻结代码 SHA/tree 见上。文档交付提交与后续 Preview/生产部署 SHA 分别记录，避免混用。
- G5 已完成：Preview fence `b03aa86835c673e2236fdfa5ecdfcb5f`；production fence `2ccf758e956c55bcdfadbd8823dc6cd3`；Gitee Release 为 [v0.5.12](https://gitee.com/Liu_772021/for-now/releases/tag/v0.5.12)。
- G6 观察完成：31 个连续一分钟样本，30 分 11 秒，全部为候选 SHA、服务 active、重启 0、公网 200；压缩调用和成本均为 0。
- G7 完成：发布与观察闭环；保留三个 release-tier partial（daily tier 的 `local-online-snapshot` 同时仍为 partial），不把未执行人工/私有分发验收记作通过。
