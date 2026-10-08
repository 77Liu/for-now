import { thoughtChainDetail, thoughtChainListPage } from "../modules/thoughts/index.mjs";
import { normalizeOnboardingV2 } from "../modules/onboarding/index.mjs";

const LIST_FIELDS = new Set([
  "id",
  "version",
  "syncVersion",
  "createdAt",
  "updatedAt",
  "occurredAt",
  "occurredOn",
  "type",
  "content",
  "tags",
  "relatedTo",
  "disposition",
  "origin",
  "authorType",
  "sourceRef"
]);

const BASE_METRICS = ["mood", "energy", "stress", "sleep"];
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CHECKIN_ID_FIELDS = ["id", "version", "syncVersion", "createdAt", "updatedAt", "occurredAt", "occurredOn"];
const WEEKLY_INSIGHT_FIELDS = [
  "checkins",
  "thoughts",
  "questions",
  "answers",
  "kept",
  "activeDays7",
  "pairedDays30",
  "rootCount30",
  "tracedRoots30",
  "traceRate30",
  "correctionActions30",
  "reviewAgeDays",
  "analysisCount"
];

export const ROUTE_STATE_LIMITS = Object.freeze({
  today: Object.freeze({
    currentCheckins: 48,
    trendCheckins: 30,
    latestMetricCheckins: 16,
    trendDays: 30,
    customMetrics: 12,
    homeMemories: 30,
    keepsakes: 12
  }),
  review: Object.freeze({
    checkins: 90,
    checkinDays: 90,
    analyses: 8,
    analysisContentChars: 6000,
    annotationsPerAnalysis: 12,
    repliesPerAnnotation: 8,
    shenjiPerAnnotation: 4,
    receiptSources: 12,
    experiments: 20,
    customMetrics: 16,
    clusters: 12,
    clusterItems: 3,
    clusterItemContentChars: 240,
    trends: 8,
    associations: 3
  })
});

const list = value => Array.isArray(value) ? value : [];
const timestamp = value => String(value?.occurredAt || value?.createdAt || "");
const dateKey = value => String(value?.occurredOn || timestamp(value).slice(0, 10));
const text = value => String(value || "").trim();
const boundedText = (value, limit) => String(value || "").slice(0, limit);
const clone = value => structuredClone(value);
const quoteTags = state => [...new Set(list(state?.quotes)
  .flatMap(item => list(item?.tags))
  .map(value => text(value).slice(0, 30))
  .filter(Boolean))]
  .slice(0, 100);
const PUBLIC_STATE_FIELDS = [
  "version",
  "checkins",
  "dailyRecords",
  "captures",
  "journals",
  "journalDraft",
  "thoughts",
  "chats",
  "books",
  "keepsakes",
  "quotes",
  "experiments",
  "analyses",
  "customMetrics",
  "aiTasks",
  "notifications",
  "notificationUnread",
  "insights",
  "trashCount",
  "speech",
  "vision",
  "actions",
  "habits",
  "habitCheckins",
  "feedback",
  "validationLedger",
  "userClaims",
  "modelUnknowns",
  "onboarding",
  "onboardingV2"
];

function localDateKey() {
  const value = new Date();
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0")
  ].join("-");
}

function shiftDateKey(value, offset) {
  if (!DATE_KEY_PATTERN.test(value)) return "";
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
}

function scalarFields(value, fields) {
  return Object.fromEntries(fields
    .filter(key => Object.hasOwn(value || {}, key))
    .map(key => [key, clone(value[key])]));
}

function safeNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function customMetricProjection(item) {
  const result = scalarFields(item, ["id", "version", "syncVersion", "createdAt", "updatedAt"]);
  if (Object.hasOwn(item || {}, "name")) result.name = boundedText(item.name, 40);
  if (Object.hasOwn(item || {}, "low")) result.low = boundedText(item.low, 60);
  if (Object.hasOwn(item || {}, "high")) result.high = boundedText(item.high, 60);
  return result;
}

function customMetricProjections(values, limit) {
  return list(values).slice(0, limit).map(customMetricProjection);
}

function customMetricIds(metrics) {
  return metrics.map(item => text(item?.id)).filter(Boolean);
}

function checkinMetrics(item, metricIds) {
  const result = {};
  for (const metric of BASE_METRICS) {
    const value = safeNumber(item?.[metric]);
    if (value != null) result[metric] = value;
  }
  const custom = Object.fromEntries(metricIds.flatMap(id => {
    const value = safeNumber(item?.custom?.[id]);
    return value == null ? [] : [[id, value]];
  }));
  if (Object.keys(custom).length) result.custom = custom;
  return result;
}

function checkinNotes(item, metricIds) {
  const keys = [...BASE_METRICS, ...metricIds];
  const notes = Object.fromEntries(keys.flatMap(key => (
    Object.hasOwn(item?.notes || {}, key)
      ? [[key, boundedText(item.notes[key], 800)]]
      : []
  )));
  return Object.keys(notes).length ? notes : null;
}

function detailedCheckin(item, metricIds) {
  const result = {
    ...scalarFields(item, CHECKIN_ID_FIELDS),
    ...checkinMetrics(item, metricIds)
  };
  if (Object.hasOwn(item || {}, "factors")) {
    result.factors = list(item.factors).slice(0, 20).map(value => boundedText(value, 40)).filter(Boolean);
  }
  const notes = checkinNotes(item, metricIds);
  if (notes) result.notes = notes;
  return result;
}

function trendCheckin(item, metricIds) {
  return {
    ...scalarFields(item, ["occurredAt", "occurredOn"]),
    ...checkinMetrics(item, metricIds)
  };
}

function metricValue(item, key) {
  return key.startsWith("custom:")
    ? safeNumber(item?.custom?.[key.slice(7)])
    : safeNumber(item?.[key]);
}

function todayCheckins(values, currentDate, metricIds) {
  const limits = ROUTE_STATE_LIMITS.today;
  const eligible = list(values)
    .filter(item => {
      const date = dateKey(item);
      return date && date <= currentDate;
    })
    .slice()
    .sort((left, right) => timestamp(right).localeCompare(timestamp(left)));
  const current = eligible
    .filter(item => dateKey(item) === currentDate)
    .slice(0, limits.currentCheckins);
  const detailed = new Set(current);
  const cutoff = shiftDateKey(currentDate, 1 - limits.trendDays);
  const trend = eligible
    .filter(item => dateKey(item) < currentDate && (!cutoff || dateKey(item) >= cutoff))
    .slice(0, limits.trendCheckins);
  const selected = new Set([...current, ...trend]);
  const latest = [];
  for (const key of [...BASE_METRICS, ...metricIds.map(id => `custom:${id}`)]) {
    const item = eligible.find(value => metricValue(value, key) != null);
    if (!item || selected.has(item)) continue;
    selected.add(item);
    latest.push(item);
    if (latest.length >= limits.latestMetricCheckins) break;
  }
  return [...current, ...trend, ...latest]
    .sort((left, right) => timestamp(right).localeCompare(timestamp(left)))
    .map(item => detailed.has(item)
      ? detailedCheckin(item, metricIds)
      : trendCheckin(item, metricIds));
}

function reviewCheckins(values, currentDate, metricIds) {
  const limits = ROUTE_STATE_LIMITS.review;
  const cutoff = shiftDateKey(currentDate, 1 - limits.checkinDays);
  return list(values)
    .filter(item => {
      const date = dateKey(item);
      return date && date <= currentDate && (!cutoff || date >= cutoff);
    })
    .slice()
    .sort((left, right) => timestamp(right).localeCompare(timestamp(left)))
    .slice(0, limits.checkins)
    .map(item => detailedCheckin(item, metricIds));
}

function receiptProjection(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const tokenBudget = scalarFields(receipt.tokenBudget, ["limit", "estimatedUsed", "remaining", "estimation"]);
  const sources = list(receipt.sources).slice(0, ROUTE_STATE_LIMITS.review.receiptSources).map(source => ({
    ...scalarFields(source, [
      "resourceType",
      "resourceId",
      "recordType",
      "version",
      "occurredAt",
      "occurredOn"
    ]),
    ...(source?.excerpt ? { excerpt: boundedText(source.excerpt, 500) } : {}),
    ...(source?.location && typeof source.location === "object" ? {
      location: scalarFields(source.location, [
        "view",
        "targetId",
        "rootId",
        "targetKey",
        "occurredOn",
        "dailyType"
      ])
    } : {})
  }));
  if (!sources.length && !Object.keys(tokenBudget).length) return null;
  return {
    ...scalarFields(receipt, ["version"]),
    ...(Object.keys(tokenBudget).length ? { tokenBudget } : {}),
    ...(sources.length ? { sources } : {})
  };
}

function annotationReplyProjection(reply) {
  return {
    ...scalarFields(reply, ["id", "createdAt", "updatedAt"]),
    text: boundedText(reply?.text, 4000)
  };
}

function annotationExchangeProjection(exchange) {
  const receipt = receiptProjection(exchange?.contextReceipt);
  return {
    ...scalarFields(exchange, ["id", "createdAt", "sourceTaskId", "clientRequestId"]),
    message: boundedText(exchange?.message, 6000),
    answer: boundedText(exchange?.answer, 6000),
    ...(receipt ? { contextReceipt: receipt } : {})
  };
}

function annotationProjection(annotation) {
  const limits = ROUTE_STATE_LIMITS.review;
  const result = {
    ...scalarFields(annotation, [
      "id",
      "kind",
      "targetKey",
      "start",
      "end",
      "rawStart",
      "createdAt",
      "updatedAt",
      "resolved",
      "version",
      "driftedAt",
      "originalTargetKey"
    ]),
    quote: boundedText(annotation?.quote, 1000),
    text: boundedText(annotation?.text, 4000),
    contextBefore: boundedText(annotation?.contextBefore, 240),
    contextAfter: boundedText(annotation?.contextAfter, 240),
    replies: list(annotation?.replies).slice(0, limits.repliesPerAnnotation).map(annotationReplyProjection),
    shenji: list(annotation?.shenji).slice(0, limits.shenjiPerAnnotation).map(annotationExchangeProjection)
  };
  if (annotation?.driftReason) result.driftReason = boundedText(annotation.driftReason, 240);
  if (annotation?.originalContext && typeof annotation.originalContext === "object") {
    result.originalContext = {
      before: boundedText(annotation.originalContext.before, 1000),
      focus: boundedText(annotation.originalContext.focus, 1000),
      after: boundedText(annotation.originalContext.after, 1000)
    };
  }
  if (Array.isArray(annotation?.attachmentPaths)) {
    result.attachmentPaths = annotation.attachmentPaths.slice(0, 5).map(value => boundedText(value, 240));
  }
  return result;
}

function analysisProjection(item) {
  const limits = ROUTE_STATE_LIMITS.review;
  const receipt = receiptProjection(item?.contextReceipt);
  const content = String(item?.content || "");
  return {
    ...scalarFields(item, [
      "id",
      "version",
      "syncVersion",
      "createdAt",
      "updatedAt",
      "reason",
      "reviewStatus",
      "reviewedAt",
      "reviewDisposition"
    ]),
    content: content.slice(0, limits.analysisContentChars),
    ...(content.length > limits.analysisContentChars ? { contentTruncated: true } : {}),
    annotations: list(item?.annotations).slice(0, limits.annotationsPerAnalysis).map(annotationProjection),
    annotationDrift: list(item?.annotationDrift).slice(0, limits.annotationsPerAnalysis).map(annotationProjection),
    ...(receipt ? { contextReceipt: receipt } : {})
  };
}

function reviewAnalyses(values, afterId = "") {
  const ordered = list(values)
    .slice()
    .sort((left, right) => timestamp(right).localeCompare(timestamp(left)));
  const start = afterId ? ordered.findIndex(item => item?.id === afterId) + 1 : 0;
  if (afterId && start === 0) return { invalidCursor: true, items: [], nextId: "", total: ordered.length };
  const selected = ordered.slice(start, start + ROUTE_STATE_LIMITS.review.analyses);
  return {
    items: selected.map(analysisProjection),
    nextId: start + selected.length < ordered.length ? selected.at(-1)?.id || "" : "",
    total: ordered.length
  };
}

function experimentProjection(item) {
  return {
    ...scalarFields(item, ["id", "version", "syncVersion", "createdAt", "updatedAt", "outcome", "duration", "status"]),
    hypothesis: boundedText(item?.hypothesis, 500),
    factor: boundedText(item?.factor, 80)
  };
}

function clusterProjection(cluster) {
  const limits = ROUTE_STATE_LIMITS.review;
  return {
    theme: boundedText(cluster?.theme, 120),
    count: Math.max(0, Number(cluster?.count) || 0),
    questions: Math.max(0, Number(cluster?.questions) || 0),
    kept: Math.max(0, Number(cluster?.kept) || 0),
    discarded: Math.max(0, Number(cluster?.discarded) || 0),
    unreviewed: Math.max(0, Number(cluster?.unreviewed) || 0),
    items: list(cluster?.items).slice(0, limits.clusterItems).map(item => ({
      ...scalarFields(item, ["id", "occurredAt", "occurredOn"]),
      content: boundedText(item?.content, limits.clusterItemContentChars)
    }))
  };
}

function insightsProjection(value) {
  const insights = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    trends: list(insights.trends).slice(0, ROUTE_STATE_LIMITS.review.trends).map(item => ({
      ...scalarFields(item, ["metric"]),
      current: safeNumber(item?.current),
      previous: safeNumber(item?.previous),
      currentCount: Math.max(0, Number(item?.currentCount) || 0),
      previousCount: Math.max(0, Number(item?.previousCount) || 0)
    })),
    associations: list(insights.associations).slice(0, ROUTE_STATE_LIMITS.review.associations).map(item => ({
      factor: boundedText(item?.factor, 80),
      withCount: Math.max(0, Number(item?.withCount) || 0),
      withoutCount: Math.max(0, Number(item?.withoutCount) || 0),
      nextDayCount: Math.max(0, Number(item?.nextDayCount) || 0),
      sameDay: safeNumber(item?.sameDay),
      baseline: safeNumber(item?.baseline),
      nextDay: safeNumber(item?.nextDay),
      confidence: boundedText(item?.confidence, 40)
    })),
    weekly: scalarFields(insights.weekly, WEEKLY_INSIGHT_FIELDS)
  };
}

function keepsakeProjection(item) {
  return {
    ...scalarFields(item, [
      "id",
      "version",
      "syncVersion",
      "createdAt",
      "updatedAt",
      "occurredAt",
      "occurredOn",
      "backgroundOpacityPct",
      "derivativeState",
      "thumbPath",
      "cutoutPath",
      "previewPath"
    ]),
    title: boundedText(item?.title, 160),
    note: boundedText(item?.note, 500),
    description: boundedText(item?.description, 500),
    tags: list(item?.tags).slice(0, 8).map(value => boundedText(value, 40)).filter(Boolean),
    ...(item?.media && typeof item.media === "object" ? { media: clone(item.media) } : {})
  };
}

function listThought(item, maxContent = 1200) {
  const result = {};
  for (const key of LIST_FIELDS) {
    if (!Object.hasOwn(item || {}, key)) continue;
    result[key] = key === "content" ? text(item[key]).slice(0, maxContent) : clone(item[key]);
  }
  return result;
}

function isUserThought(item) {
  const origin = text(item?.origin).toLowerCase();
  return item?.authorType !== "ai" && !/^(?:deepseek|codex|openai|model|ai)(?:$|[-_:])/i.test(origin);
}

function homeMemories(state, limit = ROUTE_STATE_LIMITS.today.homeMemories) {
  const thoughts = list(state.thoughts);
  const thoughtItems = thoughts
    .filter(item => item?.type === "question" && item.disposition !== "discarded" && isUserThought(item) && text(item.content))
    .map(root => {
      const child = thoughts
        .filter(item => item?.relatedTo === root.id
          && item.disposition !== "discarded"
          && ["idea", "record", "answer"].includes(item.type)
          && isUserThought(item)
          && text(item.content))
        .sort((left, right) => timestamp(right).localeCompare(timestamp(left)))[0];
      return {
        key: `thought:${root.id}`,
        id: root.id,
        type: "thought",
        occurredAt: timestamp(root),
        occurredOn: dateKey(root),
        title: child ? text(root.content).slice(0, 240) : "",
        text: text(child?.content || root.content).slice(0, 500)
      };
    });
  const bookItems = list(state.books).flatMap(book => list(book?.notes)
    .filter(note => text(note?.content) && isUserThought(note))
    .map(note => ({
      key: `book:${book.id}:${note.id}`,
      id: note.id,
      bookId: book.id,
      noteId: note.id,
      type: "book",
      occurredAt: timestamp(note),
      occurredOn: dateKey(note),
      sourceTitle: text(book.title).slice(0, 160),
      title: "",
      text: text(note.content).slice(0, 500)
    })));
  const quoteItems = list(state.quotes)
    .filter(item => text(item?.content) && isUserThought(item))
    .map(item => ({
      key: `quote:${item.id}`,
      id: item.id,
      type: "quote",
      occurredAt: timestamp(item),
      occurredOn: dateKey(item),
      sourceTitle: text(item.source).slice(0, 160),
      title: "",
      text: text(item.content).slice(0, 500)
    }));
  return [...thoughtItems, ...bookItems, ...quoteItems]
    .sort((left, right) => timestamp(right).localeCompare(timestamp(left)) || left.key.localeCompare(right.key))
    .slice(0, limit);
}

function todayThoughts(state, currentDate, limit = 5) {
  const thoughts = list(state.thoughts);
  const roots = thoughts
    .filter(item => item?.type === "question" && dateKey(item) === currentDate)
    .sort((left, right) => timestamp(right).localeCompare(timestamp(left)))
    .slice(0, limit);
  const rootIds = new Set(roots.map(item => item.id));
  const children = thoughts.filter(item => rootIds.has(item?.relatedTo) && isUserThought(item));
  return [...roots.map(item => listThought(item, 1200)), ...children.map(item => listThought(item, 1200))];
}

function pick(state, fields) {
  return Object.fromEntries(fields
    .filter(key => key !== "clusters" && Object.hasOwn(state || {}, key))
    .map(key => [key, clone(state[key])]));
}

export function startupProjection({
  store,
  user,
  version,
  releaseVersion,
  capabilities = [],
  features = {},
  governanceUrl = "",
  openingPreferences,
  unread = 0
}) {
  return {
    protocolVersion: 1,
    version,
    releaseVersion,
    user: clone(user),
    ...(openingPreferences ? { openingPreferences: clone(openingPreferences) } : {}),
    capabilities: [...capabilities],
    features: clone(features),
    governanceUrl,
    accountCursor: Math.max(0, Number(store?._persistence?.sync?.cursor) || 0),
    notificationUnread: Math.max(0, Number(unread) || 0),
    quoteTags: quoteTags(store),
    onboardingV2: normalizeOnboardingV2(store?.onboardingV2, store?.onboarding)
  };
}

export function routeStateProjection(state, {
  view = "today",
  currentDate = localDateKey(),
  resourceId = "",
  query = {},
  cursorScope = ""
} = {}) {
  const common = {
    notificationUnread: Math.max(0, Number(state?.notificationUnread) || 0)
  };
  if (view === "today") {
    const metrics = customMetricProjections(state?.customMetrics, ROUTE_STATE_LIMITS.today.customMetrics);
    return {
      ...common,
      checkins: todayCheckins(state?.checkins, currentDate, customMetricIds(metrics)),
      customMetrics: metrics,
      homeMemories: homeMemories(state || {}),
      keepsakes: list(state?.keepsakes)
        .slice()
        .sort((left, right) => timestamp(right).localeCompare(timestamp(left)))
        .slice(0, ROUTE_STATE_LIMITS.today.keepsakes)
        .map(keepsakeProjection)
    };
  }
  if (view === "captures") {
    const promoted = list(state?.thoughts)
      .filter(item => item?.type === "question" && item?.sourceRef?.type === "capture")
      .map(item => listThought(item, 240));
    return { ...common, captures: clone(list(state?.captures)), thoughts: promoted, speech: clone(state?.speech) };
  }
  if (view === "daily") return { ...common, dailyRecords: clone(list(state?.dailyRecords)) };
  if (view === "journals") return { ...common, journals: clone(list(state?.journals)), journalDraft: clone(state?.journalDraft || null) };
  if (view === "thoughts") {
    const pageNumber = Math.min(5, Math.max(1, Math.floor(Number(query?.page) || 1)));
    if (resourceId) {
      const detail = thoughtChainDetail(state?.thoughts, resourceId);
      const { blocks = [], ...root } = detail || {};
      return {
        ...common,
        thoughts: detail ? [root, ...blocks] : [],
        speech: clone(state?.speech),
        thoughtPage: { kind: "detail", found: Boolean(detail), nextId: "", query: text(query?.q), page: pageNumber }
      };
    }
    const page = thoughtChainListPage(state?.thoughts, {
      limit: 20 * pageNumber,
      maxLimit: 100,
      query: query?.q || "",
      tag: query?.tag || "",
      sort: query?.sort,
      cursorScope
    });
    return {
      ...common,
      thoughts: page.items,
      speech: clone(state?.speech),
      thoughtPage: {
        kind: "list",
        nextId: pageNumber < 5 ? page.nextId : "",
        tags: page.tags,
        query: text(query?.q),
        tag: text(query?.tag),
        sort: query?.sort === "created" ? "created" : "occurred",
        page: pageNumber
      }
    };
  }
  if (view === "books") return { ...common, books: clone(list(state?.books)) };
  if (view === "quotes") return { ...common, quotes: clone(list(state?.quotes)) };
  if (view === "keepsakes") return { ...common, keepsakes: clone(list(state?.keepsakes)), vision: clone(state?.vision) };
  if (view === "together") {
    return {
      ...common,
      chats: clone(list(state?.chats)),
      thoughts: todayThoughts(state || {}, currentDate)
    };
  }
  if (view === "review") {
    const limits = ROUTE_STATE_LIMITS.review;
    const metrics = customMetricProjections(state?.customMetrics, limits.customMetrics);
    const analyses = reviewAnalyses(state?.analyses, query?.analysisAfterId);
    return {
      ...common,
      checkins: reviewCheckins(state?.checkins, currentDate, customMetricIds(metrics)),
      analyses: analyses.items,
      analysisPage: {
        nextId: analyses.nextId,
        total: analyses.total,
        invalidCursor: Boolean(analyses.invalidCursor)
      },
      experiments: list(state?.experiments).slice(0, limits.experiments).map(experimentProjection),
      customMetrics: metrics,
      clusters: list(state?.clusters).slice(0, limits.clusters).map(clusterProjection),
      insights: insightsProjection(state?.insights),
      reviewSourceCount: ["checkins", "dailyRecords", "captures", "journals", "thoughts"]
        .reduce((sum, key) => sum + list(state?.[key]).length, 0)
    };
  }
  const routeFields = {
    discovery: [],
    mine: PUBLIC_STATE_FIELDS,
    "personal-context": [],
    statistics: [],
    "ai-cost": [],
    architecture: [],
    commercialization: [],
    feedback: [],
    export: [],
    notifications: ["notifications", "aiTasks", "notificationUnread"],
    trash: ["trashCount"],
    permission: [],
    account: [],
    settings: ["speech", "vision"],
    about: []
  };
  return { ...common, ...pick(state, routeFields[view] || PUBLIC_STATE_FIELDS) };
}
