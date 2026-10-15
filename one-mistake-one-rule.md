# 事故与规则索引

原逐条规则已改为场景地图；对应领域文档/测试维护具体行为，不从事故数量推导额外硬门。跨场景合并仍可人工复审，[原始案例归档索引](docs/archive/git-cleanup-20261011/manifests/git-cleanup-20261011-manifest.json)保留作追溯；本轮完成路由整理，尚未逐案确认领域正文与测试已完整吸收，合并审查继续保留。

| 事故或触发场景 | 责任文档/验证入口 |
| --- | --- |
| 同日状态被后一次覆盖 | [metrics.md](knowledge/metrics.md) |
| 更新后整页重绘导致界面状态丢失 | [architecture.md](knowledge/architecture.md) |
| 共享 Codex 会话发生 active writer 冲突 | [architecture.md](knowledge/architecture.md) |
| 追问上下文不完整 | [prompt-architecture.md](knowledge/prompt-architecture.md) |
| 正文编辑使位置型批注失效 | [architecture.md](knowledge/architecture.md) |
| Markdown 源码与可见正文混用坐标 | [architecture.md](knowledge/architecture.md) |
| 新增内容面遗漏 Markdown 渲染 | [architecture.md](knowledge/architecture.md) |
| 文件输入没有可见接收状态 | [architecture.md](knowledge/architecture.md) |
| await 后访问 event.currentTarget | [architecture.md](knowledge/architecture.md) |
| UTC 日期被误当成本地自然日 | [architecture.md](knowledge/architecture.md) |
| 固定日期夹具读取真实墙上时钟 | [regression.mjs](scripts/regression.mjs)、[runtime-infrastructure-regression.mjs](scripts/runtime-infrastructure-regression.mjs) |
| 创建时间被误用为发生时间 | [architecture.md](knowledge/architecture.md) |
| 后台模型任务锁住前台录入 | [architecture.md](knowledge/architecture.md) |
| 流式内容强制抢回滚动位置 | [architecture.md](knowledge/architecture.md) |
| 思考过程耗尽最终回答额度 | [prompt-architecture.md](knowledge/prompt-architecture.md) |
| 损坏数据被当成空库 | [observability.md](knowledge/observability.md)、[observability-regression.mjs](scripts/observability-regression.mjs) |
| 私有数据权限依赖默认 umask | [observability.md](knowledge/observability.md)、[auth-regression.mjs](scripts/auth-regression.mjs) |
| 模型失败路径遗漏审计或泄露正文 | [observability.md](knowledge/observability.md)、[release-readiness-2026-09-27.md](docs/versions/v0.1.0/README.md) |
| 异步结果覆盖已切换的编辑对象 | [architecture.md](knowledge/architecture.md) |
| 运行中任务在重启后被盲目重放 | [architecture.md](knowledge/architecture.md)、[scalable-architecture-design.md](knowledge/scalable-architecture-design.md) |
| 全局刷新序号吞掉无关页面更新 | [architecture.md](knowledge/architecture.md) |
| 不定高正文使用绝对定位气泡 | [architecture.md](knowledge/architecture.md) |
| 未核对运行目录导致图册基于旧副本 | [product-visuals-260927-2045.md](knowledge/long-term/outdated/design/product-visuals-260927-2045.md) |
| 新账户数据未加载就解除私有界面 | [architecture.md](knowledge/architecture.md)、[ui-regression.mjs](scripts/ui-regression.mjs) |
| 恢复对象沿用删除前版本 | [architecture.md](knowledge/architecture.md)、[regression.mjs](scripts/regression.mjs) |
| 永久清理先丢失附件重试依据 | [architecture.md](knowledge/architecture.md)、[regression.mjs](scripts/regression.mjs) |
| 重试请求重复创建后台任务 | [architecture.md](knowledge/architecture.md)、[regression.mjs](scripts/regression.mjs) |
| 恢复校验混用内部对象与公开投影 | [v0.5.5-development-process-2026-10-04.md](docs/versions/v0.5.5/README.md)、[restore-validation-regression.mjs](scripts/restore-validation-regression.mjs) |
| 媒体性能门缺少真实持久媒体路由 | [hotfix-v0.5.7-audio-on-demand-2026-10-05.md](docs/versions/hotfix-v0.5.7-audio-on-demand/README.md)、[v0.5.7-development-process-2026-10-05.md](docs/versions/v0.5.7/README.md) |
| 延迟页面把 mount 当成账户就绪 | [controller.mjs](public/frontend/features/health/controller.mjs)、[frontend-health-feature-regression.mjs](scripts/frontend-health-feature-regression.mjs) |
| 迟到上传只拒收结果却遗留资源 | [recognition.mjs](public/frontend/features/health/recognition.mjs)、[ui-regression.mjs](scripts/ui-regression.mjs) |
| 把切片检查点误当成版本完成 | [iteration-planning.md](SOP/iteration-planning.md) |
| 夜间 Prompt 串成授权终点状态机 | [night-continuous-development.md](SOP/night-continuous-development.md) |
| 未登录壳进入已登录页面生命周期 | [v0.5.8-development-process-2026-10-07.md](docs/versions/v0.5.8/README.md)、[ui-regression.mjs](scripts/ui-regression.mjs) |
| 生产冒烟按按钮文案推断零费用 | [v0.5.8-development-process-2026-10-07.md](docs/versions/v0.5.8/README.md)、[user-journey-testing.md](knowledge/user-journey-testing.md) |
| 回滚后陈旧部署命令复活失败候选 | [v0.5.8-development-process-2026-10-07.md](docs/versions/v0.5.8/README.md)、[pre-launch-confirmation.md](knowledge/pre-launch-confirmation.md) |
| 会话清理重新查询已撤销的主账户节点 | [ui-regression.mjs](scripts/ui-regression.mjs) |
| 归档验证遗漏运行依赖与脚本分派 | [iteration-plan-v0.5.9-2026-10-06.md](docs/versions/v0.5.9/README.md) |
