import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ATTACHMENT_BACKUP_FORMAT,
  collectBackupAttachmentPaths
} from "../src/shared/attachments/index.mjs";
import { publicCapture } from "../src/modules/captures/index.mjs";
import { publicKeepsake } from "../src/modules/keepsakes/index.mjs";
import { ACCOUNT_DOCUMENT_FILES } from "../src/shared/persistence/index.mjs";
import { safeText } from "../src/shared/validation/index.mjs";

const args = process.argv.slice(2);
const requireRelationalExport = args.includes("--require-relational-export");
const positional = args.filter(value => value !== "--require-relational-export");
if (positional.length !== 1) {
  throw new Error("Usage: node scripts/validate-restored-data.mjs <restored-data-dir> [--require-relational-export]");
}
const root = path.resolve(positional[0]);
const objectValue = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (objectValue(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const digest = value => crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
const bytesDigest = value => crypto.createHash("sha256").update(value).digest("hex");
const restoredPublicCapture = item => {
  const visible = publicCapture(item);
  if (!Object.hasOwn(visible || {}, "transcription")) return visible;
  const transcription = visible.transcription;
  return {
    ...visible,
    transcription: transcription && typeof transcription === "object" && !Array.isArray(transcription)
      ? {
          ...transcription,
          rawText: safeText(transcription.rawText, 120_000),
          polishedText: safeText(transcription.polishedText, 120_000),
          condensedText: safeText(transcription.condensedText, 120_000),
          errorCode: safeText(transcription.errorCode, 120),
          condenseErrorCode: safeText(transcription.condenseErrorCode, 120)
        }
      : null
  };
};

const authFile = path.join(root, "auth.json");
const auth = JSON.parse(await fs.readFile(authFile, "utf8"));
if (!Array.isArray(auth.users) || !auth.users.length) throw new Error("Restored backup has no accounts");
let aiBudget;
try {
  aiBudget = JSON.parse(await fs.readFile(path.join(root, "ai-budget.json"), "utf8"));
} catch {
  throw new Error("Restored backup has no valid AI budget document");
}
if (!objectValue(aiBudget)) throw new Error("Restored backup has no valid AI budget document");
const aiBudgetSha256 = digest(aiBudget);

let exportManifest = null;
try {
  exportManifest = JSON.parse(await fs.readFile(path.join(root, "export-manifest.json"), "utf8"));
} catch (error) {
  if (requireRelationalExport || error?.code !== "ENOENT") {
    throw new Error("Restored backup has no valid relational export manifest");
  }
}
if (exportManifest) {
  if (exportManifest.format !== "for-now-relational-export-v1"
    || !Array.isArray(exportManifest.accounts)
    || exportManifest.aiBudget?.file !== "ai-budget.json"
    || !/^[a-f0-9]{64}$/.test(exportManifest.aiBudget?.sha256 || "")) {
    throw new Error("Restored relational export manifest is invalid");
  }
  if (exportManifest.aiBudget.sha256 !== aiBudgetSha256) {
    throw new Error("Restored relational export AI budget hash does not match");
  }
  const exportAccounts = new Set();
  for (const account of exportManifest.accounts) {
    const accountId = String(account?.accountId || "");
    if (typeof account?.accountId !== "string"
      || !/^[A-Za-z0-9_.-]+$/.test(accountId)
      || exportAccounts.has(accountId)
      || !/^[a-f0-9]{64}$/.test(account.storeSha256 || "")
      || !objectValue(account.documents)
      || !Object.values(account.documents).every(value => /^[a-f0-9]{64}$/.test(value))
      || !Array.isArray(account.attachments)) {
      throw new Error("Restored relational export manifest is invalid");
    }
    exportAccounts.add(accountId);
  }
  if (exportAccounts.size !== auth.users.length
    || auth.users.some(user => !exportAccounts.has(String(user.id || "")))) {
    throw new Error("Restored relational export account set does not match");
  }
}
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

const apiCollections = ["checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books", "keepsakes", "quotes", "experiments", "analyses", "customMetrics", "actions", "habits", "habitCheckins", "feedback", "validationLedger"];
const privateCollections = ["evidenceSources", "evidencePermissions", "perceptionEvents"];
const collections = [...apiCollections, ...privateCollections];
const collectionIdentity = (key, item) => String(
  key === "evidencePermissions" ? item?.sourceKey : item?.id || ""
);
let totalRecords = 0, totalAttachmentReferences = 0, localAttachments = 0, records = 0, firstAttachment = "";
let collectionEvidence = {};
const exportAccounts = new Map((exportManifest?.accounts || []).map(account => [String(account.accountId), account]));
for (const user of auth.users) {
  const userId = String(user.id || "");
  if (!/^[A-Za-z0-9_.-]+$/.test(userId)) throw new Error("Restored account has an invalid ID");
  const manifestAccount = manifestAccounts.get(userId);
  if (!manifestAccount || manifestAccount.userScoped !== true) throw new Error("Restored attachment manifest account set does not match");
  const userDir = path.join(root, "users", userId), store = JSON.parse(await fs.readFile(path.join(userDir, "store.json"), "utf8"));
  const exportAccount = exportAccounts.get(userId);
  if (exportAccount && digest(store) !== exportAccount.storeSha256) {
    throw new Error(`Restored store content does not match the relational export manifest: ${userId}`);
  }
  for (const [document, expectedHash] of Object.entries(exportAccount?.documents || {})) {
    const fileName = ACCOUNT_DOCUMENT_FILES[document];
    if (!fileName) throw new Error("Restored relational export manifest is invalid");
    let value;
    try {
      value = JSON.parse(await fs.readFile(path.join(userDir, fileName), "utf8"));
    } catch {
      throw new Error(`Restored account document is missing or invalid: ${userId}/${document}`);
    }
    if (digest(value) !== expectedHash) {
      throw new Error(`Restored account document does not match the relational export manifest: ${userId}/${document}`);
    }
  }
  for (const key of collections) {
    const values = Array.isArray(store[key])
      ? store[key]
      : Number(store.version || 1) < 17 && privateCollections.includes(key) ? []
        : null;
    if (!values) throw new Error(`Restored store is missing ${key}`);
    totalRecords += values.length;
    if (user.id === auth.users[0].id) {
      const visibleCollection = key === "captures"
        ? values.map(restoredPublicCapture)
        : key === "keepsakes"
          ? values.map(publicKeepsake)
          : values;
      if (apiCollections.includes(key)) records += visibleCollection.length;
      collectionEvidence[key] = {
        count: visibleCollection.length,
        idsSha256: digest(visibleCollection.map(item => collectionIdentity(key, item)).sort()),
        contentSha256: digest(visibleCollection)
      };
    }
  }
  const references = collectBackupAttachmentPaths(store);
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
  aiBudgetSha256,
  relationalExport: Boolean(exportManifest),
  collectionEvidence,
  apiCollectionEvidence: Object.fromEntries(
    apiCollections.map(key => [key, collectionEvidence[key]])
  ),
  attachmentManifest: {
    format: backupManifest.format,
    sourceAttachmentStorage: backupManifest.sourceAttachmentStorage,
    attachments: localAttachments,
    attachmentReferences: totalAttachmentReferences
  },
  sessionToken: token
}));
