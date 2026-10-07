# V0.5.9 多 Agent 调度记录

- 启动时间：2026-10-07 16:11 +0800
- 集成基线：`f3164f62d35f794845d205897154c56d1a1c1283`
- 分支 / 工作树：`feat/v0.5.9-integration` /
  `.worktrees/v0.5.9-integration`
- 生产基线：`v0.5.8@7067ba65eeafccb953080e00988f62728d3b75a8`
- 当前门禁：`G1/G2 passed-for-local-development`，
  `G3-22/10a/05a/05b/06 validated`，`G3-07/17 active`
- 授权：本地规划、开发、测试和本地提交；不含 push `main`、tag、Release、
  生产、云配置、真实付费调用或生产数据写入

## 1. 现场与保护清单

| 工作树 | HEAD / 分支 | 状态 | 负责人 / 下一步 |
| --- | --- | --- | --- |
| 项目根 | `f3164f6 / main` | 干净 | 只读基线，不在根目录开发 |
| `v0.5.9-integration` | `d8bd3a8 / feat/v0.5.9-integration` | `06` 代码已提交，文档待提交 | orchestrator；转入 `07` |
| `v0.5.9-image-rotation` | `edefd18 / feat/v0.5.9-image-rotation` | `17` 首轮审查 NO-GO，修复中 | developer-17-fix |

当前 `3/6`。旧工作树已在可恢复归档后非强制移除；不得删除、reset、stash
或提交仍在活动的 `06/17` 现场。

受保护未提交资产：

| 资产 | SHA-256 | 处理 |
| --- | --- | --- |
| V0.5.9 已审阅计划 | `45c1bb9c...24afc8` | 正文机械迁入本分支后继续修订 |
| 计划报告图片 | `bdd261d6...0c6e9` | 仅保留原现场，不顺带提交 |
| 图片提示词 | `eb8428e0...a1d1c` | 仅保留原现场，不顺带提交 |
| 旧工作树 TODO | `fd5db59d...f96ec` | 已随 `archive/v0.5.9-plan-assets-20261007@7cdecfb` 归档；格式噪声不迁入 main |

## 2. DAG

```text
G1/G2
├─ 22 audio removal race [validated: bd52ebf]
├─ 10a replay fixtures [validated: bc066bd]
├─ 05a evidence contract [validated: 7cce77b]
│  └─ 05b persistence [validated: 3bbf564]
│     ├─ 06 task selection [validated: d8bd3a8]
│     │  └─ 07 prompt roles [active]
│     │     └─ 08 continuous perception
│     │        └─ 09 correction/invalidation
│     └──────────────────────────┐
│                                └─ 10b receipt/replay gate
├─ 17 image rotation [active: first review NO-GO]
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
| `orchestrator` | 唯一 DAG、G1/G2、集成与共享文件 | V0.5.9 集成树和共享热点 | 22、10a、05a/05b 已验证；`active` | 实现 06 任务选材 |
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
| `developer-05a` | evidence/event/permission 纯领域契约 | `src/modules/user-model/evidence.mjs`、公共导出、专项 | `7cce77b`；`closed` | 交给 05b |
| `reviewer-05a-r1` | 账户、许可、版本、依赖与时间安全 | 只读 | `0/2/2 NO-GO`；`closed` | 缺失账户、空依赖等已修复 |
| `reviewer-05a-r2` | source key 规范化复核 | 只读 | `0/0/1 NO-GO`；`closed` | 非规范 key 绕过已修复 |
| `reviewer-05a-r3` | 删除状态与重复依赖复核 | 只读 | `0/0/2 NO-GO`；`closed` | fail-closed 已修复 |
| `reviewer-05a-r4` | 去重输入与 locale 确定性复核 | 只读 | `0/0/2 NO-GO`；`closed` | 非数组和 locale 已修复 |
| `reviewer-05a-r5` | 最终证据契约复审 | 只读 | `0/0/0 GO`；`closed` | 无 |
| `validator-05a` | 专项、user-model、模块与 backend 门 | 只读 | backend 通过（333,982 ms）；`closed` | 交给 05b |
| `developer-05b` | Store/JSON/PG 映射与生命周期接线 | schema、normalization、persistence、trash、专项 | `cea417d`、`ed3f64b`、`3bbf564`；`closed` | 交给 06/08 |
| `reviewer-05b-a/b` | 账户、恢复、版本、公开投影与 trash identity | 只读 | 两轮关闭 3 个 P1、1 个 P2，最终 `0/0/0 GO`；`closed` | 无 |
| `validator-05b` | JSON/PG16、恢复、领域与模块门 | 只读 | PG 16.14 stable、check、专项通过；`closed` | 交给 06 |
| `reviewer-06-r1…r11` | 选材、回执、派生来源、兼容与性能 | 只读 | 多轮关闭许可、预算、来源绑定、递归失效、附件和长正文问题；最终 `0/0/0/0 GO` | 交给 07/08/10b |
| `worktree-governor-v059` | 历史现场归档与工作树治理 | 旧工作树、stash、archive refs | 4 棵旧树已安全移除，2 条 stash 已归档/核对后清零；`closed` | 保持总数 ≤6 |
| `developer-17` | 图片连续旋转 | 图片草稿内部 2 模块和专项 | `edefd18`；首轮 `0/1/1/1 NO-GO` | 修复 UI 可达性、重复编码和 URL 集合 |
| `reviewer-17-r1` | 旋转入口、像素、并发和资源清理 | 只读 | `0/1/1/1 NO-GO`；`closed` | 等待增量修复后复审 |

`developer-22` 不能作为自己的唯一 reviewer。Reviewer 和 Validator 复用现有
工作树，只读执行；`17` 使用独立分支/工作树，与 `06/07` 写集不重叠。

## 4. G1/G2 决策

权威范围、做/不做、入口矩阵、质量阈值、TTL、主动综合默认值、切片契约和调用
预算统一维护在
`reports/iteration-plan-v0.5.9-2026-10-06.md` 的 2.2 与 3.2。

局部阻塞：

- `19`：Owner 尚未授权 CDN、OSS、DNS、证书和费用告警配置。
- 真实模型对照：尚无本次费用和私人数据授权；本地只跑 stub/确定性回放。
- push/tag/Release/生产：均未授权。

这些阻塞不影响 `07`、`17`、`18`、`21` 的本地准备。工作树治理后已从
`6/6` 降为 `3/6`；`07` 占集成树共享写槽，`17` 占独立前端写槽，`18/21`
因最多两条叶子写线暂不派发。

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
| 17:52 | orchestrator → developer-05a | 读取现有 user-model/task/trash 边界 | 固定纯领域写集，不提前接持久化 |
| 17:58 | reviewer-05a-r1 → developer-05a | `0/2/2 NO-GO`：账户、空依赖、时间、幂等键 | 全部改为严格契约 |
| 18:08 | reviewer-05a-r2 → developer-05a | `0/0/1 NO-GO`：非规范 source key 绕过 | 统一解析规范四元组 |
| 18:15 | reviewer-05a-r3/r4 → developer-05a | 重复依赖、deleted、非数组、locale 共 4 个 P1 | 双时序与多 locale 反例通过 |
| 18:22 | reviewer-05a-r5 → orchestrator | `0/0/0 GO` | 提交 `7cce77b`，写槽转 05b |
| 18:31 | orchestrator → developer-05b | 冻结 v16→v17、JSON/PG、trash/restore 失败断言 | Store v17 与持久化接线进入 active |
| 19:24 | reviewers-05b → developer-05b | 恢复探针、旧备份、revision、公开投影、trash identity、legacy 版本 findings | 全部修复并补反例 |
| 20:09 | reviewers-05b-final → orchestrator | 当前差分 `0/0/0 GO` | 提交 `cea417d`、`ed3f64b`、`3bbf564`，写槽转 06 |
| 20:10 | orchestrator | 启动 `06`，固定 scene/task/current material 与 receipt v2 | 思绪根/追问/批注纵向接线 |
| 21:52 | reviewers-06-r8 | `0/0/6 NO-GO`：追问定位、来源凭据、时间、兼容、递归依赖、图片 | 建立反例并逐项修复 |
| 23:14 | worktree-governor | 三类历史现场、平台树和两条 stash 完成可恢复归档 | 工作树 `6→3`，创建 `17` 独立树 |
| 23:14 | developer-17 | 首版图片旋转提交 `edefd18` | Reviewer `0/1/1/1 NO-GO`，增量修复中 |
| 23:27 | reviewer-06-r11 → orchestrator | `06` 当前差分 `0/0/0/0 GO` | 四笔提交至 `d8bd3a8`，转入文档与固定 tree 门 |

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

## 6.3 05a 验证与审查

- 在已登记的 `domain.user-model` 内新增纯领域 evidence 模块；没有修改 Store、
  PostgreSQL、HTTP、registry、Prompt 或前端。
- source identity 使用规范 JSON 四元组；证据绑定账户、来源版本、内容 hash、
  span、事件、严格 RFC3339 双时间、许可 revision 和派生依赖。
- `contextAllowed` 与 `learningAllowed` 独立；跨账户、缺失/删除来源、版本/hash
  变化、许可 revision 变化及任一依赖失效均 fail-closed。
- 事件幂等键绑定账户、事件、操作、来源 identity/version、hash、许可 revision
  与 perception version；证据 fingerprint 排除随机 ID/记录时间并使用固定
  code-unit 排序。
- 首轮 `0/2/2`，五轮独立审查最终 `0/0/0 GO`。专项 114 条以上断言、
  `test:user-model`、check、模块边界和 backend system（333,982 ms）通过；
  外部调用为 0。

## 6.4 05b 验证与审查

- Store v17 新增 evidence source、permission、perception event 三类私有集合；
  非数组、非法记录、重复 ID/语义输入均以 `STORAGE_READ_FAILED` 拒绝。
- JSON 与 PostgreSQL 16.14 round-trip、RLS、source/derived relation、账户导出、
  v16 恢复和动态 API 集合探针通过；PG counts 为 `33/46/29/6/34/1`。
- 删除顶层、嵌套和思绪链来源会撤销双许可并推进 revision，恢复不恢复许可；
  同 ID 不同类型/嵌套 trash 不会误伤无关来源。可编辑来源的 legacy/v1 更新
  都单调推进版本。
- 私有三集合不进入 `/api/state`；两轮 Reviewer 关闭 3 个 P1、1 个 P2，
  最终 `0/0/0 GO`。真实供应商和云调用均为 0。
- 后台任务发送前/落库前复查等待 `06` 产出 `evidenceChecks` 后由 `08` 激活，
  当前不保留无 producer 的名义接线。

## 6.5 06 验证与审查

- `working-context v2` 统一记录 scene/task、当前材料、候选/选入/排除、
  Evidence checks、来源版本/hash、账户绑定、时间窗和最终 user prompt 预算。
- 思绪根回答、追问和批注均发送完整当前链；纯图片及根/内容块/追问/评论附件
  进入相同请求。检索不可用时显式降级为仅当前材料。
- 生成前后重算 receipt；v2 派生输出必须绑定 succeeded task、结果 ID、
  task tuple 与 context fingerprint。同步回答使用不公开的内部成功任务；
  public state 及 task list/get/result 均不暴露该凭据。
- Evidence 依赖按链递归校验；底层删除、撤权、版本变化、可识别的中间派生
  evidence 缺失和循环依赖均 fail-closed。1000 条 Evidence 本地检查低于
  `50 ms`。
- 16 类 selection-only 回放执行完成：当前材料、许可、失效与事件去重门通过；
  相关选择 `11/14`，保留 2 个语义漏选给 `08/10b`，不计作最终质量通过。
  general/legacy 固定指纹未漂移，真实模型调用为 0。
- 多轮 Reviewer 从 `0/1/3`、`0/0/2`、`0/0/2`、`0/0/1` 收敛到
  `0/0/0/0 GO`。代码与测试提交：`c07dc54`、`8140622`、`f1f574c`、
  `d8bd3a8`。
- 已通过专项、核心、API v1、content/AI runtime、F3、auth、user-model、
  check、冻结 replay 与 Journey Smoke `15/15`。跨最终修改的 backend
  结果只作影响面证据；固定文档提交后须重跑完整 backend。

## 6.6 工作树治理与 17 写线

- `archive/v0.5.9-plan-assets-20261007@7cdecfb` 保存 V0.5.9 计划原稿、
  图片和提示词；`archive/v0.4.0-g2-capability-20261007@07d77ba`、
  `archive/v0.5.0-integration-20261007@9a2c5e4` 与
  `archive/exploration-feature-atlas-20260930@207dbd9` 保存其他独有资产。
- v0.5.0 调试材料移至仓库外权限 `0700/0600` 的
  `个人成长追踪-local-archive/20261007/v0.5.0-integration-sensitive`。
  两条 stash 经覆盖/归档核验后清零；旧工作树均非强制移除。
- `17` 从 `2bb3819` 创建独立工作树并提交首版 `edefd18`。首轮 Reviewer
  发现 UI 不可达、JPEG 多代编码和 Blob URL 集合增长，当前由
  `developer-17-fix` 在原 3 文件写集内修复，尚未进入集成分支。

## 7. NO-GO 与下一动作

- 当前不是候选；不得执行 Preview、Release 或生产动作。
- `22` 仅为工作区已验证未部署，不能写成需求已发布或生产问题已关闭。
- 主线下一动作：在集成树推进 `07` 职责化提示词与注入防线；并行线继续关闭
  `17` 首轮 findings。两线通过独立审查后由 orchestrator 串行集成；不调用
  真实模型，不执行 Preview、push、tag、Release 或生产动作。
