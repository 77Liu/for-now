# 应用架构地图

修订：2026-10-17，Owner 已批准，接入 develop 后生效。本文只定位设计与实现，不保存当前生产版本、候选状态或重复模块清单。实际运行身份及证据只查[唯一控制面](coordination-control-plane.md)。

## 分层入口

| 范围 | 维护位置 |
| --- | --- |
| 职责、实体访问、事务、记录同步、列表/详情、首屏 | [设计契约](design-contracts.md) |
| 模块 owner、公开入口、依赖与迁移 | [模块设计](modularization-design.md)、[机器登记](module-boundaries.json) |
| 服务端装配、领域、HTTP、外部适配 | [src](../src/) |
| 页面、功能、传输、会话与状态 | [前端源码](../public/frontend/) |
| 数据库映射、运行/恢复协议 | [PostgreSQL](postgres-migration.md) |
| Prompt、用户原文与派生内容 | [Prompt 架构](prompt-architecture.md)、[冷启动](onboarding-strategy.md) |
| 日志/审计与容量运维 | [审计](observability.md)、[运维](operations-capacity.md) |
| 视觉与交互设计 | [设计语言](design-language.md)、[UI SOP](../SOP/ui-ux-optimization.md) |
| 扩展选项及其证据条件 | [架构演进](scalable-architecture-design.md) |

## 使用方式

沿任务的实际输入、服务、仓储、重建、投影及前端消费者核对候选代码。旧适配器仍有整账户读写或整域同步时，将其作为待迁移现状评估，不能引用旧架构文字为新命令开例外；也不能因为目标契约已写入文档就宣称现有代码完成迁移。

启动/编译命令以 [package.json](../package.json) 与[工程规则](engineering-rules.md)为准。页面加载和更新直接遵循设计契约，不保留“首次启动可全量加载”或“按域替换缓存”的第二套策略。

## 历史参考

旧架构中的版本、数据结构与实现说明已分离到[应用历史](history/application-before-v0.5.16.md)和[模型/运行历史](history/model-runtime-before-v0.5.16.md)。这些文件保留原始叙述及当时限制，不用其“当前”字样推定现行状态。旧架构图亦仅是历史说明，不能作为新候选的验收证据。
