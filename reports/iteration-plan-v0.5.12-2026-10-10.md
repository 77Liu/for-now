# V0.5.12 接收计划：日记录压缩与七天趋势 P0

计划日期：2026-10-10（Asia/Shanghai）

状态：`P00 与 G1-G3 本地验收完成 / G4 代码复审 GO / G5-G7 已完成`

代码基线为 V0.5.11 已发布后的文档证据提交 `fb72e71451bfb76d98914e006f39d71704f3bf06`；开发分支为 `release/v0.5.12`。V0.5.11 P00 冷启核心与本版 P0 使用独立候选和验收记录。唯一发行说明位于 [release-v0.5.12-2026-10-10.md](release-v0.5.12-2026-10-10.md)；本文件和发布门禁记录不复制发行说明正文。

## 1. G1 范围冻结

| 需求 ID | 冻结范围 |
| --- | --- |
| `reczz28JPbOch6n9` | 合法个人记录的持久日压缩、来源可追溯、来源变化后失效，并渐进覆盖既往历史 |
| `reczz28JPbOce5sZ` | 按账户本地日期和权限校验近七天趋势，并进入个性化回答上下文 |
| `reczz28HgtICoG29` | 历史稳定用户表达独立补充核心模型；回答按冻结顺序组织模型、趋势、相关材料与当前材料 |

压缩只使用符合授权策略的个人原始记录。无来源、无许可或内容未变化时不排队、不调用模型；编辑、删除、撤权、账户变化和过期生成结果使派生材料失效。七天趋势保留真实覆盖日期，缺失日期不补零；AI 摘要和外部引文不得伪装成用户事实。

调度按 Asia/Shanghai 的 06:00 / 18:05 两个时段扫描；先登记持久任务，不阻塞记录保存。输入、分片、输出和队列均有上限。来源变化后必须重新核验权限和摘要指纹。生产生成由独立额度控制：每次模型调用在 PostgreSQL 共享账本原子预留；日限额 ¥1、单次峰值 ¥0.25、全站每日最多 4 次；每轮最多回填 1 个历史日期。未知最终费用按预留峰值记账，超预算进入有界等待或 fail-stop，不盲目重试。

历史稳定表达最多 3 项、总预算 120 tokens，须为精确用户原文并保留来源。回答上下文先放稳定冷启核心及已就绪的历史表达，再按日期和合法来源加入近七天趋势、相关记录、有限无关样本和当前问题；普通文本日记辅助不注入趋势。

## 2. G2-G3 验收与实现

- 日压缩输入/输出、权限、来源追溯、日历窗口、分片覆盖、幂等、持久预算等待、失败隔离、七天趋势及用户可见覆盖页已由专项回归覆盖；14 项记录压缩专项全通过。
- DeepSeek 压缩输入 token 峰值按消息 JSON 转义后的 UTF-8 字节上界和模板余量计量；输出峰值上限为 900 tokens。单次估值超过 ¥0.25 的模型请求在 provider 前拒绝。
- PostgreSQL `site_ai_budget.record_compression_quota` sidecar 通过幂等 `ALTER ... ADD COLUMN IF NOT EXISTS` 增加，与预算文档在同一行锁事务读写。双 runtime PG 回归验证调用/费用并发限额、取消释放、结算、未知成本按预留额计费，以及旧版只更新文档仍保留 sidecar。
- 存储回滚往返回归使用独立临时 PostgreSQL，验证新增 `recordCompressions` 与 `historicalUserSupplement` 在 `.511` 未知字段读写后仍可由当前版本完整读取。
- 扫描日志只记录脱敏计数、预算耗尽、失败元数据和耗时，不记录账户/来源 ID、正文或凭据。相关测试已纳入 `system-test record-compressions`。
- P00 smoke 通过：17/17 journeys 自动覆盖；已有用户补答另以双账户真实 headless Chrome 和 loopback provider mock 验证补答同步、提取候选、原文来源 span、用户确认、刷新恢复及账户隔离。provider messages 与五条许可答案逐条精确核对，且排除预置历史/profile 标记；真实 provider 质量仍不在本地 mock 验收范围。
- 日级 Journey 通过：22 条中 21 条自动覆盖，唯一 partial 为本地线上快照人工验收；日压缩/七天趋势 10 项断言均有专项证据，含聊天与复盘实际引用 renderer、测试默认配置关闭扫描。
- 同事务新来源首次回答的 stale 竞态已修复；专项验证新建 queued、版本变化、旧任务、running/waiting、显式事务、幂等重放及撤权后 stale。
- `node scripts/system-test.mjs frontend`：前端全门通过，含桌面、响应式与移动端模拟。
- 后端完整门已在实现/测试 tree `2466bfa0ebabf7de40844efad8a7665529c00e99` 通过，包含隔离部署场景和 Preview 模拟；之后仅对个人概要趋势字段补充 OpenAPI nullable 契约及回归，专项 API 契约与模块检查通过。更新候选门已通过 API、权限、恢复和 release-fence 检查；按变更影响表未重复执行已通过且无关的部署回滚模拟。上述本地回归与模拟未执行远端命令、push 或部署；生产发布另见下文 G5。
- PostgreSQL 16.14 本地四项均通过：AI 预算双 runtime、主集成、生命周期/幂等账本、压缩映射回滚往返。
- `node scripts/check-modules.mjs`：117 个活动模块、240 条拥有路由，无深层导入或循环依赖。独立 reviewer 对当前完整代码差异给出 GO。

后端完整门通过时的实现/测试 tree 为 `2466bfa0ebabf7de40844efad8a7665529c00e99`；后续 nullable 契约的当前代码由 API 专项回归复验。最新后端门通过 API、恢复与 release fence，在进入不受该 API 变更影响且已有通过证据的部署回滚模拟后按用户影响矩阵停止。独立 reviewer 对运行时代码差异给出 GO。冻结代码 SHA/tree 为 `229df17bb876464f60d5c28f10258582aa857c90` / `f6fdcca0e66f2c06904565cc7953e671b421ae00`；文档收口后最终发布 SHA/tree 为 `4359648b41608429832e2ce4897bd12163a5d812` / `3acb46da5e8cb609f41adcb1c866434736208380`，运行时代码保持一致。Preview、Gitee main/tag/Release、生产备份与隔离恢复、schema initializer、严格角色预检和生产部署均完成；生产日压缩按硬限额启用。G6 生产限定观察已通过，31/31 个一分钟样本覆盖 14:01:02–14:31:13（Asia/Shanghai），持续 30 分 11 秒，活动/readiness SHA 一致，PID 稳定、零重启、入口全 200、压缩调用与成本为 0；G7 复盘记录见发布门禁。

## 3. 数据迁移、兼容与回滚

schema initializer 必须先于 `.512` 服务启动，以创建 sidecar 列；未初始化时严格角色检查 fail-stop。该新增列不影响 `.511`，旧版仅更新 `document` 不会覆盖额度账。账号数据映射没有破坏性 DDL，`.511` mapping 对新 collection 的往返保留由临时 PG fixture 验证。

发布前须为全库及附件取得新鲜、校验通过的备份并完成隔离恢复演练；记录 schema initializer、权限核验及部署 fence。代码回滚可回到 `.511` 候选，sidecar 列和配额账在旧版期间保留；回滚不等同于数据恢复。扫描开关可独立关闭，关闭时不得发起压缩 provider 调用。

## 4. G4-G7 顺序

G4 独立 reviewer 已对运行时代码给出 GO。G5 已完成 Preview、备份/恢复、schema initializer、runtime 角色预检、Gitee Release、生产部署与扫描限额设置。G6 生产观察完成：31/31 个连续一分钟样本，持续 30 分 11 秒，活动/readiness SHA 均为 `4359648b41608429832e2ce4897bd12163a5d812`，PID `870806` 稳定、重启 0 次、服务 active、公网 `/now/` 均为 HTTP 200，压缩调用/成本/等待均为 0。G7 已回流发布与观察证据；`local-online-snapshot`、`private-media-distribution`、`responsive-visual-accessibility` 保持 partial。

V0.5.11 的 30 分钟生产观察已完成：31 次分钟样本全部通过，readiness/active SHA 一致，重启数为 0。证据记录在 [V0.5.11 发布门禁](pre-launch-2026-10-10-v0.5.11.md)，不与本版扫描或 release note 混写。
