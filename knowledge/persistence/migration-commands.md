# 数据库迁移命令

返回[数据库地图](../postgres-migration.md)。以下是显式迁移流程；生产动作仍要求[当前有效授权](../release-authorization-policy.md)，不能从历史“已批准”推断本次权限。

无论采用哪种承载方式，都必须准备同一 PostgreSQL 16 数据库中的独立 schema
管理、迁移、运行数据、运行认证和只读恢复身份；运行身份必须满足非 owner、
`NOSUPERUSER`、`NOBYPASSRLS`，并只获得下述最小权限。连接串仅写入权限
`0600` 的生产环境文件，不进入 Git、报告或命令输出。完成网络/TLS、备份、
监控和恢复责任确认后，才进入最新 JSON/OSS 冻结与迁移窗口。

只读校验：

```bash
npm run migrate:postgres -- --dry-run --data-dir /path/to/isolated-copy
```

建表与数据导入分开执行，凭据通过受控环境注入：

```bash
# PG_SCHEMA_DATABASE_URL：仅用于建表的管理连接
npm run migrate:postgres -- --init-schema

# DATABASE_URL：已授权的非 owner 迁移角色
npm run migrate:postgres -- --data-dir /path/to/isolated-copy
```

建表后由数据库管理者创建独立登录角色。完整迁移角色需要 `for_now`、`for_now_auth` 两个 schema 的 USAGE 及迁移涉及表的 SELECT/INSERT/UPDATE/DELETE；不授予表所有权或 schema CREATE。运行阶段拆成数据、认证和全站预算三个角色。新增表后重新核对授权。

更新已存在的完整影子批次：

```bash
npm run migrate:postgres -- --data-dir /path/to/isolated-copy --expected-target-sha256 PREVIOUS_BUNDLE_SOURCE_SHA256
```

该参数只控制影子导入覆盖，不代表获准覆盖生产数据库。正式写入切换仍遵循发布流程。

`ATTACHMENT_STORAGE=oss` 必须同时显式传入 `--allow-remote-attachments`；默认不得访问真实供应商。原来的单账户业务 store 检查可用 `--store-only --account-id ACCOUNT`，该模式不包含独立文件与附件实物，不构成 S1 全量证据。
