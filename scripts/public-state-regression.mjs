import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  createEmptyStore,
  createPublicStateProjection,
  withoutOwnerMetadata
} from "../src/app/index.mjs";

process.env.TZ = "Asia/Shanghai";

const CURRENT_DATE = "2026-10-05";
const CURRENT_TIME = "2026-10-05T12:00:00.000Z";
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const projectPublicState = createPublicStateProjection({
  getUser: () => ({ id: "member", role: "user" }),
  isOwner: user => user?.role === "owner",
  speechProvider: {
    configured: true,
    defaultVoice: "voice-default",
    voices: [{ id: "voice-default", name: "默认声音" }],
    supportedAsrMimeTypes: ["audio/wav"]
  },
  visionProvider: { configured: true },
  hash,
  now: () => CURRENT_TIME,
  today: () => CURRENT_DATE
});

const store = {
  ...createEmptyStore(),
  captures: [{
    id: "capture",
    version: 2,
    content: "可朗读正文",
    speechCache: [{ id: "legacy-private-cache" }],
    tokenBudget: { private: true }
  }],
  keepsakes: [{
    id: "keepsake",
    title: "纪念物",
    originalPath: "/attachments/original.png",
    cutoutPath: "/attachments/cutout.webp",
    requestHash: "private-request-hash",
    previewPath: "/attachments/preview.png"
  }],
  aiTasks: Array.from({ length: 105 }, (_, index) => ({
    id: `task-${index}`,
    kind: "thoughtAnswer",
    targetId: `thought-${index}`,
    inputVersion: 1,
    status: "succeeded",
    createdAt: CURRENT_TIME,
    internal: index === 0,
    payload: { privatePrompt: "do not expose" },
    tokenBudget: { private: true }
  })),
  notifications: [{
    id: "unread",
    status: "succeeded",
    readAt: ""
  }, {
    id: "active",
    status: "running",
    readAt: ""
  }, {
    id: "read",
    status: "failed",
    readAt: CURRENT_TIME
  }],
  trash: [{ id: "trash-a" }, { id: "trash-b" }],
  attachmentCleanup: [{ path: "/attachments/private.png" }],
  speechCache: [{
    id: "speech-asset",
    cacheKey: "speech-asset",
    sourceType: "capture",
    sourceId: "capture",
    sourceVersion: 2,
    ownerHash: hash("owner"),
    textHash: hash("可朗读正文"),
    voice: "voice-default",
    attachmentPath: "/attachments/speech.mp3",
    mimeType: "audio/mpeg",
    bytes: 321,
    createdAt: "2026-10-05T10:00:00.000Z",
    expiresAt: "2026-11-05T10:00:00.000Z"
  }],
  commercialization: {
    assumptions: { privateRevenue: 999 }
  },
  evidenceSources: [{ id: "private-evidence", accountId: "member" }],
  evidencePermissions: [{ sourceKey: "[\"capture\",\"capture\",\"\",\"\"]", accountId: "member" }],
  perceptionEvents: [{ id: "private-perception-event", accountId: "member" }],
  ownerExtension: {
    visible: true,
    tokenBudget: { limit: 5000 }
  },
  userClaims: [{ id: "private-claim", statement: "MODEL_DETAIL_MARKER" }],
  modelUnknowns: [{ id: "private-unknown", question: "UNKNOWN_DETAIL_MARKER" }],
  checkins: [{
    id: "checkin",
    occurredOn: CURRENT_DATE,
    occurredAt: CURRENT_TIME,
    mood: 4,
    energy: 4,
    stress: 2,
    sleep: 4,
    factors: []
  }],
  thoughts: [{
    id: "question",
    type: "question",
    content: "工作项目",
    tags: [],
    disposition: "pending",
    occurredOn: CURRENT_DATE,
    occurredAt: CURRENT_TIME
  }]
};
const snapshot = structuredClone(store);

const ownerState = projectPublicState(store, { id: "owner", role: "owner" });
assert.equal(Object.hasOwn(ownerState, "commercialization"), false);
assert.equal(Object.hasOwn(ownerState, "trash"), false);
assert.equal(Object.hasOwn(ownerState, "attachmentCleanup"), false);
assert.equal(Object.hasOwn(ownerState, "speechCache"), false);
assert.equal(Object.hasOwn(ownerState, "evidenceSources"), false);
assert.equal(Object.hasOwn(ownerState, "evidencePermissions"), false);
assert.equal(Object.hasOwn(ownerState, "perceptionEvents"), false);
assert.equal(ownerState.trashCount, 2);
assert.equal(ownerState.notificationUnread, 1);
assert.equal(ownerState.aiTasks.length, 100);
assert.equal(ownerState.aiTasks.some(item => item.id === "task-0"), false);
assert.equal(Object.hasOwn(ownerState.aiTasks[0], "payload"), false);
assert.equal(Object.hasOwn(ownerState.captures[0], "speechCache"), false);
assert.equal(Object.hasOwn(ownerState.keepsakes[0], "originalPath"), false);
assert.equal(Object.hasOwn(ownerState.keepsakes[0], "requestHash"), false);
assert.equal(ownerState.ownerExtension.tokenBudget.limit, 5000);
assert.equal(ownerState.userClaims[0].statement, "MODEL_DETAIL_MARKER");
assert.equal(ownerState.modelUnknowns[0].question, "UNKNOWN_DETAIL_MARKER");
assert.deepEqual(ownerState.clusters.map(item => [item.theme, item.count]), [["工作与创造", 1]]);
assert.equal(ownerState.insights.weekly.rootCount30, 1);
assert.deepEqual(ownerState.speech, {
  configured: true,
  defaultVoice: "voice-default",
  voices: [{ id: "voice-default", name: "默认声音" }],
  supportedAsrMimeTypes: ["audio/wav"],
  assets: [{
    id: "speech-asset",
    sourceType: "capture",
    sourceId: "capture",
    sourceVersion: 2,
    voice: "voice-default",
    generationRate: -10,
    mimeType: "audio/mpeg",
    bytes: 321,
    createdAt: "2026-10-05T10:00:00.000Z",
    expiresAt: "2026-11-05T10:00:00.000Z"
  }]
});
assert.deepEqual(ownerState.vision, { configured: true });

const memberState = projectPublicState(store);
assert.equal(memberState.ownerExtension.visible, true);
assert.equal(Object.hasOwn(memberState, "userClaims"), false);
assert.equal(Object.hasOwn(memberState, "modelUnknowns"), false);
assert.equal(JSON.stringify(memberState).includes("MODEL_DETAIL_MARKER"), false);
assert.equal(JSON.stringify(memberState).includes("UNKNOWN_DETAIL_MARKER"), false);
const privateContextOverview = withoutOwnerMetadata({
  userModel: {
    readiness: "ready",
    claims: [{ statement: "MODEL_DETAIL_MARKER" }],
    unknowns: [{ question: "UNKNOWN_DETAIL_MARKER" }]
  }
});
assert.deepEqual(privateContextOverview.userModel, {
  readiness: "ready",
  claims: [],
  unknowns: []
});
const sanitizedContext = withoutOwnerMetadata({
  sources: [
    { id: "userClaim:c1", resourceType: "userClaim", excerpt: "MODEL_SOURCE_MARKER" },
    { id: "thought:t1", resourceType: "thought", excerpt: "VISIBLE_SOURCE" }
  ],
  conclusions: [
    { id: "user-claim-c1", sourceIds: ["userClaim:c1"], text: "MODEL_CONCLUSION_MARKER" },
    { id: "recent-facts", sourceIds: ["thought:t1"], text: "VISIBLE_CONCLUSION" }
  ]
});
assert.deepEqual(sanitizedContext.sources.map(source => source.id), ["thought:t1"]);
assert.deepEqual(sanitizedContext.conclusions, [{
  id: "recent-facts",
  sourceIds: ["thought:t1"],
  text: "VISIBLE_CONCLUSION"
}]);
assert.equal(JSON.stringify(sanitizedContext).includes("MODEL_SOURCE_MARKER"), false);
assert.equal(JSON.stringify(sanitizedContext).includes("MODEL_CONCLUSION_MARKER"), false);
assert.equal(Object.hasOwn(memberState.ownerExtension, "tokenBudget"), false);
assert.equal(JSON.stringify(memberState).includes("tokenBudget"), false);
assert.equal(Object.hasOwn(memberState, "evidenceSources"), false);
assert.equal(Object.hasOwn(memberState, "evidencePermissions"), false);
assert.equal(Object.hasOwn(memberState, "perceptionEvents"), false);
assert.deepEqual(memberState.speech.assets, [], "speech assets must be account-bound");
assert.deepEqual(store, snapshot, "public projection must not modify Store");

assert.throws(
  () => createPublicStateProjection(),
  /requires user, owner, provider, hash and clock dependencies/
);

console.log("Public state regression passed.");
