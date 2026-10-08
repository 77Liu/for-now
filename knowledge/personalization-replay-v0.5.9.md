# V0.5.9 个性化固定回放契约

状态：`10b 确定性实现已验证；真实模型质量待验收`。本文件定义固定夹具、
评估接口与真实回放的证据边界；本地评分不代表真实语义或个性化收益已通过。

## 固定资产

- 夹具：`scripts/fixtures/personalization-replay-v1.json`
- 运行清单：`scripts/fixtures/personalization-replay-manifest-v1.json`
- runner：`scripts/lib/personalization-replay.mjs`
- 专项：`scripts/personalization-replay-regression.mjs`
- 夹具版本：`2026.10.07.1`
- 数据边界：仅虚构数据，不读取生产或个人正文
- 当前执行证据：确定性 stub 和供应商传输桩，真实模型调用数为 `0`
- 起始代码基线：commit `2d8687a1f26f6e4b7e859d13c4d502da0f6a2c7d`，
  tree `50a42b7de427558bd6852748ba2766cc948cf401`
- 候选状态：manifest 已登记本地编排候选；G4完整发布候选另行冻结。工具输出必须带实际执行 tree，不能把本地 manifest 当作发布GO。

夹具逐项覆盖抽取、时间、更新、克制、新数据可见、并发、去重、量表、任务
相关、完整链、许可、失效、来源忠实、反馈、泛化边界和个性化收益，共 16 类。
每类固定任务、材料标签、关键证据、禁止来源、stub 断言和旧基线失败码。

## 三方案接口

adapter 输入单个 fixture，输出：

```json
{
  "schemaVersion": 1,
  "variant": "general|legacy|new",
  "executionMode": "deterministic-stub",
  "fixtureId": "fixture-id",
  "selectedSourceIds": ["source-id"],
  "assertions": [{
    "id": "assertion-id",
    "sourceIds": ["source-id"]
  }],
  "adapterEvidence": {
    "selectionPolicy": "adapter-version",
    "promptSha256": "legacy-only",
    "projectionVersion": "legacy-only",
    "sourceFingerprintSha256": "legacy-only"
  }
}
```

- `general` 只选本轮当前材料。
- `legacy` 调用现有 `personalContextProjection`，复现固定类别堆叠。
- `new` 已调用真实本地编排，并由可信确定性引用grader核对来源与完整回答覆盖；真实模型语义仍为 `not-run`。

adapter 只报告断言 ID 和引用，不能自报“受支持”或“正确”；评分从 fixture
中的独立 `assertionOracle` 读取。stub 断言只验证 evaluator、来源绑定和失败
保留，不是模型回答样本。真实模型对照仍须 Owner、费用和私人数据授权；未经
执行不得据此宣称个性化收益。固定的 8 个代表任务已单独标记，授权后每种方案
运行两次，调用上限为 48 次。

10a历史runner只接受冻结的 `general` / `legacy` deterministic adapter。
10b已接入 `new` 与可信确定性grader；回答span、原始来源文本与引用逐项核对，
不接受adapter自报评分。真实模型适配仍须独立语义评估；空断言或 `null`
指标不能成为候选通过证据。确定性和生成工具始终输出 `gateEligible=false`。

## 真实生成工具与盲评

- `npm run replay:personalization:plan -- --tree <tree>` 默认只输出冻结计划，无外部调用。
- 显式 `node scripts/personalization-live-replay.mjs --live --tree <tree> --output <private-report.json>` 才执行真实生成；凭据只从进程环境 `REPLAY_API_KEY` 读取，固定目的地 `https://api.deepseek.com/chat/completions`，工具不读取生产数据库或用户正文。
- 8任务×3方案×2次，最多48次、单并发、0自动重试、90秒单次超时；模型/Prompt/参数逐项匹配冻结请求SHA。按峰值单价、不计缓存优惠保守预留，计划总额不得超过30元。
- 账本在调用前记录in-flight并以0600原子保存；失败、超时、崩溃留下未知调用，禁止自动重试。恢复检查候选/计划/请求/答案指纹，已完成请求不重复调用；不把未知账单记零。
- 账本记录完整wire请求、回答、reasoning、usage、返回模型和finish状态；文件属于私有审计资产，不进入公共报告或产品UI。该合成验收工具使用隔离审计账本，不写生产全站费用账本，真实费用仍须据供应商账单核对。
- `npm run replay:personalization:blind -- <private-report.json> <new-directory>` 只接受48条完整、指纹一致的回答，生成不含方案名的Owner材料、未填评分模板和单独私有解盲映射。已有文件拒绝覆盖，不能重新排列挑选有利样本。
- Owner先评两次回答的来源忠实、新鲜度、注入与实际帮助，再解盲。至少7/8不劣、4/8明显更有帮助；所有空项保持未评，生成成功或模板生成不构成质量通过。
- `npm run test:personalization-live` 用全局fetch桩验证传输、48次上限、账本权限、完整恢复、首次失败停止、漂移拒绝与盲评打包，外部调用为0。

2026-10-08凭据动作的自动审批拒绝已登记在根目录权威计划第9节，随后Owner
明确授权该凭据来源、目的地与用途；仅限本次48调用/30元合成回放。执行包装层
只在内存读取该凭据并传给子进程环境，不保存在工具账本，不输出密钥。

## 指标

所有比率先跨固定集累加分子和分母，再统一计算：

- 材料相关率 = 选中且标注相关的候选历史材料数 / 全部选中候选历史材料数，
  门槛 `>= 85%`。必选的本轮问题不进入该分母。
- 关键证据漏选率 = 未选中的 required 候选历史材料数 / required 候选历史
  材料总数，门槛 `0%`。本轮材料丢失由独立硬门统计。
- 证据支持率 = oracle 判定有充分引用的断言数 / 断言总数，门槛 `100%`。
- 新鲜度误述率 = 把非当前状态说成当前的断言数 / 时序敏感断言数，门槛 `0%`。

另逐项统计禁止来源使用、重复事件使用、当前材料丢失和语义断言不匹配。许可
越权、跨账户、失效来源、旧结果覆盖和当前原文丢失均属于零容忍硬门。

`null` 表示当前方案没有产生该指标的有效分母，不能解释成 `0%` 或通过；
方案汇总会标为 `not-evaluable`。

## 旧基线解释

固定集故意保留旧方案和通用方案的失败样本。专项通过只表示：

1. 16 类 fixture 完整、任务非空、各维度必备反例结构有效；
2. 当前旧投影仍产生被冻结的来源选择、Prompt hash、projection version、
   source hash 和失败码；
3. 指标计算、禁止来源、引用完整性和 baseline drift 检查正常；
4. adapter 不能删除 fixture 要求的 stub 断言，也不能靠自报正确性改变评分；
5. 新编排和真实模型结果没有被伪造为已执行。

10a 的执行层只覆盖 fixture、旧选择基线、完整 Prompt 请求指纹和 evaluator。
并发写回、账户 repository 隔离、删除恢复及派生失效的生产行为由 `05–09`
逐步接入同一 fixture；在接入前统一记录为 `productionBehavior=not-run`，不能
把结构覆盖写成端到端行为通过。

当前 `general` 在 10/16 个 fixture 有已知缺口，主要是关键历史证据漏选；
`legacy` 在 11/16 个 fixture 有已知缺口，包含无关材料、来源身份、时间、
去重和失效问题。后续修改现有投影或夹具时，专项必须先暴露 baseline drift，
不得直接改期望值掩盖行为变化。
