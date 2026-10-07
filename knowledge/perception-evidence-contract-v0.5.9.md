# V0.5.9 感知证据领域契约

状态：`05a/05b/08/09 本地已验证`。领域提交：`7cce77b`；持久化与生命周期提交：
`cea417d`、`ed3f64b`、`3bbf564`；持续感知提交：`fb14d47`、`0198e55`、
`5f3b69a`；纠正与失效提交：`e9b1f25`。

`05a` 定义证据、来源事件、双许可、版本校验、派生依赖和事件去重的纯领域
规则。`05b` 已完成 Store v17、JSON/PostgreSQL 映射、导出恢复、删除撤权和
既有来源更新的单调版本接线；`08` 已完成核心来源生产者和后台任务双重硬门。
任务级选材与用户可见的纠正/许可入口分别属于 `06` 与 `09`。

## 核心对象

### EvidenceSource

- `accountId`：证据所属账户，消费时必须与当前账户严格相等。
- `sourceRef`：`resourceType/resourceId/rootId/targetKey/version`。
- `eventId`：同一现实事件的稳定标识，用于跨记录去重。
- `origin`：`user/device/ai/system/third_party`。
- `informationType`：用户事实、用户观点、测量事实、设备建议或模型派生。
- `contentSha256/contentLength/span`：绑定当前原文版本和引用范围。
- `occurredAt/recordedAt`：分别表示业务发生时间和系统记录时间。
- `permissionRevision`：证据生成时采用的许可版本。
- `derivedFrom`：派生项依赖的规范 source key、版本、内容 hash 和许可版本。
- `sourceTaskId`：可选的感知任务来源；参与持久化关系，但不参与语义去重指纹。

时间字段必须是带 `Z` 或显式时区偏移的严格 RFC3339，且日期真实存在；
`occurredAt` 不得晚于 `recordedAt`。所有版本和 permission revision 都是正
安全整数。`model_derived` 必须至少有一个依赖，依赖不得重复或自引用。

### EvidencePermission

`contextAllowed` 与 `learningAllowed` 是两个独立且必填的布尔值。许可对象绑定
账户、规范 source key、revision 和更新时间。删除后恢复数据不能恢复许可；
即使布尔值未改变，只要 permission revision 已推进，旧证据也必须重新校验。

### PerceptionEvent

事件绑定账户、事件类型、来源 identity/version、内容 hash、许可 revision、
发生/记录时间和 `perceptionVersion`。幂等键包含这些字段，不包含随机生成的
事件记录 ID；相同输入重试稳定，来源版本、内容、许可或感知器版本变化都会
形成不同键。

## 使用资格

`evaluateEvidence` 在每次用于上下文或学习前重新检查：

1. evidence、调用账户和 current state 结构有效；
2. evidence、当前来源和许可账户严格一致；
3. 来源存在、未删除且 source key 一致；
4. 来源版本与内容 hash 未变化；
5. 许可 revision 未变化，且本次 purpose 对应许可仍为 true；
6. 每个派生依赖的账户、来源、版本、hash、许可和删除状态仍有效。

任一检查失败即 `usable=false`。固定原因码：

- `EVIDENCE_INVALID`
- `EVIDENCE_ACCOUNT_MISMATCH`
- `EVIDENCE_SOURCE_MISSING`
- `EVIDENCE_SOURCE_DELETED`
- `EVIDENCE_VERSION_STALE`
- `EVIDENCE_CONTENT_CHANGED`
- `EVIDENCE_PERMISSION_DENIED`
- `EVIDENCE_PERMISSION_STALE`
- `EVIDENCE_DEPENDENCY_STALE`
- `EVIDENCE_EVENT_DUPLICATE`

来源和依赖状态中的 `deleted` 必须显式为布尔值；缺失或类型错误均 fail-closed。
依赖快照中的规范 key 必须唯一，禁止依赖输入顺序形成 last-write-wins。

## 去重与确定性

source key 使用 JSON 四元组
`[resourceType, resourceId, rootId, targetKey]`。输入可有 JSON 空白，但解析后
必须是恰好四项的有效 tuple，并统一规范化；任意字符串、额外元素和同源别名
均不能绕过自引用或重复检查。

同一账户内相同 `eventId` 聚合为一个事件组；相同正文 hash 但不同 eventId
不得合并，不同账户也不得合并。排序使用固定 code-unit 顺序，不依赖机器
locale。证据 fingerprint 排除生成 ID 和记录时间，保留账户、来源版本、内容、
业务时间、许可和依赖，因此同一语义输入的重试稳定。

## 验证边界

`scripts/perception-evidence-regression.mjs` 当前执行 114 条以上断言，并已纳入
`test:user-model` 与后端系统门。覆盖非法 schema、时间、span、账户、双许可、
版本/hash、删除恢复、派生依赖、非规范 key、重复状态、locale 稳定性和事件
去重。全部测试使用内存对象，无模型、云服务或生产数据调用。

`05b` 已在此契约之上完成：

- Store v17 与旧 Store 兼容默认值；
- JSON/PostgreSQL collection、relation 和 round-trip；
- 既有记录更新单调推进来源版本，trash 删除撤销双许可、恢复不恢复许可；
- 私有 evidence/event/permission 集合不进入 `/api/state`；
- 导出、备份、恢复与迁移证据。

`08` 已将核心记录、批注回复和 ASR 转写接入事务化感知 adapter。来源创建或
修改时，原文、事件、许可和可选 internal task 同次提交；任务仅在提交成功后
调度。`learningAllowed` 默认关闭，显式开启后才调用模型。调用前和落库前均
重验账户、来源版本/hash、许可 revision、事件与当前感知器版本；删除和恢复
记录 lifecycle event，恢复不恢复许可。

跨来源同一事件通过显式 `eventId` 或既有来源链传播，选择阶段继续按 event
聚合。聚合记录版本推进但来源正文未变时，系统迁移已验证证据或识别已完成的
空结果，不重复调用模型。internal task 不进入公开任务、状态或通知；运行中
断后的自动恢复有持久化次数上限。超出 UTF-8 Prompt 预算时保留原文和事件，
不创建任务。

`scripts/perception-runtime-regression.mjs` 覆盖上述运行时边界、JSON 落盘与
重启、连续中断恢复和 10,000 来源扫描；PostgreSQL 16.14 stable 另覆盖事件、
许可、任务与 `sourceTaskId` 关系往返。所有验证使用 stub，真实模型调用为 0。

## 09 用户治理与综合失效

- 个人上下文提供 claim 确认、修正、拒绝、撤回，以及来源级上下文/学习双许可；
  写许可前必须命中当前原始来源白名单，AI 派生、伪造和旧版本来源均拒绝。
- 学习综合按根问题、普通子记录、追问问题、追问回答分别计数，模型输入和回执
  共用最多 80 个原子项；行动完成反馈最多 40 条，且必须显式允许学习。
- 手动周期综合先保存为 candidate，确认后仅作为 `model_summary` 进入回答
  上下文。来源版本、内容或许可 revision 变化会使其退出上下文并显示 stale。
- 撤销行动完成或删除行动会关闭当前及历史反馈的学习许可；恢复数据不会恢复
  许可。自动周期综合继续默认关闭。
- PostgreSQL JSONB 对任务 payload 的键序重排不再造成误判，同时兼容本地已有
  的旧感知任务 hash。固定 general/legacy replay 指纹保持不变。
