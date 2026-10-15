# Git 整理前工作树交接总表

状态：**根目录 `develop` 是唯一活动写入点；候选工作树已交接并归档，禁止继续开发**（2026-10-12，Asia/Shanghai）

本表是当前 Git 整理的唯一交接入口。每棵原工作树都有逐树记录；补丁、未跟踪文件和 SHA-256 保存在 `.git/git-cleanup-archive-20261011-retry2/`，不进入发布产物。

| 原工作树 | 分支 | HEAD | 交接结果 |
|---|---|---|---|
| 根目录 `develop` | `develop` | `3cca060` | 当前唯一活动写入点；不再与工作树重复写入 |
| 根目录历史 `main` | `main` | `9e02fb1` | 稳定线，无活动工作树 |
| Keepsake 热修 | `hotfix/keepsake-image-stability` | `4359648` | 已保存补丁/未跟踪文件并移除工作树；与 flicker 线禁止自动合并 |
| 账号刷新热修 | `hotfix/account-refresh-stop` | `4359648` | 干净、已归档并移除工作树 |
| 来源查看候选 | `codex/v0.5.12-source-context-view` | `de2d46d` | 干净、只读审查、已归档并移除工作树 |
| Keepsake flicker 候选 | `feat/v0.5.13.1-keepsake-flicker` | `ebbde6f` | 当前补丁已保存并哈希；已移除工作树，不自动接入 |
| 旧发布现场 | `release/v0.5.12` | `5c79008` | 规则/业务混合脏现场已归档并移除工作树；旧分支只保留审计用途 |
| v0.5.13.1 稳定性候选 | `feat/v0.5.13.1-stability` | `3250565` | 已写入交接记录并建立 archive ref；活动工作树已移除，本地功能分支已删除，禁止继续开发 |

## 当前允许入口

- `main` → `9e02fb1`：已发布稳定线，未推送远端。
- `release/v0.5.12-clean` → `4359648`：冻结发布复核线。
- `release/v0.5.13.1` → `3e94e2f`：现有候选发布线，仅作冻结/审计入口，不从其继续开发。
- `develop` → `3cca060`：当前唯一普通开发基线，根目录工作树承载写入。

## 已完成的安全动作

- 生产标签 `v0.5.12` 已核验：标签对象 `17cea8c`，实际提交 `4359648b41608429832e2ce4897bd12163a5d812`。
- 初始 119 个本地分支已创建 `refs/archive/git-cleanup-20261011/heads/*`；整理过程中创建的临时 `docs/git-history-cleanup` 也已补建 archive ref，因此当前 archive ref 共 120 条。现有本地保留 4 个受职责约束的分支入口，旧开发入口已删除；只有根目录 `develop` 有活动写入。
- 根目录原脏现场的 stash 为 `24d163645e4d3aa4f76539025fd10b699392c30a`，恢复引用为 `refs/archive/git-cleanup-20261011/root-main-dirty-stash`。
- 工作树归档清单 SHA-256：`807c6448e9a1166a64e48edd3555e802c2efd1bf6993bc3f0fc2a584b486ec1f`。
- 当前仅保留根目录 `develop` 1 棵活动工作树；保护分支没有活动工作树。

## 尚未执行

- 本次已删除本地 `feat/v0.5.13.1-stability` 开发入口；远程分支和标签未修改。
- 未将任何业务补丁自动接入 `develop`；Keepsake 两条线的唯一接入责任仍由主控审查后决定。
- 未推送 `main`、`develop`、任何 archive ref 或 tag。
