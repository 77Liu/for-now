import { AsyncLocalStorage } from "node:async_hooks";
import { bindBusinessIdResponse, withBusinessIdTransaction } from "../../../.build/typescript/backend/shared/persistence/business-identifiers.mjs";
import {
  beginAiAuditAttempt,
  deleteExpiredAiAuditAttempts,
  finishAiAuditAttempt,
  findMissingAiAuditUsage,
  markInterruptedAiAuditAttempts
} from "../../../.build/typescript/backend/shared/persistence/ai-audit-repository.mjs";
import {
  readAiUsageAttempts,
  readAiUsageDaySummary,
  recordAiUsageAttempt
} from "../../../.build/typescript/backend/shared/persistence/ai-usage-repository.mjs";
import {
  pruneRecordChanges as pruneRecordSyncChanges
} from "../../../.build/typescript/backend/shared/persistence/record-sync-repository.mjs";
import {
  changeAuthPassword,
  countAuthUsers,
  deleteAuthSession,
  findAuthAuthentication,
  findAuthCredential,
  findAuthCredentialById,
  findAuthUserById,
  findFirstAuthOwner,
  insertAuthRegistration,
  issueAuthSessionIfCurrent,
  listAuthUsersPage,
  listAuthorizedAuthUsersPage,
  updateAuthRecordTimezone,
  updateAuthRole,
  updateAuthUsername
} from "../../../.build/typescript/backend/shared/persistence/postgres-auth.mjs";
import pg from "pg";
import { canonicalJson, mapStoreObjects, rebuildStoreObjects } from "./store-mapping.mjs";
import { clearStoreObjects, readPostgresStoreObjects, storeSqlMapping, writeStoreObjects } from "./postgres-objects.mjs";
import { mapAccountDocument } from "./document-mapping.mjs";
import { normalizePersistedDocument, preserveDocumentExtensions } from "./normalization.mjs";
import {
  findIdempotencyResponse,
  persistenceMetadata,
  preparePersistenceDocument,
  publicPersistenceDocument,
  recordIdempotencyResponse,
  synchronizePersistenceMetadata
} from "./persistence-metadata.mjs";
import {
  documentSqlMapping, readAccountDocument, writeAccountDocument, readAuthDocument, writeAuthDocument
} from "./postgres-documents.mjs";
import { createAccountUnitOfWork } from "../../../.build/typescript/backend/shared/persistence/account-unit-of-work.mjs";

const accountKey = id => `for-now-account:${id}`;
const invalid = message => Object.assign(new Error(message), { code: "STORAGE_CONFIGURATION_INVALID" });
const conflict = () => Object.assign(new Error("数据已变更，请刷新后重试"), { statusCode: 409, code: "VERSION_CONFLICT" });
function validateRecordCompressionQuota(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.days)) {
    throw invalid("PostgreSQL record-compression quota state is missing or invalid");
  }
  for (const day of value.days) {
    if (typeof day?.key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.key)
      || !Number.isSafeInteger(day.calls) || day.calls < 0
      || !Number.isSafeInteger(day.costMicros) || day.costMicros < 0
      || !Array.isArray(day.reservations)) {
      throw invalid("PostgreSQL record-compression quota day is invalid");
    }
    for (const reservation of day.reservations) {
      if (typeof reservation?.reservationId !== "string" || !reservation.reservationId
        || !Number.isSafeInteger(reservation.calls) || reservation.calls <= 0
        || !Number.isSafeInteger(reservation.costMicros) || reservation.costMicros < 0) {
        throw invalid("PostgreSQL record-compression quota reservation is invalid");
      }
    }
  }
  return structuredClone(value);
}

async function transaction(client, operation, readOnly = false, beforeCommit = () => {}) {
  await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
  try {
    const result = await operation();
    beforeCommit();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function validateRole(pool, kind) {
  const schema = kind === "auth" ? "for_now_auth" : "for_now";
  const forbiddenSchema = kind === "auth" ? "for_now" : "for_now_auth";
  const client = await pool.connect();
  try {
    const { rows: [role] } = await client.query(`
      SELECT current_user AS name, current_database() AS database, inet_server_addr()::text AS host,
        inet_server_port() AS port, rolsuper, rolbypassrls,
        has_schema_privilege(current_user, $1, 'USAGE') AS allowed,
        has_schema_privilege(current_user, $2, 'USAGE') AS forbidden,
        has_table_privilege(current_user, budget.oid, 'SELECT') AS budget_select,
        has_table_privilege(current_user, budget.oid, 'UPDATE') AS budget_update,
        has_table_privilege(current_user, budget.oid, 'INSERT') AS budget_insert,
        has_table_privilege(current_user, budget.oid, 'DELETE') AS budget_delete,
        has_table_privilege(current_user, budget.oid, 'TRUNCATE') AS budget_truncate,
        has_table_privilege(current_user, budget.oid, 'REFERENCES') AS budget_references,
        has_table_privilege(current_user, budget.oid, 'TRIGGER') AS budget_trigger,
        has_table_privilege(current_user, budget.oid, 'SELECT WITH GRANT OPTION') AS budget_select_grant,
        has_table_privilege(current_user, budget.oid, 'UPDATE WITH GRANT OPTION') AS budget_update_grant,
        EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = budget.oid
          AND a.attname = 'record_compression_quota' AND a.attnum > 0 AND NOT a.attisdropped) AS has_record_compression_quota,
        EXISTS (
          SELECT 1 FROM pg_class privileged
          JOIN pg_namespace privileged_schema ON privileged_schema.oid = privileged.relnamespace
          WHERE privileged_schema.nspname IN ('for_now', 'for_now_auth')
            AND privileged.relkind = 'r'
            AND privileged.oid <> budget.oid
            AND (
              has_table_privilege(current_user, privileged.oid, 'SELECT')
              OR has_table_privilege(current_user, privileged.oid, 'INSERT')
              OR has_table_privilege(current_user, privileged.oid, 'UPDATE')
              OR has_table_privilege(current_user, privileged.oid, 'DELETE')
              OR has_table_privilege(current_user, privileged.oid, 'TRUNCATE')
              OR has_table_privilege(current_user, privileged.oid, 'REFERENCES')
              OR has_table_privilege(current_user, privileged.oid, 'TRIGGER')
            )
        ) AS other_table_privileges,
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('for_now', 'for_now_auth') AND c.relkind = 'r'
            AND pg_has_role(current_user, c.relowner, 'USAGE')) AS owns
      FROM pg_roles
      CROSS JOIN (
        SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'for_now' AND c.relname = 'site_ai_budget'
      ) budget
      WHERE rolname = current_user
    `, [schema, forbiddenSchema]);
    if (!role || role.rolsuper || role.rolbypassrls || role.owns || !role.allowed || role.forbidden) {
      throw invalid("PostgreSQL runtime requires separate non-owner data/auth/AI budget roles without superuser or BYPASSRLS");
    }
    const anyBudgetPrivilege = role.budget_select || role.budget_update
      || role.budget_insert || role.budget_delete || role.budget_truncate
      || role.budget_references || role.budget_trigger
      || role.budget_select_grant || role.budget_update_grant;
    if (kind !== "budget" && anyBudgetPrivilege) {
      throw invalid("PostgreSQL data/auth runtime roles must not access for_now.site_ai_budget");
    }
    if (kind === "budget" && (!role.budget_select || !role.budget_update
      || !role.has_record_compression_quota
      || role.budget_insert || role.budget_delete || role.budget_truncate
      || role.budget_references || role.budget_trigger
      || role.budget_select_grant || role.budget_update_grant
      || role.other_table_privileges)) {
      throw invalid("PostgreSQL AI budget runtime role requires SELECT and UPDATE only on for_now.site_ai_budget");
    }
    return role;
  } finally { client.release(); }
}

export async function createPostgresRuntime({
  connectionString,
  authConnectionString,
  budgetConnectionString,
  getAccountId,
  requireMigration = false,
  authRequired = null,
  readOnly = false,
  onPoolError = () => {},
  authorizeAccount = () => {},
  assertAccountCommit = () => {},
  onAccountFailure = () => {}
}) {
  if (!connectionString || !authConnectionString || !budgetConnectionString) {
    throw invalid("DATABASE_URL, AUTH_DATABASE_URL and AI_BUDGET_DATABASE_URL are required");
  }
  const makePool = (connectionString, applicationName, max = 8) => {
    const pool = new pg.Pool({
      connectionString, max, connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000, statement_timeout: 30000, lock_timeout: 15000,
      application_name: applicationName
    });
    pool.on("error", onPoolError);
    pool.on("connect", client => client.on("error", onPoolError));
    return pool;
  };
  const dataPool = makePool(connectionString, "for-now-data-runtime");
  const authPool = makePool(authConnectionString, "for-now-auth-runtime");
  const budgetPool = makePool(budgetConnectionString, "for-now-ai-budget-runtime", 2);
  const connect = async pool => {
    try { return await pool.connect(); }
    catch (error) { onAccountFailure(error); throw error; }
  };
  const context = new AsyncLocalStorage(), authContext = new AsyncLocalStorage();
  let applicationClient = null;
  const close = async () => {
    if (applicationClient) {
      const client = applicationClient;
      applicationClient = null;
      await client.query("SELECT pg_advisory_unlock(hashtextextended('for-now-application', 0))").catch(() => {});
      client.release(true);
    }
    await Promise.all([dataPool.end(), authPool.end(), budgetPool.end()]);
  };
  try {
    const [dataRole, authRole, budgetRole] = await Promise.all([
      validateRole(dataPool, "data"),
      validateRole(authPool, "auth"),
      validateRole(budgetPool, "budget")
    ]);
    if (new Set([dataRole.name, authRole.name, budgetRole.name]).size !== 3
      || dataRole.database !== authRole.database || dataRole.database !== budgetRole.database
      || dataRole.host !== authRole.host || dataRole.host !== budgetRole.host
      || dataRole.port !== authRole.port || dataRole.port !== budgetRole.port) {
      throw invalid("Runtime data/auth/AI budget roles must be distinct and use the same database server");
    }
    if (authRequired === true) {
      const probe = await connect(dataPool);
      try {
        await transaction(probe, async () => {
          await probe.query("SELECT set_config('app.account_id', 'local', true)");
          if ((await probe.query("SELECT 1 FROM for_now.accounts WHERE account_id = 'local'")).rowCount) {
            throw invalid("Local account data requires explicit owner migration before enabling authentication");
          }
        }, true);
      } finally { probe.release(); }
    }
    const client = await connect(authPool);
    try {
      await transaction(client, async () => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('for-now-bundle', 0))");
        if (requireMigration && !(await client.query("SELECT 1 FROM for_now_auth.migration_state WHERE id = 'bundle'")).rowCount) {
          throw invalid("Existing JSON data requires a verified full migration before PostgreSQL startup");
        }
        if (authRequired === false && (await client.query(
          "SELECT 1 FROM for_now_auth.users LIMIT 1"
        )).rowCount) {
          throw invalid("Migrated identities require AUTH_REQUIRED=1");
        }
        if (!readOnly) {
          await client.query("INSERT INTO for_now_auth.runtime_state(id) VALUES (true) ON CONFLICT DO NOTHING");
        }
      }, readOnly);
    } finally { client.release(); }
  } catch (error) {
    await close();
    throw error;
  }

  const accountId = () => {
    const id = getAccountId();
    if (typeof id !== "string" || !/^[\w-]+$/.test(id)) throw invalid("An explicit account context is required");
    return id;
  };
  const bind = (client, id) => client.query("SELECT set_config('app.account_id', $1, true)", [id]);
  const withAccountLock = async operation => {
    authorizeAccount();
    const id = accountId(), current = context.getStore();
    if (current?.active && current.id === id) return operation(current.client, id);
    const client = await connect(dataPool);
    let destroy = false;
    try {
      // Session lock intentionally survives each explicit commit (attachment
      // cleanup persists its intent before touching external binary storage).
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [accountKey(id)]);
      const scope = { id, client, active: true, pending: Promise.resolve() };
      try { authorizeAccount(); return await context.run(scope, () => operation(client, id)); }
      finally { await scope.pending; scope.active = false; }
    } catch (error) { onAccountFailure(error); throw error; }
    finally {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [accountKey(id)]); }
      catch { destroy = true; }
      client.release(destroy);
    }
  };
  const accountTransaction = operation => withAccountLock((client, id) => {
    const current = context.getStore();
    const pending = current.pending.then(() => transaction(client, async () => {
      await bind(client, id);
      authorizeAccount();
      return operation(client, id);
    }, false, authorizeAccount));
    current.pending = pending.catch(() => {});
    return pending;
  });
  const readAccount = async operation => {
    authorizeAccount();
    const id = accountId(), client = await connect(dataPool);
    try {
      return await transaction(client, async () => {
        await bind(client, id);
        authorizeAccount();
        return operation(client, id);
      }, true, authorizeAccount);
    } catch (error) { onAccountFailure(error); throw error; }
    finally { client.release(); }
  };
  const markAccount = async (client, id) => {
    const result = await client.query(
      "UPDATE for_now.accounts SET runtime_started_at = COALESCE(runtime_started_at, now()), revision = revision + 1 WHERE account_id = $1 RETURNING revision",
      [id]
    );
    if (!result.rowCount) throw invalid("Account is not provisioned");
  };
  const documents = {
    read: (name, fallback) => readAccount((client, id) => readAccountDocument(client, id, name, fallback)),
    update: (name, fallback, mutator, normalize = value => value) => accountTransaction(async (client, id) => {
      const raw = await readAccountDocument(client, id, name, fallback);
      const document = normalizePersistedDocument(raw, normalize);
      const result = await mutator(document);
      assertAccountCommit(raw, document, name);
      await writeAccountDocument(client, id, name, preserveDocumentExtensions(raw, document));
      await markAccount(client, id);
      return result;
    }),
    write: (name, value) => accountTransaction(async (client, id) => {
      const before = await readAccountDocument(client, id, name, null);
      assertAccountCommit(before, value, name);
      await writeAccountDocument(client, id, name, preserveDocumentExtensions(before, value));
      await markAccount(client, id);
    })
  };
  /**
   * 创建账户仓储；新增onCommitted（unreleased）位于真实COMMIT之后、审计之前。
   * 提示失败不回滚或重判已提交事实；仍由持久游标与回执确认结果。
   */
  let recordProjection = null;
  const createStoreRepository = ({
    normalize,
    pgIo = null,
    emptyDocument,
    onCommit = async () => {},
    onCommitted = () => {},
    now = () => new Date().toISOString(),
    getContext = () => ({})
  }) => {
    const afterCommit = Symbol.for("for-now.after-commit");
    let assertLegacyMutation = null;
    const hintCommitted = (id, details = {}) => {
      try { void Promise.resolve(onCommitted({ accountId: id, storageScope: "postgres", ...details })).catch(() => {}); } catch {}
    };
    const projectChanged = (context, rows) => recordProjection?.changed(context, rows);
    const accountUnitOfWork = createAccountUnitOfWork({
      beforeCommit: async (context, rows) => { await projectChanged(context, rows); },
      transaction: accountTransaction,
      onCommitted: event => hintCommitted(event.accountId, {
        cursor: event.cursor,
        commandId: event.commandId
      }),
      getContext,
      now
    });
    const readRaw = async (client, id) => {
      const mapping = await readPostgresStoreObjects(client, id);
      try { return rebuildStoreObjects(mapping); }
      catch (cause) {
        const error = Object.assign(new Error("账户存储映射损坏，原数据已保留"), {
          statusCode: 503, code: "ACCOUNT_DATA_INVALID", recoveryScope: "account", accountId: id, reasonCode: "ACCOUNT_STORE_MAPPING_INVALID", cause
        });
        onAccountFailure(error); throw error;
      }
    };
    const metadataMode = id => pgIo?.syncReadMode === "metadata"
      && (pgIo.accountAllowlist.includes("*") || pgIo.accountAllowlist.includes(id));
    const mappingError = (id, cause) => Object.assign(new Error("账户同步存储损坏，原数据已保留"), {
      statusCode: 503, code: "ACCOUNT_DATA_INVALID", recoveryScope: "account", accountId: id,
      reasonCode: "ACCOUNT_SYNC_MAPPING_INVALID", cause
    });
    // 此payload本来就剥离生命周期和幂等ledger；只验证并消费同步元数据，不伪造完整仓库。
    const readSyncMetadata = async (client, id) => {
      const rows = (await client.query("SELECT field, shape, payload FROM for_now.store_fields WHERE account_id = $1 AND (field = '_persistence' OR field = 'version')", [id])).rows;
      try {
        const row = rows.find(item => item.field === "_persistence");
        const versionRow = rows.find(item => item.field === "version");
        if (rows.length !== 2 || row?.shape !== "value" || !row.payload || typeof row.payload !== "object"
          || Array.isArray(row.payload) || row.payload.version !== 1
          || versionRow?.shape !== "value" || !Number.isSafeInteger(versionRow.payload) || versionRow.payload < 1) throw new Error("Missing or unsupported sync metadata");
        const hasSync = Object.hasOwn(row.payload, "sync");
        const sync = row.payload.sync;
        if (hasSync && (!sync || typeof sync !== "object" || Array.isArray(sync))) throw new Error("Invalid sync shape");
        // 先校验所有已存在字段：旧格式缺省不允许掩盖同时存在的坏cursor/记录。
        if (hasSync) persistenceMetadata({ _persistence: { ...row.payload,
          sync: { cursor: 0, changes: [], operations: [], ...sync }, lifecycles: [], idempotency: [] } });
        const missing = !hasSync || !["cursor", "changes", "operations"].every(key => Object.hasOwn(sync, key));
        // 旧store曾合法缺少同步回执字段；必须走同一快照完整迁移消费者，不能在窄读补空。
        if (missing && versionRow.payload < emptyDocument.version) return null;
        if (missing) throw new Error("Current store is missing sync state");
        return { sync: structuredClone(sync) };
      } catch (cause) { throw mappingError(id, cause); }
    };
    const fullSyncSnapshot = async (client, id) => {
      const document = preparePersistenceDocument(normalizePersistedDocument(await readRaw(client, id), normalize), now);
      return { document: publicPersistenceDocument(document), metadata: persistenceMetadata(document) };
    };
    /**
     * 在同一账户只读可重复读快照内判断游标，并读取按域投影的真实字段闭包。
     * 未变化/错误游标不读取业务对象；历史schema和未知域保留完整读取。
     * @since unreleased
     */
    const readSyncChanges = ({ cursor: after, hasCursor = true, limit = 500, fieldsForDomains } = {}) => readAccount(async (client, id) => {
      if (!metadataMode(id)) return fullSyncSnapshot(client, id);
      const metadata = await readSyncMetadata(client, id);
      if (metadata === null) return fullSyncSnapshot(client, id);
      const { cursor, changes } = metadata.sync;
      const oldest = changes[0]?.cursor || cursor + 1;
      const pending = hasCursor ? changes.filter(change => change.cursor > after) : [];
      if (!pending.length || after > cursor || (hasCursor && after < oldest - 1) || pending.length > limit) return { document: null, metadata };
      const fields = fieldsForDomains?.([...new Set(pending.map(change => change.domain))]);
      if (!fields) return fullSyncSnapshot(client, id);
      const mapping = await readPostgresStoreObjects(client, id, { fields });
      try {
        const raw = rebuildStoreObjects(mapping);
        if (!Object.hasOwn(raw, "version")) throw new Error("Missing store version");
        if (raw.version !== emptyDocument.version) return fullSyncSnapshot(client, id);
        for (const field of fields) {
          if (!Object.hasOwn(raw, field)) throw new Error(`Missing projection field: ${field}`);
          if (Array.isArray(emptyDocument[field]) && !Array.isArray(raw[field])) throw new Error(`Invalid projection array: ${field}`);
        }
        // 规范化可添加未读取域的默认值，但它们不构成投影证据，必须在返回前剥离。
        const normalized = normalizePersistedDocument(raw, normalize);
        return { document: Object.fromEntries(fields.map(field => [field, normalized[field]])), metadata };
      } catch (cause) { throw mappingError(id, cause); }
    });
    const transact = operation => withAccountLock(async (client, id) => {
      const initial = await transaction(client, async () => {
        await bind(client, id);
        const row = (await client.query("SELECT revision FROM for_now.accounts WHERE account_id = $1", [id])).rows[0];
        if (!row) throw invalid("Account is not provisioned");
        return { raw: await readRaw(client, id), revision: row.revision };
      }, true);
      const document = preparePersistenceDocument(
        normalizePersistedDocument(initial.raw, normalize),
        now
      );
      let before = structuredClone(document), revision = initial.revision;
      const commit = async () => {
        assertAccountCommit(before, document, "store");
        assertLegacyMutation?.(before, document);
        synchronizePersistenceMetadata(before, document, now, { context: getContext() || {} });
        const mapping = mapStoreObjects(id, document);
        const next = await transaction(client, async () => {
          await bind(client, id);
          const result = await client.query(`
            UPDATE for_now.accounts SET revision = revision + 1,
              runtime_started_at = COALESCE(runtime_started_at, now())
            WHERE account_id = $1 AND revision = $2 RETURNING revision
          `, [id, revision]);
          if (!result.rowCount) throw conflict();
          await clearStoreObjects(client, id);
          await writeStoreObjects(client, mapping);
          if (recordProjection) {
            const previous = new Map(mapStoreObjects(id, before).objects.map(row => [row.objectKey, row]));
            const current = new Map(mapping.objects.map(row => [row.objectKey, row]));
            const changed = [...previous.values(), ...current.values()].filter(row => (
              canonicalJson(previous.get(row.objectKey) ?? null) !== canonicalJson(current.get(row.objectKey) ?? null)
            ));
            await projectChanged({ client, accountId: id }, changed);
          }
          const missing = await client.query(`
            SELECT 1 FROM for_now.store_attachment_refs r
            LEFT JOIN for_now.attachment_inventory i ON i.account_id = r.account_id AND i.path = r.path
            WHERE r.account_id = $1 AND r.field_name <> 'attachmentCleanup'
              AND (i.path IS NULL OR i.state <> 'verified') LIMIT 1
          `, [id]);
          if (missing.rowCount) throw Object.assign(new Error("附件不存在，请重新上传"), { statusCode: 409, code: "ATTACHMENT_MISSING" });
          // Removed inventory is finalized only when no reference/cleanup task remains.
          await client.query(`
            DELETE FROM for_now.attachment_inventory i WHERE i.account_id = $1 AND i.state = 'missing_cleanup'
              AND NOT EXISTS (SELECT 1 FROM for_now.store_attachment_refs r WHERE r.account_id = i.account_id AND r.path = i.path)
          `, [id]);
          return result.rows[0].revision;
        }, false, authorizeAccount);
        revision = next;
        hintCommitted(id);
        const context = getContext();
        if (context?.clientOperationId) context.operationCommitted = true;
        const previous = before;
        before = structuredClone(document);
        await onCommit(publicPersistenceDocument(previous), publicPersistenceDocument(document));
      };
      return withBusinessIdTransaction(document, () => operation({ document, commit }));
    });
    const executeIdempotent = (request, operation, { onReplay = value => value } = {}) => transact(async ({ document, commit }) => {
      const replay = findIdempotencyResponse(document, request, now);
      if (replay !== undefined) {
        const context = getContext() || {};
        const result = bindBusinessIdResponse(onReplay(structuredClone(replay)), context);
        context.operationCommitted = true;
        return structuredClone(result);
      }
      const response = bindBusinessIdResponse(await operation(document), getContext() || {});
      recordIdempotencyResponse(document, { ...request, response }, now);
      await commit();
      return structuredClone(response);
    });
    return {
      /** 数据库实例由运行时独占，账户由受信上下文另行绑定。 @since unreleased */
      syncScope: () => "postgres",
      /** Installs one domain-owned projection before account initialization. @since unreleased */
      recordProjectionCoverage: Object.freeze({
        recordTransactions: true,
        legacyCommits: true,
        initialization: true,
        offlineImportInvalidates: true,
        legacyMutationGuard: true
      }),
      installRecordProjection(projection) {
        if (recordProjection) throw new Error("Record projection already installed");
        if (typeof projection?.changed !== "function" || typeof projection?.rebuild !== "function") {
          throw new TypeError("Record projection requires changed/rebuild commands");
        }
        recordProjection = projection;
        assertLegacyMutation = projection.assertLegacyMutation;
      },
      /** Reads only caller-declared collections for legacy domain adapters. @since unreleased */
      readCollections: fields => readAccount(async (client, id) => {
        if (!Array.isArray(fields) || fields.some(field => typeof field !== "string")) {
          throw new TypeError("Collection query requires explicit field names");
        }
        return rebuildStoreObjects(await readPostgresStoreObjects(client, id, { fields }));
      }),
      /** Runs a domain query under the trusted account and the existing read transaction. @since unreleased */
      queryRecords: operation => readAccount((client, accountId) => operation({ client, accountId })),
      /** Explicit maintenance: isolated account transaction, never an online fallback. @since unreleased */
      rebuildRecordProjection: (afterRootId = "") => accountTransaction((client, accountId) => {
        if (!recordProjection) throw new Error("Record projection is not installed");
        return recordProjection.rebuild({ client, accountId }, afterRootId);
      }),
      pruneRecordChanges: ({ before, retainRows }) => accountTransaction(
        (client, accountId) => pruneRecordSyncChanges(
          { client, accountId },
          { before, retainRows }
        )
      ),
      validate: ({ allowCreate = false } = {}) => readAccount(async (client, id) => {
        const exists = (await client.query("SELECT 1 FROM for_now.accounts WHERE account_id = $1", [id])).rowCount;
        if (!exists && allowCreate) return null;
        if (!exists) throw Object.assign(new Error("迁移账户缺失，拒绝空初始化"), {
          statusCode: 503, code: "ACCOUNT_DATA_INVALID", recoveryScope: "account", accountId: id, reasonCode: "ACCOUNT_MIGRATION_MISSING"
        });
        return readRaw(client, id);
      }),
      read: () => readAccount(async (client, id) => publicPersistenceDocument(preparePersistenceDocument(
        normalizePersistedDocument(await readRaw(client, id), normalize),
        now
      ))),
      transact,
      update: mutator => transact(async ({ document, commit }) => {
        const result = bindBusinessIdResponse(await mutator(document), getContext() || {});
        await commit();
        await result?.[afterCommit]?.();
        return result;
      }),
      executeIdempotent,
      readIdempotent: request => readAccount(async (client, id) => {
        const document = preparePersistenceDocument(
          normalizePersistedDocument(await readRaw(client, id), normalize),
          now
        );
        const replay = findIdempotencyResponse(document, request, now);
        return replay === undefined ? undefined : structuredClone(replay);
      }),
      readPersistenceMetadata: () => readAccount(async (client, id) => persistenceMetadata(preparePersistenceDocument(
        normalizePersistedDocument(await readRaw(client, id), normalize),
        now
      ))),
      readSyncSnapshot: () => readAccount(fullSyncSnapshot),
      readSyncChanges,
      /** 只查询同步operations回执，不读取独立幂等ledger；仍受账户资格/RLS约束。 @since unreleased */
      readOperationReceipt: operationId => readAccount(async (client, id) => {
        const metadata = metadataMode(id) ? await readSyncMetadata(client, id) : null;
        const snapshot = metadata ? { metadata } : await fullSyncSnapshot(client, id);
        return structuredClone(snapshot.metadata.sync.operations.find(item => item.operationId === operationId));
      }),
      /** 记录级命令只经该短事务端口访问；默认配置为空时没有业务消费者。 @since unreleased */
      accountUnitOfWork,
      initialize: ({ allowCreate = false } = {}) => {
        const id = accountId();
        return accountTransaction(async (client, id) => {
        const exists = (await client.query("SELECT 1 FROM for_now.accounts WHERE account_id = $1", [id])).rowCount;
        if (!exists && !allowCreate) throw invalid("Missing migrated account; refusing empty initialization");
        if (!exists) {
          await client.query("INSERT INTO for_now.accounts(account_id) VALUES ($1)", [id]);
          await client.query(
            "INSERT INTO for_now.account_sync_heads(account_id) VALUES ($1)",
            [id]
          );
          await writeStoreObjects(client, mapStoreObjects(id, preparePersistenceDocument(
            normalize(structuredClone(emptyDocument)),
            now
          )));
        } else {
          const raw = await readRaw(client, id), normalized = preparePersistenceDocument(
            normalizePersistedDocument(raw, normalize),
            now
          );
          if (canonicalJson(raw) !== canonicalJson(normalized)) {
            const previousMapping = mapStoreObjects(id, raw);
            const nextMapping = mapStoreObjects(id, normalized);
            await clearStoreObjects(client, id);
            await writeStoreObjects(client, nextMapping);
            if (recordProjection) {
              const previousRows = new Map(previousMapping.objects.map(row => [row.objectKey, row]));
              const currentRows = new Map(nextMapping.objects.map(row => [row.objectKey, row]));
              const changed = [...previousRows.values(), ...currentRows.values()].filter(row => (
                canonicalJson(previousRows.get(row.objectKey) ?? null) !== canonicalJson(currentRows.get(row.objectKey) ?? null)
              ));
              await projectChanged({ client, accountId: id }, changed);
            }
          }
        }
        if (recordProjection?.initialize) await recordProjection.initialize({ client, accountId: id });
        await markAccount(client, id);
        }).then(result => { hintCommitted(id); return result; });
      },
      waitForIdle: () => withAccountLock(async () => {})
    };
  };
  const aiAudit = {
    findMissingUsage: (afterCallId, limit) => readAccount((client, id) => (
      findMissingAiAuditUsage(client, id, afterCallId, limit)
    )),
    beginAttempt: row => accountTransaction((client, id) => (
      beginAiAuditAttempt(client, id, row)
    )),
    finishAttempt: (callId, terminal) => accountTransaction((client, id) => (
      finishAiAuditAttempt(client, id, callId, terminal)
    )),
    markInterrupted: (cutoff, limit) => accountTransaction((client, id) => (
      markInterruptedAiAuditAttempts(client, id, cutoff, limit)
    )),
    deleteExpired: (cutoff, limit) => accountTransaction((client, id) => (
      deleteExpiredAiAuditAttempts(client, id, cutoff, limit)
    ))
  };
  const aiUsage = {
    recordAttempt: entry => accountTransaction((client, id) => (
      recordAiUsageAttempt(client, id, entry)
    )),
    read: options => readAccount((client, id) => (
      readAiUsageAttempts(client, id, options)
    )),
    readDaySummary: day => readAccount((client, id) => (
      readAiUsageDaySummary(client, id, day)
    )),
    ensure: () => readAccount(async client => {
      await client.query("SELECT 1 FROM for_now.ai_usage_attempts LIMIT 0");
      await client.query("SELECT 1 FROM for_now.ai_usage_aggregates LIMIT 0");
    })
  };
  const aiBudget = {
    read: async () => {
      const client = await connect(budgetPool);
      try {
        return await transaction(client, async () => {
          const row = (await client.query(
            "SELECT document, record_compression_quota AS \"recordCompressionQuota\" FROM for_now.site_ai_budget WHERE id = true"
          )).rows[0];
          if (!row) throw invalid("PostgreSQL AI budget singleton is missing");
          return {
            ...structuredClone(row.document),
            recordCompressionQuota: validateRecordCompressionQuota(row.recordCompressionQuota)
          };
        }, true);
      } catch (error) { onAccountFailure(error); throw error; } finally { client.release(); }
    },
    update: async mutator => {
      if (typeof mutator !== "function") throw new TypeError("AI budget update requires a mutator");
      const client = await connect(budgetPool);
      try {
        return await transaction(client, async () => {
          const row = (await client.query(
            "SELECT document, record_compression_quota AS \"recordCompressionQuota\" FROM for_now.site_ai_budget WHERE id = true FOR UPDATE"
          )).rows[0];
          if (!row) throw invalid("PostgreSQL AI budget singleton is missing");
          const document = structuredClone(row.document);
          const atomicState = { recordCompressionQuota: validateRecordCompressionQuota(row.recordCompressionQuota) };
          const result = await mutator(document, atomicState);
          if (!document || typeof document !== "object" || Array.isArray(document)) {
            throw new TypeError("AI budget update must preserve an object document");
          }
          atomicState.recordCompressionQuota = validateRecordCompressionQuota(atomicState.recordCompressionQuota);
          await client.query(
            "UPDATE for_now.site_ai_budget SET document = $1::jsonb, record_compression_quota = $2::jsonb WHERE id = true",
            [JSON.stringify(document), JSON.stringify(atomicState.recordCompressionQuota)]
          );
          return result;
        });
      } catch (error) { onAccountFailure(error); throw error; } finally { client.release(); }
    }
  };
  const authRead = async operation => {
    const client = await connect(authPool);
    try { return await transaction(client, () => operation(client), true); }
    catch (error) { onAccountFailure(error); throw error; }
    finally { client.release(); }
  };
  const authWrite = async operation => {
    const client = await connect(authPool);
    try { return await transaction(client, () => operation(client)); }
    catch (error) { onAccountFailure(error); throw error; }
    finally { client.release(); }
  };
  const executeProvisions = async (client, provisions) => {
    for (const { id, business, documents } of provisions) {
      await client.query(
        "SELECT for_now_auth.provision_account($1, $2::jsonb, $3::jsonb)",
        [id, JSON.stringify(business), JSON.stringify(documents)]
      );
    }
  };
  const provision = (id, store, values) => {
    const current = authContext.getStore();
    if (!current) throw invalid("Provisioning requires a registration transaction");
    // 注册必须一次写入完整同步元数据；兼容无 trash 的合法旧格式，且不修改调用方。
    const document = preparePersistenceDocument(structuredClone(store), undefined, { force: true });
    const mapping = mapStoreObjects(id, document);
    const business = storeSqlMapping(mapping);
    if (recordProjection) business.projectionVersion = recordProjection.provisionedVersion(mapping.objects);
    current.provisions.push({
      id, business,
      documents: Object.entries(values).map(([name, value]) => documentSqlMapping(mapAccountDocument(id, name, value)))
    });
  };
  const rowAuth = {
    findCredentialByUsernameKey: key => authRead(client => findAuthCredential(client, key)),
    findCredentialByUserId: id => authRead(client => findAuthCredentialById(client, id)),
    findAuthenticationByTokenHash: hash => authRead(client => findAuthAuthentication(client, hash)),
    findUserById: id => authRead(client => findAuthUserById(client, id)),
    findFirstOwner: () => authRead(client => findFirstAuthOwner(client)),
    countUsers: () => authRead(client => countAuthUsers(client)),
    scanUsersPage: query => authRead(client => listAuthUsersPage(client, query.limit, query.after)),
    listUsersPage: query => authRead(client => listAuthorizedAuthUsersPage(
      client, query.tokenHash, query.limit, query.after, query.nowMs
    )),
    register: command => authWrite(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('for-now-auth-bootstrap', 0))");
      const first = await countAuthUsers(client) === 0;
      const user = { ...command.user, role: first ? "owner" : "user" };
      const session = { ...command.session, userId: user.id, sessionVersion: user.sessionVersion };
      await insertAuthRegistration(client, user, session);
      const provisions = [];
      const rollbackStorage = await authContext.run(
        { provisions },
        () => command.initialize(user, first)
      );
      await executeProvisions(client, provisions);
      return { user, session, rollbackStorage };
    }),
    issueSessionIfCredentialCurrent: command => authWrite(async client => {
      const user = await issueAuthSessionIfCurrent(client, command.snapshot, command.session);
      return user ? { user, session: command.session } : null;
    }),
    setRole: command => authWrite(client => updateAuthRole(
      client, command.tokenHash, command.userId, command.role,
      command.updatedAt, command.nowMs
    )),
    rename: command => authWrite(client => updateAuthUsername(
      client, command.tokenHash, command.username, command.usernameKey,
      command.updatedAt, command.nowMs
    )),
    setRecordTimezone: command => authWrite(client => updateAuthRecordTimezone(
      client, command.tokenHash, command.recordTimezone,
      command.updatedAt, command.nowMs
    )),
    changePasswordAndRevokeSessions: command => authWrite(client => changeAuthPassword(
      client, command.tokenHash, command.snapshot, command.passwordHash,
      command.updatedAt, command.nowMs
    )),
    deleteSession: tokenHash => authWrite(client => deleteAuthSession(client, tokenHash)),
    verify: () => authRead(async client => {
      const [user, session] = await Promise.all([
        client.query(`
          SELECT id FROM for_now_auth.users
          WHERE password_hash !~ '^scrypt\\$[A-Za-z0-9+/]{22}==\\$[A-Za-z0-9+/]{86}==$'
          LIMIT 1
        `),
        client.query(`
          SELECT token_hash FROM for_now_auth.sessions
          WHERE token_hash !~ '^[a-f0-9]{64}$'
          LIMIT 1
        `)
      ]);
      return { valid: !user.rowCount && !session.rowCount };
    })
  };
  const auth = {
    read: () => authRead(client => readAuthDocument(client))
      .then(value => value || { version: 1, users: [], sessions: [] }),
    update: mutator => authWrite(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('for-now-bundle', 0))");
      const document = await readAuthDocument(client) || { version: 1, users: [], sessions: [] };
      const provisions = [];
      const result = await authContext.run({ provisions }, () => mutator(document));
      await writeAuthDocument(client, document);
      await executeProvisions(client, provisions);
      return result;
    }),
    provision,
    row: rowAuth
  };
  const attachments = {
    lock: operation => withAccountLock(() => operation()),
    record: item => accountTransaction(async (client, id) => {
      await client.query(`
        INSERT INTO for_now.attachment_inventory(account_id,path,storage,object_key,bytes,sha256,state)
        VALUES ($1,$2,$3,$4,$5,$6,'uploading')
      `, [id, item.path, item.storage, item.objectKey, item.bytes, item.sha256]);
      await markAccount(client, id);
    }),
    confirm: item => accountTransaction(async (client, id) => {
      const result = await client.query(`
        UPDATE for_now.attachment_inventory SET state = 'verified', storage = $3, object_key = $4
        WHERE account_id = $1 AND path = $2 AND bytes = $5 AND sha256 = $6
      `, [id, item.path, item.storage, item.objectKey, item.bytes, item.sha256]);
      if (!result.rowCount) throw new Error("Uploaded attachment does not match its durable inventory");
    }),
    pending: () => readAccount(async (client, id) => (await client.query(`
      SELECT path FROM for_now.attachment_inventory WHERE account_id = $1 AND state = 'uploading'
    `, [id])).rows),
    list: ({ paths = null } = {}) => readAccount(async (client, id) => (await client.query(`
      SELECT path, storage, object_key AS "objectKey", bytes, sha256, state
      FROM for_now.attachment_inventory
      WHERE account_id = $1
        AND ($2::text[] IS NULL OR path = ANY($2::text[]))
      ORDER BY path
    `, [id, paths])).rows),
    removed: resourcePath => accountTransaction(async (client, id) => {
      await client.query(`
        UPDATE for_now.attachment_inventory SET state = 'missing_cleanup', bytes = NULL, sha256 = NULL
        WHERE account_id = $1 AND path = $2
      `, [id, resourcePath]);
      await client.query(`
        DELETE FROM for_now.attachment_inventory i WHERE account_id = $1 AND path = $2
          AND NOT EXISTS (SELECT 1 FROM for_now.store_attachment_refs r WHERE r.account_id = i.account_id AND r.path = i.path)
      `, [id, resourcePath]);
      // Inventory-only changes do not advance the store revision while a
      // multi-commit cleanup operation holds this same account lock.
    })
  };
  const claimApplication = async onLost => {
    const client = await connect(authPool);
    try {
      const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended('for-now-application', 0)) AS acquired");
      if (!result.rows[0].acquired) throw invalid("Only one application instance per database is supported by the current scheduler and global quotas");
      applicationClient = client;
      client.on("error", () => { if (applicationClient === client) onLost(); });
    } catch (error) { client.release(true); throw error; }
  };
  const ready = () => Promise.all([
    dataPool.query("SELECT 1"), authPool.query("SELECT 1"), budgetPool.query("SELECT 1"),
    ...(applicationClient ? [applicationClient.query("SELECT 1")] : [])
  ]);
  /**
   * 读取认证层已确认Owner的固定settings文档；独立只读事务不授予业务store、写入或新派发资格。
   * 调用者须独立校验配置，损坏时拒绝，不写默认值。
   * @since unreleased
   */
  const readSharedSettings = async id => {
    const client = await connect(dataPool);
    try { return await transaction(client, async () => { await bind(client, id); return readAccountDocument(client, id, "settings", null); }, true); }
    catch (error) { onAccountFailure(error); throw error; }
    finally { client.release(); }
  };
  return {
    createStoreRepository,
    documents,
    aiAudit,
    aiUsage,
    aiBudget,
    auth,
    attachments,
    ready,
    claimApplication,
    close,
    readSharedSettings
  };
}
