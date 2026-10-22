# 此刻 · 个人成长追踪

本地优先的个人记录与成长系统：记录、回答、反馈、学习与更新。用户原文与 AI 派生内容分开保存，支持持续编辑、追溯与纠正。

## 启动

Node.js 20+；首次运行 `npm ci`。账户模式需配置 `AUTH_REQUIRED=1`、内测码摘要和对应持久化环境后运行 `./启动.command`，默认入口为 <http://127.0.0.1:4173/>。隔离功能验收使用 `npm run start:local-test`，具体地址以启动输出为准；普通无认证业务模式已退役。

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
| [版本记录](docs/versions/) | 按版本保存唯一发布记录及必要机器证据 |
| [技术方案](docs/technical-proposals/) | 当前可评审技术方案；不代表已经实施或纳入版本 |
| [协调控制面](coordination/current.json) | 当前迭代、候选、授权和下一动作的机器可读正文 |
| [scripts/](scripts/) | 执行与检查工具；命令入口以 package.json 为准 |
| [归档清单](docs/archive/git-cleanup-20261011/manifests/git-cleanup-20261011-manifest.json) | 被替换资料的追溯索引，不作为现行规则 |

代码主要位于 `src/`（服务端）、`public/frontend/`（前端）、`ios/`（原生壳）。数据与密钥保存在受保护目录，不进入 Git。
