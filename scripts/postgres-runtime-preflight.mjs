import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "../src/config/index.mjs";
import { createPostgresRuntime, hasJsonData } from "../src/shared/persistence/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = loadAppConfig({ rootDir: ROOT });

if (config.persistenceBackend !== "postgres") {
  process.stdout.write("PostgreSQL runtime preflight skipped: persistence backend is not postgres.\n");
  process.exit(0);
}

let runtime;
try {
  runtime = await createPostgresRuntime({
    connectionString: config.databaseUrl,
    authConnectionString: config.authDatabaseUrl,
    budgetConnectionString: config.aiBudgetDatabaseUrl,
    getAccountId: () => "preflight",
    requireMigration: await hasJsonData(config.dataDir),
    authRequired: config.authRequired,
    readOnly: true
  });
  await runtime.ready();
  process.stdout.write("PostgreSQL runtime preflight passed: data, auth and AI budget roles are compatible.\n");
} finally {
  await runtime?.close();
}
