# iOS 真机性能测试（初步 SOP）

状态：初步 SOP，可随任何有效证据、工具改进或验收口径变化持续更新。

本 SOP 用于 iOS 真机候选的启动与提交等待态验收。每次更新必须保留变更原因、
验证结果和候选提交；不得把测试框架开销、首次登录或环境故障误报为产品性能。

## 1. 指标口径

| 指标 | 当前门槛 | 后续门槛 | 起点 | 终点 |
| --- | ---: | ---: | --- | --- |
| 已登录冷启动 | `<3s` | `<1s` | 冷进程 `XCUIApplication.launch()` 前 | 今日页“记录思考”可点击且布局稳定 |
| 提交进入等待态 | `<0.5s` | `<0.2s` | 捕念 submit handler 入口 | 按钮禁用并写入统一等待状态 |

首次安装、开发者信任、本地网络授权、登录和首次引导单独记录，不并入“已登录
冷启动”。XCTest 手势合成、无障碍快照和诊断收集单独记录，不并入产品内部提交
等待耗时。

## 2. 硬边界

- 默认仅在北京时间 `01:00-08:00` 执行；窗口外必须有 Owner 当次明确授权。
- 只允许非生产 HTTPS，或显式启用的 RFC1918 局域网 HTTP。
- 禁止使用生产账户、生产写入和真实供应商；使用空数据一次性影子账户。
- 测试凭证写入 `0600` 临时文件或临时 `.xctestrun`，结束后立即删除。
- 自定义报告不记录 UDID、序列号或证书标识；原始 `.xcresult` 仅作为本机受限证据。
- 候选工作树必须干净，记录候选 SHA、设备型号、iOS、Xcode 和构建配置。

## 3. 预检

1. 用数据线连接设备，解锁并保持常亮。
2. 确认 Xcode 显示 `usb`、`available`，并已启用开发者模式。
3. 在“VPN 与设备管理”信任当前开发者 App。
4. 局域网模式下，在“隐私与安全性 → 本地网络”允许“此刻”。
5. 确认隔离服务健康检查、空数据影子账户和 onboarding `skipped`。
6. 确认 App 与服务端来自同一候选契约；版本不一致不得继续性能判定。

企业网络阻断 `localhost.run`、`serveo.net` 等隧道时，使用 Mac 局域网地址和临时
反向代理。不得改用生产域名绕过限制。

## 4. 构建与运行

使用 Release、Team `Y4C56M94J3`、Automatic Signing 和专用编译条件
`CIKE_PERFORMANCE_TESTING`。先执行 `build-for-testing` 生成 `.xctestrun`，
再把一次性环境写入临时副本并执行 `test-without-building`。

标准入口：

```bash
scripts/ios-device-performance.sh plan
scripts/ios-device-performance.sh build
scripts/ios-device-performance.sh test
```

需要局域网时设置：

```bash
export CIKE_IOS_PERF_LAN_HTTP=1
export CIKE_IOS_PERF_TEST_URL=http://<RFC1918-IP>:<PORT>/now/
```

## 5. 启动分段

每次启动至少记录：

1. `process_to_scene`：进程加载到 Scene 连接。
2. `scene_to_web_navigation`：窗口显示到 WKWebView 开始导航。
3. `web_navigation_to_module`：HTML 导航到前端模块执行。
4. `auth_session`：`/api/auth/me`。
5. `core_snapshot`：`/api/state` + `/api/meta`。
6. `secondary_bootstrap`：设置、onboarding、行动/习惯等首屏依赖。
7. `render_to_stable`：数据齐备到今日页可点击且布局稳定。
8. `xctest_overhead`：总耗时减去应用内分段耗时。

API 服务端耗时须从请求日志核对，不能用客户端总等待倒推。

## 6. 证据与结论

结果只能是：

- `通过`：指标、环境、分段证据和 `.xcresult` 均完整。
- `不通过`：形成有效指标且超过门槛。
- `未验收`：环境、权限、版本、缓存或测量方法使指标不可采信。

每轮保留：

- 候选 SHA、设备型号/iOS、Xcode、Release 构建结果。
- 指标 JSON、分段 JSON、服务端对应请求耗时。
- `.xcresult`、退出码和失败原因。
- 临时账户、凭证、服务和代理的销毁确认。

## 7. 当前基线

- iPhone 13 Pro Max / iOS 18.7.8。
- 已登录冷进程启动：`4.437s`，结论 `不通过`。
- 首次预检包含安装、权限、登录等步骤，耗时明显超过 4 秒，不属于冷启动指标。
- 对应服务端请求为 `0–4ms`，首要优化对象是原生启动、WKWebView、前端模块和
  首屏水合，不是数据库或 API 处理。
- 提交外部观测 `1.331s` 包含 XCTest 开销，不可作为产品指标；应用内毫秒值未
  稳定闭合，结论 `未验收`。

## 8. 优化顺序

1. 先完成启动分段埋点，任何优化必须说明减少了哪一段。
2. 首屏只保留认证、meta、最小 state；onboarding schema、行动/习惯、同步恢复
   延后到首屏可交互之后。
3. 缩小首屏 JS/CSS，按页面拆分非今日页模块，减少 WKWebView 解析与执行。
4. 将无关草稿恢复、媒体存储打开和后台轮询移到首帧之后。
5. 复用认证会话，避免已登录冷启动再次经历登录或首次引导。
6. 达到 `<3s` 后，把各段预算收紧至总计 `<1s`，并以 P95 而非单次最好值验收。

## 9. 常见故障

| 现象 | 判定 | 处理 |
| --- | --- | --- |
| Runner code 74 / DTX 断开 | XCTest 通道，不是性能失败 | 改用 USB、解锁、信任 |
| Developer App 不受信任 | 签名信任 | VPN 与设备管理中信任 |
| 真机无请求到 Mac | 本地网络/ATS | 开启本地网络，核对 RFC1918 地址 |
| 域名被飞连禁止 | 企业网络策略 | 使用局域网，不绕到生产 |
| 登录后 `Not found` | 常见为客户端/服务端版本错配 | 对齐同一版本后复验 |
| 页面恢复到上次路由 | 状态恢复影响测试 | 测试前显式切回“今日” |
| 新代码未生效 | Service Worker 缓存 | 换隔离 origin 或清理 App 容器 |

