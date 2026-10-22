# Cloud deployment

本页是生产部署地图。发布顺序与授权仅见[发布 SOP](../SOP/release-and-observation.md)及[授权策略](../knowledge/release-authorization-policy.md)：**部署受审候选 → 观察 → 正式晋级 main → 回流 develop**。不得为部署候选提前推进 main；本文命令不是执行授权或成功回执。

代码从 Gitee 获取，运行数据独立保存于 `/srv/for-now/data`；禁止双向同步活动数据目录。实际生产版本、数据库版本、角色核验和运行结果只读[当前控制面](../coordination/current.json)。

PostgreSQL 部署须核对数据、认证、预算和恢复角色及环境配置；代码回滚不替代数据恢复，具体见[持久化地图](../knowledge/postgres-migration.md)。早期切库证据见[历史回执](../docs/versions/v0.2.1/evidence/production-cutover.json)，不代表新候选已验收。

## Access model

域名、Nginx、平台入口及访问边界见[生产接入](docs/production-setup.md#access-model)。

## Initial server setup

工具依赖、首次准备、环境与证书配置见[首次配置](docs/production-setup.md#initial-server-setup)。

## Read-only platform console

独立平台及应用端聚合接口见[平台接入](docs/production-setup.md#read-only-platform-console)。

## Historical keepsake media migration

历史小物迁移的计划、停写和精确应用见[媒体迁移](docs/data-and-recovery.md#historical-keepsake-media-migration)。

## Private attachment migration

私有 OSS 与本地回退材料见[附件迁移](docs/data-and-recovery.md#private-attachment-migration)。

## Monitoring and restore

告警验证、备份与恢复见[监控与恢复](docs/data-and-recovery.md#monitoring-and-restore)。

## Deploy updates

候选分支、精确 SHA、独立 guard、媒体配置、部署与回退步骤见[生产发布执行](docs/production-release.md)。

Preview 的安装与隔离见[Preview 地图](README-preview.md)。
