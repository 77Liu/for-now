# V0.5.8-03/04 多 Agent 调度记录

- 日期：2026-10-05
- 起始基线：`f911cde4505d3434ab4afcf4b5614f8e828f4bcc`
- 当前门禁：`iteration-G4 / entrypoint-G4-closed`
- 当前状态：`f4-closed-f5-next`
- 活跃工作树：`5 / 6`（B6 叶子已清理）
- 机器事实：3 个入口策略、68 个模块、237 条拥有路由、6 条迁移例外；
  `server.mjs` 由 3283 行降至 4 行，`runtime.mjs` 当前为 4527 行
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

## F2 slice 2 所有权

| task | owner | ownership | forbidden | acceptance |
| --- | --- | --- | --- | --- |
| F2-A-S | `f2-actions-scout` | actions 闭包、同步与账户边界，只读 | 不修改文件、不调用远程/Base | 精确符号、生命周期、离线/冲突与接线风险 |
| F2-H-S | `f2-home-scout` | home/default route 闭包与首屏预算，只读 | 不修改文件、不调用远程/Base | 判断当前能否替换 today descriptor |
| F2-G-S | `f2-gate-scout` | Journey、PWA、closure 与 entrypoint 门，只读 | 不修改文件、不放宽预算 | 验收矩阵、证据失效与拒绝条件 |
| F2-A-W | `f2-actions-worker` | `features/actions` 内 coordinator/controller/public entry 与独立专项 | runtime、共享 barrel、登记、package、SW、HTML/CSS | 离线/冲突、迟到响应、重复 mount、reset 和草稿保留 |
| I3 | `orchestrator` | runtime 接线、共享 barrel、登记、runner、PWA/预算与调度记录 | 不顺改产品行为，不替换 home page descriptor | actions 旧实现/监听删除，无双轨，默认路由预算不放宽 |
| V3 | `f2-actions-validator` | 固定差分只读验证 | 不改实现或断言 | actions 专项、check、frontend/Journey、PWA/预算 |
| R3 | `f2-actions-reviewers` | coordinator/controller 与集成差分独立复审 | 只读 | blocker/P0/P1 清零 |

## B3 AI runtime 所有权

| task | owner | ownership | forbidden | acceptance |
| --- | --- | --- | --- | --- |
| B3-S | `b3-ai-runtime-scout` | AI 装配闭包、消费者与依赖，只读 | 不修改文件、不调用真实供应商或远程服务 | 精确迁移符号、公开 API、循环依赖与接线顺序 |
| B3-G-S | `b3-ai-runtime-gate-scout` | AI 预算、provider、审计与启动恢复测试，只读 | 不修改实现、不执行 Preview/生产动作 | 失败矩阵、现有证据与缺口 |
| B3-W | `b3-ai-runtime-worker` | `src/app/ai-runtime.mjs` 与独立专项 | `server.mjs`、app barrel、模块登记、package、HTTP 与其他领域 | provider/gate/settings/usage/cost/budget/audit/generator 工厂和恢复契约 |
| I4 | `orchestrator` | app barrel、`server.mjs` 单轨接线、模块登记、runner 与状态文档 | 不改路由、Store/schema、Prompt、模型参数、价格、预算策略或 provider 行为 | 删除入口旧装配，无双轨，入口 SHA/行数收紧 |
| V4 | `b3-ai-runtime-validator` | 固定集成差分只读验证 | 不改实现或放宽断言 | check、AI budget/provider/observability/auth/local-runtime/backend |
| R4 | `b3-ai-runtime-reviewers` | AI 装配、恢复、账户与错误边界独立复审 | 只读 | blocker/P0/P1 清零 |

## B4 媒体 runtime 所有权

| task | owner | ownership | forbidden | acceptance |
| --- | --- | --- | --- | --- |
| B4-S | `b4-media-scout` | 附件、OCR、健康/书目、ASR/TTS 闭包与既有模块，只读 | 不修改文件、不调用真实供应商 | 精确迁移符号、依赖、复用边界与写集 |
| B4-G-S | `b4-gate-scout` | storage、records、library、Volcengine 与 backend 门禁，只读 | 不修改实现、不调用远程服务 | 冻结失败矩阵、专项和隔离环境限制 |
| B4-W | `b4-media-worker` | `src/app/media-runtime.mjs`、内部 media 模块、health 归一化与独立专项 | `server.mjs`、公共 barrel、HTTP、登记、package、runner | 账户隔离、幂等/补偿、OCR fallback、预算 stage、ASR stale 与 sweep |
| I5 | `orchestrator` | app/http barrel、legacy 图片 handler、`server.mjs` 单轨接线、登记与 runner | 不迁 B5 后台任务入队，不改 schema/Prompt/模型/预算/路由顺序 | 删除入口旧实现，provider 例外归零，入口 SHA/行数收紧 |
| V5 | `orchestrator` | 冻结差分影响验证 | 不放宽门禁或重复完整 backend | check、媒体专项、影响门、backend |
| R5 | `b4-media-reviewer` | 附件/媒体/预算/启动闭包独立复审 | 只读 | blocker/P0/P1 清零 |

## B5 内容 runtime 所有权

| task | owner | ownership | forbidden | acceptance |
| --- | --- | --- | --- | --- |
| B5-S | `orchestrator` | thoughts/captures/journals/reviews、后台任务、个人语境闭包与测试 | 不修改代码、不调用远程服务 | 精确依赖、循环引用、接线顺序和失败矩阵 |
| B5-W | `b5-content-worker` | `src/app/content-runtime.mjs`、`src/app/content/*` 与独立专项 | `server.mjs`、公共 barrel、登记、package、runner | 账户隔离、幂等并发、迟到拒写、ASR 去重、个人语境脱敏 |
| I6 | `orchestrator` | app barrel、`server.mjs` 单轨接线、登记、package 与 runner | 不改 schema/Prompt/模型/预算/路由顺序 | 删除入口旧装配，无双轨，入口 SHA/行数收紧 |
| V6 | `orchestrator` | 冻结差分影响验证 | 不放宽门禁或重复完整 backend | check、内容专项、影响门、backend |
| R6 | `b5-content-reviewer` | 内容/后台任务/账户与媒体接线独立复审 | 只读 | blocker/P0/P1 清零 |

## 角色知识账

| roleId | specialty | activeContext | ownership | dependencies | communications | evidence | status | next |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `orchestrator` | 契约冻结与串行集成 | `5505d29`；iteration-G3 / entrypoint-G4-code | 共享文件与集成树 | 全部角色 | 完成 B7、F3 与 F4.1 接线、验证及复审 | server 只启动且 4 行；checkins presenter 已迁出；PG stable 待环境 | `active` | F4.2-F10 / G5-G7 |
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
| `f2-feature-worker` | 真实 lazy feature 叶子实现 | `c3c4033`；F2 slice 1 | export/feedback/discovery/legacy adapter 内部文件与专项 | f2-scout/I2 | controller API 冻结后交给调度者接线 | 4 个生命周期专项通过 | `closed` | actions/home 另行冻结 |
| `b2-f2-validator` | B2/F2 独立影响验证 | `4ee0921`；F2 冻结差分 | 只读 | B2/I2 | 重跑 check、entrypoint、F2、PWA、URL 与最终大门 | 最终 check/web/frontend/Journey 全通过 | `closed` | 下一切片重新验证 |
| `b2-f2-reviewers` | 生命周期、隔离与 lazy 真实性复审 | `4ee0921`；F2 冻结差分 | 只读 | V2 | 多轮关闭 reset scrub、ABA 与 rollback tail | 最终 GO，blocker/P0/P1=`0/0/0` | `closed` | 下一切片复审 |
| `f2-actions-scout` | actions UI、同步和账户闭包 | `a48f93e`；F2 slice 2 | 只读 | F2-A-W/I3 | 冻结 coordinator/controller 分层与迟到响应风险 | 精确符号、测试矩阵与共享接线点已移交 | `closed` | actions worker |
| `f2-home-scout` | 默认首页与跨域闭包 | `a48f93e`；F2/F4-F10 | 只读 | I3 | 核对首屏时序、跨域依赖与预算 | 完整 home controller 当前 NO-GO | `closed` | 分域迁移后 F10 收口 |
| `f2-gate-scout` | Journey、PWA 与预算真实性 | `a48f93e`；F2 slice 2 | 只读 | V3/R3 | 固定 G3 证据与拒绝条件 | actions/home 影响矩阵已移交 | `closed` | 接线后验证 |
| `f2-actions-worker` | actions coordinator/controller | `5781115`；F2 slice 2 | actions 内部文件与独立专项 | F2-A-S/I3 | 叶子模块交给调度者接线 | 叶子提交已集成，工作树已移除 | `closed` | 后续按新切片重新派发 |
| `f2-actions-validator` | F2 slice 2 独立影响验证 | `eca9576` | 只读 | I3 | 重跑专项、系统与预算门 | check、frontend、Journey、PWA/预算全通过 | `closed` | B3 重新验证 |
| `f2-actions-reviewers` | actions 生命周期与隔离复审 | `eca9576` 固定差分 | 只读 | V3 | 复现失败路径并清零高优问题 | 最终 GO，blocker/P0/P1=`0/0/0` | `closed` | 下一切片复审 |
| `b3-ai-runtime-scouts` | AI runtime 闭包与门禁 | `c028a0b`；B3 | 只读 | B3-W/I4 | 冻结装配 API、late-bound owner reader 与失败矩阵 | 精确闭包、消费者和测试缺口已移交 | `closed` | B3 worker |
| `b3-ai-runtime-worker` | AI runtime 应用工厂 | `1f93e3b`；B3 | 新模块与独立专项 | B3-S/I4 | 叶子模块交给调度者接线 | `280887c` 已集成，叶子工作树已移除 | `closed` | B4 |
| `b3-ai-runtime-validator` | B3 独立影响验证 | `855200c` | 只读 | I4 | 重跑 AI/认证/后端与入口门 | check、影响门和 backend `82/82` 通过 | `closed` | B4 重新验证 |
| `b3-ai-runtime-reviewers` | 预算、审计、账户与启动复审 | `855200c` 固定差分 | 只读 | V4 | 复现失败路径并清零高优问题 | GO，blocker/P0/P1=`0/0/0` | `closed` | 下一切片复审 |
| `b4-media-scouts` | 媒体 runtime 闭包与门禁 | `ccfa8ff`；B4 | 只读 | B4-W/I5 | 冻结附件、识别、ASR/TTS、缓存与隔离测试矩阵 | 精确闭包、已有模块与环境限制已移交 | `closed` | B4 worker |
| `b4-media-worker` | 媒体 runtime 应用工厂 | `3d313e0`；B4 | media 内部模块、health 归一化与独立专项 | B4-S/I5 | 叶子模块交给调度者接线 | `00087be` 已集成，叶子工作树已移除 | `closed` | B5 |
| `b4-media-validator` | B4 独立影响验证 | `6eee683` | 只读 | I5 | 重跑媒体/附件/认证/预算与 backend | check、影响门和 backend `83/83` 通过 | `closed` | B5 重新验证 |
| `b4-media-reviewer` | 媒体账户、预算、清理与启动复审 | `6eee683` 固定差分 | 只读 | V5 | 只报生产可达 blocker/P0/P1 | GO，blocker/P0/P1=`0/0/0` | `closed` | 下一切片复审 |
| `b5-content-worker` | 内容 runtime 应用工厂 | `0273b68`；B5 | content runtime、内部资源/后台/工作流模块与独立专项 | B5-S/I6 | 叶子模块交给调度者接线 | `cac2496` 已集成，叶子工作树已移除 | `closed` | B6 |
| `b5-content-validator` | B5 影响验证 | `342571d` | 只读 | I6 | 重跑内容/任务/媒体与 backend | check、影响门和 backend `83/83` 通过；新专项已纳入后续 84 阶段 runner | `closed` | B6 重新验证 |
| `b5-content-reviewer` | 内容、任务、账户与媒体接线复审 | `342571d` 固定差分 | 只读 | V6 | 只报生产可达 blocker/P0/P1 | GO，blocker/P0/P1=`0/0/0` | `closed` | 下一切片复审 |
| `b6-http-worker` | Owner/statistics/admin/legacy HTTP 编排 | `c7903cc`；B6 | 新 app/http 模块与专项 | I7 | 叶子模块交给调度者接线 | `5bc5a80` 已集成，待清理叶子工作树 | `closed` | B7 |
| `b6-http-validator` | B6 影响与完整后端验证 | `2320d1a` | 只读 | I7 | 重跑 check、Owner/鉴权/统计/UI 与 backend | check、影响门和 backend `90/90` 通过 | `closed` | B7 重新验证 |
| `b6-http-reviewer` | HTTP 顺序、权限、代理与单轨复审 | `2320d1a` 固定差分 | 只读 | V7 | 只报生产可达 blocker/P0/P1 | GO，blocker/P0/P1=`0/0/0` | `closed` | 下一切片复审 |
| `b7-server-reviewer` | 服务端组合根、路由顺序与生命周期复审 | `17fca0d` 前冻结差分 | 只读 | B7 | 只报生产可达 blocker/P0/P1 | GO；真实 JSON 启动、ready、SIGTERM 与日志复验通过，`0/0/0` | `closed` | F3-F10 |
| `f3-notifications-worker` | 通知 presenter 与页面 lifecycle | `a45cba7`；F3.1 | notifications 内部模块与专项 | I8 | 叶子模块交给调度者接线 | controller/presenter 与迟到隔离专项已集成 | `closed` | F3.2 |
| `f3-notifications-reviewers` | 深链、离页接管与 PWA 复审 | `dfbcaf5` 固定差分 | 只读 | I8 | 只报生产可达 blocker/P0/P1 | 两项 P1 修复后 GO，blocker/P0/P1=`0/0/0` | `closed` | F3.2 重新验证 |
| `f3-annotations-worker` | 批注 presenter、DOM 与账户 lifecycle | `78e5fc1`；F3.2 | annotations 内部模块与专项 | I9 | 由调度者串行接入 runtime/media/shell | 旧实现单轨删除；专项、UI、PWA/预算通过 | `closed` | F3.3 |
| `f3-annotations-reviewers` | 加载降级、账户迟到和跨 root 复审 | `78e5fc1` 固定差分 | 只读 | I9 | 只报生产可达 blocker/P0/P1 | 三项 P1 修复后 GO，blocker/P0/P1=`0/0/0` | `closed` | F3.3 重新验证 |
| `f3-background-results-worker` | 结果合并、账户代际与跨内容定位 | `5ca856d`；F3.3 | background-results 内部模块与专项 | I10 | 由调度者串行接入 runtime/annotations/PWA | discovery 错误归属与入口旧实现单轨删除 | `closed` | F4 |
| `f3-background-results-reviewers` | 最终任务重试、定位竞态与 PWA lazy 边界复审 | `5ca856d` 固定差分 | 只读 | I10 | 只报生产可达 blocker/P0/P1 | 两项 P1 修复后 GO，blocker/P0/P1=`0/0/0` | `closed` | F4 重新验证 |

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
- `P0-F1-02` 已关闭：export、feedback、discovery 使用直接 public entry 的
  字面量动态 import；其余 22 页使用显式 legacy adapter，不再指向共享 barrel。
- `P0-PWA-01` 已关闭：Service Worker install 不再预缓存 3 个 lazy feature，
  首次使用后按版本缓存；shell、默认路由增量和单页 lazy closure 分层设门。
- `P1-TEST-01` 已关闭：新增 descriptor 静态门、4 个 controller 专项、
  `aria-busy` 真实路由交互、账户 reset、迟到响应和 router ABA/rollback 测试。
- `P1-TEST-02` 仍是流程约束：Journey Smoke 不在 `test:system all` 内，本批已
  另行执行并通过 `14/14`。

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

## F2 slice 1 检查点

- 本地提交：`c3c4033`（feature controllers）和 `4ee0921`
  （application/ports、真实 descriptors、PWA/预算与 runner 接线）。
- export、feedback、discovery 已拥有 fresh controller、root 内 DOM、幂等
  disposer、账户 reset 和迟到响应隔离；runtime 同批删除旧 presenter、loader、
  事件监听和私有状态，无运行时双轨。
- `createBrowserApplication`、feature registry 及 state/sync/shell ports 已接入；
  router 对 import/mount 标记 `aria-busy`，A→B→A、失败 rollback 与 rollback
  pending 时的新导航均串行恢复到唯一 controller。
- Service Worker 为 `cike-shell-v0.5.8-4`：3 个 lazy feature 不进入 install，
  访问后 cache-on-use。入口固定门未放宽，最终 shell 为
  `23 modules / 819087 B`；默认路由增量 `2 / 12000 B`；export、feedback、
  discovery 分别为 `3 / 13218 B`、`3 / 24922 B`、`3 / 31130 B`，首页隐藏
  feature 请求为 `0`。
- 最终固定条件 web budget `30534 ms` 通过：冷启动 firstReadable P75/P95
  `740.9 / 757.2 ms`，暖启动 `736.3 / 738.2 ms`。开屏入口改为在已观测
  first-contentful-paint 后注入，关闭此前 app.js 早于 FCP 的不稳定样本。
- `npm run check`、entrypoint、4 个 F2 专项、G2、PWA、URL/history、UI、mobile
  均通过；frontend suite `84074 ms`，Journey Smoke `14/14`、`64336 ms`。
- 多轮 reviewer 关闭 export reset 残留、A→B→A 无 controller 和 rollback
  enter 脱离 transition tail；最终 GO，blocker/P0/P1=`0/0/0`。
- browser factory/call/import/import-binding 4 条例外已删除；剩余 6 条 G6 例外
  绑定 `runtime.mjs` SHA
  `820e48e3177536893cc82dafb1a49392c741f2b356a936eacad56ef8da6b6a16`，
  行数上限收紧为 5275。全库迁移例外由 20 降至 16，G6 条件未放宽。
- 未执行 push、tag、Release、Preview、部署、云资源修改、Base 写入、真实付费
  调用或生产写入。

## F2 slice 2 冻结

- 基线：`a48f93e02729b36d071ee2039dc921fad41653f0`，集成树干净；叶子工作树
  建立后为 `6 / 6`，不得再创建工作树；仍为 `iteration-G3 / entrypoint-G2`。
- actions 冻结为长驻 headless coordinator + `today` 根内可回收 controller。
  coordinator 在页面未挂载时仍负责 discovery 转行动、同步 pending 恢复和
  incremental snapshot；controller 只拥有 DOM、表单和 root 内事件。
- `today` 当前每路由只能激活一个 controller，完整 home 又直接耦合 F4 mood、
  F5 thoughts、F6 capture/voice、F7 library 和 F8 keepsake。首屏渲染还发生在
  `state.start/load()` 内，立即替换 descriptor 会改变 opening 就绪时序。
- 因此本批不伪造完整 home lazy：`today` 继续登记 legacy page adapter；
  memory helper 保持现有纯 API，首页各领域随 F4-F8 迁移，F10 再一次性替换
  home descriptor 与首屏启动顺序。
- actions 叶子模块不得修改 runtime、共享 barrel、entrypoint policy、
  Service Worker、HTML/CSS 或 package；这些由调度者串行接线，并同批删除
  runtime 旧 presenter、请求、状态和监听，禁止双轨。
- 必测：重复 mount/unmount、root 外事件、创建草稿保留、409/412、离线 pending、
  刷新失败、旧 list/command 迟到、A→B→A、账户 reset、未挂载 pending 恢复、
  local-test today hydrate、discovery 转行动。
- 门禁不得放宽：runtime `24 modules / 800 KiB`、默认路由 `2 / 16 KiB`、
  hidden feature 零请求及 6 条 G6 例外的到期条件保持不变；每次 runtime
  变化都重算 SHA 与实际计数。
- 受影响 Journey：`fast-visible-shell`、`home-group-navigation-stability`、
  `home-r8-single-screen`、`auth-session-boundary`、`offline-sync-recovery`、
  `local-online-snapshot`、`delete-trash-restore`、响应式/URL 恢复。

以上为冻结时的执行边界；实际完成证据见下一节。

## F2 slice 2 检查点

- 本地提交：`afcf95b`、`60b317c`、`06854ce`、`eca9576`。actions 已拆为
  长驻 headless coordinator 与首次展开才加载的 workspace controller；
  runtime 旧状态、请求、渲染与全局监听已删除，无双轨。
- coordinator 覆盖离线 projection、operation 终态、409/412、A→B→A、
  分域 incremental/full-load 合并和 latest-load 追随。多轮复审发现并关闭
  committed projection 过早清理、三连刷新误报、双域删除分批确认及
  pending→committed/load 竞态。
- `runtime.mjs` 为 5136 行，SHA
  `a236da9d26cff0aaaa2e47ab39ffac12b1c9212fe12be5b855edd5961587e087`；
  6 条 G6 例外上限同步收紧。模块登记为 `65 / 236 / 16`。
- 固定 web budget 未放宽并通过：deferred runtime
  `23 modules / 819147 B`，默认路由 `2 / 12000 B`，actions workspace
  `1 / 28365 B`，hidden feature 请求为 0；Service Worker 为
  `cike-shell-v0.5.8-5`。
- `npm run check`、actions 专项、PWA、frontend suite `76840 ms` 与
  Journey Smoke `15/15`、`62736 ms` 均通过。最终 reviewer
  GO，blocker/P0/P1=`0/0/0`。
- actions 叶子工作树已清理，当前 `5 / 6`。未执行 push、tag、Release、
  Preview、部署、Base 写入、云资源修改、真实付费调用或生产写入。

下一步：按已完成的只读侦察进入 B3 AI runtime；完整 home 继续随 F4-F8
分域迁移，并在 F10 替换 descriptor。当前仍为
`iteration-G3 / entrypoint-G2`，不代表完整 F2、G5、Release 或 V0.5.9 已开始。

## B3 AI runtime 冻结

- 基线：`c028a0bb7b33c8c9b0258b21dc2ffabad50dde2a`；叶子工作树
  `.worktrees/v0.5.8-b3-ai-runtime` 建立后为 `6 / 6`。
- 新增 `createAiRuntime()`，统一拥有 provider/gate、账户 settings/usage/cost、
  站点 budget、调用审计、DeepSeek generator 和审计恢复。HTTP、媒体处理与
  领域 workflow 继续留在现有模块，只消费显式 runtime 输出。
- Owner 模型设置继承必须通过 late-bound reader 在 auth 初始化后注入，保留
  普通账户继承 Owner provider/profile/scenario/API key 的当前行为。
- 启动顺序固定为 budget recovery 完成后才返回 runtime；损坏预算账本继续
  fail-fast，单条 reservation 恢复失败继续记录并允许启动。
- 调用顺序固定为站点预算预留、账户额度预留、gate、stage start、provider I/O、
  usage/audit、settle；未知费用不得伪造金额，预算拒绝不得触发 provider I/O。
- 保持设置/用量/成本文件名、版本、Prompt、模型、effort、重试、timeout、路由、
  状态码、ETag、Store/schema 与 handler 顺序不变。
- 叶子只改 `src/app/ai-runtime.mjs` 和独立专项；app barrel、`server.mjs`、
  `knowledge/module-boundaries.json`、`package.json` 与系统 runner 由调度者
  在固定叶子提交后串行接线。
- 最低验证：独立 runtime 专项、`npm run check`、`npm run test:ai-budget`、
  AI domain/provider、observability、auth、local-runtime、Volcengine server、
  segmentation 和 backend；真实 provider 调用与远端动作不在本切片授权内。

## B3 AI runtime 检查点

- 本地提交：`280887c`（叶子）与 `855200c`（共享接线）。`createAiRuntime()`
  统一创建 DeepSeek provider/gate、账户 settings/usage/cost、站点 budget、
  调用审计与 generator，并提供 auth 后置的 Owner 设置 reader。
- 工厂等待站点预算恢复完成后才返回；损坏账本 fail-fast，单 reservation
  恢复失败记录后继续。站点预算拒绝不进入账户额度、gate 或 provider I/O；
  未知费用保留 billing gap，不伪造金额。
- `server.mjs` 删除旧装配与审计恢复实现，2295→2120 行，SHA 为
  `beac6a755b4a1712e0fb38c9f7ee3ff46e332dbf2ad7cb7f371fd6427563eb20`；
  DeepSeek provider 违规项已从对应 allowlist 删除，10 条 G4 例外继续精确绑定。
- `npm run check`、AI runtime/budget/domain/provider、observability、auth、
  local-runtime、segmentation 通过；直接系统 Node 的 Volcengine server
  命中已知 macOS Sharp Team ID 限制，完整 backend 使用隔离 Node 后包含该项
  `82/82` 全通过，耗时 `278032 ms`。
- 本批一次实现者自审与一次独立复审均为 GO，
  blocker/P0/P1=`0/0/0`。叶子工作树已清理，当前 `5 / 6`。
- Owner 于 2026-10-06 明确将服务入口只负责启动、`server.mjs <=100` 设为
  必须结果；本项目继续执行更严格的 `<=40` 目标。不得用无边界 barrel、
  动态目录扫描或自动注册替代清晰的组合根和显式 registry。
- 下一步 B4；仍未执行 push、tag、Release、Preview、部署、Base 写入、
  云资源修改、真实付费调用或生产写入。

## B4 媒体 runtime 检查点

- 本地提交：`947c5da`（legacy 图片识别 HTTP adapter）、`00087be`
  （媒体 runtime 与专项）、`6eee683`（共享接线、旧实现删除、登记与 runner）。
- `createMediaRuntime()` 组合账户级附件上传/清理、provider gate、健康/书目
  OCR、ASR 派生与转写、小物媒体、TTS cache/sweep；附件、provider、领域
  normalize 继续复用原有公开模块。后台任务入队与去重仍留给 B5。
- 上传幂等重放/陈旧结果、账户 inventory 隔离、OCR 配置与 fallback、预算
  stage、ASR stale cleanup、sleep/heart-rate normalize 及 sweep 单飞均有
  独立专项；旧入口实现已删除，无双轨。
- `npm run check` 与 B4 冻结影响门通过；完整 backend `83/83`、
  `281838 ms` 通过，包含隔离 Node 下 Volcengine server。直接系统 Node
  的 keepsake media 聚合命令仍命中已知 Sharp Team ID 限制，其所有阶段已由
  backend 隔离 runner 通过。
- 独立 reviewer GO，blocker/P0/P1=`0/0/0`。`server.mjs` 2120→1473 行，
  SHA `3c1202bae77ae2bd4d6668e6744adf683c197261e30c4d5776961f441554de29`；
  拥有路由 237 条、迁移例外 15 条，provider 入口例外已删除。
- 当前进入 B5；未执行 push、tag、Release、Preview、部署、Base 写入、
  云资源修改、真实付费调用或生产写入。

## B5 内容 runtime 检查点

- 本地提交：`cac2496`（content runtime、内部资源/后台/工作流模块与专项）、
  `342571d`（共享接线、旧实现删除、登记、package 与 backend runner）。
- `createContentRuntime()` 统一组合领域 repository adapter、记录服务、批注/
  回收、内容附件、媒体子运行时、后台任务、ASR 入队、thought/capture/journal/
  review/chat 工作流、用户模型提取与个人语境投影；内部按职责拆成三个子模块，
  未把高热点从入口平移到单文件。
- 账户隔离、持久幂等、后台并发/迟到结果、ASR 格式与去重、内容附件回收、
  个人语境 owner 元数据均保持原契约；入口旧实现已删除，无双轨、动态扫描或
  隐式自注册。
- `npm run check`、B5 独立专项及 thoughts、captures/journals、transcription、
  reviews/chat、tasks、personal-context、user-model、content-attachments、
  media 影响门通过；完整 backend `83/83` 通过。新专项已加入后续 backend
  runner，当前清单为 84 阶段。
- 独立 reviewer GO，blocker/P0/P1=`0/0/0`。`server.mjs` 1473→1162 行，
  SHA `8d6c6d0bf4de8d35aaf9c0e463f612dd395a1062046798edccf5cc9cb483f66e`；
  65 个模块、237 条拥有路由和 15 条迁移例外不变。
- 当前进入 B6；未执行 push、tag、Release、Preview、部署、Base 写入、
  云资源修改、真实付费调用或生产写入。

## B6 HTTP 编排检查点

- 本地提交：`5bc5a80`（统计 runtime、admin/Owner/upstream/legacy/registry
  工厂与专项）、`2320d1a`（共享接线、入口旧实现删除、登记与 runner）。
- 平台快照的 loopback/服务令牌边界、代理 body 上限/Cookie/响应头/流式背压、
  Owner 能力、商业化与统计口径、legacy 顺序和 V1 显式注册顺序保持不变；
  入口旧实现已删除，无双轨、动态扫描或隐式自注册。
- `npm run check`、HTTP 编排专项、reviews/chat、auth、frontend-shell 影响门
  及完整 backend `90/90` 通过。独立 reviewer GO，
  blocker/P0/P1=`0/0/0`。
- `server.mjs` 1162→1048 行，SHA
  `19b6eab6f353d6086222a8c4730b6b4bb770f760a2ac008bd636e9e691ab987c`；
  API 字面量例外 25→7，65 个模块、237 条拥有路由、15 条迁移例外不变。
- 当前进入 B7；未执行 push、tag、Release、Preview、部署、Base 写入、
  云资源修改、真实付费调用或生产写入。

## B7 服务端入口收口检查点

- 本地提交：`17fca0d`。`server.mjs` 只保留 `createServerRuntime` 导入、
  runtime 构造和 `start()`，1048→4 行；配置/持久化 foundation、账户访问、
  平台/内容 HTTP adapter、V1/legacy wiring、静态资源与生命周期按职责拆分，
  所有新增生产文件均小于 500 行。
- `createHttpApplication()` 返回 `handle/routeIds`，9 段 handler 顺序保持
  health/readiness → local-test/proxy → admin → auth → owner → v1 → legacy
  → attachment → static；`createServerRuntime()` 公开 `start/ready/stop`。
  未引入动态扫描、隐式自注册、无边界 barrel 或运行时双轨。
- `npm run check`、server runtime/HTTP/auth/local-mode/API v1、容量边界、
  deploy/preview 模拟和隔离 memory soak 通过；完整 `test:system`
  `416224 ms` 全通过，backend runner 为 `91/91`。第一次 memory soak 与
  两个 deploy 模拟并行导致 cold-start 超时，隔离原命令后通过，未放宽阈值。
- 独立 reviewer GO，blocker/P0/P1=`0/0/0`；另行复验真实 JSON 启动、
  `/readyz`、SIGTERM 退出码 0 和 started/stopped 日志通过。
- 真实 PostgreSQL 16 因缺少 `postgres/initdb/pg_ctl` 未运行。当前为
  `iteration-G3 / entrypoint-G4-code`，完整 G4 的 PG stable 证据待环境；
  剩余 6 条迁移例外均属于 browser G6；
  未执行 push、tag、Release、真实 Preview/生产部署、Base 写入、云资源修改、
  真实付费调用或生产写入。

## F3.1 通知页 lifecycle 检查点

- 本地提交：`a45cba7`（notifications presenter/controller 与专项）、
  `dfbcaf5`（runtime、descriptor、legacy、登记、runner、PWA/预算接线）。
- 通知页从 legacy adapter 移除，以显式 literal import 按路由加载；controller
  仅绑定页面 root，拥有 render/load/read/read-all/retry，并在
  mount/unmount/reset 后阻止旧 activation 写 DOM、跳转或提示。
- 初次复审发现直接深链早于 session ready 读取、以及重试成功后离页丢失全局
  refresh/poll 两个 P1。前者改为 ready 后由首个 state render 触发，后者将
  session 有效与页面 activation 分离；专项均补失败反例。PWA 首次未访问 lazy
  私有页不属于离线壳承诺，经两名验证者确认。
- `runtime.mjs` 5136→5130 行，SHA
  `7639dc9a63d4f904ab727c3d0afbf76075ebf37d8cec65cff355d30c8674447f`；
  例外计数 API 70→69、event binding 268→266、template 774→772。
- `npm run check`、F3 专项、PWA、web budget、frontend `21/21`
  `81488 ms`、Journey Smoke `15/15` 通过；通知 lazy closure 为
  `3 / 16954 B`，默认首页隐藏 feature 请求仍为 0，预算未放宽。最终独立
  reviewer GO，blocker/P0/P1=`0/0/0`。
- 当前下一步为 F3.2 批注 lifecycle；未执行 push、tag、Release、Preview、
  部署、Base 写入、云资源修改、真实付费调用或生产写入。

## F3.2 批注 lifecycle 检查点

- 本地提交：`78e5fc1`。新增 `features/annotations` 的 model/view/operations/
  controller 与专项；原 `thought-discovery/annotation-tools.mjs` 已迁移，
  runtime 内批注状态、锚点、面板、草稿和事件监听单轨删除。
- controller 经 shell 生命周期挂载，重复 mount 不叠加监听，reset 清理 timer、
  animation frame 和私有 DOM；请求使用 account/session/activation 票据，
  回复、互转和删除额外绑定发起时 root。评论图片与通知通过窄端口复用。
- 显式动态 import 不阻断应用启动，失败缓存会清除供后续 session 重试；失效
  session 不提示，controller 不可用时 books 状态刷新安全降级。Service Worker
  缓存版本升至 `cike-shell-v0.5.8-7`，无目录扫描、隐式注册或双轨。
- `runtime.mjs` 5130→5002 行，SHA
  `eea3d7a1065273c38583255bdd5564382b6cba145400e9ba647aa07608662787`；
  API 69→68、DOM query 203→171、event binding 269→247、timer 60→54、
  template 772→722，剩余 6 条 browser G6 例外。
- `npm run check`、F3 专项、PWA、web budget、frontend `22/22`
  `76841 ms`、Journey Smoke `15/15` `62771 ms` 通过；runtime 静态闭包
  `21 / 776503 B`、隐藏 feature 请求 0，预算未放宽。首次 frontend 末项
  因测试服务启动超时失败，独立 mobile 与完整原命令复跑均通过。
- 两轮独立复审共发现并关闭 3 个 P1，最终 GO，
  blocker/P0/P1=`0/0/0`。当前下一步为 F3.3 后台结果与跨内容定位；未执行
  push、tag、Release、Preview、部署、Base 写入、云资源修改、真实付费调用
  或生产写入。

## F3.3 后台结果与跨内容定位检查点

- 本地提交：`5ca856d`。新增 `features/background-results` 的 model/
  locator/controller/public entry；旧
  `thought-discovery/background-results.mjs` 与通用 feature barrel 导出已删除，
  runtime 只保留显式 lazy loader 和窄端口装配。
- 结果按 task/result/目标指纹幂等合并；账户 reset 清除 applied/failed/
  in-flight 状态，迟到结果不写新账户。通知定位覆盖 thought/capture 与
  journal/chat/analysis/book/quote 批注，同账户连续目标由 navigation
  generation 隔离。
- 首次复审发现“最后任务完成时 import 失败后停止轮询”和“隐藏模块进入 install
  precache”两个 P1；已改为最多 3 次有界重试，并把 background-results 移入
  `LAZY_MODULE_PATHS` 首次使用缓存。定向复核 GO，
  blocker/P0/P1=`0/0/0`。
- `runtime.mjs` 5002→4997 行，SHA
  `e9fa893d0ce5c128603be37ee25ab303055c812c1b7c7c95397a16267766de90`；
  DOM query 171→166、timer 54→50、template 722→717，API 68、event
  binding 247 不变，仍为 6 条 browser G6 例外。
- `npm run check`、F3 专项、PWA、web budget、完整 frontend `23/23`
  `85017 ms`、Journey Smoke `15/15` `66725 ms` 通过；runtime 静态闭包
  `20 / 761286 B`，首页隐藏 feature 请求 0，预算未放宽。首次完整 frontend
  的 keepsake 异步候选断言失败，冻结差分后原命令复跑全绿。
- F3 已完成并解除 F5 前置；下一步进入 F4。未执行 push、tag、Release、
  Preview、部署、Base 写入、云资源修改、真实付费调用或生产写入。

## F4.1 状态趋势与首页情绪检查点

- 本地提交：`0e1f869`（checkins model/presenter/controller 与专项）、
  `5505d29`（runtime、descriptor、模块登记、runner 和 PWA 接线）。
- 状态指标、同日均值趋势、单次历史和首页 7 日情绪从 home/runtime 单轨迁入
  `features/checkins-model` 与 `features/checkins`。controller 监听当前 route
  root，但明确呈现 `today/review` 两个 surface，保证首页乐观状态即时进入
  隐藏历史；reset 清理当前和已离页账户 DOM。
- 首次 UI 定向门暴露仅更新当前 route root 的兼容回归；首次首屏门依次暴露
  actions 三次读取提前、剩余一次提前读取和动态模块串行延迟。最终改为 mount
  只绘制自有 surface、runtime 窄调用 presentation、默认首页 controller
  静态解析；所有硬阈值保持原值。
- `runtime.mjs` 4997→4962 行，SHA
  `23887c7a4f7a837d41181ae0d8f3abf47d1ab00cc27252564fb8357b33801fb5`；
  event binding 247→246、template 717→696，API 68、DOM query 166、
  timer 50 不变；模块登记 67，仍为 6 条 browser G6 例外。
- `npm run check`、F4.1、records、records-v1、frontend-shared、UI、PWA、
  web budget、Journey Smoke `15/15` `64234 ms` 通过；首屏闭包
  `24 / 771187 B`、隐藏 feature 请求 0、API 最大 9/10、冷/暖 P75
  `699.7/701.4 ms`。两路独立复审最终 blocker/P0/P1=`0/0/0`。
- 下一步进入 F4.2 健康媒体草稿与批量体重；未执行 push、tag、Release、
  Preview、部署、Base 写入、云资源修改、真实付费调用或生产写入。

## 2026-10-06 滚动调度周期 R1

### 现场与候选

- 触发：Owner 要求将“滚动迭代调度器”和“热点入口雷达”融合进现有 SOP，
  同时保护并完成 F4.2。
- 基线：`601e2d9dafda3b2e188c1d096817cec2ff6230a3`。
- F4.2 代码检查点：`c65b7f0`、`4e2d7b8`、`c01ae57`、`2050489`；
  当前代码候选为 `2050489`，运行时 SHA
  `b1e184eb4ca7532e10f0826bd8eeffe673777f6cb4f082bf979139e9bba2dfe2`。
- 工作树：实际注册 `5/6`。根工作区的 `SOP/worktree-lifecycle.md` 是未提交
  提案，目标工作树没有该文件；本轮不复制、不清理根工作区，只把已核对原则
  融入目标树现有 SOP。
- 授权：本地代码、测试、SOP、事实文档和任务提交；不含 push、tag、Release、
  Preview/生产部署、云资源、真实付费调用、Base 或生产写入。

### 本轮事件

| 时间（+08:00） | 事件 | 候选 / 证据 | 决定 |
| --- | --- | --- | --- |
| 14:45:41–14:46:30 | F4.2 四个本地提交形成 | `c65b7f0..2050489` | 固定代码候选，停止共享入口写入 |
| 实际时间未完整记录 | 首轮独立复审 | 2 个 P1：空 owner 冷启、迟到上传租约 | 返回修复环 |
| 实际时间未完整记录 | 定向复审 | 1 个 P1：重入后控件仍禁用 | 返回修复环 |
| 实际时间未完整记录 | 最终复审 | blocker/P0/P1=`0/0/0` | F4.2 review 冻结 |
| 实际时间未完整记录 | PG stable 首次运行 | 预检通过；`sharp` Team ID 导致主集成失败 | 记录环境失败，不改阈值 |
| 实际时间未完整记录 | PG stable 隔离复跑 | ad-hoc 签名 Node；三段退出码 0 | 关闭 G4 PG 子门与 G4 |

缺少 Agent 启动/结束的完整事件时间，因此不生成虚假耗时甘特图；Git 提交时间
只作为里程碑，不解释为开发工时。

### 当前角色名册

| roleId / task | 实际角色 | ownership | evidence | status | next |
| --- | --- | --- | --- | --- | --- |
| `orchestrator` | 主调度/唯一集成写者 | F4.2 共享入口、SOP 和本轮事实文档 | 四个代码提交、分层门禁 | `active` | 文档检查点后进入 F4.3 |
| `f4_2_review_close` | 独立 Reviewer | 只读固定差分 | 3 个 P1 关闭后 `0/0/0` | `closed` | F4.3 重新审查 |
| `g4_pg_stable` | Validator | 只读 PG manifest 与本地临时资源 | 首次环境失败；隔离复跑三段通过 | `closed` | G6 候选漂移时按矩阵复验 |
| `f5_f6_scout` | Scout | 只读媒体/语音边界 | F56-SI/SA、F5-M、F6-M 契约 | `closed` | 等 F4.3 与写槽 |

本轮同时使用的 SubAgent 峰值为 3；五角色仅为预算，不是持续满载目标。只读
角色未创建工作树，5/6 工作树状态保持不变。

### 工作树处置

| 路径 / 分支 | HEAD 与状态 | 处置 |
| --- | --- | --- |
| 根工作区 / `wip/root-dirty-before-v0.4.0-owner-integration` | `4eb5de7`，大量已跟踪与未跟踪治理/UI 现场 | 保留，不修改、不清理 |
| `.worktrees/v0.4.0-g2-capability` | `82ca060`，`public/index.html` 脏 | 保留，归属待原 owner 收口 |
| `.worktrees/v0.5.0-integration` | `505ac90`，恢复脚本与调试现场脏 | 保留，归属待原 owner 收口 |
| `.worktrees/v0.5.8-p00-p0` | `2050489`，仅 SOP/状态文档待提交 | 当前唯一集成写树 |
| `platform-console` / `platform/main` | `d157537`，工作树干净，独立产品线 | 保留，不并入主应用 |

现有两个 stash 均保留：2026-10-01 的未完成产品定义编辑，以及 2026-09-30
的 P3 探索资产。当前没有可在不判断归属的情况下安全删除的工作树。

### 重排后的 DAG 与写集

| taskId | dependsOn | owner | writeSet | gate / acceptance | state | next |
| --- | --- | --- | --- | --- | --- | --- |
| `F4.2` | F4.1 | orchestrator | health feature、runtime、module/SW/runner | check、F4、frontend、PWA、budget、Smoke、review 0/0/0 | `closed` | F4.3 |
| `G4-PG` | B7 固定后端 manifest | validator | 无仓库写入 | PG 16.14 stable 三段通过 | `closed` | G6 漂移复验 |
| `SOP-R1` | 调度定稿 | orchestrator | 两份 SOP、目录与本报告 | 入口/输出/退出门可追溯 | `closed` | F4.3 |
| `F4.3` | F4.2 | orchestrator | health records/submission、runtime、module/SW/runner | check、F4、sync、frontend、PWA、budget、Smoke、review 0/0/0 | `closed` | F5 |
| `F56-SI` | F4.2 | 下一 Developer | `media/content-image-drafts.mjs` 与专项 | 账户隔离、部分上传、rollback、URL 回收 | `ready` | 仅有一个写槽时优先 |
| `F56-SA` | F4.2 | 下一 Developer | `media/page-audio.mjs` 与专项 | 播放排他、迟到 blob、reset、URL 回收 | `ready` | 等写槽或与 SI 非重叠并行 |
| `F5-M` | F56-SI/SA | 待分配 | thoughts media 内部文件与专项 | source version、账户、草稿 key、TTS 反例 | `blocked` | 等共享 API |
| `F6-M` | F56-SI/SA | 待分配 | captures audio 内部文件与专项 | stream/timer/reset、上传回滚、旧 identity | `blocked` | 等共享 API |

`F56-SI` 与 `F56-SA` 可并行准备，F5-M/F6-M 也可在 API 冻结后并行；当前
只剩一个工作树槽，因此最多新增一条叶子写线。runtime、barrel、registry、
runner 和 Service Worker 始终由 orchestrator 按 F5→F6 串行接线。

### 关键等待与 ETA

| 等待项 | 当前影响 | ETA |
| --- | --- | --- |
| F5 写集与反例冻结 | 当前唯一下一代码动作 | 复用既有 F5/F6 侦察，先确认思绪非媒体边界 |
| F56-SI / F56-SA 写槽 | 仅剩 1 个工作树槽，不能同时新建两条写树 | F4.3 检查点后重排，时间 `待测` |
| CDN/OSS/DNS/证书/费用授权 | 阻塞 19 的真实 Preview，不阻塞本地 F4/F5/F6 | 等 Owner 授权，不给工程 ETA |

### F4.2 与门禁证据

- `runtime.mjs` 4962→4663 行；API 68→66、DOM query 166→152、
  event binding 246→232、template 696→670、timer 50；模块 68、路由 237、
  browser G6 例外 6。
- health daily 首次 closure `3 modules / 40953 B`，默认首页隐藏模块请求 0；
  OCR 和提交 adapter 只在用户动作后加载，预算未放宽。
- `npm run check`、`test:f4-features`、PWA、web budget、完整 frontend
  `25/25` `76874 ms`、Journey Smoke `15/15` `65658 ms` 通过。
- PostgreSQL 首次失败与隔离成功均保留；25 文件 manifest 为
  `bf9cf4886b09b90bb349d3c7b2ae9d65d92b1474f69aa19988db0b86faf90116`。
- 当前唯一下一动作：提交 SOP/事实文档检查点，然后冻结 F4.3；不执行任何
  push、tag、Release、Preview、部署、Base、云资源或生产写入。

## 2026-10-06 完整需求原子重排 R2

Owner 明确授权拆分 V0.5.8/V0.5.9，并同步 Base 与本地计划。重排遵循：
`>60%` 只作为准入参考，必须同时满足完整需求、无外部阻塞、约一天可完整验收
且不留下双轨；代码切片和交付记录不能替代需求原子。

### Base 写入与回读

- 创建版本记录 `v0.5.9@reczz28K2FLyWwBC`。
- 需求池从 `rev=410` 更新到 `rev=413`：V0.5.8 精确保留 6 条 P00，
  V0.5.9 精确接收 8 条 P0，`has_more=false`。
- 研发交付从 `rev=118` 更新到 `rev=120`：V0.5.8 保留
  `00–04、11–16、20` 共 12 条；V0.5.9 接收 `05–10、17–19、21`
  共 10 条。
- `11 固定候选`、`12 发布关闭` 各只关联 6 条 P00，验收标准已删除
  CDN/系统协作等迁出内容；`18/19` 保持同属 V0.5.9 媒体分发需求。
- 迁移后的依赖文本、交付项前缀和版本字段已统一为 V0.5.9；登记版本与原始
  计划文本保留审计。

### V0.5.8 冻结范围

| 需求原子 | 状态 |
| --- | --- |
| 移动端首页/思绪路由 | 工作区已验证未部署 |
| 首页快捷语音 | 工作区已验证未部署 |
| 思绪层级与字体 | 工作区已验证未部署 |
| 第三方费用治理 | 工作区已验证未部署 |
| 250ms 同步开屏 | 工作区已验证未部署 |
| server/runtime 纯组装入口 | 服务端 G4 已关闭；浏览器完成 F4.2，继续 G6 |

V0.5.8 不再接收新功能。当前代码路径只允许完成 F4.3-F10/G6、修复保留范围的
blocker/P0/P1、固定候选和发布关闭。图片旋转、私有 CDN、开屏设置与系统协作
全部属于 V0.5.9，不得顺手接入。

### 重排后的收口链

```text
F4.3 -> F5 -> F6 -> F7 -> F8 -> F9 -> F10 -> G6
     -> 11 固定候选/完整门/Preview
     -> Owner 发布授权
     -> 12 发布/观察/G7
```

- F4.3-F10/G6 目标 10-16 小时；候选、完整门与 Preview 目标 3-6 小时；
  生产发布与观察目标 1-2 小时，另需授权。
- 可发布候选墙钟目标为 14-24 小时；生产关闭预计 1-2 天。以上是当前范围
  估算，不以删测试、放宽预算或跳过恢复门维持。
- 下一唯一动作是 F5；V0.5.9 只完成接收计划，不启动开发。

## 2026-10-06 F4.3 日录展示、提交与 sync 检查点 R3

- 代码提交：`5139875`。日录 presenter、编辑/删除、V1 create/update/delete
  和健康草稿 operation 对账已迁入 `features/health`；runtime 只注入
  request/state/sync 端口，旧展示、submit 监听和 health 专属 sync 分支删除。
- `runtime.mjs` 4663→4527 行，SHA
  `342b3979ae298420a923c939204eaf0709f055b4840a5523e226e1d87eae1a76`；
  API 65、DOM query 141、event binding 229、template 614、timer 50，
  6 条 browser G6 例外按当前计数冻结。
- health 静态闭包 `3 modules / 38617 B`；records 仅在 daily 路由加载，
  OCR/submission 仍在操作后加载；首页隐藏 health 请求 0，未放宽预算。
- 新增提交稳定幂等键、pending/conflict、committed 草稿清理、账户迟到和
  operation 订阅回收反例。`check`、F4、sync、PWA、web budget、完整
  frontend `25/25` `83034 ms`、Journey Smoke `15/15` `63884 ms` 通过；
  一次独立复审 blocker/P0/P1=`0/0/0`。
- Base 交付 `04@reczz28JPdCVXtsA` 已最小字段更新并回读，交付表
  `rev=121 / 92`；仍为“进行中 / 未发布”，下一步 F5。未执行 push、tag、
  Release、Preview、部署、云资源修改、真实付费调用或生产写入。

## 2026-10-06 F5 思绪与共享媒体 lifecycle 检查点 R4

- 代码提交：`e603137`（页面音频 coordinator）、`6faa442`（内容图片草稿
  manager）和 `74ac884`（思绪 feature、共享入口接线与旧实现删除）。
- `features/thoughts` 接管思绪列表/详情、搜索/分页、追问/备注、编辑/删除、
  TTS source-version 校验和详情路由恢复；`thoughts/together` 共用同一
  lazy controller，runtime 不再保留 presenter、详情操作或全局思绪监听。
- 内容图片草稿按 owner/generation 与 key 隔离，部分上传只重试失败项，
  确定失败补偿、未知结果持久保留；页面音频统一处理播放排他、迟到 Blob、
  reset 和 object URL 单次回收。
- `runtime.mjs` 4527→4288 行，SHA
  `dc4dc6eb4b847adc35ecdb38563eee411b8478ccefd85c29d95ada3a757ceba5`；
  API 65→63、DOM query 141→118、event binding 229→204、
  template 614→548、timer 50→45；74 个模块、237 条路由、6 条 browser
  G6 例外按更小计数冻结。
- thoughts descriptor 静态引导闭包 `2 modules / 1147 B`，默认首页隐藏
  thoughts 请求 0；延迟 runtime 闭包 `24 modules / 677830 B`，首屏 API
  最大 9。冷/暖 first-readable P75 为 `672.7/668.3 ms`，预算未放宽。
- `npm run check`、F5 专项、sync、URL/history、PWA、web budget、UI、
  mobile、完整 frontend `28/28` `93962 ms`、Journey Smoke `15/15`
  `66361 ms` 通过；一次独立复审 blocker/P0/P1=`0/0/0`。
- Base 最小字段回填未执行：当前环境缺少 `lark-cli`，无法调用已安装
  lark-base skill；交付表继续以已回读的 `rev=121 / 92` 为最后事实，待工具
  恢复后补写 F5 证据，不据此阻塞本地代码检查点。
- F5 已关闭，下一步进入 F6 捕念/音频/转写与日记；未执行 push、tag、
  Release、Preview、部署、云资源修改、真实付费调用或生产写入。

## 2026-10-06 F6 治理检查点 R5

状态：`f6-dirty-governance-checkpoint / not-validated / not-complete`。本节只冻结
治理介入时的现场，不把后续探索性测试当成固定候选证据。

### Dirty Candidate Manifest

- 时间：`2026-10-06T18:22:32+0800`
- HEAD：`9f3747a1c758d79950bba166eb5f22c5ecf06df3`
- 完整临时 index tree：
  `de3b9402cabad3466765593aab4b770406e54056`
- tracked + untracked manifest digest：
  `2ca137e17868b8294e5dc16a8506156fd20715e85ad1a38d2c8849c8ab0ab424`
- 范围：12 个 tracked 修改、7 个 untracked 文件；本报告的治理记录在该
  checkpoint 之后写入，不属于上述 tree。

```text
M  1367ef73d854d6e0043bc1c75c20f1dfe1f2a5d178a73900a7d6816ba70bbe5c  knowledge/module-boundaries.json
M  d02e8fd274ed2255c6b197072e2912c570165cb6cd3beef342bb35e23538dbf6  package.json
M  d72d02159d1c8b21dab83b535fe681b73bb1108814771578af3cedf08590b5dd  public/frontend/app/runtime.mjs
M  495caa4757bdd72ee4653d5681d15d09ec04be84c5d7702d4745a6a9ad79b860  public/frontend/features/background-results/controller.mjs
M  c82b143d17a158a1adf08ea61a0c8ed2df44ed683862a07ea11f4aa8f0355a8a  public/frontend/features/index.mjs
M  498254abfa6cefeedcf44a4929eda4462f57ee619acf80ee7e17015cb42c93aa  public/service-worker.js
M  90f0b232b93b147291a22498e8b2178db5a16712d15f371849e846adbff9c934  scripts/frontend-background-results-feature-regression.mjs
M  288d20c1b2b685e8cf1f5faccb8b39cb3ad42ead8ba41f2ccc5c03740a8948dd  scripts/frontend-lazy-descriptor-regression.mjs
M  604532f32595b0762ed576ff8fe76a48aa28a7471e1ea808023be1304d8d34b3  scripts/frontend-shell-regression.mjs
M  b26b7ce38c7d6d3ca4398d4cc650a5383b53b0aec223b2ef2a6cb826b0aa77e3  scripts/pwa-regression.mjs
M  9797b4835b6c42a491508e78cf7875ea6f98d8a06526c59909f43b5a143ef5b2  scripts/ui-regression.mjs
M  82b659f07a218e6090c77dbcd8b131c9f115e488ad8a7574dad3736e273232db  scripts/web-first-screen-budget-regression.mjs
?? ce6a6422f01233355321ee51c6dcfba94d5195ef683dc6a7af3091ed0462b5bd  public/frontend/features/capture-journal/capture-audio.mjs
?? 788702e5c4429f9b58148ff70f03a5b0090ee0624227b258391044bd4f5766ac  public/frontend/features/capture-journal/captures.mjs
?? 345d1bd1fe62aa84b12e28a5bac0b8c86c1cd65909d83157d251e024b0265a45  public/frontend/features/capture-journal/index.mjs
?? cd7a11a63ee545b3e9373f30f216da5ffc9633e21d01d7a51329350c98c72be0  public/frontend/features/capture-journal/journals.mjs
?? 3bdf69e292f410084fa60cc39dbcbde380959ad4f9b177dfdb9e9f5fe763a27b  public/frontend/features/capture-journal/loader.mjs
?? 844576842628ae14a9508f91506c15a26acbb3b63b90112fc1232378102e4c13  public/frontend/features/capture-journal/presentation.mjs
?? 6041a473f89bbcd66d7ecad7f526e77ab28b5b6840cdd3638ea8e4ff99cdfc18  scripts/frontend-capture-journal-feature-regression.mjs
```

### F6 边界、所有权与依赖

| task / owner | base / readSet | writeSet | 验收 / 回报 | 状态 |
| --- | --- | --- | --- | --- |
| F6 主集成 / `orchestrator` | HEAD `9f3747a`；F6 dirty tree | capture-journal、runtime、registry、module policy、runner、SW、F6 测试、本报告 | 专项→影响门→固定候选→独立 GO；回报本报告 | `active` |
| A 技术债 Reviewer / `4ec0b719-3d0a-4e3b-a135-e258395c85af` | 当前 F6 全差分 | 无 | owner/ports/lifecycle 与热点平移建议；不出最终 GO | `active` |
| B Validator / `f8b2fe87-cf03-4a76-9b6e-5e040683304d` | F6 模块、测试、门禁 | 无 | 冻结 stream/timer/Blob/租约/账户/离页/迟到/草稿/路由矩阵 | `active` |
| C SOP Owner / `bc2e5fa6-643b-449d-84db-b69f215cb08e` | HEAD `9f3747a`、外部规范与既有 SOP | 仅五个授权 SOP/knowledge 文件；独立工作树 | 文档校验、独立 commit、结构化回报 | `active` |
| D F7 Scout / `3d23b081-3bfc-4570-bc2d-216bdd006561` | F7 书籍/善言/回顾闭包 | 无 | 下一批 ready 边界、依赖、写集、专项 | `active` |
| E Evidence/Dispatch Auditor / `351047da-c0c8-49d7-b984-7dc0dc901b4e` | 调度账、Git/工作树、测试事实 | 无 | 名册、资源、DAG、等待原因与下一动作审计 | `active` |

### 资源与写集

- 工作树从 `5/6` 增至 `6/6`；唯一新增写树为
  `.worktrees/v0.5.8-governance-sop` / `chore/f6-governance-sop`。
  达到上限后禁止再创建工作树。
- 当前主树独占 F6 代码、`runtime.mjs`、模块登记、runner、Service Worker
  和本报告；SOP Owner 不得触碰这些文件。A/B/D/E 均只读，不占写树。
- 浏览器与端口只由主树按测试命令临时申请；治理检查点时无持久测试服务器。
  外部云、费用、Base、Preview、发布和生产资源均未授权。

### 必要跨 Feature 差分

- `features/background-results/controller.mjs` 是 F6 必需差分：捕念转写与图片
  理解的后台结果原先直接调用 runtime 的 `renderCaptures`。页面迁为 lazy
  controller 后必须改为发布 `captures` domain，由当前激活 feature 接收；
  否则保留反向 UI 依赖或导致后台结果不刷新。
- `features/index.mjs` 删除 capture overflow page effect 是 F6 必需差分：
  overflow 的 DOM 与 resize 生命周期已归 capture controller；保留会造成
  双 owner 和重复调度。
- `service-worker.js`、PWA/lazy descriptor/web budget、模块登记与 package
  runner 都是新增 lazy feature 的缓存、边界和验收接线；不含产品新功能。

### 风险与重排

- 已识别并进入修复环的 P1：编辑已有捕念后恢复的新建媒体草稿必须重新持久化；
  捕念/日记提交跨路由时必须完成清理且不能复用旧幂等键；预算必须统计真实
  capture/journal 实现闭包，不能只统计二级 loader。
- 当前 `captures.mjs=1226`、`journals.mjs=615`、`capture-audio.mjs=591`。
  行数本身不作为失败门，但 captures 同时拥有 DOM、请求、录音、草稿、提交、
  同步和跨域动作，已满足热点平移触发条件，必须在最终接线前按职责拆分。
- A/B/D/E 均为 ready 且已派发；C 获得唯一剩余写槽。没有其他可派发写任务：
  F6 共享接线必须单写，F7 仅可侦察，V0.5.9 功能被冻结。
- 唯一下一动作：主树先关闭上述 P1 并拆分 capture-journal owner；随后运行
  叶子专项，冻结新的完整 tree/manifest，再执行影响门和最终独立复审。

## 2026-10-06 F6 滚动调度 R6

状态：`candidate-pre-freeze / impact-gate-passed-with-recorded-flake`。

### 事件驱动重排

- A `4ec0b719-3d0a-4e3b-a135-e258395c85af` 返回：当前草稿存在捕念
  DOM、请求、录音、草稿和同步 owner 集中这一 P0 热点平移；最终候选前应拆为
  view、operations 和薄 controller。该结果已执行，不作为最终 GO。
- B `f8b2fe87-cf03-4a76-9b6e-5e040683304d` 返回并冻结 F6 矩阵：录音
  stream/timer/track、Blob URL、并发上传租约、账户代际、离页与迟到响应、
  捕念/日记草稿和路由恢复。专项现已进入标准 `frontend` suite。
- D `3d23b081-3bfc-4570-bc2d-216bdd006561` 返回：F7 按
  `BOOKS -> QUOTES -> REVIEW` 顺序 conditionally ready，依赖 F6 提交。
  当前不派发写任务的具体原因是 F6 尚未形成冻结提交，不能与共享 runtime
  接线并发；不是“仍在规划”。
- E `351047da-c0c8-49d7-b984-7dc0dc901b4e` 返回：治理时 6/6
  worktrees、F6 NO-GO，唯一下一动作是关闭热点和验证缺口。SOP 写树完成后已
  安全移除，现为 5/6；浏览器、端口、云、费用、Base 和发布资源均未占用。
- C `bc2e5fa6-643b-449d-84db-b69f215cb08e` 在独立写树提交
  `739c63a`，主树串行吸收为 `0255229`。变更只覆盖既有五个 SOP/knowledge
  文件，未新增平行制度；其写树已移除。

### Owner 收口

- `captures.mjs` 从 1226 行降至 678 行，仅保留端口校验、编辑器协调、事件
  分派与 mount/unmount/resetSession 生命周期。
- `captures-view.mjs` 独占捕念列表、标签、音频状态和 overflow DOM 投影；
  `captures-operations.mjs` 独占保存、删除、转写、朗读及补偿；
  `capture-drafts.mjs` 独占账户隔离的 session 草稿与旧格式迁移。
- `capture-audio.mjs` 保持独立录音 owner，覆盖 stream、timer、暂停时长、
  本地 Blob、对象 URL、幂等上传租约和迟到上传补偿；未与页面 controller
  合并。`journals.mjs` 保持单页表单/列表/回望生命周期，不承接捕念 owner。
- runtime 的 `captureDraftAdapter` 已删除，仅向 feature 注入
  `sessionStorage` 与账户端口。迁移时发现并修复旧适配器会恢复
  `input[type=file]` 非空值的生产可达缺陷；新快照不保存文件输入，旧快照
  恢复时也跳过文件输入。
- `background-results/controller.mjs` 保留在本批：后台捕念转写和图片理解
  必须发布 `captures` domain，才能解除对 runtime `renderCaptures` 的反向
  UI 依赖。该跨 feature 修改不含范围外功能。

### 验证事实

- F6 专项：通过。新增 fake MediaRecorder stream/timer/track、暂停计时、
  Blob URL 精确释放、并发上传单租约、账户迟到补偿、草稿账户隔离和文件输入
  兼容性验证。
- `npm run check`：通过；78 个 active modules、237 条 owned routes、
  6 个收敛中的入口例外。
- PWA：通过；lazy capture-journal 仍为 cache-on-use，不进入 install
  precache。
- Web budget：通过；捕念路由实现 6 个职责模块、23024B，日记 2 个模块、
  9831B，均低于 40KiB 传输预算。模块数 6 是治理拆分后首次冻结的结构上限，
  未改变既有首屏、lazy descriptor 或 40KiB 预算。
- UI：修复文件输入恢复缺陷后独立通过。完整 frontend 第二轮通过前 28 项，
  最后一项 mobile 在既有思绪详情展开等待上出现一次时序失败；相同代码下
  `mobile-platform-regression` 随后独立通过。该次记录不冒充完整门通过，
  固定候选仍须再跑一次完整 frontend。

唯一下一动作：冻结包含上述代码、测试和本记录的新 candidate tree/manifest，
串行重跑完整 frontend；通过后交最终独立 Reviewer，只接受当前候选引入且
生产路径可达的 blocker/P0/P1。

## 2026-10-06 F6 冻结候选复审 R7

- 首版冻结候选：tree `396c93e8d12dfbb566e2bed8635880febc4d9b4b`，
  manifest SHA-256
  `e528fbf8e386fd555c1a6a0f556750ea1735e80980ee6c294c4d1a06b8549533`。
- 完整 frontend：29/29 通过，耗时 77143ms；`npm run check` 与 F6 专项
  同一候选通过。
- 最终 Reviewer 首轮返回 `0/0/2`。按双人交叉验证，退出时捕念草稿复活项
  为 `0/2` 确认，依据实际 registry cleanup、账户置空和媒体 manager reset
  顺序排除；日记跨路由请求租约项为 `2/2` 确认，保留为 P1。
- 已解除首版冻结并修复该 P1：日记草稿保存与 AI 辅助分别持有跨
  mount/unmount 单飞租约；remount 时保持控件禁用直到旧请求结束；正式提交
  与草稿保存互斥。浏览器反例覆盖离页、返回、重复点击、旧请求释放和后续新
  请求，防止旧 PUT 覆盖新草稿及重复 AI 费用调用。

唯一下一动作：冻结第二版 candidate，重跑专项与 frontend 影响门，并由新的
独立 Reviewer 复审第二版差分；只有 blocker/P0/P1=`0/0/0` 才允许提交 F6。

## 2026-10-06 F6 检查点关闭 R8

- 第二版固定候选：
  - base：`02552299f91aaa34dec9a0a25d12007a60bd19f8`
  - tree：`d7bef1df3f7eb8441274c0f825f905b7b9d568c0`
  - 完整 tree manifest SHA-256：
    `7f2f089795376770a59b0ce63704455c3fc499549965a9c342390466f55cb635`
  - 相对 base：25 个文件
- 同一候选证据：
  - `npm run check`：通过
  - `npm run test:f6-features`：通过
  - background-results 与 commit-gate 专项：通过
  - Web budget：通过；captures 6/23059B，journals 2/9990B
  - `node scripts/system-test.mjs frontend`：29/29，通过，86130ms
- 第二版最终独立 Reviewer：无 findings，
  blocker/P0/P1=`0/0/0`，`GO`。
- F6 已提交：`e4c53ee`（`feat(frontend): extract capture and journal features`）；
  commit tree 与第二版固定候选 tree 完全一致。
- F7 现已满足 F6 依赖；下一批保持 scout 已冻结的
  `BOOKS -> QUOTES -> REVIEW` 顺序。未执行 push、Preview、生产、Base、云资源
  或费用操作。
