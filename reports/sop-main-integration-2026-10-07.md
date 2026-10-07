# SOP 主流程资产集成记录

- 日期：2026-10-07
- 目标基线：`main@1bab107bd69eaa97c6c0aabcb550f86baf870107`
- 来源工作树：
  `/Users/bytedance/Documents/Codex/个人成长追踪`
- 来源分支：
  `wip/root-dirty-before-v0.4.0-owner-integration@4eb5de747224`
- 集成工作树：
  `.worktrees/sop-main-integration`
- 状态：**已集成并推送 `main`**
- 内容提交：`f9fb5b64dae7353edc733561fc90a55d6453ed58`

## 1. 为什么 IDE 仍显示大量 `U/M`

根目录不是 `main`，而是为保护历史未提交资产长期保留的 `wip` 工作树。IDE
截图显示的是这个工作树相对 `4eb5de7` 的状态：

- `U`：文件只存在于根工作区，根分支和 `main` 都没有跟踪；
- `M`：文件相对根分支已经修改；
- 即使另一工作树已把部分规则提交到 `main`，根工作树也不会自动清除自己的
  `U/M` 标记。

此前收尾只吸收了夜间持续开发、发布回流和复盘相关文件，没有审计并接入整套
G0-G7 主流程。这使重要 SOP 仍依赖根工作区现场，属于收尾漏项，不是 IDE
显示错误。

## 2. 本次吸收范围

新增到 `main`：

- `knowledge/development-lifecycle.md`
- `SOP/requirement-intake.md`
- `SOP/feature-development.md`
- `SOP/integration-audit.md`
- `SOP/release-and-observation.md`
- `SOP/hotfix.md`
- `SOP/http-browser-review.md`
- `SOP/worktree-lifecycle.md`

三方合并：

- `SOP/README.md`
- `SOP/iteration-planning.md`
- `SOP/iteration-retrospective.md`
- `SOP/ui-ux-optimization.md`

保留 `main` 版本，不用根草稿覆盖：

- `SOP/multi-agent-orchestration.md`
- `SOP/night-continuous-development.md`
- `SOP/ios-device-performance-testing.md`

根目录的 `multi-agent-orchestration.md` 是较早草稿；`main` 版本包含更完整的
事件驱动重排、Epic/叶子、候选证据绑定、生产单写和 fencing 规则，因此只把
其依赖的工作树 SOP 补入，不回退主文件。

## 3. 合并原则

1. 以 `knowledge/development-lifecycle.md` 作为 G0-G7、状态和证据契约的
   单一事实来源。
2. 以根版 `iteration-planning.md` 的完整生命周期、风险预验证、旅程、
   发布关闭和 G1/G2 门为主体。
3. 保留 `main` 独有的 Epic/叶子语义、动态 `ready` 派发、夜间跨版本车道、
   热点雷达、候选 SHA/tree/manifest 和证据失效规则。
4. `SOP/README.md` 使用完整主流程表，并保留夜间持续开发与 iOS 性能专项入口。
5. 不复制专业细节形成第二套规则；SOP 继续引用工程、测试和发布单一事实来源。
6. 热修原编号与工作树 SOP 重复，改为 `SOP-OPS-001`；其余编号保持不变。
7. 生命周期草稿中的概念状态与 Base 真实单选不一致；需求、执行、发布枚举
   恢复为当前 Base schema，`G0-G7`、候选和观察阶段继续作为门禁/证据表达。

## 4. 根工作区后续处理

本次不删除、reset、checkout 或提交根工作区的其他用户资产。完成集成后：

- 远端 `main` 成为 SOP 权威来源；
- `.worktrees/sop-main-integration` 可切换为干净的 `main` 工作树；
- 根 `wip` 工作树仍会显示 `U/M`，因为其余未提交产品、设计和调试资产仍需
  独立审计；
- 日常开发应打开干净 `main` 工作树，不再把根 `wip` 的 Source Control
  状态当作主线状态；
- 只有在根目录全部资产形成归档提交或被逐项吸收后，才能安全退役该工作树。

## 5. 验收

- [x] 13 份新增/修改 Markdown 的相对链接全部存在；
- [x] 没有 merge conflict marker、未闭合 code fence 或重复 SOP 编号；
- [x] `main` 原有多 Agent、夜间持续开发和 iOS 性能 SOP 未回退；
- [x] `npm run check` 通过；
- [x] 变更只包含 SOP、生命周期总纲和本报告；
- [x] 提交后快进并推送 `main`；
- [x] 根 `wip`、其他脏工作树和 stash 均未修改。
