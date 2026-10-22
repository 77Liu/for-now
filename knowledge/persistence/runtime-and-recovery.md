# 数据库运行与恢复协议

返回[数据库地图](../postgres-migration.md)。本页区分运行约束、旧兼容实现与专用恢复；不把既有账户仓储的访问方式固化为新业务要求。

## PostgreSQL 运行与恢复

`PERSISTENCE_BACKEND=json|postgres` 默认 `json`。PostgreSQL 模式需要 `DATABASE_URL`（数据角色）、`AUTH_DATABASE_URL`（认证角色）及 `AI_BUDGET_DATABASE_URL`（预算角色）。三者必须同库、角色互异、非 owner / NOSUPERUSER / NOBYPASSRLS。数据和认证角色不得直接 SELECT/UPDATE 全站预算表；预算角色不得访问任何租户表或认证 schema。运行模式拒绝 `LOCAL_TEST_MODE` 与上游代理，禁止经 JSON 文件读写业务、认证或配置；日志与附件二进制仍可使用本地文件。

由建表管理员授予数据角色 `for_now` 的 USAGE 和租户运行表 SELECT/INSERT/UPDATE/DELETE，并收回预算表的全部权限。全站预算单例只向独立预算角色授予 SELECT/UPDATE，不授予 INSERT/DELETE/TRUNCATE/REFERENCES/TRIGGER、授权转授权或其他表权限；运行启动会拒绝缺权、越权或角色复用：

```sql
GRANT USAGE ON SCHEMA for_now TO for_now_data;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA for_now TO for_now_data;
REVOKE ALL ON TABLE for_now.site_ai_budget FROM for_now_data;

GRANT USAGE ON SCHEMA for_now TO for_now_budget;
GRANT SELECT, UPDATE ON TABLE for_now.site_ai_budget TO for_now_budget;
```

认证角色仅获 `for_now_auth` 的 USAGE 和认证表读写，并单独授予 `EXECUTE ON FUNCTION for_now_auth.provision_account(text,jsonb,jsonb)`；不得获得 `for_now` 或预算表权限。该 SECURITY DEFINER 函数固定 search_path、默认拒绝 PUBLIC，只能为已经插入身份表的新账户初始化映射，不能读取或替换既有账户。注册的身份、会话、业务初值和独立文档在同一认证事务提交；失败整体回滚。

运行语义：

- `postgres-runtime.mjs` 提供 `read/update/transact`，使用正式关系行重建业务对象，不读取或更新迁移快照。旧兼容适配器仍存在整账户映射替换；这是待迁移债务，不是新命令模板。目标与迁移范围按[设计契约](../design-contracts.md)执行，不凭关系存储宣称已实现精准访问。
- 全站 AI 预算不绑定 `app.account_id`，独立预算连接使用 `site_ai_budget` 唯一行的 `SELECT ... FOR UPDATE` 事务串行所有账户的预留、结算和恢复命令；mutator 或 UPDATE 失败均整体回滚。普通数据/认证连接无法直接读取或改写该表。
- 旧兼容账户仓储使用数据库 advisory lock；锁跨显式 `commit()` 保留。每个 commit 是真实持久点，后续失败不回滚已完成的附件清理意图。账户 revision 以 compare-and-swap 拦截锁外冲突，读取使用 REPEATABLE READ 一致快照，事务内 `SET LOCAL` 绑定 RLS。
- 旧兼容配置/用量路径在账户锁内完成；归一化保留迁移扩展，若会丢弃数组记录则拒绝。数据角色不能读取认证 schema，认证角色不能直接读租户内容。
- 上传先登记 `uploading` 与预期大小/哈希，再写二进制并验真为 `verified`；中断上传在启动时核对实物，保留有效文件或清除未写入的预留。业务不能引用其他账户或未验证的附件。永久清理在首个 commit 持久化任务，再删除文件并提交结果；失败可重试。
- 当前调度、供应商全局额度和流式去重仍按单进程设计；每个数据库只允许一个应用实例，第二实例启动失败。应用锁连接丢失时退出，避免失去排他性继续写入。跨连接 repository 并发已验证，不等于支持多实例调度。
- `/readyz` 检查数据库和应用锁连接；数据库不可用时返回 503。已有 JSON 数据但无完整迁移证据时拒绝启动，缺失迁移账户不会初始化成空库。

停应用后，用独立非 owner/NOBYPASSRLS 恢复角色（两个 schema 的 USAGE 与 SELECT，不授予写权限）导出：

```bash
# PG_BACKUP_DATABASE_URL 由环境注入，不在命令或日志中打印。
npm run export:postgres -- --data-dir /path/to/data --output-dir /path/to/new-export
```

OSS 模式还需显式 `--allow-remote-attachments`。导出取得应用排他锁；运行中拒绝导出。REPEATABLE READ 读取全站预算、身份、每账户关系行、文档与附件清单，逐文件核对 SHA-256/大小，全部通过后原子发布新目录；失败清除临时输出。新目录包含根 `ai-budget.json`、兼容 JSON 恢复文档、附件和带预算内容哈希的 `export-manifest.json`，不包含旧写源标记，也不依赖迁移快照；输出不是线上第二写源。

恢复时在**全新数据库**初始化 schema/角色，再对新导出目录执行完整导入，切换隔离应用验证。禁止清空运行标记后重导旧快照。`deploy/backup-to-oss.sh` 已增加停写导出分支，PG 模式要求 `PG_BACKUP_DATABASE_URL`；云端备份/OSS 的当前证据从控制面及适用发布回执读取。现有 `restore-drill.sh` 只证明导出的 JSON 兼容读取，显式清空数据库连接；新数据库恢复由 PostgreSQL 专项另验。
