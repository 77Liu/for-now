import assert from "node:assert/strict";
import { ROUTE_STATE_LIMITS, routeStateProjection, startupProjection } from "../src/app/index.mjs";
import { createStartupHttp } from "../src/http/index.mjs";

const CURRENT_DATE = "2026-10-04";
const ROUTE_BUDGET_BYTES = 200 * 1024;
const large = `PRIVATE_HEAVY_${"x".repeat(50_000)}`;
const shiftDateKey = offset => {
  const value = new Date(`${CURRENT_DATE}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};
const occurredAt = (date, index = 0) => new Date(
  Date.parse(`${date}T08:00:00.000Z`) + index * 60_000
).toISOString();
const keysIn = value => {
  const keys = new Set();
  const visit = item => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      keys.add(key);
      visit(child);
    }
  };
  visit(value);
  return keys;
};
const assertNoPrivateFields = value => {
  const keys = keysIn(value);
  for (const field of [
    "reasoningContent",
    "modelDraft",
    "privateBlob",
    "originalPath",
    "alphaMaskPath",
    "editPath",
    "requestHash"
  ]) {
    assert.equal(keys.has(field), false, `projection leaked ${field}`);
  }
};

const thoughts = Array.from({ length: 30 }, (_, index) => {
  const id = `root-${index}`;
  return [
    {
      id,
      type: "question",
      content: `${index === 0 ? "today" : "earlier"}-${large}`,
      occurredAt: occurredAt(index === 0 ? CURRENT_DATE : shiftDateKey(-index - 1)),
      occurredOn: index === 0 ? CURRENT_DATE : shiftDateKey(-index - 1),
      tags: ["test"],
      annotations: [{ text: large }],
      followUps: [{ question: large }],
      version: 1
    },
    {
      id: `idea-${index}`,
      type: "idea",
      relatedTo: id,
      content: large,
      occurredAt: occurredAt(index === 0 ? CURRENT_DATE : shiftDateKey(-index - 1), 1),
      authorType: "user",
      reasoningContent: large,
      modelDraft: large,
      version: 1
    }
  ];
}).flat();

const customMetrics = Array.from({ length: 40 }, (_, index) => ({
  id: `metric-${index}`,
  name: `Metric ${index}-${large}`,
  low: `Low ${index}-${large}`,
  high: `High ${index}-${large}`,
  privateBlob: large
}));
const currentCheckins = Array.from({ length: 60 }, (_, index) => ({
  id: `today-${index}`,
  version: 1,
  occurredAt: occurredAt(CURRENT_DATE, index),
  occurredOn: CURRENT_DATE,
  mood: index % 5 + 1,
  energy: (index + 1) % 5 + 1,
  stress: (index + 2) % 5 + 1,
  sleep: (index + 3) % 5 + 1,
  factors: [large],
  custom: { "metric-0": index % 5 + 1 },
  notes: { mood: large },
  reasoningContent: large,
  privateBlob: large
}));
const historicalCheckins = Array.from({ length: 120 }, (_, index) => {
  const date = shiftDateKey(-index - 1);
  return {
    id: `history-${index}`,
    version: 1,
    occurredAt: occurredAt(date),
    occurredOn: date,
    mood: index % 5 + 1,
    energy: (index + 1) % 5 + 1,
    stress: (index + 2) % 5 + 1,
    sleep: (index + 3) % 5 + 1,
    factors: ["history"],
    notes: { mood: large },
    privateBlob: large
  };
});
const sparseMetricCheckin = {
  id: "sparse-metric",
  occurredAt: occurredAt(shiftDateKey(-200)),
  occurredOn: shiftDateKey(-200),
  mood: 3,
  energy: 3,
  stress: 3,
  sleep: 3,
  custom: { "metric-11": 5 },
  privateBlob: large
};
const futureCheckin = {
  id: "future",
  occurredAt: occurredAt(shiftDateKey(1)),
  occurredOn: shiftDateKey(1),
  mood: 5,
  energy: 5,
  stress: 5,
  sleep: 5,
  custom: { "metric-11": 1 }
};
const analyses = Array.from({ length: 30 }, (_, index) => ({
  id: `analysis-${index}`,
  createdAt: occurredAt(shiftDateKey(-index)),
  reason: index % 2 ? "weekly-background" : "manual",
  content: `Analysis ${index}-${large}`,
  reasoningContent: large,
  annotations: [{
    id: `annotation-${index}`,
    kind: "comment",
    targetKey: "content",
    start: 0,
    end: 8,
    quote: "Analysis",
    text: "Comment",
    createdAt: occurredAt(shiftDateKey(-index), 1),
    replies: [{ id: `reply-${index}`, text: "Reply", createdAt: occurredAt(shiftDateKey(-index), 2) }],
    shenji: [{ id: `shenji-${index}`, message: "Question", answer: "Answer", reasoningContent: large }],
    privateBlob: large
  }],
  privateBlob: large
}));
const clusters = Array.from({ length: 30 }, (_, clusterIndex) => ({
  theme: `Cluster ${clusterIndex}-${large}`,
  count: 50,
  questions: 50,
  kept: 10,
  discarded: 5,
  unreviewed: 35,
  privateBlob: large,
  items: Array.from({ length: 50 }, (_, itemIndex) => ({
    id: `cluster-${clusterIndex}-item-${itemIndex}`,
    occurredAt: occurredAt(shiftDateKey(-itemIndex)),
    occurredOn: shiftDateKey(-itemIndex),
    content: `Cluster item ${itemIndex}-${large}`,
    annotations: [{ text: large }],
    reasoningContent: large,
    modelDraft: large,
    privateBlob: large
  }))
}));
const experiments = Array.from({ length: 30 }, (_, index) => ({
  id: `experiment-${index}`,
  createdAt: occurredAt(shiftDateKey(-index)),
  hypothesis: `Hypothesis ${index}-${large}`,
  factor: `Factor ${index}-${large}`,
  outcome: "mood",
  duration: 30,
  status: "active",
  privateBlob: large
}));
const store = {
  _persistence: { sync: { cursor: 42 } },
  onboardingV2: { session: { status: "completed" }, privateDraft: large },
  notifications: [{ id: "notice", status: "succeeded", readAt: "" }],
  quotes: [
    { id: "quote-a", content: "PRIVATE_QUOTE_CONTENT", tags: ["阅读", "长期"] },
    { id: "quote-b", content: "PRIVATE_QUOTE_CONTENT", tags: ["阅读", "摘录"] }
  ]
};
const publicState = {
  checkins: [...currentCheckins, ...historicalCheckins, sparseMetricCheckin, futureCheckin],
  thoughts,
  dailyRecords: Array.from({ length: 7 }, (_, index) => ({ id: `daily-${index}` })),
  captures: Array.from({ length: 8 }, (_, index) => ({ id: `capture-${index}` })),
  journals: Array.from({ length: 9 }, (_, index) => ({ id: `journal-${index}` })),
  books: [{ id: "book", title: "Book", notes: [{ id: "note", content: "Note", occurredAt: "2026-10-03T09:00:00.000Z" }] }],
  quotes: [{ id: "quote", source: "Source", content: "Quote", occurredAt: "2026-10-02T09:00:00.000Z" }],
  keepsakes: Array.from({ length: 30 }, (_, index) => ({
    id: `keepsake-${index}`,
    title: `Keepsake ${index}-${large}`,
    note: large,
    thumbPath: `/attachments/thumb-${index}.webp`,
    originalPath: `/attachments/original-${index}.png`,
    alphaMaskPath: `/attachments/mask-${index}.png`,
    editPath: `/attachments/edit-${index}.webp`,
    ...(index === 0 ? {
      media: {
        version: 1,
        status: "failed",
        originalAvailable: true,
        retryable: true,
        list: { imagePath: "", backgroundPath: "" },
        detail: { imagePath: "", backgroundPath: "" }
      }
    } : {}),
    occurredAt: occurredAt(shiftDateKey(-index)),
    privateBlob: large
  })),
  customMetrics,
  analyses,
  experiments,
  clusters,
  insights: {
    trends: Array.from({ length: 20 }, (_, index) => ({
      metric: `metric-${index}`,
      current: index % 5 + 1,
      previous: index ? index % 5 + 1 : null,
      currentCount: 7,
      previousCount: 7,
      privateBlob: large
    })),
    associations: Array.from({ length: 20 }, (_, index) => ({
      factor: `Factor ${index}-${large}`,
      withCount: 10,
      withoutCount: 10,
      nextDayCount: 5,
      sameDay: 4,
      baseline: 3,
      nextDay: 4,
      confidence: "可观察",
      privateBlob: large
    })),
    aiOnlyThoughtIds: Array.from({ length: 1000 }, (_, index) => `root-${index}`),
    weekly: {
      checkins: 7,
      activeDays7: 7,
      pairedDays30: 3,
      rootCount30: 20,
      tracedRoots30: 10,
      traceRate30: 50,
      correctionActions30: 9,
      reviewAgeDays: 1,
      analysisCount: analyses.length,
      privateBlob: large
    },
    privateBlob: large
  },
  speech: { assets: [] },
  notificationUnread: 1
};

const startup = startupProjection({
  store,
  user: { id: "account", username: "owner", role: "owner" },
  version: "test",
  releaseVersion: "0.5.7",
  capabilities: ["ai-costs"],
  features: { incrementalSync: true },
  governanceUrl: "/platform/",
  unread: 1
});
const startupText = JSON.stringify(startup);
assert.equal(startup.accountCursor, 42);
assert.equal(startup.onboardingV2.session.status, "completed");
assert.equal(startup.notificationUnread, 1);
assert.deepEqual(startup.quoteTags, ["阅读", "长期", "摘录"]);
for (const forbidden of ["thoughts", "clusters", "keepsakes", "attachmentPath", large]) {
  assert.equal(startupText.includes(forbidden), false);
}
assert.equal(startupText.includes("PRIVATE_QUOTE_CONTENT"), false);
assert.ok(Buffer.byteLength(startupText) <= 25 * 1024);

const today = routeStateProjection(publicState, { view: "today", currentDate: CURRENT_DATE });
const todayText = JSON.stringify(today);
assert.equal(Object.hasOwn(today, "clusters"), false);
assert.equal(Object.hasOwn(today, "books"), false);
assert.equal(Object.hasOwn(today, "quotes"), false);
assert.equal(Object.hasOwn(today, "thoughts"), false);
assert.equal(today.customMetrics.length, ROUTE_STATE_LIMITS.today.customMetrics);
assert.equal(today.homeMemories.length, ROUTE_STATE_LIMITS.today.homeMemories);
assert.equal(today.keepsakes.length, ROUTE_STATE_LIMITS.today.keepsakes);
assert.equal(today.keepsakes[0].media.status, "failed");
assert.equal(today.keepsakes[0].media.list.imagePath, "");
assert.equal(
  today.checkins.filter(item => item.occurredOn === CURRENT_DATE).length,
  ROUTE_STATE_LIMITS.today.currentCheckins
);
assert.ok(
  today.checkins.length <= ROUTE_STATE_LIMITS.today.currentCheckins
    + ROUTE_STATE_LIMITS.today.trendCheckins
    + ROUTE_STATE_LIMITS.today.latestMetricCheckins
);
assert.equal(today.checkins.some(item => item.occurredOn === shiftDateKey(1)), false);
assert.equal(
  today.checkins.some(item => item.occurredOn === sparseMetricCheckin.occurredOn && item.custom?.["metric-11"] === 5),
  true
);
assert.ok(today.checkins.filter(item => item.occurredOn !== CURRENT_DATE).every(item => (
  !Object.hasOwn(item, "id")
  && !Object.hasOwn(item, "factors")
  && !Object.hasOwn(item, "notes")
)));
assertNoPrivateFields(today);
assert.equal(todayText.includes(large), false);
const todayBytes = Buffer.byteLength(todayText);
assert.ok(todayBytes <= ROUTE_BUDGET_BYTES, `today projection is ${todayBytes} bytes`);

const review = routeStateProjection(publicState, { view: "review", currentDate: CURRENT_DATE });
const reviewText = JSON.stringify(review);
assert.equal(review.checkins.length, ROUTE_STATE_LIMITS.review.checkins);
assert.equal(review.analyses.length, ROUTE_STATE_LIMITS.review.analyses);
assert.equal(review.analyses[0].contentTruncated, true);
assert.equal(review.analysisPage.total, analyses.length);
assert.equal(review.analysisPage.nextId, "analysis-7");
assert.equal(review.experiments.length, ROUTE_STATE_LIMITS.review.experiments);
assert.equal(review.customMetrics.length, ROUTE_STATE_LIMITS.review.customMetrics);
assert.equal(review.clusters.length, ROUTE_STATE_LIMITS.review.clusters);
assert.equal(review.checkins.some(item => item.id === futureCheckin.id || item.id === sparseMetricCheckin.id), false);
assert.ok(review.clusters.every(item => item.items.length <= ROUTE_STATE_LIMITS.review.clusterItems));
assert.ok(review.clusters.flatMap(item => item.items).every(item => (
  item.content.length <= ROUTE_STATE_LIMITS.review.clusterItemContentChars
)));
assert.ok(review.analyses.every(item => item.content.length <= ROUTE_STATE_LIMITS.review.analysisContentChars));
assert.equal(review.insights.trends.length, ROUTE_STATE_LIMITS.review.trends);
assert.equal(review.insights.associations.length, ROUTE_STATE_LIMITS.review.associations);
assert.equal(Object.hasOwn(review.insights, "aiOnlyThoughtIds"), false);
assert.equal(
  review.reviewSourceCount,
  publicState.checkins.length
    + publicState.dailyRecords.length
    + publicState.captures.length
    + publicState.journals.length
    + publicState.thoughts.length
);
assertNoPrivateFields(review);
assert.equal(reviewText.includes(large), false);
const reviewBytes = Buffer.byteLength(reviewText);
assert.ok(reviewBytes <= ROUTE_BUDGET_BYTES, `review projection is ${reviewBytes} bytes`);
const nextReview = routeStateProjection(publicState, {
  view: "review",
  currentDate: CURRENT_DATE,
  query: { analysisAfterId: review.analysisPage.nextId }
});
assert.equal(nextReview.analyses[0].id, "analysis-8");
assert.equal(nextReview.analysisPage.nextId, "analysis-15");
assert.equal(routeStateProjection(publicState, {
  view: "review",
  currentDate: CURRENT_DATE,
  query: { analysisAfterId: "missing-analysis" }
}).analysisPage.invalidCursor, true);

const thoughtList = routeStateProjection(publicState, {
  view: "thoughts",
  currentDate: CURRENT_DATE,
  query: { q: "earlier" }
});
assert.equal(thoughtList.thoughtPage.kind, "list");
assert.equal(thoughtList.thoughts.length, 20);
assert.ok(thoughtList.thoughtPage.nextId);
assert.deepEqual(thoughtList.thoughtPage.tags, ["test"]);
assert.equal(thoughtList.thoughtPage.sort, "occurred");
assert.ok(thoughtList.thoughts.every(item => item.type === "question" && !Object.hasOwn(item, "blocks")));
assertNoPrivateFields(thoughtList);
const restoredThoughtList = routeStateProjection(publicState, {
  view: "thoughts",
  currentDate: CURRENT_DATE,
  query: { q: "earlier", page: 2 }
});
assert.equal(restoredThoughtList.thoughts.length, 29);
assert.equal(restoredThoughtList.thoughtPage.nextId, "");
const thoughtDetail = routeStateProjection(publicState, {
  view: "thoughts",
  currentDate: CURRENT_DATE,
  resourceId: "root-0"
});
assert.equal(thoughtDetail.thoughtPage.kind, "detail");
assert.equal(thoughtDetail.thoughtPage.found, true);
assert.equal(thoughtDetail.thoughts.length, 2);
assert.equal(Object.hasOwn(thoughtDetail.thoughts[0], "blocks"), false);
assertNoPrivateFields(thoughtDetail);
const missingThoughtDetail = routeStateProjection(publicState, {
  view: "thoughts",
  currentDate: CURRENT_DATE,
  resourceId: "missing"
});
assert.equal(missingThoughtDetail.thoughtPage.found, false);
assert.deepEqual(missingThoughtDetail.thoughts, []);

const emptyReview = routeStateProjection({}, { view: "review", currentDate: CURRENT_DATE });
assert.deepEqual(
  [emptyReview.checkins, emptyReview.analyses, emptyReview.experiments, emptyReview.customMetrics, emptyReview.clusters],
  [[], [], [], [], []]
);
assert.deepEqual(emptyReview.insights, { trends: [], associations: [], weekly: {} });

for (const view of [
  "today",
  "together",
  "daily",
  "captures",
  "books",
  "quotes",
  "keepsakes",
  "journals",
  "thoughts",
  "discovery",
  "mine",
  "personal-context",
  "statistics",
  "ai-cost",
  "architecture",
  "commercialization",
  "feedback",
  "export",
  "notifications",
  "trash",
  "permission",
  "account",
  "settings",
  "about",
  "unknown"
]) {
  assert.equal(
    Object.hasOwn(routeStateProjection({ clusters: [{ theme: "hidden" }] }, { view, currentDate: CURRENT_DATE }), "clusters"),
    false,
    `${view} leaked clusters`
  );
}

const together = routeStateProjection(publicState, { view: "together", currentDate: CURRENT_DATE });
assert.equal(together.thoughts.filter(item => item.type === "question").length, 1);
assert.equal(JSON.stringify(together).includes("reasoningContent"), false);

const captures = routeStateProjection({
  ...publicState,
  captures: [{ id: "capture", content: "Capture" }],
  thoughts: [{ id: "linked", type: "question", sourceRef: { type: "capture", id: "capture" }, content: "Linked" }]
}, { view: "captures" });
assert.equal(captures.captures.length, 1);
assert.equal(captures.thoughts.length, 1);
assert.equal(Object.hasOwn(captures, "clusters"), false);

const responses = [];
const v1 = {
  success(_res, status, data) {
    responses.push({ status, data });
    return true;
  },
  error(_res, status, message, code) {
    responses.push({ status, message, code });
    return true;
  },
  nextCursor(afterId) {
    return afterId ? `encoded:${afterId}` : null;
  },
  pagination(url) {
    return { afterId: String(url.searchParams.get("cursor") || "").replace(/^encoded:/, "") };
  }
};
const http = createStartupHttp({
  readStartup: async () => startup,
  readRouteState: async route => ({
    route,
    ...(route.view === "thoughts" ? { thoughtPage: { kind: "list", nextId: "cursor-id" } } : {}),
    ...(route.view === "review" ? { analysisPage: { nextId: "analysis-cursor", total: 9 } } : {})
  })
});
assert.equal(await http.handleV1({ method: "GET" }, {}, new URL("http://local/api/v1/startup"), v1), true);
assert.equal(responses.at(-1).data.protocolVersion, 1);
assert.equal(await http.handleV1({ method: "GET" }, {}, new URL("http://local/api/v1/route-state?view=today"), v1), true);
assert.equal(responses.at(-1).data.route.view, "today");
assert.equal(await http.handleV1({ method: "GET" }, {}, new URL("http://local/api/v1/route-state?view=thoughts&q=test"), v1), true);
assert.equal(responses.at(-1).data.route.query.q, "test");
assert.match(responses.at(-1).data.thoughtPage.nextCursor, /^encoded:/);
assert.equal(Object.hasOwn(responses.at(-1).data.thoughtPage, "nextId"), false);
assert.equal(await http.handleV1({ method: "GET" }, {}, new URL("http://local/api/v1/route-state?view=review&cursor=encoded:analysis-7"), v1), true);
assert.equal(responses.at(-1).data.route.query.analysisAfterId, "analysis-7");
assert.equal(responses.at(-1).data.analysisPage.nextCursor, "encoded:analysis-cursor");
assert.equal(Object.hasOwn(responses.at(-1).data.analysisPage, "nextId"), false);
assert.equal(await http.handleV1({ method: "GET" }, {}, new URL("http://local/api/v1/route-state?view=unknown"), v1), true);
assert.deepEqual(responses.at(-1), { status: 400, message: "页面标识无效", code: "INVALID_ROUTE_VIEW" });
assert.equal(await http.handleV1({ method: "POST" }, {}, new URL("http://local/api/v1/startup"), v1), false);

console.log(`Startup projection checks passed: today ${todayBytes} B, review ${reviewBytes} B; bounded DTOs, field exclusion and route isolation.`);
