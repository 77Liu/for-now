# V0.5.8-03/04 多 Agent 调度记录

- 日期：2026-10-05
- 起始基线：`f911cde4505d3434ab4afcf4b5614f8e828f4bcc`
- 当前门禁：`G3`
- 当前状态：`first-batch-verified`
- 活跃工作树：`5 / 6`
- 机器事实：3 个入口策略、59 个模块、233 条拥有路由、20 条迁移例外；
  `server.mjs` 由 3283 行降至 2866 行
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

## 角色知识账

| roleId | specialty | activeContext | ownership | dependencies | communications | evidence | status | next |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `orchestrator` | 契约冻结与串行集成 | `f911cde`；G3 | 共享文件与集成树 | 全部角色 | 固定任务图并处理 blocker | 首批 5 个本地提交；G3 通过 | `integrated` | 进入 B1b/B1c/F1b |
| `backend-scout` | B1-B7 符号与闭包 | `server.mjs` 3283 行 | 只读 | B1a | 建议 B1a→B1b→B1c | 无生产 runtime 骨架 | `closed` | 移交 B1a |
| `frontend-scout` | F1-F10 页面与 lifecycle | `runtime.mjs` 5291 行 | 只读 | F1a | 先 application/router disposer | registry 未接线 | `closed` | 移交 F1a |
| `gate-scout` | G4/G6 与测试真实性 | 20 条例外 | 只读 | C0/I | 报告 policy 冲突与死代码假绿 | G4/G6 按预期失败 | `closed` | 等待复核 |
| `orchestration-secretary` | 依赖与证据缺口 | SOP、计划、报告 | 只读 | 全部角色 | 固定工作树与单写边界 | 调度草案已移交 | `closed` | 后续更新知识账 |
| `backend-store-worker` | Store v16 归一化 | B1a | 新模块和专项 | backend-scout | 目标模块交给调度者接线 | `f3724c4`；backend 通过 | `closed` | B1b |
| `frontend-application-worker` | browser lifecycle | F1a | 新模块和专项 | frontend-scout | 多轮竞态修复后冻结 | `e7d99d6`、`6d74383` | `closed` | F1b |
| `independent-reviewer` | 冻结差分复审 | 首批集成差分 | 只读 | C0/B1a/F1a/I | 多轮只报 blocker/P0/P1 | 最终 GO，`0/0/0` | `closed` | 下一批复审 |

## 已关闭问题与保留风险

- `BLOCKER-04-01` 已关闭：`application.mjs` 已建立独立公开模块，browser
  policy 同时允许并要求该 specifier；生产 runtime 尚未接线。
- `P0-ENTRY-01` 已关闭：factory/use 绑定顶层导出直接作用域和可达语句；
  bootstrap 与 20 条例外另绑定源文件 SHA，G4/G6/G7 有显式命令。
- `P0-B1-01` 已关闭：Store v16 默认值、归一化和商业化迁移已从入口删除并由
  `src/app` 唯一实现，专项直接经过 public barrel。
- F1a 多轮关闭 pending start、迟到 disposer、reset/stop 重入、cleanup lock、
  直接/异步包装自引用和 timeout 后迟到清理；最终 Reviewer 无 P1。
- `P0-F1-01`：`createPageRouter` 注册全局监听但没有 disposer，无法满足
  application stop 和重复启动闭包；留给 F1b。
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

下一步：B1b 派生统计、B1c 公开状态投影、F1b router/session/state/sync/shell
ports；继续由调度者单写两个入口。
