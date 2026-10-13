import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import {
  createCaptureJournalWorkflows,
  createReviewChatWorkflows
} from "../src/app/index.mjs";
import { evidenceSourceKey } from "../src/modules/user-model/index.mjs";

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const accountId = "compression-answer-citation-account";
const trendSource = {
  citationId: "trend:2026-10-09:journal-source",
  text: "这周三次记录了晚间散步。",
  source: {
    resourceType: "journal",
    resourceId: "journal-source",
    recordType: "日记",
    origin: "user",
    informationType: "user_original",
    version: 1
  }
};
const aiReferenceId = "ai-reference:trend-only";
const trend = {
  payload: {
    sources: [{ citationId: trendSource.citationId }],
    aiReferences: [{ text: "模型预测用户今天会疲惫", citationId: aiReferenceId }]
  },
  citationSources: [trendSource],
  historicalUserSupplement: { records: [] },
  historicalUserSupplementCitationSources: [],
  fingerprint: "trend-fingerprint"
};
const thought = {
  id: "analysis-thought",
  type: "question",
  content: "我想把晚间散步变成稳定习惯。",
  contextAllowed: true,
  disposition: "kept",
  authorType: "user",
  version: 2,
  tags: [],
  followUps: [],
  occurredAt: "2026-10-09T10:00:00.000Z",
  occurredOn: "2026-10-09",
  createdAt: "2026-10-09T10:00:00.000Z"
};
const thoughtPermissionKey = evidenceSourceKey({
  resourceType: "thought",
  resourceId: thought.id,
  rootId: thought.id,
  targetKey: "question:analysis-thought",
  version: thought.version
});

function createStore() {
  return {
    userClaims: [],
    modelUnknowns: [],
    aiTasks: [],
    evidencePermissions: [{
      schemaVersion: 1,
      accountId,
      sourceKey: thoughtPermissionKey,
      contextAllowed: true,
      learningAllowed: true,
      revision: 1,
      updatedAt: "2026-10-10T02:00:00.000Z"
    }],
    journals: [{
      id: "current-journal",
      title: "散步后的想法",
      content: "走了二十分钟，回来后心情轻松一些。",
      tags: ["散步"],
      occurredAt: "2026-10-10T01:00:00.000Z",
      occurredOn: "2026-10-10",
      createdAt: "2026-10-10T01:00:00.000Z",
      updatedAt: "2026-10-10T01:00:00.000Z",
      version: 3,
      reflections: []
    }],
    thoughts: [thought],
    captures: [],
    chats: [],
    analyses: [],
    checkins: [],
    dailyRecords: [],
    actions: [],
    quotes: [],
    keepsakes: [],
    books: [],
    experiments: [],
    customMetrics: [],
    habits: [],
    habitCheckins: [],
    notifications: []
  };
}

function createHarness() {
  const store = createStore();
  const repository = {
    async read() {
      return structuredClone(store);
    },
    async update(operation) {
      return operation(store);
    }
  };
  let id = 0;
  const createId = () => `citation-regression-${++id}`;
  const generate = async (prompt, options) => {
    if (options.scene === "diaryLead") {
      assert.equal(options.json, undefined,
        "journal assistance should remain a short plain-text suggestion workflow");
      assert.doesNotMatch(options.systemPrompt, /citationId/);
      assert.match(prompt, /\"coreUserModel\"/,
        "journal assistance still receives the stable cold-start core model");
      assert.doesNotMatch(prompt, /\"sevenDayTrend\"/,
        "journal assistance must not consume uncited seven-day trend data");
      return { content: "沿着今天的感受继续写。", reasoningContent: "synthetic" };
    }
    assert.equal(options.json, true, `${options.scene} must request JSON when it consumes trends`);
    assert.match(options.systemPrompt, /citationId/,
      `${options.scene} must receive the answer citation contract`);
    const data = [...prompt.matchAll(/<(?:working_context_data|reference_context_data) format="application\/json">([\s\S]*?)<\/(?:working_context_data|reference_context_data)>/g)]
      .map(match => JSON.parse(match[1]));
    const aliasForText = (value, text) => {
      if (Array.isArray(value)) return value.map(item => aliasForText(item, text)).find(Boolean);
      if (!value || typeof value !== "object") return null;
      if (/^r[1-9]\d*$/.test(value.citationId || "") && Object.entries(value).some(([key, item]) => (
        ["text", "content", "exactQuote"].includes(key) && typeof item === "string" && item.includes(text)
      ))) return value.citationId;
      return Object.values(value).map(item => aliasForText(item, text)).find(Boolean);
    };
    const trendAlias = aliasForText(data, trendSource.text);
    assert.ok(trendAlias, "actual supplied trend evidence has a request-local alias");
    const currentJournalId = aliasForText(data, "回来后心情轻松一些");
    const citations = [{
      citationId: trendAlias,
      exactQuote: trendSource.text
    }, {
      citationId: aiReferenceId,
      exactQuote: "模型预测用户今天会疲惫"
    }];
    if (options.scene === "diaryReflection") {
      assert.ok(currentJournalId, "current journal citation ID must be visible beside the current context");
      citations.push({
        citationId: currentJournalId,
        exactQuote: "回来后心情轻松一些"
      });
    }
    if (options.scene === "analysis") {
      assert.doesNotMatch(prompt, /analysis:question:analysis-thought:2/,
        "long analysis source IDs stay server-side");
      citations.push({
        citationId: aliasForText(data, thought.content),
        exactQuote: thought.content
      });
    }
    return {
      content: JSON.stringify({
        answer: `已验证的 ${options.scene} 合成回答。`,
        citations
      }),
      reasoningContent: "synthetic"
    };
  };
  const journals = {
    async get(targetId) {
      return store.journals.find(item => item.id === targetId) || null;
    },
    async findReflectionRequest() {
      return null;
    },
    addReflectionInStore(document, targetId, input) {
      const journal = document.journals.find(item => item.id === targetId);
      const value = { id: createId(), ...input };
      journal.reflections.unshift(value);
      return { value };
    },
    async addReflection(targetId, input) {
      return this.addReflectionInStore(store, targetId, input);
    }
  };
  const chats = {
    async findRequest() {
      return null;
    },
    saveInStore(document, input) {
      const value = { id: createId(), ...input };
      document.chats.unshift(value);
      return { value };
    },
    async save(input) {
      return { value: { id: createId(), ...input } };
    }
  };
  const reviews = {
    async findAnalysisRequest() {
      return null;
    },
    saveAnalysisInStore(document, input) {
      const value = { id: createId(), ...input };
      document.analyses.unshift(value);
      return { value };
    }
  };
  const backgroundAi = { async enqueue() { return null; } };
  let trendReads = 0;
  const workflowOptions = {
    repository,
    generate,
    hash,
    createId,
    coreModelReadiness: () => ({ ready: true }),
    getRecentTrend: () => {
      trendReads += 1;
      return structuredClone(trend);
    },
    currentTime: () => Date.parse("2026-10-10T02:00:00.000Z"),
    contextKey: () => accountId,
    getAccountId: () => accountId
  };
  return {
    store,
    getTrendReadCount: () => trendReads,
    capture: createCaptureJournalWorkflows({ ...workflowOptions, journals, backgroundAi }),
    review: createReviewChatWorkflows({ ...workflowOptions, chats, reviews, backgroundAi })
  };
}

const harness = createHarness();
const chat = await harness.review.answerChat({
  message: "这周的散步有什么线索？",
  eventTime: { occurredAt: "2026-10-10T02:00:00.000Z", occurredOn: "2026-10-10" }
});
assert.equal(chat.value.answer, "已验证的 chat 合成回答。");
assert.deepEqual(chat.value.citations.map(item => item.citationId), [trendSource.citationId]);
assert.equal(chat.value.citationStatus, "matched");

const analysis = await harness.review.runAnalysis();
assert.equal(analysis.value.content, "已验证的 analysis 合成回答。");
assert.deepEqual(analysis.value.citations.map(item => item.citationId), [
  trendSource.citationId,
  "analysis:question:analysis-thought:2"
]);

const reflection = await harness.capture.reflect({ id: "current-journal" });
assert.equal(reflection.content, "已验证的 diaryReflection 合成回答。");
assert.deepEqual(reflection.citations.map(item => item.citationId), [
  trendSource.citationId,
  "current-journal:current-journal:3"
]);
assert.equal(reflection.citationStatus, "matched");

const trendReadsBeforeAssist = harness.getTrendReadCount();
const assist = await harness.capture.assist({
  mode: "lead",
  occurredOn: "2026-10-10",
  title: "散步后的想法",
  content: "走了二十分钟，回来后心情轻松一些。"
});
assert.match(assist.content, /沿着今天的感受继续写/);
assert.equal(harness.getTrendReadCount(), trendReadsBeforeAssist,
  "the suggestion-only journal assist workflow must not read trends without a citation contract");
const preparedAssist = harness.capture.personalizedTaskHandler.prepare(harness.store, {
  kind: "journalAssist",
  targetId: "journal-draft",
  payload: {
    mode: "lead",
    occurredOn: "2026-10-10",
    title: "散步后的想法",
    content: "走了二十分钟，回来后心情轻松一些。",
    binding: {}
  },
  createdAt: "2026-10-10T02:00:00.000Z"
});
assert.ok(preparedAssist);
assert.match(preparedAssist.prompt, /\"coreUserModel\"/);
assert.doesNotMatch(preparedAssist.prompt, /\"sevenDayTrend\"/,
  "the persisted journal assist workflow must not consume uncited seven-day trend data");
assert.equal(harness.getTrendReadCount(), trendReadsBeforeAssist);

console.log("Record compression answer citation regression passed: answer citations are verified, AI-reference IDs are excluded, and plain-text journal assistance receives no trend.");
