# 系统测试入口与证据

修订：2026-10-17，Owner 已批准，接入 develop 后生效。本文只维护命令地图、执行资源及回执要求；[测试影响矩阵](test-impact-matrix.md)是选择专项、上层门、证据失效和结果状态的唯一正文。

| 专项 | 说明 |
| --- | --- |
| [后端目录](testing/backend-catalog.md) | 现有脚本与行为定位 |
| [前端目录](testing/frontend-catalog.md) | 浏览器及页面行为定位、模拟限制 |
| [PostgreSQL](testing/postgres.md) | 真实数据库工具、隔离与环境故障 |
| [性能与容量](testing/load.md) | 压测执行和结果口径 |
| [第三方实测](third-party-live-testing.md) | plan-only / live 协议与调用矩阵 |
| [用户旅程](user-journey-testing.md) | 旅程登记与实际消费验证 |

## 命令地图

以下为定位目录，不是每次任务的必跑清单。实际脚本、阶段与默认参数以 [package.json](../package.json) 为准；目录中的覆盖描述不等于候选已通过。

| 命令 | 范围 |
| --- | --- |
| `npm run check:modules` | 前后端模块登记/语法、公开入口、允许依赖、静态及字面量动态深层导入、循环依赖、前端请求入口、运行配置入口和迁移例外 |
| `npm run check:entrypoints` | 固定三类真实入口、目标组合 API/import binding、handler 顺序、页面清单、职责禁令、行数和 G4/G6 到期迁移例外 |
| `npm run test:entrypoints` | 入口词法/策略正反例与 feature registry 的挂载、渲染、清理、账户重置、迟到结果和失败恢复 |
| `npm run test:commit-gate` | 本地 `feat/fix/test/docs` 任务提交的隔离候选、允许/拒绝边界、门禁自身完整性、测试失败和暂存 tree 漂移 |
| `npm run test:backend` | 语法、API/数据、认证、本地测试隔离、服务器路径、可观测性、附件、边界、监控、恢复、部署回滚 |
| `npm run test:api-v1` | v1 公共包络、OpenAPI、认证、base path、思绪/状态/健康纵向链、游标、ETag/If-Match、幂等、SSE、删除恢复和账户隔离 |
| `npm run test:openapi` | 思绪 OpenAPI 分片、根文档组合、引用闭合、运行路由覆盖和写入请求头 |
| `npm run test:records` | 此刻状态与每日健康记录的载荷、CRUD、HTTP 兼容、账户隔离和失败提交 |
| `npm run test:records-v1` | 状态与健康记录 v1 的游标列表、详情、幂等创建、条件更新/删除、账户隔离和 OpenAPI 组合 |
| `npm run test:g2` | 思绪检索/回访、跨体裁导出、行动/习惯、反馈/验证及统一 HTTP/持久化集成 |
| `npm run test:keepsake-media` | 小物媒体事务、WebP 派生规格、批量失败补偿、上传响应契约及历史媒体迁移计划 |
| `npm run test:frontend-shared` | 前端内容安全/Markdown/LaTeX、本地时区边界和图片数量/MIME/大小校验 |
| `npm run test:opening` | 开屏参数、雨滴物理、同步壳、退出上限、失败重试、减少动态效果与资源清理 |
| `npm run test:frontend-shell` | 浏览器 JS/CSS 薄入口、25 个视图注册、页面切换和 feature 生命周期副作用 |
| `npm run test:persistence` | JSON repository、业务及身份/配置/用量/附件映射与构思领域服务 |
| `npm run test:postgres:preflight` | 在业务断言前核对 PostgreSQL 16 的 `postgres`、`initdb`、`pg_ctl` 和实际选择路径 |
| `npm run test:postgres:stable` | 通过预检选定固定 PostgreSQL 16 工具链，再执行完整真实数据库专项 |
| `npm run test:postgres` | 临时真实 PostgreSQL：关系实体全领域关系重建、RLS/认证授权、整批导入、失败回滚、第二数据库恢复，以及生命周期/幂等账本的跨进程与重启；数据库改动的额外必跑门禁 |
| `npm run test:local-mode` | 本地模拟/冷启切换、线上只读边界与工作区隔离 |
| `npm run test:load` | 独立容量评估：并发读、并发写、混合流量、持久 AI 任务队列 |
| `npm run test:frontend` | API/会话/状态契约、生产候选的桌面、响应式 UI 与移动平台模拟 |
| `npm run test:journeys:smoke` | 前端契约与真实浏览器用户任务闭环；触发时机由测试影响矩阵决定 |
| `npm run test:journeys:daily` | Smoke 加前端全回归、认证隔离和线上快照恢复 |
| `npm run test:journeys:release` | 完整系统、PostgreSQL 与依赖审计；发布授权另按授权策略 |
| `npm run test:journeys:live -- <mode>` | 运行时传入隔离账号与样例，验证真实 UI、持久化及第三方服务；不得用于生产写入 |
| `npm run test:third-party -- --live` | 用合成样例统一实测 DeepSeek、豆包语音、火山视觉、阿里分割和 OSS；按既有费用/数据授权并加载受保护凭据 |
| `npm run test:system` | 按后端 → 前端顺序执行功能稳定性系统测试 |

## 候选与回执

每份有效回执绑定适用候选、命令/行为、目的、时间、环境/fixture、结果、限制和原始证据引用。提交、tree 或文件哈希按[控制面协议](coordination-control-plane.md)记录对象类型/路径与六位简称；Git/协议内部完整对象标识不截断。未提交候选需可重建的隔离视图或 manifest，不能只报 HEAD 或若干入口文件。

运行前后核对候选视图；过程中漂移则不能将结果签给原候选。构建、审查和部署的对象必须对应同一有效候选，复用条件与失败状态只按影响矩阵裁定。

## 资源与副作用

默认回归使用临时目录、本地端口、替身和隔离浏览器 profile；不连接生产或付费服务。获准 live 的调用使用[统一费用授权](release-authorization-policy.md#上线前付费验收持续授权)，不在本文维护另一额度。

浏览器测试按现有入口串行；后端只有端口、目录、数据库和进程互不干扰时才可并行。记录本次占用资源并在成功/失败后清理，不要求另建永久资源账或重复报告。冻结候选的资源不供其他准备任务抢占。

固定历史日期的回归使用统一注入时钟覆盖业务、审计、用量和预算；测试时钟入口只能在测试环境启用，测试适配器不混入生产业务职责。

只为真实变化增加必要验证。优先复用现有专项和消费者；不为文案/注释规则另造测试，不以重复全量运行替代完整代码契约审查。
