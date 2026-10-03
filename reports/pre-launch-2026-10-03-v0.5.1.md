# V0.5.1 热修上线门记录

状态：V0.5.0 生产静态资源权限已人工恢复，热修代码与回归已完成；最终 Release
门、标签、Gitee Release 和持久化部署待执行。

## 1. 发布对象

- 基线：`v0.5.0 / b7b8eb6da799666520e5edb4be767a2028c32dae`。
- 热修范围：生产部署目录所有权、可遍历权限、回滚目录权限与版本元数据。
- 数据与 API：无 schema、业务数据、接口或产品行为变化。

## 2. 故障与恢复

- V0.5.0 部署后 `/now/` 与 `/now/today` 返回 200，但 Nginx 直接读取的
  `app.js`、CSS 和 `.mjs` 返回 403，网页无法完成启动。
- `namei` 证据显示 `/opt/for-now`、`releases` 为 0750，活动 release 根为
  0700；Nginx 用户无法遍历 alias 路径。
- Preview 部署器已在候选构建后改为 root 持有、0755 可遍历，生产部署器仍
  保留旧的 `chown -R for-now` 与 `mktemp` 0700 行为，导致环境行为不一致。
- 已立即把生产活动路径的三个目录改为 0755，并在 `nginx -t` 后 reload；
  JS/CSS `.mjs` 恢复 HTTP 200、`application/javascript`，ready 保持 200。

## 3. 修复

- `/opt/for-now` 与 `/opt/for-now/releases` 固定为 `root:root 0755`。
- Git mirror 单独保持 `for-now:for-now 0700`，只读 deploy key 边界不变。
- 候选安装依赖和检查阶段仍由 `for-now` 执行；完成后整个 release 改为
  `root:root`，release 根为 0755。
- 切换前同时规范化当前候选和直接回滚目标，确保回滚后 Nginx 静态 alias
  仍可读取。
- 部署回归新增 base、releases、active release 的 0755 断言，以及所有权
  命令契约。

## 4. 发布核对摘要

### 新功能

- 无。

### Bug 修复

- 修复生产 Nginx 静态 alias 因 release 根目录 0700 而返回 403。

### 架构调整

- 明确生产 Git mirror、不可变 release 与运行数据的不同所有权和权限边界。

## 5. Bug 修复

### 生产静态资源 403

**Bug 描述：** V0.5.0 切换成功后，HTML 与 ready 正常，但浏览器请求 JS/CSS
静态资源返回 403，导致应用无法启动。

**原因：** 新增 Nginx 静态 alias 后，生产部署器仍把 release 根目录保留为
`mktemp` 的 0700；Preview 部署器已有权限处理，但未同步到生产部署器。

**解决方案：** 分离 mirror 与 release 所有权，候选构建完成后转为 root
不可变目录并授予目录遍历权限，同时覆盖直接回滚目标和回归测试。

## 6. 验证与部署

- `bash -n deploy/deploy.sh`：通过。
- `npm run test:deploy`：通过，覆盖成功、依赖失败、restart/health/Nginx
  失败、PostgreSQL 预检、同提交、回滚和目录权限。
- 完整 `npm run test:journeys:release`：待最终候选执行。
- 因已安装部署器本身包含旧逻辑，需先从已推送热修提交提取
  `deploy/deploy.sh` 并校验后安装到 `/usr/local/sbin/for-now-deploy`，
  再部署同一 SHA。
- 部署后必须核对 root、JS、CSS、`.mjs`、Service Worker、ready、认证边界，
  并用新版备份器执行备份与隔离恢复。
