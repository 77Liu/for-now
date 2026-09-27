import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || "");
if (!root) throw new Error("Usage: node scripts/validate-restored-data.mjs <restored-data-dir>");
const authFile = path.join(root, "auth.json");
const auth = JSON.parse(await fs.readFile(authFile, "utf8"));
if (!Array.isArray(auth.users) || !auth.users.length) throw new Error("Restored backup has no accounts");

const collections = ["checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books", "keepsakes", "quotes", "experiments", "analyses", "customMetrics"];
let totalRecords = 0, totalAttachmentReferences = 0, localAttachments = 0, records = 0, firstAttachment = "";
for (const user of auth.users) {
  const userId = String(user.id || "");
  if (!/^[A-Za-z0-9_.-]+$/.test(userId)) throw new Error("Restored account has an invalid ID");
  const userDir = path.join(root, "users", userId), store = JSON.parse(await fs.readFile(path.join(userDir, "store.json"), "utf8"));
  for (const key of collections) {
    if (!Array.isArray(store[key])) throw new Error(`Restored store is missing ${key}`);
    totalRecords += store[key].length;
    if (user.id === auth.users[0].id) records += store[key].length;
  }
  const references = new Set();
  const scan = value => {
    if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === "object") Object.values(value).forEach(scan);
    else if (typeof value === "string" && value.startsWith("/attachments/")) references.add(value);
  };
  scan(store);
  totalAttachmentReferences += references.size;
  for (const reference of references) {
    const name = reference.slice("/attachments/".length);
    if (!/^[\w.-]+$/.test(name)) throw new Error("Restored store has an invalid attachment path");
    try {
      if ((await fs.stat(path.join(userDir, "attachments", name))).isFile()) localAttachments += 1;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
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
  sessionToken: token
}));
