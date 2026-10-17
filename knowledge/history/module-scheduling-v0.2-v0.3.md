# 历史模块调度与冻结（v0.2.0–v0.3.0）

只读历史摘录：2026-10-17 从模块设计正文迁出。以下分支、工作树、并行数量、审批及冻结规则仅用于追溯当时决定，不得用于当前任务。当前规则见[模块设计](../modularization-design.md)。原记录内容未改写。

## 11. v0.2.0 串行底座与并行准入

2026-09-28 用户将完整 PostgreSQL、模块化、v1 契约及行动/习惯、附件导出、小物优化、反馈和小圈验证提升为本轮 P0，并要求底座先串行、独立功能后并行。本节是开发调度约束的单一事实来源；优先级和状态在 `README-TODO.md` 维护。

2026-09-29 优先级调整：小圈验证由原 P0-22 移至 P2-09，v0.2.0 不开展真实招募、试用、反馈收集或补偿；已经完成的验证台账底座和此前并行开发记录继续保留。该调整不回写或合并覆盖上面的历史决策。

### 串行主链

`S0 基线 → S1 全领域映射 → S2 PostgreSQL 运行与恢复 → S3 高耦合主链 → G1 接口冻结 → S3 独立重构并行 → S3 串行集成 → G2 正式冻结 → P 功能并行 → I 串行集成 → R 发布切换`

- S0：登记当前工作区与生产 v0.1.1 差异，保留热修与所有已有改动；本地可创建开发分支/工作树，发布提交按工程规则执行。
- S1：逐项映射业务集合、嵌套内容、回收站、任务/通知、认证/会话、配置、用量和附件引用；未知字段必须保留或拒绝，不能静默丢失。完整快照仅作迁移证据，不能冒充关系映射完成。
- S1 本地映射演练已覆盖业务 `store.json`、独立文件、附件实物与第二数据库恢复；生产源数据和 OSS 在发布停写窗口重新核验。S2 已移除早期思绪核对投影，业务只使用正式关系表；S1/S2 通过不开放并行准入。
- S2：实现 PostgreSQL repository，使用非 superuser、非 BYPASSRLS、非表 owner 的运行角色验证跨账户隔离；验证单事务、并发、断连回滚、重启和导出恢复。先在本地隔离环境切换并核对唯一写源。
- S2 当前限制：每数据库单应用实例，账户级兼容 repository；数据库应用锁与目录标记阻止双实例和旧 JSON 回切。运行角色、原子注册、附件状态及停写导出契约见 `postgres-migration.md`。后侧工作树若运行 PostgreSQL，必须使用独立数据库，不能只换端口和目录。
- S3 前段：单一负责人迁移 `auth/storage/session`、`thoughts/annotations/ai/tasks/notifications`、`trash/attachments/restore` 等高耦合链路，并完成思绪链与 v1 公共错误、分页、版本、幂等和路由注册。
- G1：思绪领域服务和 v1 公共内核验收冻结后，可启动最多三条“纯重构”支线：后端叶子领域、前端无业务共享能力、领域 OpenAPI 分片与专项测试。G1 不开放任何新增产品功能。
- G1 后各支线不得修改 `server.mjs`、`public/app.js`、根 OpenAPI、模块登记、依赖锁或全局 CSS；这些共享文件仍由集成负责人逐批串行接入。发现公共契约缺口时支线停止，回到主线修订并重新冻结。
- G2：S1-S3 的验收证据全部通过，迁移例外清零，schema、OpenAPI、前端 API/状态和公共入口冻结，任务依赖及允许写入目录明确，才可启动后侧产品功能编码并行。此前不得提前建立另一套存储/API。
- 用户于 2026-09-29 指定提前实现体重/运动截图识别（P0-11 扩展）：由集成负责人串行接入现有健康、附件和模型链路，共享文件仍由同一负责人维护。这不关闭 S1-S3/G，也不启动其他功能并行。
- I/R：按依赖逐个集成，各次集成都跑受影响的跨模块回归；最终冻结候选、双轮发布审计并按授权切生产数据库。功能分支不持有生产密钥。

### 后侧功能分工

| 工作流 | 范围 | 开工所需契约 | 所有权 |
| --- | --- | --- | --- |
| A 思绪与检索 | 搜索、新鲜回访、后台结果、批注操作 | 内容版本、任务通知、检索分页和前端增量更新 | 思绪与检索模块；不改任务底座 |
| B 附件与媒体 | P00 图片原文、附件导出、小物上传/存储、运动截图 | 附件引用/保留/清理、记录图片 schema、识别任务 | 附件媒体模块；内部先图片引用再小物/运动，避免多人改同一上传链 |
| C 行动与习惯 | Todo、习惯、打卡及来源关联 | 通用对象版本、软删除、来源引用和幂等 | 独立 actions/habits 模块 |
| D 产品反馈与验证 | 反馈入口、同意/退出流程、验证记录 | 会话、版本、反馈 schema、导出入口 | 独立 feedback 模块；仅保留已完成台账底座，真实小圈执行属于 P2-09 |

首屏壳、导航、全局输入/时间和设置由集成负责人依次处理；其余工作流通过模块挂载契约交付，不共同编辑壳文件。

### 每个并行任务必须具备

1. 基线 tree/提交与契约版本、负责人、对应 TODO ID。
2. 独立分支/工作树、端口、数据目录；无生产凭据、无真实供应商默认调用。
3. 允许修改的目录、公共入口、禁止修改的共享文件及消费者列表。
4. 可验证的完成条件、成功/失败/隔离/删除恢复测试及集成顺序。
5. schema、OpenAPI、依赖锁、模块登记、启动入口和全局 CSS 由唯一集成负责人维护。共享契约新增需求先返回串行主链，禁止分支私改或长期兼容两套规则。
6. 默认最多 4 个编码工作流；依赖未就绪时停在该门前，不以目录不同认定可独立并行。
7. 功能开发只跑稳定性测试；`test:load` 只在容量评估或明确要求时执行。候选冻结后停止所有并行写入。

### 数据库切换语义

数据库是本轮正式交付目标。本地单写切换是并行准入证据，生产切换在发布阶段执行。切换前 JSON 是恢复点；数据库开始接收正式新写入后，默认前滚修复，回退必须先将新数据一致导出并核验，禁止直接启用旧 JSON。API 能连接数据库、建表成功或 mock 测试通过均不能单独证明切换完成。

## 12. G1 冻结契约

G1 于 2026-09-29 在当前工作区完成技术冻结，契约版本为 `API v1 1.0.0`。运行定义以 `src/http/openapi-v1.mjs`、`src/http/api-v1.mjs`、`src/modules/thoughts/index.mjs`、`src/app/thought-workflows.mjs` 和 `knowledge/module-boundaries.json` 为准。

- 成功响应固定为 `{ data, error: null, meta: { traceId, ... } }`；失败响应固定为 `{ data: null, error: { code, message, details? }, meta: { traceId } }`。
- 每个 HTTP 响应继续返回 `X-Request-Id`；合法客户端值透传，不合法或缺失时由服务端生成。
- 列表使用不透明 `cursor` 和有上限的 `limit`，下一页游标只出现在 `meta.nextCursor`；客户端不得解析游标内容。
- 单资源读取返回表示正整数版本的 `ETag`。条件更新/删除必须原样回传 `If-Match`；缺失为 `428 PRECONDITION_REQUIRED`，过期为 `412 PRECONDITION_FAILED`。
- 幂等创建和模型写操作必须提供 `Idempotency-Key`；同键同载荷复用结果，同键不同载荷返回 `409 IDEMPOTENCY_KEY_REUSED`。
- OpenAPI 根位于 `/api/v1/openapi.json`；G1 冻结思绪链列表、详情、创建、更新、删除和流式回答，S3-11 新增状态与健康记录的列表、详情、创建、更新和删除。旧 `/api/*` 与 v1 调用同一领域/应用服务，生产前端迁移完成前不得删除旧路由。
- v1 公共包络、错误码、游标格式、版本语义、幂等语义和根 OpenAPI 只能由集成负责人修改；支线只能提交领域分片和测试夹具。任何破坏性修改必须提升契约版本并重新经过 G1。

冻结的服务面：

- `createThoughtService`：`createChainInStore`、`updateChainInStore`、`saveGeneratedAnswerInStore`、`getChain`、`listChains`，以及既有块/备注/追问/状态命令。
- `createThoughtWorkflows`：`createChain`、`updateChain`、`removeChain`、`getChain`、`listChains`、`createDraft`、`createStarter`、`answerRoot`。
- `createApiV1Http`：`register`、`handle`、`success`、`error`、`pagination`、`nextCursor`、`expectedVersion`、`idempotencyKey` 与统一包络生成。
- `createThoughtHttp`：`handle` 保持旧 `/api/*` 兼容，`handleV1` 作为 v1 模块挂载点；后续领域沿用相同注册方式。

### G1 后三路启动单

当前分支为 `explore/nightly-p3-20260928`，当前 HEAD 仍为 `d33a53e7f173b8af9898b854e3ef415171d9db8b`，G1 与 S3-10 实现仍在未提交工作区。用户明确要求启动并行后，三路从同一 HEAD 创建独立分支/工作树，并同步同一份 G1 工作区基线；各路只修改允许目录，产物未在支线提交，由集成负责人审查后按 B1 → B2 → B3 接入主工作区。

| 路线 | 分支 / 工作树 | 端口 / 数据 / 数据库 | 实际交付 | 禁止修改 |
| --- | --- | --- | --- | --- |
| B1 后端叶子领域 | `refactor/v020-b1-backend` / `/private/tmp/for-now-v020-b1` | `4181` / `data/worktrees/b1` / `for_now_v020_b1` | `checkins/health` 记录服务、HTTP 适配和专项 | `server.mjs`、`public/app.js`、根 OpenAPI、模块登记、锁文件、全局 CSS |
| B2 前端共享能力 | `refactor/v020-b2-frontend-shared` / `/private/tmp/for-now-v020-b2` | `4182` / `data/worktrees/b2` / 不启用 PostgreSQL | `frontend/content`、`time`、`media` 和专项 | 页面壳、`public/app.js`、HTML/CSS、后端 schema/OpenAPI、锁文件 |
| B3 契约分片与专项 | `refactor/v020-b3-contract-tests` / `/private/tmp/for-now-v020-b3` | `4183` / `data/worktrees/b3` / `for_now_v020_b3` | 思绪 OpenAPI 分片和引用/运行覆盖专项 | 根 OpenAPI、公共错误/游标实现、服务入口、模块登记、锁文件、全局 CSS |

三路工作树、分支和隔离资源已创建；未启动真实供应商或生产连接。集成后 `npm run check`、三组新增专项、`npm test` 与 `npm run test:system` 均通过；本轮未改持久化/schema，`npm run test:postgres` 单次复验仍在业务断言前命中已知 macOS 启动错误，继续引用同日 40 项真实数据库基线。机器可读证据见 `docs/versions/v0.2.0/evidence/s3-10-integration.json`。G1 只允许纯重构，产品功能 A-D 仍由 G2 阻断。

## 13. G2 功能轮与 I 串行集成

用户于 2026-09-29 明确启动 G2 功能轮。A-D 从同一未提交主工作区基线建立独立分支与 `/private/tmp/for-now-v020-g2-*` 工作树，支线不修改公共入口；主线按 A → B → C → D 顺序审查，再统一接入 Store v15、HTTP、OpenAPI、模块登记、页面结构与样式。

| 路线 | 分支 / 工作树 | 已集成交付 |
| --- | --- | --- |
| A 思绪与检索 | `feature/v020-g2-a-search` / `/private/tmp/for-now-v020-g2-a` | 思绪正文/标签及类型筛选、来源标识、稳定游标、新鲜/未留痕、已读、免打扰与任意门 |
| B 附件与导出 | `feature/v020-g2-b-attachments` / `/private/tmp/for-now-v020-g2-b` | 跨体裁资源、附件引用、共享/缺失/未引用状态，确定性 JSON/Markdown 及默认秘密/推理排除 |
| C 行动与习惯 | `feature/v020-g2-c-actions` / `/private/tmp/for-now-v020-g2-c` | 行动优先级/来源/完成撤销，习惯频次/启停/调整/自然日打卡，幂等创建和父子回收恢复 |
| D 反馈与验证 | `feature/v020-g2-d-feedback` / `/private/tmp/for-now-v020-g2-d` | 主动上下文授权的反馈、状态流转，以及同意/退出、补偿/奖励和真实参与证据台账 |

I 集成后 `/api/v1` 共 32 条 OpenAPI 路径、51 个操作，前端共 23 个视图。`npm run test:system` 43/43 阶段通过，且没有运行容量压测、真实 AI/分割供应商、commit、push 或部署。因本轮新增 PostgreSQL 对象与关系映射，旧 40 项数据库基线不能替代复验；当前环境的单次 `npm run test:postgres` 在业务断言前失败，错误为 `postmaster became multithreaded during startup`。因此 I 本地集成通过，但 G2 正式关闭仍待获准本机环境的真实 PostgreSQL 复验。机器证据见 `../docs/versions/v0.2.0/evidence/g2-i-integration.json`。

## 14. V0.3.0 串并行开发入口

V0.3.0 不复用上述 G2 的长期未提交工作树。当前调度、任务编号、`v0.2.x`
功能批次、最多两条实现线并行和串行合入规则统一见
[`docs/versions/v0.3.0/README.md`](../../docs/versions/v0.3.0/README.md)。

本阶段继续遵守模块边界和影响矩阵，但工作树生命周期改为：

1. 从已提交的 `main` 基线创建一个任务分支。
2. 只有任务确需并行时才创建独立工作树。
3. 一个工作树只承载一个任务和一个明确所有权范围。
4. 每个可验收切片先形成本地提交，再进入串行集成。
5. 合并后记录提交和验证，确认工作树干净后用 `git worktree remove` 退出。

任何共享契约、schema、模块登记、根入口、全局样式或依赖锁仍由单一集成
负责人修改；支线发现公共缺口时返回串行主链，不在多个分支分别演化。
