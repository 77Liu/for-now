# v0.5.16 扩大独立审查 12 项返修回执

日期：2026-10-21
实现提交：`54f3b05b69309f7d7edee0c592983421d170e742`（tree `df94412c290faf9d12ff6e8958bb7e63289d1a28`）
分支：`feat/v0.5.16-sync-latency`
审查来源：[expanded-independent-review-import.json](2026-10-21-expanded-independent-review-import.json)

## 结论

12 项均在代码与回归中处理，状态为 `FIXED_IN_CODE_PENDING_INDEPENDENT_REREVIEW`。本轮未执行独立复审，未重建四账户有状态启动门，未访问生产、未部署、未调用真实付费 provider，因此不声明 `READY_WAIT_OWNER`。

## 逐项处理

| ID | 修复 | 回归 |
| --- | --- | --- |
| G1 | [incremental-sync.mts](../public/frontend/shared/incremental-sync.mts) 重复批次只允许游标前进；恢复失败仍由重试定时器再次执行 | [sync-coordinator-regression.mjs](../scripts/sync-coordinator-regression.mjs) 新增首次恢复失败、重试成功、重复批次不回退 |
| G2 | [usage.mjs](../src/modules/ai/usage.mjs) 持久基数与本地已记录增量相加，并保留持久账目已追上的去重上界 | [ai-domain-regression.mjs](../scripts/ai-domain-regression.mjs) 覆盖次数/费用两条上限与持久账目追平 |
| G3 | [trash/index.mjs](../src/modules/trash/index.mjs) 旧记录按类型限定父集合白名单唯一匹配 | [trash-regression.mjs](../scripts/trash-regression.mjs) 同 ID 书籍下只展开 `bookNote`，排除 `thoughtRemark` |
| N1 | [data-sync-runtime.mts](../public/frontend/app/runtime/data-sync-runtime.mts) 列表/详情只有真实装载过（含 `requestCursor`/`found`）才可跳过恢复 | 前端构建与既有 sync/ports 专项 |
| N2 | [record-sync.mts](../public/frontend/state/record-sync.mts) 子块删除/丢弃使列表摘要失效，不再保留旧预览 | [record-sync-v2-regression.mts](../scripts/record-sync-v2-regression.mts) 新增 N2 反例 |
| N3 | 同上，无关根的子块新增不失效当前详情，同根新增仍重读详情 | 同上新增 N3 正反例 |
| N4 | [trash.mjs](../src/app/trash.mjs) 漂移区批注随子项移入回收站时一并取消任务 | 同上 trash 专项新增 mark/drift 双任务取消断言 |
| S1 | [record-compression-context.mjs](../src/app/record-compression-context.mjs) 正文与引用按新到旧分配预算，裁剪先丢旧日期 | [record-compression-trend-context-regression.mjs](../scripts/record-compression-trend-context-regression.mjs) 新增多日超预算反例 |
| S2 | [record-compressions.mjs](../src/app/record-compressions.mjs) 已跨日等待的历史补充优先本轮槽位；同日仍先保证日报与失败修复槽位 | [record-compression-budget-wait-regression.mjs](../scripts/record-compression-budget-wait-regression.mjs) 新增跨日轮转、单次调用上限与既有调度反例 |
| M1 | [for-now-monitor-journal-context.service](../deploy/for-now-monitor-journal-context.service) 不存在的 `/var/lib/for-now` 改为 `-` 可选禁入，消除 226/NAMESPACE 启动失败 | [monitor-regression.mjs](../scripts/monitor-regression.mjs) 既有启动场景 |
| M2 | [monitor-journal-context.mts](../scripts/monitor-journal-context.mts) 与 [monitor-health.mjs](../scripts/monitor-health.mjs) 读取中台顶层 `message` 错误类名 | monitor 专项断言 `TimeoutError` 进入告警正文 |
| M3 | [monitor-health.mjs](../scripts/monitor-health.mjs) 外层 ready 超时可配（默认 15000ms，下限 5000ms），不再用 5s 截断慢聚合 | monitor/deploy 专项 |

## 验证（绑定实现提交）

- `npm run build:runtime`：PASS
- `npm test`：PASS
- `npm run check`：PASS（214 文档、134 模块、243 路由、1159 维护文本）
- `npm run test:frontend`：PASS（40 子项，含桌面/移动 UI）
- `npm run test:record-compressions`：PASS（16 子项）
- `npm run test:record-sync`：PASS
- `npm run test:monitor`：PASS
- `npm run test:deploy`：PASS（30 场景）
- `npm run test:postgres:stable`：PASS（PostgreSQL 16.14）
- 定向：trash、AI domain、趋势上下文专项：PASS

## 未完成与限制

1. **独立复审未执行**：以上为返修自评与本地证据，不能替代独立结论。
2. **有状态启动门未重建**：现有脱敏快照绑定 `6dace45/92b96c`，本轮未访问生产重新采集，`v0516-rereview-stateful-gate-unrebuilt` 保持 OPEN。
3. **M1/M2/M3 未部署**：采集单元、journal 字段与外层超时仅修改仓库；生产采集单元仍为 failed，需部署后复验。
4. **中台侧聚合未改**：M3 只放宽外层等待，没有修改中台自身 readyz 聚合实现。
5. 未 push/tag/Release/Preview/生产部署，未写生产业务数据，未调用真实付费模型。
6. 浏览器 P75≤500ms、Safari/安装 PWA/真机、生产负载与放量缺口沿用原限制，未关闭。
