import { localDateKey, shiftDateKey, strictDateKey } from "../../shared/time/index.mjs";

const list = value => Array.isArray(value) ? value : [];

export function recordStatistics(input = {}) {
  const store = {
    checkins: list(input.checkins),
    dailyRecords: list(input.dailyRecords),
    captures: list(input.captures),
    journals: list(input.journals),
    thoughts: list(input.thoughts),
    chats: list(input.chats),
    books: list(input.books),
    keepsakes: list(input.keepsakes),
    quotes: list(input.quotes),
    experiments: list(input.experiments),
    analyses: list(input.analyses)
  };
  const annotationRoots = [
    ...store.captures,
    ...store.journals,
    ...store.thoughts,
    ...store.chats,
    ...store.books,
    ...store.quotes,
    ...store.analyses
  ];
  const annotations = annotationRoots.flatMap(root => [
    ...list(root.annotations),
    ...list(root.annotationDrift)
  ]);
  const content = [
    { key: "checkins", label: "状态", count: store.checkins.length },
    { key: "sleep", label: "睡眠", count: store.dailyRecords.filter(item => item.type === "sleep").length },
    { key: "heartRate", label: "心率", count: store.dailyRecords.filter(item => item.type === "heartRate").length },
    { key: "weight", label: "体重", count: store.dailyRecords.filter(item => item.type === "weight").length },
    { key: "exercise", label: "运动", count: store.dailyRecords.filter(item => item.type === "exercise").length },
    { key: "captures", label: "捕念", count: store.captures.length },
    { key: "journals", label: "日记", count: store.journals.length },
    { key: "thoughts", label: "思考主题", count: store.thoughts.filter(item => item.type === "question").length },
    { key: "chats", label: "长期对话", count: store.chats.length },
    { key: "books", label: "书目", count: store.books.length },
    { key: "bookNotes", label: "读书记录", count: store.books.reduce((sum, book) => sum + list(book.notes).length, 0) },
    { key: "quotes", label: "善言", count: store.quotes.length },
    { key: "keepsakes", label: "小物", count: store.keepsakes.length },
    { key: "experiments", label: "个人实验", count: store.experiments.length },
    { key: "analyses", label: "认知复盘", count: store.analyses.length }
  ];
  const interactions = [
    { key: "highlights", label: "划线", count: annotations.filter(item => item.kind === "highlight").length },
    { key: "comments", label: "评论", count: annotations.filter(item => item.kind !== "highlight").length },
    { key: "commentReplies", label: "评论回复", count: annotations.reduce((sum, item) => sum + list(item.replies).length, 0) },
    { key: "shenji", label: "@神鸡", count: annotations.reduce((sum, item) => sum + list(item.shenji).length, 0) },
    { key: "followUps", label: "思考追问", count: store.thoughts.reduce((sum, item) => sum + list(item.followUps).length, 0) },
    { key: "remarks", label: "思考备注", count: store.thoughts.reduce((sum, item) => sum + list(item.remarks).length, 0) },
    { key: "reflections", label: "日记回望", count: store.journals.reduce((sum, item) => sum + list(item.reflections).length, 0) }
  ];
  const contentByKey = Object.fromEntries(content.map(item => [item.key, item]));
  const interactionByKey = Object.fromEntries(interactions.map(item => [item.key, item]));
  const module = (key, label, keys, source = contentByKey) => ({
    key,
    label,
    items: keys.map(itemKey => source[itemKey]).filter(Boolean)
  });
  const groups = [
    {
      key: "today",
      label: "今日",
      modules: [
        module("moment", "此刻", ["checkins"]),
        module("together", "共参", ["chats"]),
        module("daily", "每日", ["sleep", "heartRate", "weight", "exercise"])
      ]
    },
    {
      key: "seen",
      label: "所见",
      modules: [
        module("captures", "念起", ["captures"]),
        module("books", "书间", ["books", "bookNotes"]),
        module("quotes", "拾句", ["quotes"]),
        module("keepsakes", "小物", ["keepsakes"])
      ]
    },
    {
      key: "thought",
      label: "所思",
      modules: [
        module("thoughts", "思绪", ["thoughts"]),
        module("journals", "日记", ["journals"]),
        module("review", "回顾", ["experiments", "analyses"])
      ]
    },
    {
      key: "interaction",
      label: "互动",
      modules: [
        module("annotations", "正文批注", ["highlights", "comments", "commentReplies", "shenji"], interactionByKey),
        module("thoughtInteractions", "思绪", ["followUps", "remarks"], interactionByKey),
        module("journalInteractions", "日记", ["reflections"], interactionByKey)
      ]
    }
  ];
  for (const group of groups) {
    for (const item of group.modules) item.total = item.items.reduce((sum, entry) => sum + entry.count, 0);
    group.total = group.modules.reduce((sum, item) => sum + item.total, 0);
  }
  return {
    total: [...content, ...interactions].reduce((sum, item) => sum + item.count, 0),
    contentTotal: content.reduce((sum, item) => sum + item.count, 0),
    interactionTotal: interactions.reduce((sum, item) => sum + item.count, 0),
    content,
    interactions,
    groups
  };
}

export function operationStatistics(input = []) {
  const entries = list(input).filter(item => (
    item?.event === "request.completed"
    && item.result === "success"
  ));
  const actions = new Map();
  for (const item of entries) {
    const action = item.action || "unknown";
    actions.set(action, (actions.get(action) || 0) + 1);
  }
  return {
    completedWrites: entries.length,
    activeDays: new Set(entries.map(item => localDateKey(item.timestamp)).filter(Boolean)).size,
    segmentationRequests: entries.filter(item => (
      /\/(?:segment|keepsakes\/segment)(?:\/|$)/.test(item.action || "")
    )).length,
    topActions: [...actions.entries()]
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))
      .slice(0, 8)
  };
}

export function statisticsRange({ from, to } = {}, currentDate = localDateKey()) {
  const start = from === undefined ? shiftDateKey(currentDate, -6) : strictDateKey(from);
  const end = to === undefined ? currentDate : strictDateKey(to);
  if (!start || !end || start > end) return { error: "统计时间范围不正确", code: "STATISTICS_RANGE_INVALID" };
  const days = Math.round((
    Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)
  ) / 86400000) + 1;
  if (days > 3660) return { error: "单次最多统计 10 年", code: "STATISTICS_RANGE_TOO_LARGE" };
  return { value: { from: start, to: end } };
}

export function createStatisticsService({
  repository,
  ensureAiUsage,
  readAiUsage,
  readOperationEntries,
  aiDashboard,
  today = () => localDateKey()
}) {
  if (!repository || typeof repository.read !== "function") {
    throw new TypeError("Statistics service requires a repository with read()");
  }
  for (const [name, dependency] of Object.entries({
    ensureAiUsage,
    readAiUsage,
    readOperationEntries,
    aiDashboard
  })) {
    if (typeof dependency !== "function") throw new TypeError(`Statistics service requires ${name}()`);
  }

  return {
    async dashboard(rangeInput = {}) {
      const range = statisticsRange(rangeInput, today());
      if (range.error) return range;
      const { from, to } = range.value;
      await ensureAiUsage();
      const [store, usage, operations] = await Promise.all([
        repository.read(),
        readAiUsage(),
        readOperationEntries(from, to)
      ]);
      return {
        value: {
          records: recordStatistics(store),
          ai: aiDashboard(usage, from, to, store.commercialization?.assumptions?.common?.usdCny),
          service: operationStatistics(operations)
        }
      };
    }
  };
}
