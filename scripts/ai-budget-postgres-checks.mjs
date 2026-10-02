import assert from "node:assert/strict";
import { AI_BUDGET_POLICY, createAiBudgetService } from "../src/modules/ai/index.mjs";
import {
  createAiBudgetRepository,
  createPostgresRuntime
} from "../src/shared/persistence/index.mjs";

const roleName = value => {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new TypeError("Unsafe PostgreSQL test role name");
  }
  return value;
};

export async function runAiBudgetPostgresChecks({
  admin,
  connect,
  database,
  dataRole: configuredDataRole,
  authRole: configuredAuthRole,
  budgetRole: configuredBudgetRole,
  runtime,
  peer,
  runtimeOptions,
  runWithAccount = (_accountId, operation) => operation()
}) {
  const dataRole = roleName(configuredDataRole);
  const authRole = roleName(configuredAuthRole);
  const budgetRole = roleName(configuredBudgetRole);
  const policy = {
    ...AI_BUDGET_POLICY,
    userDailyKnownCostCny: 1000,
    userDailyCalls: 1000
  };
  const service = (repository, prefix) => {
    let sequence = 0;
    return createAiBudgetService({
      repository,
      policy,
      now: () => "2026-10-02T01:00:00.000Z",
      createId: () => `${prefix}-${++sequence}`
    });
  };

  const privileges = (await admin.query(`
    SELECT
      has_table_privilege($1, 'for_now.site_ai_budget', 'SELECT') AS "select",
      has_table_privilege($1, 'for_now.site_ai_budget', 'UPDATE') AS "update",
      has_table_privilege($2, 'for_now.site_ai_budget', 'SELECT') AS "authSelect",
      has_table_privilege($2, 'for_now.site_ai_budget', 'UPDATE') AS "authUpdate",
      has_table_privilege($3, 'for_now.site_ai_budget', 'SELECT') AS "budgetSelect",
      has_table_privilege($3, 'for_now.site_ai_budget', 'UPDATE') AS "budgetUpdate",
      has_table_privilege($3, 'for_now.site_ai_budget', 'INSERT') AS "budgetInsert",
      has_table_privilege($3, 'for_now.site_ai_budget', 'DELETE') AS "budgetDelete",
      has_table_privilege($3, 'for_now.site_ai_budget', 'TRUNCATE') AS "budgetTruncate"
  `, [dataRole, authRole, budgetRole])).rows[0];
  assert.deepEqual(privileges, {
    select: false,
    update: false,
    authSelect: false,
    authUpdate: false,
    budgetSelect: true,
    budgetUpdate: true,
    budgetInsert: false,
    budgetDelete: false,
    budgetTruncate: false
  });

  const dataClient = await connect(dataRole, database);
  const authClient = await connect(authRole, database);
  const budgetClient = await connect(budgetRole, database);
  await assert.rejects(
    dataClient.query("SELECT document FROM for_now.site_ai_budget"),
    error => error.code === "42501"
  );
  await assert.rejects(
    dataClient.query("UPDATE for_now.site_ai_budget SET document = '{}'::jsonb"),
    error => error.code === "42501"
  );
  await assert.rejects(
    authClient.query("SELECT document FROM for_now.site_ai_budget"),
    error => error.code === "42501"
  );
  await assert.rejects(
    authClient.query("UPDATE for_now.site_ai_budget SET document = '{}'::jsonb"),
    error => error.code === "42501"
  );
  assert.deepEqual((await budgetClient.query(
    "SELECT document FROM for_now.site_ai_budget WHERE id = true"
  )).rows[0].document, {});
  assert.equal((await budgetClient.query(
    "UPDATE for_now.site_ai_budget SET document = '{}'::jsonb WHERE id = true"
  )).rowCount, 1);

  await admin.query(`GRANT SELECT ON for_now.site_ai_budget TO ${dataRole}`);
  await assert.rejects(
    createPostgresRuntime(runtimeOptions),
    /data\/auth runtime roles must not access for_now\.site_ai_budget/
  );
  await admin.query(`REVOKE SELECT ON for_now.site_ai_budget FROM ${dataRole}`);
  await admin.query(`GRANT SELECT ON for_now.accounts TO ${budgetRole}`);
  await assert.rejects(
    createPostgresRuntime(runtimeOptions),
    /AI budget runtime role requires SELECT and UPDATE only/
  );
  await admin.query(`REVOKE SELECT ON for_now.accounts FROM ${budgetRole}`);

  const firstRepository = createAiBudgetRepository({ runtime });
  const secondRepository = createAiBudgetRepository({ runtime: peer });
  const firstService = service(firstRepository, "postgres-first");
  const secondService = service(secondRepository, "postgres-second");
  const reservations = await Promise.allSettled([
    firstService.reserveTask({
      accountId: "budget-account-a",
      taskId: "budget-task-a",
      stages: [{
        id: "model-a",
        provider: "deepseek",
        service: "chat-completions",
        scene: "thoughtAnswer",
        costKnown: true,
        estimatedCostCny: 60
      }]
    }),
    secondService.reserveTask({
      accountId: "budget-account-b",
      taskId: "budget-task-b",
      stages: [{
        id: "model-b",
        provider: "deepseek",
        service: "chat-completions",
        scene: "thoughtAnswer",
        costKnown: true,
        estimatedCostCny: 60
      }]
    })
  ]);
  assert.equal(reservations.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(
    reservations.find(item => item.status === "rejected").reason.code,
    "AI_SITE_DAILY_COST_LIMIT"
  );
  assert.deepEqual(
    await runWithAccount("budget-account-a", () => firstRepository.read()),
    await runWithAccount("budget-account-b", () => secondRepository.read())
  );

  const beforeRollback = await firstRepository.read();
  await admin.query(`
    CREATE FUNCTION for_now.reject_ai_budget_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.document ? 'databaseFailureProbe' THEN
        RAISE EXCEPTION 'injected AI budget update failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_ai_budget_update BEFORE UPDATE ON for_now.site_ai_budget
    FOR EACH ROW EXECUTE FUNCTION for_now.reject_ai_budget_update()
  `);
  try {
    await assert.rejects(firstRepository.update(document => {
      document.databaseFailureProbe = true;
    }), /injected AI budget update failure/);
  } finally {
    await admin.query("DROP TRIGGER reject_ai_budget_update ON for_now.site_ai_budget");
    await admin.query("DROP FUNCTION for_now.reject_ai_budget_update()");
  }
  assert.deepEqual(await firstRepository.read(), beforeRollback);
  await assert.rejects(firstRepository.update(document => {
    document.mutatorFailureProbe = true;
    throw new Error("abort PostgreSQL budget mutation");
  }), /abort PostgreSQL budget mutation/);
  assert.deepEqual(await firstRepository.read(), beforeRollback);
  await admin.query("UPDATE for_now.site_ai_budget SET document = '{}'::jsonb WHERE id = true");

  return [
    "isolated AI budget role and denied data/auth direct access",
    "global AI budget cross-account concurrency",
    "global AI budget database and mutator rollback"
  ];
}
