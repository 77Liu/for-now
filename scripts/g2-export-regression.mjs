import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import {
  buildExportManifest,
  createAccountExport,
  createExportDocument,
  createExportManifest,
  stableExportJson
} from "../src/modules/exports/index.mjs";
import {
  createDownloadDescriptor,
  createDownloadDescriptors
} from "../public/frontend/features/export/index.mjs";
import { createExportHttp } from "../src/http/index.mjs";

const snapshot = {
  accountId: "account/42",
  snapshotAt: "2026-09-29T08:09:10.000Z",
  store: {
    version: 14,
    captures: [
      {
        id: "capture-b",
        version: 3,
        createdAt: "2026-09-28T02:00:00.000Z",
        occurredAt: "2026-09-28T01:00:00.000Z",
        occurredOn: "2026-09-28",
        content: "带两张图片的捕念",
        attachmentPaths: ["/attachments/shared.png", "/attachments/missing.png"],
        reasoningContent: "PRIVATE_REASONING",
        apiKey: "PRIVATE_API_KEY",
        nested: { chain_of_thought: "PRIVATE_CHAIN", password: "PRIVATE_PASSWORD" }
      },
      {
        id: "capture-a",
        version: 1,
        occurredAt: "2026-09-27T01:00:00.000Z",
        content: "用于验证排序"
      }
    ],
    dailyRecords: [{
      id: "daily-image-only",
      type: "weight",
      version: 4,
      occurredAt: "2026-09-28T03:00:00.000Z",
      attachmentPaths: ["/attachments/shared.png"]
    }],
    books: [{
      id: "book-1",
      version: 2,
      createdAt: "2026-09-28T04:00:00.000Z",
      title: "有封面的书",
      imagePath: "/attachments/shared.png"
    }],
    keepsakes: [{
      id: "keepsake-1",
      version: 5,
      occurredAt: "2026-09-28T05:00:00.000Z",
      title: "票券",
      originalPath: "/attachments/original.png",
      cutoutPath: "/attachments/cutout.png"
    }],
    thoughts: [{
      id: "thought-image-only",
      version: 2,
      occurredAt: "2026-09-28T05:30:00.000Z",
      type: "record",
      attachmentPaths: ["/attachments/shared.png"],
      annotations: [{
        id: "comment-image-only",
        attachmentPaths: ["/attachments/missing.png"]
      }]
    }],
    chats: [{
      id: "chat-1",
      createdAt: "2026-09-28T06:00:00.000Z",
      message: "用户提问",
      answer: "模型回答",
      reasoning: "PRIVATE_CHAT_REASONING",
      credentials: "PRIVATE_CREDENTIAL"
    }],
    onboarding: {
      updatedAt: "2026-09-28T07:00:00.000Z",
      material: "用户主动填写的资料",
      accessToken: "PRIVATE_ACCESS_TOKEN"
    },
    aiTasks: [{ id: "task-private", payload: { password: "MUST_NOT_EXPORT" } }],
    notifications: [{ id: "notification-private" }]
  },
  inventory: [
    { path: "/attachments/shared.png", storage: "local", objectKey: "shared.png", bytes: 30, sha256: "a".repeat(64), state: "verified" },
    { path: "/attachments/original.png", storage: "local", objectKey: "original.png", bytes: 10, sha256: "b".repeat(64), state: "verified" },
    { path: "/attachments/cutout.png", storage: "local", objectKey: "cutout.png", bytes: 20, sha256: "c".repeat(64), state: "verified" },
    { path: "/attachments/unreferenced.png", storage: "local", objectKey: "unreferenced.png", bytes: 40, sha256: "d".repeat(64), state: "verified" }
  ]
};
const original = structuredClone(snapshot);
const manifest = buildExportManifest(snapshot);

assert.deepEqual(snapshot, original, "export construction must not mutate the injected snapshot");
assert.deepEqual(createExportManifest(snapshot), manifest);
assert.equal(manifest.format, "for-now-cross-genre-export-v1");
assert.equal(manifest.accountId, "account/42");
assert.equal(manifest.snapshotVersion, 14);
assert.equal(manifest.summary.resources, 8);
assert.equal(manifest.summary.attachments, 5);
assert.equal(manifest.summary.attachmentReferences, 8);
assert.equal(manifest.summary.sharedAttachments, 2);
assert.equal(manifest.summary.orphanReferences, 2);
assert.equal(manifest.summary.unreferencedAttachments, 1);

const shared = manifest.attachments.find(item => item.path === "/attachments/shared.png");
assert.equal(shared.references.length, 4);
assert.deepEqual(
  shared.references.map(reference => [reference.resourceType, reference.resourceId, reference.field, reference.version]),
  [
    ["book", "book-1", "imagePath", 2],
    ["capture", "capture-b", "attachmentPaths", 3],
    ["dailyRecord", "daily-image-only", "attachmentPaths", 4],
    ["thought", "thought-image-only", "attachmentPaths", 2]
  ]
);
assert.equal(new Set(shared.references.map(reference => reference.attachmentId)).size, 1);
assert.equal(shared.metadata.sha256, "a".repeat(64));

const imageOnly = manifest.resources.find(resource => resource.id === "daily-image-only");
assert.ok(imageOnly, "records containing only an image must remain exportable");
assert.deepEqual(imageOnly.body, []);
assert.equal(imageOnly.attachmentReferences[0].fieldPath, "attachmentPaths[0]");
assert.equal(imageOnly.attachmentReferences[0].occurredAt, "2026-09-28T03:00:00.000Z");

const missing = manifest.attachments.find(item => item.path === "/attachments/missing.png");
assert.equal(missing.availability, "missing");
assert.equal(missing.references.length, 2, "missing references must remain in the manifest");
assert.equal(manifest.orphanReferences[0].path, "/attachments/missing.png");
assert.deepEqual(new Set(manifest.orphanReferences.map(item => item.resourceId)), new Set(["capture-b", "thought-image-only"]));
assert.equal(manifest.unreferencedAttachments[0].path, "/attachments/unreferenced.png");

const attachmentFields = new Set(manifest.attachmentReferences.map(reference => reference.field));
assert.deepEqual(attachmentFields, new Set(["attachmentPaths", "imagePath", "originalPath", "cutoutPath"]));
assert.deepEqual(
  manifest.resources.filter(resource => resource.resourceType === "capture").map(resource => resource.id),
  ["capture-a", "capture-b"]
);

const serialized = stableExportJson(manifest);
for (const privateValue of [
  "PRIVATE_REASONING",
  "PRIVATE_API_KEY",
  "PRIVATE_CHAIN",
  "PRIVATE_PASSWORD",
  "PRIVATE_CHAT_REASONING",
  "PRIVATE_CREDENTIAL",
  "PRIVATE_ACCESS_TOKEN",
  "MUST_NOT_EXPORT"
]) {
  assert.doesNotMatch(serialized, new RegExp(privateValue));
}
assert.equal(manifest.privacy.reasoningExcluded, true);
assert.equal(manifest.privacy.secretsExcluded, true);
assert.ok(manifest.privacy.omittedReasoningFields >= 3);
assert.ok(manifest.privacy.omittedSecretFields >= 4);

const explicitPrivateExport = buildExportManifest(snapshot, { includeReasoning: true, includeSecrets: true });
const explicitPrivateJson = stableExportJson(explicitPrivateExport);
assert.match(explicitPrivateJson, /PRIVATE_REASONING/);
assert.match(explicitPrivateJson, /PRIVATE_API_KEY/);

const reordered = structuredClone(snapshot);
reordered.store.captures.reverse();
reordered.inventory.reverse();
assert.equal(stableExportJson(buildExportManifest(reordered)), serialized);
assert.equal(stableExportJson(buildExportManifest(snapshot)), serialized);

const accountExport = createAccountExport(snapshot);
assert.deepEqual(accountExport.manifest, manifest);
assert.equal(accountExport.files.json.filename, "for-now-account-42-export-2026-09-29.json");
assert.equal(accountExport.files.markdown.filename, "for-now-account-42-export-2026-09-29.md");
assert.deepEqual(JSON.parse(accountExport.files.json.content), manifest);
assert.match(accountExport.files.markdown.content, /带两张图片的捕念/);
assert.match(accountExport.files.markdown.content, /\/attachments\/missing\.png/);
assert.match(accountExport.files.markdown.content, /## 孤儿引用/);
assert.equal(
  createExportDocument(manifest, "md").mimeType,
  "text/markdown;charset=utf-8"
);
assert.throws(() => createExportDocument(manifest, "zip"), /Unsupported export format/);

const descriptor = createDownloadDescriptor(accountExport.files.json);
assert.equal(descriptor.filename, accountExport.files.json.filename);
assert.equal(descriptor.download, descriptor.filename);
assert.equal(descriptor.mimeType, "application/json;charset=utf-8");
assert.equal(await descriptor.blob.text(), accountExport.files.json.content);
assert.equal(descriptor.size, descriptor.blob.size);
assert.equal(createDownloadDescriptors(accountExport.files).length, 2);
assert.throws(() => createDownloadDescriptor({ format: "zip", content: "" }), /Unsupported export format/);

const g2Manifest = buildExportManifest({
  accountId: "g2-account",
  store: {
    version: 15,
    actions: [{ id: "action-1", title: "行动", version: 1 }],
    habits: [{ id: "habit-1", title: "习惯", version: 1 }],
    habitCheckins: [{ id: "habit-checkin-1", habitId: "habit-1", occurredOn: "2026-09-29", version: 1 }],
    feedback: [{ id: "feedback-1", body: "反馈", version: 1 }],
    validationLedger: [{ id: "validation-1", participantRef: "成员-01", version: 1 }],
    commercialization: { version: 3, updatedAt: "2026-09-29T08:00:00.000Z" }
  }
});
assert.deepEqual(
  new Set(g2Manifest.resources.map(resource => resource.resourceType)),
  new Set(["action", "habit", "habitCheckin", "feedback", "validationLedger", "commercialization"])
);
const unverifiedManifest = buildExportManifest({
  accountId: "internal-test",
  store: {
    version: 15,
    captures: [{ id: "capture-without-inventory", content: "仅内部核验", attachmentPaths: ["/attachments/unverified.png"] }]
  }
});
assert.equal(unverifiedManifest.attachments[0].availability, "unverified");
assert.equal(unverifiedManifest.orphanReferences.length, 0, "Missing inventory must not be reported as verified missing");

let httpResponse;
const exportHttp = createExportHttp({
  createExport: createAccountExport,
  snapshot: async () => ({ accountId: snapshot.accountId, store: snapshot.store }),
  attachmentInventory: async source => {
    assert.equal(source.accountId, snapshot.accountId);
    return snapshot.inventory;
  }
});
await exportHttp.handleV1(
  { method: "GET" },
  {},
  new URL("http://local/api/v1/exports/account?format=manifest"),
  { success: (_res, status, data) => { httpResponse = { status, data }; } }
);
assert.equal(httpResponse.status, 200);
assert.equal(httpResponse.data.attachments.every(item => item.availability !== "unverified"), true);

const frontendSource = await fs.readFile(new URL("../public/frontend/features/export/index.mjs", import.meta.url), "utf8");
assert.doesNotMatch(frontendSource, /\b(?:document|window|fetch|XMLHttpRequest)\b/);
const domainSource = await fs.readFile(new URL("../src/modules/exports/index.mjs", import.meta.url), "utf8");
assert.doesNotMatch(domainSource, /\b(?:fetch|process\.env|node:fs|node:http)\b/);

console.log("G2 export checks passed: shared references, image-only resources, missing attachments, privacy defaults, deterministic JSON/Markdown and Blob descriptors.");
