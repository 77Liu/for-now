# PostgreSQL 迁移与恢复地图

修订：2026-10-17，Owner 已批准，接入 develop 后生效。本文是数据库专项入口；当前部署后端、候选及剩余阻碍只在[控制面](coordination-control-plane.md)维护。

| 范围 | 唯一正文 |
| --- | --- |
| 实体映射、引用、源保留、导入验真和覆盖保护 | [映射与影子导入](persistence/mapping-and-import.md) |
| 角色准备、dry-run、建表、导入和显式覆盖参数 | [迁移命令](persistence/migration-commands.md) |
| 运行角色、旧兼容适配、唯一写源、导出和恢复 | [运行与恢复](persistence/runtime-and-recovery.md) |
| 本机真实数据库与快照验证 | [数据库测试](testing/postgres.md)、[测试影响矩阵](test-impact-matrix.md) |
| 旧试装、切换和验证事实 | [2026-09-30 历史](history/postgres-migration-20260930.md) |

普通在线局部写入遵循[设计契约](design-contracts.md)，不能借用完整迁移/恢复的覆盖入口。关系行存储不等于仓储已按实体精准读写；既有整账户重建、提交和锁行为须在相应迁移切片中明确处理。

生产切换、备份演练和配置动作按[授权策略](release-authorization-policy.md)与[发布 SOP](../SOP/release-and-observation.md)执行。迁移工具的完整哈希参数、密码/会话摘要及数据完整性算法保留协议格式；项目回执简称遵循[控制面协议](coordination-control-plane.md)。

旧文档中“生产仍 JSON”“尚未安装 PostgreSQL”等阶段文字已移入历史，不再与执行命令混排。历史通过、失败、未执行各保留原结论，不据历史状态推定当前生产配置。
