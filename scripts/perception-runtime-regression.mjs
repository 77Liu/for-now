import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import "./prompt-test-setup.mjs";
import {
  createAiTaskTargets,
  createBackgroundAi,
  createEmptyStore,
  createPerceptionAwareRepository,
  createPerceptionRuntime,
  createPerceptionService
} from "../src/app/index.mjs";
import { createNotificationService } from "../src/modules/notifications/index.mjs";
import { createTaskLifecycle } from "../src/modules/tasks/index.mjs";
import {
  deduplicateEvidenceByEvent,
  evidenceSourceKey,
  normalizeEvidenceSource
} from "../src/modules/user-model/index.mjs";
import { createJsonStoreRepository } from "../src/shared/persistence/index.mjs";

const clone = value => structuredClone(value);
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const sourceRef = (id, version) => ({
  resourceType: "capture",
  resourceId: id,
  rootId: "",
  targetKey: "",
  version
});

let store = createEmptyStore();
let accountId = "account-a";
let sequence = 0;
let second = 0;
let commits = 0;
const scheduled = [];
const modelWork = [];
let generated = JSON.stringify({
  evidence: [{
    origin: "user",
    informationType: "user_viewpoint",
    span: [0, 4]
  }]
});
let preflightStarted = null;
let preflightBarrier = null;
let generationStarted = null;
let generationBarrier = null;

const baseRepository = {
  async read() {
    return clone(store);
  },
  async update(operation) {
    const draft = clone(store);
    const result = await operation(draft);
    store = draft;
    commits += 1;
    await result?.[Symbol.for("for-now.after-commit")]?.();
    return clone(result);
  },
  async executeIdempotent(_request, operation) {
    const draft = clone(store);
    const result = await operation(draft);
    store = draft;
    commits += 1;
    return clone(result);
  }
};

const now = () => new Date(Date.UTC(2026, 9, 7, 8, 0, second++)).toISOString();
const createId = () => `perception-test-${++sequence}`;
const perceptionRuntime = createPerceptionRuntime({
  getAccountId: () => accountId,
  createId,
  now,
  hash
});
let backgroundAi;
const repository = createPerceptionAwareRepository({
  repository: baseRepository,
  perception: perceptionRuntime,
  createTask: (document, input) => backgroundAi.createInStore(document, input),
  scheduleTask: taskId => backgroundAi.schedule(taskId)
});
const targets = createAiTaskTargets({
  thoughts: {},
  annotations: {},
  perception: perceptionRuntime,
  getAccountId: () => accountId,
  hash,
  now
});
backgroundAi = createBackgroundAi({
  repository,
  tasks: createTaskLifecycle({ createId, now, hash }),
  notifications: createNotificationService({ createId, now }),
  targets,
  generate: async (work, { isCurrent } = {}) => {
    preflightStarted?.();
    if (preflightBarrier) await preflightBarrier;
    if (typeof isCurrent === "function" && !await isCurrent()) {
      throw Object.assign(new Error("stale before provider"), {
        code: "AI_TASK_STALE"
      });
    }
    modelWork.push(clone(work));
    generationStarted?.();
    if (generationBarrier) await generationBarrier;
    return { content: generated, reasoningContent: "must-not-persist" };
  },
  dispatch: callback => scheduled.push(callback),
  contextKey: () => accountId,
  onError: error => {
    throw error;
  }
});
const perception = createPerceptionService({
  repository,
  runtime: perceptionRuntime,
  backgroundAi
});

await repository.update(document => {
  document.captures.unshift({
    id: "capture-a",
    content: "专注学习",
    occurredAt: "2026-10-07T07:00:00.000Z",
    createdAt: "2026-10-07T07:00:00.000Z",
    version: 1
  });
  return { value: document.captures[0] };
});
assert.equal(commits, 1);
assert.equal(store.captures.length, 1);
assert.equal(store.perceptionEvents.length, 1);
assert.equal(store.evidencePermissions.length, 1);
assert.equal(store.evidencePermissions[0].contextAllowed, true);
assert.equal(store.evidencePermissions[0].learningAllowed, false);
assert.equal(store.aiTasks.length, 0);
assert.equal(scheduled.length, 0);

const enabled = await perception.observe({
  sourceRef: sourceRef("capture-a", 1),
  contextAllowed: true,
  learningAllowed: true,
  eventKind: "permission_changed"
});
assert.equal(enabled.task.kind, "perceptionExtraction");
assert.equal(enabled.task.resourceType, "capture");
assert.equal(enabled.task.internal, true);
assert.equal(store.evidencePermissions[0].revision, 2);
assert.equal(enabled.event.occurredAt, "2026-10-07T07:00:00.000Z");
assert.equal(store.aiTasks.length, 1);
assert.equal(store.notifications.length, 0);
assert.equal(scheduled.length, 1);
assert.deepEqual(await backgroundAi.enqueue({
  kind: " perceptionExtraction ",
  resourceType: "capture",
  targetId: "capture-a",
  inputVersion: 1,
  payload: enabled.task.payload,
  clientRequestId: "public-perception-attempt"
}), { unsupported: true });

await backgroundAi.run(enabled.task.id);
assert.equal(store.aiTasks[0].status, "succeeded");
assert.equal(store.evidenceSources.length, 1);
assert.equal(store.evidenceSources[0].accountId, "account-a");
assert.equal(
  normalizeEvidenceSource(store.evidenceSources[0]).sourceTaskId,
  enabled.task.id
);
assert.equal(store.evidenceSources[0].sourceRef.resourceType, "capture");
assert.deepEqual(store.evidenceSources[0].span, [0, 4]);
assert.equal(modelWork.length, 1);
assert.equal(modelWork[0].scene, "perceptionExtraction");
assert.equal(modelWork[0].json, true);
assert.match(modelWork[0].prompt, /perceptionExtraction/);
assert.equal((await backgroundAi.list()).items.length, 0);
assert.equal(store.notifications.length, 0);

await repository.update(document => {
  const capture = document.captures[0];
  capture.content = "第一版修改";
  capture.version = 2;
  capture.updatedAt = now();
  return { value: capture };
});
const staleBeforeCall = store.aiTasks.find(task => (
  task.kind === "perceptionExtraction" && task.inputVersion === 2
));
assert.ok(staleBeforeCall);
await repository.update(document => {
  const capture = document.captures[0];
  capture.content = "第二版修改";
  capture.version = 3;
  capture.updatedAt = now();
  return { value: capture };
});
const currentTask = store.aiTasks.find(task => (
  task.kind === "perceptionExtraction" && task.inputVersion === 3
));
assert.ok(currentTask);
await backgroundAi.run(staleBeforeCall.id);
assert.equal(store.aiTasks.find(task => task.id === staleBeforeCall.id).status, "stale");
assert.equal(modelWork.length, 1);
generated = JSON.stringify({
  evidence: [{
    origin: "user",
    informationType: "user_fact",
    span: [0, 3]
  }]
});
await backgroundAi.run(currentTask.id);
assert.equal(store.aiTasks.find(task => task.id === currentTask.id).status, "succeeded");
assert.equal(modelWork.length, 2);

await repository.update(document => {
  const capture = document.captures[0];
  capture.content = "供应商调用前修改";
  capture.version = 4;
  capture.updatedAt = now();
  return { value: capture };
});
const preflightTask = store.aiTasks.find(task => (
  task.kind === "perceptionExtraction" && task.inputVersion === 4
));
let releasePreflight;
preflightBarrier = new Promise(resolve => {
  releasePreflight = resolve;
});
const reachedPreflight = new Promise(resolve => {
  preflightStarted = resolve;
});
const preflightRun = backgroundAi.run(preflightTask.id);
await reachedPreflight;
await repository.update(document => {
  const capture = document.captures[0];
  capture.content = "供应商调用前已经变化";
  capture.version = 5;
  capture.updatedAt = now();
  return { value: capture };
});
releasePreflight();
await preflightRun;
preflightBarrier = null;
preflightStarted = null;
assert.equal(store.aiTasks.find(task => task.id === preflightTask.id).status, "stale");
assert.equal(modelWork.length, 2);

const lateTask = store.aiTasks.find(task => (
  task.kind === "perceptionExtraction" && task.inputVersion === 5
));
let releaseGeneration;
generationBarrier = new Promise(resolve => {
  releaseGeneration = resolve;
});
const started = new Promise(resolve => {
  generationStarted = resolve;
});
const lateRun = backgroundAi.run(lateTask.id);
await started;
await repository.update(document => {
  const capture = document.captures[0];
  capture.content = "生成期间修改后";
  capture.version = 6;
  capture.updatedAt = now();
  return { value: capture };
});
releaseGeneration();
await lateRun;
generationBarrier = null;
generationStarted = null;
assert.equal(store.aiTasks.find(task => task.id === lateTask.id).status, "stale");
assert.equal(store.evidenceSources.some(item => item.sourceRef.version === 5), false);

generated = "{invalid-json";
const newestTask = store.aiTasks.find(task => (
  task.kind === "perceptionExtraction" && task.inputVersion === 6
));
await backgroundAi.run(newestTask.id);
assert.equal(store.aiTasks.find(task => task.id === newestTask.id).status, "failed");
assert.equal(store.captures[0].content, "生成期间修改后");
generated = JSON.stringify({ evidence: [] });
assert.deepEqual(await backgroundAi.retry(newestTask.id), { missing: true });
const retried = await backgroundAi.retryInternal(newestTask.id);
assert.equal(retried.duplicate, false);
assert.equal(retried.task.retryOf, newestTask.id);
await backgroundAi.run(retried.task.id);
assert.equal(store.aiTasks.find(task => task.id === retried.task.id).status, "succeeded");

await repository.update(document => {
  const capture = document.captures[0];
  capture.content = "等待重启恢复";
  capture.version = 7;
  capture.updatedAt = now();
  return { value: capture };
});
const recoverable = store.aiTasks.find(task => (
  task.kind === "perceptionExtraction" && task.inputVersion === 7
));
scheduled.length = 0;
await backgroundAi.resume();
assert.equal(scheduled.length, 1);
await backgroundAi.run(recoverable.id);
assert.equal(store.aiTasks.find(task => task.id === recoverable.id).status, "succeeded");

await repository.update(document => {
  const capture = document.captures[0];
  capture.content = "重启时正在执行";
  capture.version = 8;
  capture.updatedAt = now();
  return { value: capture };
});
const interrupted = store.aiTasks.find(task => (
  task.kind === "perceptionExtraction" && task.inputVersion === 8
));
await repository.update(document => {
  const task = document.aiTasks.find(item => item.id === interrupted.id);
  task.status = "running";
  task.startedAt = now();
  return task;
});
scheduled.length = 0;
await backgroundAi.resume();
assert.equal(store.aiTasks.find(task => task.id === interrupted.id).status, "failed");
assert.equal(scheduled.length, 1);
const recoveredRetry = store.aiTasks.find(task => task.retryOf === interrupted.id);
assert.ok(recoveredRetry);
assert.equal(recoveredRetry.recoveryAttempt, 1);
await repository.update(document => {
  const task = document.aiTasks.find(item => item.id === recoveredRetry.id);
  task.status = "running";
  task.startedAt = now();
  return task;
});
scheduled.length = 0;
await backgroundAi.resume();
assert.equal(store.aiTasks.find(task => task.id === recoveredRetry.id).status, "failed");
assert.equal(scheduled.length, 1);
const secondRecoveredRetry = store.aiTasks.find(task => task.retryOf === recoveredRetry.id);
assert.ok(secondRecoveredRetry);
assert.equal(secondRecoveredRetry.recoveryAttempt, 2);
await backgroundAi.run(secondRecoveredRetry.id);
assert.equal(store.aiTasks.find(task => task.id === secondRecoveredRetry.id).status, "succeeded");

const captureEvent = store.perceptionEvents.findLast(item => (
  item.sourceRef.resourceType === "capture"
  && item.sourceRef.resourceId === "capture-a"
));
await repository.update(document => {
  document.journals.unshift({
    id: "journal-same-event",
    title: "",
    content: "重启时正在执行",
    occurredAt: "2026-10-07T07:00:00.000Z",
    createdAt: "2026-10-07T07:00:00.000Z",
    version: 1,
    perceptionEventId: captureEvent.eventId,
    annotations: [],
    annotationDrift: [],
    reflections: []
  });
  return { value: document.journals[0] };
});
const journalEvent = store.perceptionEvents.findLast(item => (
  item.sourceRef.resourceType === "journal"
  && item.sourceRef.resourceId === "journal-same-event"
));
assert.equal(journalEvent.eventId, captureEvent.eventId);
generated = JSON.stringify({
  evidence: [{
    origin: "user",
    informationType: "user_viewpoint",
    span: [0, 4]
  }]
});
const journalEnabled = await perception.observe({
  sourceRef: {
    resourceType: "journal",
    resourceId: "journal-same-event",
    rootId: "",
    targetKey: "",
    version: 1
  },
  eventId: captureEvent.eventId,
  learningAllowed: true,
  eventKind: "permission_changed"
});
await backgroundAi.run(journalEnabled.task.id);
const sharedEventEvidence = store.evidenceSources.filter(item => (
  item.eventId === captureEvent.eventId
));
assert.ok(sharedEventEvidence.length >= 2);
assert.equal(
  deduplicateEvidenceByEvent(sharedEventEvidence).eventCount,
  1
);

await repository.update(document => {
  const capture = document.captures[0];
  capture.content = "旧感知器版本";
  capture.version = 9;
  capture.updatedAt = now();
  return { value: capture };
});
const oldVersionTask = store.aiTasks.find(task => (
  task.kind === "perceptionExtraction" && task.inputVersion === 9
));
await baseRepository.update(document => {
  const task = document.aiTasks.find(item => item.id === oldVersionTask.id);
  const event = document.perceptionEvents.find(item => (
    item.id === task.payload.perceptionEventId
  ));
  task.payload.perceptionVersion = "2026.10.06.9";
  event.perceptionVersion = "2026.10.06.9";
  return task;
});
const callsBeforeOldVersion = modelWork.length;
await backgroundAi.run(oldVersionTask.id);
assert.equal(store.aiTasks.find(task => task.id === oldVersionTask.id).status, "stale");
assert.equal(modelWork.length, callsBeforeOldVersion);

const stableRef = sourceRef("capture-stable", 1);
await repository.update(document => {
  document.evidencePermissions.push({
    schemaVersion: 1,
    accountId: "account-a",
    sourceKey: evidenceSourceKey(stableRef),
    contextAllowed: true,
    learningAllowed: true,
    revision: 1,
    updatedAt: now()
  });
  document.captures.unshift({
    id: "capture-stable",
    content: "正文没有变化",
    occurredAt: "2026-10-07T07:30:00.000Z",
    createdAt: "2026-10-07T07:30:00.000Z",
    version: 1
  });
  return { value: document.captures[0] };
});
const stableTask = store.aiTasks.find(task => (
  task.kind === "perceptionExtraction"
  && task.payload?.sourceRef?.resourceId === "capture-stable"
));
generated = JSON.stringify({
  evidence: [{
    origin: "user",
    informationType: "user_fact",
    span: [0, 4]
  }]
});
await backgroundAi.run(stableTask.id);
const tasksBeforeMetadataChange = store.aiTasks.length;
await repository.update(document => {
  const capture = document.captures.find(item => item.id === "capture-stable");
  capture.tags = ["metadata-only"];
  capture.version = 2;
  capture.updatedAt = now();
  return { value: capture };
});
assert.equal(store.aiTasks.length, tasksBeforeMetadataChange);
assert.ok(store.evidenceSources.some(item => (
  item.sourceRef.resourceId === "capture-stable"
  && item.sourceRef.version === 2
)));

const thoughtRef = {
  resourceType: "thought",
  resourceId: "thought-stable",
  rootId: "thought-stable",
  targetKey: "question:thought-stable",
  version: 1
};
await repository.update(document => {
  document.evidencePermissions.push({
    schemaVersion: 1,
    accountId: "account-a",
    sourceKey: evidenceSourceKey(thoughtRef),
    contextAllowed: true,
    learningAllowed: true,
    revision: 1,
    updatedAt: now()
  });
  document.thoughts.unshift({
    id: "thought-stable",
    type: "question",
    content: "根问题文本",
    occurredAt: "2026-10-07T07:45:00.000Z",
    createdAt: "2026-10-07T07:45:00.000Z",
    version: 1,
    annotations: [],
    followUps: []
  });
  return { value: document.thoughts[0] };
});
const thoughtTask = store.aiTasks.find(task => (
  task.kind === "perceptionExtraction"
  && task.payload?.sourceRef?.resourceId === "thought-stable"
));
await backgroundAi.run(thoughtTask.id);
const taskCountBeforeFollowUp = store.aiTasks.length;
await repository.update(document => {
  const root = document.thoughts.find(item => item.id === "thought-stable");
  root.followUps.push({
    id: "thought-follow-up",
    question: "继续追问",
    answer: "",
    createdAt: now(),
    version: 1
  });
  root.version = 2;
  root.updatedAt = now();
  return { value: root.followUps[0] };
});
assert.equal(store.aiTasks.length, taskCountBeforeFollowUp);
assert.ok(store.evidenceSources.some(item => (
  item.sourceRef.resourceId === "thought-stable"
  && item.sourceRef.version === 2
)));

const oversizedRef = sourceRef("capture-oversized", 1);
const tasksBeforeOversizedSource = store.aiTasks.length;
await repository.update(document => {
  document.evidencePermissions.push({
    schemaVersion: 1,
    accountId: "account-a",
    sourceKey: evidenceSourceKey(oversizedRef),
    contextAllowed: true,
    learningAllowed: true,
    revision: 1,
    updatedAt: now()
  });
  document.captures.unshift({
    id: "capture-oversized",
    content: "中".repeat(12_000),
    occurredAt: "2026-10-07T07:50:00.000Z",
    createdAt: "2026-10-07T07:50:00.000Z",
    version: 1
  });
  return { value: document.captures[0] };
});
assert.equal(store.captures[0].content.length, 12_000);
assert.ok(store.perceptionEvents.some(item => (
  item.sourceRef.resourceId === "capture-oversized"
)));
assert.equal(store.aiTasks.length, tasksBeforeOversizedSource);

const taskCount = store.aiTasks.length;
await repository.update(document => {
  document.captures[0].debugOnly = true;
  return { value: document.captures[0] };
});
assert.equal(store.aiTasks.length, taskCount);

const copied = clone(store);
accountId = "account-b";
assert.throws(() => perceptionRuntime.observeInStore(copied, {
  sourceRef: sourceRef("capture-a", 9),
  learningAllowed: true
}), /permission state is invalid/);
assert.equal(copied.evidenceSources.length, store.evidenceSources.length);
accountId = "account-a";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "perception-runtime-"));
try {
  const file = path.join(directory, "store.json");
  const diskSourceRef = sourceRef("capture-disk", 1);
  const seed = createEmptyStore();
  seed.evidencePermissions.push({
    schemaVersion: 1,
    accountId: "account-disk",
    sourceKey: evidenceSourceKey(diskSourceRef),
    contextAllowed: true,
    learningAllowed: true,
    revision: 1,
    updatedAt: "2026-10-07T07:00:00.000Z"
  });
  await fs.writeFile(file, JSON.stringify(seed), { mode: 0o600 });
  const diskBase = createJsonStoreRepository({
    getFile: () => file,
    readDocument: async (target, fallback) => JSON.parse(
      await fs.readFile(target, "utf8").catch(() => JSON.stringify(fallback))
    ),
    writeDocument: async (target, document) => {
      await fs.writeFile(target, JSON.stringify(document), { mode: 0o600 });
    },
    normalize: value => ({ ...createEmptyStore(), ...value }),
    emptyDocument: createEmptyStore(),
    now: () => "2026-10-07T08:30:00.000Z"
  });
  const diskPerception = createPerceptionRuntime({
    getAccountId: () => "account-disk",
    createId: () => `disk-${++sequence}`,
    now: () => "2026-10-07T08:30:00.000Z",
    hash
  });
  let diskBackground;
  const diskScheduled = [];
  const diskRepository = createPerceptionAwareRepository({
    repository: diskBase,
    perception: diskPerception,
    createTask: (document, input) => diskBackground.createInStore(document, input),
    scheduleTask: taskId => diskBackground.schedule(taskId)
  });
  const diskTargets = createAiTaskTargets({
    thoughts: {},
    annotations: {},
    perception: diskPerception,
    getAccountId: () => "account-disk",
    hash,
    now: () => "2026-10-07T08:30:00.000Z"
  });
  diskBackground = createBackgroundAi({
    repository: diskRepository,
    tasks: createTaskLifecycle({
      createId: () => `disk-${++sequence}`,
      now: () => "2026-10-07T08:30:00.000Z",
      hash
    }),
    notifications: createNotificationService({
      createId: () => `disk-${++sequence}`,
      now: () => "2026-10-07T08:30:00.000Z"
    }),
    targets: diskTargets,
    generate: async () => ({
      content: JSON.stringify({
        evidence: [{
          origin: "user",
          informationType: "user_fact",
          span: [0, 4]
        }]
      })
    }),
    dispatch: callback => diskScheduled.push(callback),
    contextKey: () => "account-disk",
    onError: error => {
      throw error;
    }
  });
  await diskRepository.update(document => {
    document.captures.unshift({
      id: "capture-disk",
      content: "持久化感知",
      occurredAt: "2026-10-07T08:00:00.000Z",
      createdAt: "2026-10-07T08:00:00.000Z",
      version: 1
    });
    return { value: document.captures[0] };
  });
  const persistedBeforeRestart = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(persistedBeforeRestart.captures.length, 1);
  assert.equal(persistedBeforeRestart.perceptionEvents.length, 1);
  assert.equal(persistedBeforeRestart.aiTasks.length, 1);
  assert.equal(persistedBeforeRestart.aiTasks[0].status, "queued");
  diskScheduled.length = 0;
  await diskBackground.resume();
  assert.equal(diskScheduled.length, 1);
  await diskBackground.run(persistedBeforeRestart.aiTasks[0].id);
  const persistedAfterRestart = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(persistedAfterRestart.aiTasks[0].status, "succeeded");
  assert.equal(
    persistedAfterRestart.evidenceSources[0].sourceTaskId,
    persistedBeforeRestart.aiTasks[0].id
  );
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

const performanceStore = createEmptyStore();
for (let index = 0; index < 5_000; index += 1) {
  const occurredAt = "2026-10-07T07:00:00.000Z";
  performanceStore.captures.push({
    id: `performance-capture-${index}`,
    content: `capture ${index}`,
    occurredAt,
    createdAt: occurredAt,
    version: 1,
    annotations: []
  });
  performanceStore.thoughts.push({
    id: `performance-thought-${index}`,
    type: "question",
    content: `thought ${index}`,
    occurredAt,
    createdAt: occurredAt,
    version: 1,
    annotations: [],
    followUps: [],
    sourceRef: {
      type: "capture",
      id: `performance-capture-${index}`,
      version: 1
    }
  });
}
const performanceRepository = createPerceptionAwareRepository({
  repository: {
    read: async () => performanceStore,
    update: async operation => operation(performanceStore),
    executeIdempotent: async (_request, operation) => operation(performanceStore)
  },
  perception: createPerceptionRuntime({
    getAccountId: () => "performance",
    now: () => "2026-10-07T08:30:00.000Z"
  }),
  createTask: () => null,
  scheduleTask: () => {}
});
const scanStartedAt = performance.now();
await performanceRepository.update(document => {
  document.unrelatedMarker = true;
  return true;
});
const scanDurationMs = performance.now() - scanStartedAt;
assert.ok(
  scanDurationMs < 750,
  `10,000-source unchanged scan took ${scanDurationMs.toFixed(1)} ms`
);
assert.equal(performanceStore.perceptionEvents.length, 0);

console.log(
  `Perception runtime checks passed: transactional source events, explicit learning permission, internal task isolation, stale-result rejection, retry recovery, account fail-closed behavior, and a 10,000-source scan in ${scanDurationMs.toFixed(1)} ms.`
);
