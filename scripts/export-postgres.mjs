import path from "node:path";
import pg from "pg";
import { createAttachmentStorage } from "../src/shared/attachments/index.mjs";
import { exportPostgresDirectory } from "../src/shared/persistence/index.mjs";
import { loadAttachmentConfig } from "../src/config/index.mjs";

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index++) {
  const key = args[index];
  if (key === "--allow-remote-attachments") options.remote = true;
  else if (["--data-dir", "--output-dir"].includes(key) && args[index + 1] && !args[index + 1].startsWith("--")) options[key] = args[++index];
  else throw new Error("Usage: export-postgres --data-dir PATH --output-dir NEW_PATH [--allow-remote-attachments]");
}
if (!options["--data-dir"] || !options["--output-dir"] || !process.env.PG_BACKUP_DATABASE_URL) {
  throw new Error("Explicit --data-dir, --output-dir and PG_BACKUP_DATABASE_URL are required");
}
const attachmentConfig = loadAttachmentConfig();
if (attachmentConfig.mode === "oss" && !options.remote) throw new Error("OSS reads require --allow-remote-attachments");
const dataDir = path.resolve(options["--data-dir"]);
const storage = createAttachmentStorage(attachmentConfig);
const client = new pg.Client({ connectionString: process.env.PG_BACKUP_DATABASE_URL });
try {
  await client.connect();
  const result = await exportPostgresDirectory(client, {
    outputDir: options["--output-dir"],
    readAttachment: ({ accountId, userScoped, item }) => {
      const name = path.basename(item.path);
      const directory = userScoped ? path.join(dataDir, "users", accountId) : dataDir;
      return storage.get({ ownerId: accountId, name, localFile: path.join(directory, "attachments", name) });
    }
  });
  console.log(JSON.stringify({ status: "exported", ...result }));
} catch {
  // Connection errors may embed user/host details; never print credentials or documents.
  console.error("PostgreSQL export failed; verify application stop, recovery role, target directory and attachment integrity.");
  process.exitCode = 1;
} finally { await client.end(); }
