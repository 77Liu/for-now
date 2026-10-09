import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createContentBackground } from "../src/app/index.mjs";
import { createThoughtTaskTarget } from "../src/modules/thoughts/index.mjs";

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const clone = value => structuredClone(value);
let id = 0;
let modelCalls = 0;
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
    return { content: "不应在核心模型未就绪时生成" };
  },
  now,
  createId: () => `id-${++id}`,
  hash,
  logEvent() {},
  debugServerUrl: "",
  debugRunId: "",
  debugFetch: async () => ({ ok: true })
});

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
assert.equal(store.aiTasks.length, 1);

console.log("Production background assembly keeps personalized answer tasks waiting without preparing a prompt or calling the provider, and rejects missing targets.");
