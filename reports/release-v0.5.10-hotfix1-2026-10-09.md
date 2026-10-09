# v0.5.10+hotfix.1 版本显示修正记录（2026-10-09）

## 发行说明（唯一正文来源，未发布草稿）

# v0.5.10+hotfix.1 · Web

发行日期：发布后补录（Asia/Shanghai）
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
- 修正包版本：`0.5.10+hotfix.1`；拟用独立 tag：`v0.5.10+hotfix.1`。已有 `v0.5.10` tag 与 Gitee Release 保持不变。
- 候选提交/tree：提交完成后补录。
- 产品行为范围仅为版本元数据、Web/PWA 标签和缓存身份，以及 iOS 项目的版本/build 元数据；不改 API、数据、权限、存储、schema 或外部供应商调用。
- 用户截图证实页脚仍显示 `v0.5.9`。代码核对发现 package、Web 静态标签、运行时默认值和 Service Worker 缓存名均沿用了 `0.5.9`；首次 `.10` 标签没有同步这些版本字段。

## 验证与复审

- `node scripts/pwa-regression.mjs`：通过；覆盖 package/lock 版本、两处 Web 标签、运行时与会话默认值、Service Worker cache key、iOS 四处 marketing/build 值。
- `node scripts/frontend-basic-surfaces-feature-regression.mjs`：通过；另断言 SemVer build metadata `+hotfix.1` 在产品页脚隐藏，显示为 `v0.5.10`。
- `node scripts/mobile-platform-regression.mjs`：通过。
- `plutil -lint ios/App/App.xcodeproj/project.pbxproj`：通过。
- `git diff --check`：通过。
- 独立只读 review：GO。Review 确认产品页脚从 `0.5.10+hotfix.1` 显示基版本 `v0.5.10`、服务端保留完整 build identity；SemVer build metadata 不用于版本排序。
- `scripts/system-test.mjs all` 曾在未冻结工作树上执行。第一次因当前运行环境无 `npm` 可执行文件，在提交门回归处中断；使用已配置 bundled pnpm 的兼容入口再次运行后，冻结回放源检查因未提交的 `package.json` 与 `HEAD` 不一致而失败。保留该失败结果；未改旧回放基线，按交接要求不再重跑无关全系统/AI 回放或费用矩阵。该结果不记为全系统通过。
- 当前环境没有 `xcodebuild`，故未生成 iOS Simulator 制品；本次仍明确为 Web/PWA 发布，不宣称 iOS 构建、签名、真机或分发已验收。

## 版本 v0.5.10 观察与热修顺序

原 v0.5.10 生产 G6 窗口为 2026-10-09 15:43–16:13 UTC。观察代理恢复同一窗口，已记录 15:44 与 15:57 UTC 有效样本；15:48、15:53 两个计划点因观察进程中止而缺样，后续样本及窗口结论待补。Production monitor 的脱敏聚合读数（15:56:50 UTC）为当日累计估算 ¥0.3596、AI calls 27、unknown-cost calls 0；这是生产聚合状态，不归因于本次测试。Agent 未发起生产模型调用。

待原窗口收口后，再部署本热修到生产并开始新的 30 分钟 G6。Preview 部署、生产 fence、精确 SHA、Gitee Release URL、冒烟及热修 G6/G7 结果待实际完成后补录；生产回滚目标为上述 v0.5.10 基线。本热修无数据/schema 变更，不需要新的数据库备份或恢复演练。
