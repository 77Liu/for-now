# 前端测试目录

返回[系统测试地图](../system-testing.md)。本表只定位已有脚本；选择、证据与限制由测试影响矩阵和实际回执决定。

## 前端测试

| 测试文件 | 主要覆盖 |
| --- | --- |
| `scripts/frontend-contract-regression.mjs` | base path、错误元数据、可选接口、迟到 JSON/图片拒收、SSE 分块/中断/会话失效、并发刷新域合并和账户清空 |
| `scripts/frontend-shared-regression.mjs` | 内容 HTML 安全、Markdown/LaTeX 等价、本地时区跨日，以及图片数量、MIME 和大小边界 |
| `scripts/opening-controller-regression.mjs` | R9.4-F1 参数、慢提示、内容 inert、退出/失败/重试状态机、背景异步、DPR、确定性雨滴物理和页面生命周期清理 |
| `scripts/frontend-shell-regression.mjs` | 根 JS/CSS 薄入口、25 个 HTML 视图与 canonical path 登记一致、页面组切换、按需加载与离开页面清理 |
| `scripts/frontend-feature-lifecycle-regression.mjs` | feature 延迟加载、重复进入、状态合并、AbortSignal、失败重试、清理、账户重置与 stop |
| `scripts/frontend-health-feature-regression.mjs` | 健康媒体草稿的账户/日期隔离、直接 daily 冷启恢复、批次终态恢复、租约清理和重复挂载 |
| `scripts/web-first-screen-budget-regression.mjs` | Fast 4G 下同步开屏 250ms、ready 后 140ms 退出、深链、失败重试、减少动态效果、首屏请求与媒体零预取预算 |
| `scripts/url-history-regression.mjs` | 部署基路径下直接打开、旧路径归一、query replace、详情 push、前进后退、滚动恢复与删除对象安全回退 |
| `scripts/ui-regression.mjs` | 页面主流程、G2 行动/习惯与寻迹渲染、账户切换、输入保留、异步结果、通知跳转、桌面与响应式布局 |
| `scripts/mobile-platform-regression.mjs` | iPhone/Android UA、DPR、触控、横竖屏、动态视口、键盘、安全区和输入缩放 |

`ui-regression.mjs` 默认自行启动临时静态服务器；只有验证指定部署实例时才传入 `APP_URL`。移动模拟基于 Chromium，不等同于真实 iOS WebKit、安装态 PWA、Android 真机或触觉验证。

原生设备的执行窗口、环境和证据要求只引用[真机性能 SOP](../../SOP/ios-device-performance-testing.md)。
