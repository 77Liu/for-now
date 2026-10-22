# v0.5.16 组合候选验收

日期：2026-10-19。规则基线 `9c4916`。最终候选 `2d97b585258cc7d241f6566d5d994418253889dc`，tree `6527cad5a12df5b271cd00e31c4e5196bddf6c83`。

## 结论

六项必需门全部通过，可以冻结候选并进入 `READY_WAIT_OWNER`。本轮只完成本地候选验收；未 push、tag、创建 Release/Preview、部署、写生产业务数据或调用真实付费 provider。

Safari、安装态 PWA、移动真机、生产负载/放量及浏览器 500ms P75 仍为 `PARTIAL/NOT_RUN`，不得由本结论外推。阶段 11 保留 v1；PWA 强制升级与 v1 退场仍属于 v0.6 独立评审。

## 必需门

| 门 | 结果 | 证据 |
| --- | --- | --- |
| release metadata / PWA | PASS | 版本 `0.5.16`；前端旅程核对 92 个预缓存模块、离线 KaTeX 闭包、懒模块按需缓存及私有请求排除 |
| static module contracts | PASS | 最终候选 `npm run check --silent`；133 个模块、243 条 owned routes、无深层导入或环 |
| full regression | PASS | 最终候选 `npm test --silent`；生成物、主回归及失败恢复断言通过 |
| release journeys | PASS | `e2d51a0` 精确候选 `node scripts/system-test.mjs frontend`，39 个子套件、97.985s；最终两次提交只改独立启动门脚本，应用、前端及旅程夹具未变 |
| release protection | PASS | 复用 `e52db12` 的 release fence、deploy/preview dry-run；之后未改发布、部署、回滚脚本或配置 |
| stateful PostgreSQL startup | PASS | 最终候选、新四账户脱敏快照、PG 16.14；default 与完整 `v0516-combined` 均通过启动、readyz、同库重启及核心读写 |

生产依赖审计为 0 个已知漏洞（149 项生产依赖）。`1bc3e0` 的完整 PostgreSQL stable 门继续有效：最终后续提交仅修改 `scripts/release-state-startup-gate.mts`，应用持久化和 PG 夹具未变。

## 有状态全局门

快照由 `for_now_backup` 经 SSH 回环隧道在 `REPEATABLE READ READ ONLY` 事务内采集；只精准读取认证账户 ID，再读取四账户业务映射及 `settings/usage`。源连接关闭后才在本机进程内脱敏。未保存账户身份、正文、原媒体、连接串或凭据。

- 快照：`artifacts/local/v0516-startup-snapshot-2d97b58.json`
- manifest 摘要：`2d0f799995821349ca6c7a2d3465d3ff81d335bfe9d48bb5551ad25826c3fa6e`
- 采集时间：`2026-10-19T17:45:17.086Z`
- 账户：4；任务状态：134；账户文档：四账户 `settings/usage`，无可选 `costPlan`
- default：旧同步读、记录命令和 sync v2 关闭，PASS
- v0516-combined：账户恢复、PG metadata 窄读、AI 队列、账户唤醒、思绪分页、增量同步、七项记录命令和 sync v2 全账户白名单同时开启，PASS
- 两个 profile 首次启动和重启配置一致；每次启动恢复 4 个账户；登录、状态读取、纯文本思绪保存/读回、任务和通知读取通过
- provider、外发和媒体副作用尝试均为 0；无附件保存的附件清单读取为 0

## 保留失败

验收未覆盖旧失败。`e52db12` 暴露通知夹具缺 record-sync 端口，`7164df7` 暴露 runtime owner 超限；`1bc3e0` 暴露生产旧认证 schema 快照不兼容，`e2d51a0` 暴露无附件保存的陈旧查询断言，`620fff6` 暴露组合 profile 缺记录命令和 sync v2。各问题均形成后继候选并由直接证据关闭。

最终候选自测曾与两个共享 `.build` 构建并行，出现一次生成模块暂缺；其他构建结束后独占重跑通过。该并发失败不改写为候选缺陷，正式门均采用顺序构建。

## 证据边界

真实 Chrome 桌面及响应式审计通过；移动结果是 iPhone SE/15 与 Pixel 7 的浏览器模拟，不等于 Safari、安装态 PWA 或真机。浏览器 P75 500ms、生产放量和长期 SLO 不属于本次 PASS。94 条真实样本未重建、未重跑；日志明确保持 `NOT_RUN`。
