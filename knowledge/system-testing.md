# 系统测试

本文档是本项目后端、压测和前端系统测试范围、命令与维护规则的单一事实来源。测试默认只使用临时目录、本地端口、模拟供应商和浏览器隔离 profile，不连接生产数据或产生真实模型、OSS、图片分割费用。

## 统一入口

| 命令 | 范围 |
| --- | --- |
| `npm run check:modules` | 前后端模块登记/语法、公开入口、允许依赖、静态及字面量动态深层导入、循环依赖、前端请求入口、运行配置入口和迁移例外 |
| `npm run test:commit-gate` | 本地 `feat` 自动提交的隔离候选、允许/拒绝边界、门禁自身完整性、测试失败和暂存 tree 漂移 |
| `npm run test:backend` | 语法、API/数据、认证、本地测试隔离、服务器路径、可观测性、附件、边界、监控、恢复、部署回滚 |
| `npm run test:api-v1` | v1 公共包络、OpenAPI、认证、base path、思绪/状态/健康纵向链、游标、ETag/If-Match、幂等、SSE、删除恢复和账户隔离 |
| `npm run test:openapi` | 思绪 OpenAPI 分片、根文档组合、引用闭合、运行路由覆盖和写入请求头 |
| `npm run test:records` | 此刻状态与每日健康记录的载荷、CRUD、HTTP 兼容、账户隔离和失败提交 |
| `npm run test:records-v1` | 状态与健康记录 v1 的游标列表、详情、幂等创建、条件更新/删除、账户隔离和 OpenAPI 组合 |
| `npm run test:g2` | 思绪检索/回访、跨体裁导出、行动/习惯、反馈/验证及统一 HTTP/持久化集成 |
| `npm run test:keepsake-media` | 小物媒体事务、WebP 派生规格、批量失败补偿与上传响应契约 |
| `npm run test:frontend-shared` | 前端内容安全/Markdown/LaTeX、本地时区边界和图片数量/MIME/大小校验 |
| `npm run test:frontend-shell` | 浏览器 JS/CSS 薄入口、23 个视图注册、页面切换和 feature 生命周期副作用 |
| `npm run test:persistence` | JSON repository、业务及身份/配置/用量/附件映射与构思领域服务 |
| `npm run test:postgres` | 临时真实 PostgreSQL：Store v15 全领域关系重建、RLS/认证授权、整批导入、失败回滚、第二数据库恢复，以及生命周期/幂等账本的跨进程与重启；数据库改动的额外必跑门禁 |
| `npm run test:local-mode` | 本地模拟/冷启切换、线上只读边界与工作区隔离 |
| `npm run test:load` | 独立容量评估：并发读、并发写、混合流量、持久 AI 任务队列 |
| `npm run test:frontend` | API/会话/状态契约、生产候选的桌面、响应式 UI 与移动平台模拟 |
| `npm run test:explore` | P1-P3 本地探索页隔离，仅在探索分支运行，不进入生产发布门禁 |
| `npm run test:system` | 按后端 → 前端顺序执行功能稳定性系统测试 |

功能开发阶段不执行压测，`test:load` 不属于 `test:system` 默认链路，只在容量评估、扩容决策或用户明确要求时单独运行。`test:system` 串行执行浏览器用例，避免多个 Chromium 进程同时清理临时 Session Storage。真实外部服务冒烟 `test:oss`、`test:aliyun` 也不属于默认系统测试，必须在明确授权且配置受控凭据后单独执行。

## 后端测试

| 测试文件 | 主要覆盖 |
| --- | --- |
| `scripts/check-modules.mjs` | 模块清单、公开入口、测试、依赖方向、深层导入、循环依赖和路由归属 |
| `scripts/commit-gate-regression.mjs` | 隔离暂存候选、精确本地提交、受保护分支、高风险/治理面、同路径未暂存内容、测试失败、门禁完整性和 tree 漂移拒绝 |
| `scripts/runtime-infrastructure-regression.mjs` | 环境默认/上下限与旧额度兼容、不可变配置快照、测试模式限制、并发账户/后台上下文、追踪 ID、base path、SSE/断连、脱敏权限与保留边界 |
| `scripts/persistence-regression.mjs` | JSON 串行提交、业务 store 各领域/嵌套对象映射、附件与任务引用、原文/顺序重建、损坏数据拒绝 |
| `scripts/postgres-integration.mjs` | 真 PostgreSQL 的非 owner RLS、多账户、父外键、并发重复导入、快照覆盖保护、中途/断连回滚、同数量内容篡改拦截、关系导出恢复 |
| `scripts/document-migration-regression.mjs` / `scripts/postgres-bundle-checks.mjs` | 独立文档无损映射、秘密分区、账户/会话/场景重复与孤儿拒绝、附件实物与缺失检查、源漂移、完整批次回滚及第二数据库恢复 |
| `scripts/thought-service-regression.mjs` | 构思服务的根链/内容块、链投影、版本冲突、回答落盘、批注重定位、备注、追问和状态更新 |
| `scripts/api-v1-contract-regression.mjs` | v1 `data/error/meta`、TraceID、OpenAPI、base path、认证、游标分页、ETag/If-Match、Idempotency-Key、SSE、旧接口共用数据、恢复与账户隔离 |
| `scripts/api-v1-openapi-fragment-regression.mjs` | 思绪领域 OpenAPI 分片的路径/操作、引用闭合、运行路由覆盖及 If-Match/Idempotency-Key |
| `scripts/record-v1-regression.mjs` | 状态/健康 v1 运行处理器、幂等重试、服务端默认时间、游标、ETag、条件删除、账户隔离和 OpenAPI 分片组合 |
| `scripts/g2-discovery-regression.mjs` | 思绪搜索/类型筛选、来源身份、稳定游标、新鲜/未留痕、已读/免打扰、任意门、账户隔离和失败提交 |
| `scripts/g2-export-regression.mjs` | 跨体裁正文与附件引用、共享/缺失/未引用附件、确定性 JSON/Markdown、秘密与模型推理默认排除 |
| `scripts/g2-actions-regression.mjs` | 行动/习惯/打卡载荷、持久幂等、版本、状态历史、来源、自然日去重、回收定位、账户隔离和失败提交 |
| `scripts/g2-feedback-regression.mjs` | 反馈上下文授权、幂等、状态流转、验证同意/退出、补偿/奖励、参与证据、账户隔离和失败提交 |
| `scripts/g2-integration-regression.mjs` | G2 OpenAPI、真实 HTTP、账户隔离、ETag、级联回收恢复、导出覆盖与隐私默认值 |
| `scripts/checkin-health-regression.mjs` | 状态/健康记录载荷、时间和版本、原始元数据、CRUD/HTTP、仓储账户隔离、回收委派及提交失败 |
| `scripts/ai-domain-regression.mjs` | 旧模型设置、并发账户设置/成本独立保存、整份替换兼容、自然日与统计、写前归一化失败、备份权限、价格快照/未知用量、额度释放/隔离、账本与审计独立故障；运行适配回滚用接口桩，真实 PG 另验 |
| `scripts/ai-provider-regression.mjs` | DeepSeek JSON/SSE、逐字节 UTF-8/CRLF 拆包、断流/过滤/截断/供应商错误的部分输出、空正文重试次数与额度、容量失败释放、超时、并发账户、图片 Flash 参数与私有摘要 |
| `scripts/segmentation-regression.mjs` | 阿里云 SDK 无重试、同步/异步结果、失败状态/轮询超时、PNG 下载大小/格式/超时、调用组及账户审计、审计失败不重放、限流/在途/上传失败释放、临时图片清理与异步绑定；均为本地替身 |
| `scripts/keepsake-time-regression.mjs` | 小物载荷/旧记录/扩展保留、局部更新兼容、账户集合隔离与失败提交；UTC/上海/纽约、夏令时、本地日/时分合成、严格日期及旧发生日期解析 |
| `scripts/prompt-catalog-regression.mjs` | 提示词目录版本选择、SHA-256、必需 ID、占位符契约、提示词正文与代码分离 |
| `scripts/collaboration-regression.mjs` | 可见文本/重复引文、漂流保留、两套批注 URL、任务结果/通知原子提交、失败回滚、并发幂等/重试、迟到拒写、重启与跨账户同 ID 任务 |
| `scripts/trash-regression.mjs` | 整记录/嵌套恢复版本、批注与漂流回附、父记录缺失/冲突、二次确认与清单变化、共享附件保留、两次提交失败、清理重试和调度账户隔离 |
| `scripts/regression.mjs` | JSON 迁移、CRUD、回收站、异步绑定、幂等、版本竞态、AI 任务与附件清理 |
| `scripts/auth-regression.mjs` | 注册登录、Cookie、CSRF、账户隔离、base path、附件 GET/HEAD/私有缓存/越权、三类任务重启恢复 |
| `scripts/local-test-mode-regression.mjs` | 线上只读快照、主账户约束、本地写隔离、冷启重置、附件回退和上游写入拒绝 |
| `scripts/observability-regression.mjs` | AI 审计、用量、错误分类、脱敏、日志权限、损坏文件保护；模型成功后账本或审计写失败不重复调用；日志故障期间业务提交和故障后审计恢复 |
| `scripts/attachment-storage-regression.mjs` | 本地与 mock OSS 的隔离、读写和用量；旧本地副本回退、云端与本地共同清理及失败重试 |
| `scripts/attachment-upload-regression.mjs` | 账户配额竞态、格式/总大小、临时文件、批量部分失败、清单预留/确认顺序、清理提交失败及启动核验；数据库清单用接口桩，真实事务另验 |
| `scripts/attachment-derivatives-regression.mjs` | 小物四类 WebP 派生的尺寸/质量/字节上限、EXIF 方向、元数据移除、批次持久化失败补偿及上传响应 |
| `scripts/persistence-ledger-postgres-regression.mjs` | 真 PostgreSQL 生命周期、幂等响应精确重放/冲突、永久清理后防重复、进程重启与跨进程序列化 |
| `scripts/boundaries-regression.mjs` | AI/分割限流、每日额度、请求体与附件额度 |
| `scripts/monitor-regression.mjs` | 服务、磁盘、备份、AI 连续失败、费用告警和恢复通知 |
| `scripts/restore-validation-regression.mjs` | 恢复数据解析、Store v15 全集合逐项数量/ID/内容摘要、附件引用、缺集合反向断言和临时认证会话 |
| `scripts/deploy-regression.mjs` | 候选构建、模块目录语法检查、双证书域名 Nginx 配置安装、依赖失败、健康失败、Nginx 失败和原子回滚 |

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
| `scripts/frontend-contract-regression.mjs` | base path、错误元数据、可选接口、迟到 JSON/图片拒收、SSE 分块/中断/会话失效、并发刷新域合并和账户清空 |
| `scripts/frontend-shared-regression.mjs` | 内容 HTML 安全、Markdown/LaTeX 等价、本地时区跨日，以及图片数量、MIME 和大小边界 |
| `scripts/frontend-shell-regression.mjs` | 根 JS/CSS 薄入口、23 个 HTML 视图登记一致、页面组切换、按需加载与离开页面清理 |
| `scripts/ui-regression.mjs` | 页面主流程、G2 行动/习惯与寻迹渲染、账户切换、输入保留、异步结果、通知跳转、桌面与响应式布局 |
| `scripts/mobile-platform-regression.mjs` | iPhone/Android UA、DPR、触控、横竖屏、动态视口、键盘、安全区和输入缩放 |
| `scripts/exploration-regression.mjs` | P1-P3 探索页交互、移动布局、本地命名空间和零生产 API/第三方请求；独立运行，不属于生产候选 |

`ui-regression.mjs` 默认自行启动临时静态服务器；只有验证指定部署实例时才传入 `APP_URL`。移动模拟基于 Chromium，不等同于真实 iOS WebKit、安装态 PWA、Android 真机或触觉验证。

探索页截图默认写入系统临时目录，避免普通回归污染 Git 工作区。只有确认需要更新视觉基准时，显式设置 `UPDATE_EXPLORATION_SCREENSHOTS=1`。

## 模块化重构专项

v0.2.0 起的模块化重构按 `knowledge/modularization-design.md` 执行，测试目标是证明“职责已移动，行为未变化”：

1. 开始迁移前冻结 API 响应、关键 DOM、生产数据快照兼容样本、桌面/移动截图和性能基线。
2. 每迁移一个模块，先运行该模块契约或行为测试，再运行命中跨模块影响矩阵的集成测试。
3. `npm run check:modules` 已检查前后端模块源文件归属及语法、公开入口、依赖方向、循环依赖、静态/字面量动态深层导入和路由归属；旧前端入口与新模块不得绕过 API 模块直接 fetch；`server.mjs` 和 `src/` 除 `config` 外不得直接读取环境变量。独立 CLI 的命令参数和测试运行环境不受该应用门禁约束。路由消费者与 CSS 作用域随对应模块迁移补齐。
4. 认证、时间、AI、任务、通知、回收站、附件和批注等高耦合链路必须保留端到端测试，不能只用模块单测替代。
5. 迁移期间允许的旧入口必须登记负责人、删除条件和测试；最终候选要求例外清零。
6. 全量模块化完成前后使用同一测试输入做差分核对；用户原文、ID、时间、版本、附件引用、AI 归属和错误码不得漂移。
7. 领域不得直接使用 fetch、文件/网络/子进程 I/O 或第三方 SDK；模块门禁检查直接导入及调用，外部能力由仓储/供应商接口注入。

## 真实 PostgreSQL 专项

修改映射、schema、导入或数据库 repository 时，除默认 `test:backend` 中的映射回归外，必须运行 `npm run test:postgres`。该命令是独立数据库环境门禁，不以 mock 通过代替，也不静默跳过缺失环境。

测试始终自行创建本机临时集群、随机端口和随机密码，仅监听 `127.0.0.1`；忽略 `DATABASE_URL`，不连接已有数据库。用管理角色建表，再用 `NOSUPERUSER / NOBYPASSRLS` 且不拥有表的角色导入。成功或失败后关闭集群、删除临时数据。它验证功能正确性，不是压测。

已有 PostgreSQL 时指定 `PG_TEST_BIN=/absolute/path/to/bin`。当前 macOS arm64 验证使用 PostgreSQL 16.14，二进制包固定为 `@embedded-postgres/darwin-arm64@16.14.0-beta.17`，只安装在被忽略的 `data/pg-integration-tools` 下，不加入应用依赖：

```bash
npm install --prefix data/pg-integration-tools --no-audit --no-fund @embedded-postgres/darwin-arm64@16.14.0-beta.17
npm run test:postgres
```

其他平台提供该平台的 PostgreSQL `bin` 目录即可；脚本要求 `postgres`、`initdb`、`pg_ctl` 可执行。普通 `test:system` 不自动下载或安装数据库。`postgres-runtime-checks.mjs` 由该专项执行，启动真实 HTTP 应用，覆盖原子注册、数据/认证角色分离、跨连接并发、断连回滚、多次 commit、设置、附件上传/清理/中断恢复、进程重启、目录与数据库单写保护、只读恢复角色导出和第二数据库启动。任务专项使用本地模拟模型验证并发创建、回答/任务/通知共同保存、批注对话、未读与账户隔离、只恢复 queued，以及新数据库恢复后终态不重放。生产全账户快照、真实 OSS、云端备份与正式切换需在发布阶段另验。

macOS 文件沙箱可能遗漏依赖包的 dylib 符号链接。若 `postgres --version` 报 `Library not loaded`，依据包内 `native/pg-symlinks.json` 修复该隔离安装目录：已有软链接可替换为清单指定源库的普通文件副本，再运行测试。仅操作忽略目录 `data/pg-integration-tools`；不得因此修改系统库或跳过真实数据库验证。

专项脚本为数据库子进程固定 `LC_ALL=C`、`LANG=C`、`TZ=UTC`，并在 macOS 上将现有相邻 `lib` 目录传入 `DYLD_LIBRARY_PATH`，兼容沙箱重定位二进制；启动失败输出 PostgreSQL 日志后再清理临时簇。

2026-09-29 当前结论：原有 EDB PostgreSQL 16.14 和未修改的 `scripts/postgres-integration.mjs` 已在 Codex 获准的本机执行环境完整通过（退出码 0），覆盖现有脚本全部断言，包括账户文档/成本并发隔离、版本化删除恢复、附件清理失败及重启、新数据库恢复。机器可读结果和三个测试脚本/数据库二进制 SHA-256 见 `reports/postgres-validation-2026-09-29.json`。真实数据库启动不再阻塞当前脚本验收；S3 其余工作与 G 准入按 `README-TODO.md` 执行。

同日 G1 复验中，当前受限执行环境内的 `npm run test:postgres` 与下述绝对 Node 命令均在业务断言前再次报 `postmaster became multithreaded during startup`。本段未修改 schema、映射或 repository，因此保留上述 40 项通过证据作为 S2 基线，不把本次环境失败记为业务回归通过；后续一旦修改持久化边界，仍须回到获准本机执行环境重跑。

S3-10 集成后又按约束单次执行 `npm run test:postgres`，仍在临时集群启动阶段命中相同错误，未进入业务断言。本轮只迁移状态/健康记录、前端无业务共享能力和 OpenAPI 分片，未修改 schema、映射或 repository；因此继续引用同日 40 项基线，但机器可读 S3-10 证据明确记为环境失败而非通过。S3-11/12 收口后再次单次复验，仍为相同的启动前环境失败；完整功能系统测试为 38/38 阶段通过（165661 ms）。

G2/I 集成将 Store 升至 v15，并新增行动、习惯、习惯打卡、反馈、验证台账对象及来源/父子关系映射，因此旧 40 项真实 PostgreSQL 基线不能替代本轮验收。2026-09-29 单次复验仍在任何业务断言前报 `postmaster became multithreaded during startup`，虽然 43/43 功能系统阶段通过，G2 正式门仍须在先前可用的获准本机环境重跑并取得新证据后才能关闭。详情见 `../reports/g2-i-integration-2026-09-29.json`。

G2 R3 又新增持久幂等账本、生命周期/tombstone 元数据和跨体裁图片原文任务关系。2026-09-29 分别执行 `npm run test:postgres` 与 `node scripts/persistence-ledger-postgres-regression.mjs`，两者仍在任何业务断言前由 PostgreSQL 16.14 报 `postmaster became multithreaded during startup`；脚本已固定 `LC_ALL=C`、`LANG=C`、`TZ=UTC`，追加 `OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES` 复跑仍失败。因此本轮 JSON、映射和功能系统证据可用于代码验收，但不能替代 P0-16/P0-26 的最新真实 PostgreSQL 运行证据。

2026-09-30 G2 R4 解阻：macOS 26.6.2 上的最小原生 C 进程在进入应用代码前即返回
`pthread_is_threaded_np()=1`，原嵌入式 PostgreSQL 和官方源码默认构建都会因此
触发同一保护。仅用于隔离本地测试时，使用官方 PostgreSQL 16.14 源码并在
configure 探测阶段声明该 API 不可用；不得把此构建用于生产。源码包
SHA-256 为 `f6d077142737920858ce958ccdb75c6ee137a63b5b0853c70693d401ac7e3471`：

```bash
curl -fsSL https://ftp.postgresql.org/pub/source/v16.14/postgresql-16.14.tar.bz2 -o /tmp/postgresql-16.14.tar.bz2
printf '%s  %s\n' \
  f6d077142737920858ce958ccdb75c6ee137a63b5b0853c70693d401ac7e3471 \
  /tmp/postgresql-16.14.tar.bz2 | shasum -a 256 -c -
tar -xjf /tmp/postgresql-16.14.tar.bz2 -C /tmp
cd /tmp/postgresql-16.14
ac_cv_func_pthread_is_threaded_np=no ./configure \
  --prefix=/tmp/for-now-postgresql-16.14 \
  --without-icu --without-readline --without-zlib
make -j8
make install
cd -
PG_TEST_BIN=/tmp/for-now-postgresql-16.14/bin npm run test:postgres
```

该路径实际通过 PostgreSQL 16.14 全门禁和独立持久幂等专项。主门禁现覆盖
Store v15 新领域、元数据顺序与扩展字段、JSON `null` 幂等响应、旧表从账户
快照精确升级、全量关系恢复对比、自动回答默认关闭、设置并发、治理中台
PostgreSQL 脱敏快照和小物派生路径；机器证据见
`../reports/g2-r4-postgres-2026-09-30.json`。生产仍必须
使用受支持的标准 PostgreSQL 构建，本地兼容构建不构成生产配置或切换证据。

复现命令（macOS Terminal 中运行，或在 Codex 中批准本机端口访问后执行）：

```bash
cd '/Users/bytedance/Documents/Codex/个人成长追踪'
/Users/bytedance/.local/share/node-v24.19.0/bin/node scripts/postgres-integration.mjs
```

使用 Node 绝对路径避免执行环境 PATH 未包含 Node；已有正常 PATH 时仍可 `npm run test:postgres`。测试自建临时数据库、随机密码和随机端口，结束后自动关闭并清理，不使用生产连接。除上述 macOS 26 本地兼容构建外，不得修改数据库保护检查或接入现有数据库。

历史诊断边界：此前 Trae 执行环境中的多线程退出已由 `data/s3-postgres-clean-process-retry.log` 等日志确认；固定 locale、显式 arm64、清理残留项目进程均未解决。此次 Codex 默认沙箱先报 `listen EPERM 127.0.0.1`，获准执行后原测试成功。两种错误不能混为一谈；现有证据证明有可用执行路径，但尚未定位 Trae 内创建线程的具体库/机制，不能声称已修复 Trae 本身。后续若 Trae 仍失败，直接使用上述获准路径完成专项验证，不再重复改 locale/PID。不得扫描现存 postmaster 自动跳过启动；任何未来外部数据库模式必须显式验证测试用途、版本、权限与隔离并清理本次资源。

## 持续维护规则

1. 新增或修改后端行为时，在对应专项脚本增加成功路径、关键失败路径和数据落盘断言。
2. 修改认证、账户数据、后台任务、迁移或部署时，必须纳入 `test:backend`，不得只跑单文件测试。
3. 修改高频读写、全量 JSON、队列或限流逻辑时，可以维护压测场景，但功能开发验收不运行压测；阈值变化必须有同环境容量基线证据，不能为通过测试而放宽。
4. 修改页面主流程、共享组件或移动样式时，更新 `test:frontend` 的行为断言和必要截图检查。
5. 所有系统测试必须可重复、隔离、无真实费用；临时文件、端口、子进程和浏览器 profile 在成功或失败后都要清理。
6. 浏览器测试保持串行；后端测试只有在确认无共享端口、目录或进程资源后才可并行。
7. 测试失败先保留原始断言和证据，修复实现或测试桩根因；不得只提高超时、吞掉异常或删除覆盖。
8. 每次功能发布前运行 `npm run test:system`；容量评估时再单独运行 `npm run test:load`。无法执行的真实外部服务或真机测试单独记录原因与剩余风险。
9. 新增、拆分、合并或重命名模块时，同步维护模块边界检查、模块测试入口和跨模块集成用例。
