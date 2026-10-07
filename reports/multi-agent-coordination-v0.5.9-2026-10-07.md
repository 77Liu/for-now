# V0.5.9 多 Agent 调度记录

- 启动时间：2026-10-07 16:11 +0800
- 集成基线：`f3164f62d35f794845d205897154c56d1a1c1283`
- 分支 / 工作树：`feat/v0.5.9-integration` /
  `.worktrees/v0.5.9-integration`
- 生产基线：`v0.5.8@7067ba65eeafccb953080e00988f62728d3b75a8`
- 当前门禁：`G1/G2 passed-for-local-development`，`G3-22/10a validated`，
  `G3-05a active`
- 授权：本地规划、开发、测试和本地提交；不含 push `main`、tag、Release、
  生产、云配置、真实付费调用或生产数据写入

## 1. 现场与保护清单

| 工作树 | HEAD / 分支 | 状态 | 负责人 / 下一步 |
| --- | --- | --- | --- |
| 项目根 | `f3164f6 / main` | 干净 | 只读基线，不在根目录开发 |
| `v0.4.0-g2-capability` | `82ca060 / v0.4.0-g2-capability` | `public/index.html` 脏 | 历史现场，保留 |
| `v0.5.0-integration` | `505ac90 / feat/v0.5.5-comment-voice` | restore/debug 文件脏 | 历史现场，保留 |
| `v0.5.8-p00-p0` | `1bab107 / feat/v0.5.8-p00-p0` | 计划、TODO、图片资产脏 | 规划来源，原样保留 |
| `platform-console` | `d157537 / platform/main` | 干净，独立产品线 | 不纳入主应用 |
| `v0.5.9-integration` | `f3164f6 / feat/v0.5.9-integration` | 当前集成树 | 唯一 writer |

当前 `6/6`，不得创建新工作树。不得删除、reset、stash 或提交其他现场。

受保护未提交资产：

| 资产 | SHA-256 | 处理 |
| --- | --- | --- |
| V0.5.9 已审阅计划 | `45c1bb9c...24afc8` | 正文机械迁入本分支后继续修订 |
| 计划报告图片 | `bdd261d6...0c6e9` | 仅保留原现场，不顺带提交 |
| 图片提示词 | `eb8428e0...a1d1c` | 仅保留原现场，不顺带提交 |
| 旧工作树 TODO | `fd5db59d...f96ec` | 含全文件格式化噪声，不迁入 |

## 2. DAG

```text
G1/G2
├─ 22 audio removal race [validated: bd52ebf]
├─ 10a replay fixtures [validated: bc066bd]
├─ 05a evidence contract [active]
│  └─ 05b persistence
│     ├─ 06 task selection
│     │  └─ 07 prompt roles
│     │     └─ 08 continuous perception
│     │        └─ 09 correction/invalidation
│     └──────────────────────────┐
│                                └─ 10b receipt/replay gate
├─ 17 image rotation [ready, no slot]
├─ 18 media delivery code [ready, no slot]
│  └─ 19 real CDN/OSS Preview [blocked: Owner/cloud]
└─ 21 owner opening settings [ready, no slot]
```

关键路径为 `22` 和 `05→06→07→08→09→10`。所有共享 schema、API、Prompt
manifest、module registry、runner、Service Worker 和发布文件由
`orchestrator` 串行修改。

## 3. 角色知识账

| roleId | specialty / activeContext | ownership | evidence / status | next |
| --- | --- | --- | --- | --- |
| `orchestrator` | 唯一 DAG、G1/G2、集成与共享文件 | V0.5.9 集成树和共享热点 | 22、10a 已验证；`active` | 实现 05a 领域契约 |
| `scout-audio-race` | recorder → draft → upload → ASR/账本 | 只读 | 定位 revision/persist/restore/submission 竞态；`closed` | 交给 developer-22 |
| `scout-personalization` | 05–10 现有 receipt/user-model/task/prompt/PG | 只读 | 定位固定投影、许可失效、注入和 outbox 缺口；`closed` | 交给 05a/10a |
| `developer-22` | 快捷语音移除 P00 | capture audio/controller/operations/view 和定向测试 | `bd52ebf`；`closed` | 交给版本集成 |
| `reviewer-22-r1` | 固定 22 差分独立审查 | 只读 | `0/1/3 NO-GO`；`closed` | findings 已修复 |
| `reviewer-22-r2` | 四项 finding 复审 | 只读 | `0/0/1 NO-GO`；`closed` | 交叉时序已修复 |
| `reviewer-22-r3` | 最终 tree 复审 | 只读 | `3fda6d1d...`，`0/0/0 GO`；`closed` | 无 |
| `validator-22` | 影响测试、Journey Smoke、零副作用 | 测试 artifact，只读代码 | F6/UI/Smoke/frontend 通过；`closed` | 交给版本系统门 |
| `developer-10a` | 16 类回放夹具、旧基线与指标 | 新 fixture/runner/说明 | `fb1961b`、`bc066bd`；`closed` | 交给 05a/10b |
| `reviewer-10a-r1` | fixture、指标、adapter 与基线可信度 | 只读 | `0/0/5 NO-GO`；`closed` | 五项均已修复 |
| `reviewer-10a-r2` | 首轮五项复核 | 只读 | `0/0/3 NO-GO`；`closed` | 空断言、完整 manifest、行为边界已修复 |
| `reviewer-10a-r3` | executionMode 信源复核 | 只读 | `0/0/1 NO-GO`；`closed` | 双信源绕过已修复 |
| `reviewer-10a-r4` | 最终回放基线复审 | 只读 | `0/0/0 GO`；`closed` | 无 |
| `scout-05a` | evidence/event/permission 领域边界 | 只读 | API、字段、20 条反例和 05b 边界已固定；`closed` | 交给 developer-05a |
| `developer-05a` | evidence/event/permission 纯领域契约 | `src/modules/user-model/evidence.mjs`、公共导出、专项 | `active` | 先固定失败断言 |

`developer-22` 不能作为自己的唯一 reviewer。Reviewer 和 Validator 复用现有
工作树，只读执行，不创建第七个工作树。

## 4. G1/G2 决策

权威范围、做/不做、入口矩阵、质量阈值、TTL、主动综合默认值、切片契约和调用
预算统一维护在
`reports/iteration-plan-v0.5.9-2026-10-06.md` 的 2.2 与 3.2。

局部阻塞：

- `19`：Owner 尚未授权 CDN、OSS、DNS、证书和费用告警配置。
- 真实模型对照：尚无本次费用和私人数据授权；本地只跑 stub/确定性回放。
- push/tag/Release/生产：均未授权。

这些阻塞不影响 `05a`、`17`、`18`、`21` 的本地准备；`05a` 已取得唯一写槽，
其余未派发只因工作树 `6/6` 和集成树单写。

## 5. 22 任务契约

- 目标：用户移除、取消或离开录音后，迟到 recorder/blob/persist/restore
  不能重新附着；纯文本提交为零附件、零上传、零 ASR、零账本项。
- 非目标：不改供应商、价格、录音产品范围或历史生产对象。
- 起始基线：`f3164f62d35f794845d205897154c56d1a1c1283`。
- 允许写：`public/frontend/features/capture-journal/` 内音频与提交生命周期、
  对应定向脚本；服务端只在证明缺少任务取消防线时追加最小变更。
- 禁止写：公共入口、依赖锁、Prompt、云配置、发布文件和生产数据。
- 失败断言：异步 stop、延迟 IndexedDB put/restore、移除后立即提交、双击、
  切页、未登录、账户切换、提交竞争和晚到 ASR。
- 正常回归：未移除录音恰好一次上传、一次记录、一次转写任务；上传失败沿用
  幂等键；页面离开仍恢复未移除草稿。
- 影响旅程：`capture-audio`、`audio-tts-playback`、未登录/账户切换路径。
- 最窄验证：capture feature、transcription、UI 定向、Journey Smoke。
- 恢复：无 schema；回退代码即可。所有本地测试供应商调用数固定为 0。

## 6. 调度事件

| 时间 | from → to | 事件 / 证据 | 结果 / 下一步 |
| --- | --- | --- | --- |
| 16:11 | Owner → orchestrator | 启动 V0.5.9，九条范围，先 G1/G2 后持续开发 | 接受本地目标，不扩远端授权 |
| 16:12 | orchestrator | `main/origin/main=f3164f6`；初始工作树 5 个 | 保护三个脏现场 |
| 16:16 | orchestrator → Scouts | 并行只读侦察 22 与 05–10 | 两份调用链/缺口报告完成 |
| 16:17 | Base → orchestrator | Base 23；版本 21/31；需求 450/273；交付 127/96 | 九条/11 交付一致，19 局部阻塞 |
| 16:20 | evidence → orchestrator | 生产 readyz 7067ba6；远端 main f3164f6；tag peel 7067ba6 | 发布基线一致 |
| 16:24 | validator-local | PG16 preflight、Journey schema、Prompt catalog | 全部通过 |
| 16:25 | orchestrator | 创建 V0.5.9 集成树，总数 6/6 | 不再创建工作树 |
| 16:27 | orchestrator → developer-22 | G1/G2 通过，22 唯一活动写线 | 建立失败断言 |
| 16:31 | test → developer-22 | 延迟 IndexedDB put 在 delete 后复活草稿 | 修复前失败反例固定 |
| 16:43 | reviewer-r1 → developer-22 | `0/1/3 NO-GO`：编码、取消、pending、rollback | 全部修复并补反例 |
| 16:58 | reviewer-r2 → developer-22 | `0/0/1 NO-GO`：stop-pending 替换取消 | 修复并补交叉时序 |
| 17:05 | reviewer-r3 → orchestrator | tree `3fda6d1d...`，`0/0/0 GO` | 提交 `bd52ebf` |
| 17:06 | orchestrator → developer-10a | 22 写槽释放，重算 DAG | 10a 进入 active |
| 17:10 | developer-10a | 固定 16 类 fixture、三方案接口、旧投影基线与四项指标 | 新编排/真实模型保持 not-run |
| 17:18 | validator-10a | `check`、F9、personal-context、user-model、Journey schema | 通过；真实供应商调用 0 |
| 17:20 | reviewer-10a-r1 → developer-10a | `0/0/5 NO-GO`：自报、指纹、维度、分母、代表任务 | 逐项修复 |
| 17:31 | reviewer-10a-r2 → developer-10a | `0/0/3 NO-GO`：空断言、完整 manifest、行为边界 | fail-closed 并补执行边界 |
| 17:40 | reviewer-10a-r3 → developer-10a | `0/0/1 NO-GO`：双 executionMode 信源 | 强制 adapter/output identity 一致 |
| 17:46 | reviewer-10a-r4 → orchestrator | `0/0/0 GO` | 提交 `fb1961b`、`bc066bd`，写槽转 05a |

## 6.1 22 验证与审查

- 修复前失败：延迟草稿 `put` 在移除后的 `delete` 之后完成，已移除 Blob
  重回 IndexedDB。
- 实现：草稿写删串行；recorder、restore、encode/upload、rollback 与提交结果
  绑定账户、generation 和 revision；提交封存 pending permission/file；提交
  期间音频控件禁用。
- 对抗用例：迟到 stop/dataavailable、put、restore、encode、rollback，
  active cancel、stop-pending cancel、替换时保留旧音频、账户切换和纯文本
  ASR 抑制。
- 最终 tree：`3fda6d1d8481e3b1ed5d89cfe96b77d2f4df1c19`。
- 本地提交：`bd52ebf`。
- 通过：`npm run check`、`test:f6-features`、`test:auth`、
  `test:media-runtime`、`test:ui`、`test:journeys:smoke`（15/15）、
  `test:frontend`（36 stages）。
- 未执行：真实 ASR/DeepSeek、Preview、生产和 Release；调用预算实际为 0。

## 6.2 10a 验证与审查

- 夹具版本 `2026.10.07.1`，16 类各一项，8 个代表任务为真实模型待验收集。
- manifest 固定起始 commit/tree、Prompt catalog、完整 SP/UP、模型参数、
  两次重复预算和 general/legacy 结果指纹；候选保持 `not-frozen`。
- general 仅当前材料，10/16 有历史关键证据漏选；因无候选材料和回答断言，
  相关率/支持率为 `null`，状态 `not-evaluable`。
- legacy 材料相关率 `65.2174%`、关键证据漏选率 `0%`、证据支持率 `60%`、
  新鲜度误述率 `100%`，11/16 保留已知失败。
- runner 不采信 adapter 自报评分；空断言、未知引用、输出身份伪装、Prompt/
  来源/结果指纹漂移均 fail-closed。new/真实模型 adapter 在 10b grader 接入前
  拒绝执行。
- `npm run check`、`npm run test:f9-features`、
  `npm run test:personalization-replay`、个人上下文/用户模型专项和 Journey
  schema 通过；生产行为和真实模型未运行，调用数为 0。

## 7. NO-GO 与下一动作

- 当前不是候选；不得执行 Preview、Release 或生产动作。
- `22` 仅为工作区已验证未部署，不能写成需求已发布或生产问题已关闭。
- 唯一下一动作：实现 `05a` 的 evidence/event/permission 纯领域契约和失败
  断言；不改 Store schema、HTTP、module registry，不调用真实模型。
