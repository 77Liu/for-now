# MVP 运行能力验证（2026-09-27）

## 当前结论

结论：**生产部分完成，完整发布仍为 BLOCKED**。

- 已在生产直接收紧现有数据目录权限，并完成功能冒烟。
- 已从 OSS 最新备份执行真实隔离恢复演练。
- OSS 附件、调用边界、最低飞书告警和恢复工具已在本地实现并通过专项回归。
- 尚未部署本工作区版本。生产 OSS 附件写入被 RAM 权限阻断；飞书真实投递缺少 webhook。

生产当前应用版本仍为 `9eb7f067d52b`。

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

## 外部阻断

### OSS RAM 权限

实际测试确认 ECS RAM 角色能列出 `for-now-attachments` 前缀，但 `PutObject` 返回 `403 AccessDenied`。需要为 `acs:oss:*:*:for-now/for-now-attachments/*` 增加最小 `GetObject/PutObject/DeleteObject` 权限，并限制桶级 `ListObjects` 到该前缀。

权限更新后的验收顺序：

1. 在服务器执行 `scripts/oss-attachment-smoke.mjs`，真实验证 put/get/匿名拒绝/delete。
2. 停止应用写入，执行 `for-now-migrate-attachments`。
3. 核对对象数和字节数后设置 `ATTACHMENT_STORAGE=oss`。
4. 启动应用，验证上传、鉴权读取、书封、健康截图和小物原图/轮廓。
5. 保留本地附件作为本次发布回滚副本。

### 飞书

服务器尚无 `FEISHU_ALERT_WEBHOOK`。需要用户创建飞书自定义机器人并提供 webhook；若机器人开启签名校验，同时提供 secret。配置写入服务器 `/etc/for-now.env`，不得写入 Git、报告或聊天回显。

配置后的验收顺序：

1. 执行 `monitor-health.mjs --test-alert` 并确认用户实际收到。
2. 启动 monitor service，核对状态文件为 `0600`。
3. 通过受控测试触发服务失败告警，再恢复并确认恢复消息。

## 发布后必验

- `/readyz`、版本号、注册/登录、现有账户和记录。
- 通过应用链路再次调用 DeepSeek Flash/Pro，并核对官方 usage 落入账户账本。
- 通过部署后的应用 API 再次完成阿里云分割，并核对三类日志关联。
- OSS 新图片 put/get、匿名拒绝、delete 和旧本地附件回退。
- 系统、操作、AI 三类日志的权限、脱敏及 `traceId / callGroupId / callId` 关联。
- 飞书真实告警与恢复通知。
- 最新备份后的第二次恢复演练。
- 30 分钟观察窗口内无持久化错误、账户串写、持续失败、OOM 或异常费用。
