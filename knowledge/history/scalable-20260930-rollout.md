# 2026-09-30 架构演进原方案

2026-10-17 从活跃正文分离。以下为原方案/当时事实，不代表当前批准范围、运行状态或强制门槛。现行入口见[架构演进](../scalable-architecture-design.md)。

## 8. 演进顺序

### 阶段 A0：设计与样本冻结

- 冻结现有行为样本、数据域清单、迁移风险和回退条件；生产运行架构不变。

### 阶段 A1：现有架构正确性

- 先完成回收站、异步目标绑定、用户原文分层和失败回归。
- 退出条件：P00 自动化通过，恢复演练成功，跨账户测试 0 泄漏。
- 当前状态：P00 本地自动化、恢复和跨账户边界已验证，P00-02 生产数据恢复完成，A1 工作区退出条件已满足。由于代码尚未提交、部署和完成生产冒烟，不得据此直接启动生产存储迁移。

### 阶段 A2：代码模块化与契约边界

- 按 `knowledge/modularization-design.md` 在现有 Node.js 与原生前端内渐进拆分；当前已建立机器可读登记与 `check:modules`，并完成持久化适配器和构思领域首批拆分。
- 模块边界稳定后再并行提供 `/api/v1`，补齐 OpenAPI、错误码、幂等和并发测试，不同时替换语言、框架和存储。
- 数据访问接口当前仍由 JSON 实现；PostgreSQL 只进行离线影子导入与校验，不双写生产。
- 异步任务先具备持久状态和目标绑定。
- 退出条件：模块迁移例外清零，边界检查和完整回归通过；生产使用端点全部纳入契约，旧/新客户端兼容测试通过，P95 回归不超过 10%。

### 阶段 B：PostgreSQL

- 建表、RLS、索引、迁移器和逐表校验器；迁移范围包含业务记录、认证/会话、模型设置、用量账本与审计保留边界。
- 第一批代码已经覆盖账户、迁移批次、原始快照、思绪根对象、内容块、追问、备注和批注；原始 JSONB 快照是迁移校验与回退证据，不是最终查询模型。
- 至少使用 3 份真实快照 dry-run；逐账户核对数量、ID、时间、版本、引用、附件 SHA-256 和孤儿引用，再在短维护窗口切换。
- 当前数据量很小，优先一次性可验证迁移；不使用脆弱的跨存储直接双写。
- JSON 只作为切换前恢复点。切换后默认前滚；只有反向导出已经演练通过，才可把它称为回滚路径。

### 阶段 C：前后端分离与 worker

- 前端独立构建发布，API 保持同域版本化路径。
- 先迁移 AI 和图片任务；任务领取使用 `SKIP LOCKED` 或等价机制，并具备租约、心跳、fencing token、超时回收、有限重试、死信、取消、幂等副作用和优雅停机。
- 用 1000 个混合任务执行 kill/restart 测试，要求丢失 0、重复外部副作用 0、无终态 0、死信可重放。
- 前端独立发布后再无状态化 API。双实例前必须完成共享会话、限流、任务领取、单实例调度、真实 readiness 和持久任务事件；任一实例退出时错误率不超过 1%。

### 阶段 D：按指标扩容

- 连接池饱和或锁等待升高：增加 PgBouncer/托管连接池。
- 读流量显著高于写流量且主库读 CPU 成为瓶颈：增加只读副本。
- 任务积压和数据库轮询成为瓶颈：引入托管消息队列或 Redis。
- 向量规模和检索延迟超过 PostgreSQL 目标：再评估独立向量服务。
- 单库经纵向扩容、索引和归档后仍接近容量边界：按 `account_id` 分片。

## 9. 明确触发门槛

不得仅凭“未来可能高并发”增加基础设施。每个组件使用独立进入条件，不以任一指标触发整套架构跳级：

- **连接池**：利用率或锁等待连续 15 分钟超过 70%，经压测复现后评估 PgBouncer/托管连接池。
- **API 实例**：单实例 CPU 连续 15 分钟超过 70%，或事件循环延迟 P95 超过 100 ms；先优化热点，再以近 14 日峰值 5 倍压测验证双实例。
- **任务队列**：最老任务等待超过 30 秒，或积压超过正常 5 分钟吞吐量；先优化领取与并发，再评估托管队列或 Redis。
- **只读副本**：读流量显著高于写流量，且主库读 CPU 已成为可复现瓶颈。
- **向量索引**：语义检索已证明业务增益，向量超过百万级且精确检索不满足 SLO 后再启用 HNSW；定期与精确检索对比召回率。
- **分片**：单库经纵向扩容、索引和归档后仍逼近容量、维护窗口或合规边界；`100` 个账户本身不是分片理由。

## 10. 行业实践取舍

| 参考 | 可采用的原则 | 不照搬的部分 |
| --- | --- | --- |
| Day One | 私密内容、端到端加密、用户拥有数据、可导出 | 当前服务端 AI 与纯 E2EE 冲突，先诚实披露 |
| Mem | 低摩擦捕捉、可见记忆、语义检索、版本历史；AI 场景明确采用静态/传输加密 | 不把自动代理写操作作为当前默认 |
| OpenAI Memory | 记忆与原始来源分离，可查看、更正、删除和限制使用范围 | 不使用不可解释的单一记忆摘要 |
| Notion | PostgreSQL 长期作为核心；以 workspace/account 作为局部性和未来分片键 | 不在当前规模预建数百分片、Kafka 或数据湖 |
| pgvector | 向量与关系数据同库、支持精确/近似和混合检索 | 不在小数据阶段盲目上 ANN 索引 |
| Google SRE | 黄金信号、黑盒与白盒结合、低噪音告警、SLO | 不复制大团队运维流程 |
| Transactional outbox | 业务写入与事件意图同事务、消费者幂等 | 不因采用 outbox 就拆微服务 |

## 11. 参考资料

- Day One Privacy & Security FAQ: <https://dayoneapp.com/privacy-faqs/>
- Mem privacy and export: <https://get.mem.ai/pricing>
- OpenAI Memory FAQ: <https://help.openai.com/en/articles/8590148-memory-faq>
- Notion, Sharding Postgres: <https://www.notion.com/blog/sharding-postgres-at-notion>
- pgvector: <https://github.com/pgvector/pgvector>
- PostgreSQL Row Security: <https://www.postgresql.org/docs/current/ddl-rowsecurity.html>
- AWS Transactional Outbox: <https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html>
- Google SRE Monitoring Distributed Systems: <https://landing.google.com/sre/book/chapters/monitoring-distributed-systems.html>
