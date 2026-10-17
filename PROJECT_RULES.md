# 项目规则

生效：2026-10-15；本次修订：2026-10-17，Owner 已批准，接入 develop 后生效。仅维护跨任务长期约束；操作步骤见 [SOP](SOP/README.md)。

所在根目录：`/Users/bytedance/Documents/Personal/forNow`。这是项目迁移时唯一需要更新的绝对定位锚点；项目内代码、配置、控制面和文档中的路径值均记录根目录相对路径，不复制本行绝对值。

## 读取与规则归属

1. 启动先读 README 和本文件，再按任务读取一份相关 SOP；知识、历史和事故案例按需检索。
2. 系统/平台约束及用户最新明确要求优先；项目文件不得扩大授权。已覆盖的持续授权无需逐次重问；暂停或缩小范围立即生效。
3. 同一仓库所有聊天从“所在根目录”读取当前主控工作树中的唯一控制面，再按其中 rule_baseline 指定的提交读取有效规则。控制面的 `canonical_path` 只登记根目录相对路径；其他 checkout 不得复制当前状态。物理根目录不等于 main 分支；任何 checkout 检出旧提交时，其中规则也是历史快照，不得覆盖控制面登记的有效规则。
4. 任务单注明规则来源和生效日期。规则变更先修改唯一正文，由协调者通知受影响任务；只重新核对改变的约束。代码/API/schema 等领域契约仍随任务基线版本，不能用新知识覆盖旧候选的实际行为。
5. 一项约束只维护一处；其他文件链接引用。仓库内 Markdown/HTML 指向项目文件时必须使用从当前文档可解析的相对链接，禁止仓库根绝对链接、`file:`、`computer:` 或本机绝对路径；外部网页保留完整 `https:` 链接。执行参数以对应脚本/配置为准，文档不另列一套阈值。冲突修正文内，不能只在顶部叠加“以新规则为准”。

## 规则地图（map）

- 跨任务原则与优先级：本文件。
- 设计职责、领域边界、实体访问、事务、记录级同步、列表/详情和首屏：[`knowledge/design-contracts.md`](knowledge/design-contracts.md)。
- 模块清单、公开入口、依赖方向和迁移顺序：[`knowledge/modularization-design.md`](knowledge/modularization-design.md)。
- 源码文件头、公共接口 JSDoc 和 partial：[`knowledge/source-documentation-rules.md`](knowledge/source-documentation-rules.md)。
- 需求到复盘生命周期：[`knowledge/development-lifecycle.md`](knowledge/development-lifecycle.md)；执行步骤见 [`SOP/README.md`](SOP/README.md)。
- 本地提交组织与门禁入口：[`knowledge/commit-and-release-rules.md`](knowledge/commit-and-release-rules.md)。
- 本地分支与远程分支分别适用的职责、保护与保留规则：[`knowledge/remote-branch-policy.md`](knowledge/remote-branch-policy.md)；物理 checkout 的隔离与回收：[`SOP/worktree-lifecycle.md`](SOP/worktree-lifecycle.md)。工作树归档不等于分支删除。
- 外部动作与费用授权：[`knowledge/release-authorization-policy.md`](knowledge/release-authorization-policy.md)；发布及正式节点回流：[`SOP/release-and-observation.md`](SOP/release-and-observation.md)。
- 测试选择、证据与发布全局门：[`knowledge/test-impact-matrix.md`](knowledge/test-impact-matrix.md)；发行说明：[`knowledge/release-notes-rules.md`](knowledge/release-notes-rules.md)。
- 当前状态、事件、授权和候选：[`knowledge/coordination-control-plane.md`](knowledge/coordination-control-plane.md)。

规则地图只做入口，不复制 detail 条款；旧历史文档保留原事实，不作为当前执行规则。

## 文档与状态

6. README 严格少于 100 行，只含必要项目知识和地图；不复制当前版本、需求状态、历史和知识细节。
7. 状态、事件、归档及维护责任唯一正文见[控制面与版本事件协议](knowledge/coordination-control-plane.md)；`README-TODO.md` 只做入口地图。只有协调者可以通过指定入口更新当前状态；当前控制面与追加事件、只读收口快照分离，版本收口集中提交，不以版本号或聊天结论替代真实回执。
8. `one-mistake-one-rule.md` 只做事故→责任文件的索引。新事故优先修正对应正文或测试，不机械增加硬规则。
9. SOP 写步骤与职责；`knowledge/` 保存领域知识、技术依据和设计，不逐篇加入启动地图。生命周期、测试影响矩阵和发布自动授权分别只有各自正文；历史报告、旧方案及 `recyclebin/` 不作为当前执行要求。
10. 文档随相关代码或发布同步更新；纯文档任务可独立交付，无长期 docs 分支。删除或替换有追溯价值的内容先归档。
11. 有效决定更新原维护位置；无变化不造报告。长期任务在可恢复节点留下基线、已做、未做和下一动作即可。

## 修改、验证与提交

12. 只完成当前需求及必要连带改动；复用现有结构。抽象、依赖或防御必须有实际使用方或失败依据；不靠单行压缩复杂逻辑追求行数。
13. 修改前核对工作区，保护其他任务的未提交内容；只暂存和提交自己的范围。不得把“工作区脏”当作丢弃文件的理由。
14. 原始用户数据、账户、附件、凭据不进 Git；外部返回按契约校验，模型推断不能自动变为用户事实。持久化或迁移失败保留原数据和恢复路径。
15. 模块通过公开入口协作；每个任务必须登记允许写集、禁写集、共享文件负责人和接入顺序。共享入口、schema、依赖、默认配置、构建/部署入口、`.gitignore` 与控制面由协调者指定唯一串行写者；工作树越界或写集重叠立即停写，未完成边界核对不得合入。并行和契约变更按协作 SOP 执行。
16. 新增应用及脚本源码使用 TypeScript（`.ts`/`.mts`）；语言专用文件如 shell、SQL 按其语言编写；旧 JavaScript 按功能切片渐进迁移，不借机换框架或全量改写。类型检查和编译入口以当前 `package.json` 为准；浏览器/Capacitor 加载实际构建产物。
17. 源码文件头与公共接口文档遵循[源码与注释规范唯一正文](knowledge/source-documentation-rules.md)。
18. 保存、查询和同步遵循[设计职责与数据访问契约](knowledge/design-contracts.md)：只处理本次业务闭包，禁止局部操作清写整账户或无关集合；客户端按记录 ID/版本合并增量。页面交互与账户生命周期状态同样按该契约保护和清理。
19. 开发者编辑后先自查，主控接入前亲自审查完整数据链及代码契约，发现问题退回修改；具体责任与顺序唯一正文见[协作协议](SOP/multi-agent-orchestration.md#开发者自查与主控接入审查)。验证确认审查结论，覆盖受影响行为、消费者与失败恢复。固定代码/依赖/配置/相关环境未变时复用证据；扩大测试须有影响依据，不固定双轮或逐次全量重测。
20. 测试与 review 结论绑定实际候选和执行环境；未执行、失败、未知、partial 不得改写为通过。行为影响到测试选择的唯一正文是 `knowledge/test-impact-matrix.md`，develop → release 必须完成该矩阵的有状态全局测试门，通过后才冻结 release；命令入口见 `package.json`，技术命令目录按需查 `knowledge/system-testing.md`。
21. 提交单一目的、可审查；中文摘要描述结果，类型前缀可英文。自动任务提交使用 `npm run commit:task`；允许范围、规模及固定 tree 校验只由 `scripts/commit-gate.mjs` 定义，不另设文档数字门槛。
22. 不满足自动提交适用范围时，由协调者按现有授权审查真实差分和验证结果后提交；不机械拆碎原子修改，也不为过门禁改写类型或隐藏失败。
23. 分支、合并与工作树按 [协作协议](SOP/multi-agent-orchestration.md)、[工作树生命周期](SOP/worktree-lifecycle.md) 和 [远程分支规则](knowledge/remote-branch-policy.md)；没有已确认的并行写入、发布候选隔离或外部环境隔离，禁止创建或保留工作树，单写者使用唯一工作目录，在指定 `feat/*` 上修改，`develop` 仅作集成；同一任务不得在主线和工作树重复写入；任务完成后立即交接、归档并禁止继续开发。发布风险和最小闭环只由 [发布 SOP](SOP/release-and-observation.md) 定义。现有远程引用不因规则落地而自动修改，远程命名与保护从下一次 `push` 起执行。
24. 真实付费或生产操作按[发布自动授权策略](knowledge/release-authorization-policy.md)及控制面记录的目的地、预算和失效时间执行；先识别自动副作用，不盲重试未知结果。策略未完成启动前核验时，不启用自动生产写入。当前任务明确“不开发”时，持续开发授权不扩大本次范围。

## 约束维护

现行规则正文每篇不超过 200 行；超长时按职责、领域或动作去重拆分，map 只保留适用范围和链接。原始历史记录与收口归档保持只读，不作为现行规则入口。规则修改应能说明解决了哪个实际问题、由谁维护、替代了什么。可靠自动检查已承担的要求只保留入口说明；不重复抄写实现。交付如实报告完成范围、验证与未解决项。
