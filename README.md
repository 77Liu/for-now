# 此刻 · 个人成长追踪

本地优先的个人记录与成长系统：记录、回答、反馈、学习与更新。用户原文与 AI 派生内容分开保存，支持持续编辑、追溯与纠正。

## 启动

Node.js 20+；首次 `npm ci`，随后运行 `./启动.command`，默认本地入口为 <http://127.0.0.1:4173/>。隔离功能验收使用 `npm run start:local-test`，具体地址以启动输出为准。

生产入口：<https://77liu.top/now/>。部署与恢复操作见 `deploy/README.md`；这里不保存生产版本副本。

## 文档地图

| 入口 | 简述 |
| --- | --- |
| [PROJECT_RULES.md](PROJECT_RULES.md) | 跨任务有效约束与共同规则来源；开始工作必读 |
| [SOP/README.md](SOP/README.md) | 按当前任务选择操作流程；不要求通读所有 SOP |
| [唯一协调控制面](knowledge/coordination-control-plane.md) | 当前迭代、候选、发布和运行状态的唯一正文；仅协调者维护 |
| [README-TODO.md](README-TODO.md) | 状态入口地图，不保存状态值 |
| [one-mistake-one-rule.md](one-mistake-one-rule.md) | 事故到责任文档/测试的索引，按触发场景读取 |
| [knowledge/](knowledge/) | 领域知识和设计，按问题检索，不逐篇列入启动地图 |
| [reports/](reports/) | 计划、交接、发布及核验记录；历史有时间与范围边界 |
| [scripts/](scripts/) | 执行与检查工具；命令入口以 package.json 为准 |
| [recyclebin/](/Users/bytedance/Documents/Codex/个人成长追踪/recyclebin/) | 被替换资料的追溯存档，不作为现行规则 |

代码主要位于 `src/`（服务端）、`public/frontend/`（前端）、`ios/`（原生壳）。数据与密钥保存在受保护目录，不进入 Git。
