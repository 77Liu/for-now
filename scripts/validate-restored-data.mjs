import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ATTACHMENT_BACKUP_FORMAT } from "../src/shared/attachments/index.mjs";

const root = path.resolve(process.argv[2] || "");
if (!root) throw new Error("Usage: node scripts/validate-restored-data.mjs <restored-data-dir>");
const authFile = path.join(root, "auth.json");
const auth = JSON.parse(await fs.readFile(authFile, "utf8"));
if (!Array.isArray(auth.users) || !auth.users.length) throw new Error("Restored backup has no accounts");
let backupManifest;
try {
  backupManifest = JSON.parse(await fs.readFile(path.join(root, "backup-manifest.json"), "utf8"));
} catch {
  throw new Error("Restored backup has no valid attachment manifest");
}
if (backupManifest?.format !== ATTACHMENT_BACKUP_FORMAT || backupManifest.complete !== true || !Array.isArray(backupManifest.accounts)) {
  throw new Error("Restored backup has no complete attachment manifest");
}
const manifestAccounts = new Map();
for (const account of backupManifest.accounts) {
  const accountId = String(account?.accountId || "");
  if (!/^[A-Za-z0-9_.-]+$/.test(accountId) || manifestAccounts.has(accountId)
    || !Array.isArray(account.references) || !Array.isArray(account.attachments)) {
    throw new Error("Restored attachment manifest is invalid");
  }
  manifestAccounts.set(accountId, account);
}
if (manifestAccounts.size !== auth.users.length) throw new Error("Restored attachment manifest account set does not match");

const collections = ["checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books", "keepsakes", "quotes", "experiments", "analyses", "customMetrics", "actions", "habits", "habitCheckins", "feedback", "validationLedger"];
const objectValue = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (objectValue(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const digest = value => crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
const bytesDigest = value => crypto.createHash("sha256").update(value).digest("hex");
let totalRecords = 0, totalAttachmentReferences = 0, localAttachments = 0, records = 0, firstAttachment = "";
let collectionEvidence = {};
for (const user of auth.users) {
  const userId = String(user.id || "");
  if (!/^[A-Za-z0-9_.-]+$/.test(userId)) throw new Error("Restored account has an invalid ID");
  const manifestAccount = manifestAccounts.get(userId);
  if (!manifestAccount || manifestAccount.userScoped !== true) throw new Error("Restored attachment manifest account set does not match");
  const userDir = path.join(root, "users", userId), store = JSON.parse(await fs.readFile(path.join(userDir, "store.json"), "utf8"));
  for (const key of collections) {
    if (!Array.isArray(store[key])) throw new Error(`Restored store is missing ${key}`);
    totalRecords += store[key].length;
    if (user.id === auth.users[0].id) {
      records += store[key].length;
      collectionEvidence[key] = {
        count: store[key].length,
        idsSha256: digest(store[key].map(item => String(item?.id || "")).sort()),
        contentSha256: digest(store[key])
      };
    }
  }
  const references = new Set();
  const scan = (value, key = "") => {
    if (key === "attachmentCleanup") return;
    if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === "object") Object.entries(value).forEach(([childKey, child]) => scan(child, childKey));
    else if (typeof value === "string" && value.startsWith("/attachments/")) references.add(value);
  };
  scan(store);
  const expectedReferences = [...references].sort();
  if (canonicalJson(expectedReferences) !== canonicalJson([...manifestAccount.references].sort())) {
    throw new Error("Restored attachment references do not match the backup manifest");
  }
  totalAttachmentReferences += references.size;
  const attachments = new Map();
  for (const item of manifestAccount.attachments) {
    const name = String(item?.path || "").slice("/attachments/".length);
    if (!/^[\w.-]+$/.test(name) || attachments.has(item.path)
      || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || !/^[a-f0-9]{64}$/.test(item.sha256 || "")) {
      throw new Error("Restored attachment manifest entry is invalid");
    }
    attachments.set(item.path, item);
    const file = path.join(userDir, "attachments", name);
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`Restored attachment is missing: ${item.path}`);
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Restored attachment is not a regular file: ${item.path}`);
    const data = await fs.readFile(file);
    if (data.length !== item.bytes || bytesDigest(data) !== item.sha256) {
      throw new Error(`Restored attachment content does not match the backup manifest: ${item.path}`);
    }
    localAttachments += 1;
  }
  const actualNames = (await fs.readdir(path.join(userDir, "attachments"), { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).filter(entry => entry.isFile()).map(entry => entry.name).sort();
  const manifestNames = [...attachments.keys()].map(reference => reference.slice("/attachments/".length)).sort();
  if (canonicalJson(actualNames) !== canonicalJson(manifestNames)) {
    throw new Error("Restored attachment directory does not match the backup manifest");
  }
  for (const reference of expectedReferences) {
    const name = reference.slice("/attachments/".length);
    if (!/^[\w.-]+$/.test(name)) throw new Error("Restored store has an invalid attachment path");
    if (!attachments.has(reference)) throw new Error(`Restored attachment is missing: ${reference}`);
    if (!firstAttachment && user.id === auth.users[0].id) {
      firstAttachment = reference;
    }
  }
}

const token = crypto.randomBytes(24).toString("base64url"), user = auth.users[0];
auth.sessions = Array.isArray(auth.sessions) ? auth.sessions : [];
auth.sessions.push({
  tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
  userId: user.id,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString()
});
await fs.writeFile(authFile, `${JSON.stringify(auth)}\n`, { mode: 0o600 });
await fs.chmod(authFile, 0o600);
console.log(JSON.stringify({
  users: auth.users.length,
  records,
  totalRecords,
  attachmentReferences: totalAttachmentReferences,
  localAttachments,
  firstAttachment,
  firstUserId: user.id,
  collectionEvidence,
  attachmentManifest: {
    format: backupManifest.format,
    sourceAttachmentStorage: backupManifest.sourceAttachmentStorage,
    attachments: localAttachments,
    attachmentReferences: totalAttachmentReferences
  },
  sessionToken: token
}));
