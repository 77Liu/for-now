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

本轮公网中台与主应用同机部署，`for-now-platform.service` 的 systemd 边界为 `MemoryHigh=128M`、`MemoryMax=192M`、`TasksMax=64`。它按 10 秒缓存读取主应用脱敏聚合，监听回环 `4280`，不读取业务数据目录。2026-09-28 上线前只读复核时同机可用内存约 476 MiB、Swap 未使用；若可用内存持续低于 300 MiB、出现 Swap 持续增长或任一 OOM，立即回滚中台并停止放量。`for-now-monitor.timer` 同时检查中台 systemd 和 `/readyz`，任一失败进入严重告警。

2026-09-30 02:40（Asia/Shanghai）v0.2.0 发布前只读复核：主应用与中台均为
`active` 且 `NRestarts=0`，分别占用约 185 MiB 和 72 MiB，Swap 为 0；连续
5 次系统可用内存为 302–303 MiB，距 300 MiB 停止放量阈值仅 2–3 MiB。
服务器尚未安装 PostgreSQL 客户端或服务，也没有 5432 监听。不得在当前
实例上直接同机新增 PostgreSQL 并假设容量足够；最终 GO 前必须由人工选择
托管 PostgreSQL，或先扩容并在目标配置下验证应用、数据库和中台的内存
余量。`aegis.service` 自 2026-08-26 起处于 failed，属于候选发布前已存在
的主机运维问题，需由服务器负责人确认是否恢复或接受。
同次核对中，`for-now-backup.timer` 与 `for-now-monitor.timer` 均启用，最近
备份成功标记为 2026-09-29 03:22:52 +0800，仍在 26 小时告警窗口内；
本机最新归档为 7,226,346 字节、53 个归档条目，配套 SHA-256 校验通过且
未发现绝对路径或 `..` 路径；OSS 中同名归档和校验文件可由最小 RAM 角色
列出，远端校验文件中的 SHA-256 与本机归档一致，匿名读取归档返回 403。
该静态检查不替代发布窗口的新备份、最新 inventory 和隔离恢复演练。
实际证书续期单元为 `snap.certbot.renew.timer`。域名证书有效至
2026-12-28，公网 IP 短期证书有效至 2026-10-03；发布前必须确认短期证书
已按计划续期，不能沿用旧文档中的 `certbot.timer` 单元名。

### 2026-09-30 清理与试装前评估

08:45（Asia/Shanghai）经用户授权清理非保留工作负载：

- `openclaw-gateway.service` 是独立的 root 用户级 OpenClaw 网关，清理前
  cgroup 占用 490,643,456 字节（约 468 MiB）；它未接入当前 Nginx、
  MySQL、`dysf` 或本应用，
  已停止并禁用。
- MySQL 仅有业务库 `olympics_badge` 和账户 `olympic`，无业务连接；
  Olympics 后端本来就没有运行，旧 `olympic-forward` Nginx 配置也未启用。
  `mysql.service` 已正常停止并禁用，数据文件保留，未删除。
- `dysf`、主应用和只读中台继续运行，本地健康检查均通过；复测时三个
  cgroup 分别约 72～80 MiB、114 MiB 和 80 MiB。两轮共 10 次系统可用
  内存采样为 977～990 MiB，Swap 约为 0，内核日志和三个保留服务均无
  OOM 记录。
- `aegis.service` 已确认是阿里云云安全中心客户端。其 systemd 单元仍保留
  2026-08-26 的失败状态，但 `AliYunDunUpdate`、`AliYunDun` 和
  `AliYunDunMonitor` 已于 2026-09-14 重新启动并持续运行，合计常态约
  35～50 MiB。该客户端提供安全心跳、资产/威胁检测和自更新，不因节省内存
  停止；应通过云安全中心控制台 Agent 诊断或官方修复流程恢复服务状态一致性。

清理后，同机 PostgreSQL 16 从“当前无容量”调整为“低并发 MVP 可受控验证”。
应用运行态最多使用两个各 8 连接的池，应用锁占用认证池中的一个槽位；
同机试运行基线为
`max_connections=30`、`shared_buffers=128MB`、`work_mem=4MB`、
`maintenance_work_mem=64MB`、`autovacuum_max_workers=2`，并为数据库设置
约 `MemoryHigh=384M`、`MemoryMax=512M` 的 systemd 边界。该配置只是验收
起点，不是未经测量的生产结论：安装后必须以真实候选完成迁移、备份恢复和
并发/图片链路复测，稳定可用内存不得低于 400 MiB，Swap 不得持续增长。
当前 1.57 GiB 实例可作为 5～10 名邀请用户的最低限度试运行规格；若数据库
长期同机承载，推荐扩至至少 4 GiB，以覆盖应用现有内存上限、数据库维护任务
和图片处理峰值。Ubuntu 22.04 当前软件源只提供 PostgreSQL 14，生产所需
PostgreSQL 16 还需使用受控的 PGDG 软件源或改用托管实例；本次尚未安装。

### 2026-09-30 当前规格 PostgreSQL 受限试装

用户随后选择“当前规格受限试装”。已从官方 PGDG `jammy-pgdg` 源安装
PostgreSQL **16.15**，签名密钥指纹核对通过。安装时阻止包脚本自动启动服务，
未重启现有应用；试装集群为 `16/fornowtrial`，systemd 单元为
`postgresql@16-fornowtrial.service`。集群名不含连字符，以兼容包内 systemd
模板的 `%I` 路径展开。依赖同时将 `libpq5` 更新为 PGDG 18.6；收尾核对未
发现进程继续映射已删除的旧库，三个保留服务进程未变化。

当前实际配置替代上方试装前的配置建议：

| 项目 | 生效值 |
| --- | --- |
| 网络/认证 | 仅 `127.0.0.1:5432` 和本机 Unix socket；TCP SCRAM，Unix peer |
| 最大连接 | 40（30 在迁移/核验连接与测试应用并存时触及保留连接槽；记录失败后改为 40 并重跑全部断言） |
| 内存 | `shared_buffers=128MB`、`work_mem=4MB`、`maintenance_work_mem=64MB`、`autovacuum_work_mem=32MB` |
| 后台维护 | `autovacuum_max_workers=2`，禁用并行查询和 JIT |
| 进程约束 | `MemoryHigh=384M`、`MemoryMax=512M`、`MemorySwapMax=0`、`CPUQuota=100%`、`TasksMax=128` |
| 持久化 | 校验和开启；`fsync`、`full_page_writes`、`synchronous_commit` 全部保持开启 |
| 启动策略 | `start.conf=manual`；当前由 systemd 手动启动，试装阶段不自动随主机启动 |

固定候选 `70b5644ef265440b9f5f4e69868647544f6deff2` 的 42 项真实数据库
断言已在该集群通过。仅将测试启动器从自建临时集群适配为已安装的空试装
集群，业务断言未修改；合成数据覆盖 Store v15、RLS、并发、认证、配置、
附件恢复、单写保护及第二数据库重建。测试进程单独限制为 384 MiB/75% CPU，
仅允许本机网络并屏蔽生产数据/环境文件。期间主机可用内存最低
737.60 MiB，数据库 cgroup 采样峰值 182.96 MiB。

随后执行 pgbench scale 1、17 客户端/2 线程、20 TPS 限速的 90 秒测试：
完成 1,819 次事务，零失败/跳过/超过 1 秒，平均延迟 2.576 ms；
主机可用内存最低 829.72 MiB，数据库 cgroup 采样峰值 134.55 MiB。
321,398 字节的 `pg_dump -Fc` 备份恢复至新库后，四张表全部行的摘要一致；
仅重启 PostgreSQL 后两个库摘要仍一致。测试库/角色和临时管理员密码均已
清理，集群只剩默认库及默认角色。最终数据库 cgroup 的 high/max/OOM 计数
均为 0，试装期间内核日志无 OOM，Swap 未增长。上述限速吞吐不代表应用端到端吞吐，也不构成大量用户或图片峰值放量
结论。随后在 ECS 使用同一 PostgreSQL 16.15 二进制独立重跑持久幂等专项，
精确重放、请求哈希冲突、永久清理后防重复、重启和双进程序列化全部通过；
测试在独立临时集群及 384 MiB/零 Swap cgroup 中运行，仅允许本机网络，
结束后临时集群、候选和依赖均已删除。
机器摘要见 [`ecs-postgres-trial-2026-09-30.json`](../reports/ecs-postgres-trial-2026-09-30.json)。
收尾时已删除服务器上的临时候选源码、依赖和测试脚本，数据库空闲 cgroup
约 50.3 MiB，主机可用内存 890 MiB；主应用、中台、`dysf` 与公网健康检查
通过，OpenClaw 和 MySQL 继续保持停用。

连接池口径：两个池各最多 8 条，合计最多 **16 条**。前述 MySQL
136,368,128 字节约为 130 MiB；主机 MemAvailable 的 MiB 采样不受影响。

截至受限试装阶段，本节只证明安装和合成数据验证，不代表生产迁移或峰值
容量验收；当时尚无正式业务库/角色。后续已完成正式空库/角色及生产备份
隔离恢复，见下方追加记录；生产仍使用 JSON，正式切换仍需发布授权。
当前空试装集群可用 `sudo systemctl stop postgresql@16-fornowtrial` 停止并
释放内存，用 `sudo systemctl start postgresql@16-fornowtrial` 恢复；
正式接管数据后应按生产迁移流程另行配置自动启动、角色、备份和告警。

同日 10:19 只读复核：最新 JSON/附件备份为
`for-now-20260929T192750Z.tar.gz`（本地时间 2026-09-30 03:27），
7,453,657 字节、60 个条目；配套 SHA-256 验证通过，归档无绝对路径或
`..` 路径。备份、监控和证书续期 timer 均启用，最近监控结果无问题；
Nginx 配置通过，域名 HTTPS 200，域名 HTTP 和 IP HTTPS 均 308 跳转。
该本地归档核对仍不替代发布窗口的新备份、OSS 最新 inventory 和生产
PostgreSQL 独立恢复。

### 2026-09-30 生产备份与 OSS 隔离恢复

经人工授权，正式空库 `for_now` 和 owner/schema/migration/data/auth/backup
最小角色已建立；19 张表全部为空，凭据仅保存在 ECS 的
`/etc/for-now-postgres/credentials.json`（目录 `0700`、文件 `0600`），
未写入 `/etc/for-now.env`。角色隔离、恢复角色只读及开户函数事务回滚探针
均通过，数据库保持手动启动。

从 OSS 只读下载最新完成备份 `for-now-20260929T192750Z.tar.gz`，文件
7,453,657 字节、60 个归档条目，SHA-256 与路径安全验证通过。附件前缀共
34 个对象、41,356,740 字节；每个对象均经 `GetObject` 读取并计算 SHA-256。
备份中的 3 个账户引用 30 个附件，全部从 OSS 验证，无本地回退；本轮
OSS 操作只有 List/Get，没有远端写入。

生产备份随后写入第一套隔离数据库，再由只读恢复角色导出包含附件的关系
快照并导入第二套全新数据库。认证、账户 store、设置、用量和附件 inventory
逐项一致；重复导入验真、运行角色、迁移证据、应用锁和全账户读取均通过。
固定候选应用还在第二套恢复库启动，通过 3 个账户共 51 个集合核对，并从
本地物化恢复目录读取 30 个附件、40,647,767 字节，逐文件大小和 SHA-256
一致；未登录请求被拒绝。

演练完成后两套隔离数据库、临时角色/会话、候选依赖、生产快照和下载附件
均已删除。正式库仍为空，生产环境摘要、应用软链接和三个服务 PID 未变化；
收尾可用内存约 857 MiB，Swap 未增长。机器证据见
[`production-postgres-recovery-2026-09-30.json`](../reports/production-postgres-recovery-2026-09-30.json)。
发布窗口仍需冻结更新后的 JSON/OSS、重查变化并完成最终导入；还需先配置
PostgreSQL 自动启动、生产连接、数据库备份与监控。

## 调用与存储边界

| 边界 | 当前默认 | 目的 |
| --- | --- | --- |
| DeepSeek 全局启动速率 | 20 QPS | 避免突发请求压垮实例或触发供应商限流 |
| DeepSeek 全局在途并发 | 20 | 限制连接、内存和文件写队列压力 |
| 阿里云图片分割全局启动速率 | 5 QPS | 低于用户提供的供应商 100 QPS 上限 |
| 阿里云图片分割全局在途并发 | 5 | 控制图片内存、上传、轮询和结果下载压力 |
| 每用户 DeepSeek 调用 | 200 次/UTC 日 | 防止单账户耗尽共享额度 |
| 每用户 DeepSeek 估算费用 | 默认 ¥14.40/UTC 日；`0` 可关闭拦截 | v0.2.0 仅供 Owner 内部测试，生产设为 `0`；用量记账和费用告警仍保留 |
| 每用户持久附件 | 1 GiB | 上传前按 OSS 对象总字节检查 |

供应商额度记录来自用户在 2026-09-27 提供的信息：图片分割 100 次/秒、`deepseek-flash` 2500 次/秒、`deepseek-v4-pro` 500 次/秒。该信息用于后台扩容设计，不代表本系统应该接近这些上限；提高本地阈值前必须重新核对供应商控制台/正式文档并做实例压测。当前费用换算基线为 `1 美元 = ¥7.20`，仅用于把供应商原币账单统一转换为人民币口径。

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
