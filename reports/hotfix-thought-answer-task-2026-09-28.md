# v0.1.1 思绪自动回答热修

## 问题

- 严重度：严重。
- 用户症状：在浏览器“收集”页保存未填写回答的思绪时，接口返回 `createThoughtAnswerTask is not defined`，思绪与后台回答任务均未提交。
- 生产证据：2026-09-28 20:16:31 与 20:16:44（Asia/Shanghai），`POST /api/thought-chains` 连续返回 HTTP 500、`ReferenceError`，运行版本为 `4a8146088f90`。

## 根因与修复

持久 AI 任务已统一迁移到 `createAiTask`，但“创建完整思绪并自动生成回答”的分支仍调用已删除的旧函数 `createThoughtAnswerTask`。

本次只将该调用替换为：

```js
createAiTask(store, {
  kind: "thoughtAnswer",
  targetId: question.id,
  inputVersion: question.version,
  clientRequestId
})
```

未改变 HTTP 请求/响应结构、Prompt、数据结构、计费、权限或其他任务类型。

## 用户侧变化

- 收集页在回答为空时可正常保存问题和初步想法。
- 同一原子提交会创建后台思绪回答任务并返回 `201`。
- 同一 `clientRequestId` 重复提交返回原任务，不重复调用模型。

## 数据与配置

- 无数据迁移。
- 无环境变量或服务器配置变化。
- 不修改已有记录；此前失败请求的操作日志显示 `changeCount=0`，需用户重新提交。

## 验证

- 修复前本地复现：HTTP 500，`createThoughtAnswerTask is not defined`。
- 修复后同路径：HTTP 201，返回 `thoughtAnswer` 任务。
- 新增回归：后台任务最终成功、重复提交复用任务、模型只调用一次、只落一份回答。
- `npm ci`：130 个包，0 个已知漏洞。
- `npm run test:system`：后端与前端 18 个阶段全部通过，总用时 `102091 ms`。
- 按功能开发阶段规则未执行 `npm run test:load`，未调用真实 DeepSeek、阿里云分割或 OSS。

## 限制与回滚

- 本次仅修复收集页自动回答任务创建，不包含 v0.2.0 数据库、模块化或新功能改动。
- 回滚目标为生产当前提交 `4a8146088f90`。
- 代码回滚不需要数据回滚；部署前仍执行一致性备份。

## 发布记录

- 候选分支：`hotfix/thought-answer-task-20260928`
- 版本：`v0.1.1`
- 标签：`hotfix-v0.1.1-thought-answer`
- 生产运行提交与公网冒烟以部署后的 `/readyz` 和服务器日志实测为准。
