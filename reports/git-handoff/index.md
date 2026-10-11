# Git 整理前工作树交接总表

状态：**已完成事实快照；分支删除和业务接入仍未完成**（2026-10-11（Asia/Shanghai））

规则：先交接、补丁/未跟踪归档和 SHA-256，再处理分支引用；不重写已发布历史，不自动合并重叠写集。

| 工作树 | 分支 | HEAD | 状态 | 处理方向 |
|---|---|---|---|---|
| `/Users/bytedance/Documents/Codex/个人成长追踪` | `main` | `b64068c93e11` | **dirty** | 保存完整差分与未跟踪归档；从整理分支选择性提取规则，不直接合入业务。（[交接记录](main.md)） |
| `/Users/bytedance/.codex/worktrees/keepsake-image-stability/个人成长追踪` | `hotfix/keepsake-image-stability` | `4359648b4160` | **dirty** | 仅保留归档；与 flicker 线重叠，禁止自动 cherry-pick。（[交接记录](hotfix_keepsake-image-stability.md)） |
| `/Users/bytedance/.codex/worktrees/refresh-stop/个人成长追踪` | `hotfix/account-refresh-stop` | `4359648b4160` | **clean** | 已完成只读核对，恢复责任未证实前仅归档。（[交接记录](hotfix_account-refresh-stop.md)） |
| `/Users/bytedance/.codex/worktrees/source-context-view/个人成长追踪` | `codex/v0.5.12-source-context-view` | `de2d46d94cff` | **clean** | 只读比较提交；若有需求只在 develop 上重建并重新验证。（[交接记录](codex_v0.5.12-source-context-view.md)） |
| `/Users/bytedance/.codex/worktrees/v0.5.13.1-keepsake-flicker` | `feat/v0.5.13.1-keepsake-flicker` | `ebbde6fcf100` | **dirty** | 保留补丁供主控审查；Git 整理完成前不继续写入，接入需新 develop 基线。（[交接记录](feat_v0.5.13.1-keepsake-flicker.md)） |
| `/Users/bytedance/Documents/Codex/个人成长追踪/.worktrees/v0.5.9-integration` | `release/v0.5.12` | `5c790083047b` | **dirty** | 按规则/发布/业务分类；未发布内容不随生产线进入 main。（[交接记录](release_v0.5.12.md)） |

## 已建立的安全边界

- 生产标签 `v0.5.12` 已核验：标签对象 `17cea8ca54b6be255fe8c0060d3ec9531a02e8d0`，实际提交 `4359648b41608429832e2ce4897bd12163a5d812`。
- 已创建冻结线 `release/v0.5.12-clean`，指向 `4359648`；只做发布复核。
- `develop` 当前指向 `ebbde6fcf100432de8a599c771cbd8e774e043ad`；规则整理分支 `docs/git-history-cleanup` 已从该基线创建。
- 已为 119 个本地分支创建 `refs/archive/git-cleanup-20261011/heads/*`；旧分支暂未删除。
- 已归档并移除两个干净只读工作树：`hotfix/account-refresh-stop`、`codex/v0.5.12-source-context-view`；其分支和 archive ref 保留。
- 当前 Keepsake 两条线存在重叠写集：`hotfix/keepsake-image-stability` 与 `feat/v0.5.13.1-keepsake-flicker`。唯一候选负责人为 feature 线的主开发 Agent；热修线只读归档，禁止自动 cherry-pick。
- 完整工作树归档清单：`.git/git-cleanup-archive-20261011-retry2/worktree-archive-manifest.tsv`；清单 SHA-256：`807c6448e9a1166a64e48edd3555e802c2efd1bf6993bc3f0fc2a584b486ec1f`。

## 尚未执行

- 尚未删除旧本地分支引用、未删除脏工作树、未推送远程引用。
- 尚未把根目录脏差分或业务差分自动接入 `develop`。
- 规则基线需要在 `docs/git-history-cleanup` 完成审查并提交后，才能作为 `develop` 的新规则基线。
