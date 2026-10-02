# V0.4.0 上线门记录

状态：第一轮上线门已收口；第二轮独立审计发现 4 项 Major 发布阻断；
最终发布许可条件未满足，未取得最终 GO。

## 1. 发布对象

- 生产基线：`v0.3.0 / e3a7da5c7a66d0f1c3d86b565b90832b5ffaa616`。
- 候选分支：`v0.4.0-ai-budget-integration`。
- 上线门进入基线：`main@136ef89b9d6cf2c2f63a176ac2ea885ad4245b6d`。
- 第一轮检查起点：`main@124bf670898d7a237be9f8ecd1da556a5e67fa17`，
  tree `60939da71644fbe37d2dad00a1d227007668c749`。
- 第一轮授权 tree：`756f5c414eeab9421e9ecdf7f3ba8346183128e1`。
- 冻结候选：`d9e7189edc726df72e9d65757c224faaceef66b6`，tree
  `756f5c414eeab9421e9ecdf7f3ba8346183128e1`。
- 本次收口后的纯文档证据提交不属于冻结候选，不得替代上述部署 SHA。
- 本记录不授权 push、tag、Gitee Release、V0.4 部署或真实供应商调用；生产
  写入仅限本节记录的即时备份、预算单例/角色/凭据配置和只读预检。

## 2. Owner 决策

- 允许 V0.4.0 进入第一轮上线门。
- 真机冷启动 `4.437s` 未达到原 `<3s`，提交等待态仍未形成可采信内部指标。
  Owner 接受 V0.4.0 不整改，不得写成性能通过。
- 前端、后端、网页和原生性能整体进入 V0.5.0 `P00`：
  先完成 `<3s / <0.5s`，再把冷启动收紧至 `<1s`。
- 生产媒体迁移 apply 不属于本次默认发布动作；没有单独授权时保持 dry-run。
- 影子账户长期生命周期不作为 V0.4.0 运行时功能发布动作；真机临时账户已销毁。

## 3. 允许进入门的依据

- G2 服务端 capability、Owner 页面隔离和撤权重登已实现。
- canonical URL/history、旧 URL 兼容和删除对象安全回退已实现。
- 全站 AI 日/月预算、全链路预留、未知费用限制、Owner ETag 控制已接入。
- TTS 30 天缓存及后台全量清理已闭合。
- 当前代码系统门、旅程、JSON/PostgreSQL 预算、认证、UI 和 iOS Release
  模拟器构建已有通过证据。
- 真机失败与未验收项已如实记录，并有明确 V0.5.0 P00 去向。

## 4. 上线门阻断项

| 项目 | 当前状态 | 进入门 | 最终 GO |
| --- | --- | --- | --- |
| 真机启动/提交性能 | Owner 接受延期至 V0.5.0 P00 | 不阻断 | 不阻断，但必须保留失败声明 |
| 候选冻结与版本元数据 | 冻结 SHA、`0.4.0`、Prompt、iOS 已对齐 | 通过 | 通过 |
| `npm run test:journeys:release` | 冻结 SHA 上 210.722 秒全绿 | 通过 | 通过 |
| 完整前后端系统门 | 冻结 SHA 上 195.250 秒全绿 | 通过 | 通过 |
| PostgreSQL stable | 16.14、45 项及持久幂等通过 | 通过 | 通过 |
| 生产备份与隔离恢复 | 即时备份、校验、上传、服务恢复通过 | 通过 | 发布窗口仍须核对 |
| 生产配置、凭据与权限存在性 | 预算单例、角色、连接及冻结候选只读预检通过 | 通过 | 通过 |
| 客户端/服务端版本契约 | 生产仍为 V0.3.0 | 允许准备 | 阻断 |
| 第二轮独立审计 | 自动门通过，但 4 项 Major 静态/并发审计问题成立 | 不适用 | 阻断 |
| 最终人工授权 | Owner 同意无问题时直接许可；当前条件未满足 | 不适用 | 阻断 |

## 5. 强制发布顺序

1. 冻结同一候选 SHA，完成第一轮和第二轮审计。
2. 备份并验证恢复；核对生产配置和回滚版本。
3. 先部署 V0.4 后端。
4. 验证 `/readyz`、`/now/today`、`/api/meta`、V0.4 新增 API 和认证。
5. 再发布/验证 V0.4 网页与原生客户端。
6. 执行生产冒烟与不少于 40 分钟观察。

生产仍运行 V0.3.0 时，禁止发布 V0.4 客户端。当前手机登录后的 `Not found`
已确认来自 V0.4 客户端请求 V0.3.0 不存在的新 API，不是密码错误。

## 6. 第一轮验证

### 6.1 本地门禁

- iOS Release 模拟器重新构建成功；同步后工作树无生成资产漂移。
  `cike-0.4.0-ios-simulator.zip` 为 6,412,625 字节，SHA-256
  `c9e9196b3a499237957d3e17e68a0046bf3f5f272ec39ac734f35d4a729311cf`。
- 完整前后端系统矩阵 203,608 ms 全部通过，包含部署回滚、恢复、Owner
  capability、真实浏览器桌面/响应式 UI 和移动平台模拟。
- PostgreSQL 16.14 stable 通过：AI 预算独立角色、45 项全领域/运行时/新库
  恢复检查及持久幂等专项全部通过。
- `npm audit --omit=dev`：生产依赖 149 项，漏洞 0。
- package、lock 根版本、页面版本和 iOS Marketing Version 均为 `0.4.0`；
  Prompt active version 为 `2026.10.02.2`。
- 第一轮修复 tree 上的最终统一 Release 门：
  - runId：`2026-10-02T16-44-50-611Z`；
  - 完整系统：`203608 ms`；
  - PostgreSQL stable：`16191 ms`；
  - 生产依赖审计：`1685 ms`，0 漏洞；
  - 总计：`221484 ms`。
- 旅程矩阵共 15 条，13 条自动化；`local-online-snapshot` 和
  `responsive-visual-accessibility` 保持 partial。前者由本轮生产只读、
  隔离恢复和既有本地模拟证据补验；后者由四视口浏览器回归、移动平台模拟、
  Owner 视觉接受和已如实记录失败的真机性能证据补验，不升级为自动化通过。
- 三个本地提交完成后，冻结
  `d9e7189edc726df72e9d65757c224faaceef66b6` 并从该 SHA 重新运行统一
  Release 门：
  - runId：`2026-10-02T17-01-04-501Z`；
  - 完整系统：`195250 ms`；
  - PostgreSQL stable：`13953 ms`；
  - 生产依赖审计：`1519 ms`，0 漏洞；
  - 总计：`210722 ms`。

首次 `test:journeys:release` 没有被写成通过：

1. 本机 Node 与 Sharp Team ID 不一致，改用已核对的临时 ad-hoc Node 后继续；
   未修改依赖或跳过媒体测试。
2. 北京时间跨过 10 月 3 日后，固定 9 月夹具按真实日期计算近 7 日统计而失败；
   现增加仅测试环境生效的统一单调时钟，并覆盖生产忽略和非法日期拒绝。
3. Release 脚本未找到当前工作树内的 PG 工具；显式使用项目根忽略目录中的
   PostgreSQL 16.14 后进入业务断言。
4. PG 运行时测试仍按旧权限允许普通用户修改 AI 成本，且并发注册假定数组首项
   必然先成为 Owner；现按实际角色选择会话，断言普通用户固定返回
   `403 OWNER_REQUIRED`。

上述修复改变测试、配置和部署门，因此旧统一 Release 结果失效。工作树结果未
被替代写成冻结候选结果；冻结 SHA 已独立从头复验并通过。

### 6.2 生产只读与恢复

2026-10-03 第一轮仅执行配置和运行状态读取：

- `/etc/for-now.env` 为 `root:root 0600`；现有 data/auth/backup 连接、认证、
  OSS、RAM Role、飞书和火山必需键存在，未输出值。
- 主服务、中台、备份 timer 和监控 timer 均 active；备份与监控最近结果均为
  success。
- 活动 release 为 `e3a7da5c7a66d0f1c3d86b565b90832b5ffaa616`，直接回滚
  目标 `6adff978e5febcbbafad53d88cf3d4fa7b9de4e1` 仍存在。
- PostgreSQL 为 16.15；恢复角色 `for_now_backup` 为非 superuser 且
  `NOBYPASSRLS`。
- 最新本地归档 `for-now-20261001T192104Z.tar.gz` 为 62,003,896 字节，
  SHA-256 校验通过；成功标记仍在 26 小时告警阈值内。
- 隔离逻辑恢复演练通过：3 个账户、187 条导出记录、41 个附件引用、45 个
  本地附件；恢复实例 API 核对 185 条，附件 HTTP 读取通过。临时目录和 4273
  端口已清理，生产主服务始终 active。

### 6.3 第一轮收口授权执行结果

Owner 已授权并完成以下范围；这不构成最终发布授权：

1. 第一轮修复已拆为测试确定性、部署预检、发布证据三个本地提交并冻结；未
   push、未 tag、未创建 Gitee Release。
2. 生产即时备份 `for-now-20261002T170456Z.tar.gz` 已生成，64,661,989
   字节；本地 SHA-256 校验和 OSS 归档/校验文件上传成功。备份期间主服务按
   设计停止后恢复，`/readyz` 返回 200。
3. `for_now.site_ai_budget` 单例表和空 JSON 文档已创建，owner 为
   `for_now_owner`；`for_now_budget` 为
   `LOGIN / NOSUPERUSER / NOBYPASSRLS / NOCREATEDB / NOCREATEROLE /
   NOINHERIT`。
4. 精确权限已验真：budget 仅有数据库 CONNECT、`for_now` schema USAGE
   和预算表 SELECT/UPDATE；backup 有 SELECT；migration 有 SELECT/UPDATE；
   data/auth/PUBLIC 对预算表无权，budget 对其他业务表和 auth schema 无权。
5. 首次冻结候选只读预检按设计失败，指出生产数据库已撤销 PUBLIC CONNECT，
   新角色缺少连接权。补充必需的数据库 CONNECT 后第二次通过；未增加任何
   schema/table 权限。
6. 预算凭据已加入 `/etc/for-now-postgres/credentials.json`，连接 URL 已
   加入 `/etc/for-now.env`，两者保持 `root:root 0600`，值未输出。配置前备份
   为 `/etc/for-now.env.before-ai-budget-20261002T170701Z` 和
   `/etc/for-now-postgres/credentials.json.before-ai-budget-20261002T170701Z`。
7. 冻结候选从 `/tmp` 临时解包并以生产三角色运行只读预检通过，临时目录已
   删除。配置后生产仍为 V0.3.0 release
   `e3a7da5c7a66d0f1c3d86b565b90832b5ffaa616`、PID `455544`、
   package `0.3.0`、数据计数 `3/314/59`，主服务 active、`/readyz=200`、
   公网页面 200。未部署代码，未调用真实供应商。

## 7. 第一轮遗漏审计

已重新读取项目规则、工程规则、上线流程、详细清单、系统/旅程测试、发行说明、
架构、可观测性、AI 成本、隐私、容量与 PostgreSQL 文档。

| 严重度 | 问题 | 处理 |
| --- | --- | --- |
| Blocker | 生产缺 AI 预算表、角色与连接 | 已按最小权限配置并由冻结候选只读预检通过 |
| Major | 部署器原先只检查 PostgreSQL 适配器文件，不在切换前验证新预算角色 | 新增只读 `postgres-runtime-preflight` 和回滚专项 |
| Major | 固定日期主回归跨午夜漂移 | 统一测试时钟；非测试环境忽略该配置 |
| Major | PG 用例假定并发注册返回顺序和旧成本权限 | 按响应角色选择 Owner；普通用户固定 403 |
| Environment | macOS Node/Sharp 签名不兼容 | 使用临时 ad-hoc Node；不改候选依赖 |
| Documentation | 原始 V0.4.0 计划只保存在归档分支，未合入当前候选 | 以已提交 Owner 决策、TODO 和本上线门记录作为当前事实；发布关闭时回填归档计划 |

当前未发现已证实的未关闭 critical/major 业务代码问题；第一轮代码审计通过。
第一轮生产配置阻断已解除；隐私草案中对外邀请条件仍未完成，因此本版继续只限
项目内部使用。

## 8. 第二轮独立审计

### 8.1 独立复验

- 从冻结 SHA `d9e7189edc726df72e9d65757c224faaceef66b6` 创建 detached
  干净工作树，tree 仍为 `756f5c414eeab9421e9ecdf7f3ba8346183128e1`。
- 第二轮统一 Release 门全绿：
  - runId：`2026-10-02T17-22-29-347Z`；
  - 完整系统：`199151 ms`；
  - PostgreSQL stable：`16432 ms`；
  - 生产依赖审计：`1567 ms`，0 漏洞；
  - 总计：`217150 ms`。
- 自动门的 onboarding 前端测试只覆盖纯转换和显式 409 合并；PWA 测试只
  检查固定资产名；转写与预算测试未覆盖相同输入的并发强制任务；恢复测试夹具
  没有 `ai-budget.json`。因此全绿结果不能排除以下问题。
- 两名独立验证器逐项复核全部候选问题：4 项 Major 和 1 项 Minor 均为
  `2/2` 一致确认。

### 8.2 发布阻断

| 严重度 | 问题 | 证据与影响 |
| --- | --- | --- |
| Major | 离线五问草稿可静默覆盖其他设备更新 | `pendingSync` 遇更高远端 revision 时先采用新 revision，再以 `full: true` 提交旧草稿，绕过已有逐项冲突选择 |
| Major | PWA 离线壳缺少新增模块依赖 | 预缓存缺 `frontend/content/error-presentation.mjs` 和 `frontend/features/onboarding-v2/index.mjs`；静态资源为 `no-store`，断网重启会中断 ES module 图 |
| Major | 并发强制转写共享预算 reservation | 最小复现产生 2 次供应商调用，但只有 1 次预算结算；一项成功，另一项以 `AI_BUDGET_RESERVATION_NOT_FOUND` 失败，可漏记未知费用调用 |
| Major | 实际恢复演练不校验全站预算 | PostgreSQL 导出已写 `ai-budget.json` 和哈希，但恢复验证不要求文件/清单存在；预算缺失时 JSON 仓储回退空文档仍可就绪 |
| Minor | iOS 启动分段附件不会生成 | 开关在模块加载时只读 URL，原生稍后设置 dataset 无效；XCTest 缺指标时静默返回。Owner 已明确延期性能验收，记入 V0.5.0 P00，不单独阻断本版 |

冻结候选未修改，上述 Major 均未修复。第二轮审计不通过，不得 push、tag、
创建 Gitee Release、部署 V0.4 后端或发布 V0.4 网页/原生客户端。

## 9. 当前结论

`FIRST ROUND CLOSED`：候选冻结复验、即时备份、生产预算配置和只读预检已
完成。

`SECOND ROUND FAILED / NO FINAL GO`：4 项 Major 发布阻断尚未修复和从新冻结
SHA 复验，因此不许可发布。真机冷启动 `4.437s` 继续明确为未通过，不得因
自动门全绿改写为性能通过。
