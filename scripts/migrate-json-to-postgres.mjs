import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverJsonStores,
  discoverJsonBundle,
  applyPostgresBundle,
  initializePostgresSchema,
  migrateJsonStoresToPostgres,
  storeContentSha256
} from "../src/shared/persistence/index.mjs";
import { createAttachmentStorage } from "../src/shared/attachments/index.mjs";
import { loadAttachmentConfig } from "../src/config/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
};
const dryRun = args.includes("--dry-run");
const dataDir = path.resolve(option("--data-dir") || process.env.DATA_DIR || path.join(ROOT, "data"));
const accountId = option("--account-id");
const initSchema = args.includes("--init-schema");
const storeOnly = args.includes("--store-only");

if (args.includes("--help")) {
  console.log("Usage: npm run migrate:postgres -- [--dry-run | --init-schema] [--data-dir PATH] [--expected-target-sha256 HASH] [--store-only --account-id ID] [--allow-remote-attachments]");
  console.log("Schema initialization uses PG_SCHEMA_DATABASE_URL; imports use a non-owner DATABASE_URL. This command does not switch the application write source.");
  process.exit(0);
}

if (dryRun && initSchema) throw new Error("--dry-run and --init-schema are mutually exclusive");
if (accountId && !storeOnly) throw new Error("Full bundles include all identities; --account-id requires --store-only");
if (initSchema) {
  if (!process.env.PG_SCHEMA_DATABASE_URL) throw new Error("PG_SCHEMA_DATABASE_URL is required");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.PG_SCHEMA_DATABASE_URL });
  await client.connect();
  try {
    await initializePostgresSchema(client);
    console.log(JSON.stringify({ mode: "schema-initialized" }));
  } finally {
    await client.end();
  }
} else if (!storeOnly) {
  const attachmentConfig = loadAttachmentConfig();
  if (attachmentConfig.mode === "oss" && !args.includes("--allow-remote-attachments")) {
    throw new Error("OSS verification requires explicit --allow-remote-attachments");
  }
  const storage = createAttachmentStorage(attachmentConfig);
  const bundle = await discoverJsonBundle(dataDir, { inspectAttachment: storage.inspect });
  if (dryRun) {
    console.log(JSON.stringify({
      mode: "bundle-dry-run", sourceSha256: bundle.sourceSha256, contentSha256: bundle.contentSha256,
      aiBudget: {
        sourcePresent: Boolean(bundle.sources.find(item => path.basename(item.file) === "ai-budget.json")?.sha256),
        contentSha256: storeContentSha256(bundle.aiBudget)
      },
      identities: bundle.auth?.users.length || 0, sessions: bundle.auth?.sessions.length || 0,
      accounts: bundle.accounts.map(({ plan, documents, inventory }) => ({
        accountId: plan.accountId, counts: plan.sourceCounts, documents: Object.keys(documents),
        attachments: inventory.length, bytes: inventory.reduce((sum, item) => sum + (item.bytes || 0), 0)
      }))
    }, null, 2));
  } else {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      console.log(JSON.stringify({ mode: "bundle-applied", ...await applyPostgresBundle(client, bundle, {
        expectedTargetSha256: option("--expected-target-sha256"), inspectAttachment: storage.inspect
      }) }, null, 2));
    } finally { await client.end(); }
  }
} else if (dryRun) {
  const plans = await discoverJsonStores(dataDir, accountId);
  console.log(JSON.stringify({
    mode: "dry-run",
    dataDir,
    accounts: plans.map(plan => ({
      accountId: plan.accountId,
      sourceVersion: plan.sourceVersion,
      sourceSha256: plan.sourceSha256,
      contentSha256: plan.contentSha256,
      counts: plan.sourceCounts
    }))
  }, null, 2));
} else {
  const results = await migrateJsonStoresToPostgres({
    dataDir,
    accountId,
    expectedTargetSha256: option("--expected-target-sha256"),
    connectionString: process.env.DATABASE_URL
  });
  console.log(JSON.stringify({
    mode: "applied",
    accounts: results
  }, null, 2));
}
