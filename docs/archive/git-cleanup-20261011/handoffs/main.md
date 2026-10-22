# 工作树交接：main

- 记录时间：2026-10-11（Asia/Shanghai）
- 路径：`.`
- 分支：`main`
- HEAD：`b64068c93e112040cdfd3a0f4dc00e69be20bf0f`
- 起始/对照基线：以归档 `meta.txt` 为准；生产基线提交为 `4359648b41608429832e2ce4897bd12163a5d812`。
- 当前状态：**dirty**
- 责任人：主控协调者
- 任务目的：根目录规则、状态、部署与报告整理现场；不是新基线。

## 写入与验证事实

- 未提交补丁 SHA-256：`9a5ca7b1665152fd7135fe2290b5d59a1d2d7ff4036caf30ecde1cabbee6807e`
- 暂存区补丁 SHA-256：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- 未跟踪文件归档 SHA-256：`7290feb86c9004d8efbe32935a5bd810d414a78a176ad1f94404579dae652230`
- 元数据 SHA-256：`b489f9defc36b57aaac486b7b4819b0fdd5823eaf61743c2dc131eb871c245e3`
- 恢复引用：`refs/archive/git-cleanup-20261011/heads/main`
- 完整归档目录：`.git/git-cleanup-archive-20261011-retry2/worktrees/main/`
- 未跟踪文件数：553（完整清单以 `untracked-files.txt` 为准）

## 未跟踪文件摘录

- `deploy/apply-media-config.mjs`
- `deploy/deploy-with-media.sh`
- `deploy/media-delivery.production.json`
- `knowledge/aliyun-media-distribution-config.md`
- `knowledge/feishu-base-filling-conventions.md`
- `knowledge/mvp-release-policy.md`
- `knowledge/programming-foundations-learning-notes.md`
- `knowledge/user-model-context-policy.md`
- `knowledge/user-model-extra-information-prompt.md`
- `knowledge/user-record-compression-policy.md`
- `recyclebin/release-notes-rules-before-v2-20261009-234857/ARCHIVE-INDEX.md`
- `recyclebin/release-notes-rules-before-v2-20261009-234857/SOP/iteration-retrospective.md`
- `recyclebin/release-notes-rules-before-v2-20261009-234857/SOP/release-and-observation.md`
- `recyclebin/release-notes-rules-before-v2-20261009-234857/knowledge/development-release-checklist.md`
- `recyclebin/release-notes-rules-before-v2-20261009-234857/knowledge/engineering-rules.md`
- `recyclebin/release-notes-rules-before-v2-20261009-234857/knowledge/release-notes-rules.md`
- `recyclebin/rules-before-20261011-004127/README.md`
- `recyclebin/rules-before-20261011-004127/automations/8-after.toml`
- `recyclebin/rules-before-20261011-004127/automations/8.toml`
- `recyclebin/rules-before-20261011-004127/automations/automation-after.toml`
- `recyclebin/rules-before-20261011-004127/automations/automation.toml`
- `recyclebin/rules-before-20261011-004127/before.json`
- `recyclebin/rules-before-20261011-004127/cleanup-result.json`
- `recyclebin/rules-before-20261011-004127/integration/PROJECT_RULES.md`
- `recyclebin/rules-before-20261011-004127/integration/README-TODO.md`
- `recyclebin/rules-before-20261011-004127/integration/README.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/README.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/feature-development.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/hotfix.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/http-browser-review.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/integration-audit.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/ios-device-performance-testing.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/iteration-planning.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/iteration-retrospective.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/multi-agent-orchestration.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/night-continuous-development.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/release-and-observation.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/requirement-intake.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/ui-ux-optimization.md`
- `recyclebin/rules-before-20261011-004127/integration/SOP/worktree-lifecycle.md`
- ……其余 513 项见归档清单。

## 处理决定

- 建议接入方式：保存完整差分与未跟踪归档；从整理分支选择性提取规则，不直接合入业务。
- 未完成项：不得把历史/未提交内容表述为已发布；任何选择性接入必须在新的 `develop` 上重新审查与验证。
- 风险：删除或继续使用该工作树前，必须先确认没有新的写入者；本记录与归档哈希不可覆盖。
