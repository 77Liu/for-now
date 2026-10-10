import assert from "node:assert/strict";
import { projectRecordCompressionTrendForUser } from "../src/app/index.mjs";
import {
  renderPersonalContextSurface,
  scrubPersonalContextSurface
} from "../public/frontend/features/personal-context/index.mjs";

const localDates = Array.from({ length: 7 }, (_, index) => `2026-10-${String(index + 4).padStart(2, "0")}`);
const sourceManifest = [
  {
    sourceId: "user-source",
    recordId: "journal-1",
    resourceType: "journal",
    subtype: "日记",
    origin: "user_original",
    version: 3,
    rootId: "",
    targetKey: ""
  },
  {
    sourceId: "ai-source",
    recordId: "generated-1",
    resourceType: "analysis",
    subtype: "AI摘要",
    origin: "ai_generated",
    version: 1
  }
];
const trend = {
  timezone: "Asia/Shanghai",
  localDates,
  coverage: {
    windowDays: 7,
    summaryDays: 2,
    missingDays: 5,
    missingDates: localDates.slice(2),
    partialDays: 1,
    truncatedDays: 0
  },
  displayDays: localDates.map((localDate, index) => index < 2 ? {
    localDate,
    status: "ready",
    completeness: index === 0 ? "partial" : "complete",
    summary: {
      sourceManifest,
      daily: {
        observations: [
          { text: "用户原始日记的整理。", sourceIds: ["user-source"] },
          { text: "不可展示的 AI 推断。", sourceIds: ["ai-source"] },
          { text: "不能用用户原文给模型推断背书。", sourceIds: ["user-source", "ai-source"] }
        ]
      },
      thoughtsIdeas: { focus: [], changes: [] },
      other: { themes: [] },
      metrics: []
    }
  } : {
    localDate,
    status: "missing",
    completeness: "unknown",
    summary: null
  }),
  displaySources: [
    {
      localDate: localDates[0],
      sourceId: "user-source",
      text: "用户亲自写下的原始日记片段。",
      recordId: "journal-1",
      resourceType: "journal",
      subtype: "日记",
      version: 3
    },
    {
      localDate: localDates[0],
      sourceId: "ai-source",
      text: "不可泄露的 AI 中间推断。",
      recordId: "generated-1",
      resourceType: "analysis",
      subtype: "AI摘要",
      version: 1
    },
    {
      localDate: localDates[1],
      sourceId: "user-source",
      text: "第二天的获准原文。",
      recordId: "journal-1",
      resourceType: "journal",
      subtype: "日记",
      version: 3
    }
  ]
};

const projected = projectRecordCompressionTrendForUser(trend);
assert.equal(projected.days.length, 7);
assert.deepEqual(projected.localDates, localDates);
assert.equal(projected.coverage.summaryDays, 2);
assert.equal(projected.coverage.missingDays, 5);
assert.deepEqual(projected.coverage.missingDates, localDates.slice(2));
assert.equal(projected.days[0].completeness, "partial");
assert.equal(projected.days[0].daily.length, 1,
  "rows sourced from AI-generated material must not be presented as user-derived summaries");
assert.equal(projected.days[0].daily[0].sources[0].resourceId, "journal-1");
assert.equal(projected.days[0].daily[0].sources[0].version, 3);
assert.equal(projected.days[0].daily[0].sources[0].excerpt, "用户亲自写下的原始日记片段。");
assert.equal(projected.days[2].status, "missing");
assert.equal(JSON.stringify(projected).includes("不可泄露的 AI 中间推断"), false);
assert.match(projected.disclosure, /AI/);
assert.match(projected.disclosure, /不代表你直接说过/);

const elements = new Map([
  ["#personal-context-summary", { innerHTML: "" }],
  ["#personal-context-record-trend", { innerHTML: "" }],
  ["#personal-context-record-trend-disclosure", { textContent: "" }]
]);
const root = {
  querySelector(selector) {
    return elements.get(selector) || null;
  }
};
const escapeMarkup = value => String(value).replace(/[&<>"']/g, char => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
})[char]);
assert.equal(renderPersonalContextSurface({
  root,
  data: {
    conclusions: [],
    recordCompressionTrend: projected,
    sources: [],
    userModel: { claims: [] },
    sourcePermissions: [],
    periodicSyntheses: []
  },
  loadState: "ready",
  snapshot: {},
  contentState: ({ title, body }) => `<p>${escapeMarkup(title)} ${escapeMarkup(body)}</p>`,
  escapeMarkup,
  plainPreview: value => value,
  formatDate: value => value || ""
}), true);
const markup = elements.get("#personal-context-record-trend").innerHTML;
assert.equal((markup.match(/data-record-compression-date=/g) || []).length, 7,
  "all seven real calendar dates must be displayed, including missing dates");
assert.match(markup, /2026-10-04/);
assert.match(markup, /2026-10-10/);
assert.match(markup, /缺失日期/);
assert.match(markup, /查看原记录/);
assert.match(markup, /用户亲自写下的原始日记片段/);
assert.doesNotMatch(markup, /不可泄露的 AI 中间推断/);
assert.match(elements.get("#personal-context-record-trend-disclosure").textContent, /不代表你直接说过/);

scrubPersonalContextSurface(root);
assert.equal(elements.get("#personal-context-record-trend").innerHTML, "",
  "account/session teardown must scrub daily summaries and source excerpts");
assert.equal(elements.get("#personal-context-record-trend-disclosure").textContent, "");

console.log("Seven-day daily summaries, permission-filtered source provenance, real coverage dates, missing dates and session scrubbing regression passed.");
