import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import {
  WORKING_CONTEXT_RECEIPT_BYTE_LIMIT,
  WORKING_CONTEXT_VERSION,
  contextDerivedOutputAllowed,
  taskContextSourceMaterial,
  thoughtTaskCurrentMaterial,
  workingContextProjection,
  workingContextReceiptFingerprint,
  workingContextReceiptMatches
} from "../src/app/index.mjs";
import {
  evidenceFingerprint,
  normalizeEvidenceSource,
  normalizePerceptionEvent
} from "../src/modules/user-model/index.mjs";
import { taskInputMatches } from "../src/modules/tasks/index.mjs";

const accountId = "account-a";
const generatedAt = "2026-10-07T12:30:00.000Z";
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
assert.equal(taskInputMatches({
  kind: "annotationShenji",
  inputVersion: 1,
  subtargetVersion: 0,
  legacyUnversionedSubtarget: true,
  inputHash: "legacy-hash"
}, {
  inputVersion: 1,
  subtargetVersion: 2,
  inputHash: "legacy-hash"
}), true);
assert.equal(taskInputMatches({
  kind: "annotationShenji",
  inputVersion: 1,
  subtargetVersion: 0,
  inputHash: "legacy-hash"
}, {
  inputVersion: 1,
  subtargetVersion: 2,
  inputHash: "legacy-hash"
}), false);
assert.equal(taskInputMatches({
  kind: "annotationShenji",
  inputVersion: 0,
  subtargetVersion: 0
}, {
  inputVersion: 1,
  subtargetVersion: 2
}), false);
assert.equal(taskInputMatches({
  kind: "followUpAnswer",
  inputVersion: 1,
  subtargetVersion: 0
}, {
  inputVersion: 1,
  subtargetVersion: 2
}), false);
const sourceKey = sourceRef => JSON.stringify([
  sourceRef.resourceType,
  sourceRef.resourceId,
  sourceRef.rootId,
  sourceRef.targetKey
]);
const evidenceRecord = ({
  id,
  resourceId,
  text,
  eventId,
  contextAllowed = true,
  span = null,
  recordedAt = generatedAt
}) => {
  const sourceRef = {
    resourceType: "capture",
    resourceId,
    rootId: "",
    targetKey: "",
    version: 1
  };
  const evidence = normalizeEvidenceSource({
    schemaVersion: 1,
    id,
    accountId,
    sourceRef,
    eventId,
    origin: "user",
    informationType: "user_viewpoint",
    contentSha256: hash(text),
    contentLength: text.length,
    span: span || [0, text.length],
    occurredAt: "2026-10-01T08:00:00.000Z",
    recordedAt,
    permissionRevision: 1,
    derivedFrom: []
  });
  return {
    capture: {
      id: resourceId,
      content: text,
      version: 1,
      occurredAt: "2026-10-01T08:00:00.000Z",
      occurredOn: "2026-10-01"
    },
    evidence,
    permission: {
      schemaVersion: 1,
      accountId,
      sourceKey: sourceKey(sourceRef),
      contextAllowed,
      learningAllowed: false,
      revision: 1,
      updatedAt: recordedAt
    },
    event: normalizePerceptionEvent({
      schemaVersion: 1,
      id: `event-${id}`,
      accountId,
      kind: "created",
      sourceRef,
      eventId,
      contentSha256: hash(text),
      occurredAt: "2026-10-01T08:00:00.000Z",
      recordedAt,
      permissionRevision: 1,
      perceptionVersion: "perception-v1"
    })
  };
};

const relevant = evidenceRecord({
  id: "evidence-relevant",
  resourceId: "capture-relevant",
  text: "迁移方案必须兼容旧客户端，并保持写入不中断。",
  eventId: "migration-event",
  recordedAt: "2026-10-07T12:00:03.000Z"
});
const duplicate = evidenceRecord({
  id: "evidence-duplicate",
  resourceId: "capture-duplicate",
  text: "迁移方案的另一份重复事件记录。",
  eventId: "migration-event",
  recordedAt: "2026-10-07T12:00:02.000Z"
});
const irrelevant = evidenceRecord({
  id: "evidence-irrelevant",
  resourceId: "capture-irrelevant",
  text: "昨天记录了体重和饮水。",
  eventId: "health-event"
});
const denied = evidenceRecord({
  id: "evidence-denied",
  resourceId: "capture-denied",
  text: "旧客户端迁移偏好已经撤回。",
  eventId: "denied-event",
  contextAllowed: false
});
const root = {
  id: "root",
  type: "question",
  authorType: "user",
  content: "如何设计不中断写入的迁移？",
  version: 3,
  attachmentPaths: ["/attachments/root.png"],
  occurredAt: "2026-10-07T11:00:00.000Z",
  occurredOn: "2026-10-07",
  remarks: [{ id: "remark", text: "必须保留旧客户端", version: 1 }],
  followUps: [{
    id: "follow-up",
    question: "比较双写与停机切换",
    answer: "先列风险",
    version: 2
  }],
  annotations: [{
    id: "annotation",
    targetKey: "question:root",
    quote: "不中断写入",
    text: "这是硬约束",
    version: 1,
    shenji: [{ id: "exchange", message: "为什么？", answer: "因为仍有旧客户端" }]
  }]
};
const store = {
  thoughts: [
    root,
    {
      id: "idea",
      relatedTo: root.id,
      type: "idea",
      authorType: "user",
      content: "先做兼容读取",
      version: 1
    },
    {
      id: "record",
      relatedTo: root.id,
      type: "record",
      authorType: "user",
      content: "压测时写入不能暂停",
      attachmentPaths: ["/attachments/record.png"],
      version: 1
    },
    {
      id: "answer",
      relatedTo: root.id,
      type: "answer",
      authorType: "user",
      content: "倾向双写方案",
      version: 1
    },
    {
      id: "image-only",
      relatedTo: root.id,
      type: "record",
      authorType: "user",
      content: "",
      attachmentPaths: ["/attachments/image-only.png"],
      version: 1
    }
  ],
  captures: [relevant.capture, duplicate.capture, irrelevant.capture, denied.capture],
  evidenceSources: [relevant.evidence, duplicate.evidence, irrelevant.evidence, denied.evidence],
  evidencePermissions: [relevant.permission, duplicate.permission, irrelevant.permission, denied.permission],
  perceptionEvents: [relevant.event, duplicate.event, irrelevant.event, denied.event],
  trash: []
};
const currentMaterial = thoughtTaskCurrentMaterial(store, root, {
  accountId,
  currentFollowUpId: "follow-up"
});
const options = {
  accountId,
  scene: "followUpAnswer",
  task: {
    kind: "followUpAnswer",
    text: "比较不中断写入的迁移方案，并保留旧客户端约束。",
    targetId: root.id,
    subtargetId: "follow-up"
  },
  currentMaterial,
  generatedAt
};
const projection = workingContextProjection(store, options);

assert.equal(projection.receipt.schemaVersion, 2);
assert.equal(projection.receipt.version, WORKING_CONTEXT_VERSION);
assert.equal(projection.receipt.status, "complete");
assert.equal(projection.receipt.historyRetrieval.status, "ok");
assert.equal(projection.receipt.currentMaterial.length, currentMaterial.length);
assert.equal(projection.receipt.selected.filter(item => item.channel === "current").length, currentMaterial.length);
for (const expected of [
  "如何设计不中断写入的迁移？",
  "先做兼容读取",
  "压测时写入不能暂停",
  "倾向双写方案",
  "必须保留旧客户端",
  "比较双写与停机切换",
  "这是硬约束",
]) {
  assert.match(projection.prompt, new RegExp(expected));
}
assert.doesNotMatch(projection.prompt, /因为仍有旧客户端/);
assert.ok(
  projection.receipt.selected.some(item => item.evidenceId === relevant.evidence.id),
  JSON.stringify({
    candidates: projection.receipt.candidates,
    selected: projection.receipt.selected,
    excluded: projection.receipt.excluded
  })
);
assert.ok(projection.receipt.candidates.find(
  item => item.evidenceId === relevant.evidence.id
).relevanceScore > 0);
assert.ok(projection.receipt.excluded.some(item => (
  item.evidenceId === duplicate.evidence.id && item.reasons.includes("duplicate-event")
)));
assert.ok(projection.receipt.excluded.some(item => (
  item.evidenceId === irrelevant.evidence.id && item.reasons.includes("task-irrelevant")
)));
assert.ok(projection.receipt.excluded.some(item => (
  item.evidenceId === denied.evidence.id && item.reasons.includes("EVIDENCE_PERMISSION_DENIED")
)));
assert.equal(projection.receipt.evidenceChecks.length, 1);
assert.deepEqual(projection.receipt.evidenceChecks[0], {
  evidenceId: relevant.evidence.id,
  evidenceFingerprint: evidenceFingerprint(relevant.evidence),
  purpose: "context"
});
assert.equal(projection.receipt.sourceCount, projection.receipt.sources.length);
assert.deepEqual(projection.attachmentPaths, [
  "/attachments/root.png",
  "/attachments/record.png",
  "/attachments/image-only.png"
]);
assert.equal(
  projection.receipt.selected.filter(item => item.channel === "history").length
    + projection.receipt.excludedCount,
  projection.receipt.candidateCount
);
assert.match(workingContextReceiptFingerprint(projection.receipt), /^[a-f0-9]{64}$/);
assert.equal(workingContextReceiptMatches(store, projection.receipt, options), true);
assert.equal(workingContextReceiptFingerprint({
  ...projection.receipt,
  generatedAt: "not-a-date"
}), "");
assert.equal(workingContextReceiptFingerprint({
  ...projection.receipt,
  timeWindow: { from: "2026-10-32", to: "2026-10-01" }
}), "");
assert.equal(workingContextReceiptMatches(store, {
  ...projection.receipt,
  timeWindow: { from: "2026-09-30", to: "2026-10-01" }
}, options), false);
const rootAnswerOptions = {
  ...options,
  scene: "thoughtAnswer",
  task: {
    kind: "thoughtAnswer",
    text: root.content,
    targetId: root.id,
    subtargetId: ""
  },
  currentMaterial: thoughtTaskCurrentMaterial(store, root, { accountId })
};
const rootAnswerProjection = workingContextProjection(store, rootAnswerOptions);
assert.equal(contextDerivedOutputAllowed(store, {
  id: "forged-valid-answer",
  type: "answer",
  authorType: "ai",
  origin: "deepseek",
  relatedTo: root.id,
  content: "伪造但结构完整的回答",
  modelDraft: "伪造但结构完整的回答",
  sourceVersion: root.version,
  clientRequestId: "forged-valid-request",
  contextReceipt: rootAnswerProjection.receipt
}, accountId), false);
const foregroundAnswer = {
  id: "foreground-answer",
  type: "answer",
  authorType: "ai",
  origin: "deepseek",
  relatedTo: root.id,
  content: "可信前台回答",
  modelDraft: "可信前台回答",
  sourceVersion: root.version,
  sourceTaskId: "foreground-task",
  clientRequestId: "foreground-answer",
  version: 1,
  contextReceipt: rootAnswerProjection.receipt
};
const foregroundStore = structuredClone(store);
foregroundStore.thoughts.push(foregroundAnswer);
foregroundStore.aiTasks = [{
  id: "foreground-task",
  kind: "thoughtAnswer",
  targetId: root.id,
  subtargetId: "",
  resultId: foregroundAnswer.id,
  status: "succeeded",
  contextFingerprint: workingContextReceiptFingerprint(rootAnswerProjection.receipt),
  internal: true
}];
assert.equal(contextDerivedOutputAllowed(
  foregroundStore,
  foregroundStore.thoughts.at(-1),
  accountId
), true);
const derivedStore = structuredClone(store);
derivedStore.thoughts.push({
  id: "derived-answer",
  relatedTo: root.id,
  type: "answer",
  authorType: "ai",
  origin: "deepseek",
  content: "基于历史迁移证据生成的回答",
  modelDraft: "基于历史迁移证据生成的回答",
  sourceVersion: root.version,
  sourceTaskId: "derived-task",
  version: 1,
  clientRequestId: "foreground-answer",
  contextReceipt: rootAnswerProjection.receipt
});
derivedStore.aiTasks = [{
  id: "derived-task",
  kind: "thoughtAnswer",
  targetId: root.id,
  subtargetId: "",
  resultId: "derived-answer",
  status: "succeeded",
  contextFingerprint: workingContextReceiptFingerprint(rootAnswerProjection.receipt)
}];
assert.ok(thoughtTaskCurrentMaterial(derivedStore, derivedStore.thoughts[0], {
  accountId
}).some(item => item.sourceRef.resourceId === "derived-answer"));
derivedStore.evidencePermissions.find(item => (
  item.sourceKey === relevant.permission.sourceKey
)).contextAllowed = false;
derivedStore.evidencePermissions.find(item => (
  item.sourceKey === relevant.permission.sourceKey
)).revision += 1;
assert.equal(thoughtTaskCurrentMaterial(derivedStore, derivedStore.thoughts[0], {
  accountId
}).some(item => item.sourceRef.resourceId === "derived-answer"), false);
const completedFollowUpStore = structuredClone(store);
const completedRoot = completedFollowUpStore.thoughts[0];
const completedFollowUp = completedRoot.followUps[0];
completedRoot.version += 1;
completedFollowUp.version += 1;
Object.assign(completedFollowUp, {
  answer: "生成后的追问回答",
  authorType: "ai",
  origin: "deepseek",
  modelDraft: "生成后的追问回答",
  sourceTaskId: "follow-up-task",
  contextReceipt: projection.receipt
});
completedFollowUpStore.aiTasks = [{
  id: "follow-up-task",
  kind: "followUpAnswer",
  targetId: root.id,
  subtargetId: completedFollowUp.id,
  resultId: completedFollowUp.id,
  status: "succeeded",
  contextFingerprint: workingContextReceiptFingerprint(projection.receipt)
}];
assert.ok(thoughtTaskCurrentMaterial(completedFollowUpStore, completedRoot, {
  accountId,
  currentFollowUpId: completedFollowUp.id
}).some(item => item.text === "生成后的追问回答"));
const forgedStore = structuredClone(store);
forgedStore.thoughts.push({
  id: "forged-answer",
  relatedTo: root.id,
  type: "answer",
  authorType: "ai",
  content: "伪造派生内容",
  version: 1,
  contextReceipt: {
    schemaVersion: 2,
    version: "forged",
    accountBindingSha256: hash(accountId),
    currentMaterial: [],
    selected: [],
    evidenceChecks: []
  }
});
assert.equal(thoughtTaskCurrentMaterial(forgedStore, forgedStore.thoughts[0], {
  accountId
}).some(item => item.sourceRef.resourceId === "forged-answer"), false);

const spanText = "早餐吃了苹果。数据库迁移必须灰度。";
const spanValue = "数据库迁移必须灰度";
const spanStart = spanText.indexOf(spanValue);
const spanRecord = evidenceRecord({
  id: "evidence-span",
  resourceId: "capture-span",
  text: spanText,
  eventId: "span-event",
  span: [spanStart, spanStart + spanValue.length]
});
const spanStore = {
  ...store,
  captures: [...store.captures, spanRecord.capture],
  evidenceSources: [...store.evidenceSources, spanRecord.evidence],
  evidencePermissions: [...store.evidencePermissions, spanRecord.permission],
  perceptionEvents: [...store.perceptionEvents, spanRecord.event]
};
const spanProjection = workingContextProjection(spanStore, options);
assert.match(spanProjection.prompt, /数据库迁移必须灰度/);
assert.doesNotMatch(spanProjection.prompt, /早餐吃了苹果/);
const appleOnly = evidenceRecord({
  id: "evidence-apple",
  resourceId: "capture-apple",
  text: "早餐吃了苹果。",
  eventId: "apple-event"
});
const appleStore = {
  ...store,
  captures: [appleOnly.capture],
  evidenceSources: [appleOnly.evidence],
  evidencePermissions: [appleOnly.permission],
  perceptionEvents: [appleOnly.event]
};
const appleProjection = workingContextProjection(appleStore, {
  ...options,
  task: { ...options.task, text: "比较苹果手机迁移方案。" }
});
assert.ok(appleProjection.receipt.excluded.some(item => (
  item.evidenceId === appleOnly.evidence.id && item.reasons.includes("task-irrelevant")
)));
const english = evidenceRecord({
  id: "evidence-english",
  resourceId: "capture-english",
  text: "The database migration must preserve compatibility.",
  eventId: "english-event"
});
const englishStore = {
  ...store,
  captures: [english.capture],
  evidenceSources: [english.evidence],
  evidencePermissions: [english.permission],
  perceptionEvents: [english.event]
};
assert.ok(workingContextProjection(englishStore, {
  ...options,
  task: { ...options.task, text: "Migrate databases without downtime." }
}).receipt.selected.some(item => item.evidenceId === english.evidence.id));
const shortChinese = evidenceRecord({
  id: "evidence-sleep",
  resourceId: "capture-sleep",
  text: "最近持续睡眠不足。",
  eventId: "sleep-event"
});
const shortChineseStore = {
  ...store,
  captures: [shortChinese.capture],
  evidenceSources: [shortChinese.evidence],
  evidencePermissions: [shortChinese.permission],
  perceptionEvents: [shortChinese.event]
};
assert.ok(workingContextProjection(shortChineseStore, {
  ...options,
  task: { ...options.task, text: "睡眠怎么办？" }
}).receipt.selected.some(item => item.evidenceId === shortChinese.evidence.id));
const genericProject = evidenceRecord({
  id: "evidence-generic-project",
  resourceId: "capture-generic-project",
  text: "This project concerns a catering schedule.",
  eventId: "generic-project-event"
});
const genericProjectStore = {
  ...store,
  captures: [genericProject.capture],
  evidenceSources: [genericProject.evidence],
  evidencePermissions: [genericProject.permission],
  perceptionEvents: [genericProject.event]
};
assert.ok(workingContextProjection(genericProjectStore, {
  ...options,
  task: { ...options.task, text: "Plan the project database migration." }
}).receipt.excluded.some(item => (
  item.evidenceId === genericProject.evidence.id && item.reasons.includes("task-irrelevant")
)));
for (const [resourceType, collection, item, targetKey, expected] of [
  ["userClaim", "userClaims", { id: "claim", statement: "用户声明", version: 2 }, "claim:claim", "用户声明"],
  ["modelUnknown", "modelUnknowns", { id: "unknown", question: "仍需确认什么？", version: 1 }, "", "仍需确认什么？"],
  ["checkin", "checkins", { id: "checkin", mood: 4, energy: 3, stress: 2, sleep: 4, factors: ["发布"], custom: {}, notes: {}, version: 1 }, "", "\"mood\":4"],
  ["dailyRecord", "dailyRecords", { id: "daily", type: "exercise", durationSeconds: 900, version: 1 }, "", "\"durationSeconds\":900"]
]) {
  assert.match(taskContextSourceMaterial({ [collection]: [item] }, {
    resourceType,
    resourceId: item.id,
    rootId: "",
    targetKey,
    version: item.version
  }).text, new RegExp(expected));
}
const manyEvidence = Array.from({ length: 120 }, (_, index) => evidenceRecord({
  id: `evidence-many-${index}`,
  resourceId: `capture-many-${index}`,
  text: `迁移方案需要兼容旧客户端 ${index}`,
  eventId: `many-event-${index}`
}));
const manyStore = {
  ...store,
  captures: manyEvidence.map(item => item.capture),
  evidenceSources: manyEvidence.map(item => item.evidence),
  evidencePermissions: manyEvidence.map(item => item.permission),
  perceptionEvents: manyEvidence.map(item => item.event)
};
const manyProjection = workingContextProjection(manyStore, options);
assert.equal(manyProjection.receipt.candidateCount, 120);
assert.equal(manyProjection.receipt.candidates.length, 100);
assert.equal(manyProjection.receipt.excludedCount, 112);
assert.equal(manyProjection.receipt.excluded.length, 100);
assert.ok(Buffer.byteLength(JSON.stringify(manyProjection.receipt), "utf8")
  <= WORKING_CONTEXT_RECEIPT_BYTE_LIMIT);

const changed = structuredClone(store);
changed.captures.find(item => item.id === relevant.capture.id).version = 2;
changed.captures.find(item => item.id === relevant.capture.id).content = "迁移约束已经改变。";
assert.equal(workingContextReceiptMatches(changed, projection.receipt, options), false);

const degraded = workingContextProjection(store, {
  ...options,
  retrieveHistorical: () => {
    throw new Error("retrieval unavailable");
  }
});
assert.equal(degraded.receipt.status, "degraded");
assert.equal(degraded.receipt.historyRetrieval.status, "unavailable");
assert.equal(degraded.receipt.evidenceChecks.length, 0);
assert.equal(degraded.receipt.selected.some(item => item.channel === "history"), false);
assert.equal(degraded.receipt.selected.filter(item => item.channel === "current").length, currentMaterial.length);
assert.match(degraded.prompt, /历史证据暂不可用，本次仅依据当前材料/);
const malformedRetrieval = workingContextProjection(store, {
  ...options,
  retrieveHistorical: () => [null]
});
assert.equal(malformedRetrieval.receipt.status, "degraded");
assert.equal(malformedRetrieval.receipt.selected.some(item => item.channel === "history"), false);
const injectedDenied = workingContextProjection(store, {
  ...options,
  retrieveHistorical: () => [denied.evidence]
});
assert.equal(injectedDenied.receipt.selected.some(item => item.channel === "history"), false);
assert.ok(injectedDenied.receipt.excluded[0].reasons.includes("EVIDENCE_PERMISSION_DENIED"));

assert.throws(
  () => workingContextProjection(store, {
    ...options,
    accountId: "account-b"
  }),
  error => error.code === "CURRENT_MATERIAL_ACCOUNT_MISMATCH"
);
const deniedCurrentStore = structuredClone(store);
deniedCurrentStore.thoughts.find(item => item.id === "record").contextAllowed = false;
deniedCurrentStore.thoughts.find(item => item.id === "idea").disposition = "discarded";
deniedCurrentStore.thoughts[0].annotationDrift = [{
  id: "drifted",
  targetKey: "question:root",
  quote: "STALE_DRIFT_QUOTE",
  text: "STALE_DRIFT_COMMENT",
  version: 1
}];
const filteredCurrent = thoughtTaskCurrentMaterial(
  deniedCurrentStore,
  deniedCurrentStore.thoughts[0],
  { accountId, currentFollowUpId: "follow-up" }
);
assert.equal(filteredCurrent.some(item => item.sourceRef.resourceId === "record"), false);
assert.equal(filteredCurrent.some(item => item.sourceRef.resourceId === "idea"), false);
assert.equal(filteredCurrent.some(item => item.sourceRef.resourceId === "drifted"), false);
deniedCurrentStore.thoughts[0].contextAllowed = false;
assert.throws(
  () => workingContextProjection(deniedCurrentStore, {
    ...options,
    currentMaterial: thoughtTaskCurrentMaterial(
      deniedCurrentStore,
      deniedCurrentStore.thoughts[0],
      { accountId, currentFollowUpId: "follow-up" }
    )
  }),
  error => error.code === "CURRENT_MATERIAL_INVALID"
);
assert.throws(
  () => workingContextProjection(store, {
    ...options,
    tokenLimit: 256,
    currentMaterial: [{
      ...currentMaterial[0],
      text: "当前材料".repeat(200)
    }]
  }),
  error => error.code === "CURRENT_MATERIAL_BUDGET_EXCEEDED"
);
const maximumCurrent = Array.from({ length: 80 }, (_, index) => ({
  ...currentMaterial[0],
  id: `current-maximum-${index}`,
  text: `材料 ${index}`,
  sourceRef: {
    ...currentMaterial[0].sourceRef,
    resourceId: `current-maximum-${index}`
  }
}));
const maximumCurrentProjection = workingContextProjection(store, {
  ...options,
  currentMaterial: maximumCurrent
});
assert.equal(maximumCurrentProjection.receipt.currentMaterial.length, 80);
assert.ok(Buffer.byteLength(JSON.stringify(maximumCurrentProjection.receipt), "utf8")
  <= WORKING_CONTEXT_RECEIPT_BYTE_LIMIT);
const longCurrentProjection = workingContextProjection(store, {
  ...options,
  currentMaterial: Array.from({ length: 81 }, (_, index) => ({
    ...currentMaterial[0],
    id: `current-long-${index}`,
    sourceRef: {
      ...currentMaterial[0].sourceRef,
      resourceId: `current-long-${index}`
    }
  }))
});
assert.equal(longCurrentProjection.receipt.currentMaterial.length, 81);

const replayFixtureSet = JSON.parse(await fs.readFile(
  new URL("./fixtures/personalization-replay-v1.json", import.meta.url),
  "utf8"
));
const replayCollections = {
  capture: "captures",
  journal: "journals",
  checkin: "checkins",
  dailyRecord: "dailyRecords",
  thoughtAi: "thoughts"
};
const replayRecord = material => {
  const id = material.id.split(":").slice(1).join(":");
  const occurredOn = material.occurredOn || "2026-10-01";
  const common = {
    id,
    version: material.version || 1,
    occurredAt: `${occurredOn}T08:00:00.000Z`,
    occurredOn,
    createdAt: `${occurredOn}T08:00:00.000Z`
  };
  if (material.storeKind === "capture") return { ...common, content: material.text, tags: [] };
  if (material.storeKind === "journal") return { ...common, title: "", content: material.text, tags: [] };
  if (material.storeKind === "checkin") {
    return {
      ...common,
      mood: 3,
      energy: 3,
      stress: 3,
      sleep: 3,
      factors: [],
      ...material.payload
    };
  }
  if (material.storeKind === "dailyRecord") {
    return {
      ...common,
      type: "weight",
      ...material.payload,
      description: material.payload?.description || material.text
    };
  }
  return {
    ...common,
    type: "answer",
    authorType: "ai",
    origin: "deepseek",
    relatedTo: "fixture-root",
    content: material.text
  };
};
const replayState = fixture => {
  const replayStore = {
    captures: [],
    journals: [],
    checkins: [],
    dailyRecords: [],
    thoughts: [],
    evidenceSources: [],
    evidencePermissions: [],
    perceptionEvents: [],
    trash: []
  };
  const current = [];
  const evidenceToMaterial = new Map();
  for (const [index, material] of fixture.materials.entries()) {
    if (material.channel === "current") {
      current.push({
        id: material.id,
        accountId,
        text: material.text,
        recordType: "当前任务材料",
        validation: "immutable",
        sourceRef: {
          resourceType: "replayFixture",
          resourceId: `${fixture.id}-${index}`,
          rootId: "",
          targetKey: "",
          version: 1
        }
      });
      continue;
    }
    if (material.account === "other") continue;
    const record = replayRecord(material);
    replayStore[replayCollections[material.storeKind]].push(record);
    const sourceRef = {
      resourceType: material.storeKind === "thoughtAi" ? "thought" : material.storeKind,
      resourceId: record.id,
      rootId: "",
      targetKey: "",
      version: record.version
    };
    const source = taskContextSourceMaterial(replayStore, sourceRef);
    const evidenceId = `replay-${fixture.id}-${index}`;
    const contextAllowed = material.contextAllowed !== false
      && material.forbiddenReason !== "invalidated-derived"
      && material.storeKind !== "thoughtAi";
    const evidence = normalizeEvidenceSource({
      schemaVersion: 1,
      id: evidenceId,
      accountId,
      sourceRef,
      eventId: material.eventId || `event-${fixture.id}-${index}`,
      origin: material.forbiddenReason === "third-party-as-user" ? "third_party" : "user",
      informationType: "user_viewpoint",
      contentSha256: source.contentSha256,
      contentLength: source.text.length,
      span: [0, source.text.length],
      occurredAt: record.occurredAt,
      recordedAt: generatedAt,
      permissionRevision: 1,
      derivedFrom: []
    });
    replayStore.evidenceSources.push(evidence);
    replayStore.evidencePermissions.push({
      schemaVersion: 1,
      accountId,
      sourceKey: sourceKey(sourceRef),
      contextAllowed,
      learningAllowed: false,
      revision: 1,
      updatedAt: generatedAt
    });
    replayStore.perceptionEvents.push(normalizePerceptionEvent({
      schemaVersion: 1,
      id: `perception-${fixture.id}-${index}`,
      accountId,
      kind: "created",
      sourceRef,
      eventId: evidence.eventId,
      contentSha256: evidence.contentSha256,
      occurredAt: evidence.occurredAt,
      recordedAt: generatedAt,
      permissionRevision: 1,
      perceptionVersion: "selection-replay-v1"
    }));
    evidenceToMaterial.set(evidenceId, material);
  }
  return { replayStore, current, evidenceToMaterial };
};
const replayResults = replayFixtureSet.fixtures.map(fixture => {
  const { replayStore, current, evidenceToMaterial } = replayState(fixture);
  const replayProjection = workingContextProjection(replayStore, {
    accountId,
    scene: "thoughtAnswer",
    task: {
      kind: "thoughtAnswer",
      text: fixture.task,
      targetId: fixture.id,
      subtargetId: ""
    },
    currentMaterial: current,
    generatedAt
  });
  const selectedEvidenceIds = replayProjection.receipt.selected
    .filter(item => item.channel === "history")
    .map(item => item.evidenceId);
  const selectedMaterials = selectedEvidenceIds.map(id => evidenceToMaterial.get(id));
  const required = fixture.materials.filter(item => item.channel === "history" && item.required);
  const missingRequired = required.filter(item => !selectedMaterials.includes(item));
  const selectedEvents = selectedMaterials.map(item => item.eventId).filter(Boolean);
  assert.equal(
    replayProjection.receipt.selected.filter(item => item.channel === "current").length,
    current.length,
    `${fixture.id} lost current material`
  );
  assert.equal(
    selectedMaterials.some(item => (
      item.contextAllowed === false
      || item.account === "other"
      || item.forbiddenReason === "invalidated-derived"
      || item.storeKind === "thoughtAi"
    )),
    false,
    `${fixture.id} selected hard-denied material`
  );
  assert.equal(new Set(selectedEvents).size, selectedEvents.length, `${fixture.id} duplicated an event`);
  return {
    fixtureId: fixture.id,
    selectedCount: selectedMaterials.length,
    relevantSelectedCount: selectedMaterials.filter(item => item.relevant).length,
    missingRequiredIds: missingRequired.map(item => item.id)
  };
});
const replayMissing = replayResults.flatMap(result => result.missingRequiredIds);
const replaySelected = replayResults.reduce((total, result) => total + result.selectedCount, 0);
const replayRelevant = replayResults.reduce((total, result) => total + result.relevantSelectedCount, 0);
assert.equal(replayResults.length, 16);
assert.deepEqual(replayMissing, [
  "capture:dedup-capture",
  "capture:benefit-result"
]);
assert.ok(replayRelevant / replaySelected >= 0.7);

console.log(
  "Task context selection checks passed: complete current chains, evidence-gated relevance, "
  + `event deduplication, degraded retrieval, receipt invalidation and 16-fixture selection replay `
  + `(relevance ${replayRelevant}/${replaySelected}, known semantic misses ${replayMissing.length}).`
);
