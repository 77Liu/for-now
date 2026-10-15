# V0.5.7 音频按需加载热修

日期：2026-10-05

状态：**H4 已发布并完成观察；继续运行**

生产运行：`v0.5.7@2c395c0295404a6c7bd5a076bb66b11c6e72c3f2`

前一生产提交：`v0.5.7@dbb6a0a377d959915d69404bc212b4887b261f56`

热修代码候选：`7ed6286feb1a1d52b2f016690a1827401663696c`

候选 tree：`065e7627ed8c14b338aa59c2738afa948a24f30d`

标签：`hotfix-v0.5.7-audio-on-demand`

Gitee Release：<https://gitee.com/Liu_772021/for-now/releases/tag/hotfix-v0.5.7-audio-on-demand>

## 发现与影响

- 发现时间：2026-10-05 12:49 +0800。
- 发现来源：V0.5.7 生产登录态浏览器冒烟。
- 受影响路径：进入“所见 / 念起”且列表包含历史原始录音或已生成 TTS。
- 症状：未点击播放时，Chrome 因 `preload="metadata"` 发出
  `Range: bytes=0-`；生产对一条历史 M4A 返回完整 `1,419,036 B`，重渲染又
  下载一次。
- 影响：违反“点击前音频传输 0 B”的性能合同，增加用户流量与服务器/OSS
  读取压力；未发现数据错写、权限越界、服务不可用或媒体内容损坏。
- 控制措施：未执行数据修复；V0.5.7 G6 在热修重新观察完成前保持开启，
  当前已满足关闭条件。

## 根因

原始录音和持久化 TTS 的两个播放器模板均使用 `preload="metadata"`。真实
Chrome 为读取时长请求 `bytes=0-`，而该范围合法表示完整对象，因此服务按
Range 合同返回完整音频。

既有固定性能门只覆盖首页启动时的点击前媒体传输，测试数据没有在当前路由挂载
历史录音；UI 回归只检查播放器存在与 URL，没有检查预加载属性或真实浏览器
网络事件，因此没有阻止该回归。

## 最小修复

- 原始录音播放器改为 `preload="none"`。
- 持久化 TTS 播放器改为 `preload="none"`。
- UI 回归通过 CDP 监听真实网络：进入含历史录音和 TTS 的念起列表后，在播放
  点击前不得出现 `.m4a` 或 `/api/speech/audio` 请求。
- 不修改媒体 URL、播放控件、Range 服务、持久化数据或第三方供应商协议。

## 针对性验证

| 验证 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm run test:ui` | 通过；新增真实浏览器零音频请求断言 |
| `npm run test:mobile` | 通过 |
| `node scripts/attachment-range-regression.mjs` | 通过 |
| `npm run test:deploy` | 通过 |
| `npm run test:web-budget` | 通过；点击前媒体传输 `0 B` |
| 完整隔离系统套件 | 通过 |
| PostgreSQL 16.14 stable | 通过；使用项目 ad-hoc 签名 Node |
| `npm audit --omit=dev` | 通过；0 漏洞 |
| Preview / 生产原故障复验 | 通过 |

Release 聚合命令的完整系统套件通过；随后 PostgreSQL 阶段在默认 macOS
Node 24 上触发已知 Sharp 动态库签名限制，错误为
`IMAGE_PROCESSOR_UNAVAILABLE`。这与 V0.5.7 原候选验证时相同。改用项目
`prepareTestNodeBinary` 生成的 ad-hoc 签名 Node 后，AI 预算、PostgreSQL
runtime 和 lifecycle/idempotency 三组测试全部通过。该环境差异不涉及候选代码
或生产依赖。

## 发布与观察

- Owner 已单独授权热修上线；`main`、`preview/v0.5.7` 和功能分支均推送到
  `2c395c0`。
- annotated tag `hotfix-v0.5.7-audio-on-demand` 与正式 Gitee Release
  `1183910` 均固定到 `2c395c0`；既有 `v0.5.7` 标签继续固定在 `dbb6a0a`，
  未移动。
- Preview 于 13:09 +0800 部署 `2c395c0`。真实登录态进入含历史 M4A 的念起
  列表后，播放前原始录音和 TTS 请求均为 0；点击播放后返回 `206`，页面无
  横向溢出、控制台或运行时错误。
- 生产于 13:12 +0800 部署 `2c395c0`，`readyz` / `healthz`、运行目录和
  systemd SHA 一致。生产真实账户复验同样为播放前 0 请求，点击原始录音和
  TTS 后才返回 `206` 并正常播放。
- 生产观察从 13:15:35 至 13:45:39 +0800，共 31 个一分钟样本、持续
  30 分 04 秒。PID 始终为 `636534`，`NRestarts=0`，全部 ready 响应均为
  `2c395c029540`。
- RSS 为 `99.96–122.67 MiB`，最低可用内存约 `767 MiB`，Swap 使用量为 0，
  磁盘使用率保持 56%。
- 热修激活后 Nginx 5xx、应用 warning/error 和内核 OOM 均为 0；中段与末段
  monitor 均返回 `issues: []`。浏览器保持念起页面约 20 分钟并经历多轮同步
  后，未再次发起 M4A 或 TTS 音频请求。
- 飞书 Base 已关闭 17 条 V0.5.7 需求和 11 条本版本交付；需求表
  `rev=342 / 235`，交付表 `rev=104 / 83`。结论为热修继续运行，V0.5.7
  进入 G6/G7 关闭。
