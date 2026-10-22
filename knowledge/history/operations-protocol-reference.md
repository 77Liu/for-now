# 历史调用、附件与运维说明

2026-10-17 从运维正文迁出。保留原默认值、协议与实测记录供追溯；其中旧版本状态、阈值和命令不作为当前执行依据。当前入口见[运维地图](../operations-capacity.md)。

## 调用与存储边界

| 边界 | 当前默认 | 目的 |
| --- | --- | --- |
| DeepSeek 全局启动速率 | 20 QPS | 避免突发请求压垮实例或触发供应商限流 |
| DeepSeek 全局在途并发 | 20 | 限制连接、内存和文件写队列压力 |
| 阿里云图片分割全局启动速率 | 5 QPS | 低于用户提供的供应商 100 QPS 上限 |
| 阿里云图片分割全局在途并发 | 5 | 控制图片内存、上传、轮询和结果下载压力 |
| 火山语音全局启动速率 | 5 QPS | TTS 与 ASR 共用保守入口，待真实压测后再调整 |
| 火山语音全局在途并发 | 5 | 控制长连接、音频内存与供应商请求压力 |
| 火山通用 OCR 全局启动速率/在途并发 | 10 / 10 | 不超过正式服务默认 10 QPS |
| 火山智能文档解析全局启动速率/在途并发 | 2 / 2 | 不超过正式服务默认 2 QPS |
| 每用户第三方调用 | 200 次/UTC 日 | 覆盖 DeepSeek、TTS、ASR、OCR、文档解析与图片分割，防止单账户耗尽共享额度 |
| 每用户已知费用 | 生产当前为 ¥14.40/UTC 日；`0` 可关闭兼容账户预检 | 全站预算已接入真实调用链；V0.5.8 工作区新增 TTS、ASR、OCR、文档解析和图片分割官方目录价预留/结算，尚未部署 |
| 每用户持久附件 | 1 GiB | 上传前按 OSS 对象总字节检查 |

供应商额度记录来自用户在 2026-09-27 提供的信息：图片分割 100 次/秒、`deepseek-flash` 2500 次/秒、`deepseek-v4-pro` 500 次/秒；火山视觉官方文档记录通用 OCR 正式服务默认 10 QPS、智能文档解析默认 2 QPS。该信息用于后台扩容设计，不代表本系统应该接近这些上限；提高本地阈值前必须重新核对供应商控制台/正式文档并做实例压测。DeepSeek 新调用直接使用中国区人民币单价；`1 美元 = ¥7.20` 仅作为旧美元账本的默认展示换算值。

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
- 费用额度使用已完成落账的 DeepSeek 与已映射非 Token 服务估算费用；站点任务
  在供应商 I/O 前做原子预留，兼容账户账本仍可能因多个并发请求短暂越线，
  因此整体是成本护栏，不是供应商侧强事务预付费系统。
- 附件额度在上传前检查，并按账户串行化“查询用量 + 写入”，避免同一进程内并发穿透。OSS 列表或上传失败时不写业务路径。
- 用户选择的原图和识别输入单张限制 8 MB，一次选择合计限制 48 MB；这是覆盖常规手机图片批次的产品阈值，不覆盖专业相机原片，也不是单请求载荷上限。批次由浏览器逐张上传和处理；浏览器生成的小物透明 PNG 最多 24 MB，对应单次上传请求体最多 36 MB。Nginx `/now/` 入口上限为 36 MB，服务端除附件上传外的 JSON API 仍限制 12 MB。
- 火山 ASR 不接收应用私有附件 URL：服务端从账户隔离存储读取音频后，经 WebSocket 二进制协议直接发送。M4A、MP3、Ogg 和 WAV 可进入该链路；WebM 原件继续保留，但在完成受控转码方案前不会伪装成其他格式送入供应商。
- 火山视觉请求使用 `cv / cn-north-1` 的 V4 签名；通用 OCR 与智能文档解析使用独立限流队列。生产应使用最小权限子用户 AK/SK，不应把主账号长期密钥作为常态方案。
- 当前没有用户自助清理孤立附件的完整机制。产品开放前应补充记录删除后的引用计数或定期孤立对象清理。

## 图片与 OSS

目标架构：

- 文字、结构化记录、账户数据、用量账本和日志保存在 `/srv/for-now/data`。
- 所有持久图片以私有对象保存到 `oss://for-now/for-now-attachments/<user-id>/`。
- 浏览器不接触 OSS 凭据和公开 URL；登录后的应用从 OSS 读取并代理响应。
- 送往 DeepSeek 或阿里云分割的图片只在 `/srv/for-now/data/.../tmp/` 形成 `0600` 临时文件，请求完成后删除。
- 读取对象不存在时暂时允许回退到旧本地附件，以支持迁移窗口；迁移确认后再决定何时移除回退。

2026-09-27 已完成生产迁移：ECS RAM 角色对附件前缀的 list/put/get/delete 均通过，Bucket 已改为私有并阻止公共访问；8 个现有附件共 1,417,946 字节已迁移并逐文件下载比对一致，生产已设置 `ATTACHMENT_STORAGE=oss`。本地附件副本暂时保留作为本次发布回滚材料。

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

应用不设置对象公开 ACL，依赖桶保持私有。当前已确认桶私有、阻止公共访问且匿名读取返回 `403`；HTTPS、服务端加密和生命周期规则仍需在 OSS 控制台持续核实。

权限或存储配置变更后，在服务器执行 `scripts/oss-attachment-smoke.mjs`。脚本使用 RAM 角色写入随机对象、鉴权读取、验证匿名读取不成功、删除并确认对象消失；无论中途成功或失败都会尽力清理测试对象。2026-09-27 生产实测全部通过且测试对象无残留；无凭据输出的完整命令见 `deploy/README.md`。

## 告警

`for-now-monitor.timer` 每 5 分钟执行一次，状态变化立即通知，同一问题默认每 60 分钟重复一次，恢复后发送恢复消息。

| 告警 | warning | critical |
| --- | --- | --- |
| 服务 | 不适用 | systemd 非 active 或 `/readyz` 失败 |
| 公网中台 | 不适用 | `for-now-platform.service` 非 active 或生产聚合 `/readyz` 失败 |
| 磁盘 | 使用率 ≥ 70% | 使用率 ≥ 85% |
| 备份 | 不适用 | 无成功标记或最近成功备份超过 26 小时 |
| AI 连续失败 | 最近连续失败 ≥ 5 次 | 暂不升级 |
| AI 当日费用 | 全部账户合计 ≥ ¥36.00 | 暂不升级 |

AI 当日费用在 JSON 模式读取各账户 `ai-usage.json`，在 PostgreSQL 模式通过
`PG_BACKUP_DATABASE_URL` 的只读恢复角色汇总；数据库读取失败不得回退为
零。DeepSeek 新人民币费用、其他已知人民币费用与历史美元账本换算值合并
计算；未映射的供应商动作另计 `costUnknownCalls`。V0.5.8 工作区已映射 TTS、
流式 ASR、OCR、文档解析和阿里云分割，目录价与实际账单的资源包、阶梯价、
免费额度和合同折扣差异仍需账单核对。

告警发送到 `FEISHU_ALERT_WEBHOOK` 指向的飞书自定义机器人；启用签名校验时同时配置 `FEISHU_ALERT_SECRET`。代码只接受飞书或 Lark 官方 HTTPS webhook 域名，不在日志或命令输出中显示 URL。

2026-09-27 已完成生产真实投递：测试消息成功；受控停止 `for-now.service` 后严重告警送达，服务恢复后恢复通知送达。

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
