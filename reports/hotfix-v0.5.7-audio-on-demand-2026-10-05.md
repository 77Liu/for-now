# V0.5.7 音频按需加载热修

日期：2026-10-05

状态：**H3 通过；等待热修 push、标签、Release 与部署授权**

生产运行：`v0.5.7@dbb6a0a377d959915d69404bc212b4887b261f56`

热修代码候选：`7ed6286feb1a1d52b2f016690a1827401663696c`

候选 tree：`065e7627ed8c14b338aa59c2738afa948a24f30d`

建议标签：`hotfix-v0.5.7-audio-on-demand`

## 发现与影响

- 发现时间：2026-10-05 12:49 +0800。
- 发现来源：V0.5.7 生产登录态浏览器冒烟。
- 受影响路径：进入“所见 / 念起”且列表包含历史原始录音或已生成 TTS。
- 症状：未点击播放时，Chrome 因 `preload="metadata"` 发出
  `Range: bytes=0-`；生产对一条历史 M4A 返回完整 `1,419,036 B`，重渲染又
  下载一次。
- 影响：违反“点击前音频传输 0 B”的性能合同，增加用户流量与服务器/OSS
  读取压力；未发现数据错写、权限越界、服务不可用或媒体内容损坏。
- 当前控制：不执行数据修复或停服；暂停 V0.5.7 G6 关闭，生产继续运行
  `dbb6a0a`，等待热修发布授权。

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
| Preview / 生产原故障复验 | 待发布授权 |

Release 聚合命令的完整系统套件通过；随后 PostgreSQL 阶段在默认 macOS
Node 24 上触发已知 Sharp 动态库签名限制，错误为
`IMAGE_PROCESSOR_UNAVAILABLE`。这与 V0.5.7 原候选验证时相同。改用项目
`prepareTestNodeBinary` 生成的 ad-hoc 签名 Node 后，AI 预算、PostgreSQL
runtime 和 lifecycle/idempotency 三组测试全部通过。该环境差异不涉及候选代码
或生产依赖。

## 发布与观察

该热修是 `dbb6a0a` 之后的新代码，不复用原候选发布授权。完成 H3 后需向 Owner
提交固定 SHA，并单独取得 push、热修标签、Gitee Release、Preview/生产部署
与重新观察授权。不得移动既有 `v0.5.7` 标签。
