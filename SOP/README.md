# SOP 地图

按任务选择一份主流程，需要时才读取专项。跨任务约束见 [PROJECT_RULES](../PROJECT_RULES.md)，当前迭代、候选、发布和运行状态只读[唯一协调控制面](../knowledge/coordination-control-plane.md)。小任务用同一任务卡承载全过程，不为阶段单独建报告。

| 场景 | 流程 | 产出 |
| --- | --- | --- |
| 需求进入 | [需求收集](requirement-intake.md) | 去重后的问题、证据与验收 |
| 选择与拆分 | [迭代规划](iteration-planning.md) | 冻结范围、依赖、责任与任务卡 |
| 实现 | [功能开发](feature-development.md) | 可验证切片与交接 |
| 多 Agent | [协作协议](multi-agent-orchestration.md) | 唯一调度、写边界、契约与接入顺序 |
| 隔离与回收 | [工作树生命周期](worktree-lifecycle.md) | 少量活跃现场与可恢复归档 |
| 集成 | [集成审查](integration-audit.md) | 实际集成候选与影响验证 |
| 发布 | [发布与观察](release-and-observation.md) | 风险处置、发布决定与运行证据 |
| 生产异常 | [热修](hotfix.md) | 最小止损、修复与双向回流 |
| 复盘 | [迭代复盘](iteration-retrospective.md) | 问题回流到原维护位置 |
| 周期跟进 | [持续跟进](night-continuous-development.md) | 基于当前入口的差分推进 |
| UI 设计 | [UI/UX 优化](ui-ux-optimization.md) | 用户路径、状态和设计交接 |
| 浏览器验收 | [HTTP 浏览器评审](http-browser-review.md) | 真实操作、持久化与视觉证据 |
| iOS 专项 | [真机性能](ios-device-performance-testing.md) | 指定原生候选的性能证据 |

测试选择的唯一规则是[测试影响矩阵](../knowledge/test-impact-matrix.md)；[系统测试](../knowledge/system-testing.md)只维护命令目录、实现说明和证据格式，不再另存一套选择状态或发布门槛。

旧报告中的 G0–G7 仍可用于读历史：候选、冻结、规划、切片验证、候选审查、发布决定、上线观察、复盘。它们不要求重复建表、重复测试或独立审批。
专项流程仅在任务触发时适用；Web 发布不默认等待原生专项。SOP 仍供人工进一步精简，修改时更新原文而非追加另一套全局门。
