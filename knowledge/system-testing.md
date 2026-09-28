# 系统测试

本文档是本项目后端、压测和前端系统测试范围、命令与维护规则的单一事实来源。测试默认只使用临时目录、本地端口、模拟供应商和浏览器隔离 profile，不连接生产数据或产生真实模型、OSS、图片分割费用。

## 统一入口

| 命令 | 范围 |
| --- | --- |
| `npm run test:backend` | 语法、API/数据、认证、本地测试隔离、服务器路径、可观测性、附件、边界、监控、恢复、部署回滚 |
| `npm run test:local-mode` | 本地模拟/冷启切换、线上只读边界与工作区隔离 |
| `npm run test:load` | 独立容量评估：并发读、并发写、混合流量、持久 AI 任务队列 |
| `npm run test:frontend` | 生产候选的桌面、响应式 UI 与移动平台模拟 |
| `npm run test:explore` | P1-P3 本地探索页隔离，仅在探索分支运行，不进入生产发布门禁 |
| `npm run test:system` | 按后端 → 前端顺序执行功能稳定性系统测试 |

功能开发阶段不执行压测，`test:load` 不属于 `test:system` 默认链路，只在容量评估、扩容决策或用户明确要求时单独运行。`test:system` 串行执行浏览器用例，避免多个 Chromium 进程同时清理临时 Session Storage。真实外部服务冒烟 `test:oss`、`test:aliyun` 也不属于默认系统测试，必须在明确授权且配置受控凭据后单独执行。

## 后端测试

| 测试文件 | 主要覆盖 |
| --- | --- |
| `scripts/regression.mjs` | JSON 迁移、CRUD、回收站、异步绑定、幂等、版本竞态、AI 任务与附件清理 |
| `scripts/auth-regression.mjs` | 注册登录、Cookie、CSRF、账户隔离、base path、三类任务重启恢复 |
| `scripts/local-test-mode-regression.mjs` | 线上只读快照、主账户约束、本地写隔离、冷启重置、附件回退和上游写入拒绝 |
| `scripts/observability-regression.mjs` | AI 审计、用量、错误分类、脱敏、日志权限和损坏文件保护 |
| `scripts/attachment-storage-regression.mjs` | 本地与 mock OSS 的隔离、读写、删除和用量 |
| `scripts/boundaries-regression.mjs` | AI/分割限流、每日额度、请求体与附件额度 |
| `scripts/monitor-regression.mjs` | 服务、磁盘、备份、AI 连续失败、费用告警和恢复通知 |
| `scripts/restore-validation-regression.mjs` | 恢复数据解析、数量、附件引用和临时认证会话 |
| `scripts/deploy-regression.mjs` | 候选构建、依赖失败、健康失败、Nginx 失败和原子回滚 |

## 压测

`scripts/load-regression.mjs` 每次启动独立应用与模拟 DeepSeek 服务，验证：

1. 并发读取 `/api/state` 无失败。
2. 并发创建捕念时 JSON 串行写入不丢记录、不重复 ID。
3. 读写混合流量无错误，最终文件仍可解析。
4. 多个持久 AI 任务全部进入终态，每个任务只调用一次模拟供应商，峰值并发不越过 8。
5. 各阶段 P95 不超过测试阈值。

默认回归规模：

| 指标 | 默认值 |
| --- | ---: |
| 并发工作数 | 20 |
| 读取请求 | 200 |
| 写入请求 | 80 |
| 混合请求 | 160 |
| AI 任务 | 24 |
| 读取 P95 阈值 | 500 ms |
| 写入 P95 阈值 | 500 ms |
| 混合 P95 阈值 | 750 ms |
| AI 任务完成 P95 阈值 | 2000 ms |

可通过 `LOAD_CONCURRENCY`、`LOAD_READ_REQUESTS`、`LOAD_WRITE_REQUESTS`、`LOAD_MIXED_REQUESTS`、`LOAD_AI_TASKS` 和对应的 `LOAD_*_P95_MS` 环境变量调整。设置 `LOAD_REPORT_PATH` 可输出 JSON 报告。

压测不在功能开发阶段执行。它用于容量评估而不是功能稳定性验收，也不代表生产容量结论。服务器扩容或放量前，应在隔离预发布环境按 `knowledge/operations-capacity.md` 的 CPU、内存、事件循环、队列和 P95 指标执行，禁止直接对生产写接口施压。

## 前端测试

| 测试文件 | 主要覆盖 |
| --- | --- |
| `scripts/ui-regression.mjs` | 页面主流程、账户切换、输入保留、异步结果、通知跳转、桌面与响应式布局 |
| `scripts/mobile-platform-regression.mjs` | iPhone/Android UA、DPR、触控、横竖屏、动态视口、键盘、安全区和输入缩放 |
| `scripts/exploration-regression.mjs` | P1-P3 探索页交互、移动布局、本地命名空间和零生产 API/第三方请求；独立运行，不属于生产候选 |

`ui-regression.mjs` 默认自行启动临时静态服务器；只有验证指定部署实例时才传入 `APP_URL`。移动模拟基于 Chromium，不等同于真实 iOS WebKit、安装态 PWA、Android 真机或触觉验证。

探索页截图默认写入系统临时目录，避免普通回归污染 Git 工作区。只有确认需要更新视觉基准时，显式设置 `UPDATE_EXPLORATION_SCREENSHOTS=1`。

## 持续维护规则

1. 新增或修改后端行为时，在对应专项脚本增加成功路径、关键失败路径和数据落盘断言。
2. 修改认证、账户数据、后台任务、迁移或部署时，必须纳入 `test:backend`，不得只跑单文件测试。
3. 修改高频读写、全量 JSON、队列或限流逻辑时，可以维护压测场景，但功能开发验收不运行压测；阈值变化必须有同环境容量基线证据，不能为通过测试而放宽。
4. 修改页面主流程、共享组件或移动样式时，更新 `test:frontend` 的行为断言和必要截图检查。
5. 所有系统测试必须可重复、隔离、无真实费用；临时文件、端口、子进程和浏览器 profile 在成功或失败后都要清理。
6. 浏览器测试保持串行；后端测试只有在确认无共享端口、目录或进程资源后才可并行。
7. 测试失败先保留原始断言和证据，修复实现或测试桩根因；不得只提高超时、吞掉异常或删除覆盖。
8. 每次功能发布前运行 `npm run test:system`；容量评估时再单独运行 `npm run test:load`。无法执行的真实外部服务或真机测试单独记录原因与剩余风险。
