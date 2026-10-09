# v0.5.10+hotfix.1 版本显示修正记录（生产观察窗口起始：2026-10-09 UTC）

## 发行说明（唯一正文来源，已发布）

# v0.5.10+hotfix.1 · Web

发行日期：2026-10-10（Asia/Shanghai）
相对版本：v0.5.10

本版修正网页仍显示旧版本号的问题，产品页脚继续显示 `v0.5.10`。

## 修复
- **版本显示**：首次 v0.5.10 部署后，页面仍标为 `v0.5.9`；本次为该发布创建独立热修标签，统一应用包、运行时、页面版本与 Service Worker 缓存身份，页面更新后显示 `v0.5.10`。仍停留在旧页面时刷新一次。

## 已知限制
- 本次只发布 Web/PWA 版本；iOS 工程版本元数据同步为 `0.5.10`、build `7`，未生成、签名或分发 iOS 制品。
- 首次 v0.5.10 的 AI 空正文上游根因仍未确认；本热修不改变 AI 行为。

## 发布对象与范围

- 上线前生产基线：`5ce8c1a14f43cf6182faee1968b5711e43167f59`（v0.5.10）。
- 修正候选分支：`codex/v0.5.10-minimum`。
- 修正包版本：`0.5.10+hotfix.1`；新增独立 annotated tag：`v0.5.10+hotfix.1`。已有 `v0.5.10` tag 与对应 Release 保持原指向。
- 候选提交：`1189b0300ceaeaf04282561dab6e3ab1c14f741f`；tree：`8b89736629a9bfb1e0df32f787081ca075573fd9`。
- 产品行为范围仅为版本元数据、Web/PWA 标签和缓存身份，以及 iOS 项目的版本/build 元数据；不改 API、数据、权限、存储、schema 或外部供应商调用。
- 用户截图证实页脚仍显示 `v0.5.9`。代码核对发现 package、Web 静态标签、运行时默认值和 Service Worker 缓存名均沿用了 `0.5.9`；首次 `.10` 标签没有同步这些版本字段。

## 验证与复审

- `node scripts/pwa-regression.mjs`：通过；覆盖 package/lock 版本、两处 Web 标签、运行时与会话默认值、Service Worker cache key、iOS 四处 marketing/build 值。
- `node scripts/frontend-basic-surfaces-feature-regression.mjs`：通过；另断言 SemVer build metadata `+hotfix.1` 在产品页脚隐藏，显示为 `v0.5.10`。
- `node scripts/mobile-platform-regression.mjs`：初次通过；提交后的两次复跑分别在移动端旅程的后续内容渲染断言、键盘高度断言失败（预期 `430`、实得 `437`）。本次版本修正不涉及这些交互；保留为未稳定通过，不记作通过。
- `plutil -lint ios/App/App.xcodeproj/project.pbxproj`：通过。
- `git diff --check`：通过。
- 独立只读 review：GO。Review 确认产品页脚从 `0.5.10+hotfix.1` 显示基版本 `v0.5.10`、服务端保留完整 build identity；SemVer build metadata 不用于版本排序。
- `scripts/system-test.mjs all` 曾在未冻结工作树上执行。第一次因当前运行环境无 `npm` 可执行文件，在提交门回归处中断；使用已配置 bundled pnpm 的兼容入口再次运行后，冻结回放源检查因未提交的 `package.json` 与 `HEAD` 不一致而失败。保留该失败结果；未改旧回放基线，按交接要求不再重跑无关全系统/AI 回放或费用矩阵。该结果不记为全系统通过。
- 本次候选发布验证所用环境未安装 `xcodebuild`，故当时未生成 iOS Simulator 制品；本次仍明确为 Web/PWA 发布，不宣称 iOS 构建、签名、真机或分发已验收。

## 部署与观察

- 保留正式 tag `v0.5.10` 指向 `5ce8c1a14f43cf6182faee1968b5711e43167f59`；新增 annotated tag `v0.5.10+hotfix.1` 指向本候选。候选已快进推送到 Gitee `main`，旧 tag 未移动。
- Gitee Release：[v0.5.10+hotfix.1：修正版本显示与缓存标识](https://gitee.com/Liu_772021/for-now/releases/tag/v0.5.10+hotfix.1)。原 `v0.5.10` Release 已更新为 Release Note v2，并注明页脚问题由独立热修修正。
- Preview release-fence attempt `5a98285449a274d8959bf3a10d1137a9` 已完成，active SHA 为 `1189b0300ceaeaf04282561dab6e3ab1c14f741f`。公网 Preview 首页 200、`/preview/readyz` 返回该 SHA、匿名状态 API 401、管理快照 404、`noindex, nofollow, noarchive` 生效；线上页脚模块 SHA-256 与候选文件一致。
- 生产 release-fence attempt `9ace68361edbe4ee727c4673b4dfc0af` 于 2026-10-09 16:15 UTC 完成部署。active path 指向 `/opt/for-now/releases/1189b0300ceaeaf04282561dab6e3ab1c14f741f`，`/now/readyz` 返回 `1189b0300cea`；公开页面显示 `v0.5.10`，Service Worker cache key 为 `cike-shell-v0.5.10-hotfix.1-opening-1`。匿名状态 API 401、管理快照 404，服务 active、`NRestarts=0`。
- 热修 G6 观察窗口为 2026-10-09 16:15–16:45 UTC，由独立只读代理每 5 分钟采样。七个样本均匹配候选 SHA/readiness，服务 active、`NRestarts=0`，各样本间 priority err..alert=0；未缺样。

| 时间 UTC | 错误计数 | 脱敏费用聚合 |
|---|---:|---|
| 16:15:36 | 0（自部署起） | monitor 仍为 16:12:50.770Z：¥0.3596，27 calls，unknown=0 |
| 16:20:12 | 0 | monitor 16:18:20.761Z：¥0.3596，27 calls，unknown=0 |
| 16:25:10 | 0 | monitor 16:23:30.830Z：¥0.3596，27 calls，unknown=0 |
| 16:30:09 | 0 | monitor 16:28:50.888Z：¥0.3947，28 calls，unknown=0（较前次 +¥0.0351、+1 call） |
| 16:35:13 | 0 | monitor 16:34:20.837Z：¥0.3947，28 calls，unknown=0（累计未增） |
| 16:40:10 | 0 | monitor 16:39:23.339Z：¥0.3947，28 calls，unknown=0（累计未增） |
| 16:45:10 | 0 | monitor 16:44:50.738Z：¥0.3947，28 calls，unknown=0（累计未增） |

费用为生产聚合，16:30 读数的增量无法归因于本次测试；16:35 至 16:45 累计未增。观察代理仅读取健康、重启、错误计数和脱敏费用聚合，没有生产模型调用、用户内容读取或业务数据写入。G6 于窗口结束后关闭：GO，继续运行热修版本；未发现发布阻断。
- 生产回滚目标为原 v0.5.10 SHA `5ce8c1a14f43cf6182faee1968b5711e43167f59`。本热修无数据/schema 变更，不需要新的数据库备份或恢复演练；没有生产模型调用或生产业务数据写入。
