import assert from "node:assert/strict";
import { createThoughtService } from "../src/modules/thoughts/index.mjs";

const store = {
  captures: [{ id: "capture-source", content: "来源念起", version: 3 }],
  thoughts: [{
    id: "question-1",
    type: "question",
    content: "原问题",
    relatedTo: null,
    version: 1,
    remarks: [],
    followUps: [],
    annotations: [{
      id: "annotation-1",
      targetKey: "record:generated-1",
      quote: "原记录"
    }]
  }]
};
const idempotency = new Map();
const repository = {
  async read() {
    return structuredClone(store);
  },
  async update(mutator) {
    return mutator(store);
  },
  async executeIdempotent(request, operation) {
    const identity = `${request.scope}:${request.key}`;
    const existing = idempotency.get(identity);
    if (existing) {
      if (existing.requestHash !== request.requestHash) {
        throw Object.assign(new Error("same key, different body"), { code: "IDEMPOTENCY_KEY_REUSED" });
      }
      return structuredClone(existing.response);
    }
    const response = await operation(store);
    idempotency.set(identity, { requestHash: request.requestHash, response: structuredClone(response) });
    return response;
  }
};
let sequence = 0;
let timestamp = 0;
const service = createThoughtService({
  repository,
  createId: () => `generated-${++sequence}`,
  now: () => `2026-09-28T00:00:0${timestamp++}.000Z`,
  recordVersion: value => Math.max(1, Number(value) || 1),
  eventTimeFields: input => input,
  reanchorAnnotations(root, targetKey, previous, next) {
    const annotation = root.annotations?.find(item => item.targetKey === targetKey);
    if (annotation && previous !== next) annotation.reanchored = true;
  }
});

const record = await service.createBlock({
  content: "原记录",
  eventTime: { occurredAt: "2026-09-28T01:00:00.000Z", occurredOn: "2026-09-28" },
  type: "record",
  relatedTo: "question-1",
  tags: ["验证"]
});
assert.equal(record.value.authorType, "user");
assert.equal(store.thoughts[0].id, record.value.id);
assert.equal(store.thoughts.find(item => item.id === "question-1").version, 2);
const idempotentBlockInput = {
  content: "幂等内容块",
  eventTime: { occurredAt: "2026-09-28T01:00:00.000Z", occurredOn: "2026-09-28" },
  type: "record",
  relatedTo: "question-1",
  tags: ["验证"],
  attachmentPaths: ["/attachments/idempotent.png"],
  clientRequestId: "thought-block-request-1"
};
const idempotentBlock = await service.createBlock(idempotentBlockInput);
const replayedBlock = await service.createBlock(idempotentBlockInput);
assert.equal(replayedBlock.value.id, idempotentBlock.value.id);
assert.equal(store.thoughts.filter(item => item.clientRequestId === "thought-block-request-1").length, 1);
await assert.rejects(
  service.createBlock({ ...idempotentBlockInput, content: "不同内容" }),
  { code: "IDEMPOTENCY_KEY_REUSED" }
);
assert.equal((await service.createBlock({
  content: "孤儿",
  eventTime: { occurredAt: "2026-09-28T01:00:00.000Z", occurredOn: "2026-09-28" },
  type: "record",
  relatedTo: "missing",
  tags: []
})).missing, true);

const edited = await service.updateBlock({
  id: record.value.id,
  content: "更新记录",
  eventTimeInput: { occurredAt: "2026-09-28T01:01:00.000Z", occurredOn: "2026-09-28" },
  expectedVersion: 1
});
assert.equal(edited.value.version, 2);
assert.equal(store.thoughts.find(item => item.id === "question-1").annotations[0].reanchored, true);
assert.equal((await service.updateBlock({
  id: record.value.id,
  content: "不应覆盖",
  eventTimeInput: { occurredAt: "2026-09-28T01:01:00.000Z", occurredOn: "2026-09-28" },
  expectedVersion: 1
})).conflict, true);

const remark = await service.addRemark({ id: "question-1", text: "备注" });
assert.equal(remark.value.text, "备注");
assert.equal((await service.updateRemark({ id: "question-1", remarkId: remark.value.id, text: "更新备注" })).value.version, 2);

const followUp = await service.addFollowUp({ id: "question-1", question: "为什么？", answer: "" });
assert.equal(followUp.value.version, 1);
const updatedFollowUp = await service.updateFollowUp({
  id: "question-1",
  followUpId: followUp.value.id,
  hasQuestion: true,
  question: "具体为什么？",
  hasAnswer: true,
  answer: "用户回答",
  expectedVersion: 1
});
assert.equal(updatedFollowUp.value.version, 2);
assert.equal(updatedFollowUp.value.origin, "manual");
assert.equal((await service.updateFollowUp({
  id: "question-1",
  followUpId: followUp.value.id,
  hasQuestion: false,
  question: null,
  hasAnswer: true,
  answer: "过期回答",
  expectedVersion: 1
})).conflict, true);

const disposition = await service.setDisposition({ id: "question-1", disposition: "discarded" });
assert.equal(disposition.value.disposition, "discarded");
assert.equal(store.thoughts.find(item => item.id === record.value.id).disposition, "discarded");

const chainInput = {
  questionText: "链问题",
  eventTime: { occurredAt: "2026-09-28T02:00:00.000Z", occurredOn: "2026-09-28" },
  tags: ["链"],
  clientRequestId: "chain-request",
  requestHash: "chain-hash",
  idea: "初步想法",
  answer: "",
  modelDraft: "",
  modelReasoning: "",
  sourceRef: { type: "capture", id: "capture-source", version: 3 }
};
const chain = service.createChainInStore(store, chainInput);
const chainRoot = chain.items[0];
assert.equal(chainRoot.type, "question");
assert.deepEqual(chainRoot.sourceRef, { type: "capture", id: "capture-source", version: 3 });
assert.equal(chain.items[1].type, "idea");
assert.equal(service.createChainInStore(store, chainInput).duplicate, true);
assert.equal(service.createChainInStore(store, { ...chainInput, requestHash: "different" }).conflict, true);
assert.equal(service.createChainInStore(store, {
  ...chainInput,
  clientRequestId: "chain-missing-source",
  requestHash: "chain-missing-source",
  sourceRef: { type: "capture", id: "missing", version: 1 }
}).sourceMissing, true);
assert.deepEqual(service.createChainInStore(store, {
  ...chainInput,
  clientRequestId: "chain-stale-source",
  requestHash: "chain-stale-source",
  sourceRef: { type: "capture", id: "capture-source", version: 2 }
}), { sourceVersionConflict: true, currentVersion: 3 });
assert.deepEqual(service.createChainInStore(store, {
  ...chainInput,
  clientRequestId: "chain-duplicate-source",
  requestHash: "chain-duplicate-source"
}), { sourceConflict: true, rootId: chainRoot.id });
const staleChainUpdate = service.updateChainInStore(store, {
  id: chainRoot.id,
  questionText: "不应覆盖",
  tags: [],
  changesEventTime: false,
  eventTimeInput: {},
  idea: "",
  answer: "",
  hasIdea: false,
  hasAnswer: false,
  expectedVersion: 9,
  removeBlock() {}
});
assert.equal(staleChainUpdate.versionConflict, true);
const chainUpdate = service.updateChainInStore(store, {
  id: chainRoot.id,
  questionText: "链问题已更新",
  tags: ["更新"],
  changesEventTime: false,
  eventTimeInput: {},
  idea: "",
  answer: "",
  hasIdea: false,
  hasAnswer: false,
  expectedVersion: 1,
  removeBlock() {}
});
assert.equal(chainUpdate.value.version, 2);
assert.equal((await service.getChain(chainRoot.id)).blocks.length, 1);
assert.equal((await service.listChains({ limit: 1 })).items.length, 1);
assert.equal(service.saveGeneratedAnswerInStore(store, {
  id: chainRoot.id,
  clientRequestId: "answer-request",
  sourceVersion: 1,
  content: "过期回答",
  reasoningContent: ""
}).stale, true);
assert.equal(service.saveGeneratedAnswerInStore(store, {
  id: chainRoot.id,
  clientRequestId: "answer-request",
  sourceVersion: 2,
  content: "有效回答",
  reasoningContent: "独立思考"
}).value.reasoningContent, "独立思考");

console.log("Thought service checks passed: chains, repository isolation, version conflicts, annotations, remarks, follow-ups and disposition.");
