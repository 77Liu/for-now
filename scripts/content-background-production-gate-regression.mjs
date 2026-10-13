import "./prompt-test-setup.mjs";
import { normalizeOnboardingV2 } from "../src/modules/onboarding/index.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createContentBackground, prepareUserModelExtraction } from "../src/app/index.mjs";
import { createThoughtTaskTarget } from "../src/modules/thoughts/index.mjs";

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const clone = value => structuredClone(value);
let id = 0;
let modelCalls = 0;
let providerFails = true;
const scheduled = [];
let store = {
  aiTasks: [],
  notifications: [],
  thoughts: [{
    id: "question-1",
    type: "question",
    content: "我在考虑什么？",
    version: 1,
    contextAllowed: true,
    attachmentPaths: [],
    followUps: []
  }],
  captures: [],
  onboardingV2: null,
  userClaims: [],
  modelUnknowns: [],
  evidenceSources: [],
  evidencePermissions: []
};
const repository = {
  async read() {
    return clone(store);
  },
  async update(mutate) {
    const draft = clone(store);
    const result = await mutate(draft);
    store = draft;
    return clone(result);
  }
};
const now = () => "2026-10-10T00:00:00.000Z";
const background = createContentBackground({
  repository,
  annotationService: {},
  contentAttachments: null,
  perception: null,
  mediaRuntime: {
    speechProvider: { configured: false, supportedAsrMimeTypes: [] },
    async materializeAttachmentFiles() { return []; }
  },
  getAccountId: () => "account-1",
  backgroundContextKey: () => "account-1",
  dispatchBackground: callback => scheduled.push(callback),
  runDeepSeek: async () => {
    modelCalls += 1;
    if (providerFails) throw Object.assign(new Error("合成最终空答"), { code: "EMPTY_DEEPSEEK_CONTENT" });
    return { content: JSON.stringify({ answer: "合成回答", citations: [] }), reasoningContent: "合成推理" };
  },
  now,
  createId: () => `id-${++id}`,
  hash,
  logEvent() {},
  debugServerUrl: "",
  debugRunId: "",
  debugFetch: async () => ({ ok: true })
});

store.onboardingV2 = normalizeOnboardingV2({
  migration: { selectedFlow: "v2" },
  session: { revision: 1, answers: {
    currentContext: { rawText: "合成补充", contextAllowed: true, version: 1 }
  } }
});
const extraction = prepareUserModelExtraction(store).value;
store.aiTasks.push({ id: "core-in-flight", kind: "onboardingClaimExtraction",
  targetId: "onboarding-v2", status: "running", inputVersion: 1, inputHash: extraction.inputHash });
const waiting = await background.backgroundAi.enqueue({
  kind: "thoughtAnswer",
  targetId: "question-1",
  inputVersion: 1,
  clientRequestId: "production-gate-waiting"
});
assert.equal(waiting.task.status, "waiting_for_user_model");
assert.equal(scheduled.length, 0, "production assembly must not schedule a personalized answer before readiness");
assert.equal(modelCalls, 0, "production assembly must make no provider call before readiness");
await background.backgroundAi.run(waiting.task.id);
assert.equal(modelCalls, 0, "a waiting production task cannot be claimed by the worker");

const invalid = await background.backgroundAi.enqueue({
  kind: "thoughtAnswer",
  targetId: "missing-question",
  clientRequestId: "production-gate-invalid-target"
});
assert.equal(invalid.missing, true, "production target inspection rejects missing targets before creating a wait");
assert.equal(store.aiTasks.length, 2);


store.aiTasks.find(task => task.id === "core-in-flight").status = "queued";
await background.backgroundAi.run("core-in-flight");
assert.equal(store.aiTasks.find(task => task.id === "core-in-flight").status, "failed");
assert.equal(store.aiTasks.find(task => task.id === waiting.task.id).status, "queued",
  "抽取最终失败仍保持failed，但自动释放同账户等待回答");
assert.equal(modelCalls, 1);
assert.equal(scheduled.length, 1);
store.aiTasks.unshift({ id: "core-cancel", kind: "onboardingClaimExtraction",
  targetId: "onboarding-v2", status: "queued", inputVersion: 1, inputHash: extraction.inputHash });
store.thoughts.push({ ...store.thoughts[0], id: "question-2" });
const next = await background.backgroundAi.enqueue({ kind: "thoughtAnswer", targetId: "question-2",
  inputVersion: 1, clientRequestId: "cancel-recovery" });
assert.equal(next.task.status, "waiting_for_user_model", "旧失败不能绕过新的在途任务");
await background.backgroundAi.cancelPersisted("core-cancel");
assert.equal(store.aiTasks.find(task => task.id === next.task.id).status, "queued");
assert.equal(store.aiTasks.find(task => task.id === "core-cancel").status, "cancelled");

providerFails = false;
await background.backgroundAi.run(next.task.id);
const answerResult = await background.backgroundAi.getResult(next.task.id);
assert.equal(answerResult.task.status, "succeeded");
assert.equal(answerResult.result.content, "合成回答");
assert.equal(answerResult.result.reasoningContent, "合成推理", "对象响应的思考内容仍原样传给已有消费者");
assert.deepEqual(answerResult.result.citations, [], "引用验证后的字段仍保留");

console.log("Production background assembly keeps personalized answer tasks waiting without preparing a prompt or calling the provider, and rejects missing targets.");
