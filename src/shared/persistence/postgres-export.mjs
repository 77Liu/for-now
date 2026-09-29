import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ACCOUNT_DOCUMENT_FILES } from "./document-mapping.mjs";
import { readAuthDocument } from "./postgres-documents.mjs";
import { readPostgresBundle } from "./postgres-bundle.mjs";
import { storeContentSha256 } from "./store-mapping.mjs";

// The recovery role has read-only privileges in both schemas. It must still be
// non-owner/NOBYPASSRLS; each tenant is read with explicit transaction context.
export async function exportPostgresDirectory(client, { outputDir, readAttachment }) {
  const output = path.resolve(outputDir);
  let stage, locked = false;
  try {
    const role = (await client.query(`
      SELECT rolsuper, rolbypassrls, EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('for_now','for_now_auth') AND c.relkind = 'r' AND pg_has_role(current_user,c.relowner,'USAGE')
      ) AS owns FROM pg_roles WHERE rolname = current_user
    `)).rows[0];
    if (role.rolsuper || role.rolbypassrls || role.owns) throw new Error("Export requires a non-owner/NOBYPASSRLS recovery role");
    locked = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('for-now-application',0)) AS locked")).rows[0].locked;
    if (!locked) throw new Error("Stop the application before exporting relational data and attachments together");
    try { await fs.access(output); throw new Error("Export output directory already exists"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    stage = await fs.mkdtemp(`${output}.partial-`);
    await fs.chmod(stage, 0o700);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const auth = await readAuthDocument(client);
    const ids = auth?.users.length ? auth.users.map(user => user.id) : ["local"];
    const bundle = await readPostgresBundle(client, ids);
    const write = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    if (bundle.auth) await write(path.join(stage, "auth.json"), bundle.auth);
    for (const account of bundle.accounts) {
      await client.query("SELECT set_config('app.account_id', $1, true)", [account.accountId]);
      const directory = auth?.users.length ? path.join(stage, "users", account.accountId) : stage;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await write(path.join(directory, "store.json"), account.store);
      for (const [document, value] of Object.entries(account.documents)) {
        await write(path.join(directory, ACCOUNT_DOCUMENT_FILES[document]), value);
      }
      const references = new Set();
      // Active references without inventory must never become a "good" backup.
      for (const row of (await client.query(
        "SELECT DISTINCT path FROM for_now.store_attachment_refs WHERE account_id = $1 AND field_name <> 'attachmentCleanup'",
        [account.accountId]
      )).rows) references.add(row.path);
      for (const item of account.inventory) {
        if (item.state === "missing_cleanup" && references.has(item.path)) throw new Error("An active attachment is missing");
        references.delete(item.path);
        if (item.state === "missing_cleanup") continue;
        if (item.state !== "verified") throw new Error("Unfinished attachment upload; recover the application before export");
        const bytes = await readAttachment({ accountId: account.accountId, userScoped: Boolean(auth?.users.length), item });
        if (bytes.length !== item.bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== item.sha256) {
          throw new Error("Attachment content does not match the inventory");
        }
        const attachmentDir = path.join(directory, "attachments");
        await fs.mkdir(attachmentDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(attachmentDir, path.basename(item.path)), bytes, { mode: 0o600 });
      }
      if (references.size) throw new Error("Referenced attachment is missing from the inventory");
    }
    const evidence = {
      format: "for-now-relational-export-v1", createdAt: new Date().toISOString(),
      accounts: bundle.accounts.map(row => ({
        accountId: row.accountId, storeSha256: storeContentSha256(row.store),
        documents: Object.fromEntries(Object.entries(row.documents).map(([name, value]) => [name, storeContentSha256(value)])),
        attachments: row.inventory
      }))
    };
    await write(path.join(stage, "export-manifest.json"), evidence);
    await client.query("COMMIT");
    await fs.rename(stage, output);
    stage = null;
    return { accounts: ids.length, outputDir: output };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true });
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('for-now-application',0))").catch(() => {});
  }
}
