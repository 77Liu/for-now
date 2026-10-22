# v0.5.16 01:00 后独立复审 6 项返修回执

日期：2026-10-21
实现提交：`5f85f4fed3227a5e7efe2ce371155324f8b3a433`（tree `a6f7536417f0ad71c056486797c176abc156feba`）
分支：`feat/v0.5.16-sync-latency`
审查来源：独立审查者提供的 `outputs/2026-10-21-after-0100-independent-review.md`（未入库）

## 结论

A1–A4 已在代码与回归中修复，A5 判定根因在本仓库之外的中台服务，保持 `OPEN`，A6 已把门清单补齐为策略实际派生的 8 项。所有状态均为待独立复审/待执行回执，不声明 `READY_WAIT_OWNER`。

## 逐项处理

| ID | 修复原因与入口 | 代码位置 | 可区分修复前后的回归 |
| --- | --- | --- | --- |
| A1 / P1 | 旧回收站记录缺少 `parentCollection` 时，批注/漂移批注可能属于多个顶层集合。原逻辑在回收站中只有一个同 ID 父项时会把它当作唯一归属，选中同 ID 书籍即可把原属在线思绪的批注一起永久清理。现在多集合类型一律不自动推断，只接受完整身份；单集合类型（如 `bookNote`）仍保持既有扩展。受影响入口：`trash.expanded`（预览与永久清理）。 | [trash/index.mjs](../src/modules/trash/index.mjs#L43-L58) | [trash-regression.mjs](../scripts/trash-regression.mjs#L215-L245) 新增“回收站只有同 ID 书籍”的批注与漂移批注反例；修复前会展开两条，修复后只清理书籍。 |
| A2 / P2 | 列表范围只按成员/新增判定失效，页外子块改标签而进入筛选时不会失效。现在筛选页把 `tags`（标签筛选）和 `content/text`（检索筛选）视为成员资格字段，页外变化同样使范围失效并按有界筛选页恢复。受影响入口：`applyRecordBatch` 的 `thoughtPage` 分支。 | [record-sync.mts](../public/frontend/state/record-sync.mts#L174-L180)、[record-sync.mts](../public/frontend/state/record-sync.mts#L362-L377) | [record-sync-v2-regression.mts](../scripts/record-sync-v2-regression.mts#L612-L685) 覆盖进入筛选、退出筛选与未筛选列表三种情况；修复前“进入”返回空失效集。 |
| A3 / P2 | 恢复只检查页面“装载过”，旧查询投影可被新查询页复用。现在列表比较 `query/tag/sort/requestCursor/direction`，详情要求 `found===true`、根已装载且 `query` 一致；详情描述符也补充当前查询。不一致直接返回 `false`，走既有 rebase。受影响入口：`hydrateRecordScopes`。 | [data-sync-runtime.mts](../public/frontend/app/runtime/data-sync-runtime.mts#L321-L345) | [sync-coordinator-regression.mjs](../scripts/sync-coordinator-regression.mjs#L1694-L1758) 用真实运行时注入状态，覆盖旧 `q=old` 列表、旧详情查询被拒绝，以及身份一致时复用。 |
| A4 / P2 | 历史补充优先分支只预留队列位置，没有预留实际预算；预算仅剩 1 次时补充会取走唯一额度，失败日报修复重新落回预算等待。现在同时计算队列余量与预算余量，并为失败日报各预留 1 个名额后取较小值。受影响入口：记录压缩扫描的历史补充优先分支。 | [record-compressions.mjs](../src/app/record-compressions.mjs#L839-L853) | [record-compression-budget-wait-regression.mjs](../scripts/record-compression-budget-wait-regression.mjs#L313) 固定队列上限 4、预算余 1、失败日报与跨日补充并存；修复前补充入队、修复后日报修复入队且补充继续等待。 |
| A5 / P2 | 外层等待改为 15s 未触及超时发生处。中台 `fetchProductionData` 仍在 5s 取消聚合，`readyz` 据此返回 500；审查用中台源码组合复现到 5032ms 仍为 `TimeoutError`。中台源码不在本仓库，本轮无法完成根因修复；`M3` 保持 `OPEN`，需中台仓库改动与部署窗口，不能表述为当前线上故障。 | [monitor-health.mjs](../scripts/monitor-health.mjs#L41-L50) 仅外层；中台侧未改 | 不宣称修复。现有 monitor 专项只证明外层超时行为，不能覆盖中台 5s 取消。 |
| A6 / P2 | 候选只登记 6 项必需门，策略实际派生 8 项，漏 `control_plane_compatibility`、`proposal_checker_compatibility`。现在候选 `required_gates` 写回完整 8 项；两项新增门的命令已本地运行通过，但尚未在固定候选干净工作区用 `run-gate` 生成绑定回执，因此质量门登记为待回执状态，工具仍会阻止后续放行。 | [coordination/current.json](../coordination/current.json) | `npm run test:control-plane`、`npm run test:proposal-checker` 本地通过；`gate-plan` 输出 8 项。 |

## 验证

- `npm run build:runtime`：PASS
- `npm test`：PASS
- `npm run check`：PASS（215 文档、134 模块、243 路由、1161 维护文本）
- `npm run test:record-sync`：PASS（含新增 A2/A3 回归）
- `npm run test:monitor`：PASS
- `node scripts/trash-regression.mjs`：PASS（含新增 A1 回归）
- `node scripts/record-compression-budget-wait-regression.mjs`：PASS（含新增 A4 回归）
- `node scripts/ui-regression.mjs`：PASS（单独运行，避免与 PG/部署并发）
- `node scripts/deploy-regression.mjs`：PASS（30 场景；单独运行约 12 分钟，此前并发运行曾表现为长时间无输出）
- `npm run test:release-fence`：PASS
- `npm run test:control-plane`：PASS
- `npm run test:proposal-checker`：PASS
- `npm run test:postgres:stable`：PASS（PostgreSQL 16.14，单独运行）

## 未完成与限制

1. **A5 未修复**：根因在中台 `fetchProductionData` 的 5s 取消；本仓库只能放宽外层等待，需中台仓库修改并部署后复验。
2. **A6 正式回执未生成**：两项新增门尚未通过 `run-gate` 绑定到候选；质量门未登记为 `PASS`，放行仍被阻止。
3. **独立复审未执行**：以上为返修自评与本地证据，不能替代独立结论。
4. **有状态启动门未重建**：`v0516-rereview-stateful-gate-unrebuilt` 保持 `OPEN`。
5. 未 push/tag/Release/Preview/生产部署，未写生产业务数据，未调用真实付费模型。
6. 浏览器 P75、Safari/安装 PWA/真机与生产放量缺口沿用原限制，未关闭。
