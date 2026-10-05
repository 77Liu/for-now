# V0.5.8-02 多 Agent 调度记录

- 日期：2026-10-05
- 门禁：`G3 / B0-F0`
- 起始基线：`dab874d`
- 当前状态：`local-committed`
- 活跃工作树：`5 / 6`
- 授权边界：仅本地契约、静态门、专项、文档与提交；无 push、tag、Release、
  Preview、部署、云资源、真实付费调用或生产写入授权

## 目标与非目标

目标：

1. 用机器可读策略冻结 `server.mjs`、`runtime.mjs` 的目标组合 API、允许依赖、
   行数预算、禁止职责和迁移例外。
2. 提供 `check:entrypoints` 及其正反例回归，并接入 `npm run check`。
3. 提供未接线的 `createFeatureRegistry`，冻结 mount/render/unmount、
   resetSession、AbortSignal、迟到结果和失败重试语义。
4. 将新门接入分层系统测试，为 03/04 迁移提供可执行验收。

非目标：

- 不在 02 中迁移 `server.mjs` 的 B1-B7 业务实现。
- 不在 02 中迁移 `runtime.mjs` 的 F1-F10 页面或事件实现。
- 不修改 Store/schema、产品行为、文案、样式、依赖或发布配置。

## 任务图与所有权

```text
02-A 机器策略与静态 checker ─┐
                              ├─> 02-I registry/package/system 串行接线
02-B feature registry 契约 ───┘
                              └─> 02-R 独立 review -> 影响测试 -> 本地提交
```

| task | roleId | specialty | activeContext | ownership | dependencies | communications | evidence | status | next |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 02-I | `orchestrator` | 契约冻结与串行集成 | `dab874d`；B0/F0 | registry、package/system、PWA、文档 | 02-A/02-B/02-W | 收敛 reviewer findings，固定 G 门 | `6730597`；check/frontend/performance 通过 | `closed` | 进入 03/04 |
| 02-A | `entrypoint-checker-dev` | 词法静态门与反例 | 当前入口仅作有期限例外 | checker、lexer 与反例 | 入口设计、机器 registry | 交付初版后由调度者修复边界漏洞 | 三入口、真实 path、API/binding/catalog、例外期限已覆盖 | `integrated` | 关闭 |
| 02-B | `feature-registry-dev` | 前端 feature 生命周期 | registry 不接当前 runtime | `public/frontend/feature-registry/` 与 lifecycle 专项 | 生命周期冻结契约 | 交付初版后由调度者修复竞态 | 加载中状态、清理失败、reset 锁定均覆盖 | `integrated` | 关闭 |
| 02-W | `wiring-dev` | package、barrel、system runner | 仅三个授权文件 | package/system 接线 | 02-A/02-B | 发现静态 barrel 增加首屏闭包后改为独立模块 | `test:entrypoints` 与双 suite 接线 | `integrated` | 关闭 |
| 02-S | `orchestration-secretary` | 角色知识与证据缺口 | 基线 `dab874d` | 只读调度记录 | 所有角色 | 回传 G3、system runner、review 缺口 | 缺口均已处理 | `closed` | 无 |
| 02-R | `independent-reviewers` | 边界、生命周期、PWA、性能 | 最新未提交差分 | 只读 | 02-I 完成 | 多轮复审，每轮只保留可复现 blocker/P0/P1 | 最终 blocker/P0/P1 = 0，GO | `closed` | 无 |

## 冻结 API

- 服务端目标：`createServerRuntime({ rootUrl, processRef? })` 返回
  `start/ready/stop`；`createHttpApplication(deps)` 返回 `handle/routeIds`。
- 浏览器兼容入口：`startApplication({ opening } = {})`，内部 runtime 保持
  `startApplication(initial = null, { opening = null } = {})`。
- 浏览器目标：`createBrowserApplication({...})` 返回
  `start/resetSession/stop`。
- feature registry：`enter/leave/notifyState/resetSession/stop`。
- 有副作用 feature：`mount({ root, route, signal })`、`render`、`unmount`、
  `resetSession`；纯函数 feature 不强制包装 controller。

## 已冻结机器契约

- 三个真实入口固定为 `server.mjs`、`public/frontend/app/runtime.mjs` 和
  `public/app.js`；策略不能换成替代文件。
- 服务端组合 API 固定为 `createServerRuntime` / `createHttpApplication`，
  浏览器组合 API 固定为 `createBrowserApplication` / `createFeatureRegistry`。
- 57 个模块、233 条拥有路由和 25 个页面需与真实 registry/page catalog
  一致；server handler 顺序固定为九段。
- 当前旧入口由 20 条逐明细、逐计数例外约束。服务端例外在 G4 失效，
  浏览器例外在 G6 失效，G7 强制零例外。
- 所有入口、测试、模块公开入口、允许导入和 page catalog 均做真实路径包含性
  校验；冻结入口及策略文件拒绝符号链接。
- `frontend.feature-registry` 为独立公开模块，02 不把它静态接入当前 runtime
  闭包；后续 04 接线时再承担页面 controller 生命周期。

## Review 闭环

| round | findings | 处理 |
| --- | --- | --- |
| R1 | lexer 将 `&& /regex/` 误判为除法；handler 元数据绑定旧 `.register()` 形态 | 修复 lexer；handler 改为目标顺序与路由 owner 契约 |
| R2 | reset 失败后的排队 reset 假成功 | registry 锁定并让排队操作携带原始 cause 失败 |
| R3 | 加载中状态丢失；view 规范化重名覆盖 | 缓存并合并 pending render；重复 key fail fast |
| R4 | cleanup 失败复用旧 controller；页面、期限和真实入口可自降级 | 清理失败丢弃缓存；固定 page catalog、G4/G6 与三入口身份 |
| R5 | 括号、拼接、模板、computed property、ASI block 和间接 import 绕过 | 共享静态求值、导入 binding 解析和完整反例 |
| R6 | symlink/外部 registry 逃逸；入口 path/API/binding 可自降级 | realpath 门；真实入口、目标 API、binding 和 page catalog 硬冻结 |
| R7 | 工厂同名调用可假满足；反射与成员 import 可绕过 | 关联 imported binding、工厂赋值和 receiver 调用；禁止动态全局访问及成员 import |
| R8 | 未使用 registry 进入当前 runtime 闭包 | 拆为独立公开模块，恢复原 24 模块/800 KiB 预算 |
| R9 | 工厂、依赖和 lifecycle 仅按同名字符串可假满足 | 绑定 import local、同 scope/顺序、真实参数值与 receiver 调用 |

## 验证记录

- `npm run check`：通过；57 个模块、233 条路由、G3 下 20 条有效例外。
- `npm run test:entrypoints`：通过；覆盖正反例、精确例外、路径逃逸与生命周期。
- `npm run test:frontend`：曾在 URL/history hydration 出现 1 次非确定性失败；
  单项与完整组复跑通过，最终 `85722 ms`，失败样本保留。
- `node scripts/system-test.mjs performance`：首次本机 Paint Timing 抖动失败；
  独立复跑通过，cold feedback P75/P95 `64/84 ms`，warm `56/56 ms`，
  runtime 闭包恢复为 `24 / 815481 B`；另保留一次 `app.js` 早于 FCP
  `2.5 ms` 的本机时序失败样本。
- `npm run test:backend`：最终隔离运行完成，全部阶段通过，`328948 ms`。
- 所有命令均使用本地临时目录、模拟供应商和隔离端口；无真实付费调用、
  Preview、部署或生产写入。
- 最终独立 Reviewer 结论：GO，blocker/P0/P1 = `0/0/0`。
- 本地提交：`6730597`（`feat(architecture): freeze entrypoint contracts`）。
- Base 回读：需求池 `rev=355 / 238`、研发交付 `rev=114 / 92`。整体需求
  `reczz28JPK4rO6LI` 为“进行中 / 未发布”，02 交付
  `reczz28JPdCVUwBD` 为“待验收 / 未发布”。

测试 fixture 因集中覆盖大量恶意输入超过 800 行；生产 checker、lexer、
surface/contract/static-value helper 与 feature registry 均不超过 500 行，
没有把大入口问题转移到新的实现文件。

## 当前边界

- `server.mjs` 3,283 行、`runtime.mjs` 5,291 行仍是迁移例外，02 不宣称
  “入口已拆”。
- 02 只冻结目标契约和生命周期，不迁移 B1-B7/F1-F10 业务。
- 未执行 push、tag、Release、Preview、部署、云资源修改、真实付费调用或
  生产写入。
