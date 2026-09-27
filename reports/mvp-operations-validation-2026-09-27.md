# MVP 运行能力验证（2026-09-27）

## 当前结论

结论：**生产技术发布完成，当前服务 GO**。

- 已在生产直接收紧现有数据目录权限，并完成功能冒烟。
- 已从 OSS 最新备份执行两次真实隔离恢复演练。
- OSS 附件、调用边界、最低飞书告警、恢复工具及三类日志已通过本地和生产验证。
- 代码已提交并推送 Gitee `main`：`908004b50d3f1bba2de49cbb172913913c6543dd`。
- 生产已部署同一提交，Nginx、systemd、应用健康检查和监控定时器正常。
- 8 个现有附件已迁移至私有 OSS，逐文件下载比对一致；本地副本保留作为本次发布回滚材料。

生产当前应用版本为 `908004b50d3f`。

生产 `/etc/for-now.env` 已启用限流、用户额度、私有 OSS 附件和告警阈值，`ATTACHMENT_STORAGE=oss`。飞书测试、真实服务停止告警和恢复通知均投递成功。

技术发布完成不等于可以无条件扩大外部邀请。当前实例仍只建议 5～10 名低并发邀请用户；邀请项目成员以外的用户前，仍应完成 `knowledge/privacy-notice.md` 中的运营主体、联系方式、同意记录、导出和删除路径。

## 生产验证

### 权限修复

- `/srv/for-now/data` 下目录已统一为 `0700`、文件统一为 `0600`。
- `for-now` 服务账户可读取数据，`nobody` 不可读取。
- 未登录附件请求返回 `401`。
- 修复后 `for-now.service` 和健康检查正常。

### OSS 备份恢复

- 最早旧快照因早于注册、缺少 `auth.json` 被验证器正确拒绝。
- 手动生成新一致性快照并成功上传归档与 SHA-256 文件。
- 从 OSS 下载最新归档，校验 SHA-256 一致，解压到临时目录并以隔离端口启动。
- 恢复结果：1 个账户、42 条业务记录、4 个附件引用。
- 使用临时认证会话读取 `/api/state` 成功；附件 HTTP 内容与恢复文件逐字节一致。
- 临时进程和目录已清理，活动生产数据未被替换。
- 部署后再次生成 `for-now-20260927T131012Z.tar.gz` 并演练恢复：1 个账户、42 条记录、4 个附件引用，OSS 附件认证代理读取通过。

### 私有 OSS 附件

- 首次权限验证发现 Bucket 为公共读，测试对象及备份归档可匿名读取；迁移当即暂停。
- Bucket 改为私有并开启阻止公共访问后，旧备份公网访问返回 `403`。
- RAM 角色真实完成随机对象 put/get/delete，匿名访问返回 `403`，测试对象无残留。
- 迁移 8 个本地附件、共 1,417,946 字节；远端对象数和字节数一致，且每个对象下载后与本地副本逐字节相同。
- 应用级 OSS 冒烟通过：上传写入 OSS、应用代理读取一致、实例不落持久文件、匿名访问 `403`，测试对象随后删除。

### 实例容量

- 2 vCPU、1.57 GiB 内存、2 GiB Swap、40 GB 磁盘。
- 观测时可用内存约 498 MiB，磁盘剩余约 23.38 GB，应用数据约 1.98 MB。
- 当前适合约 5～10 名低并发邀请用户；扩大范围前按 `knowledge/operations-capacity.md` 的触发条件复评。

### 外部 AI

- `deepseek-flash` 真实请求成功：HTTP 200，680 ms，官方 usage 为输入 7、输出 1 Token。
- `deepseek-v4-pro` 真实请求成功：HTTP 200，919 ms，官方 usage 为输入 7、输出 1 Token。
- ECS RAM 临时凭据和 `SegmentHDCommonImage` 提交真实成功，证明实例角色和首段分割权限可用。
- 通过官方 VIAPI 客户端执行 `GetAsyncJobResult` 成功；端到端分割经过 2 次轮询，在 11.9 秒内下载 10,093,007 字节的有效 PNG。

### 隔离应用集成

在生产机 `/var/tmp` 启动当前工作区的隔离临时实例，使用独立空数据目录和端口，不切换活动服务、不修改活动数据。结果：

- 通过应用 `/api/settings/test` 真实调用 DeepSeek 成功，账本记录官方 usage：输入 357、输出 3 Token。
- 通过应用 `/api/keepsakes/segment` 完成提交、2 次轮询和结果下载。
- 10,093,004 字节透明 PNG 经约 13.5 MB Base64 请求成功上传并通过附件 HTTP 逐字节读取，验证了 24 MB 图片/36 MB 请求体修复。
- 系统日志包含 DeepSeek、`SegmentHDCommonImage`、`GetAsyncJobResult` 和结果下载成功事件；操作日志包含图片上传；AI 审计同时包含 DeepSeek 与阿里云开始/终态。
- 共核对 8 个临时数据文件均为 `0600`。临时进程和目录已清理。

### 告警与生产日志

- 飞书 `open.larkoffice.com` 官方 webhook 域名已纳入精确白名单，签名投递测试成功。
- 受控停止 `for-now.service` 后，监控检测到 critical 并发送“严重告警”；应用恢复后发送“已恢复”，监控状态重新为 success。
- 生产无效登录请求生成同一 trace 的系统和操作日志；两类日志权限均为 `0600`，测试密码、飞书 webhook 和 secret 均未出现。
- 真实 DeepSeek 与阿里云 AI 审计已在生产机隔离实例中验证；活动账户需在用户下一次主动 AI 操作后产生正式账户流水。

## 本地实现与自动化验证

| 能力 | 自动化证据 | 结果 |
| --- | --- | --- |
| 主业务 | `npm test` | 通过 |
| 认证与账户隔离 | `npm run test:auth` | 通过 |
| 三类日志、用量与失败边界 | `npm run test:observability` | 通过 |
| 本地/模拟 OSS 附件后端 | `npm run test:storage` | 通过 |
| AI/分割速率与并发、用户次数/费用、附件额度 | `npm run test:boundaries` | 通过 |
| 服务/磁盘/备份/AI 失败/费用、飞书签名、去重与恢复 | `npm run test:monitor` | 通过 |
| 恢复数据验证器 | `npm run test:restore` | 通过 |
| 部署候选与失败回滚 | `npm run test:deploy` | 通过 |
| 浏览器功能与桌面/移动布局 | `npm run test:ui` | 页面断言通过；Chrome 结束后被 TRAE 沙箱拦截外部 Crashpad 路径，进程码为 1 |

本地 gate 默认值：

- DeepSeek：20 QPS、20 在途。
- 阿里云分割：5 QPS、5 在途。
- 每用户：200 次 DeepSeek/UTC 日、2 USD/UTC 日、1 GiB 附件。

供应商上限记录、费用边界和多实例限制见 `knowledge/operations-capacity.md`。

## 发布后状态

- 公网 `/now/readyz=200`，未登录附件请求 `401`，OSS 备份与附件匿名访问 `403`。
- `for-now.service`、`for-now-backup.timer`、`for-now-monitor.timer` 均 active；应用 `NRestarts=0`。
- 应用内存约 34 MiB，`MemoryHigh=512 MiB`、`MemoryMax=768 MiB`、`TasksMax=128` 已生效。
- `/srv/for-now/data` 目录和文件分别保持 `0700/0600`。
- 部署后 journal 未发现 OOM、未捕获异常、存储读写失败或日志写入失败。
- 工作区另有用户正在进行的产品图和文档修改，本次未改动、未提交或回退。
