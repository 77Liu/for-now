import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import "./prompt-test-setup.mjs";
import { createOnboardingService, normalizeOnboarding, onboardingContext, defaultOnboarding } from "../src/modules/onboarding/index.mjs";
import { createThoughtTaskTarget, thoughtChainContext, stripThoughtAnswerLead, thoughtDraftInput, thoughtStarterPrompt } from "../src/modules/thoughts/index.mjs";
import { createAnnotationService, annotationExcerpt } from "../src/modules/annotations/index.mjs";
import { journalAssistPrompt, journalReflectionInput, markJournalAssistContent } from "../src/modules/journals/index.mjs";
import { userAnswerContext, diaryActivityContext, thoughtPromptContext, prepareThoughtAnswer, createAiTaskTargets } from "../src/app/index.mjs";
import { createJsonStoreRepository } from "../src/shared/persistence/index.mjs";
import { createOnboardingHttp } from "../src/http/index.mjs";

const now = () => "2026-09-29T01:00:00.000Z";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const empty = () => ({ thoughts: [], checkins: [], dailyRecords: [], captures: [], journals: [], chats: [], onboarding: structuredClone(defaultOnboarding) });
const context = new AsyncLocalStorage();
const account = () => context.getStore() || "a";
const documents = new Map([["a", empty()], ["b", empty()]]);
let rejectWrite = false, writes = 0;
const repository = createJsonStoreRepository({
  getFile: account, emptyDocument: {}, normalize: value => value,
  readDocument: async key => structuredClone(documents.get(key)),
  writeDocument: async (key, value) => {
    if (rejectWrite) throw new Error("injected write failure");
    documents.set(key, structuredClone(value)); writes++;
  }
});
const onboarding = createOnboardingService({
  repository: { update: mutate => repository.update(store => { store.onboarding = mutate(store.onboarding); return store.onboarding; }) },
  now
});
const schema = onboarding.schema();
assert.deepEqual(schema.modes.map(mode => mode.questionCount), [8, 18]);
assert.equal(schema.questions.some(question => question.options.some(option => "insight" in option)), false);
schema.questions[0].options[0].label = "cannot mutate schema";
schema.interests.length = 0;
assert.equal(onboarding.schema().questions[0].options[0].label, "先找可核对证据");
assert.equal(onboarding.schema().interests.length, 12);
const quickAnswers = Object.fromEntries(schema.questions.filter(item => item.tier === "quick").map(item => [item.id, item.options[0].value]));
const detailedAnswers = Object.fromEntries(schema.questions.map(item => [item.id, item.options[1].value]));
assert.equal(onboarding.preview({}).missing.length, 8);
assert.equal(onboarding.preview({ questionnaireMode: "detailed", answers: quickAnswers }).missing.length, 10);
assert.equal(onboarding.preview({ answers: { ...quickAnswers, evidence: "invalid" } }).missing[0], "evidence");
assert.equal(writes, 0);
assert.equal((await onboarding.save({ status: "completed", answers: {} })).code, "ONBOARDING_ANSWERS_REQUIRED");
assert.equal((await onboarding.save({ status: "dismissed" })).code, "ONBOARDING_ANSWERS_REQUIRED");
assert.equal(writes, 0);
const preview = onboarding.preview({ answers: quickAnswers, material: "MATERIAL_RAW" });
assert.match(preview.value.understanding, /不是人格定论/);
assert.equal(preview.value.understanding.includes("MATERIAL_RAW"), false);
const pending = await onboarding.save({ status: "pending", answers: { evidence: "experience" }, material: "暂存原文" });
assert.equal(pending.value.status, "pending");
assert.equal(pending.value.understanding, "");
assert.equal(onboardingContext(pending.value), "（尚未完成冷启动问卷）");

await Promise.all([
  context.run("a", () => onboarding.save({ status: "completed", answers: quickAnswers, material: "ACCOUNT_A", understanding: "用户否定旧理解", profile: { occupation: "自填职业" } })),
  context.run("b", () => onboarding.save({ status: "completed", questionnaireMode: "detailed", answers: detailedAnswers, material: "ACCOUNT_B" }))
]);
assert.equal(documents.get("a").onboarding.material, "ACCOUNT_A");
assert.equal(documents.get("b").onboarding.material, "ACCOUNT_B");
assert.equal(documents.get("a").onboarding.understanding, "用户否定旧理解");
assert.match(documents.get("b").onboarding.understanding, /详细版/);
assert.deepEqual(documents.get("a").thoughts, []);
assert.equal(documents.get("a").onboarding.updatedAt, now());
const beforeFailure = structuredClone(documents.get("a"));
rejectWrite = true;
await assert.rejects(onboarding.save({ status: "completed", answers: quickAnswers, material: "MUST_NOT_COMMIT" }), /injected write failure/);
assert.deepEqual(documents.get("a"), beforeFailure);
rejectWrite = false;
// The legacy PATCH contract replaces the whole questionnaire, including omitted fields.
const replaced = await onboarding.save({ status: "completed", answers: quickAnswers });
assert.equal(replaced.value.material, "");
assert.equal(replaced.value.profile.occupation, "");
const normalized = normalizeOnboarding({ questionnaireVersion: 99, answers: { ...quickAnswers, unknown: "x", rules: "rule" }, profile: { works: "x".repeat(13000) }, interests: Array(22).fill("阅读"), material: "x".repeat(21000), updatedAt: "invalid" });
assert.equal(normalized.questionnaireVersion, 1);
assert.equal(Object.keys(normalized.answers).length, 8);
assert.equal(normalized.profile.works.length, 12000);
assert.equal(normalized.material.length, 20000);
assert.equal(normalized.interests.length, 20);
assert.equal(normalized.updatedAt, "");
const http = createOnboardingHttp({ onboarding, bodyJson: async req => req.input, sendJson: (res, status, body) => Object.assign(res, { status, body }) });
for (const [method, pathname, input, status] of [
  ["GET", "/api/onboarding/schema", undefined, 200],
  ["POST", "/api/onboarding/preview", {}, 400],
  ["PATCH", "/api/onboarding", { status: "completed", answers: quickAnswers }, 200]
]) {
  const res = {};
  assert.equal(await http.handle({ method, input }, res, { pathname }), true);
  assert.equal(res.status, status);
}
assert.equal(await http.handle({ method: "GET" }, {}, { pathname: "/api/other" }), false);

const store = empty();
store.onboarding = { ...documents.get("a").onboarding, material: "RAW_IMPORTED", understanding: "INITIAL_INFERENCE", profile: { introduction: "RAW_INTRODUCTION" } };
const event = { occurredAt: "2026-09-28T01:02:03.000Z", occurredOn: "2026-09-28", createdAt: now() };
const root = {
  ...event, id: "root", type: "question", authorType: "user", content: "RAW_QUESTION", tags: ["用户标签"], version: 3,
  reasoningContent: "PRIVATE_REASONING",
  followUps: Array.from({ length: 65 }, (_, index) => ({ id: `follow-${index}`, version: 2, question: `RAW_FOLLOW_${index}`, answer: index % 2 ? "" : `ANSWER_FOLLOW_${index}`, reasoningContent: "PRIVATE_REASONING" })),
  annotations: [{ id: "mark", kind: "comment", targetKey: "question:root", quote: "RAW_QUESTION", start: 0, end: 12, text: "RAW_COMMENT", shenji: [{ id: "turn", message: "PREVIOUS_QUESTION", answer: "PREVIOUS_ANSWER", reasoningContent: "PRIVATE_REASONING" }] }]
};
store.thoughts = [
  root,
  { ...event, id: "idea", relatedTo: root.id, type: "idea", authorType: "user", content: "RAW_IDEA" },
  { ...event, id: "record", relatedTo: root.id, type: "record", authorType: "user", content: "RAW_RECORD" },
  { ...event, id: "user-answer", relatedTo: root.id, type: "answer", authorType: "user", content: "RAW_USER_ANSWER" },
  { ...event, id: "ai-answer", relatedTo: root.id, type: "answer", authorType: "ai", content: "AI_FINAL_ANSWER", modelDraft: "OLD_AI_DRAFT", tags: ["AI_ONLY_TAG"], reasoningContent: "PRIVATE_REASONING" },
  { ...event, id: "ai-draft", relatedTo: root.id, type: "answer", authorType: "ai", content: "", modelDraft: "AI_DRAFT_FALLBACK", reasoningContent: "PRIVATE_REASONING" }
];
store.journals = [{ ...event, title: "RAW_TITLE", content: "RAW_JOURNAL", tags: [], reflections: [{ content: "AI_REFLECTION", reasoningContent: "PRIVATE_REASONING" }] }];
store.captures = [{ ...event, content: "RAW_CAPTURE", tags: ["原始"] }];
store.chats = [{ ...event, message: "RAW_CHAT", answer: "AI_CHAT", reasoningContent: "PRIVATE_REASONING" }];
store.dailyRecords = [
  { ...event, type: "weight", measuredWeight: null, bodyFatPercent: 21, description: "RAW_HEALTH" },
  { ...event, type: "exercise", exerciseType: "力量训练", durationSeconds: 3123, activeCalories: 324, totalCalories: null },
  { ...event, type: "sleep", totalMinutes: 400, averageHeartRate: 60 },
  { ...event, type: "heartRate", minimum: 50, maximum: 100, trendAnalysis: "先升后降" }
];
const original = structuredClone(store);
const personal = userAnswerContext(store);
for (const raw of ["RAW_QUESTION", "RAW_IDEA", "RAW_RECORD", "RAW_USER_ANSWER", "RAW_JOURNAL", "RAW_CAPTURE", "RAW_IMPORTED", "RAW_INTRODUCTION", "INITIAL_INFERENCE"]) assert.ok(personal.includes(raw), raw);
for (const derived of ["AI_FINAL_ANSWER", "AI_DRAFT_FALLBACK", "AI_ONLY_TAG", "AI_REFLECTION", "AI_CHAT", "PRIVATE_REASONING", "RAW_FOLLOW_64"]) assert.equal(personal.includes(derived), false, derived);
assert.match(personal, /用户问卷原始选择/);
assert.match(personal, /可修正的初始理解/);
assert.match(personal, /总重量未填写/);
assert.match(personal, /运动时长3123秒/);
const chain = thoughtChainContext(store.thoughts, root, "follow-33");
assert.equal(chain.match(/<follow_up /g).length, 65);
assert.equal(chain.match(/current="true"/g).length, 1);
assert.match(chain, /id="follow-33" current="true"/);
for (const expected of ["RAW_QUESTION", "RAW_IDEA", "RAW_USER_ANSWER", "AI_FINAL_ANSWER", "AI_DRAFT_FALLBACK", "RAW_FOLLOW_64", "ANSWER_FOLLOW_64", "（尚未回答）"]) assert.ok(chain.includes(expected), expected);
assert.equal(chain.includes("PRIVATE_REASONING"), false);
assert.equal(chain.includes("OLD_AI_DRAFT"), false);
assert.deepEqual(store, original);
const targets = createAiTaskTargets({
  thoughts: createThoughtTaskTarget({ createId: () => "generated", now, stripThoughtAnswerLead }),
  annotations: createAnnotationService({ createId: () => "annotation", now }), hash
});
assert.equal(targets.prepare(store, { kind: "thoughtAnswer", targetId: root.id }).prompt, prepareThoughtAnswer(store, root));
assert.equal(targets.prepare(store, { kind: "followUpAnswer", targetId: root.id, subtargetId: "follow-33" }).prompt, prepareThoughtAnswer(store, root, "follow-33"));
const annotationWork = targets.prepare(store, { kind: "annotationShenji", resourceType: "thought", targetId: root.id, subtargetId: "mark", payload: { message: "CURRENT_QUESTION" } });
for (const expected of ["RAW_QUESTION", "RAW_COMMENT", "PREVIOUS_QUESTION", "PREVIOUS_ANSWER", "CURRENT_QUESTION"]) assert.ok(annotationWork.prompt.includes(expected));
assert.equal(annotationWork.prompt.includes("PRIVATE_REASONING"), false);
const excerpt = annotationExcerpt("前".repeat(1500) + "焦点" + "后".repeat(1500), { start: 1500, end: 1502, quote: "焦点" });
assert.equal(excerpt.before.length, 1000);
assert.equal(excerpt.after.length, 1000);

store.captures.push({ ...event, occurredOn: "2026-09-29", occurredAt: "2026-09-29T01:02:03.000Z", content: "FUTURE_MUST_NOT_ENTER" });
store.captures.push({ ...event, occurredOn: "2026-09-27", occurredAt: "2026-09-27T01:02:03.000Z", content: "PREVIOUS_DAY" });
const activity = diaryActivityContext(store, "2026-09-28"), starter = thoughtPromptContext(store, "2026-09-28");
assert.equal(activity.includes("FUTURE_MUST_NOT_ENTER"), false);
assert.equal(starter.text.includes("FUTURE_MUST_NOT_ENTER"), false);
assert.ok(activity.includes("PREVIOUS_DAY"));
assert.ok(starter.text.includes("RAW_CHAT"));
for (const text of [activity, starter.text, journalReflectionInput(store.journals[0]).chain]) {
  assert.equal(text.includes("PRIVATE_REASONING"), false);
  assert.equal(text.includes("AI_REFLECTION"), false);
}
assert.equal(thoughtPromptContext(empty(), "2026-09-28").hasHistory, false);
assert.match(thoughtStarterPrompt("2026-09-28", thoughtPromptContext(empty(), "2026-09-28")), /这是第一次记录/);
assert.match(diaryActivityContext(empty(), "2026-03-01"), /<previous_date>2026-02-28/);
for (const mode of ["lead", "structure", "topic"]) {
  const draft = "**原文**\n\n原文末尾\n🙂";
  assert.ok(journalAssistPrompt(activity, { mode, title: "", content: draft }).includes(draft));
  const marked = markJournalAssistContent(mode, "第一行\r\n\r\n第二行");
  assert.equal(markJournalAssistContent(mode, marked), marked);
  assert.ok(marked.includes("\n\n"));
}
assert.equal(thoughtDraftInput("原问题", "原初步想法").chain.includes("原初步想法"), true);
assert.equal(stripThoughtAnswerLead("## 核心判断\n直接内容"), "直接内容");
// Long-term background is bounded independently of the unbounded current chain.
const many = empty();
many.thoughts = Array.from({ length: 45 }, (_, i) => ({ ...event, id: `q-${i}`, type: "question", content: `QUESTION_${i}_END`, authorType: "user" }));
many.captures = Array.from({ length: 35 }, (_, i) => ({ ...event, content: `CAPTURE_${i}_END` }));
many.journals = Array.from({ length: 15 }, (_, i) => ({ ...event, content: `JOURNAL_${i}_END` }));
const bounded = userAnswerContext(many);
for (const expected of ["QUESTION_39_END", "CAPTURE_29_END", "JOURNAL_11_END"]) assert.ok(bounded.includes(expected));
for (const excluded of ["QUESTION_40_END", "CAPTURE_30_END", "JOURNAL_12_END"]) assert.equal(bounded.includes(excluded), false);
assert.equal(thoughtPromptContext(many, "2026-09-28").text.split("\n").length, 12);
console.log("Personal context checks passed: required questionnaires, original/inferred separation, account transactions, full chains, prompt parity, reasoning exclusion and date/length limits.");
