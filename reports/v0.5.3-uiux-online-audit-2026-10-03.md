# V0.5.3 线上 UI/UX 走查与热修

日期：2026-10-03

状态：**已发布 Preview 与生产**

## 发现与修复

- 未登录首次打开时，`/api/auth/me` 的正常 `401 AUTH_REQUIRED` 被启动快照误判为
  “启动请求失败”。启动请求现显式接受未登录响应，登录页不再显示红色误报。
- 登录与注册页签、输入框、主按钮统一为至少 44px 高；输入字号调整为 16px，
  避免 iOS Safari 聚焦输入时自动放大。
- 登录/注册页签补齐 `aria-controls`、tabpanel 关系、单一 Tab 停点，以及
  左右方向键、Home、End 键切换。
- Service Worker 补齐通知模块的预缓存闭包，避免离线启动后相关模块缺失。

## 真实用户走查

- 在线入口：`https://77liu.top/preview/` 与 `https://77liu.top/now/`。
- 视口：桌面 1440x900、移动 390x844、窄屏 320x700。
- 隔离 Preview 账户覆盖注册、五问略过、首页、念起创建、思绪、我的。
- 320px 与 390px 均无横向溢出；核心操作、底部导航和状态反馈可达。
- 修复后公网 Preview 当前屏反馈 252.1ms，稳定首页 684.2ms。
- Preview 网络失败、异常响应、控制台错误和运行时异常均为 0。

## 验证与发布

- `npm run check`、`npm run test:auth`、`npm run test:ui` 通过。
- `npm run test:system` 全量通过，耗时 304878ms。
- `npm audit --omit=dev --audit-level=high`：0 个漏洞。
- 候选提交：`99a511306a20137fd7185850f595cf202400b1a9`。
- Preview 与生产均运行该提交，服务 active，`NRestarts=0`。
- Gitee 标签与 Release：`v0.5.3`，Release ID `1181565`。
- Preview 临时账户、记录和邀请配置已销毁，原数据与配置已恢复。
