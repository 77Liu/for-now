import assert from "node:assert/strict";
import "./prompt-test-setup.mjs";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import {
  WORKING_CONTEXT_RECEIPT_BYTE_LIMIT,
  WORKING_CONTEXT_VERSION,
  contextDerivedOutputAllowed,
  compactPersonalContextReceipt,
  personalContextProjection,
  createPerceptionRuntime,
  createPerceptionService,
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
  task: { ...projection.receipt.task, eventId: { forged: true } }
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
      eventId: material.eventId || `replay-event-${index}`,
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
const replayTaskEventIds = new Map([
  ["same-event-across-two-records", "event-workshop-1"]
]);
const replayResults = replayFixtureSet.fixtures.map(fixture => {
  const { replayStore, current, evidenceToMaterial } = replayState(fixture);
  const replayProjection = workingContextProjection(replayStore, {
    accountId,
    scene: "thoughtAnswer",
    task: {
      kind: "thoughtAnswer",
      text: fixture.task,
      targetId: fixture.id,
      subtargetId: "",
      eventId: replayTaskEventIds.get(fixture.id) || ""
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
assert.deepEqual(replayMissing, []);
assert.ok(replayRelevant / replaySelected >= 0.85);

const eventDistractorFixture = structuredClone(replayFixtureSet.fixtures.find(
  fixture => fixture.id === "same-event-across-two-records"
));
eventDistractorFixture.materials.push({
  id: "capture:dedup-dentist",
  channel: "history",
  storeKind: "capture",
  text: "Tomorrow I need a dentist appointment.",
  relevant: false,
  eventId: "event-dentist-1"
});
const eventDistractorState = replayState(eventDistractorFixture);
const eventDistractorProjection = workingContextProjection(eventDistractorState.replayStore, {
  accountId,
  scene: "thoughtAnswer",
  task: {
    kind: "thoughtAnswer",
    text: eventDistractorFixture.task,
    targetId: eventDistractorFixture.id,
    subtargetId: "",
    eventId: replayTaskEventIds.get(eventDistractorFixture.id) || ""
  },
  currentMaterial: eventDistractorState.current,
  generatedAt
});
const eventDistractorSelection = eventDistractorProjection.receipt.selected
  .filter(item => item.channel === "history")
  .map(item => eventDistractorState.evidenceToMaterial.get(item.evidenceId)?.id);
assert.ok(eventDistractorSelection.includes("capture:dedup-capture"));
assert.equal(eventDistractorSelection.includes("journal:dedup-journal"), false);
assert.equal(
  eventDistractorSelection.includes("capture:dedup-dentist"),
  false,
  JSON.stringify({
    selected: eventDistractorSelection,
    candidates: eventDistractorProjection.receipt.candidates
  })
);
const inferredEventState = replayState(eventDistractorFixture);
const inferredCurrent = inferredEventState.current[0];
inferredEventState.replayStore.perceptionEvents.push(normalizePerceptionEvent({
  schemaVersion: 1,
  id: "perception-current-workshop",
  accountId,
  kind: "created",
  sourceRef: inferredCurrent.sourceRef,
  eventId: "event-workshop-1",
  contentSha256: hash(inferredCurrent.text),
  occurredAt: generatedAt,
  recordedAt: generatedAt,
  permissionRevision: 1,
  perceptionVersion: "selection-replay-v1"
}));
const inferredEventProjection = workingContextProjection(inferredEventState.replayStore, {
  accountId,
  scene: "thoughtAnswer",
  task: {
    kind: "thoughtAnswer",
    text: eventDistractorFixture.task,
    targetId: eventDistractorFixture.id,
    subtargetId: "",
    eventScoped: true
  },
  currentMaterial: inferredEventState.current,
  generatedAt
});
const inferredEventSelection = inferredEventProjection.receipt.selected
  .filter(item => item.channel === "history")
  .map(item => inferredEventState.evidenceToMaterial.get(item.evidenceId)?.id);
assert.ok(inferredEventSelection.includes("capture:dedup-capture"));
assert.equal(inferredEventSelection.includes("capture:dedup-dentist"), false);
const laterBoundCurrent = [{
  ...inferredEventState.current[0],
  id: "current:unbound-leading-material",
  text: "Count the relevant occurrence.",
  sourceRef: {
    ...inferredEventState.current[0].sourceRef,
    resourceId: "unbound-leading-material"
  }
}, ...inferredEventState.current];
const laterBoundProjection = workingContextProjection(inferredEventState.replayStore, {
  accountId,
  scene: "thoughtAnswer",
  task: {
    kind: "thoughtAnswer",
    text: eventDistractorFixture.task,
    targetId: eventDistractorFixture.id,
    subtargetId: "",
    eventScoped: true
  },
  currentMaterial: laterBoundCurrent,
  generatedAt
});
assert.ok(laterBoundProjection.receipt.selected.some(item => (
  item.evidenceId
  && inferredEventState.evidenceToMaterial.get(item.evidenceId)?.id === "capture:dedup-capture"
)));
const conflictingCurrentEventStore = structuredClone(inferredEventState.replayStore);
conflictingCurrentEventStore.perceptionEvents.push(normalizePerceptionEvent({
  schemaVersion: 1,
  id: "perception-current-dentist",
  accountId,
  kind: "created",
  sourceRef: laterBoundCurrent[0].sourceRef,
  eventId: "event-dentist-1",
  contentSha256: hash(laterBoundCurrent[0].text),
  occurredAt: generatedAt,
  recordedAt: generatedAt,
  permissionRevision: 1,
  perceptionVersion: "selection-replay-v1"
}));
const conflictingCurrentEventProjection = workingContextProjection(conflictingCurrentEventStore, {
  accountId,
  scene: "thoughtAnswer",
  task: {
    kind: "thoughtAnswer",
    text: eventDistractorFixture.task,
    targetId: eventDistractorFixture.id,
    subtargetId: "",
    eventScoped: true
  },
  currentMaterial: laterBoundCurrent,
  generatedAt
});
assert.equal(
  conflictingCurrentEventProjection.receipt.selected.some(item => item.channel === "history"),
  false,
  "multiple current event identities must fail closed"
);
const conflictingEventHistory = structuredClone(inferredEventState.replayStore);
conflictingEventHistory.perceptionEvents.push(normalizePerceptionEvent({
  schemaVersion: 1,
  id: "perception-current-conflict",
  accountId,
  kind: "updated",
  sourceRef: inferredEventState.current[0].sourceRef,
  eventId: "event-dentist-1",
  contentSha256: hash(inferredEventState.current[0].text),
  occurredAt: generatedAt,
  recordedAt: generatedAt,
  permissionRevision: 1,
  perceptionVersion: "selection-replay-v1"
}));
const conflictingEventHistoryProjection = workingContextProjection(conflictingEventHistory, {
  accountId,
  scene: "thoughtAnswer",
  task: {
    kind: "thoughtAnswer",
    text: eventDistractorFixture.task,
    targetId: eventDistractorFixture.id,
    subtargetId: "",
    eventScoped: true
  },
  currentMaterial: inferredEventState.current,
  generatedAt
});
assert.equal(
  conflictingEventHistoryProjection.receipt.selected.some(item => item.channel === "history"),
  false,
  "multiple event identities for one current source version must fail closed"
);
const versionedCurrentEvents = structuredClone(inferredEventState.replayStore);
const versionTwoCurrent = {
  ...inferredEventState.current[0],
  id: "current:dedup-task-v2",
  sourceRef: {
    ...inferredEventState.current[0].sourceRef,
    version: 2
  }
};
versionedCurrentEvents.perceptionEvents.push(normalizePerceptionEvent({
  schemaVersion: 1,
  id: "perception-current-v2",
  accountId,
  kind: "updated",
  sourceRef: versionTwoCurrent.sourceRef,
  eventId: "event-dentist-1",
  contentSha256: hash(versionTwoCurrent.text),
  occurredAt: generatedAt,
  recordedAt: generatedAt,
  permissionRevision: 1,
  perceptionVersion: "selection-replay-v1"
}));
const versionedCurrentProjection = workingContextProjection(versionedCurrentEvents, {
  accountId,
  scene: "thoughtAnswer",
  task: {
    kind: "thoughtAnswer",
    text: eventDistractorFixture.task,
    targetId: eventDistractorFixture.id,
    subtargetId: "",
    eventScoped: true
  },
  currentMaterial: [inferredEventState.current[0], versionTwoCurrent],
  generatedAt
});
assert.equal(
  versionedCurrentProjection.receipt.selected.some(item => item.channel === "history"),
  false,
  "multiple versions of one current source must not collapse their event identities"
);
const staleCurrentEvent = structuredClone(inferredEventState.current);
staleCurrentEvent[0].sourceRef.version = 2;
const staleCurrentEventProjection = workingContextProjection(inferredEventState.replayStore, {
  accountId,
  scene: "thoughtAnswer",
  task: {
    kind: "thoughtAnswer",
    text: eventDistractorFixture.task,
    targetId: eventDistractorFixture.id,
    subtargetId: "",
    eventScoped: true
  },
  currentMaterial: staleCurrentEvent,
  generatedAt
});
assert.equal(
  staleCurrentEventProjection.receipt.selected.some(item => item.channel === "history"),
  false,
  "a stale current-source event must not bind historical evidence"
);
const chineseEventFixture = structuredClone(eventDistractorFixture);
chineseEventFixture.task = "这个事件发生了几次？";
chineseEventFixture.materials.find(item => item.channel === "current").text = "这件事出现了多少次？";
const chineseEventState = replayState(chineseEventFixture);
const chineseEventProjection = workingContextProjection(chineseEventState.replayStore, {
  accountId,
  scene: "thoughtAnswer",
  task: {
    kind: "thoughtAnswer",
    text: chineseEventFixture.task,
    targetId: chineseEventFixture.id,
    subtargetId: "",
    eventId: replayTaskEventIds.get(chineseEventFixture.id) || ""
  },
  currentMaterial: chineseEventState.current,
  generatedAt
});
const chineseEventSelection = chineseEventProjection.receipt.selected
  .filter(item => item.channel === "history")
  .map(item => chineseEventState.evidenceToMaterial.get(item.evidenceId)?.id);
assert.ok(chineseEventSelection.includes("capture:dedup-capture"));
assert.equal(chineseEventSelection.includes("capture:dedup-dentist"), false);

for (const taskText of [
  "How often did this workshop event happen?",
  "How often did that workshop event happen?",
  "How often did that workshop happen?",
  "How often did those workshops happen?",
  "How often did this happen?",
  "How often did it happen?",
  "How often was this repeated?",
  "How many times was it repeated?",
  "What happened?",
  "Tell me what happened.",
  "那件活动发生了几次？",
  "这事发生了几次？",
  "那回事发生了几次？",
  "该工作坊事件发生了几次？",
  "该事件发生了几次？",
  "这发生了几次？",
  "它发生了几次？",
  "本次发生了几次？",
  "此次发生了什么？",
  "此次事件发生了几次？"
]) {
  const ambiguousEventFixture = structuredClone(eventDistractorFixture);
  ambiguousEventFixture.task = taskText;
  ambiguousEventFixture.materials.find(item => item.channel === "current").text = taskText;
  ambiguousEventFixture.materials.push({
    id: "journal:dedup-dentist-copy",
    channel: "history",
    storeKind: "journal",
    text: "A different workshop event was copied into a journal.",
    relevant: false,
    eventId: "event-dentist-1"
  });
  const ambiguousEventState = replayState(ambiguousEventFixture);
  const ambiguousEventProjection = workingContextProjection(ambiguousEventState.replayStore, {
    accountId,
    scene: "thoughtAnswer",
    task: {
      kind: "thoughtAnswer",
      text: ambiguousEventFixture.task,
      targetId: ambiguousEventFixture.id,
      subtargetId: "",
      eventId: ""
    },
    currentMaterial: ambiguousEventState.current,
    generatedAt
  });
  assert.equal(
    ambiguousEventProjection.receipt.selected.some(item => item.channel === "history"),
    false,
    `ambiguous deictic event lookup must fail closed: ${taskText}`
  );
}
for (const taskText of [
  "这个方案有什么风险？",
  "那个目标是什么意思？"
]) {
  const ordinaryProjection = workingContextProjection(eventDistractorState.replayStore, {
    accountId,
    scene: "thoughtAnswer",
    task: {
      kind: "thoughtAnswer",
      text: taskText,
      targetId: eventDistractorFixture.id,
      subtargetId: ""
    },
    currentMaterial: [{
      ...eventDistractorState.current[0],
      text: taskText
    }],
    generatedAt
  });
  assert.equal(
    ordinaryProjection.receipt.excluded.some(item => (
      item.reasons.includes("event-reference-unresolved")
    )),
    false,
    `ordinary demonstrative query must not become an event-scoped task: ${taskText}`
  );
}

// Exercise the real permission service, including current-chain material without extracted evidence.
const permissionFixture = () => {
  const question = {
    id: "permission-root", type: "question", content: "整理当前计划", version: 1,
    createdAt: generatedAt,
    remarks: [{ id: "old-remark", text: "REVOKED_REMARK", version: 1 }],
    followUps: [
      { id: "old-followup", question: "REVOKED_QUESTION", answer: "REVOKED_ANSWER", version: 1 },
      { id: "active-followup", question: "当前明确追问", version: 1 }
    ],
    annotations: [{ id: "old-annotation", quote: "整理", text: "REVOKED_ANNOTATION", version: 1 }]
  };
  const value = {
    thoughts: [question, { id: "old-record", relatedTo: question.id, type: "record",
      content: "REVOKED_RECORD", attachmentPaths: ["/attachments/revoked.png"], version: 1 }],
    aiTasks: [], evidenceSources: [], evidencePermissions: [], perceptionEvents: []
  };
  let serial = 0;
  const runtime = createPerceptionRuntime({ getAccountId: () => accountId, now: () => generatedAt,
    createId: () => `permission-id-${++serial}` });
  const service = createPerceptionService({
    repository: { read: async () => structuredClone(value), update: async fn => fn(value) },
    runtime,
    backgroundAi: { createInStore: () => ({}), schedule: () => {} }
  });
  const ref = (resourceId, targetKey) => ({ resourceType: "thought", resourceId,
    rootId: question.id, targetKey, version: 1 });
  const build = (currentFollowUpId = "") => ({
    accountId, scene: currentFollowUpId ? "followUpAnswer" : "thoughtAnswer",
    task: { kind: currentFollowUpId ? "followUpAnswer" : "thoughtAnswer",
      targetId: question.id, subtargetId: currentFollowUpId,
      text: currentFollowUpId ? question.followUps.find(item => item.id === currentFollowUpId).question : question.content },
    currentMaterial: thoughtTaskCurrentMaterial(value, question, { accountId, currentFollowUpId }),
    generatedAt
  });
  const updatePermission = async options => options.sourceRef.targetKey.startsWith("remark:")
    // Remarks are not enumerated by the current HTTP/service source directory.
    // Use the existing runtime permission contract, not a fabricated evidence check.
    ? runtime.observeInStore(value, { ...options, expectedPermissionRevision: options.expectedRevision,
      eventKind: "permission_changed" }, () => ({}))
    : service.updatePermissions(options);
  return { value, question, service, ref, build, updatePermission };
};
const bindDerived = (fixture, receipt, id = "permission-derived") => {
  const item = { id, relatedTo: fixture.question.id, type: "answer", authorType: "ai",
    content: "合成派生输出", version: 1, sourceTaskId: `${id}-task`, contextReceipt: receipt };
  fixture.value.thoughts.push(item);
  fixture.value.aiTasks.push({ id: item.sourceTaskId, status: "succeeded", kind: "thoughtAnswer",
    targetId: fixture.question.id, subtargetId: "", resultId: id,
    contextFingerprint: workingContextReceiptFingerprint(receipt) });
  return item;
};
let permissionBoundaryCases = 0;
for (const [resourceId, targetKey, revokedText] of [
  ["old-record", "record:old-record", "REVOKED_RECORD"],
  ["old-remark", "remark:old-remark", "REVOKED_REMARK"],
  ["old-followup", "followup-question:old-followup", "REVOKED_QUESTION"],
  ["old-followup", "followup-answer:old-followup", "REVOKED_ANSWER"],
  ["old-annotation", "annotation:old-annotation", "REVOKED_ANNOTATION"]
]) {
  const fixture = permissionFixture(), sourceRef = fixture.ref(resourceId, targetKey);
  const allowed = await fixture.updatePermission({ sourceRef, contextAllowed: true,
    learningAllowed: false, expectedRevision: 0 });
  assert.equal(allowed.permission.revision, 1);
  const input = fixture.build(), before = workingContextProjection(fixture.value, input);
  assert.ok(before.prompt.includes(revokedText));
  assert.ok(before.receipt.permissionChecks.some(check => (
    check.sourceKey === sourceKey(sourceRef) && check.permissionRevision === 1
  )));
  assert.equal(before.receipt.evidenceChecks.length, 0);
  const first = bindDerived(fixture, before.receipt);
  assert.equal(contextDerivedOutputAllowed(fixture.value, first, accountId), true);
  const descendant = bindDerived(fixture,
    workingContextProjection(fixture.value, fixture.build()).receipt, "permission-descendant");
  assert.equal(contextDerivedOutputAllowed(fixture.value, descendant, accountId), true);
  const revoked = await fixture.updatePermission({ sourceRef, contextAllowed: false,
    learningAllowed: false, expectedRevision: 1 });
  assert.equal(revoked.permission.revision, 2);
  const after = workingContextProjection(fixture.value, fixture.build());
  assert.equal(after.prompt.includes(revokedText), false, targetKey);
  if (resourceId === "old-record") assert.equal(after.attachmentPaths.includes("/attachments/revoked.png"), false);
  assert.equal(contextDerivedOutputAllowed(fixture.value, first, accountId), false);
  assert.equal(contextDerivedOutputAllowed(fixture.value, descendant, accountId), false);
  assert.equal(workingContextReceiptMatches(fixture.value, before.receipt, input), false);
  assert.throws(() => workingContextProjection(fixture.value, input),
    error => error.code === "CURRENT_MATERIAL_PERMISSION_DENIED");
  // Re-authorizing cannot resurrect a result generated under an earlier revision.
  const restored = await fixture.updatePermission({ sourceRef, contextAllowed: true,
    learningAllowed: false, expectedRevision: 2 });
  assert.equal(restored.permission.revision, 3);
  assert.equal(contextDerivedOutputAllowed(fixture.value, first, accountId), false);
  assert.equal(contextDerivedOutputAllowed(fixture.value, descendant, accountId), false);
  assert.ok(workingContextProjection(fixture.value, fixture.build()).prompt.includes(revokedText));
  permissionBoundaryCases += 1;
}
const explicitFixture = permissionFixture();
const activeRootRef = explicitFixture.ref(explicitFixture.question.id, `question:${explicitFixture.question.id}`);
await explicitFixture.service.updatePermissions({ sourceRef: activeRootRef, contextAllowed: false,
  learningAllowed: false, expectedRevision: 0 });
const rootRequest = workingContextProjection(explicitFixture.value, explicitFixture.build());
assert.ok(rootRequest.prompt.includes(explicitFixture.question.content));
assert.equal(rootRequest.receipt.currentMaterial[0].authorization, "current-request");
assert.equal(rootRequest.receipt.currentMaterial[0].permissionRevision, 1);
assert.equal(contextDerivedOutputAllowed(explicitFixture.value,
  bindDerived(explicitFixture, rootRequest.receipt), accountId), false,
"an explicit request does not authorize later derived reuse");
const activeFollowUp = explicitFixture.question.followUps[1];
await explicitFixture.service.updatePermissions({
  sourceRef: explicitFixture.ref(activeFollowUp.id, `followup-question:${activeFollowUp.id}`),
  contextAllowed: false, learningAllowed: false, expectedRevision: 0
});
const followRequest = workingContextProjection(explicitFixture.value, explicitFixture.build(activeFollowUp.id));
assert.ok(followRequest.prompt.includes(activeFollowUp.question));
assert.equal(followRequest.receipt.currentMaterial.some(item => item.sourceKey === sourceKey(activeRootRef)), false);
assert.equal(followRequest.receipt.currentMaterial.find(item => item.sourceKey === sourceKey(
  explicitFixture.ref(activeFollowUp.id, `followup-question:${activeFollowUp.id}`)
)).authorization, "current-request");
assert.equal(followRequest.prompt.includes("REVOKED_RECORD"), true, "unset user material remains usable");
const spoofed = explicitFixture.build(activeFollowUp.id);
spoofed.currentMaterial.push({ ...thoughtTaskCurrentMaterial(explicitFixture.value, explicitFixture.question, { accountId })[0],
  id: "forged-current-request", authorization: "current-request" });
assert.throws(() => workingContextProjection(explicitFixture.value, spoofed),
  error => error.code === "CURRENT_MATERIAL_PERMISSION_DENIED");
const invalidPermission = permissionFixture();
const invalidRef = invalidPermission.ref("old-record", "record:old-record");
await invalidPermission.service.updatePermissions({ sourceRef: invalidRef, contextAllowed: true,
  learningAllowed: false, expectedRevision: 0 });
const validPermissionInput = invalidPermission.build();
const validReceipt = workingContextProjection(invalidPermission.value, validPermissionInput).receipt;
const legacyReceipt = structuredClone(validReceipt);
delete legacyReceipt.permissionChecks;
assert.equal(workingContextReceiptFingerprint(legacyReceipt), "");
assert.equal(contextDerivedOutputAllowed(invalidPermission.value,
  bindDerived(invalidPermission, legacyReceipt, "legacy-no-permissions"), accountId), false);
invalidPermission.value.evidencePermissions[0].accountId = "other-account";
assert.throws(() => workingContextProjection(invalidPermission.value, validPermissionInput),
  error => error.code === "CURRENT_MATERIAL_PERMISSION_INVALID");
invalidPermission.value.evidencePermissions[0].accountId = accountId;
invalidPermission.value.evidencePermissions.push(structuredClone(invalidPermission.value.evidencePermissions[0]));
assert.throws(() => workingContextProjection(invalidPermission.value, validPermissionInput),
  error => error.code === "CURRENT_MATERIAL_PERMISSION_INVALID");
invalidPermission.value.evidencePermissions.pop();
invalidPermission.value.evidencePermissions[0].revision = 0;
assert.throws(() => workingContextProjection(invalidPermission.value, validPermissionInput),
  error => error.code === "CURRENT_MATERIAL_PERMISSION_INVALID");
console.log(`Current source permission boundaries passed: ${permissionBoundaryCases} source kinds (4 service API, 1 existing remark runtime); `
  + "stale sends, direct/ancestor derived reuse, re-allow revision, explicit request isolation, unset user materials, "
  + "legacy receipts, account mismatch, duplicate and invalid permission state; externalCalls=0, ports=0.");

// Legacy receipts remain usable, but every descendant must retain their full matcher dependencies.
const legacyFixture = async (purpose = "context") => {
  const fixture = permissionFixture();
  const capture = { id: "legacy-third-source", content: "LEGACY_THIRD_SOURCE", version: 1,
    occurredOn: "2026-10-07", occurredAt: generatedAt };
  fixture.value.captures = [capture];
  const sourceRef = { resourceType: "capture", resourceId: capture.id, rootId: "", targetKey: "", version: 1 };
  await fixture.service.updatePermissions({ sourceRef, contextAllowed: true,
    learningAllowed: true, expectedRevision: 0 });
  const receipt = compactPersonalContextReceipt(personalContextProjection(fixture.value,
    { generatedAt, permissionPurpose: purpose }).receipt);
  const parent = { id: "legacy-parent", relatedTo: fixture.question.id, type: "answer", authorType: "ai",
    content: "LEGACY_PARENT_OUTPUT", version: 1, contextReceipt: receipt };
  fixture.value.thoughts.push(parent);
  assert.equal(contextDerivedOutputAllowed(fixture.value, parent, accountId), true);
  return { ...fixture, capture, sourceRef, receipt, parent };
};
let legacyBoundaryCases = 0;
for (const mutation of ["context-permission", "content", "version", "learning-permission"]) {
  const fixture = await legacyFixture(mutation === "learning-permission" ? "learning" : "context");
  const input = fixture.build();
  const before = workingContextProjection(fixture.value, input);
  assert.equal(before.receipt.legacyDependencies.length, 1);
  assert.ok(before.receipt.legacyDependencies[0].sources.some(source => source.resourceId === fixture.capture.id));
  assert.equal(before.receipt.legacyDependencies[0].sources.some(source => Object.hasOwn(source, "excerpt")), false);
  const child = bindDerived(fixture, before.receipt, `legacy-child-${mutation}`);
  child.content = "LEGACY_CHILD_OUTPUT";
  assert.equal(contextDerivedOutputAllowed(fixture.value, child, accountId), true);
  const nextInput = fixture.build();
  const descendantReceipt = workingContextProjection(fixture.value, nextInput).receipt;
  assert.equal(descendantReceipt.legacyDependencies.length, 1, "duplicate inherited receipts must be compacted, not multiplied");
  const descendant = bindDerived(fixture, descendantReceipt, `legacy-descendant-${mutation}`);
  descendant.content = "LEGACY_DESCENDANT_OUTPUT";
  assert.equal(contextDerivedOutputAllowed(fixture.value, descendant, accountId), true);
  if (mutation === "content") fixture.capture.content = "LEGACY_SOURCE_EDITED_WITHOUT_VERSION_BUMP";
  else if (mutation === "version") fixture.capture.version += 1;
  else await fixture.service.updatePermissions({ sourceRef: fixture.sourceRef,
    contextAllowed: mutation !== "context-permission", learningAllowed: mutation !== "learning-permission",
    expectedRevision: 1 });
  assert.equal(contextDerivedOutputAllowed(fixture.value, fixture.parent, accountId), false);
  assert.equal(contextDerivedOutputAllowed(fixture.value, child, accountId), false);
  assert.equal(contextDerivedOutputAllowed(fixture.value, descendant, accountId), false);
  const after = workingContextProjection(fixture.value, fixture.build());
  assert.equal(after.prompt.includes("LEGACY_PARENT_OUTPUT"), false);
  assert.equal(after.prompt.includes("LEGACY_CHILD_OUTPUT"), false);
  assert.equal(after.prompt.includes("LEGACY_DESCENDANT_OUTPUT"), false);
  assert.throws(() => workingContextProjection(fixture.value, input),
    error => error.code === "CURRENT_MATERIAL_LEGACY_STALE");
  assert.equal(workingContextReceiptMatches(fixture.value, before.receipt, input), false);
  legacyBoundaryCases += 1;
}
const mixedLegacy = await legacyFixture();
const learningReceipt = compactPersonalContextReceipt(personalContextProjection(mixedLegacy.value,
  { generatedAt, permissionPurpose: "learning" }).receipt);
mixedLegacy.value.thoughts.push({ ...mixedLegacy.parent, id: "legacy-learning-parent",
  content: "LEARNING_PARENT_OUTPUT", contextReceipt: learningReceipt });
const mixedProjection = workingContextProjection(mixedLegacy.value, mixedLegacy.build());
assert.deepEqual(new Set(mixedProjection.receipt.legacyDependencies.map(receipt => receipt.permissionPurpose || "context")),
  new Set(["context", "learning"]), "context and learning dependency matchers must both survive");
const noDependencies = structuredClone(mixedProjection.receipt);
delete noDependencies.legacyDependencies;
assert.equal(workingContextReceiptFingerprint(noDependencies), "");
const previousContract = { ...mixedProjection.receipt, version: "2026.10.08.1" };
assert.equal(workingContextReceiptFingerprint(previousContract), "");
const removedDependency = { ...mixedProjection.receipt, legacyDependencies: [] };
assert.notEqual(workingContextReceiptFingerprint(removedDependency), workingContextReceiptFingerprint(mixedProjection.receipt));
const budgetInput = mixedLegacy.build();
// Distinct valid token-limit receipts must fail at 101 unique dependencies, never be truncated to 100.
budgetInput.currentMaterial[0].legacyDependencies = Array.from({ length: 101 }, (_, index) => (
  compactPersonalContextReceipt(personalContextProjection(mixedLegacy.value,
    { generatedAt, tokenLimit: 10_000 + index }).receipt)
));
assert.throws(() => workingContextProjection(mixedLegacy.value, budgetInput),
  error => error.code === "WORKING_CONTEXT_RECEIPT_TOO_LARGE");
const byteInput = mixedLegacy.build();
byteInput.currentMaterial[0].legacyDependencies = [{ ...mixedLegacy.receipt,
  padding: "x".repeat(WORKING_CONTEXT_RECEIPT_BYTE_LIMIT) }];
assert.throws(() => workingContextProjection(mixedLegacy.value, byteInput),
  error => ["CURRENT_MATERIAL_LEGACY_INVALID", "WORKING_CONTEXT_RECEIPT_TOO_LARGE"].includes(error.code));
const duplicateInput = mixedLegacy.build();
duplicateInput.currentMaterial[0].legacyDependencies = Array.from({ length: 101 }, () => mixedLegacy.receipt);
const deduplicated = workingContextProjection(mixedLegacy.value, duplicateInput);
assert.equal(deduplicated.receipt.legacyDependencies.length, 2, "101 copies deduplicate while the separate learning receipt remains");
const malformedInput = mixedLegacy.build();
malformedInput.currentMaterial[0].legacyDependencies = [{ sources: [] }];
assert.throws(() => workingContextProjection(mixedLegacy.value, malformedInput),
  error => error.code === "CURRENT_MATERIAL_LEGACY_INVALID");
const emptyDependencies = workingContextProjection(store, options).receipt;
assert.deepEqual(emptyDependencies.legacyDependencies, []);
assert.match(workingContextReceiptFingerprint(emptyDependencies), /^[a-f0-9]{64}$/);
console.log(`Legacy dependency boundaries passed: ${legacyBoundaryCases} mutation kinds across parent/child/descendant, `
  + "full compact receipts, content/version/context/learning revocation, fingerprint binding, old-contract rejection, "
  + "mixed purposes, deduplication, 100-item/192KiB fail-closed bounds; no external calls or ports.");

console.log(
  "Task context selection checks passed: complete current chains, evidence-gated relevance, "
  + `event deduplication, degraded retrieval, receipt invalidation and 16-fixture selection replay `
  + `(relevance ${replayRelevant}/${replaySelected}, semantic misses ${replayMissing.length}).`
);
