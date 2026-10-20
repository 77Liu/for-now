# v0.5.16 独立审查返修

日期：2026-10-20。独立审查对象 `2d97b585/6527cad5`；最终返修候选 `6dace45ac660c64f905f2b80c9c15a112755c8e0`，tree `92b96c8970a8fd7b0c791abc04c6fc52c81d9d68`。规则基线 `9c4916`。

## 结论

独立审查确认的 4 项 P1、8 项 P2 均已按 Owner 拍板实现，并进入项目正式回归。最终候选通过主回归、静态门、完整 PostgreSQL 16.14、记录同步、真实 Chrome 前端旅程复用及四账户有状态门。

本报告是开发侧返修与验证结论，不替代独立复审。控制面保持“返修已验证，等待独立复审”，不恢复 `READY_WAIT_OWNER`，也不授予 push、tag、Release、Preview 或生产部署权限。

## 逐项结果

| ID | 修复 | 直接证据 |
| --- | --- | --- |
| R1 | 列表 scope 自有摘要投影；详情 scope 维护完整实体。同 scope 同游标仍检查真实冲突，列表/详情不再互比。 | 列表→详情→列表、同水位、重复接入和真实冲突回归通过 |
| R2 | 当前投影已不存在的合法历史变化返回 `SYNC_REBASE_REQUIRED`，客户端恢复当前范围，不重建旧对象。 | 创建/删除跨批次回归通过，删除对象不复活 |
| R3 | v2 恢复绑定实际 scope 描述和路由请求序号；切页中止旧恢复，响应后再次复验路由。 | A 在途→B 后到，最终仅 B 接入 |
| R4 | rebase 只保留请求中的活动范围，并释放无引用详情实体。 | 连续访问 50 个详情后保留 1 scope/1 entity |
| R5 | v2 route-state 不再读取后丢弃思绪正文；正文与语音附属投影由同一次 rebase 返回。 | 正式 PG 路由/rebase 断言及前端旅程通过 |
| R6 | 新增 `filter` refetch 语义；正文/子块文本变化只使有查询条件的思绪页失效。 | `apple`→`banana` 搜索成员恢复回归通过 |
| R7 | `SyncStatusEvent` 联合类型覆盖 v1/v2；两路错误独立保留，仅对应通道成功后清除。 | `record-error` 显示错误，v1 pull 不清除，v2 pull 后恢复 |
| R8 | rebase 失败进入既有失败计数与指数退避；成功后才重置。 | 连续延时 `1000/2000/4000/8000ms` |
| R9 | 账户+日期保留“已提交但持久汇总尚未确认”的桥接额度；准入同时计算持久、活动和桥接值。 | 调用上限 1 及费用 0.6+0.5 的受控并发均拒绝第二次 |
| R10 | 新增共享任务目标契约；准备、恢复、保存校验和图片服务共同识别普通区/漂移区，并保留完整历史资源映射。 | 漂移任务 PG 重启恢复、旧脱敏关系 round-trip 和新任务必需 relation 均通过 |
| R11 | 永久清理按集合+ID 展开；旧缺集合数据仅在父身份唯一时兼容推断。 | books/thoughts 同 ID 不串选，预览和执行清单一致 |
| R12 | 配置启用时，现有后台调度器逐账户调用裁剪；SQL 按完整 cursor 组删除，不拆事务变化，不删除业务对象。 | 调度入口专项、PG cursor 组计数及业务对象保留通过 |

## 类型与边界

`data-sync-runtime` 已迁为 282 行 `.mts` 源码，原 `.mjs` 仅为生成物薄壳；`typecheck:frontend` 直接检查 v1/v2 状态事件消费者。新增 `shared.task-targets` 模块集中任务完整身份和候选位置，模块门现为 134 个模块、243 条路由、无深层导入或环。

PWA 壳层新增生成同步运行时，预缓存闭包由 92 增至 93 个模块。生成后路径统一由现有 `prepare-generated-runtime` 修正。

## 验证

- `npm test --silent`：PASS。
- `npm run check --silent`：PASS；212 个文档、134 个模块、243 条路由。
- `npm run test:record-sync --silent`：PASS。
- `npm run test:postgres:stable --silent`：最终候选 PASS；PG 16.14、RLS、30 个生产者、漂移恢复、正式 HTTP、cursor 裁剪、重启和独立恢复。
- PG 唤醒 8 样本 P75：178.94ms。
- `node scripts/system-test.mjs frontend`：`ddc5edb` 应用/前端树直接 PASS，39 项、95.58s；后续提交仅修任务持久映射与准备集合，前端树未变。
- 最终候选四账户快照 `50839a6e...`：default 和完整 `v0516-combined` 均 PASS，136 条任务状态，provider/外发/媒体副作用 0。

## 保留边界

Safari、安装态 PWA、移动真机、生产负载和生产放量未验。浏览器 500ms P75 不由 PG P75 代替。94 条真实语料未重建、未重跑；真实付费 provider 调用为 0。v1 退场和强制 PWA 升级仍不在 v0.5.16。
