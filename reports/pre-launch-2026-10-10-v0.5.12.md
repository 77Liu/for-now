# V0.5.12 发布门禁记录

状态：P00、日压缩/七天趋势与前端全门通过；PostgreSQL 16.14 四项检查及后端完整门在实现/测试 tree `2466bfa0ebabf7de40844efad8a7665529c00e99` 通过。后续 nullable API 契约专项回归通过，当前代码独立 review 为 GO。Preview、生产备份/恢复、schema initializer 和发布决定仍待执行。生产压缩扫描当前未启用。

唯一发行说明正文为 [release-v0.5.12-2026-10-10.md](release-v0.5.12-2026-10-10.md)。

## 发布对象

- 产品线：Web/PWA。
- 基线：V0.5.11 发布后提交 `fb72e71451bfb76d98914e006f39d71704f3bf06`，生产回滚候选 `v0.5.11` / `5c839e432012090011043e5c16ab823724add2af`。
- 冻结代码候选：`229df17bb876464f60d5c28f10258582aa857c90`，tree `f6fdcca0e66f2c06904565cc7953e671b421ae00`；该 SHA 是已完成独立 review 的运行时代码对象。候选说明文档另行提交，不改变此代码对象。Preview SHA 与最终生产 `main` 部署 SHA 尚未产生，须按各自 release fence 精确记录。
- 版本元数据已由唯一版本生成器设为 `0.5.12`；PWA 与 iOS 元数据一致，构建号递增到 9。本版不构建或分发 iOS 原生制品。
- 范围：持久日压缩、七天趋势及其回答上下文、历史稳定表达补充、PostgreSQL 全站额度原子预留/结算、脱敏调度观测。

## 验证证据

- `node scripts/system-test.mjs record-compressions`：14 项全通过，新增用户可见的七日日摘要、授权来源、真实覆盖日期与缺失日期回归。
- `ai-budget-regression.mjs`、`ai-budget-runtime-regression.mjs`、PostgreSQL 双 runtime AI 预算回归通过，覆盖并发调用/费用上限、取消释放、结算、未知成本和旧版仅更新预算文档仍保留 sidecar 额度账。
- `postgres-record-compression-rollback-regression.mjs` 使用本地临时 PostgreSQL：新版本写入与读取、模拟旧版保留未知字段并修改其他记录、当前版本再次读写均通过。
- `record-compression-token-bound-regression.mjs`、`ai-provider-regression.mjs`、`runtime-infrastructure-regression.mjs`、`release-metadata-regression.mjs` 与 metadata `--check` 通过。
- `user-journey-regression.mjs smoke`：17/17 自动 journeys 通过；已有用户补答真实 headless Chrome 使用 loopback provider mock，精确核对五条许可 sourceId/原文、排除预置历史/profile，确认 claim 仅在用户操作后 active，并保留来源任务与原文 span。
- `user-journey-regression.mjs daily`：22 条中 21 条自动覆盖，日压缩/趋势与完整前端桌面、响应式、认证隔离均通过；唯一 partial 为 `local-online-snapshot`。日压缩 Journey 的聊天/复盘引用 UI、AI 摘要披露、七日覆盖和生产扫描默认关闭均有对应回归。
- 更广的 release-tier Journey 矩阵为 24 条中 21 条自动覆盖；`local-online-snapshot`、`private-media-distribution` 与 `responsive-visual-accessibility` 保持 partial。后两项属于 release-tier 矩阵，不属于 daily tier。
- 感知任务指纹刷新专项覆盖同事务新任务、版本变化、既有任务、非 queued 状态、事务提交、幂等重放和撤权后的 stale 结果。
- `node scripts/system-test.mjs frontend` 全门通过。后端全门在实现/测试 tree `2466bfa0ebabf7de40844efad8a7665529c00e99` 通过，包含隔离部署和 Preview 模拟；API nullable 改动后专项 API 契约与模块检查通过。当前候选的一次复验通过 API、恢复和 release fence，按影响范围未重复已通过且未受改动影响的部署回滚模拟。
- PostgreSQL 16.14 本地集成通过：`ai-budget-postgres-regression.mjs`、`postgres-integration.mjs`、`persistence-ledger-postgres-regression.mjs` 与 `postgres-record-compression-rollback-regression.mjs`。
- 最终独立 reviewer 对当前代码差异给出 GO；记录见迭代计划。测试 tree `2466bfa0ebabf7de40844efad8a7665529c00e99` 是 nullable API 契约变更前的完整后端实现/测试快照；当前差异后的 API 专项与模块回归已通过。审计还确认生产备份、恢复、initializer 和 runtime 角色预检是 G5 必须在目标环境补齐的门。
- 全程未调用真实 provider；没有生产数据扫描或生产写入。

## 迁移、备份与回滚

- PostgreSQL schema initializer 将幂等增加 `site_ai_budget.record_compression_quota`。部署必须先运行 initializer，再启动严格角色预检；不得跳过或以应用启动失败后再补迁移。
- `.511` 旧代码只更新既有预算 `document`，不会删除新 sidecar 配额账。业务记录 mapping 的旧版 round-trip 由独立 PostgreSQL fixture 验证。
- G5 前须制作并校验新鲜生产数据库与附件备份，并在隔离环境完成恢复演练；当前本版尚无这些新证据。
- 代码回滚目标是 `.511` tag。若 `.512` 已写入压缩结果，回滚后旧版需保留未知 store entity；本版只增加预算账 sidecar，切回 `.511` 不清除该列。代码回滚不能替代数据恢复。

## 生产扫描配置

开启前需在服务器检查 DeepSeek API URL 与凭据的存在性/路由，不打印或复制密钥；核验 `RECORD_COMPRESSION_ENABLED=1`、`RECORD_COMPRESSION_DAILY_BUDGET_CNY=1`、`RECORD_COMPRESSION_PER_CALL_BUDGET_CNY=0.25`、`RECORD_COMPRESSION_DAILY_INVOCATION_LIMIT=4`、`RECORD_COMPRESSION_MAX_BACKFILL_DATES_PER_SCAN=1`。应用另有不可通过环境配置抬高的同等硬上限。确认扫描输出已连到脱敏日志与预算等待指标后再启用；预算超出或成本未知时不得放宽界限。

## G4-G7 记录

- G4 独立 review：代码 GO；冻结代码 SHA/tree 见上。文档交付提交与后续 Preview/生产部署 SHA 分别记录，避免混用。
- G5 Preview/生产发布决定、迁移预检、备份及恢复：待执行。
- G6 服务 readiness、候选 SHA、预算事件与限定观察窗口：待执行。
- G7 复盘回流：待 G6。
