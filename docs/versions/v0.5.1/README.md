# V0.5.1 热修上线门记录

状态：**生产已上线，观察已关闭**。V0.5.1 最终 Release 门、Git/Gitee
发布、生产部署、静态资源复验、部署后备份、隔离恢复和 30 分钟生产观察均已
完成。

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
- 最终 `npm run test:journeys:release`：通过；runId
  `2026-10-03T05-40-48-694Z`，总计 `329334ms`，其中完整系统
  `312173ms`、PostgreSQL 16 `15639ms`、依赖审计 `1522ms / 0 漏洞`。
- 已从推送后的精确提交提取并安装新版
  `/usr/local/sbin/for-now-deploy`，再部署同一 SHA；服务器只读拉取、
  PostgreSQL 权限预检、候选切换和 ready 检查均通过。
- 生产 `/now/`、`/now/today` 为 200，未登录 `/now/api/v1/state` 为 401，
  管理快照为 404；JS、CSS、`.mjs`、Service Worker 均为 200，MIME 和
  gzip 正确。

## 7. Git 与发布对象

- 最终提交：
  `810a8a694fbd4f88fee4ffc98b28061e5f6c6096`。
- 发布时 `origin/main`、annotated tag `v0.5.1` 和
  `origin/preview/v0.5.1` 均指向该提交；观察完成后的文档提交只推进
  `main`，不重打标签、不重部署。
- Gitee Release：`v0.5.1`，ID `1181158`，非预发布：
  <https://gitee.com/Liu_772021/for-now/releases/tag/v0.5.1>。
- V0.5.0 Release ID `1181137` 已标记“已由 V0.5.1 取代”，不把静态资源
  403 的短暂部署描述为可正常使用的最终生产版本。

## 8. 部署后备份与恢复

- 新版备份器生成
  `for-now-20261003T054849Z.tar.gz`，大小 `66,413,277` 字节；命令只有在
  主服务恢复 ready、OSS 上传和本地清理完成后才返回成功。
- 隔离恢复通过归档 SHA-256、导出清单哈希和全站 AI 预算校验。
- 恢复结果为 4 个账户、193 条总记录、公开 API 190 条记录、41 个附件引用、
  45 个附件；候选服务的附件 HTTP 读取通过。

## 9. 性能与客户端边界

- V0.5.0 Preview 基准为当前屏反馈 `430.5ms`、stableHome `786.8ms`。
- V0.5.1 公网冷加载保留两次机器样本：`596.2ms / 912.7ms` 未通过 500ms
  反馈门，复测 `481.3ms / 967.4ms` 通过；不得删除首个失败样本或把单次
  复测表述为稳定 P95。
- iOS 未签名设备包：
  `artifacts/ios/cike-0.5.1-ios-device-unsigned.zip`，大小
  `5,503,525` 字节，SHA-256
  `35dc704caca3ff6b0e2eaac39ea1a71c5c35aa1e397fb96017f5354362f6e8cd`。
- 物理 iPhone 当前离线，V0.5.1 未重新执行真机 WKWebView 测试；网页与
  iOS 包构建证据不能替代真机结论。

## 10. 生产观察

- 观察区间：`2026-10-03T05:52:44Z` 至 `06:22:47Z`，共 31 个一分钟样本。
- PID 始终为 `499882`，PID 变化 0，`NRestarts=0`；31 次服务状态均为
  `active`，31 次本机 ready 均为 200。
- RSS 最低 `73,568,256` 字节（70.2 MiB），最高和末值均为
  `152,592,384` 字节（145.5 MiB），低于 400 MiB 告警线。窗口内存在实际
  媒体请求和阶梯抬升，30 分钟结果不外推为长期无泄漏证明。
- 系统可用内存最低 `768,800 KiB`（750.8 MiB），根分区始终为 48%。
- Nginx 访问日志中 `/now/` 5xx 为 0，错误日志中生产路径错误为 0；窗口内
  另有 2 条外部 TLS 握手异常，与应用路径无关。
- 应用日志出现 1 次后台火山 ASR `SPEECH_UNAVAILABLE`。入口请求正常返回
  202，同一既有录音在上一版本也有相同失败记录，未伴随服务异常或 HTTP 5xx，
  保留为用户可重试的上游失败，不判定为本次热修回归。
- 应用日志另有 32 条阿里 OSS SDK 的 STS 自动刷新建议。当前实现每次操作先
  取得新凭据再创建短生命周期客户端，未发生鉴权失败；该项属于日志降噪遗留。
- 手动运行 `for-now-monitor.service` 成功，返回
  `{"ok":true,"testAlert":false,"issues":[]}`。
- 观察结束后生产仍为 `active`、`NRestarts=0`、ready 版本
  `810a8a694fbd`；Preview 同版本且保持 active，用户 0、会话 0、业务记录 0、
  附件 0，仅保留内置默认配置。
