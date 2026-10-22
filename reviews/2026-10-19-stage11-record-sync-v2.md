# 阶段 11 记录级同步 v2 验收

日期：2026-10-19。基线 `0b44a82`，规则基线 `9c4916`。本轮未部署、未访问生产数据、未调用真实付费 provider。

## 结论

阶段 11 本地正确性出口通过，性能与设备结论保持 partial。v1/v2 独立；v2 只开放阶段 6 已闭合的思绪生产链，通知、通用任务和其他实体继续由既有消费者负责。未知类型、坏身份、同投递版本冲突及账户/工作区迟到批次均拒绝整批且不推进 cursor。

## 实现

- PostgreSQL 按独立 sync head 分页读取完整 command cursor，不拆分同一 ChangeSet；过大 command 要求有界 rebase。
- 服务端将思绪细粒度变化折叠为公开 `thoughtChain/thoughtBlock` 投影，过滤私有字段名；当前页和详情在同一只读快照取得 high-water。
- 前端 `state` 是 Map/scope/legacy 投影唯一写者；v1 transport 继续运行，v2 transport 独立续接。
- create/delete、排序变化及 `refetch` 自动 rebase active scope；刷新从持久 cursor 和当前有界 route snapshot 恢复，不保存整账户正文。
- 变化索引裁剪后，详情和 scope rebase 仍从当前状态完整读取。

## 验证

- `npm test --silent`、`npm run check --silent`、`npm run test:record-sync --silent`：PASS。
- `npm run test:postgres:stable`：PASS，PostgreSQL 16.14、普通 RLS 角色、正式 HTTP、重启、独立导出恢复。
- 真实 Chrome：双标签收到新思绪；cursor 前进；create/order 自动 rebase；未提交草稿与焦点在增量期间保留；整页刷新后草稿、scope 和 cursor 恢复；仅见导航导致的预期长轮询 abort，无应用异常。
- 延迟：PG 8 样本 P75 124.1ms；内存协议 P75 0.10ms。Chrome 单样本响应到可观察 paint 上界约 1.1s，样本与工具精度不足，TC-12 保持 partial。

## 限制

Safari、安装 PWA、移动真机、生产负载和生产放量未验。v1 退场及 Service Worker 强制升级仍属于 v0.6 独立评审，不在本轮实现。
