# v0.5.13.1 本地候选记录

## 范围

本候选从 `develop/9273dd5187af07cf63fbcd38226870c6d36bd98b` 建立，包含工程测试入口收敛、前端个性化任务 TS 边界与生命周期注释，以及账号会话/小物媒体稳定性相关的最小整改。

小物实现只保留当前分支这一条写入线。归档的 `feat/v0.5.13.1-keepsake-flicker` 与 `hotfix/keepsake-image-stability` 都修改同一组小物文件，未自动合并；账号刷新归档补丁为空，现有会话轮换与迟到响应丢弃回归作为现状证据。

## 候选提交

- `2ada266`：按功能域选择提交门禁、复用原子仓储夹具、移除重复 system 登记。
- `39a1a8f`：个性化任务 TS 源码、前端类型检查和构建入口。
- `6fe6a06`：生命周期和恢复边界的必要中文注释。
- `61fe71a`：小物预览 URL 按项目复用、替换和移除时精确释放，渲染刷新保留图片节点，草稿恢复失败通知已清空状态。

当前候选 SHA：`61fe71a`。

## 验证

已通过：

- `npm run check:modules`
- `npm run typecheck:frontend`
- `npm run build:frontend`
- `npm run test:commit-gate`
- `npm run test:f8-features` 中的小物前端、媒体工作流、衍生图检查
- `node scripts/frontend-contract-regression.mjs`
- `npm run test:auth`
- `git diff --check`

未运行 `system all`，未重复预算、压缩、PG、发布或付费调用测试。

`keepsake-media-migration-regression` 在本机因 `sharp` Darwin arm64 原生模块签名与当前进程 Team ID 不一致而未完成，保留为 `partial`。浏览器视觉、移动端、真实 provider 和生产验证未执行，均不写成通过。

## 回滚条件

如预览节点复用导致图片源与项目标识错配、旧 URL 未释放、草稿跨账户残留或现有小物行为回归，先停止候选，回退 `61fe71a` 到 `6fe6a06`；如工程门禁或 TS 边界引入跨域影响，再按提交粒度回退 `6fe6a06`、`39a1a8f`、`2ada266`。回退后只重跑受影响专项，不启动全量系统测试。

本候选只存在本地分支 `feat/v0.5.13.1-stability` 与 `release/v0.5.13.1`，未 push、未打生产标签、未部署。
