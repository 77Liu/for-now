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

const list = value => Array.isArray(value) ? value : [];
const timestamp = value => String(value?.occurredAt || value?.createdAt || "");
const dateKey = value => String(value?.occurredOn || timestamp(value).slice(0, 10));
const text = value => String(value || "").trim();
const clone = value => structuredClone(value);
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
  "clusters",
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

function homeMemories(state, limit = 30) {
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

function latestItems(values, limit) {
  return list(values)
    .slice()
    .sort((left, right) => timestamp(right).localeCompare(timestamp(left)))
    .slice(0, limit)
    .map(clone);
}

function pick(state, fields) {
  return Object.fromEntries(fields
    .filter(key => Object.hasOwn(state || {}, key))
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
  unread = 0
}) {
  return {
    protocolVersion: 1,
    version,
    releaseVersion,
    user: clone(user),
    capabilities: [...capabilities],
    features: clone(features),
    governanceUrl,
    accountCursor: Math.max(0, Number(store?._persistence?.sync?.cursor) || 0),
    notificationUnread: Math.max(0, Number(unread) || 0),
    onboardingV2: {
      session: {
        status: text(store?.onboardingV2?.session?.status) || "pending"
      }
    }
  };
}

export function routeStateProjection(state, {
  view = "today",
  currentDate = new Date().toISOString().slice(0, 10)
} = {}) {
  const common = {
    notificationUnread: Math.max(0, Number(state?.notificationUnread) || 0)
  };
  if (view === "today") {
    return {
      ...common,
      checkins: latestItems(state?.checkins, 30),
      customMetrics: clone(list(state?.customMetrics)),
      homeMemories: homeMemories(state || {}),
      keepsakes: latestItems(state?.keepsakes, 12)
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
  if (view === "thoughts") return { ...common, thoughts: clone(list(state?.thoughts)), speech: clone(state?.speech) };
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
    return {
      ...common,
      checkins: clone(list(state?.checkins)),
      analyses: clone(list(state?.analyses)),
      experiments: clone(list(state?.experiments)),
      customMetrics: clone(list(state?.customMetrics)),
      clusters: clone(list(state?.clusters)),
      insights: clone(state?.insights),
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
