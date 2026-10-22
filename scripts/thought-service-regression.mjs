import assert from "node:assert/strict";
import {
  createThoughtService,
  thoughtChainSpeechSource
} from "../src/modules/thoughts/index.mjs";

const speechRoot = {
  id: "speech-root",
  type: "question",
  content: "**我真正要解决什么？**",
  version: 5,
  createdAt: "2026-09-28T00:00:00.000Z"
};
const speechSource = thoughtChainSpeechSource([
  {
    id: "ai-older",
    type: "answer",
    relatedTo: speechRoot.id,
    authorType: "ai",
    content: "旧专属回答",
    version: 2,
    occurredAt: "2026-09-28T00:00:00.000Z",
    createdAt: "2026-09-28T02:00:00.000Z"
  },
  {
    id: "ai-latest",
    type: "answer",
    relatedTo: speechRoot.id,
    authorType: "ai",
    content: "当前**专属回答**",
    modelDraft: "MODEL_DRAFT_MUST_NOT_APPEAR",
    reasoningContent: "REASONING_MUST_NOT_APPEAR",
    version: 4,
    occurredAt: "2026-09-28T00:00:00.000Z",
    createdAt: "2026-09-28T04:00:00.000Z"
  },
  {
    id: "conclusion-old",
    type: "answer",
    relatedTo: speechRoot.id,
    authorType: "user",
    content: "旧结论",
    version: 1,
    occurredAt: "2026-09-28T01:00:00.000Z"
  },
  speechRoot,
  {
    id: "ai-draft-only",
    type: "answer",
    relatedTo: speechRoot.id,
    authorType: "ai",
    content: "",
    modelDraft: "DRAFT_ONLY_MUST_NOT_APPEAR",
    version: 9,
    occurredAt: "2026-09-28T05:00:00.000Z"
  },
  {
    id: "conclusion-latest",
    type: "answer",
    relatedTo: speechRoot.id,
    authorType: "user",
    content: "当前结论",
    version: 3,
    occurredAt: "2026-09-28T03:00:00.000Z"
  },
  {
    id: "conclusion-discarded",
    type: "answer",
    relatedTo: speechRoot.id,
    authorType: "user",
    content: "已舍弃结论",
    disposition: "discarded",
    version: 8,
    occurredAt: "2026-09-28T06:00:00.000Z"
  }
], speechRoot.id);
assert.equal(speechSource.source, speechRoot);
assert.equal(speechSource.sourceVersion, 5);
assert.deepEqual(speechSource.sourceVersions, {
  question: { id: "speech-root", version: 5 },
  conclusion: { id: "conclusion-latest", version: 3 },
  answer: { id: "ai-latest", version: 4 }
});
assert.deepEqual(speechSource.sections, [
  { kind: "question", label: "我的问题", content: "**我真正要解决什么？**" },
  { kind: "conclusion", label: "我的结论", content: "当前结论" },
  { kind: "answer", label: "专属回答", content: "当前**专属回答**" }
]);
assert.doesNotMatch(JSON.stringify(speechSource), /REASONING_MUST_NOT_APPEAR|MODEL_DRAFT_MUST_NOT_APPEAR|DRAFT_ONLY_MUST_NOT_APPEAR/);
assert.deepEqual(
  thoughtChainSpeechSource([speechRoot], speechRoot.id).sections,
  [{ kind: "question", label: "我的问题", content: "**我真正要解决什么？**" }]
);
assert.equal(thoughtChainSpeechSource([speechRoot], "missing"), null);

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

const followUpInput = {
  id: "question-1",
  question: "为什么？",
  answer: "",
  clientRequestId: "follow-up-request-1"
};
const followUp = await service.addFollowUp(followUpInput);
assert.equal(followUp.value.version, 1);
const replayedFollowUp = await service.addFollowUp(followUpInput);
assert.equal(replayedFollowUp.value.id, followUp.value.id);
assert.equal(replayedFollowUp.duplicate, true);
assert.equal(store.thoughts.find(item => item.id === "question-1").followUps.length, 1);
assert.equal((await service.addFollowUp({
  ...followUpInput,
  question: "同一个键不应改写内容"
})).conflict, true);
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
const chainSummaryPage = await service.listChains({ limit: 1 });
assert.equal(chainSummaryPage.items.length, 1);
assert.equal(chainSummaryPage.items[0].id, chainRoot.id);
assert.equal(chainSummaryPage.items[0].preview.kind, "idea");
assert.equal(Object.hasOwn(chainSummaryPage.items[0], "blocks"), false);
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

const privateSummary = (await service.listChains({ query: "有效回答" })).items[0];
assert.equal(Object.hasOwn(privateSummary, "blocks"), false);
assert.equal(Object.hasOwn(privateSummary, "modelDraft"), false);
assert.equal(Object.hasOwn(privateSummary, "reasoningContent"), false);
assert.doesNotMatch(JSON.stringify(privateSummary), /独立思考/);

const projectionRoots = Array.from({ length: 23 }, (_, index) => ({
  id: `projection-root-${index}`,
  type: "question",
  content: index === 0
    ? `共同主题 ${"很长的问题".repeat(150)}`
    : `共同主题 问题 ${index}`,
  occurredAt: `2026-09-${String(28 - index).padStart(2, "0")}T09:00:00.000Z`,
  occurredOn: `2026-09-${String(28 - index).padStart(2, "0")}`,
  createdAt: `2026-09-${String(28 - index).padStart(2, "0")}T09:00:00.000Z`,
  tags: index === 0 ? ["搜索标签"] : [],
  remarks: index === 0 ? [{ id: "remark-search", text: "备注搜索词" }] : [],
  followUps: index === 0 ? [{ id: "follow-up-search", question: "追问搜索词", answer: "追问回答" }] : [],
  attachmentPaths: index === 0 ? ["/attachments/one.png", "/attachments/two.png"] : [],
  ...(index === 0 ? {
    sourceRef: { type: "capture", id: "capture-projection", version: 2, private: "PRIVATE_SOURCE" }
  } : {}),
  disposition: "kept",
  version: 1
}));
const projectionStore = {
  thoughts: projectionRoots.flatMap((root, index) => [
    root,
    {
      id: `projection-user-answer-${index}`,
      type: "answer",
      content: `**结论**：我的结论 ${index}`,
      authorType: "user",
      origin: "manual",
      relatedTo: root.id,
      occurredAt: root.occurredAt,
      createdAt: root.createdAt,
      disposition: "kept",
      version: 1
    },
    {
      id: `projection-ai-answer-${index}`,
      type: "answer",
      content: `公开 AI 内容 ${index}`,
      modelDraft: `PRIVATE_MODEL_DRAFT_${index}`,
      reasoningContent: `PRIVATE_REASONING_${index}`,
      contextReceipt: { private: `PRIVATE_CONTEXT_${index}` },
      authorType: "ai",
      origin: "deepseek",
      relatedTo: root.id,
      occurredAt: root.occurredAt,
      createdAt: root.createdAt,
      disposition: "kept",
      version: 1
    }
  ])
};
projectionStore.thoughts.find(item => item.id === "projection-root-22").createdAt = "2026-10-01T09:00:00.000Z";
projectionStore.thoughts.find(item => item.id === "projection-root-22").tags = ["后页标签"];
let projectionCursorScope = "account-a";
const projectionService = createThoughtService({
  repository: {
    async read() {
      return structuredClone(projectionStore);
    },
    async update(mutator) {
      return mutator(projectionStore);
    }
  },
  createId: () => "unused",
  now: () => "2026-09-29T00:00:00.000Z",
  recordVersion: value => Math.max(1, Number(value) || 1),
  eventTimeFields: input => input,
  reanchorAnnotations() {},
  getCursorScope: () => projectionCursorScope
});

const defaultProjectionPage = await projectionService.listChains();
assert.equal(defaultProjectionPage.items.length, 20);
assert.ok(defaultProjectionPage.nextId);
assert.equal((await projectionService.listChains({ limit: 99 })).items.length, 20);
assert.deepEqual(defaultProjectionPage.items[0], {
  id: "projection-root-0",
  type: "question",
  content: projectionRoots[0].content.slice(0, 600),
  contentTruncated: true,
  version: 1,
  occurredAt: projectionRoots[0].occurredAt,
  occurredOn: projectionRoots[0].occurredOn,
  createdAt: projectionRoots[0].createdAt,
  updatedAt: null,
  tags: ["搜索标签"],
  disposition: "kept",
  attachmentCount: 2,
  blockCount: 2,
  answerCount: 2,
  preview: { kind: "conclusion", content: "我的结论 0", truncated: false },
  sourceRef: { type: "capture", id: "capture-projection", version: 2 }
});
assert.doesNotMatch(
  JSON.stringify(defaultProjectionPage),
  /PRIVATE_MODEL_DRAFT|PRIVATE_REASONING|PRIVATE_CONTEXT|PRIVATE_SOURCE|"blocks"/
);
assert.equal((await projectionService.listChains({ query: "搜索标签 备注搜索词" })).items[0].id, "projection-root-0");
assert.equal((await projectionService.listChains({ query: "追问搜索词" })).items[0].id, "projection-root-0");
assert.deepEqual((await projectionService.listChains({ tag: "后页标签" })).items.map(item => item.id), ["projection-root-22"]);
assert.equal((await projectionService.listChains({ sort: "created" })).items[0].id, "projection-root-22");
const modelDraftSearch = await projectionService.listChains({ query: "PRIVATE_MODEL_DRAFT_0" });
assert.deepEqual(modelDraftSearch.items, []);
assert.doesNotMatch(JSON.stringify(modelDraftSearch), /PRIVATE_MODEL_DRAFT_0/);

const searchedFirstPage = await projectionService.listChains({ limit: 2, query: "共同 主题" });
assert.deepEqual(searchedFirstPage.items.map(item => item.id), ["projection-root-0", "projection-root-1"]);
projectionCursorScope = "account-b";
assert.equal((await projectionService.listChains({
  limit: 2,
  query: "共同 主题",
  afterId: searchedFirstPage.nextId
})).invalidCursor, true);
projectionCursorScope = "account-a";
projectionStore.thoughts.unshift({
  id: "projection-root-new",
  type: "question",
  content: "共同主题 翻页后新插入",
  createdAt: "2026-09-29T09:00:00.000Z",
  tags: [],
  disposition: "kept",
  version: 1
});
const searchedSecondPage = await projectionService.listChains({
  limit: 2,
  query: "共同 主题",
  afterId: searchedFirstPage.nextId
});
assert.deepEqual(searchedSecondPage.items.map(item => item.id), ["projection-root-2", "projection-root-3"]);
projectionStore.thoughts.find(item => item.id === "projection-root-1").content = "锚点已退出搜索";
assert.deepEqual((await projectionService.listChains({
  limit: 2,
  query: "共同 主题",
  afterId: searchedFirstPage.nextId
})).items.map(item => item.id), ["projection-root-2", "projection-root-3"]);
projectionStore.thoughts = projectionStore.thoughts.filter(item => item.id !== "projection-root-1");
assert.deepEqual((await projectionService.listChains({
  limit: 2,
  query: "共同 主题",
  afterId: searchedFirstPage.nextId
})).items.map(item => item.id), ["projection-root-2", "projection-root-3"]);
assert.equal((await projectionService.listChains({
  limit: 2,
  query: "共同",
  afterId: searchedFirstPage.nextId
})).invalidCursor, true);
assert.equal((await projectionService.listChains({ afterId: "broken" })).invalidCursor, true);
const projectionDetail = await projectionService.getChain("projection-root-0");
assert.equal(projectionDetail.blocks.length, 2);
assert.equal(projectionDetail.blocks[1].reasoningContent, undefined);
assert.equal(projectionDetail.blocks[1].modelDraft, undefined);

console.log("Thought service checks passed: chains, summary projection, search cursors, version conflicts, annotations, remarks, follow-ups and disposition.");

// F4：相同时间下1001条双向遍历，以及边界删除后的空页反向恢复。
{
  const { thoughtChainListPage } = await import("../src/modules/thoughts/index.mjs");
  for (const count of [0, 1, 20, 21, 100, 101, 121, 1001]) {
    const rows = Array.from({ length: count }, (_, index) => ({ id: `f4-${String(index).padStart(4, "0")}`, type: "question", content: "test", occurredAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z" }));
    const seen = [], pages = []; let afterId = "";
    do {
      const page = thoughtChainListPage(rows, { afterId, cursorScope: "owner-a" });
      seen.push(...page.items.map(item => item.id)); pages.push(page); afterId = page.nextId;
    } while (afterId);
    assert.equal(seen.length, count); assert.equal(new Set(seen).size, count);
    for (let index = pages.length - 1; index > 0; index -= 1) {
      const previous = thoughtChainListPage(rows, { afterId: pages[index].prevId, direction: "prev", cursorScope: "owner-a" });
      assert.deepEqual(previous.items.map(item => item.id), pages[index - 1].items.map(item => item.id));
    }
    if (count > 20) {
      const first = pages[0], removed = rows.filter(row => !first.items.some(item => item.id === row.id));
      const surviving = first.items.slice(0, -1);
      const empty = thoughtChainListPage(surviving, { afterId: first.nextId, cursorScope: "owner-a" });
      const reverse = thoughtChainListPage(surviving, { afterId: empty.prevId, direction: "prev", cursorScope: "owner-a" });
      assert.deepEqual(reverse.items.map(item => item.id), surviving.map(item => item.id));
      assert.ok(removed.length);
      const olderOnly = pages[1].items.slice(1);
      const emptyNewer = thoughtChainListPage(olderOnly, { afterId: pages[1].prevId, direction: "prev", cursorScope: "owner-a" });
      const forward = thoughtChainListPage(olderOnly, { afterId: emptyNewer.nextId, cursorScope: "owner-a" });
      assert.deepEqual(forward.items.map(item => item.id), olderOnly.map(item => item.id));
      assert.equal(thoughtChainListPage(rows, { afterId: first.nextId, cursorScope: "owner-b" }).invalidCursor, true);
    }
  }
  assert.equal(thoughtChainListPage([], { direction: "prev" }).invalidQuery, true);
}
