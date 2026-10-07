# SOP 目录

本目录保存项目中可重复执行的标准作业流程。项目统一遵循
[`knowledge/development-lifecycle.md`](../knowledge/development-lifecycle.md)
定义的主流程、`G0-G7` 门禁、状态和证据契约：

```text
需求收集 → 本轮需求冻结 → 开发规划与风险验证
→ 小批开发与持续测试 → 集成审计与验收
→ 上线与观察 → 复盘 → 回流
```

SOP 只定义操作顺序、输入、输出、证据和退出门；产品事实、工程规则、测试
矩阵、发布细则和当前状态继续维护在各自单一事实来源。

## 主流程 SOP

| 阶段 | 门禁 | SOP | 何时使用 |
| --- | --- | --- | --- |
| 需求收集 | `G0 需求可进入` | [`requirement-intake.md`](requirement-intake.md) | 用户反馈、缺陷、想法、风险和复盘项进入需求池前 |
| 本轮冻结 | `G1 范围已冻结` | [`iteration-planning.md`](iteration-planning.md) | 选择本轮目标、做/不做、验收和兼容约束 |
| 开发规划 | `G2 开发已就绪` | [`iteration-planning.md`](iteration-planning.md) | 拆切片、验证风险、确定依赖、所有权、测试和授权 |
| 小批开发 | `G3 切片已完成` | [`feature-development.md`](feature-development.md) | 实现功能/修复/重构切片并持续测试、审查 |
| 集成审计 | `G4 候选已验收` | [`integration-audit.md`](integration-audit.md) | 串行集成、系统门、独立审查和固定候选 |
| 上线准备 | `G5 最终 GO` | [`release-and-observation.md`](release-and-observation.md) | 双轮发布检查、人工配置、备份恢复与最终授权 |
| 上线观察 | `G6 发布已关闭` | [`release-and-observation.md`](release-and-observation.md) | Git/Gitee、部署、冒烟、观察和发布收尾 |
| 复盘 | `G7 迭代已关闭` | [`iteration-retrospective.md`](iteration-retrospective.md) | 还原事实、评估结果、形成行动并回流规则/需求 |

生产异常使用 [`hotfix.md`](hotfix.md)，按“影响判断 → 止损 → 最小修复 →
针对性验证 → 发布观察 → 补回归与复盘”执行，最终仍回到 `G6/G7`。

## 专项 SOP

- [`ui-ux-optimization.md`](ui-ux-optimization.md)：用户任务、信息架构、内容、
  流程、线框、视觉、原型、实施交接和设计验收。
- [`http-browser-review.md`](http-browser-review.md)：真实 HTTP 页面的用户
  操作、异常恢复、DOM/视觉、权限、响应式和键盘评审。
- [`ios-device-performance-testing.md`](ios-device-performance-testing.md)：
  隔离环境、Release 签名、启动/提交分段计时、证据和性能收紧流程。

专项 SOP 不替代主流程门禁。例如浏览器评审通过只能作为 `G3/G4/G5` 的一项
证据，不能单独授权发布。

## 通用治理 SOP

- [`worktree-lifecycle.md`](worktree-lifecycle.md)：工作树盘点、reviewer
  串行合并、测试、保留、归档和移除的唯一操作来源。任何 `G0-G7` 门禁判定
  时活跃工作树不得超过 6 个；其他 SOP 只检查结果并引用该流程。
- [`multi-agent-orchestration.md`](multi-agent-orchestration.md)：调度者、
  并行开发者、reviewer、验证者和思考秘书的任务图、角色知识、通信、文件
  所有权、串行集成与收口流程；不替代工作树和阶段门禁。
- [`night-continuous-development.md`](night-continuous-development.md)：当前
  关键路径、质量/Preview、后续版本和安全备用车道持续重排；外部权限只阻塞
  对应节点，生产动作仍逐次授权。

## 使用规则

1. 开始任务先读取主流程标准，再选择当前阶段 SOP。
2. 小任务可以用一张任务卡承载多个阶段，但逐项记录适用门禁结论。
3. 门禁失败退回最近一个能解决问题的阶段，不通过改状态文字绕过。
4. 状态必须区分本地实现、候选验收、已发布和观察关闭。
5. 证据必须绑定完整 SHA/tree、环境、动作、结果、时间和未覆盖项。
6. 任何 push、tag、Gitee Release、部署和生产写入仍需本次人工明确授权。
7. 流程变化先更新主流程标准，再同步受影响 SOP；专业阈值只改其事实来源。
8. 创建工作树或通过任何门禁前，按 `worktree-lifecycle.md` 确认活跃工作树
   不超过 6 个；脏或不完善现场允许保留，但不得强制删除。
9. 使用多个 Agent 时先按 `multi-agent-orchestration.md` 固定角色、知识交接、
   文件所有权和合并顺序；集成工作树始终单写。

## 单一事实来源

| 内容 | 文件 |
| --- | --- |
| 生命周期、门禁、状态和证据契约 | `knowledge/development-lifecycle.md` |
| 工程、提交与授权边界 | `knowledge/engineering-rules.md` |
| 用户旅程与分层测试 | `knowledge/user-journey-testing.md`、`knowledge/system-testing.md` |
| 发布双轮检查与证据失效 | `knowledge/pre-launch-confirmation.md` |
| 上线详细检查项 | `knowledge/development-release-checklist.md` |
| 部署、回滚与生产操作 | `deploy/README.md` |
| 当前需求与交付 | 飞书 Base“需求池”“研发交付记录” |
| 当前工程状态 | `README-TODO.md` |
| 重要迭代历史 | `knowledge/iteration-history.md` |
| 阶段和最终证据 | `reports/`、机器测试产物 |
