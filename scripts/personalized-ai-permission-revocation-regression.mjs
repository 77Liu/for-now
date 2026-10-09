import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import {
  createBackgroundAi,
  createCaptureJournalWorkflows,
  createReviewChatWorkflows
} from "../src/app/index.mjs";
import { createTaskLifecycle } from "../src/modules/tasks/index.mjs";
import { eventTimeFields } from "../src/shared/time/index.mjs";

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const accountId = "permission-revocation-account";
const now = "2026-10-10T02:00:00.000Z";
const occurredAt = "2026-10-09T02:00:00.000Z";
const eventTime = eventTimeFields({ occurredAt });
const captureSourceKey = JSON.stringify(["capture", "capture-context", "", ""]);
const thoughtSourceKey = JSON.stringify([
  "thought",
  "thought-evidence",
  "thought-evidence",
  "question:thought-evidence"
]);

function createFixture() {
  return {
    journals: [{
      id: "journal-target",
      title: "目标日记",
      content: "用于生成回望的日记正文",
      tags: [],
      occurredAt,
      occurredOn: "2026-10-09",
      createdAt: occurredAt,
      updatedAt: occurredAt,
      version: 1,
      reflections: []
    }],
    captures: [{
      id: "capture-context",
      content: "允许纳入提示的状态背景",
      occurredAt,
      occurredOn: "2026-10-09",
      createdAt: occurredAt,
      version: 1
    }],
    thoughts: [{
      id: "thought-evidence",
      type: "question",
      authorType: "user",
      content: "用于分析的用户原始证据",
      tags: [],
      occurredAt,
      occurredOn: "2026-10-09",
      createdAt: occurredAt,
      version: 1,
      followUps: []
    }],
    chats: [],
    analyses: [],
    checkins: [],
    dailyRecords: [],
    actions: [],
    evidencePermissions: [
      {
        schemaVersion: 1,
        accountId,
        sourceKey: captureSourceKey,
        contextAllowed: true,
        learningAllowed: false,
        revision: 1,
        updatedAt: now
      },
      {
        schemaVersion: 1,
        accountId,
        sourceKey: thoughtSourceKey,
        contextAllowed: true,
        learningAllowed: true,
        revision: 1,
        updatedAt: now
      }
    ],
    aiTasks: [],
    notifications: []
  };
}

async function runScenario(kind) {
  const store = createFixture();
  const repository = {
    async read() {
      return structuredClone(store);
    },
    async update(operation) {
      return operation(store);
    }
  };
  let nextId = 0;
  const createId = () => `${kind}-generated-${++nextId}`;
  const tasks = createTaskLifecycle({ createId, now: () => now, hash });
  const scheduled = [];
  let ready = false;
  let generationGate = null;
  const provider = async work => {
    const gate = generationGate;
    if (!gate) throw new Error("The test provider must be paused before a task runs");
    gate.work = work;
    gate.notifyStarted();
    await gate.wait;
    return { content: `provider result for ${kind}`, reasoningContent: "synthetic reasoning" };
  };
  const baseTargets = {
    inspectIntent: () => null,
    prepare: () => null,
    save: () => null,
    result: () => null
  };
  const backgroundAi = createBackgroundAi({
    repository,
    tasks,
    notifications: {
      upsertTask() {
        return null;
      }
    },
    targets: baseTargets,
    shouldWaitForModel: (_document, input) => (
      ["journalReflection", "chat", "analysis"].includes(input?.kind) && !ready
    ),
    generate: provider,
    contextKey: () => accountId,
    dispatch: operation => scheduled.push(operation),
    onError: () => {}
  });

  let savedReflections = 0;
  let savedChats = 0;
  let savedAnalyses = 0;
  const journalRecords = {
    async get(id) {
      return store.journals.find(item => item.id === id) || null;
    },
    addReflectionInStore(document, id, input) {
      const journal = document.journals.find(item => item.id === id);
      if (!journal) return { missing: true };
      const value = { id: createId(), createdAt: now, ...input };
      journal.reflections.unshift(value);
      savedReflections += 1;
      return { value };
    }
  };
  const chatRecords = {
    saveInStore(document, input, { clientRequestId, requestHash: requestDigest }) {
      const value = {
        id: createId(),
        createdAt: now,
        ...input.eventTime,
        message: input.message,
        answer: input.answer,
        clientRequestId,
        requestHash: requestDigest
      };
      document.chats.unshift(value);
      savedChats += 1;
      return { value };
    }
  };
  const reviewRecords = {
    saveAnalysisInStore(document, input, { clientRequestId, requestHash: requestDigest }) {
      const value = {
        id: createId(),
        createdAt: now,
        ...input,
        clientRequestId,
        requestHash: requestDigest
      };
      document.analyses.unshift(value);
      savedAnalyses += 1;
      return { value };
    }
  };
  const captureJournalWorkflows = createCaptureJournalWorkflows({
    repository,
    journals: journalRecords,
    backgroundAi,
    generate: provider,
    hash,
    createId,
    coreModelReadiness: () => ({ ready }),
    today: () => "2026-10-09"
  });
  const reviewChatWorkflows = createReviewChatWorkflows({
    repository,
    chats: chatRecords,
    reviews: reviewRecords,
    backgroundAi,
    generate: provider,
    hash,
    coreModelReadiness: () => ({ ready }),
    contextKey: () => accountId,
    getAccountId: () => accountId,
    currentTime: () => Date.parse(now),
    createId
  });
  backgroundAi.registerHandler("journalReflection", captureJournalWorkflows.personalizedTaskHandler);
  backgroundAi.registerHandler("chat", reviewChatWorkflows.personalizedTaskHandler);
  backgroundAi.registerHandler("analysis", reviewChatWorkflows.personalizedTaskHandler);

  let created;
  let permissionKey;
  let expectedPromptEvidence;
  if (kind === "journalReflection") {
    created = await captureJournalWorkflows.queueReflectionIfCold({
      id: "journal-target",
      clientRequestId: "journal-reflection-revoke-permission"
    });
    permissionKey = captureSourceKey;
    expectedPromptEvidence = "允许纳入提示的状态背景";
  } else if (kind === "chat") {
    created = await reviewChatWorkflows.queueChatIfCold({
      message: "请结合我最近的记录回答",
      eventTime,
      eventTimeHash: occurredAt,
      clientRequestId: "chat-revoke-permission"
    });
    permissionKey = captureSourceKey;
    expectedPromptEvidence = "允许纳入提示的状态背景";
  } else {
    created = await reviewChatWorkflows.queueAnalysisIfCold({
      reason: "manual",
      clientRequestId: "analysis-revoke-permission"
    });
    permissionKey = thoughtSourceKey;
    expectedPromptEvidence = "用于分析的用户原始证据";
  }

  assert.ok(created?.task, `${kind} must create a durable cold-start task`);
  const task = created.task;
  assert.equal(task.status, "waiting_for_user_model");
  ready = true;
  await backgroundAi.releaseWaiting();
  assert.equal(task.status, "queued", `${kind} must be promoted when readiness is restored`);

  const handler = kind === "journalReflection"
    ? captureJournalWorkflows.personalizedTaskHandler
    : reviewChatWorkflows.personalizedTaskHandler;
  const initialWork = handler.prepare(structuredClone(store), task);
  assert.ok(initialWork, `${kind} must prepare work after readiness`);
  assert.ok(
    initialWork.prompt?.includes(expectedPromptEvidence),
    `${kind} must actually use the source whose permission will be revoked`
  );
  const initialFingerprint = initialWork.contextFingerprint || "";

  let notifyStarted;
  let resumeProvider;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const wait = new Promise(resolve => { resumeProvider = resolve; });
  generationGate = { notifyStarted, wait, work: null };
  const running = backgroundAi.run(task.id);
  let timeoutId;
  await Promise.race([
    started,
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${kind} did not reach the provider`)), 5000);
    })
  ]);
  clearTimeout(timeoutId);
  assert.equal(task.status, "running");
  assert.equal(generationGate.work.kind, kind);

  const permissionBefore = store.evidencePermissions.find(item => item.sourceKey === permissionKey);
  assert.ok(permissionBefore);
  assert.equal(
    kind === "analysis" ? permissionBefore.learningAllowed : permissionBefore.contextAllowed,
    true,
    `${kind} must begin with the relevant permission enabled`
  );
  await repository.update(document => {
    const permission = document.evidencePermissions.find(item => item.sourceKey === permissionKey);
    permission.contextAllowed = false;
    permission.learningAllowed = false;
    permission.revision += 1;
    permission.updatedAt = "2026-10-10T02:00:01.000Z";
  });

  const afterRevocationWork = handler.prepare(structuredClone(store), task);
  const fingerprintChanged = Boolean(initialFingerprint)
    && initialFingerprint !== (afterRevocationWork?.contextFingerprint || "");
  resumeProvider();
  await running;
  generationGate = null;

  const savedCount = kind === "journalReflection"
    ? savedReflections
    : kind === "chat" ? savedChats : savedAnalyses;
  return {
    kind,
    status: task.status,
    errorCode: task.errorCode || "",
    resultId: task.resultId || "",
    savedCount,
    fingerprintChanged,
    initialFingerprintPresent: Boolean(initialFingerprint),
    providerStarted: true
  };
}

const results = [];
for (const kind of ["journalReflection", "chat", "analysis"]) {
  results.push(await runScenario(kind));
}

const failures = [];
for (const result of results) {
  const passed = result.status === "stale" && !result.resultId && result.savedCount === 0;
  console.log(`${passed ? "通过" : "失败"} ${result.kind}: provider 已启动；状态=${result.status}；errorCode=${result.errorCode || "(空)"}；保存数=${result.savedCount}；指纹变化=${result.fingerprintChanged}`);
  if (!passed) failures.push(result);
}

if (failures.length) {
  for (const result of failures) {
    console.error(
      `${result.kind} 权限撤销合同失败：期望 provider 已启动后任务转为 stale，且不创建结果。`
    );
  }
  process.exitCode = 1;
} else {
  console.log("专项撤权回归通过：三个场景均在 provider 运行期间撤权后 stale，且没有持久化结果。");
}
