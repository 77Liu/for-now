import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const ATTACHMENT_BACKUP_FORMAT = "for-now-attachment-complete-backup-v1";

const digest = data => crypto.createHash("sha256").update(data).digest("hex");
const attachmentName = resourcePath => {
  const match = /^\/attachments\/([\w.-]+)$/.exec(String(resourcePath || ""));
  return match?.[1] || "";
};

function collectReferences(value, output = new Set(), key = "") {
  if (key === "attachmentCleanup") return output;
  if (typeof value === "string") {
    if (attachmentName(value)) output.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, output);
  } else if (value && typeof value === "object") {
    for (const [childKey, item] of Object.entries(value)) collectReferences(item, output, childKey);
  }
  return output;
}

async function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw new Error(`Invalid ${label}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

async function accountsIn(sourceDir) {
  try {
    const auth = await readJson(path.join(sourceDir, "auth.json"), "backup auth document");
    if (!Array.isArray(auth.users) || !auth.users.length) throw new Error("Backup source has no accounts");
    return auth.users.map(user => {
      const accountId = String(user?.id || "");
      if (!/^[A-Za-z0-9_.-]+$/.test(accountId)) throw new Error("Backup source has an invalid account ID");
      return { accountId, userScoped: true, directory: path.join(sourceDir, "users", accountId) };
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await fs.access(path.join(sourceDir, "store.json"));
    return [{ accountId: "local", userScoped: false, directory: sourceDir }];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error("Backup source has no account store");
  }
}

async function secureTree(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  await fs.chmod(root, 0o700);
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Backup data must not contain symbolic links");
    if (entry.isDirectory()) await secureTree(target);
    else if (entry.isFile()) await fs.chmod(target, 0o600);
  }
}

export async function stageAttachmentCompleteBackup({
  sourceDir,
  outputDir,
  storage,
  sourceAttachmentStorage = storage?.mode || "local",
  now = () => new Date().toISOString()
}) {
  if (!storage?.get || !storage?.list) throw new TypeError("Attachment storage with get/list is required");
  const source = path.resolve(sourceDir), output = path.resolve(outputDir);
  if (output === source || output.startsWith(`${source}${path.sep}`)) {
    throw new Error("Backup output must be outside the source data directory");
  }
  try {
    await fs.access(output);
    throw new Error("Backup output directory already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const stage = `${output}.partial-${crypto.randomUUID()}`;
  try {
    await fs.cp(source, stage, { recursive: true, force: false, errorOnExist: true });
    const accounts = await accountsIn(source);
    const manifestAccounts = [];
    for (const account of accounts) {
      const store = await readJson(path.join(account.directory, "store.json"), `store for ${account.accountId}`);
      const references = [...collectReferences(store)].sort();
      const sourceAttachments = path.join(account.directory, "attachments");
      const targetDirectory = account.userScoped
        ? path.join(stage, "users", account.accountId, "attachments")
        : path.join(stage, "attachments");
      if (storage.mode !== "local") await fs.rm(targetDirectory, { recursive: true, force: true });
      await fs.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      const listed = await storage.list({ ownerId: account.accountId, localDir: sourceAttachments });
      const byName = new Map();
      for (const item of listed) {
        if (!/^[\w.-]+$/.test(item.name) || byName.has(item.name)) {
          throw new Error("Attachment storage returned an invalid or duplicate object");
        }
        byName.set(item.name, item);
      }
      for (const resourcePath of references) {
        if (!byName.has(attachmentName(resourcePath))) {
          throw new Error(`Referenced attachment is missing from primary storage: ${resourcePath}`);
        }
      }
      const attachments = [];
      for (const item of [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))) {
        const localFile = path.join(sourceAttachments, item.name);
        const data = await storage.get({
          ownerId: account.accountId,
          name: item.name,
          localFile,
          allowLocalFallback: false
        });
        if (!Buffer.isBuffer(data) || !data.length || (Number.isFinite(item.bytes) && item.bytes !== data.length)) {
          throw new Error(`Attachment content does not match primary storage listing: ${item.name}`);
        }
        await fs.writeFile(path.join(targetDirectory, item.name), data, { mode: 0o600 });
        const resourcePath = `/attachments/${item.name}`;
        attachments.push({
          path: resourcePath,
          bytes: data.length,
          sha256: digest(data),
          referenced: references.includes(resourcePath),
          objectKey: String(item.objectKey || item.name)
        });
      }
      manifestAccounts.push({
        accountId: account.accountId,
        userScoped: account.userScoped,
        references,
        attachments
      });
    }
    const summary = {
      accounts: manifestAccounts.length,
      attachments: manifestAccounts.reduce((sum, account) => sum + account.attachments.length, 0),
      attachmentReferences: manifestAccounts.reduce((sum, account) => sum + account.references.length, 0)
    };
    const manifest = {
      format: ATTACHMENT_BACKUP_FORMAT,
      createdAt: now(),
      sourceAttachmentStorage,
      complete: true,
      accounts: manifestAccounts,
      summary
    };
    await fs.writeFile(path.join(stage, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await secureTree(stage);
    await fs.rename(stage, output);
    return manifest;
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}
