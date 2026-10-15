# Git 当前起点与历史使用规则

生效：2026-10-11（本地规则立即生效；远程分支命名与保护从下一次 `push` 起适用）。

远程分支、保护、短期分支生命周期和提交历史调整统一遵循[远程分支规则](remote-branch-policy.md)。已有远程引用、标签和发布记录保持不变；当前远端没有 `develop` 时，不得把 `origin/main` 或其他历史远程分支冒充为新的普通开发入口。

## 允许入口

- `main`：已发布稳定代码，只接收已完成发布线或生产热修回流。
- `release/v0.5.12-clean`：本次 V0.5.12 冻结复核线，只做发布复核。
- `develop`：下一阶段唯一普通开发基线。新的 `feat/*` 必须从通过规则验收的 `develop` 创建。

生产标签 `v0.5.12` 的实际提交为 `4359648b41608429832e2ce4897bd12163a5d812`；标签对象为 `17cea8ca54b6be255fe8c0060d3ec9531a02e8d0`。分支名不能替代提交核验。

## 历史入口

旧 `archive/*`、`codex/*`、`feat/*`、`fix/*`、`hotfix/*`、`release/*`、`docs/*`、`explore/*`、`refactor/*` 和工作树只用于审计与恢复。它们不是当前代码基线，不得继续修改、迁回、合并或作为新任务起点。需要复用时，必须在 `develop` 上由主控选择性搬运，重新验证并记录来源。

归档恢复引用位于 `refs/archive/git-cleanup-20261011/heads/*`；补丁、未跟踪文件和哈希见 `docs/archive/git-cleanup-20261011/handoffs/index.md` 与 `docs/archive/git-cleanup-20261011/manifests/git-cleanup-20261011-manifest.json`。

## 新任务卡最小字段

新任务必须写明：起始分支、起始 SHA、是否属于 `main`/`release`/`develop`、规则基线提交。若分支不是允许入口的合法后代、规则文件与 `develop` 不一致、或写集与活跃任务重叠，则 `DO_NOT_START`，先由主控处理。
