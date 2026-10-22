# 阶段 10：AI 推理可见性边界验收

日期：2026-10-19

基线：`546d2b`

对象：阶段 10 工作树候选；未发布、未部署

## 结论

阶段 10 本地出口通过。用户结果 reasoning 只从领域业务记录投影，内部、未知及历史缺少
分类的记录默认隐藏；私有审计仍保存实际请求、结果和 reasoning。周期复盘具备部署开关
与账户同意双门，推理 UI 默认折叠且在会话失效后拒绝迟到事件。

本阶段没有需要 Owner 决策的阻碍。`AI_REASONING_UI_ENABLED` 保持默认关闭，后续发布放量
仍须按既定发布流程单独批准。

## 重点评审表

|评审项|实现结论|验证结论|限制|
|---|---|---|---|
|分类与权限|scene 登记 trigger、受众、可见性、持久策略、policy 和 owner；未知 fail closed|内部/未知 SSE、结果、错误部分响应均无 reasoning|历史缺少分类不升级展示|
|持久与回看|思绪、追问、对话、日记回望、复盘、批注、图片理解和捕念整理按领域保存|PostgreSQL 16.14 六类结果重载及 RLS 通过；其他领域专项通过|未连接生产数据库|
|私有审计|调用契约、SP、UP、结果、reasoning 同行保存|成功、失败及部分响应 fixture；PG 同行回读通过|未新增真实付费调用|
|周期复盘|部署 gate 与账户 consent 双 true；认领、调用和保存前复验|四组合、关闭、排队任务和设置往返通过|默认关闭，不删除既有结果|
|产品投影|普通 JSON、SSE、同步/状态和详情统一服务端过滤，Owner 不绕过|公开投影、HTTP、OpenAPI 和领域回归通过|审计工具不属于产品入口|
|共享 UI|`features/ui` 默认折叠、安全文本、空内容不渲染；领域决定落点|真实 Chrome 桌面及 390×844；展开、无推理、关闭、切会话和迟到结果通过|Safari、安装 PWA、真机未验|
|上下文与导出|reasoning 不进入 chat history、复盘证据或默认导出|隔离 PG 回读断言通过|未提供显式受控 reasoning 导出|

## 用例结果

|用例|状态|证据摘要|
|---|---|---|
|TC-01/02 流式与无 reasoning|PASS|共享 UI 专项及真实 Chrome；默认折叠，无空控件|
|TC-03 持久回看|PASS|领域记录专项及 PostgreSQL 重载|
|TC-04/05 内部、未知与越权|PASS|generator/公开投影负例；Owner 响应同样过滤|
|TC-06 私有审计|PASS|实际请求、结果、reasoning 与契约同行回读|
|TC-07 上下文/导出|PASS|chat history 与默认 export 均无 reasoning marker|
|TC-08 生命周期|PASS|关闭/切会话后迟到 reasoning 和 answer 不写 DOM，草稿保留|
|TC-09 历史默认|PASS|缺 `reasoningVisibility` 一律隐藏，不按触发或点击猜测|
|TC-10 周期 consent|PASS|部署/账户四组合与 provider 前、保存前复验|
|TC-11 内部入口|PASS|感知/压缩仍无普通产品路由；内部结果不投影 reasoning|
|TC-12 scene owner|PASS|登记表完整；模块边界 132 模块、243 路由无环|
|TC-13 live-only|PASS|临时结果只在当前会话；健康草稿保存时剥离 reasoning|
|TC-14 UI 边界|PASS|共享组件在 `features/ui`；领域 feature 组合，runtime 只接生命周期|
|TC-15 领域限额|PASS|各领域使用既有正文上限；未新增全局 reasoning limit|

## 失败与修复记录

- 修复前内部 `perceptionExtraction` 会转发 reasoning 事件，专项以 exit 1 复现。
- 修复前周期复盘仅受部署配置控制，账户关闭组合仍读取业务历史，专项以 exit 1 复现。
- PostgreSQL 新夹具先后暴露缺少正式命令依赖与不完整合成字段；均为夹具错误，未充当业务
  通过。修正后新建集群完整通过。
- 模块检查首次发现新增测试未登记，第二次发现依赖登记在聚合模块；修正真实 owner 后通过。
- 链接检查发现阶段 9 将本地忽略回执写成仓库链接；改为代码路径后 209 文档通过。

## 验证范围

通过：构建与类型生成、模块边界、API v1/OpenAPI、AI provider、AI runtime、公开投影、
思绪、批注、日记/捕念、对话/复盘、图片附件、转写、书库、健康、设置、协作、真实
PostgreSQL 和真实 Chrome。

未执行：生产写入、生产数据库、真实付费 provider、push/tag/Release/Preview/部署、
Safari、安装 PWA、iOS/Android 真机。未重新采样或处理 94 条真实样本。
