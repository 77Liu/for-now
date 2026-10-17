# 后端测试目录

返回[系统测试地图](../system-testing.md)。本表是已有脚本的定位索引，不代表已运行、候选已通过或每次需要全跑；实际内容以脚本及 package.json 为准。

## 后端测试

| 测试文件 | 主要覆盖 |
| --- | --- |
| `scripts/check-modules.mjs` | 模块清单、公开入口、测试、依赖方向、深层导入、循环依赖和路由归属 |
| `scripts/commit-gate-regression.mjs` | `feat/fix/test/docs` 类型、隔离暂存候选、受保护分支、高风险/治理面、同路径未暂存内容、测试失败、门禁完整性和 tree 漂移拒绝 |
| `scripts/postgres-test-preflight-regression.mjs` | PostgreSQL 16 工具链通过、错误主版本和缺失二进制的预检分支 |
| `scripts/postgres-runtime-preflight.mjs` | 发布切换前只读核对 data/auth/AI-budget 三角色、预算单例、最小权限和同库连接；不取得应用锁、不写数据库 |
| `scripts/runtime-infrastructure-regression.mjs` | 环境默认/上下限与旧额度兼容、不可变配置快照、测试模式限制、并发账户/后台上下文、追踪 ID、base path、SSE/断连、脱敏权限与保留边界 |
| `scripts/persistence-regression.mjs` | JSON 串行提交、业务 store 各领域/嵌套对象映射、附件与任务引用、原文/顺序重建、事务内同步游标/操作 ID、损坏数据拒绝 |
| `scripts/postgres-integration.mjs` | 真 PostgreSQL 的非 owner RLS、多账户、父外键、并发重复导入、快照覆盖保护、中途/断连回滚、同数量内容篡改拦截、关系导出恢复 |
| `scripts/document-migration-regression.mjs` / `scripts/postgres-bundle-checks.mjs` | 独立文档无损映射、秘密分区、账户/会话/场景重复与孤儿拒绝、附件实物与缺失检查、源漂移、完整批次回滚及第二数据库恢复 |
| `scripts/thought-service-regression.mjs` | 构思服务的根链/内容块、链投影、版本冲突、回答落盘、批注重定位、备注、追问和状态更新 |
| `scripts/api-v1-contract-regression.mjs` | v1 `data/error/meta`、TraceID、OpenAPI、base path、认证、游标分页、ETag/If-Match、Idempotency-Key、增量同步/操作终态、SSE、旧接口共用数据、恢复与账户隔离 |
| `scripts/api-v1-openapi-fragment-regression.mjs` | 思绪领域 OpenAPI 分片的路径/操作、引用闭合、运行路由覆盖及 If-Match/Idempotency-Key |
| `scripts/record-v1-regression.mjs` | 状态/健康 v1 运行处理器、幂等重试、服务端默认时间、游标、ETag、条件删除、账户隔离和 OpenAPI 分片组合 |
| `scripts/g2-discovery-regression.mjs` | 思绪搜索/类型筛选、来源身份、稳定游标、新鲜/未留痕、已读/免打扰、任意门、账户隔离和失败提交 |
| `scripts/g2-export-regression.mjs` | 跨体裁正文与附件引用、共享/缺失/未引用附件、确定性 JSON/Markdown、秘密与模型推理默认排除 |
| `scripts/g2-actions-regression.mjs` | 行动/习惯/打卡载荷、持久幂等、版本、状态历史、来源、自然日去重、回收定位、账户隔离和失败提交 |
| `scripts/g2-feedback-regression.mjs` | 反馈上下文授权、幂等、状态流转、验证同意/退出、补偿/奖励、参与证据、账户隔离和失败提交 |
| `scripts/g2-integration-regression.mjs` | G2 OpenAPI、真实 HTTP、账户隔离、ETag、级联回收恢复、导出覆盖与隐私默认值 |
| `scripts/checkin-health-regression.mjs` | 状态/健康记录载荷、时间和版本、原始元数据、CRUD/HTTP、仓储账户隔离、回收委派及提交失败 |
| `scripts/ai-domain-regression.mjs` | 旧模型设置、并发账户设置/成本独立保存、整份替换兼容、自然日与七类服务统计、DeepSeek/火山/阿里官方价解析、文档实际页数、未知动作、写前归一化失败、备份权限、额度释放/隔离、账本与审计独立故障；运行适配回滚用接口桩，真实 PG 另验 |
| `scripts/ai-budget-runtime-regression.mjs` | 站点预算任务预留、阶段启动、实际费用结算、未启动释放、双尝试计划、结算失败保护和启动恢复 |
| `scripts/ai-budget-control-version-regression.mjs` | Owner 控制版本、普通调用不漂移、If-Match 原子校验、临时追加/恢复递增和并发陈旧写拒绝 |
| `scripts/ai-budget-http-regression.mjs` | Owner 预算安全聚合投影、ETag/no-store、服务端 actor 注入、命令错误投影与 OpenAPI 组合 |
| `scripts/ai-provider-regression.mjs` | DeepSeek JSON/SSE、逐字节 UTF-8/CRLF 拆包、断流/过滤/截断/供应商错误的部分输出、空正文重试次数与账户/站点预算、预算拒绝零供应商 I/O、容量失败释放、超时、并发账户、图片 Flash 参数与私有摘要 |
| `scripts/volcengine-provider-regression.mjs` | 火山 V4 签名、OCR/文档解析请求契约、TTS 参数/音频响应、长文本与录音文件任务，以及流式 ASR 二进制帧 |
| `scripts/volcengine-server-regression.mjs` | 带鉴权的 TTS/视觉 HTTP 入口、TTS 缓存零重复预算、TTS/ASR/OCR/文档官方价预留与结算、文档实际页数、OCR + 模型与 ASR + 润色整体预留、站点/账户拒绝零供应商 I/O、Owner 恢复和转写结果落盘 |
| `scripts/capture-transcription-regression.mjs` | 捕念转写排队/执行/结果合并、失败投影及服务重启后的中断任务恢复 |
| `scripts/segmentation-regression.mjs` | 阿里云 SDK 无重试、同步/异步结果、提交官方价、轮询/下载零重复费用、失败状态/轮询超时、PNG 下载大小/格式/超时、调用组及账户审计、审计失败不重放、限流/在途/上传失败释放、临时图片清理与异步绑定；均为本地替身 |
| `scripts/keepsake-time-regression.mjs` | 小物载荷/旧记录/扩展保留、局部更新兼容、账户集合隔离与失败提交；UTC/上海/纽约、夏令时、本地日/时分合成、严格日期及旧发生日期解析 |
| `scripts/prompt-catalog-regression.mjs` | 提示词目录版本选择、SHA-256、必需 ID、占位符契约、提示词正文与代码分离 |
| `scripts/working-context-source-boundaries-regression.mjs`、`scripts/personalization-quality-plan-regression.mjs` | 合法时点、历史材料时效与推断边界；显式 v3 用途与 catalog、旧 v2 48 请求及通用/legacy 32 请求完整不变，零供应商调用 |
| `scripts/perception-runtime-regression.mjs` | 核心来源事务化事件、双许可、内部任务隔离、调用前/落库前重验、失败及连续重启恢复、跨来源去重、JSON 落盘和 10,000 来源性能门 |
| `scripts/collaboration-regression.mjs` | 可见文本/重复引文、漂流保留、两套批注 URL、评论创建幂等、任务结果/通知原子提交、失败回滚、并发幂等/重试、迟到拒写、重启与跨账户同 ID 任务 |
| `scripts/trash-regression.mjs` | 整记录/嵌套恢复版本、批注与漂流回附、父记录缺失/冲突、二次确认与清单变化、共享附件保留、两次提交失败、清理重试和调度账户隔离 |
| `scripts/regression.mjs` | JSON 迁移、CRUD、回收站、异步绑定、幂等、版本竞态、AI 任务、健康附件两阶段识别与清理 |
| `scripts/auth-regression.mjs` | 注册登录、Cookie、CSRF、账户隔离、base path、附件 GET/HEAD/私有缓存/越权、三类任务重启恢复 |
| `scripts/local-test-mode-regression.mjs` | 线上只读快照、主账户约束、本地写隔离、冷启重置、附件回退和上游写入拒绝 |
| `scripts/observability-regression.mjs` | AI 审计、用量、错误分类、脱敏、日志权限、损坏文件保护；模型成功后账本或审计写失败不重复调用；日志故障期间业务提交和故障后审计恢复 |
| `scripts/attachment-storage-regression.mjs` | 本地与 mock OSS 的隔离、读写和用量；旧本地副本回退、云端与本地共同清理及失败重试 |
| `scripts/attachment-upload-regression.mjs` | 账户配额竞态、格式/总大小、临时文件、批量部分失败、清单预留/确认顺序、清理提交失败及启动核验；数据库清单用接口桩，真实事务另验 |
| `scripts/attachment-derivatives-regression.mjs` | 小物四类 WebP 派生的尺寸/质量/字节上限、EXIF 方向、元数据移除、批次持久化失败补偿及上传响应 |
| `scripts/keepsake-media-migration-regression.mjs` | 历史小物迁移 dry-run 零写入、计划哈希、旧资源回退保留、阻断输入、重复选择和竞态补偿 |
| `scripts/persistence-ledger-postgres-regression.mjs` | 真 PostgreSQL 生命周期、幂等响应精确重放/冲突、永久清理后防重复、进程重启与跨进程序列化 |
| `scripts/boundaries-regression.mjs` | AI/分割限流、每日额度、请求体与附件额度 |
| `scripts/monitor-regression.mjs` | 服务、磁盘、备份、AI 连续失败、费用告警和恢复通知 |
| `scripts/restore-validation-regression.mjs` | 恢复数据解析、Store v16→v17 私有证据集合兼容、公开集合逐项数量/ID/内容摘要、附件引用、缺集合反向断言和临时认证会话 |
| `scripts/deploy-regression.mjs` | 候选构建、模块目录语法检查、双证书域名 Nginx 配置安装、依赖失败、健康失败、Nginx 失败和原子回滚 |
| `scripts/sync-coordinator-regression.mjs` | durable-first 队列、资源串并行、确定性 P95、408/425/429/5xx 分类、Retry-After、退避上限、成功/失败审计裁剪、关闭→重开恢复、跨标签失效通知和增量 cursor |
