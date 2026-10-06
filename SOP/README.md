# SOP 目录

本目录保存项目中可重复执行的标准作业流程。SOP 只定义操作顺序、输入、
输出、证据和验收条件；产品事实、工程规则、发布门禁及详细检查项继续维护在
各自的单一事实来源。

## 当前 SOP

- [`iteration-planning.md`](iteration-planning.md)：从需求池、研发交付记录、
  仓库和生产基线出发，完成版本定级、范围冻结、任务切片、依赖与排期、
  热点候选入图、ETA 口径、单一 Mermaid 总图、验收门禁及状态回写。
- [`iteration-retrospective.md`](iteration-retrospective.md)：迭代结束后收集
  Agent 工作记录、人工 Prompt、Git、文件、测试和发布证据，形成可核验的
  过程报告；需要正式复盘时，再基于事实层形成问题与行动项。
- [`multi-agent-orchestration.md`](multi-agent-orchestration.md)：为已获准执行的
  任务建立调度者、思考秘书、侦察员、并行开发者、验证者与 reviewer 的任务图、
  角色知识账、事件驱动重排、候选证据绑定、文件所有权、通信协议、串行集成及
  工作树门禁。
- [`ui-ux-optimization.md`](ui-ux-optimization.md)：从现状证据、用户任务、
  信息架构和内容审计出发，完成流程、线框、视觉系统、交互原型、实施交接与
  全端设计验收；包含冷启动、组件无漂移和用户文案专项。
- [`ios-device-performance-testing.md`](ios-device-performance-testing.md)：
  初步真机性能 SOP；定义隔离环境、Release 签名、启动/提交口径、分段计时、
  证据、清理、故障分类和从 3 秒收紧到 1 秒的持续优化流程。接受随证据更新。

## 相关规则

- 工程与提交：`knowledge/engineering-rules.md`
- 发布与观察：`knowledge/pre-launch-confirmation.md`
- 上线检查项：`knowledge/development-release-checklist.md`
- 重要迭代历史：`knowledge/iteration-history.md`
- 阶段和最终报告：`reports/`
