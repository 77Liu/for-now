import { AsyncLocalStorage } from "node:async_hooks";
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

const accountKey = id => `for-now-account:${id}`;
const invalid = message => Object.assign(new Error(message), { code: "STORAGE_CONFIGURATION_INVALID" });
const conflict = () => Object.assign(new Error("数据已变更，请刷新后重试"), { statusCode: 409, code: "VERSION_CONFLICT" });

async function transaction(client, operation, readOnly = false) {
  await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
  try {
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function validateRole(pool, schema, forbiddenSchema) {
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
      throw invalid("PostgreSQL runtime requires separate non-owner data/auth roles without superuser or BYPASSRLS");
    }
    if (schema === "for_now" && (!role.budget_select || !role.budget_update
      || role.budget_insert || role.budget_delete || role.budget_truncate
      || role.budget_references || role.budget_trigger
      || role.budget_select_grant || role.budget_update_grant)) {
      throw invalid("PostgreSQL data runtime role requires SELECT and UPDATE only on for_now.site_ai_budget");
    }
    return role;
  } finally { client.release(); }
}

export async function createPostgresRuntime({
  connectionString,
  authConnectionString,
  getAccountId,
  requireMigration = false,
  authRequired = null,
  readOnly = false,
  onPoolError = () => {}
}) {
  if (!connectionString || !authConnectionString) throw invalid("DATABASE_URL and AUTH_DATABASE_URL are required");
  const makePool = connectionString => {
    const pool = new pg.Pool({
      connectionString, max: 8, connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000, statement_timeout: 30000, lock_timeout: 15000,
      application_name: "for-now-runtime"
    });
    pool.on("error", onPoolError);
    pool.on("connect", client => client.on("error", onPoolError));
    return pool;
  };
  const dataPool = makePool(connectionString), authPool = makePool(authConnectionString);
  const context = new AsyncLocalStorage(), authContext = new AsyncLocalStorage();
  let applicationClient = null;
  const close = async () => {
    if (applicationClient) {
      const client = applicationClient;
      applicationClient = null;
      await client.query("SELECT pg_advisory_unlock(hashtextextended('for-now-application', 0))").catch(() => {});
      client.release(true);
    }
    await Promise.all([dataPool.end(), authPool.end()]);
  };
  try {
    const [dataRole, authRole] = await Promise.all([
      validateRole(dataPool, "for_now", "for_now_auth"),
      validateRole(authPool, "for_now_auth", "for_now")
    ]);
    if (dataRole.name === authRole.name || dataRole.database !== authRole.database
      || dataRole.host !== authRole.host || dataRole.port !== authRole.port) {
      throw invalid("Runtime roles must be distinct and use the same database server");
    }
    if (authRequired === true) {
      const probe = await dataPool.connect();
      try {
        await transaction(probe, async () => {
          await probe.query("SELECT set_config('app.account_id', 'local', true)");
          if ((await probe.query("SELECT 1 FROM for_now.accounts WHERE account_id = 'local'")).rowCount) {
            throw invalid("Local account data requires explicit owner migration before enabling authentication");
          }
        }, true);
      } finally { probe.release(); }
    }
    const client = await authPool.connect();
    try {
      await transaction(client, async () => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('for-now-bundle', 0))");
        if (requireMigration && !(await client.query("SELECT 1 FROM for_now_auth.migration_state WHERE id = 'bundle'")).rowCount) {
          throw invalid("Existing JSON data requires a verified full migration before PostgreSQL startup");
        }
        if (authRequired === false && (await readAuthDocument(client))?.users.length) {
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
    const id = accountId(), current = context.getStore();
    if (current?.active && current.id === id) return operation(current.client, id);
    const client = await dataPool.connect();
    let destroy = false;
    try {
      // Session lock intentionally survives each explicit commit (attachment
      // cleanup persists its intent before touching external binary storage).
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [accountKey(id)]);
      const scope = { id, client, active: true, pending: Promise.resolve() };
      try { return await context.run(scope, () => operation(client, id)); }
      finally { await scope.pending; scope.active = false; }
    } finally {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [accountKey(id)]); }
      catch { destroy = true; }
      client.release(destroy);
    }
  };
  const accountTransaction = operation => withAccountLock((client, id) => {
    const current = context.getStore();
    const pending = current.pending.then(() => transaction(client, async () => {
      await bind(client, id);
      return operation(client, id);
    }));
    current.pending = pending.catch(() => {});
    return pending;
  });
  const readAccount = async operation => {
    const id = accountId(), client = await dataPool.connect();
    try {
      return await transaction(client, async () => {
        await bind(client, id);
        return operation(client, id);
      }, true);
    } finally { client.release(); }
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
      await writeAccountDocument(client, id, name, preserveDocumentExtensions(raw, document));
      await markAccount(client, id);
      return result;
    }),
    write: (name, value) => accountTransaction(async (client, id) => {
      const before = await readAccountDocument(client, id, name, null);
      await writeAccountDocument(client, id, name, preserveDocumentExtensions(before, value));
      await markAccount(client, id);
    })
  };
  const createStoreRepository = ({
    normalize,
    emptyDocument,
    onCommit = async () => {},
    now = () => new Date().toISOString(),
    getContext = () => ({})
  }) => {
    const afterCommit = Symbol.for("for-now.after-commit");
    const readRaw = (client, id) => readPostgresStoreObjects(client, id).then(rebuildStoreObjects);
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
        });
        revision = next;
        const previous = before;
        before = structuredClone(document);
        await onCommit(publicPersistenceDocument(previous), publicPersistenceDocument(document));
      };
      return operation({ document, commit });
    });
    const executeIdempotent = (request, operation, { onReplay = value => value } = {}) => transact(async ({ document, commit }) => {
      const replay = findIdempotencyResponse(document, request, now);
      if (replay !== undefined) return structuredClone(onReplay(structuredClone(replay)));
      const response = await operation(document);
      recordIdempotencyResponse(document, { ...request, response }, now);
      await commit();
      return structuredClone(response);
    });
    return {
      read: () => readAccount(async (client, id) => publicPersistenceDocument(preparePersistenceDocument(
        normalizePersistedDocument(await readRaw(client, id), normalize),
        now
      ))),
      transact,
      update: mutator => transact(async ({ document, commit }) => {
        const result = await mutator(document);
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
      readSyncSnapshot: () => readAccount(async (client, id) => {
        const document = preparePersistenceDocument(
          normalizePersistedDocument(await readRaw(client, id), normalize),
          now
        );
        return {
          document: publicPersistenceDocument(document),
          metadata: persistenceMetadata(document)
        };
      }),
      initialize: ({ allowCreate = false } = {}) => accountTransaction(async (client, id) => {
        const exists = (await client.query("SELECT 1 FROM for_now.accounts WHERE account_id = $1", [id])).rowCount;
        if (!exists && !allowCreate) throw invalid("Missing migrated account; refusing empty initialization");
        if (!exists) {
          await client.query("INSERT INTO for_now.accounts(account_id) VALUES ($1)", [id]);
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
            await clearStoreObjects(client, id);
            await writeStoreObjects(client, mapStoreObjects(id, normalized));
          }
        }
        await markAccount(client, id);
      }),
      waitForIdle: () => withAccountLock(async () => {})
    };
  };
  const aiBudget = {
    read: async () => {
      const client = await dataPool.connect();
      try {
        return await transaction(client, async () => {
          const row = (await client.query(
            "SELECT document FROM for_now.site_ai_budget WHERE id = true"
          )).rows[0];
          if (!row) throw invalid("PostgreSQL AI budget singleton is missing");
          return structuredClone(row.document);
        }, true);
      } finally { client.release(); }
    },
    update: async mutator => {
      if (typeof mutator !== "function") throw new TypeError("AI budget update requires a mutator");
      const client = await dataPool.connect();
      try {
        return await transaction(client, async () => {
          const row = (await client.query(
            "SELECT document FROM for_now.site_ai_budget WHERE id = true FOR UPDATE"
          )).rows[0];
          if (!row) throw invalid("PostgreSQL AI budget singleton is missing");
          const document = structuredClone(row.document);
          const result = await mutator(document);
          if (!document || typeof document !== "object" || Array.isArray(document)) {
            throw new TypeError("AI budget update must preserve an object document");
          }
          await client.query(
            "UPDATE for_now.site_ai_budget SET document = $1::jsonb WHERE id = true",
            [JSON.stringify(document)]
          );
          return result;
        });
      } finally { client.release(); }
    }
  };
  const auth = {
    read: async () => {
      const client = await authPool.connect();
      try { return await transaction(client, () => readAuthDocument(client), true) || { version: 1, users: [], sessions: [] }; }
      finally { client.release(); }
    },
    update: async mutator => {
      const client = await authPool.connect();
      try {
        return await transaction(client, async () => {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('for-now-bundle', 0))");
          const document = await readAuthDocument(client) || { version: 1, users: [], sessions: [] };
          const provisions = [];
          const result = await authContext.run({ provisions }, () => mutator(document));
          await writeAuthDocument(client, document);
          for (const { id, business, documents } of provisions) {
            await client.query("SELECT for_now_auth.provision_account($1, $2::jsonb, $3::jsonb)", [id, JSON.stringify(business), JSON.stringify(documents)]);
          }
          return result;
        });
      } finally { client.release(); }
    },
    provision: (id, store, values) => {
      const current = authContext.getStore();
      if (!current) throw invalid("Provisioning requires a registration transaction");
      current.provisions.push({
        id, business: storeSqlMapping(mapStoreObjects(id, store)),
        documents: Object.entries(values).map(([name, value]) => documentSqlMapping(mapAccountDocument(id, name, value)))
      });
    }
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
    list: () => readAccount(async (client, id) => (await client.query(`
      SELECT path, storage, object_key AS "objectKey", bytes, sha256, state
      FROM for_now.attachment_inventory
      WHERE account_id = $1
      ORDER BY path
    `, [id])).rows),
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
    const client = await authPool.connect();
    try {
      const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended('for-now-application', 0)) AS acquired");
      if (!result.rows[0].acquired) throw invalid("Only one application instance per database is supported by the current scheduler and global quotas");
      applicationClient = client;
      client.on("error", () => { if (applicationClient === client) onLost(); });
    } catch (error) { client.release(true); throw error; }
  };
  const ready = () => Promise.all([
    dataPool.query("SELECT 1"), authPool.query("SELECT 1"),
    ...(applicationClient ? [applicationClient.query("SELECT 1")] : [])
  ]);
  return { createStoreRepository, documents, aiBudget, auth, attachments, ready, claimApplication, close };
}
