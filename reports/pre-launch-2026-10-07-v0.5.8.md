# V0.5.8 发布前记录

日期：2026-10-07

状态：**Git/Gitee 与生产已发布；Owner 接受已知问题，生产观察通过**

生产基线：
`hotfix-v0.5.7-audio-on-demand@2c395c0295404a6c7bd5a076bb66b11c6e72c3f2`

候选分支：`feat/v0.5.8-p00-p0`

已测试行为候选：
`ffc731d83d88026ce12e3b5ae988cc61c1f1d1b1`

候选 tree：`d5392e56cdd1eb21ba7f34578990167eab30dfdb`

完整 tree manifest：947 个文件；
`/tmp/v0.5.8-release-ffc731d83d88026ce12e3b5ae988cc61c1f1d1b1.manifest`

manifest SHA-256：
`28922d3233bbf2fa2043958631427624850cc4c46251735453e80d0305227d6c`

最终发布提交：
`7067ba65eeafccb953080e00988f62728d3b75a8`

最终发布 tree：
`fa9d00a8a1d90444ced242d97365106b80e004cb`

最终发布 manifest SHA-256：
`7bc21cf97421a14884060cc1caaa92bd8d76333f2980134c0800046defdcd9e0`

计划标签：`v0.5.8`

计划 Release 标题：`v0.5.8 - 高优体验与入口收口`

说明：本文件与 TODO、迭代计划、调度记录属于纯文档收口。文档提交形成的最终
授权 SHA 会在提交后另行冻结；只要运行代码、依赖、配置和测试文件的 blob
与 `ffc731d` 一致，本地行为证据继续有效。任何上述内容变化都会废止受影响
证据并返回候选冻结阶段。

## 发布目标与范围

V0.5.8 只交付已冻结的 6 条 P00：

1. 移动端首页和思绪记录入口保持当前路由，不再错误跳回今日页。
2. 首页快捷语音在同一用户手势内复用现有捕念录音、上传和转写链路。
3. 思绪列表与详情只显示各自层级，字体放大时不截断、重叠或横向溢出。
4. DeepSeek、火山语音/视觉、文档解析和阿里分割的费用进入统一、可解释的
   用量口径；未知账单不再静默记零。
5. 冷启动同步显示 R9.4-F1 雨景开屏，首个 paint 不等待运行时模块。
6. `server.mjs` 与 `public/frontend/app/runtime.mjs` 收口为纯组合入口，
   25 个页面由显式 descriptor/controller 单轨承接。

不包含图片旋转、私有 OSS/CDN 分发、账户开屏设置、持续感知、提示词语义
改造或其他 V0.5.9 功能。

## 队列 1 退出与候选冻结

- `server.mjs` 为 4 行纯启动入口。
- `runtime.mjs` 为 53 行纯组合入口。
- 25 个页面均已离开 legacy page adapter。
- G6 为 3 个入口策略、108 个 active modules、237 条 owned routes、
  0 个 active migration exceptions。
- API、DOM、event、timer、template、lines 六类迁移例外全部归零。
- 第一轮独立 Reviewer 对功能候选返回 blocker/P0/P1=`0/0/0`。
- 工作树为 `6 / 6`，工作区在 Release 门开始和结束时均干净。

原功能候选为
`d28ea5787d63cd385733f0bc09d769f335e1c94f`。发布冻结发现 Web、npm 和
iOS 仍保留 V0.5.7 元数据，因此旧 manifest 被废止；版本元数据以独立提交
`6bca429` 修正后重新冻结并执行 Release 门。依赖集合没有变化，
`package-lock.json` 只同步根版本号。

首次授权后的 docs/status 候选
`6a27598f054cec0b476ced898397a7572f8f8754` 曾被推送到
`origin/preview/v0.5.8` 并部署到隔离 Preview。真实注册旅程稳定触发
`TypeError: Cannot read properties of null (reading 'replaceExisting')`，
调用链为 `content-media-runtime.mjs:118`、
`global-events.mjs:141`、`session-runtime.mjs:107`；同时未登录首页提前请求
actions/habits 私有接口。该 P1 触发立即回滚，Preview 与生产均恢复并保持
`2c395c029540`，生产从未切换到 V0.5.8。

修复提交 `ffc731d` 恢复未初始化媒体 manager 的 no-op 语义，并让首页
actions workspace 只在存在当前账户时加载；真实浏览器新增未登录冷启动反例，
Service Worker 缓存键更新为 `cike-shell-v0.5.8-23`。因此 `6a27598` 的
授权和全部旧 Release 证据均已失效，远端 Preview 分支仍指向该失败候选，
不得再次部署。

## 中文发行说明

以下内容是计划同步到 Gitee Release 的完整中文正文；创建 Release 前只允许
按最终 SHA、Preview 证据和已知限制做事实性补充。

### 新功能

#### 首页快捷语音记录

**用户故事：** 作为移动端高频记录者，我希望从首页一次点击就开始录音，并
继续使用已有捕念草稿、上传和转写流程。

- 首页麦克风在同一用户手势内启动既有录音链，不建立第二套录音状态机。
- 权限拒绝、等待授权时关闭、重复点击和上传失败均保留可恢复状态。
- 重试复用稳定请求身份，避免重复上传、重复转写或重复写入。

#### 同步雨景开屏

**用户故事：** 作为冷启动用户，我希望页面在业务模块加载前立即给出明确、
连贯的视觉反馈。

- R9.4-F1 开屏 DOM 与首屏 HTML 同步到达，不等待动态模块、背景图或账户偏好。
- 支持 ready、fail、dispose、减少动态效果、页面离开和账户切换清理。
- 业务 ready 后按硬门退出，不强制播放完整动画，也不改变深链目标路由。

#### 第三方费用完整识别

**用户故事：** 作为使用 AI 和媒体能力的用户，我希望每次供应商调用都能说明
金额、估算状态或账单缺口，而不是把未知费用显示为零。

- 统一覆盖 DeepSeek 文本/视觉、TTS、ASR、OCR、文档解析和阿里图片分割。
- 官方价格快照带版本和来源；无法由公开价确定的项目显示为估算或待账单。
- 请求未发出不计费；供应商已受理后的失败按实际规则结算，同一重试不重复记账。

### Bug 修复

#### 思绪页创建入口跳错页面

**Bug 描述：** 在思绪页创建、取消或提交记录时，部分路径会回到今日页并丢失
列表上下文。

**原因：** 共享创建入口把默认首页路由作为恢复目标。

**解决方案：** 让创建流程携带来源路由，取消和提交后均回到 `/thoughts`
及原列表上下文。

#### 思绪列表与详情层级重复

**Bug 描述：** 思绪详情会重复显示列表摘要，放大字体后容易出现拥挤、截断或
横向溢出。

**原因：** 列表摘要与详情正文使用了重叠的展示层级。

**解决方案：** 列表只保留摘要，详情只保留一套正文层级，并补齐
320/375/390 px 与 200% 字体等效视口断言。

#### 开屏生命周期迟到结果覆盖

**Bug 描述：** secondary 启动失败、watchdog 超时或入口请求过早时，迟到结果
可能重新改变已结束的开屏状态。

**原因：** 首个 paint、业务入口和结束锁存之间缺少完整的代际约束。

**解决方案：** 业务入口延后到真实首个 paint 后，失败与超时进入不可逆锁存，
迟到结果不再复活开屏。

#### 未登录冷启动触发私有首页生命周期

**Bug 描述：** 首次 Preview 的注册旅程在未登录启动时触发表单 reset，
媒体草稿 manager 尚未完成初始化，页面出现运行时异常；首页同时提前请求
actions/habits 私有数据。

**原因：** 入口拆分后，未登录 shell 仍经过已登录首页的媒体 reset 和
actions workspace 加载路径。

**解决方案：** 未初始化媒体 manager 时 reset 保持 no-op；首页 controller
以当前账户作为加载门，未登录状态不导入 workspace、不读取私有 actions/habits。

### 架构调整

- 服务端入口从 3283 行降为 4 行，Store、账户、AI、媒体、内容、HTTP 和服务
  生命周期迁入显式 application/http 模块。
- 浏览器入口从 5291 行降为 53 行，页面状态、事件、timer、模板和领域操作迁入
  feature controller 与 runtime owner。
- 25 个页面全部使用显式 descriptor；legacy adapter 和六类 G6 迁移例外归零。
- 页面 mount/unmount/reset、账户代际、离线同步、路由恢复和 PWA lazy cache
  由机器门持续约束。
- `package.json`、lockfile、Web 展示和 iOS marketing version 统一为
  `0.5.8`；iOS build number 为 `5`。

### 性能优化

此前浏览器大入口集中承担页面实现，隐藏页面容易进入启动闭包。现在页面按真实
descriptor/controller 装配，首页隐藏 feature 请求为 0。固定 Fast 4G 门中：

- cold firstReadable P75 为 `698.3 ms`，预算 `1000 ms`；
- warm firstReadable P75 为 `700.5 ms`，预算 `750 ms`；
- 首屏请求、API 请求与 deferred runtime 均在固定预算内。

旧候选曾在门内触及 `750.0 ms` 阈值，新候选本地样本仍不能替代公网尾部；
Preview 必须重复采样，不得放宽阈值或只保留通过样本。

## 独立审计

- 第一轮审计针对 F10/G6 功能候选，blocker/P0/P1=`0/0/0`，GO。
- 旧候选第二轮审计针对生产基线 `2c395c0` 到 `6bca429`，当时为
  blocker/P0/P1=`0/0/0`；首次真实 Preview 随后推翻该 GO 并触发回滚。
- 替换候选第二轮审计针对生产基线 `2c395c0` 到已测试候选 `ffc731d` 的完整差分，
  只接受候选引入、生产可达、稳定复现的 blocker/P0/P1。
- 完整 Reviewer 未发现符合条件的问题，blocker/P0/P1=`0/0/0`，GO。
- 针对未登录媒体 manager 预初始化的一条审阅意见经两名 Validator 复核为
  `minor` / 误报：该路径只加载静态模块并创建空内存 manager，不读草稿、
  不发私有 API，不进入本次 blocker/P0/P1 报告。

## 自动验证

候选开始和结束时均核对：

- HEAD `ffc731d83d88026ce12e3b5ae988cc61c1f1d1b1`；
- tree `d5392e56cdd1eb21ba7f34578990167eab30dfdb`；
- manifest SHA-256 `28922d32...d6c`；
- 工作区干净、6 个 worktree、无候选测试残留进程。

| 命令 / 子门 | 结果 |
| --- | --- |
| `npm run check` | 通过；G6 3 policies / 108 modules / 237 routes / 0 exceptions |
| `npm run test:backend` | 通过；91 阶段，`360.27 s` |
| `npm run test:frontend` | 通过；36 阶段，`88964 ms` |
| `npm run test:system` | 通过；`461.28 s` |
| `npm run test:postgres:stable` | 通过；PostgreSQL 16.14，主 46 项及 ledger 全通过 |
| `npm run test:pwa` | 通过 |
| `npm run test:web-budget` | 通过；warm P75 `700.5 ms`，cold P75 `698.3 ms` |
| `npm run test:journeys:release` | 通过；`595825 ms` |
| Release 内完整系统 | 通过；`573905 ms` |
| Release 内 PostgreSQL stable | 通过；`16770 ms` |
| Release 内生产依赖审计 | 通过；`5150 ms`，0 vulnerabilities |
| `npm run test:restore` | 通过；`2.31 s` |

PostgreSQL 使用项目根目录被 Git 忽略的 16.14 工具链，并用临时 ad-hoc 签名
Node 兼容本机 Sharp 签名约束；测试只创建本地临时集群，不连接生产数据库。
默认签名 Node 的首次尝试在业务数据库启动后因本机 Sharp Team ID 限制返回
`IMAGE_PROCESSOR_UNAVAILABLE`；临时 ad-hoc Node 下从头重跑通过，该失败属于
已登记环境差异，不涉及候选或依赖变更。

旧候选的一次完整系统运行曾在 warm firstReadable P75 得到
`751.4 ms > 750 ms`，该失败保留；隔离复跑为 `736.6 ms`，之后曾在门内得到
`750.0 ms`。替换候选独立预算门为 `700.5 ms`；公网性能仍是 Preview 的
重点风险，不把本地改善解释为线上余量。

Release Journey 共 20 条，18 条自动化，整体状态 passed。以下 2 条仍为
partial，必须在 Preview 人工补验：

1. `local-online-snapshot`：登录 Preview 后执行冷启测试、使用模拟、完整
   reload、认证失效和附件超时恢复，确认只读线上源且不产生生产写入。
2. `responsive-visual-accessibility`：桌面、390 px、320 px、iOS/安装态
   PWA 的键盘、横竖屏、前后台、字体放大、焦点、44 px 触控目标与截图审阅。

## 配置清单

候选没有新增环境变量、Prompt 版本、部署脚本、Nginx、systemd 或供应商资源。
发布前只核对存在性和状态，不记录任何值。

### Preview

- `NODE_ENV=production`、`PORT=4175`、`APP_BASE_PATH=/preview`。
- 独立 `DATA_DIR`，`PERSISTENCE_BACKEND=json`，
  `ATTACHMENT_STORAGE=local`。
- `AUTH_REQUIRED=1`、`COOKIE_SECURE=1`、`INVITE_CODE_HASH` 已配置。
- `PERIODIC_ANALYSIS_ENABLED=0`、`SPEECH_CACHE_SWEEP_ENABLED=0`。
- 不复制生产数据库 URL、OSS 写权限或供应商密钥；需要的测试凭据必须是
  Preview 专用并经单独授权。
- `APP_VERSION` 由部署器写入最终授权 SHA 前 12 位。

### 生产

- `/etc/for-now.env` 保持 `root:root 0600`。
- `PERSISTENCE_BACKEND=postgres`。
- `DATABASE_URL`、`AUTH_DATABASE_URL`、`AI_BUDGET_DATABASE_URL` 为同库不同
  最小权限角色；`PG_BACKUP_DATABASE_URL` 为只读恢复角色。
- `AUTH_REQUIRED=1`、`COOKIE_SECURE=1`、`INVITE_CODE_HASH` 和
  `PLATFORM_SERVICE_TOKEN_HASH` 已配置。
- `ATTACHMENT_STORAGE=oss`，私有 `OSS_ATTACHMENT_BUCKET`、prefix、endpoint、
  region 与 ECS RAM Role 保持现状。
- DeepSeek、火山语音/视觉、阿里分割和飞书告警只核对既有配置，不新增密钥。
- `INCREMENTAL_SYNC_ENABLED=1`；`PROMPT_CATALOG_VERSION` 保持既有选择。
- `APP_VERSION` 只由部署器更新为最终授权 SHA 前 12 位。

## 数据库与媒体边界

- 本版没有 schema、DDL、数据回填、数据格式升级或生产数据迁移。
- PostgreSQL repository 的变化属于入口解耦和提交回调接线；既有表、角色、
  RLS、连接 URL 和写源不变。
- 本版没有历史附件、OSS 对象、小物派生图、原始录音或媒体引用迁移。
- 不创建 CDN/OSS 新资源，不改变桶策略、公开性、对象前缀或附件读取协议。
- V0.5.9 的图片旋转、私有媒体分发和 CDN 配置不得进入本次发布窗口。
- 代码部署失败时只回滚代码和 `APP_VERSION`；数据不随代码自动回滚。

## Preview 计划

取得针对新的最终授权 SHA 的明确授权后：

1. push 经审阅的候选，并以
   `--force-with-lease=refs/heads/preview/v0.5.8:6a27598f054cec0b476ced898397a7572f8f8754`
   将 `preview/v0.5.8` 从已回滚的失败候选更新到同一新 SHA；不得使用无租约
   force push。
2. 执行：

   ```bash
   sudo DEPLOY_BRANCH=preview/v0.5.8 for-now-preview-deploy deploy
   ```

3. 核对 `https://77liu.top/preview/readyz` 返回同一 SHA，生产
   `https://77liu.top/now/readyz` 仍为 `2c395c029540`。
4. 执行 20 条 Journey 对应路径、两个 partial 人工项、320/390/1440 px、
   注册/未登录冷启动、深链、账户切换、离线同步、PWA 更新和重复性能采样。
5. 至少观察 15 分钟 Preview 的 5xx、console error、进程重启、RSS、OOM、
   API 错误和版本漂移。
6. 通过受支持的账户路径核对并清理首次失败 Preview 可能留下的随机
   `v058preview*` 合成账户；当前没有该账户密码，不直接编辑 JSON 数据。
7. 任何 blocker/P0/P1、恢复失败、持续 5xx、重启、OOM、性能稳定超限或
   SHA 漂移都停止流程并回滚 Preview：

   ```bash
   sudo DEPLOY_BRANCH=preview/v0.5.8 for-now-preview-deploy rollback
   ```

Preview 验收通过后仍不得自动进入生产；必须提交 Preview 证据并取得针对同一
SHA 的第二次明确授权。

## Git、Release 与生产步骤

第二次授权必须明确覆盖 tag、Gitee Release、生产备份/恢复、部署、适用的真实
第三方冒烟和观察：

1. 再次核对 final SHA、tree、manifest、`origin/main`、Preview readyz 和
   工作区。
2. 创建 annotated tag `v0.5.8`，目标必须是最终授权 SHA。
3. 创建同名 Gitee Release，上一发行版为
   `hotfix-v0.5.7-audio-on-demand`，正文使用本文件“中文发行说明”。
4. 只读核对生产服务、Nginx、磁盘、内存、Swap、备份 timer、监控 timer、
   当前 5xx、重启和 `/now/readyz`。
5. 执行即时备份，核对 SHA-256、OSS 上传和隔离恢复：

   ```bash
   sudo /usr/local/sbin/for-now-backup
   sudo /usr/local/sbin/for-now-restore-drill
   ```

6. 因本版无数据库或媒体迁移，不执行任何 migration/apply 命令。
7. 部署同一 SHA：

   ```bash
   sudo DEPLOY_BRANCH=main for-now-deploy
   ```

8. 核对本机 readyz、公网 readyz、登录、今日、思绪创建/详情、首页语音、
   费用统计、设置、账户切换、离线同步、附件读取和 PWA 更新。
9. 真实供应商冒烟只在第二次授权明确包含费用范围时执行；设固定预算并清理
   合成数据，不使用私人内容。
10. 进入至少 30 分钟生产观察；观察结束前不得关闭 G7 或写“已发布”。

## 观察指标与停止条件

每分钟记录：

- `/now/readyz` SHA、systemd active 状态、PID 和 `NRestarts`；
- Nginx 5xx、应用 warning/error、认证和 PostgreSQL 错误；
- RSS、可用内存、Swap、磁盘、内核 OOM；
- 同步 pending/conflict/failed、后台任务积压；
- AI/语音/视觉失败与重试、用量账本未知项和费用；
- 备份时间戳、飞书告警和附件读取失败。

任一 blocker/P0/P1、恢复失败、持续 5xx、非计划重启、OOM、跨账户读取、
不可解释数据变化、费用失控或候选漂移都立即停止并回滚。观察结论只有
“继续运行”时，才允许回填 G7、Base、TODO、版本时间表、Release 摘要和复盘。

## 回滚

代码回滚点：
`hotfix-v0.5.7-audio-on-demand@2c395c0295404a6c7bd5a076bb66b11c6e72c3f2`。

生产部署器会在候选安装或健康检查失败时自动恢复上一 release、配置和
`APP_VERSION`。若上线后人工触发回滚，确认 immutable release 目录存在后执行：

```bash
sudo ln -sfn \
  /opt/for-now/releases/2c395c0295404a6c7bd5a076bb66b11c6e72c3f2 \
  /opt/for-now/.app-rollback
sudo mv -Tf /opt/for-now/.app-rollback /opt/for-now/app
sudo sed -i \
  's/^APP_VERSION=.*/APP_VERSION=2c395c029540/' \
  /etc/for-now.env
sudo systemctl restart for-now.service
curl -fsS http://127.0.0.1:4173/readyz
sudo nginx -t
sudo systemctl reload nginx
```

回滚后必须确认 readyz 为 `2c395c029540`、服务无重启循环、Nginx 持续无 5xx、
PostgreSQL 与附件读取正常。由于本版没有数据迁移，常规代码回滚不恢复数据；
只有确认发生数据损坏时，才停止写入并按发布前即时备份执行独立恢复。

## 当前授权门

- [x] 队列 1 出口：G6、manifest、0/0/0、工作树门
- [x] 三份版本历史文档独立提交并审阅
- [x] 完整本地 Release 门
- [x] PostgreSQL 16.14 stable
- [x] 依赖审计 0 vulnerabilities
- [x] 独立第二轮审计 0/0/0
- [x] 恢复门
- [x] Base 回填并回读最终“已完成 / 已发布”
- [x] 旧候选 `6a27598` 第一次授权、push 与 Preview 部署
- [x] 旧候选真实 Preview P1、立即回滚与生产未变核对
- [x] 替换候选 `ffc731d` 修复、完整 Release 复验与新一轮 0/0/0
- [x] 新授权：更新远端 Preview 分支并部署新的最终 SHA
- [x] Preview SHA/readyz；另保留 15 分 04 秒辅助观察和人工路径证据
- [x] 最终授权：tag、Gitee Release、生产备份/恢复、部署、冒烟和观察
- [x] 发布前即时备份与隔离恢复
- [x] 生产部署、问题发现、短时回滚及 Owner 明确接受问题后的再次上线
- [x] 快捷语音移除竞态登记为 V0.5.9 P00 `reczz28KQX8Q7mhL` /
  `V0.5.9-22`
- [x] 新一轮至少 30 分钟生产观察
- [x] G7 关闭、Base/TODO/时间表/Release 摘要/复盘收尾

## 生产发布、短时回滚与再次上线

- `origin/main`、`origin/preview/v0.5.8` 和 annotated tag `v0.5.8` 均固定
  到 `7067ba65eeafccb953080e00988f62728d3b75a8`；tag peel 已核对。
- Gitee Release ID 为 `1187350`：
  <https://gitee.com/Liu_772021/for-now/releases/tag/v0.5.8>。标题为
  “v0.5.8 - 高优体验与入口收口”，正文保留三项固定栏目并在顶部披露
  已知问题及 V0.5.9 修复项。
- 发布前即时备份为 `for-now-20261007T062155Z.tar.gz`，
  `90,574,969 B`，SHA-256
  `bb5a720fca140ccafa833d433a61244630e5ea907aae610b3d0531fdca5bcb7b`；
  主归档和校验文件已上传 OSS。
- 隔离恢复验证 4 个账户、273 条总记录、91 个附件引用、97 个附件、
  233 条公开 API 记录，附件 HTTP 通过。
- 生产于 2026-10-07 14:23:43 +0800 切换到 `7067ba65eeaf`。本机和公网
  readyz、release 指针、systemd、Nginx 及远端 Git 对象一致。
- 生产冒烟发现快捷语音移除竞态：界面移除录音后，纯文本捕念仍附带并上传
  4 秒音频，触发真实 ASR。任务以 `EMPTY_ASR_TEXT` 失败，用量为
  `costKnown=false`；首次按 P1 停止条件回滚。
- 同一冒烟还确认思绪保存会自动创建回答任务并产生一次 DeepSeek 调用，
  已知费用 `¥0.081525`。后续写入立即停止；不能把本轮写成“未调用真实
  供应商”。
- 生产留下 1 条合成 capture、1 条合成 thought question、1 条模型 answer、
  2 个 AI task 和 2 条 notification。这里只记录对象 ID/状态，不复制正文；
  未在没有新生产写授权时擅自清理。
- 第一次 31 点生产观察在 14:26:30 至 14:40:34 取得 15 个稳定样本：
  SHA/PID 一致、重启/5xx/应用与 PostgreSQL warning/OOM 为 0，RSS
  `99.94-155.57 MiB`。窗口因 P1 回滚中止，没有结束标记，不算通过。
- 14:41:35 首次回滚后，旧发布流程与新 Owner 指令曾发生生产 writer 冲突；
  旧流程在 14:49:22 再次恢复 `2c395c0`。随后 Owner 明确覆盖回滚决定，
  接受该已知问题并要求直接上线 V0.5.8；旧观察进程已终止，生产再次部署
  `7067ba6`。
- 已知问题已登记为 V0.5.9 P00 需求 `reczz28KQX8Q7mhL` 和交付
  `reczz28KQXODFJ1l`（`V0.5.9-22`），验收要求纯文本提交零音频、零上传、
  零 ASR 和零账本项。
- Owner 接受后的生产观察从 14:55:20 到 15:25:35，取得 31 个一分钟样本，
  持续 30 分 15 秒。全部样本为同一 PID `700761`、同一 SHA
  `7067ba65eeaf`、`NRestarts=0`；RSS `103.23-153.28 MiB`，可用内存最低
  约 `662.78 MiB`，Swap 固定 `536,576 B`，磁盘 57%；Nginx 5xx、
  systemd warning、应用 JSON warning/error、PostgreSQL warning、内核 OOM
  均为 0，monitor 持续 success。
- 观察完整写出 31 个样本和 `END` 标记，不使用豁免补足样本。
- Base 回读：需求表 `rev=450`，6 条 V0.5.8 需求均为“已完成/已发布”；
  交付表 `rev=127`，10 条发布相关交付均为“已完成/已发布”；版本表
  `rev=20`，记录开发区间和已知问题转移。

当前生产与 Preview 均应保持 `7067ba65eeaf`。不重复触发已知媒体竞态；
V0.5.9 修复默认使用合成音频和供应商 stub，真实供应商复验需单独费用授权。
