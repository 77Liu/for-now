# PostgreSQL 映射与影子导入

返回[数据库地图](../postgres-migration.md)。本页维护迁移/恢复的全量映射与验真，不授权普通在线命令整账户读写；在线访问遵循[设计契约](../design-contracts.md)。下面表结构是既有映射说明，变更时核对实际 schema 和消费者。

## 已实现的业务 store 映射

`src/shared/persistence/store-mapping.mjs` 将业务实体映射为带领域类型的关系行：

| 表 | 含义与约束 |
| --- | --- |
| `store_fields` | 顶层字段及其数组、对象、普通值形态；区分缺失、空数组与 null |
| `store_objects` | 每个业务对象和嵌套内容独立成行；含集合、类型、ID、父对象、所属字段、顺序、正文/状态/版本索引及原始字段 |
| `store_relations` | 思绪根、日记草稿、任务目标/子目标/结果/重试、通知任务、生成来源等引用；外键包含账户 |
| `store_attachment_refs` | 每个附件路径的拥有对象、字段和原始值路径；包含回收站、待清理项和未知扩展内的路径 |
| `resource_lifecycle` | 每个业务资源的草稿/正式、活跃/删除/正式化/永久清理状态与历史；显式保存数组位置和完整原始 payload |
| `idempotency_ledger` | 90 天请求键、请求哈希、原始响应与期限；显式保存数组位置和完整原始 payload，支持 JSON `null` 响应 |
| `account_snapshots` / `migration_runs` | 原始解析快照、源文件哈希及迁移证据；业务重建不依赖快照表 |

覆盖 `checkins`、`dailyRecords`、`captures`、`journals`、`thoughts`、`chats`、`books`、`keepsakes`、`quotes`、`experiments`、`analyses`、`customMetrics`、`trash`、`attachmentCleanup`、`aiTasks`、`notifications`、`actions`、`habits`、`habitCheckins`、`feedback`、`validationLedger`。`journalDraft`、`onboarding`、`commercialization` 保存为账户级对象。

思绪备注和追问、各体裁批注/漂流批注、批注回复和神鸡对话、日记回望、读书笔记均拆为有父外键和顺序的独立行，不再只嵌在所属业务对象中。父外键不可跨账户或集合；ID 按所属集合/父对象隔离，允许不同体裁使用相同 ID。

原始时间、版本、用户文本、模型文本及推理保留原值；查询用索引列不得代替原始字段。未知字段按原结构保存，不做静默清洗。回收站 `payload` 是用于恢复的历史文档，完整保留，同时提取其中的附件路径；不将已删文档误当作活跃记录。附件引用扫描沿用当前应用的完整 `/attachments/<filename>` 字符串规则，尚不解析 Markdown 内联 URL；完整批次额外读取这些路径对应的实物。

思绪根、嵌套所有权、草稿编辑目标及排队/运行任务的必要目标引用缺失时拒绝导入。终态任务、通知和来源追踪可以指向已清理对象；此类引用显式记为 `historical`，保留目标 ID，不伪造活跃对象。未知关系字段仍保留在原始字段内，后续领域新增关系时须更新映射与测试。

早期 `entries`、`entry_blocks`、`thought_follow_ups`、`thought_remarks`、`annotations` 核对投影已从导入/验证路径移除，schema 初始化会删除这些旧投影表。思绪与嵌套内容只使用正式 `store_objects` 关系模型；原始证据仍在迁移快照内。

## 独立文件与附件

`document-mapping.mjs` 定义无损映射，`postgres-documents.mjs` 负责关系读写，`postgres-bundle.mjs` 编排批次事务：

| 来源 | 正式映射 |
| --- | --- |
| `auth.json` | 独立 `for_now_auth` schema：`users` 每账户一行，用户名规范键唯一、密码哈希独列；`sessions` 每摘要一行、外键指向账户；扩展与原始时间保留，顶层字段单独存放 |
| `llm-settings.json` | `account_documents` 标记存在性；`document_fields` 保留字段形态；每个档位、场景、回答风格写入 `document_records`；`apiKey` 仅在 `document_secrets`，不复制进普通字段/记录/迁移快照 |
| `ai-usage.json` | 每次调用按原 ID 独立成行，场景/模型/状态可查询；Token、费用、价格快照及扩展与调用同行保存 |
| `ai-cost-plan.json` | 每场景一行，全局预算、汇率和扩展字段独立保存 |
| 根 `ai-budget.json` | 全站预算、预留、结算和阈值事件整体写入非租户单例 `site_ai_budget`；与认证、账户文档和附件清单同事务导入 |
| 附件 | `attachment_inventory` 保存路径、实际存储来源、对象键、字节数、SHA-256 和状态；包含有效引用、回收站引用、清理队列以及本地未引用文件 |

认证查询发生在确定账户之前，不能假装使用租户 RLS。`for_now_auth` 通过独立 schema/专用角色授权；租户数据角色不得获得其权限。密码哈希和会话摘要不返回业务接口。账户配置、密钥、附件清单仍由强制 RLS 隔离。数据库秘密需要由数据库访问权限、备份访问控制和磁盘加密保护；这里的分表不等同于应用层加密。

缺失的可选设置/用量/成本文件与存在的空对象有区别，不凭空补齐默认值；无效 JSON、重复调用/场景/身份、大小写重名、孤儿会话或不安全账户路径均拒绝导入。认证和配置未知字段保留，数组顺序及 JSON null 不丢失。

附件检查默认只读本地。显式选择 OSS 后逐个读取对象并计算 SHA-256；远端不存在而本地可读时，按现有应用回退语义标记实际来源为 `local`，不伪称 OSS 存活。有效/回收站引用缺失阻止导入；只有全部引用均来自清理队列时允许 `missing_cleanup`。符号链接与非普通文件拒绝盘点。清单不枚举整个 OSS 桶的无引用对象，也不执行删除。正式 OSS 实物证据须在发布演练时获取，本地 mock 不代替生产证据。

## 校验与覆盖保护

1. 解析源文件与传入 store 必须相同；`sourceSha256` 标识原始文件字节，`contentSha256` 标识键排序后的 JSON 内容。对象键顺序不影响内容哈希，数组顺序必须一致。
2. 生成迁移计划时立即做往返重建；重复 ID、错误集合类型、孤儿引用或有损 JSON 值拒绝进入数据库。
3. 默认完整批次将所有账户、认证、配置、用量和附件清单放在同一事务中；批次锁与逐账户锁共同防止重复导入。旧 `--store-only` 诊断模式仍逐账户提交，不能当作完整迁移。
4. 导入后核对数量、每行字段、顺序、所有权、关系、附件清单及重建内容哈希。生命周期和幂等元数据也保存显式位置与原始 payload；旧表升级只能从账户快照恢复这些列，证据不足时拒绝启动。任一不符整事务回滚。
5. 同一源哈希再次导入时，校验实际数据后复用原迁移记录；不删除重建，不自动“修复”已经损坏的目标。
6. 目标有不同快照时默认拒绝。只有指定单一账户及当前目标源哈希才能替换影子副本；有业务数据但缺失快照证据时拒绝覆盖。
7. 所有租户表均启用并强制 RLS；每个事务使用 `SET LOCAL` 等价的 `set_config(..., true)` 绑定账户。导入角色禁止 superuser、BYPASSRLS、表 owner 或继承 owner 权限。
8. 完整批次对源文件（包括根 `ai-budget.json`）的相对路径/原始字节及内容计算两个哈希。导入前和提交前重新检查文件与附件，发现漂移即回滚；实际操作仍要求冻结写入，不能用前后哈希代替停写。
9. 完整批次重复执行会验证认证、文档集合、所有映射行和附件清单。替换必须提供当前批次源哈希，且不得改变账户集合；没有迁移证据的认证或独立文档不得覆盖。
10. 数据库进入运行态后，认证 `runtime_state` 和账户 `runtime_started_at` 拦截完整/单账户旧 JSON 导入，即使提供旧哈希也拒绝覆盖。运行数据目录写入 `.persistence-mode.json`；切回 JSON 必须在全新目录恢复、核验新增数据，不能直接复用旧 JSON。

原始字节快照仍须由外部备份保全，JSONB 导出不会复现原文件的空格、键排列等格式。迁移日志不输出正文或数据库连接串。
