# V0.5.8-03/04 多 Agent 调度记录

- 日期：2026-10-05
- 起始基线：`f911cde4505d3434ab4afcf4b5614f8e828f4bcc`
- 当前门禁：`iteration-G3 / entrypoint-pre-G2`
- 当前状态：`b2-verified-f2-ready`
- 活跃工作树：`5 / 6`
- 机器事实：3 个入口策略、61 个模块、236 条拥有路由、20 条迁移例外；
  `server.mjs` 由 3283 行降至 2295 行，`runtime.mjs` 仍为 5291 行
- 授权边界：允许本地代码、测试、文档与任务提交；不允许 push、tag、Release、
  Preview、部署、云资源修改、真实付费调用或生产写入

## 任务图

```text
C0 入口契约修复
├─ C0a 允许并要求 ./application.mjs
└─ C0b 阻止不可达/嵌套 factory 死代码假绿

B1a Store schema/归一化模块与专项
-> B1b 派生统计
-> B1c 公开状态投影
-> B2 本地测试、账户初始化与恢复
-> B3-B6
-> B7 createHttpApplication/createServerRuntime
-> G4

F1a createBrowserApplication 生命周期与专项
-> F1b router disposer、session/state/sync/shell ports
-> F2 低耦合 features
-> F3-F9
-> F10 runtime 收口
-> G6
```

首批只建立目标模块和失败/恢复测试，不接生产入口。共享入口接线、旧实现删除、
barrel、登记和 package/system runner 均由调度者串行处理。

## 首批所有权

| task | owner | ownership | forbidden | acceptance |
| --- | --- | --- | --- | --- |
| C0 | `orchestrator` | entrypoint checker、fixture、机器策略 | 不改业务入口 | 正反例与 G3 通过 |
| B1a | `backend-store-worker` | 新 Store schema/normalization 模块和专项 | `server.mjs`、barrel、登记、package | 固定时钟、v1→v16、幂等、扩展字段、失败边界 |
| F1a | `frontend-application-worker` | 新 application 模块和专项 | runtime、pages、registry、barrel、登记、package | start/reset/stop 顺序、重复调用、失败传播 |
| I | `orchestrator` | 两入口、公共 barrel、登记、runner、调度记录 | 不顺改产品行为 | 逐批接线后运行影响门 |

## B2/F2 所有权

| task | owner | ownership | forbidden | acceptance |
| --- | --- | --- | --- | --- |
| B2-S | `b2-scout` | `server.mjs` 本地测试、账户初始化/恢复闭包与相关测试，只读 | 不修改文件、不调用远程/Base | 精确符号、依赖、迁移顺序、测试与风险 |
| B2-W | `b2-backend-worker` | `src/app/` 内新 local-test/account lifecycle 模块与独立专项 | 两入口、公共 barrel、登记、package、持久化 schema | 本地工作区、只读水合、初始化/恢复成功与失败契约 |
| F2-S | `f2-scout` | discovery/actions/feedback/export/home feature 闭包，只读 | 不修改文件、不调用远程/Base | 真实 lazy 候选、closure/PWA 风险和测试矩阵 |
| F2-W | `f2-feature-worker` | F2 选定 feature 内部模块、descriptor/controller 与独立专项 | runtime、公共 barrel、pages、HTML/CSS、Service Worker | 隐藏页面不加载，start/stop/失败/账户切换可验证 |
| I2 | `orchestrator` | 两入口、公共 barrel、登记、runner、Service Worker、调度记录 | 不顺改产品行为，不放宽 closure/PWA 预算 | B2 先串行接线并删旧实现；F2 就绪后同批接 ports/application |
| V2 | `b2-f2-validator` | 冻结差分只读验证 | 不改实现或放宽断言 | local-mode/auth/runtime-infrastructure/backend；frontend/Journey/closure |
| R2 | `b2-f2-reviewers` | 冻结差分独立复审 | 只读 | blocker/P0/P1 清零后才可进入下一批 |

## 角色知识账

| roleId | specialty | activeContext | ownership | dependencies | communications | evidence | status | next |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `orchestrator` | 契约冻结与串行集成 | `9ba9f64`；iteration-G3 / entrypoint-G2 | 共享文件与集成树 | 全部角色 | 串行接入 B2 并关闭 reviewer findings | B1a-B2、F1a/F1b 与门禁强化已集成 | `active` | 进入 F2 真实 lazy feature |
| `backend-scout` | B1-B7 符号与闭包 | `server.mjs` 3283 行 | 只读 | B1a | 建议 B1a→B1b→B1c | 无生产 runtime 骨架 | `closed` | 移交 B1a |
| `frontend-scout` | F1-F10 页面与 lifecycle | `runtime.mjs` 5291 行 | 只读 | F1a | 先 application/router disposer | registry 未接线 | `closed` | 移交 F1a |
| `gate-scout` | G4/G6 与测试真实性 | 20 条例外 | 只读 | C0/I | 报告 policy 冲突与死代码假绿 | G4/G6 按预期失败 | `closed` | 等待复核 |
| `orchestration-secretary` | 依赖与证据缺口 | SOP、计划、报告 | 只读 | 全部角色 | 固定工作树与单写边界 | 调度草案已移交 | `closed` | 后续更新知识账 |
| `backend-store-worker` | Store v16 归一化 | B1a | 新模块和专项 | backend-scout | 目标模块交给调度者接线 | `f3724c4`；backend 通过 | `closed` | B1b |
| `frontend-application-worker` | browser lifecycle | F1a | 新模块和专项 | frontend-scout | 多轮竞态修复后冻结 | `e7d99d6`、`6d74383` | `closed` | F1b |
| `independent-reviewer` | 冻结差分复审 | 首批集成差分 | 只读 | C0/B1a/F1a/I | 多轮只报 blocker/P0/P1 | 最终 GO，`0/0/0` | `closed` | 下一批复审 |
| `b1bc-scout` | 派生统计与公开投影闭包 | `f627eeb` | 只读 | B1a | 冻结 7 个符号、4 类消费者和隐私边界 | 精确行号、测试矩阵与接线风险 | `closed` | 已移交调度者 |
| `b1bc-secretary` | 第二批依赖与证据账 | `f627eeb` | 只读 | B1b/B1c/I | 固定共享入口单写与串行顺序 | 工作树、G3/G4 和 reviewer 清单 | `closed` | 已写入总账 |
| `b1b-reviewer` | 统计口径行为等价 | `47d5a39` 前冻结差分 | 只读 | B1b/I | 核对日期、排序、留痕和双实现 | GO，blocker/P0/P1=`0/0/0` | `closed` | F1b 后续复审 |
| `b1c-reviewer` | 隐私、账户与消费链 | `47d5a39` 前冻结差分 | 只读 | B1c/I | 核对四类消费者、例外 SHA 和 runner | GO，blocker/P0/P1=`0/0/0` | `closed` | F1b 后续复审 |
| `f1b-router/state/runtime-scouts` | router、ports 与 runtime 闭包 | `4d3efba` | 只读 | F1a | 冻结 disposer、账户代际和 closure 约束 | 3 份闭包/竞态/测试矩阵 | `closed` | 已移交 F1b |
| `f1b-secretary` | 任务图、预算与证据失效 | `4d3efba` | 只读 | F1b/I | 固定不创建写工作树与 F2 接线条件 | 角色账和 reviewer 清单 | `closed` | 已写入总账 |
| `f1b-reviewers` | router/ports 独立复审 | `48e5d6b` 前冻结差分 | 只读 | F1b/I | 多轮复现并关闭竞态与夹具假绿 | 最终 GO，blocker/P0/P1=`0/0/0` | `closed` | F2 复审 |
| `b2-scout` | 本地测试、账户生命周期闭包 | `47d24a0`；B2 | 只读 | B1c/I2 | 核对 local-test、auth、runtime-infrastructure 与 persistence | 精确闭包、迁移顺序与风险已移交 | `closed` | B2 已集成 |
| `f2-scout` | 低耦合 feature 与真实 lazy 边界 | `47d24a0`；F2 | 只读 | F1b/I2 | 核对 discovery/actions/feedback/export/home 与 closure/PWA | export/feedback/discovery 候选、PWA/closure 风险已移交 | `closed` | 先实现 export descriptor |
| `b2f2-secretary` | 第二批状态、所有权与证据账 | `47d24a0`；SOP/计划/报告 | 只读 | B2/F2/I2 | 指出门禁命名、文档状态和 ownership 缺口 | 工作树 5/6；B2/F2 派发清单已移交 | `closed` | 接线后复核五处状态一致性 |
| `b2-backend-worker` | local-test/account lifecycle 叶子模块 | `47d24a0`；B2 | 新模块和专项 | b2-scout/I2 | 两个无冲突叶子任务移交调度者接线 | `7430973`、`f53ab06`；专项通过 | `closed` | B2 已集成 |
| `f2-feature-worker` | 真实 lazy feature 叶子实现 | `47d24a0`；等待 F2-S | 选定 feature 内部文件和专项 | f2-scout/I2 | 尚未派发写任务 | 无 | `queued` | 接收冻结候选后实现，不碰 runtime/barrel |
| `b2-f2-validator` | B2/F2 独立影响验证 | `9ba9f64`；B2 冻结差分 | 只读 | B2/I2 | 保留失败与通过样本 | check、专项、auth、persistence、restore、主 regression、backend 通过 | `closed` | F2 后重新验证前端 |
| `b2-f2-reviewers` | 生命周期、隔离与 lazy 真实性复审 | `9ba9f64`；B2 冻结差分 | 只读 | V2 | 多轮关闭原子性、隔离与测试假绿 | 最终 GO，blocker/P0/P1=`0/0/0` | `closed` | F2 冻结后复审 |

## 已关闭问题与保留风险

- `BLOCKER-04-01` 已关闭：`application.mjs` 已建立独立公开模块，browser
  policy 同时允许并要求该 specifier；生产 runtime 尚未接线。
- `P0-ENTRY-01` 已关闭：factory/use 绑定顶层导出直接作用域和可达语句；
  bootstrap 与 20 条例外另绑定源文件 SHA，G4/G6/G7 有显式命令。
- `P0-B1-01` 已关闭：Store v16 默认值、归一化和商业化迁移已从入口删除并由
  `src/app` 唯一实现，专项直接经过 public barrel。
- `P0-B1-02` 已关闭：问题聚类、趋势/关联洞察和用户留痕判定迁至
  `src/app/derived-statistics.mjs`；固定日期与输入不变性专项已接入系统门。
- `P0-B1-03` 已关闭：角色化公开 Store 投影迁至
  `src/app/public-state.mjs`；legacy state、route-state、sync 和本地水合共用
  同一 projector，商业化、回收、清理队列、私有语音缓存和普通用户
  `tokenBudget` 继续隐藏。
- F1a 多轮关闭 pending start、迟到 disposer、reset/stop 重入、cleanup lock、
  直接/异步包装自引用和 timeout 后迟到清理；最终 Reviewer 无 P1。
- `P0-F1-01` 已关闭：router 构造无浏览器副作用，`start()` 返回周期归属的
  幂等 disposer；监听、RAF、timer 和 `scrollRestoration` 均可回收，权限拒绝、
  ABA 导航、同步/异步失败和 stale pop 有专项。
- `P0-F1-02`：当前 25 个 descriptor 均指向同一 features barrel，尚不是真实
  lazy feature registry。
- `P0-PWA-01`：当前 Service Worker 预缓存 runtime 与全部 feature 模块；F2
  接线前必须重新冻结 lazy cache 和 closure budget。
- `P1-TEST-01`：handler/page 检查主要核对声明；真实接线仍需行为测试。
- `P1-TEST-02`：Journey Smoke 不在 `test:system all` 内，F2/G6 必须单独执行。

## 单写边界

以下文件只由调度者修改：

- `server.mjs`
- `public/frontend/app/runtime.mjs`
- `src/app/index.mjs`
- `src/http/index.mjs`
- `public/frontend/features/index.mjs`
- `public/frontend/pages/index.mjs`
- `knowledge/module-boundaries.json`
- `package.json`
- `scripts/system-test.mjs`
- `public/service-worker.js`
- `scripts/web-first-screen-budget-regression.mjs`
- 状态文档与本调度记录

## 首批验证

```text
npm run test:entrypoints
npm run check
node scripts/store-normalization-regression.mjs
node scripts/frontend-application-regression.mjs
npm run test:persistence
npm run test:restore
npm run test:auth
npm run test:sync
npm run test:frontend-shell
```

实际结果：

- 本地提交：`f3724c4`、`174ee83`、`e7d99d6`、`6d74383`、`2989e61`。
- `npm run check`、persistence、restore、主 regression、sync、frontend shell、
  entrypoint/module negative fixtures 均通过。
- backend suite：通过，`405823 ms`。
- frontend suite：通过，`80094 ms`。
- `check:entrypoints:g4` 按设计因首条 server G4 例外到期而失败；当前仍是 G3，
  不把首批检查点写成 G4 完成。
- 最终综合 Reviewer：GO，blocker/P0/P1=`0/0/0`。
- Base 回读：需求池 `rev=359 / 238`、研发交付 `rev=115 / 92`。整体需求
  `reczz28JPK4rO6LI` 及 03/04 交付 `reczz28JPdCVWPzV`、
  `reczz28JPdCVXtsA` 均为“进行中 / 未发布”。
- 未执行 push、tag、Release、Preview、部署、云资源修改、真实付费调用或
  生产写入。

## B1b/B1c 检查点

- 本地提交：`47d5a394977593e79c6c94aae3f42f3f8f71f138`。
- 新增派生统计与公开投影两个应用模块及两个直接经 public barrel 的专项；
  `server.mjs` 同批删除旧实现，无运行时双轨，2866→2668 行。
- `npm run check`、derived/public-state、startup、sync、persistence、restore、
  主 regression 与 auth 全通过。
- backend suite：通过，`326672 ms`；其中 auth、API v1、local-test 水合、
  restore、部署与 Preview 隔离回归均通过，未执行远端动作。
- 两个独立 Reviewer 均 GO，blocker/P0/P1=`0/0/0`。保留测试缺口是更细的
  `-6/-29` 临界日、未来日期现有行为和 association Top 3 并列夹具，不是本批
  行为漂移或发布阻断。
- server 10 条 G4 例外仍绑定当前 SHA
  `0e637c46dae7275c8f3770175d7bfebf5eb1e16543996973de9c5e208eb5c047`，
  G4 到期条件未放宽或改期。

## F1b 检查点

- 本地提交：`208cba7`（router/catalog/closure/PWA）和 `48e5d6b`
  （session/state/sync/shell ports 与专项）。
- `createPageRouter` 已提供真实 start/disposer；F1b ports 保持未接线，必须等
  F2 提供真实 lazy descriptors 后与 `createBrowserApplication` 同批接入，
  不用 25 个共享 barrel descriptor 制造静态假通过。
- `npm run check`、application/ports/router/contracts/sync/shell/PWA/URL/UI/
  mobile 全通过；frontend suite `77626 ms`，Journey Smoke `14/14`
  `63416 ms`。
- 最终固定条件 web budget `29514 ms` 通过：entry `10 / 61300 B`，
  deferred runtime `24 / 819195 B`；未提高 `24 modules / 800 KiB` 门。
- 过程保留三类性能失败样本：两次 `app.js` 比 FCP 早 `16.2 ms / 2.2 ms`，
  一次 warm firstReadable P75 `750.6 ms > 750 ms`；独立重跑收敛。
- router/ports 多轮 reviewer 最终 GO，blocker/P0/P1=`0/0/0`。runtime 仍
  5291 行，10 条 browser 例外继续绑定 SHA
  `edb425c7d2f1a3cd856463cdf7dd53f181abaeb1001247465fe0170ad7101f46`，
  G6 条件未放宽。

## B2 检查点

- 本地提交：`a35dad8`、`7430973`、`f53ab06`、`f824524`、`40b5021`、
  `816d156`、`0a912ec`、`9ba9f64`。
- 本地测试 control/workspace、上游 GET-only 水合、隔离 Cookie、账户初始化、
  JSON/PG 认证审计与逐账户恢复均已离开入口；`server.mjs` 2668→2295 行。
- workspace 切换先在 staging 完整构建，再在 Store 队列独占区换目录；水合
  使用 commit 后 pending-control 恢复。Range/If-Range、HEAD、206/416 继续透传。
- 多轮 reviewer 关闭根目录误恢复、注册孤儿目录、reset/control 原子性、
  barrier 换代、hydrate 崩溃窗口、Range 假绿和认证审计归属；最终 GO，
  blocker/P0/P1=`0/0/0`。
- `npm run check`、B2 四专项、local-mode、auth、startup、persistence、
  restore、主 regression 和 backend 均通过。过程保留两次失败样本：
  hydrate 被错误纳入 switch barrier 导致 `504`；固定时钟夹具跨日得到
  `2026-10-06`。两者均修复并复测。
- 真实 PostgreSQL 稳定门因本机缺少 PostgreSQL 16 的 `postgres/initdb/pg_ctl`
  未运行；preflight 回归通过。server 10 条 G4 例外绑定 SHA
  `057b6fa80a6bca478c41367ada48eb237de2b520b4e8b7e868e56163b664c99f`，
  行数上限收紧为 2295，G4 到期条件未放宽。

下一步：F2 先实现 export、feedback、discovery 的真实 lazy descriptors，
再由调度者同批接入 F1b application/ports；不使用共享 barrel 假 lazy。
