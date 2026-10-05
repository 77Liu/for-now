# V0.5.8-16 多 Agent 调度记录

- 日期：2026-10-05
- 门禁：`G3` 本地切片
- 调度者：V0.5.8 集成负责人
- 起始基线：`75e37d9`
- 当前集成提交：`56337a9`
- 活跃工作树：`5 / 6`
- 授权边界：仅本地实现、审查、测试与提交；无 push、tag、Release、部署、
  云资源、真实付费调用或生产写入授权

## 角色总账

| 角色 ID | 角色 | 工作树 / HEAD | 文件所有权 | 状态 | 最近证据 | 下一交接 |
| --- | --- | --- | --- | --- | --- | --- |
| `orchestrator` | 调度者 / 集成负责人 | `v0.5.8-p00-p0@56337a9` | 集成 tree、共享入口、最终测试与状态 | active | 核心计价 `a4150e9`、统计 UI `56337a9` 已提交 | Base 回填后进入 20 |
| `pricing-budget-review` | reviewer | 只读当前 diff | 费用、预算、失败路径 | completed | 发现失败调用误计费、ASR 信任客户端时长、TTS 字符口径 | 三项均已进入修复与回归 |
| `pricing-ui-review` | reviewer | 只读当前 diff | 七类服务、UI、迁移 | completed | 发现失败调用计费与旧 provider 单位仍标未知 | 两项均已修复 |
| `budget-settlement-dev` | 并行开发者 | `fix/v0.5.8-budget-unknown-settlement@e6fed80` | budget runtime/domain 与专项测试 | integrated | `e6fed80` 测试通过，patch 等价接入为 `1eb61c9` | 源工作树已移除，分支 ref 保留 |
| `sop-secretary` | 思考秘书 | 只读根 SOP | 调度角色、知识、通信与工作树边界 | completed | 建议独立 `SOP-DEV-007` 和对象级并行 | 已写入根 SOP |
| `context-secretary` | 思考秘书 | 只读 V0.5.8 | 进度、依赖、文件归属与 Base 收口 | completed | 校正 13/15/14/16 状态和后续顺序 | 交给调度者与状态文档开发者 |
| `status-docs-dev` | 并行开发者 | `docs/v0.5.8-status-20261005@21108a0` | `README-TODO.md`、V0.5.8 计划 | integrated | `21108a0` 检查通过，接入为 `9544fae` | 源工作树已移除，分支 ref 保留 |
| `pricing-final-review` | reviewer | 只读组合 tree | 前述问题关闭与新回归 | completed | 五项问题均关闭，无新增发现；服务器门由调度者以临时 ad-hoc Node 补验通过 | 关闭 |
| `orchestration-sop-review` | reviewer | 只读根 SOP | SOP 单一事实来源与执行性 | completed | 发现并关闭角色写权限、证据失效和消息关联三项问题 | 根 SOP 保留待独立提交 |

## 依赖与合并顺序

```text
官方价与单位映射
→ 失败调用账单缺口、旧单位迁移、可信 ASR 时长
→ 已知预留可降级为实际未知结算
→ 组合回归与独立复审
→ 状态文档 / Base 回填
→ V0.5.8-20
```

共享入口 `server.mjs`、`public/frontend/app/runtime.mjs` 和最终暂存区始终由
调度者单写。预算结算与状态文档分别使用隔离工作树；一次只串行接入一个提交。

## 通信与决策

1. reviewer 发现失败调用按预估值结算会虚增费用；调度者决定成功调用才按目录
   价结算，失败或无供应商计费证据时保留明确账单缺口。
2. reviewer 发现 ASR 使用客户端 `durationMs` 可低报；调度者决定预算按
   10 分钟上限预留，实际只接受供应商 `utterances.end_time`。
3. 并行开发者交付 `e6fed80`，允许已知预留按实际 `costKnown=false` 降级；
   调度者审查后 cherry-pick 为 `1eb61c9`。
4. 旧 provider 记录只要已有合法 `unitType / units`，v5 归一化后标记
   `usageKnown=true`；不回算旧费用。
5. 阿里云分割提交使用目录价，轮询与下载记已知零价；失败调用没有账单证据时
   不把预留值写成实际消费。
6. SOP reviewer 要求 reviewer 默认只读、完整证据失效范围和可关联消息 ID；
   根 SOP 已修订，reviewer 只有显式切换为集成负责人后才能执行合并。
7. 费用核心与统计 UI 分别提交为 `a4150e9`、`56337a9`；独立费用复审无新增
   问题。

## 测试与证据

- `npm run check`
- `npm test`
- `npm run test:pricing`
- `npm run test:ai-budget`
- `node scripts/ai-domain-regression.mjs`
- `npm run test:volcengine`
- `node scripts/segmentation-regression.mjs`
- `npm run test:transcription`
- `npm run test:speech-cache`
- `npm run test:observability`
- `npm run test:ui`
- `npm run test:journeys:smoke`：13/13
- ad-hoc 签名 Node 下 `scripts/volcengine-server-regression.mjs`

以上组合回归最近一轮均通过。macOS 原 Node 与 `sharp` Team ID 不一致，按仓库
既有 `prepareTestNodeBinary` 生成临时 ad-hoc Node 后服务器测试通过；临时文件
已删除。

## 保留现场和清理

- `fix/v0.5.8-budget-unknown-settlement` 已被当前分支 patch 等价吸收，干净
  工作树已移除，分支 ref 保留。
- `docs/v0.5.8-status-20261005@21108a0` 已接入为 `9544fae`，干净工作树已
  移除，分支 ref 保留。
- 根工作区的 SOP 与工作树治理改动继续保留，不夹带进功能提交。

## 下一步

1. 回填 Base，但需求只标“待验收”，不标已发布。
2. 进入 `V0.5.8-20`。
