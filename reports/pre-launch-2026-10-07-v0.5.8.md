# V0.5.8 发布前记录

日期：2026-10-07

状态：**本地 Release 候选已固定并通过第二轮审计；待 Preview 授权，未发布**

生产基线：
`hotfix-v0.5.7-audio-on-demand@2c395c0295404a6c7bd5a076bb66b11c6e72c3f2`

候选分支：`feat/v0.5.8-p00-p0`

已测试行为候选：
`6bca4295a0317e6274e7d5fed6c292284c7578f9`

候选 tree：`4fd2fbca6256879862e92d3654c20261ca00d176`

完整 tree manifest：946 个文件；
`/tmp/v0.5.8-release-6bca4295a0317e6274e7d5fed6c292284c7578f9.manifest`

manifest SHA-256：
`7076aba155aed3229064529513b84781a14365b8ba7abe35d1f0f23bf2b8b10a`

计划标签：`v0.5.8`

计划 Release 标题：`v0.5.8 - 高优体验与入口收口`

说明：本文件与 TODO、迭代计划、调度记录属于纯文档收口。文档提交形成的最终
授权 SHA 会在提交后另行冻结；只要运行代码、依赖、配置和测试文件的 blob
与 `6bca429` 一致，本地行为证据继续有效。任何上述内容变化都会废止受影响
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
- 工作树为 `5 / 6`，工作区在 Release 门开始和结束时均干净。

原功能候选为
`d28ea5787d63cd385733f0bc09d769f335e1c94f`。发布冻结发现 Web、npm 和
iOS 仍保留 V0.5.7 元数据，因此旧 manifest 被废止；版本元数据以独立提交
`6bca429` 修正后重新冻结并执行 Release 门。依赖集合没有变化，
`package-lock.json` 只同步根版本号。

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

- cold firstReadable P75 为 `748.7 ms`，预算 `1000 ms`；
- warm firstReadable P75 为 `750.0 ms`，预算 `750 ms`；
- 首屏请求、API 请求与 deferred runtime 均在固定预算内。

warm P75 没有余量，Preview 必须重复采样并观察公网尾部；不得放宽阈值或只保留
通过样本。

## 独立审计

- 第一轮审计针对 F10/G6 功能候选，blocker/P0/P1=`0/0/0`，GO。
- 第二轮审计针对生产基线 `2c395c0` 到已测试候选 `6bca429` 的完整差分，
  只接受候选引入、生产可达、稳定复现的 blocker/P0/P1。
- 第二轮未发现符合条件的问题，blocker/P0/P1=`0/0/0`，GO。

## 自动验证

候选开始和结束时均核对：

- HEAD `6bca4295a0317e6274e7d5fed6c292284c7578f9`；
- tree `4fd2fbca6256879862e92d3654c20261ca00d176`；
- manifest SHA-256 `7076aba1...b10a`；
- 工作区干净、5 个 worktree、无残留测试进程。

| 命令 / 子门 | 结果 |
| --- | --- |
| `npm run check` | 通过；G6 3 policies / 108 modules / 237 routes / 0 exceptions |
| `npm run test:backend` | 通过；91 阶段，`332231 ms` |
| `npm run test:frontend` | 通过；36 阶段，`83677 ms` |
| `npm run test:system` | 通过；`429676 ms` |
| `npm run test:postgres:stable` | 通过；PostgreSQL 16.14，主 46 项及 ledger 全通过 |
| `npm run test:pwa` | 通过 |
| `npm run test:web-budget` | 通过；warm P75 `750.0 ms`，cold P75 `748.7 ms` |
| `npm run test:journeys:release` | 通过；`457035 ms` |
| Release 内完整系统 | 通过；`440613 ms` |
| Release 内 PostgreSQL stable | 通过；`15122 ms` |
| Release 内生产依赖审计 | 通过；`1300 ms`，0 vulnerabilities |
| `npm run test:restore` | 通过 |

PostgreSQL 使用项目根目录被 Git 忽略的 16.14 工具链，并用临时 ad-hoc 签名
Node 兼容本机 Sharp 签名约束；测试只创建本地临时集群，不连接生产数据库。

旧候选的一次完整系统运行曾在 warm firstReadable P75 得到
`751.4 ms > 750 ms`，该失败保留；隔离复跑为 `736.6 ms`。版本元数据修正后的
新候选 Release 门一次通过，warm P75 恰为 `750.0 ms`。该结果是 Preview 的
重点风险，不解释为性能余量。

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

取得针对最终授权 SHA 的第一次明确授权后：

1. push 经审阅的候选，并建立 `preview/v0.5.8` 指向同一 SHA。
2. 执行：

   ```bash
   sudo DEPLOY_BRANCH=preview/v0.5.8 for-now-preview-deploy deploy
   ```

3. 核对 `https://77liu.top/preview/readyz` 返回同一 SHA，生产
   `https://77liu.top/now/readyz` 仍为 `2c395c029540`。
4. 执行 20 条 Journey 对应路径、两个 partial 人工项、320/390/1440 px、
   深链、账户切换、离线同步、PWA 更新和重复性能采样。
5. 至少观察 15 分钟 Preview 的 5xx、console error、进程重启、RSS、OOM、
   API 错误和版本漂移。
6. 任何 blocker/P0/P1、恢复失败、持续 5xx、重启、OOM、性能稳定超限或
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
- [ ] Base 回填“待验收 / 待发布”
- [ ] 第一次授权：push 与 Preview
- [ ] Preview 验收及两个 partial 人工项
- [ ] 第二次授权：tag、Gitee Release、生产操作和费用范围
- [ ] 发布前即时备份与隔离恢复
- [ ] 生产部署、冒烟和至少 30 分钟观察
- [ ] G7 关闭、Base/TODO/时间表/Release 摘要/复盘收尾

当前停在第一次明确授权之前。不得自行 push、tag、创建 Release、部署
Preview/生产、调用付费服务或写入生产。
