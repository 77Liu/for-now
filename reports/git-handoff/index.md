# Git 整理前工作树交接总表

状态：**已完成交接、归档和本地入口收敛；旧分支删除仍待最后只读复核**（2026-10-11，Asia/Shanghai）

本表是当前 Git 整理的唯一交接入口。每棵原工作树都有逐树记录；补丁、未跟踪文件和 SHA-256 保存在 `.git/git-cleanup-archive-20261011-retry2/`，不进入发布产物。

| 原工作树 | 分支 | HEAD | 交接结果 |
|---|---|---|---|
| 根目录 | `main` | `b64068c`（已保存脏现场） | 脏差分已保存为 stash `24d1636` 和 archive ref；本地 `main` 已收敛到 `9dc52af` |
| Keepsake 热修 | `hotfix/keepsake-image-stability` | `4359648` | 已保存补丁/未跟踪文件并移除工作树；与 flicker 线禁止自动合并 |
| 账号刷新热修 | `hotfix/account-refresh-stop` | `4359648` | 干净、已归档并移除工作树 |
| 来源查看候选 | `codex/v0.5.12-source-context-view` | `de2d46d` | 干净、只读审查、已归档并移除工作树 |
| Keepsake flicker 候选 | `feat/v0.5.13.1-keepsake-flicker` | `ebbde6f` | 当前补丁已保存并哈希；已移除工作树，不自动接入 |
| 旧发布现场 | `release/v0.5.12` | `5c79008` | 规则/业务混合脏现场已归档并移除工作树；旧分支只保留审计用途 |

## 当前允许入口

- `main` → `9dc52af`：已发布稳定线，未推送远端。
- `release/v0.5.12-clean` → `9dc52af`：冻结发布复核线。
- `develop` → `143af28`：规则整理后的普通开发基线。
- `docs/git-history-cleanup` → `143af28`：规则整理已完成的短期记录分支，验收后可归档。

## 已完成的安全动作

- 生产标签 `v0.5.12` 已核验：标签对象 `17cea8c`，实际提交 `4359648b41608429832e2ce4897bd12163a5d812`。
- 119 个本地分支已创建 `refs/archive/git-cleanup-20261011/heads/*`；旧分支尚未删除。
- 根目录原脏现场的 stash 为 `24d163645e4d3aa4f76539025fd10b699392c30a`，恢复引用为 `refs/archive/git-cleanup-20261011/root-main-dirty-stash`。
- 工作树归档清单 SHA-256：`807c6448e9a1166a64e48edd3555e802c2efd1bf6993bc3f0fc2a584b486ec1f`。
- 当前只有根目录、整理分支和冻结发布线 3 棵工作树；整理分支和冻结线完成后将只保留根目录 `main` 与干净 `develop` 工作树。

## 尚未执行

- 未删除本地旧分支或远程分支；删除前仍需一次只读复核，确保没有新写入者。
- 未将任何业务补丁自动接入 `develop`；Keepsake 两条线的唯一接入责任仍由主控审查后决定。
- 未推送 `main`、`develop`、任何 archive ref 或 tag。
