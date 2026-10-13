# 发布规则入口

发布动作、授权核对、失败续做、停止回滚和关闭，只维护在 [发布与观察 SOP](../SOP/release-and-observation.md)。本文件保留为旧链接入口，不再复制固定双轮、逐次审批、全量复测或当前版本状态。

- 当前事实与唯一维护者：[控制面协议](coordination-control-plane.md)。
- Git 角色与远程保护：[分支规则](remote-branch-policy.md)。
- 适用检查项：[上线检查清单](development-release-checklist.md)。
- 测试说明：[system-testing](system-testing.md)；选择范围遵循 PROJECT_RULES 中按影响验证的约束，测试选择唯一遵循 [测试影响矩阵](test-impact-matrix.md)。
- 部署与恢复命令：[deploy/README](../deploy/README.md)；命令能力必须现场核对，不由 SOP 名称推断已经实现。

旧流程正文由 Git 历史保留，仅用于追溯，不是当前门禁。
