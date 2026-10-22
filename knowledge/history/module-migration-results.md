# 历史模块迁移记录（v0.2.0–v0.5.8）

只读历史摘录：2026-10-17 从模块设计正文迁出。以下“当前”、门禁、路径和结论均指原记录时点，不作为现行状态或调度授权。当前入口见[模块设计](../modularization-design.md)。

当前已实施：

- `knowledge/module-boundaries.json` 登记首批模块、公开入口、拥有路由、测试和迁移例外。
- `npm run check:modules` 检查模块文件、公开入口、测试、跨模块深层导入、允许依赖、共享层反向依赖和循环依赖。
- `src/shared/persistence/` 接管 JSON repository，并提供业务 store、认证/会话、配置/秘密、用量/成本和附件清单的 PostgreSQL 映射、重建与整批事务迁移；S2 运行适配在同一公开入口实现。运行数据角色与认证角色分离，注册通过仅允许新建账户的数据库函数在认证事务内初始化；账户锁跨多次 commit 保留，读取使用一致快照。映射命令与验证状态见 [`postgres-migration.md`](../postgres-migration.md)。
- `src/modules/thoughts/` 接管思绪根链、内容块、保留状态、备注、追问、版本检查和回答落盘；`src/app/thought-workflows.mjs` 负责创建链/任务原子事务、草稿/引子及前台回答编排，`src/http/thoughts.mjs` 统一适配旧 API 和 v1 思绪纵向样板。`server.mjs` 仍是其他领域的显式迁移例外。
- `src/modules/health/` 接管睡眠、心率、体重/体成分与运动记录载荷、CRUD，以及体重/运动识别字段、空值归一化、识别提示和摘要；`profile.mjs` 与 `records.mjs` 通过公开 `index.mjs` 导出，内部无循环依赖，不依赖 HTTP、存储或 AI SDK。`src/modules/checkins/` 接管此刻状态载荷和 CRUD；两者的 HTTP 适配分别位于 `http/health-records` 与 `http/checkins`，附件和模型装配仍由 `server.mjs` 负责。
- S3 首段已拆出：`src/modules/auth/` 拥有注册、密码和会话生命周期，注入认证 repository 与账户初始化，不接收 HTTP 对象；`src/http/` 拥有 JSON、Cookie、认证路由与请求身份绑定；认证文件适配归 `shared/persistence`，账户初始化由应用装配。前端 `frontend/api` 统一请求、SSE 与附件读取，`frontend/session` 拥有请求取消与会话代次，`frontend/state` 拥有账户快照、刷新合并、订阅与过期响应拒收；S3-12 已进一步将根入口、页面路由和页面副作用迁入对应前端模块。
- S3 第二段已拆出：`annotations` 拥有批注创建、回复、可见文本锚点、漂流与模型对话保存；`tasks` 拥有幂等创建、单一重试后继、领取、终态和恢复规则；`notifications` 拥有任务通知投影、已读与未读计数。`app` 负责跨领域资源解析与后台 AI 事务编排，领域只接收所属记录或集合，不自行查询其他领域。结果校验、领域结果保存、任务终态与通知在同一次 repository 更新中完成；调度上下文由启动装配注入。Markdown 可见文本归 `shared/content`，通用文本截断与版本归一化归 `shared/validation`。两套批注 URL 共用 `http/annotations`；思绪结果保存归 thoughts。通用 AI 供应商、前台生成、全量思绪 CRUD 和其他领域仍待迁移，不能把本段描述为整条 AI 链路完成。
- S3 第三段已拆出删除恢复与持久附件清理：`trash` 拥有条目/期限/清单，`app` 协调恢复版本与批注回附，`shared/attachments` 拥有引用收集和清理队列，`http/trash` 接管四条路由。批注任务绑定根记录版本，整记录恢复推进版本；正文、创建/发生时间与附件引用保留。相关 JSON 与真实 PostgreSQL 专项均已通过。
- S3 附件段已拆出上传校验、账户配额串行化、临时图片、存储适配和启动清单核验；统一入口为 `shared/attachments/index.mjs`，根目录旧适配文件已删除。`http/attachments` 接管上传和认证后的 GET/HEAD，账户与模拟模式的上游回退由装配入口注入。截图识别的领域规则、AI 供应商和前端媒体交互继续迁移；真实 PostgreSQL 清单、失败恢复与重启已验收。
- S3 配置与日志段已拆出：`config` 统一应用运行环境快照；`shared/observability` 拥有异步上下文、私有日志、脱敏与提交后摘要；`http/request` 拥有追踪 ID、base path、错误和完成审计。附件适配与迁移/导出脚本显式传入配置，根日志文件已删除；AI 调用内容与终态规则继续在下一段迁移。
- V0.5.8 B2 已将本地测试 control/workspace、GET-only 上游水合和账户初始化/启动恢复迁入 `app`，将隔离会话、Cookie 改写和本地测试路由迁入 `http`；workspace reset 使用 staging 与 JSON repository 独占换目录，hydrate 使用 commit 后 pending-control 恢复。JSON 与 PostgreSQL 认证 adapter 均执行提交后审计，注册失败只回收未持久账户目录。`server.mjs` 同批删除旧实现并降至 2295 行；本地专项和 backend 通过，真实 PostgreSQL 16 因当前机器缺少可执行文件待后续环境复核。
- V0.5.8 B3 已以 `createAiRuntime()` 统一 DeepSeek provider/gate、账户 settings/usage/cost、站点 budget、调用审计、generator 与审计恢复，Owner 设置继承通过 auth 后置 reader 注入；`server.mjs` 删除旧装配并降至 2120 行。完整 backend 82/82 通过，独立复审 blocker/P0/P1 为 0/0/0。Owner 于 2026-10-06 重申服务入口只负责启动，硬上限 100 行；项目继续执行更严格的 `server.mjs <= 40` 与显式组合根目标。
- V0.5.8 B4 已以 `createMediaRuntime()` 统一附件上传/清理、媒体 provider gate、健康/书目识别、ASR 派生、TTS cache/sweep 与小物媒体装配；内部按 attachments、uploads、vision、ASR、speech、providers 分责，复用既有领域和基础设施实现。`server.mjs` 删除旧实现并降至 1473 行，provider 入口例外归零；完整 backend 83/83 通过，独立复审 blocker/P0/P1 为 0/0/0。后台任务入队/去重留在 B5，最终入口 `<=40` 目标不变。
- V0.5.8 B5 已以 `createContentRuntime()` 统一内容记录 repository 适配、批注/回收、内容附件、媒体子运行时、后台任务、ASR 入队、thought/capture/journal/review/chat 工作流、用户模型提取和个人语境投影；内部拆分为 `content/resources.mjs`、`content/background.mjs` 与 `content/workflows.mjs`，避免把热点平移到单一组合文件。`server.mjs` 删除旧装配并降至 1162 行；`check`、B5 影响门和完整 backend 83/83 通过，独立复审 blocker/P0/P1 为 0/0/0。后续 backend runner 已纳入 content runtime 专项，当前阶段数为 84；下一步 B6 迁出 owner/statistics/admin/legacy HTTP 编排，最终入口 `<=40` 目标不变。
- V0.5.8 B6 已将统计日志适配、平台 admin 快照鉴权、上游代理、Owner 路由、legacy API 顺序和 V1 显式注册表迁入 `src/app`/`src/http`。平台凭据与 loopback、账户权限、body 上限、Cookie/响应头、流式背压及路由顺序保持不变；未引入动态扫描或隐式自注册。`server.mjs` 删除旧实现并由 1162 行降至 1048 行，API 字面量例外由 25 降至 7；`check`、影响门和完整 backend 90/90 通过，独立复审 blocker/P0/P1 为 0/0/0。下一步 B7 建立 `createHttpApplication()` 与 `createServerRuntime()`，删除 server 迁移例外并达到 `<=40`。
- V0.5.8 B7 已建立 `createServerRuntime()`、`createHttpApplication()` 和
  `start/ready/stop` 生命周期。配置/持久化 foundation、账户/auth/local-test、
  平台与内容 HTTP adapter、显式 registry、静态资源和 scheduler 按职责拆分，
  所有新增生产文件均小于 500 行；未使用目录扫描、隐式自注册或运行时双轨。
  `server.mjs` 由 1048 行降至 4 行，9 条 server 例外归零，
  `check:entrypoints:g4` 和完整 system `416224 ms` 通过，独立复审
  blocker/P0/P1 为 0/0/0。2026-10-06 使用显式 PostgreSQL 16.14 工具路径
  与临时 ad-hoc 签名 Node 重跑 stable 三段通过，G4 已关闭。
- V0.5.8 F4.2 已建立 `frontend.feature.health`，由 daily 路由显式加载
  controller、草稿 lifecycle 与 view；OCR/上传和提交 adapter 再按用户动作
  加载。账户/日期隔离、直接 daily 冷启、重复 mount、迟到结果、上传租约
  补偿和批量体重恢复均有反例；`runtime.mjs` 由 4962 行降至 4663 行，
  首页隐藏 health 请求为 0。
- S3 AI 已拆出：`ai` 拥有设置归一化、场景选择、用量/单价快照、成本模拟/统计、额度预留、通用 SP/场景约束及调用/重试审计；`shared/persistence` 接管账户文档队列、备份和运行适配，HTTP 接管设置/成本接口。修复 JSON 并发设置覆盖。DeepSeek HTTP/SSE 与图片编码归 `infrastructure/ai-providers`；业务上下文继续迁移。
- P00 提示词目录已接入：60 个系统提示、场景约束、业务任务和模型可见模板归 `prompts/versions/`；当前激活 `2026.10.02.2` 并保留此前版本。`infrastructure/prompt-catalog` 负责文件与摘要校验，`shared/prompts` 提供不可变运行快照和严格渲染；版本可独立固定，AI 审计记录版本与摘要，代码不保留提示词正文。五问候选提取场景只记录调用元数据与字符数，不在审计日志保存用户原文或完整 Prompt。
- S3-08 思绪链已收口：整套思绪创建/编辑、内容块、状态、备注、追问、草稿、引子及前台流式回答均经同一领域/应用服务实现；删除继续调用回收事务。旧 URL 仅保留协议适配，不再在入口复制业务逻辑。
- S3-09 v1 公共内核已冻结为 `1.0.0`：`http/api-v1` 提供统一包络、游标、ETag/If-Match、Idempotency-Key、TraceID 和模块注册，`http/openapi-v1` 提供根 OpenAPI；思绪链列表/详情/创建/修改/删除/流式回答作为首个纵向样板。契约专项覆盖 base path、认证、错误、重复请求、版本冲突、恢复与账户隔离。
- S3-10 已完成 G1 后三路纯重构及串行集成：B1 迁出 `checkins/health` 记录服务与 HTTP，B2 迁出前端 `content/time/media` 无业务共享能力，B3 将思绪 OpenAPI 路径/schema 拆为领域分片；集成负责人按 B1 → B2 → B3 修改公共入口、模块登记和系统测试。当前门禁为 31 个模块、72 条路由，完整系统 36 阶段通过（137115 ms）；产品功能并行仍由 G2 阻断。
- S3-11 已将状态与健康记录扩展为思绪后的两条完整 v1 纵向链：列表/详情、幂等创建、ETag/If-Match 条件更新与删除、账户隔离及旧接口复用同一服务；根 OpenAPI 机械组合 `openapi/records` 分片。重复请求未显式提供发生时间时，幂等摘要排除服务端生成时间，确保重试稳定。
- S3-12 已将 `public/app.js` 收缩为启动入口，将浏览器运行时迁入 `frontend/app`，20 个视图与组别映射进入 `frontend/pages`，进入/离开页面的按需加载、溢出与动画副作用进入 `frontend/features`；根 `styles.css` 只加载模块样式。模块门禁为 34 个模块、82 条路由，完整系统 38 阶段通过（165661 ms）。
- G2 A-D 已通过四个隔离工作树交付并由主线完成 I 串行集成：`discovery` 提供检索/新鲜回访，`exports` 提供隐私默认关闭的跨体裁导出，`actions` 提供行动/习惯/打卡，`feedback` 提供产品反馈与证据化验证台账。Store 升至 v15，OpenAPI 新增 G2 分片，前端增加寻迹、导出、反馈三个视图及今日行动工作区。模块门禁为 42 个模块、116 条路由，完整系统 43 阶段通过（151709 ms）。
- G2 R2/R3 追加收口：捕念/日记、书间/拾句、共参/复盘/统计与内容附件已迁入独立领域和 HTTP 分片；跨体裁图片原文通过统一后台任务生成非破坏性理解结果，正文与图片差异在同一 repository 事务中进入回收记录。当前模块门禁为 50 个模块、201 条拥有路由，OpenAPI 为 60 条路径、104 个操作，`migrationExceptions` 为空。
- S3 小物已拆出：阿里云 SDK/轮询/PNG 下载与错误投影归 `infrastructure/ai-providers`，小物校验/归一化/创建/编辑/临时图片流程归 `keepsakes`，四条路由归 HTTP，删除调用应用回收事务；共享附件提供图片读取/摘要，`shared/concurrency` 提供独立于业务的限流队列。`shared/time` 继续接管严格日期和发生时间解析，版本相关迁移仍在原处。差分、完整系统和真实 PostgreSQL 专项通过；未调用真实供应商。
