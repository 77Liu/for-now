# V0.5.8-20 多 Agent 调度记录

- 日期：2026-10-05
- 门禁：`G3` 本地切片
- 调度者：V0.5.8 集成负责人
- 起始基线：`56337a9`
- 完整提交链：`91a10b7`、`6384c7c`、`9830564`、`0f163aa`、
  `b24722b`、`8607cc6`、`88d37e1`
- 代码与测试截止：`88d37e142810d32ab12105d881c0759d9711b77b`
- 调度 SOP：`3856f1c`
- 交付状态：`工作区已验证未部署`
- 活跃工作树：`5 / 6`
- 授权边界：仅本地实现、审查、测试与提交；无 push、tag、Release、
  Preview、部署、云资源、真实付费调用或生产写入授权

## 角色总账

| 角色 ID | 角色 | 工作树 / HEAD | 文件所有权 | 状态 | 最近证据 | 下一交接 |
| --- | --- | --- | --- | --- | --- | --- |
| `orchestrator` | 调度者 / 集成负责人 | `v0.5.8-p00-p0@88d37e1` | `public/index.html`、串行集成、最终测试与状态 | closed | 完整提交链与最终系统门已固定 | 进入 02 |
| `opening-controller-dev` | 开屏控制器开发者 | 集成于当前树 | opening engine/controller 生命周期 | integrated | start/ready/fail/dispose、清理与 reduced-motion 路径通过 | 关闭 |
| `opening-integration-dev` | 开屏集成开发者 | `9830564/b24722b` | bootstrap/runtime/service worker 接线 | integrated | 同步开屏覆盖认证、onboarding、深链、失败、PWA 升级、BFCache 与路由失败竞态 | 交给测试强化 |
| `opening-test-dev` | 测试强化开发者 | `0f163aa/8607cc6/88d37e1` | opening、PWA 与 web budget 回归 | integrated | 原生 Paint Timing、post-paint handoff、失败/重试与旧缓存升级纳入门禁 | 关闭 |
| `opening-independent-review` | 独立 reviewer | 只读组合 tree | 生命周期、真实 paint、升级与回归边界 | closed | findings 全部关闭，无 blocker/P0/P1/P2 | 关闭 |
| `status-docs-dev` | 状态文档开发者 | 当前树未提交文档 | TODO、迭代计划与调度记录 | closed | 状态统一为工作区已验证未部署，下一步 02 | 由调度者提交 |

## 依赖与接入顺序

```text
同步 HTML 开屏与冻结配置
→ controller 生命周期和异常清理
→ 认证 / onboarding / 深链 / PWA / BFCache 接线
→ 真实 paint、退出与升级预算强化
→ 受影响专项重跑与独立复审
→ 状态文档
→ V0.5.8-02
```

`public/index.html`、`public/frontend/app/bootstrap.mjs`、
`public/frontend/app/runtime.mjs`、PWA 与测试编排均为共享热点，由集成负责人
串行接线。功能事实固定在 `9830564/b24722b/88d37e1`，测试强化固定在
`0f163aa/8607cc6/88d37e1`。

## 通信与决策

1. 开屏纸白、品牌和雨景容器随 HTML 同步存在，不等待 runtime、背景图、账户
   偏好或业务请求；默认配置继续以 R9.4-F1 为权威。
2. controller 只管理 `start/ready/fail/dispose` 和资源清理，不发认证或业务
   请求；深链保持目标页，ready 后不强制播放完整动画。
3. 性能验收从 DOM 存在修订为真实 paint，并增加 post-paint handoff，避免把
   尚未实际绘制的同步节点误记为用户可见。
4. 测试强化覆盖失败/重试、legacy cache 到新 service worker 的升级、减少动态
   效果、BFCache 与 pagehide 清理。
5. 独立 reviewer 提出的真实 paint、生命周期清理、升级恢复和回归预算问题均已
   进入功能或测试提交并关闭；最终复审无 blocker/P0/P1。

## 性能证据

最终 Fast 4G web gate 使用真实 paint，采用同一组最终证据：

| 指标 | 结果 |
| --- | ---: |
| opening deep-link FCP | `84.0 ms` |
| `app.js` request start | `90.8 ms` |
| cold current feedback FCP P75/P95 | `60 / 64 ms` |
| warm current feedback FCP P75/P95 | `56 / 60 ms` |
| cold firstReadable P75/P95 | `704.0 / 704.5 ms` |
| warm firstReadable P75/P95 | `701.0 / 716.5 ms` |
| ready → painted | `114.8 ms` |

开屏 FCP 满足 `<=250 ms`，退出满足 ready 后 `<=140 ms`。独立最新轮的
冷暖 FCP P75/P95 均小于 `80 ms`；真实 paint 修订后的最终性能门通过。

性能验证过程中有一次运行在环境尾部结束为失败。该轮保留为失败样本，未改写
或计入通过；随后独立重跑收敛为通过。这里记录的是“曾失败、后续通过”，不以
后续结果覆盖前一轮事实。

## 系统与专项门

- `npm run test:system`：在最终 `88d37e1` 上 `406996 ms` 全通过。
- 最终树的 `npm run check`、`npm run test:opening`、
  `npm run test:frontend-shell`、`npm run test:pwa` 与
  `npm run test:web-budget` 均已通过；完整系统门同时覆盖 mobile、UI、
  performance gate 与其他登记套件。
- `npm run test:journeys:smoke`：`14/14`。
- PostgreSQL 16.14 stable 兼容门通过。macOS 原 Node 与原生依赖签名不兼容时，
  使用仓库既有 ad-hoc Node 流程补验通过。

## 审查结论

- 独立 reviewer findings 全部关闭。
- 最终无 blocker、P0 或 P1 遗留。
- 本结论只覆盖本地组合 tree，不等于 Preview 或生产验收。

## 下一步

1. 保持 `V0.5.8-20` 为“工作区已验证未部署”，不声称发布或 Preview。
2. 进入 `V0.5.8-02`，冻结服务端/浏览器组合 API、feature 生命周期和
   `check:entrypoints`。

## 事实审计补录

补录时间：2026-10-05 18:55 +0800

### 最终证据边界

- 代码与测试截止 SHA：
  `88d37e142810d32ab12105d881c0759d9711b77b`。
- 功能链：`91a10b7 -> 6384c7c -> 9830564 -> 0f163aa -> b24722b
  -> 8607cc6 -> 88d37e1`。前两项来自 controller 支线的等价集成提交，
  后五项为当前集成分支提交。
- Base 回读：需求池 `rev=354 / 238`，研发交付 `rev=113 / 92`；
  需求 `reczz28Jd7mMoWFW` 与交付 `reczz28Jd8F4oH1y` 均为
  “待验收 / 未发布”。
- 工作树：`5 / 6`。未完善或有独立用途的现场继续保留，本轮未新建工作树、
  未删除用户现场。
- 授权边界：未 push、tag、创建 Gitee Release、部署、修改云资源、调用真实
  付费服务或写入生产。

### 角色知识账

| roleId | specialty | activeContext | ownership | dependencies | communications | evidence | status | next |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `orchestrator` | 集成、门禁、状态 | `56337a9..88d37e1`；20 收口 | `index.html`、集成、提交和状态文档 | 接收开发、验证与 reviewer 结论 | M01-M08 | 最终系统门 `406996 ms` | `closed` | 建立 02 新基线 |
| `opening-controller-dev` | 状态机与雨景资源 | R9.4-F1 controller | `public/frontend/opening/*` | 冻结配置、集成入口 | M01/M02 | `91a10b7/6384c7c`、opening 专项 | `closed` | 无 |
| `opening-integration-dev` | HTML、bootstrap、runtime、PWA | 同步壳与业务 ready | 共享入口的阶段性授权 | controller API、现有启动流程 | M02/M03 | `9830564/b24722b` | `integrated` | 由调度者接管入口 |
| `opening-test-dev` | 性能、PWA、失败恢复 | 原生 paint 与升级兼容 | opening 专项测试 | 冻结业务实现 | M03-M06 | `0f163aa/8607cc6/88d37e1` | `integrated` | 无 |
| `opening-reviewer-a` | 差分与假绿审查 | `8607cc6` 后差分 | 只读 | 开发与测试证据 | M04-M06 | 提出 FCP、timeout、secondary 3 项 P1 | `closed` | findings 已关闭 |
| `opening-reviewer-b` | 最终独立签核 | `88d37e1` 当前差分 | 只读 | M06 修复结果 | M07 | blocker/P0/P1/P2 均为 0 | `closed` | 无 |
| `orchestrator-secretary` | 角色知识、通信与交接审计 | 20 -> 02 切换 | 只读 | 调度 SOP 与现有报告 | M08 | 指出未固定树、字段与证据索引缺口 | `closed` | 02 使用新模板 |
| `v058-02-scout` | 入口契约侦察 | 02 预研，未启动实现 | 只读 | 拆分设计与当前入口 | M08 | 服务端/浏览器 API、生命周期和静态门建议 | `closed` | 从 `88d37e1` 重新冻结 |

### 通信与 finding 关闭

| messageId | from -> to | 状态 | 基线 / 文件 | 决定与证据 | next owner |
| --- | --- | --- | --- | --- | --- |
| M01 | 调度者 -> controller 开发 | accepted | `56337a9` / opening 模块 | 独立实现 `start/ready/fail/dispose`，不发业务请求 | controller 开发 |
| M02 | controller -> 集成开发 | integrated | `91a10b7/6384c7c` | 接入同步 HTML、认证、深链、BFCache 与失败恢复 | 集成开发 |
| M03 | 集成开发 -> 测试开发 | accepted | `9830564/b24722b` | 建立真实 paint、退出、PWA 与预算门 | 测试开发 |
| M04 | reviewer-a -> 调度者 | changes requested | `8607cc6` | P1-01 缺少 FCP 后入口断言；P1-02 缺少 1500/5000ms 锁存；P1-03 缺少 secondary 失败 | 调度者 |
| M05 | 测试开发 -> 调度者 | blocked | `web-first-screen-budget` | 新断言实测发现双 rAF 仍可早于 FCP | 调度者 |
| M06 | 调度者 -> reviewer-b | fixed | `88d37e1` / 3 文件 | paint 后任务启动、Resource Timing、真实 5 秒 late-success 和 secondary 失败均通过 | reviewer-b |
| M07 | reviewer-b -> 调度者 | approved | `88d37e1` | blocker/P0/P1/P2 为 0 | 调度者 |
| M08 | 秘书/02 侦察 -> 调度者 | handed off | 文档与入口设计 | 先固定 20，再从新基线执行 B0/F0；02 写任务已暂停且未落文件 | 调度者 |

### 验证索引

| 证据 | 结果 |
| --- | --- |
| `npm run check` | 通过；56 个模块、233 条路由 |
| `npm run test:opening` | 通过 |
| `npm run test:frontend-shell` | 通过 |
| `npm run test:pwa` | 通过；31 个缓存模块 |
| `npm run test:web-budget` | 通过；包含 secondary 503 与真实 5000ms late-success |
| `npm run test:system` | `406996 ms`，全通过；validate run ID `2026-10-05T10-48-02-017Z` |
| PostgreSQL 16.14 stable | 通过；最终改动不涉及服务端或持久化，证据继续有效 |
| 独立最终复审 | APPROVED；blocker/P0/P1/P2 均为 0 |

历史失败不覆盖：

- 旧双 rAF 实测 `openingVisible 1085.6 ms < FCP 1120.0 ms`，触发 P1 修复。
- 错误地把调度 marker 当成 FCP 后证据时出现过 `474.7 ms < 488.0 ms`
  的假红；最终门只用 `app.js` Resource Timing 对 FCP。
- 最终系统门前曾主动中止一轮已失效基线，退出码 `130`；该轮不计为通过。
