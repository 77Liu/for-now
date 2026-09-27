# 运行边界与运维

本文档是当前容量假设、限额、告警、OSS 附件和恢复演练的单一事实来源。配置默认值以 `deploy/for-now.env.example` 为准；生产是否已启用必须以服务器实测为准。

## 当前实例基线

2026-09-27 对生产 ECS 的只读观测结果：

| 项目 | 观测值 |
| --- | --- |
| CPU | 2 vCPU，观测负载约 0.11 |
| 内存 | 总计约 1.57 GiB，可用约 498 MiB；Node 服务 RSS 约 69 MiB |
| Swap | 2 GiB，接近未使用 |
| 磁盘 | 40 GB，剩余约 23.38 GB |
| 应用数据 | 约 1.98 MB |
| 单个 release | 约 33 MB |
| systemd journal | 约 568 MB |
| 稳定性 | `for-now.service` active，`NRestarts=0`，近 30 天未见 OOM |

当前实例适合约 5～10 名邀请用户的低并发 MVP，不适合未经压测直接开放放量。主要约束不是供应商额度，而是 1.57 GiB 内存、单 Node 进程、文件型 JSON 全量读写和同机其他进程占用。

## 调用与存储边界

| 边界 | 当前默认 | 目的 |
| --- | --- | --- |
| DeepSeek 全局启动速率 | 20 QPS | 避免突发请求压垮实例或触发供应商限流 |
| DeepSeek 全局在途并发 | 20 | 限制连接、内存和文件写队列压力 |
| 阿里云图片分割全局启动速率 | 5 QPS | 低于用户提供的供应商 100 QPS 上限 |
| 阿里云图片分割全局在途并发 | 5 | 控制图片内存、上传、轮询和结果下载压力 |
| 每用户 DeepSeek 调用 | 200 次/UTC 日 | 防止单账户耗尽共享额度 |
| 每用户 DeepSeek 估算费用 | 2 USD/UTC 日 | 到达已落账费用后拒绝新调用 |
| 每用户持久附件 | 1 GiB | 上传前按 OSS 对象总字节检查 |

供应商额度记录来自用户在 2026-09-27 提供的信息：图片分割 100 次/秒、`deepseek-flash` 2500 次/秒、`deepseek-v4-pro` 500 次/秒。该信息用于后台扩容设计，不代表本系统应该接近这些上限；提高本地阈值前必须重新核对供应商控制台/正式文档并做实例压测。

当前 gate 为单进程内存队列，只约束单实例。扩为多实例前必须改成共享限流和共享额度账本，不能把每个实例都配置为同一全局上限。

2026-09-27 生产网络实测：

- `deepseek-flash` 返回 HTTP 200，680 ms，官方 usage 为输入 7、输出 1 Token。
- `deepseek-v4-pro` 返回 HTTP 200，919 ms，官方 usage 为输入 7、输出 1 Token。
- ECS RAM 临时凭据可用，`SegmentHDCommonImage` 提交成功并返回异步 `requestId`。
- 通过官方 VIAPI 客户端轮询 `GetAsyncJobResult` 成功；完整测试经过 2 次轮询，在 11.9 秒内取得并下载 10,093,007 字节的有效 PNG。若错误地向 imageseg endpoint 查询同名动作会返回 403，因此两个 SDK 客户端不能混用。

当前分割链路使用的最小动作：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "viapi-imageseg:SegmentHDCommonImage",
        "viapi:GetAsyncJobResult"
      ],
      "Resource": "*"
    }
  ]
}
```

阿里云接口参考：`https://help.aliyun.com/zh/viapi/developer-reference/api-universal-hd-split`；RAM 细粒度授权参考：`https://help.aliyun.com/zh/viapi/developer-reference/use-ram-policy-access-control`。

## 限额行为

- QPS 使用滚动 1 秒启动窗口；超过后排队，不直接丢弃。
- 并发以供应商请求实际在途数计算，完成或失败后释放。
- 每用户调用次数包含成功、失败和自动重试，因为它们都是真实供应商请求。
- 费用额度使用已完成落账的 DeepSeek 估算费用；多个并发请求可能在完成前短暂越过费用线，因此它是成本护栏，不是强事务预付费系统。
- 附件额度在上传前检查，并按账户串行化“查询用量 + 写入”，避免同一进程内并发穿透。OSS 列表或上传失败时不写业务路径。
- 用户选择的原图和识别输入保持 8 MB 限制；浏览器生成的小物透明 PNG 最多 24 MB，对应上传请求体最多 36 MB。Nginx `/now/` 入口上限为 36 MB，服务端除附件上传外的 JSON API 仍限制 12 MB。
- 当前没有用户自助清理孤立附件的完整机制。产品开放前应补充记录删除后的引用计数或定期孤立对象清理。

## 图片与 OSS

目标架构：

- 文字、结构化记录、账户数据、用量账本和日志保存在 `/srv/for-now/data`。
- 所有持久图片以私有对象保存到 `oss://for-now/for-now-attachments/<user-id>/`。
- 浏览器不接触 OSS 凭据和公开 URL；登录后的应用从 OSS 读取并代理响应。
- 送往 DeepSeek 或阿里云分割的图片只在 `/srv/for-now/data/.../tmp/` 形成 `0600` 临时文件，请求完成后删除。
- 读取对象不存在时暂时允许回退到旧本地附件，以支持迁移窗口；迁移确认后再决定何时移除回退。

生产迁移当前受阻：ECS RAM 角色可以列出附件前缀，但对该前缀的 `PutObject` 返回 `403 AccessDenied`。在权限修复并完成真实 put/get/delete 前，不得设置 `ATTACHMENT_STORAGE=oss` 或删除本地附件。

附件前缀所需最小权限应与备份前缀分开：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:GetObject", "oss:PutObject", "oss:DeleteObject"],
      "Resource": ["acs:oss:*:*:for-now/for-now-attachments/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["oss:ListObjects"],
      "Resource": ["acs:oss:*:*:for-now"],
      "Condition": {
        "StringLike": {
          "oss:Prefix": ["for-now-attachments/*"]
        }
      }
    }
  ]
}
```

应用不设置对象公开 ACL，依赖桶保持私有。正式启用前需在 OSS 控制台确认桶 ACL 为私有、HTTPS、服务端加密和生命周期规则。

权限更新后，在服务器执行 `scripts/oss-attachment-smoke.mjs`。脚本使用 RAM 角色写入随机对象、鉴权读取、验证匿名读取不成功、删除并确认对象消失；无论中途成功或失败都会尽力清理测试对象。无凭据输出的完整命令见 `deploy/README.md`。

## 告警

`for-now-monitor.timer` 每 5 分钟执行一次，状态变化立即通知，同一问题默认每 60 分钟重复一次，恢复后发送恢复消息。

| 告警 | warning | critical |
| --- | --- | --- |
| 服务 | 不适用 | systemd 非 active 或 `/readyz` 失败 |
| 磁盘 | 使用率 ≥ 70% | 使用率 ≥ 85% |
| 备份 | 不适用 | 无成功标记或最近成功备份超过 26 小时 |
| AI 连续失败 | 最近连续失败 ≥ 5 次 | 暂不升级 |
| AI 当日费用 | 全部账户合计 ≥ 5 USD | 暂不升级 |

告警发送到 `FEISHU_ALERT_WEBHOOK` 指向的飞书自定义机器人；启用签名校验时同时配置 `FEISHU_ALERT_SECRET`。代码只接受飞书或 Lark 官方 HTTPS webhook 域名，不在日志或命令输出中显示 URL。

配置后执行一次真实投递测试：

```bash
sudo /bin/bash -c '
  set -a
  source /etc/for-now.env
  set +a
  exec runuser --preserve-environment -u for-now -- \
    /usr/local/bin/node /opt/for-now/app/scripts/monitor-health.mjs --test-alert
'
```

收到测试消息后再启用定时器：

```bash
sudo systemctl enable --now for-now-monitor.timer
sudo systemctl start for-now-monitor.service
sudo systemctl status for-now-monitor.service --no-pager
```

## 备份与恢复

- `for-now-backup.timer` 每日生成停止写入后的完整数据快照、SHA-256 文件并上传 OSS；只有两个对象都上传成功才更新时间戳。
- 本机备份保留 7 天；OSS 生命周期需在控制台核实。
- `for-now-restore-drill` 下载最新 OSS 快照，验证 SHA-256，解压到 `/var/tmp`，收紧为目录 `0700`/文件 `0600`，创建一小时临时会话，在隔离端口启动应用并核对账户、记录及附件 HTTP 读取，最后终止进程组并删除临时目录。
- 2026-09-27 已完成一次真实演练：新快照下载校验一致，临时实例恢复 1 个账户、42 条记录和 4 个附件，认证 API 与附件逐字节比对通过。最早的旧快照早于注册数据，因缺少 `auth.json` 被正确拒绝。

生产复测命令：

```bash
sudo /usr/local/sbin/for-now-backup
sudo /usr/local/sbin/for-now-restore-drill
```

恢复演练不修改活动数据和活动服务。任何演练失败都应保留原 OSS 对象，并先检查 checksum、归档结构、RAM 权限、端口占用和临时实例日志。

## 扩容触发条件

达到任一条件时先停止扩大邀请范围并复评：

- 可用内存持续低于 300 MiB、发生 OOM、Swap 持续增长，或 Node RSS 持续超过 400 MiB。
- 磁盘达到 70%，或按最近 7 天增长速度预计 14 天内达到 70%。
- AI P95 端到端延迟连续一小时超过 60 秒，或失败率连续 15 分钟超过 10%。
- JSON 数据或用量账本导致常规写请求 P95 超过 500 ms。
- 活跃用户超过 10 人，或出现稳定的多用户同时图片处理。

扩容顺序应先做指标和压测，再处理图片直传/签名 URL、共享限流与账本、数据库迁移和多实例；不要只提高 QPS 环境变量。
