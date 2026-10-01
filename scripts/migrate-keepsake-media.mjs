import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKeepsakeMediaMigration } from "../src/app/index.mjs";
import { loadAppConfig } from "../src/config/index.mjs";
import { createImageAttachments, createAttachmentStorage } from "../src/shared/attachments/index.mjs";
import {
  checkPersistenceMarker,
  createJsonStoreRepository,
  createPostgresRuntime,
  hasJsonData
} from "../src/shared/persistence/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
};
const dryRun = args.includes("--dry-run");
const apply = args.includes("--apply");

if (args.includes("--help")) {
  console.log("Usage: npm run migrate:keepsake-media -- --dry-run [--account-id ID] [--keepsake-id ID]");
  console.log("       npm run migrate:keepsake-media -- --apply --expected-plan-sha256 HASH [--account-id ID] [--keepsake-id ID]");
  console.log("Stop the application before applying. Apply keeps the legacy cutout for rollback; it never finalizes deletion.");
  process.exit(0);
}
if (dryRun === apply) throw new Error("Choose exactly one of --dry-run or --apply");

const config = loadAppConfig({ rootDir: ROOT });
if (config.localTestMode || config.upstreamOrigin) {
  throw new Error("Keepsake media migration requires a standalone canonical data source");
}
await checkPersistenceMarker(config.dataDir, config.persistenceBackend);

const selectedAccountId = option("--account-id");
const selectedKeepsakeId = option("--keepsake-id");
const expectedPlanSha256 = option("--expected-plan-sha256");
if (apply && !/^[a-f0-9]{64}$/.test(expectedPlanSha256)) {
  throw new Error("--apply requires a 64-character --expected-plan-sha256");
}

let activeAccountId = "";
let activeContext = null;
let runtime = null;
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const readJson = async file => JSON.parse(await fs.readFile(file, "utf8"));
const writeJsonAtomic = async (file, value) => {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, file);
};

try {
  if (config.persistenceBackend === "postgres") {
    runtime = await createPostgresRuntime({
      connectionString: config.databaseUrl,
      authConnectionString: config.authDatabaseUrl,
      authRequired: config.authRequired,
      getAccountId: () => activeAccountId || (config.authRequired ? null : "local"),
      requireMigration: await hasJsonData(config.dataDir),
      readOnly: dryRun
    });
    if (apply) await runtime.claimApplication(() => process.exit(1));
  }

  let accounts;
  if (config.authRequired) {
    const auth = runtime
      ? await runtime.auth.read()
      : await readJson(path.join(config.dataDir, "auth.json"));
    accounts = (auth.users || []).map(user => ({ id: user.id }));
  } else {
    accounts = [{ id: "local" }];
  }
  if (selectedAccountId) accounts = accounts.filter(account => account.id === selectedAccountId);
  if (!accounts.length) throw new Error(`Account not found: ${selectedAccountId || "(none)"}`);

  const storage = createAttachmentStorage(config.attachments);
  let attachments;
  attachments = createImageAttachments({
    storage,
    getContext: () => activeContext,
    quotaBytes: config.limits.attachmentBytes,
    defaultMaxBytes: 24 * 1024 * 1024,
    inventory: runtime?.attachments,
    cleanFailedUploads: paths => Promise.all(paths.map(resourcePath => attachments.remove(resourcePath))),
    onCleanupDeferred: error => { throw error; }
  });

  const planned = [];
  for (const account of accounts.sort((left, right) => left.id.localeCompare(right.id))) {
    activeAccountId = account.id;
    const accountDataDir = config.authRequired
      ? path.join(config.dataDir, "users", account.id)
      : config.dataDir;
    activeContext = {
      ownerId: account.id,
      dataDir: accountDataDir,
      attachmentsDir: path.join(accountDataDir, "attachments")
    };
    const repository = runtime
      ? runtime.createStoreRepository({
          normalize: value => value,
          emptyDocument: { version: 15, keepsakes: [], trash: [], attachmentCleanup: [] },
          getContext: () => ({ operationId: "keepsake-media-migration" })
        })
      : createJsonStoreRepository({
          getFile: () => path.join(accountDataDir, "store.json"),
          readDocument: readJson,
          writeDocument: writeJsonAtomic,
          normalize: value => value,
          emptyDocument: { version: 15, keepsakes: [], trash: [], attachmentCleanup: [] },
          getContext: () => ({ operationId: "keepsake-media-migration" })
        });
    const migration = createKeepsakeMediaMigration({
      repository,
      attachments,
      accountId: account.id
    });
    const plan = await migration.plan({
      ...(selectedKeepsakeId ? { keepsakeIds: [selectedKeepsakeId] } : {}),
      requirePrimaryStorage: config.attachments.mode !== "local"
    });
    planned.push({ migration, plan });
  }

  const aggregatePlanSha256 = sha256(JSON.stringify(planned.map(({ plan }) => ({
    accountId: plan.accountId,
    planSha256: plan.planSha256
  }))));
  const planSummary = {
    mode: dryRun ? "dry-run" : "apply",
    persistence: config.persistenceBackend,
    attachmentStorage: config.attachments.mode,
    planSha256: aggregatePlanSha256,
    accounts: planned.map(({ plan }) => plan)
  };

  if (dryRun) {
    console.log(JSON.stringify(planSummary, null, 2));
    if (planned.some(({ plan }) => plan.summary.blocked)) process.exitCode = 2;
  } else {
    if (expectedPlanSha256 !== aggregatePlanSha256) {
      throw Object.assign(new Error("Aggregate migration plan hash does not match the reviewed dry-run"), {
        code: "MIGRATION_PLAN_MISMATCH"
      });
    }
    if (planned.some(({ plan }) => plan.summary.blocked)) {
      throw Object.assign(new Error("Migration plan contains blocked keepsakes"), {
        code: "MIGRATION_PLAN_BLOCKED"
      });
    }
    const results = [];
    for (const entry of planned) {
      activeAccountId = entry.plan.accountId;
      activeContext = {
        ownerId: entry.plan.accountId,
        dataDir: config.authRequired
          ? path.join(config.dataDir, "users", entry.plan.accountId)
          : config.dataDir,
        attachmentsDir: path.join(
          config.authRequired ? path.join(config.dataDir, "users", entry.plan.accountId) : config.dataDir,
          "attachments"
        )
      };
      await attachments.prepareDirectory();
      results.push(await entry.migration.apply(entry.plan, {
        expectedPlanSha256: entry.plan.planSha256
      }));
    }
    console.log(JSON.stringify({ ...planSummary, results }, null, 2));
    if (results.some(result => result.summary.conflicted || result.summary.failed)) process.exitCode = 2;
  }
} finally {
  await runtime?.close();
}
