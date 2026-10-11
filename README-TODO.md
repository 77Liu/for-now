# 状态来源地图

本文件只路由状态，不维护第二份版本、需求或待办清单。

| 事实 | 唯一维护位置 | 维护责任 |
| --- | --- | --- |
| 需求原文、需求验收、版本与交付关联 | 飞书需求池及对应版本/交付记录；离线快照见 reports/evidence/feishu-requirements-current/ | 需求管理；离线数据标明采集时间与范围 |
| 未冻结候选与推荐排期 | [requirement-roadmap-current.json](reports/requirement-roadmap-current.json) | 需求管理；候选不等于冻结或发布 |
| 收集批次、差分、分页覆盖和回写证据 | [requirement-delta-current.json](reports/requirement-delta-current.json) | 需求管理；完整扫描与定向更新分别保留来源 |
| 冻结范围、实现验收、延期项 | 当前版本实施计划，路径从下项获取 | 主开发协调者 |
| 活跃任务、负责人、基线、工作位置与证据入口 | [requirement-coordination-current.json](reports/requirement-coordination-current.json) | 唯一协调者；monitor 只唤醒或转交，不另养开发队列 |
| 实际生产发布、回滚与观察 | 协调记录指向的原始发布/观察报告 | 发布执行者；报告是当时事实，实际运行版本需现场核对 |
| 历史演进 | knowledge/iteration-history.md 与日期化 reports | 只追加重要事实，不继续维护“当前版本” |

JSON 是上述本地结构化事实的维护文件；同名 Markdown 仅作入口，不手工抄写状态。旧快照和已完成批次保持历史身份，不能由脚本重放覆盖新状态。
