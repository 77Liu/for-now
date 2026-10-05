# V0.5.7 发布前记录

日期：2026-10-05

状态：**G5 远端 Preview 通过，等待标签、Gitee Release 与生产发布授权**

生产基线：`v0.5.6@780d279f3b36431430b421f9c72136cc48e90c75`

候选分支：`feat/v0.5.7-performance`

运行代码候选：`5e806598eac2bb0384a9fc6c966a57e311d82d68`

候选 tree：`e950815a891fd0e1e95f5a3557aa99fe0f6d59ea`

## 发布目标

让已登录用户只为当前页面付出启动、数据和媒体成本，并补齐移动端高频操作：

- 启动不读取完整 `/api/state`，当前路由按有界 DTO 加载；
- 隐藏页面不挂载媒体 DOM，图片和音频只在需要时读取；
- 小物公开投影只提供派生媒体清单，普通展示不回退原图；
- 思绪列表分页/搜索、详情与整链朗读按需加载；
- 念起使用独立录入层，善言支持可创建多标签；
- JSON 支持 gzip，附件支持本地与 OSS byte Range；
- 建立固定网络条件下的启动、导航、同步、媒体和字节硬门。

范围为 7 条 P00、8 条 P0 和选定 P1“费用图纵轴按实际峰值”。V0.5.8
大入口纯组装化只完成计划，不在本版实施。

## 新增能力

### 当前路由启动

- 新增轻量 startup 与 route-state 接口，启动不再下载全账户状态。
- 思绪首批最多 20 条，搜索、筛选、分页和详情使用服务端投影。
- 今日状态、回顾聚类与分析内容均有数量和正文上限。
- 当前路由是唯一渲染入口，离开页面会取消失效请求。

### 媒体边界

- 小物使用版本化媒体清单，派生图未就绪时显示状态占位，不回退原图。
- 历史小物迁移保留 dry-run、计划哈希、竞态检测和回滚资产。
- 音频点击前不传输正文；本地与 OSS 存储支持 `206`、`416`、`If-Range`
  和客户端断开清理。

### 思绪与录入

- 思绪问题、最新用户结论和最新 AI 回答按存在性组成整链 TTS，并按内容版本
  失效缓存。
- 320/390px 下补充、追问、回答保持单行 44px 操作区。
- 念起录入进入独立对话层，保存后回到时间线。
- 善言创建、编辑和正文收藏复用可创建多标签组件。

## Bug 修复

- 备份只校验活动附件引用，不再被幂等回放中的历史附件路径误阻断。
- OSS 流打开返回对象不存在时可回退本地副本。
- 思绪分页游标绑定账户范围，避免跨账户复用。
- 捕念编辑关闭操作串行化，并取消过期异步请求。
- 冷直达嵌套路由改用服务端注入的静态 `<base>`；浏览器不再抢跑请求
  `/thoughts/frontend/**`、`/seen/frontend/**` 等错误资源路径。
- 增量同步长轮询期间收到前台或提交信号时，合并补发一次立即拉取，不再偶发
  等待完整 `1500ms` 轮询窗口。
- 启动元数据与入口静态资源并行；已认证首页复用只读启动提示，并提前发现入口
  模块依赖，公网当前屏反馈不再串行等待启动 API。

## 独立审计

两轮独立审阅覆盖启动投影、媒体、思绪、回顾、同步和 UI。发现的 7 项缺口
全部关闭：

1. 回顾分析首批有界但无法继续分页；
2. 首页小物投影遗漏媒体清单；
3. OSS stream-open 404 未触发本地回退；
4. 思绪游标未绑定账户；
5. 详情性能指标没有执行真实打开；
6. 当前屏反馈未要求目标路由标题；
7. 捕念编辑器连续关闭存在过期异步结果覆盖。

最终复审未留下 Critical/Major 问题。

## 自动验证

最终候选 `5e80659`：

| 命令 / 子门 | 结果 |
| --- | --- |
| `npm run check` | 通过；55 个模块、233 条拥有路由、62 条 Prompt |
| `npm run test:journeys:release` | 通过；`334216 ms` |
| Release：完整隔离系统套件 | 通过；`318303 ms` |
| Release：PostgreSQL 16.14 stable | 通过；`14379 ms` |
| Release：生产依赖审计 | 通过；`1534 ms`，0 漏洞 |
| `npm run test:mobile` | 最终 Release 内通过；另连续独立运行 10 次通过 |
| `npm run test:url-history` | 通过；含冷直达静态资源路径断言 |
| `npm run test:auth` | 通过；含 `/now/` base 注入 |
| `npm run test:pwa` | 通过；27 个缓存模块 |

PostgreSQL stable 覆盖非 owner、`NOSUPERUSER`、`NOBYPASSRLS` 运行角色，
41 个业务对象、23 组业务关系、6 个附件引用、29 个生命周期记录和持久幂等。

## 固定性能门

条件：单一无头浏览器与 profile、1280×800、Fast 4G、40ms 延迟、
10 次 nearest-rank 采样、Service Worker bypass。

| 指标 | P75 | P95 | 预算 |
| --- | ---: | ---: | ---: |
| 冷启动当前屏反馈 | 171.1 ms | 230.7 ms | 500 / 750 ms |
| 冷启动首个可读 | 641.3 ms | 730.0 ms | 1000 / 1500 ms |
| 暖启动当前屏反馈 | 172.7 ms | 176.4 ms | 500 / 750 ms |
| 暖启动首个可读 | 644.4 ms | 655.0 ms | 750 / 1000 ms |
| 路由切换首个可读 | 65.2 ms | 80.4 ms | 350 / 600 ms |
| 思绪详情打开 | 55.9 ms | 70.9 ms | 350 / 600 ms |
| 思绪详情返回 | 64.4 ms | 65.3 ms | 250 / 500 ms |
| 第二设备提交到可读 | 67.2 ms | 92.8 ms | 500 / 1000 ms |

其他合同：

- startup JSON 解码最大 `418 B`；
- 当前路由 JSON 解码最大 `7073 B`；
- 初始 JSON 传输最大 `968 B`；
- 首个可读请求数 `43`，API 请求数不超过 `10`；
- 完整 `/api/state` 请求 `0`；
- 点击前媒体传输 `0 B`；
- JSON gzip、identity 协商与媒体不压缩合同通过。

本地性能与截图目录被 Git 忽略，只保存在本地验收环境。

## 本地 HTTP 验收

隔离条件：

- `AUTH_REQUIRED=0`；
- 临时 `DATA_DIR`；
- 本地附件；
- 不配置外部供应商；
- 不连接生产、不写生产数据。

已验证：

- 首次引导跳过后进入当前页；
- 思绪创建、详情打开和来源返回；
- 念起独立录入层、可创建标签和保存后自动收起；
- 善言创建时同时新增两个标签；
- 详情 URL 冷直达，静态资源全部从应用 base 加载；
- 1440×900、390×844、320×568 无横向溢出；
- 320/390px 思绪主要操作同一行且高度均为 44px；
- 浏览器控制台无运行错误；
- 网络中仅有设计为可选探测的 `/api/local-test-mode` 404，没有页面资源失败。

本地截图：

- `artifacts/v0.5.7/http-desktop-today.png`
- `artifacts/v0.5.7/http-desktop-thought-detail.png`
- `artifacts/v0.5.7/http-desktop-capture-editor.png`
- `artifacts/v0.5.7/http-desktop-quotes-tags.png`
- `artifacts/v0.5.7/http-mobile-thought-detail-390.png`
- `artifacts/v0.5.7/http-mobile-thought-detail-320.png`
- `artifacts/v0.5.7/http-mobile-capture-editor-390.png`

## 远端 Preview 验收

- `preview/v0.5.7` 与 Preview 运行代码均固定为 `5e806598eac2`；生产保持
  `780d279f3b36`，生产服务、代码、环境和数据未改动。
- 公网 `readyz` 返回精确 Preview SHA；`X-Robots-Tag` 为
  `noindex, nofollow, noarchive`；管理快照端点返回 `404`。
- 三轮冷缓存公网验收当前屏反馈为 `320.7 / 410.2 / 302.8 ms`，稳定首页为
  `871.5 / 852.2 / 833.4 ms`，均满足 `<500 / <1000 ms`。
- 三轮均无资源失败、意外 HTTP 响应、控制台错误或运行时异常；320/390px
  无横向溢出。登录态 `verify` 旅程通过，新用户引导保持隐藏。
- Linux 15 分钟共 31 个样本：RSS `82.79–84.52 MiB`，末 10 个样本
  `84.50–84.52 MiB`；服务始终 active、`NRestarts=0`、健康 SHA 一致。
  最终部署后的 356 个 Preview 请求中 Nginx 5xx 为 0，应用 warning/error
  为 0，内核 OOM 为 0。
- Preview 未配置 DeepSeek、火山语音/视觉或阿里云分割凭据，因此真实第三方
  live 测试为 N/A；未借用生产凭据，相关合同与模拟专项已在 Release 门通过。
- 机器证据位于忽略目录 `artifacts/v0.5.7-online-preview-20261005-final-{1,2,3}/`
  与 `artifacts/v0.5.7-online-preview-20261005-linux-rss.log`。

## 未覆盖与后续发布门

当前结论适用于 G5 Preview 候选。以下动作尚未执行：

- push `main`、标签或 Gitee Release；
- 真实 DeepSeek、火山语音/视觉和阿里云分割（Preview 无凭据，N/A）；
- 物理 iPhone、安装态 PWA 与 Android 真机；
- 历史小物生产 dry-run/apply；
- 生产即时备份、恢复、部署和观察。

上述生产动作必须另取明确授权。不得用 Preview 通过替代生产结论。

## G5 前检查表

- [x] 7 条 P00、8 条 P0 和选定 P1 实现
- [x] 独立审计问题关闭
- [x] 最终候选完整 Release 门
- [x] PostgreSQL 16.14 stable
- [x] 固定 Fast 4G 性能门
- [x] 本地 HTTP 桌面与移动端验收
- [x] 冷直达资源路径无错误请求
- [x] Owner 授权 push 与远端 Preview
- [x] 远端 Preview 功能、Linux RSS 与公网多视口验收
- [x] Preview 第三方 live 判定 N/A，未借用生产凭据
- [ ] Owner 授权 tag、Gitee Release、生产迁移与部署
- [ ] 生产即时备份、隔离恢复、部署、冒烟与观察

## 回滚

- Preview 已部署 `5e806598eac2`；当前生产继续运行
  `v0.5.6@780d279f3b36431430b421f9c72136cc48e90c75`。
- 后续 Preview 或生产失败时，使用既有不可变 release、健康检查和原子软链接
  回滚；生产媒体 apply 必须先保留 dry-run 计划与哈希，并单独取得授权。
