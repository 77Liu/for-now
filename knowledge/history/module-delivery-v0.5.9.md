# 历史模块交付说明（v0.5.9）

只读历史摘录：2026-10-17 迁出；不代表当前配置、验收或生产状态。当前规则见[模块设计](../modularization-design.md)。

### V0.5.9 私有媒体分发边界

`shared.attachments` 的 delivery 策略仅复制服务端生成的 thumb/display WebP 与 TTS MP3 到独立私有分发桶；原件、Alpha、编辑源与原始录音继续代理。app/media/attachments 拥有当前账户与有效业务引用校验，发送前后拒绝删除/失效 TTS；HTTP 保留认证、HEAD、Range/416 和 If-Range 代理语义。新生产模块仍归既有附件模块，不新建服务。默认 proxy，短签名固定 60 秒；真实 CDN 鉴权缓存、CORS 和过期由 19 真实 Preview 验收，不以 SDK 桩关闭。


- V0.5.9-21：`shared.opening` 拥有冻结配置与 revision/ETag；account settings 文档只经专用 Owner 路由更新开场字段，AI 设置合并保留该字段。已登录 startup/meta 仅向 Owner 附带偏好，读取失败使用冻结默认；未登录和普通账户无开场偏好请求。开场控制器负责异步雨景代际与及时释放；设置 feature 拥有按账户的草稿、409 显式重载和迟到请求防护。
