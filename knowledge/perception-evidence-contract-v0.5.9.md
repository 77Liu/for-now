# V0.5.9 感知证据领域契约

状态：`05a 本地已验证`。实现提交：`7cce77b`。

本契约只定义证据、来源事件、双许可、版本校验、派生依赖和事件去重的纯领域
规则。它不包含 Store schema、JSON/PostgreSQL 映射、HTTP、后台任务接线或
用户界面；这些属于 `05b` 及后续切片。

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

`05b` 必须在此契约之上新增：

- Store v17 与旧 Store 兼容默认值；
- JSON/PostgreSQL collection、relation 和 round-trip；
- 记录写入、trash/restore、账户边界与后台任务发送前/落库前复查；
- 导出、备份、恢复与迁移证据。

在 `05b` 完成前，不得把本契约写成持久化或端到端感知能力已完成。
