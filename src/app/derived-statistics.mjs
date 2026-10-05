import { localDateKey, shiftDateKey } from "../shared/time/index.mjs";
import { safeText } from "../shared/validation/index.mjs";

const avg = values => (
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
);
const round = value => value == null ? null : Math.round(value * 100) / 100;

export function classifyThought(text, tags = []) {
  const value = `${text} ${tags.join(" ")}`.toLowerCase();
  const groups = [
    ["工作与创造", ["工作", "项目", "职业", "同事", "产品", "创作", "任务"]],
    ["关系与连接", ["关系", "朋友", "家人", "伴侣", "社交", "沟通"]],
    ["身心状态", ["睡眠", "情绪", "压力", "疲惫", "焦虑", "健康", "运动", "身体"]],
    ["学习与成长", ["学习", "阅读", "能力", "课程", "复盘", "成长", "知识"]],
    ["选择与方向", ["选择", "决定", "目标", "方向", "未来", "要不要", "价值", "意义"]],
    ["金钱与消费", ["理财", "消费", "收入", "储备金", "价格", "支付能力"]]
  ];
  return groups.find(([, words]) => words.some(word => value.includes(word)))?.[0]
    || tags[0]
    || "待慢慢看清";
}

export function deriveThoughtClusters(store) {
  const map = new Map();
  const roots = store.thoughts.filter(item => item.type === "question");
  for (const item of roots) {
    const theme = classifyThought(item.content, item.tags);
    if (!map.has(theme)) map.set(theme, []);
    map.get(theme).push(item);
  }
  return [...map.entries()].map(([theme, items]) => ({
    theme,
    count: items.length,
    questions: items.length,
    kept: items.filter(item => item.disposition === "kept").length,
    discarded: items.filter(item => item.disposition === "discarded").length,
    unreviewed: items.filter(item => item.disposition === "pending").length,
    items: items.sort((left, right) => (
      (right.occurredAt || right.createdAt).localeCompare(left.occurredAt || left.createdAt)
    ))
  })).sort((left, right) => right.count - left.count);
}

export function isUntouchedAiAnswer(item) {
  const content = safeText(item?.content);
  const modelDraft = safeText(item?.modelDraft);
  return item?.type === "answer"
    && Boolean(modelDraft)
    && content === modelDraft
    && !item.editedFromModel
    && !item.updatedAt
    && !["manual", "deepseek-edited"].includes(item.origin);
}

export function thoughtHasUserTrace(store, root) {
  const children = store.thoughts.filter(item => item.relatedTo === root.id);
  return Boolean(
    root.updatedAt
    || root.dispositionAt
    || (root.annotations || []).length
    || (root.annotationDrift || []).length
    || (root.remarks || []).length
    || (root.followUps || []).length
    || children.some(item => item.type === "idea" && safeText(item.content))
    || children.some(item => (
      item.type === "answer"
      && !isUntouchedAiAnswer(item)
      && (safeText(item.content) || safeText(item.modelDraft))
    ))
  );
}

export function thoughtIsUntouchedAiOnly(store, root) {
  const answers = store.thoughts.filter(item => (
    item.relatedTo === root.id && item.type === "answer"
  ));
  return answers.some(isUntouchedAiAnswer) && !thoughtHasUserTrace(store, root);
}

export function deriveStateInsights(store, {
  currentDate = localDateKey()
} = {}) {
  const ordered = [...store.checkins].sort((left, right) => (
    left.occurredOn.localeCompare(right.occurredOn)
    || (left.occurredAt || left.createdAt).localeCompare(right.occurredAt || right.createdAt)
  ));
  const dates = [...new Set(ordered.map(item => item.occurredOn))].sort();
  const byDate = new Map(dates.map(date => [
    date,
    ordered.filter(item => item.occurredOn === date)
  ]));
  const daily = dates.map(date => Object.fromEntries(
    ["mood", "energy", "stress", "sleep"].map(metric => [
      metric,
      avg(byDate.get(date).map(item => Number(item[metric])).filter(Number.isFinite))
    ])
  ));
  const recent = daily.slice(-7);
  const previous = daily.slice(-14, -7);
  const trends = ["mood", "energy", "stress", "sleep"].map(metric => {
    const currentValues = recent.map(item => Number(item[metric])).filter(Number.isFinite);
    const previousValues = previous.map(item => Number(item[metric])).filter(Number.isFinite);
    return {
      metric,
      current: round(avg(currentValues)),
      previous: round(avg(previousValues)),
      currentCount: currentValues.length,
      previousCount: previousValues.length
    };
  });

  const factorNames = [...new Set(ordered.flatMap(item => item.factors || []))];
  const confidenceRank = { "单日观察": 1, "初步线索": 2, "可观察": 3 };
  const associationEvidence = item => (
    Math.min(item.withCount, item.withoutCount) + item.nextDayCount
  );
  const associationEffect = item => item.baseline == null ? 0 : Math.max(
    ...[item.sameDay, item.nextDay]
      .filter(Number.isFinite)
      .map(value => Math.abs(value - item.baseline)),
    0
  );
  const associations = factorNames.map(factor => {
    const withFactor = [];
    const withoutFactor = [];
    const nextDay = [];
    dates.forEach(date => {
      const entries = byDate.get(date);
      const mood = avg(entries.map(item => item.mood));
      const present = entries.some(item => (item.factors || []).includes(factor));
      (present ? withFactor : withoutFactor).push(mood);
      const nextEntries = byDate.get(shiftDateKey(date, 1));
      if (present && nextEntries) nextDay.push(avg(nextEntries.map(item => item.mood)));
    });
    const confidence = withFactor.length >= 10
        && withoutFactor.length >= 10
        && nextDay.length >= 5
        && dates.length >= 30
      ? "可观察"
      : withFactor.length >= 2 ? "初步线索" : "单日观察";
    return {
      factor,
      withCount: withFactor.length,
      withoutCount: withoutFactor.length,
      nextDayCount: nextDay.length,
      sameDay: round(avg(withFactor)),
      baseline: round(avg(withoutFactor)),
      nextDay: round(avg(nextDay)),
      confidence
    };
  }).sort((left, right) => (
    confidenceRank[right.confidence] - confidenceRank[left.confidence]
    || associationEvidence(right) - associationEvidence(left)
    || associationEffect(right) - associationEffect(left)
    || left.factor.localeCompare(right.factor, "zh-CN")
  )).slice(0, 3);

  const weekAgo = shiftDateKey(currentDate, -6);
  const weekRoots = store.thoughts.filter(item => (
    item.type === "question"
    && (item.occurredOn || item.createdAt.slice(0, 10)) >= weekAgo
  ));
  const answeredRoots = weekRoots.filter(root => store.thoughts.some(item => (
    item.relatedTo === root.id && item.type === "answer"
  )));
  const monthAgo = shiftDateKey(currentDate, -29);
  const itemDate = item => {
    const timestamp = item?.occurredAt || item?.createdAt;
    return item?.occurredOn || (timestamp ? localDateKey(timestamp) : "");
  };
  const inWindow = (item, cutoff) => {
    const date = itemDate(item);
    return date >= cutoff && date <= currentDate;
  };
  const activeDates = new Set([
    ...store.checkins,
    ...store.dailyRecords,
    ...store.captures,
    ...store.journals,
    ...store.thoughts.filter(item => item.type === "question"),
    ...store.chats,
    ...store.quotes,
    ...store.books.flatMap(book => book.notes || []),
    ...store.keepsakes
  ].filter(item => inWindow(item, weekAgo)).map(itemDate));
  const checkinDates30 = new Set(
    store.checkins.filter(item => inWindow(item, monthAgo)).map(itemDate)
  );
  const healthDates30 = new Set(
    store.dailyRecords.filter(item => inWindow(item, monthAgo)).map(itemDate)
  );
  const pairedDays30 = [...checkinDates30].filter(date => healthDates30.has(date)).length;
  const roots30 = store.thoughts.filter(item => (
    item.type === "question" && inWindow(item, monthAgo)
  ));
  const tracedRoots30 = roots30.filter(root => thoughtHasUserTrace(store, root));
  const aiOnlyThoughtIds = store.thoughts
    .filter(item => item.type === "question" && thoughtIsUntouchedAiOnly(store, item))
    .map(item => item.id);
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
    ...(root.annotations || []),
    ...(root.annotationDrift || [])
  ]);
  const correctionActions30 = [
    ...store.thoughts
      .filter(item => item.type === "answer" && item.editedFromModel)
      .map(item => ({
        ...item,
        occurredOn: localDateKey(item.updatedAt || item.createdAt || item.occurredAt)
      })),
    ...store.thoughts.flatMap(root => root.followUps || []),
    ...store.thoughts.flatMap(root => root.remarks || []),
    ...annotations,
    ...annotations.flatMap(annotation => annotation.replies || []),
    ...store.journals.flatMap(journal => journal.reflections || []),
    ...store.analyses.filter(item => item.reason === "manual")
  ].filter(item => inWindow(item, monthAgo)).length;
  const latestAnalysisDate = store.analyses
    .map(item => localDateKey(item.createdAt))
    .filter(Boolean)
    .sort()
    .at(-1) || "";
  const reviewAgeDays = latestAnalysisDate
    ? Math.max(0, Math.round((
      Date.parse(`${currentDate}T00:00:00Z`)
      - Date.parse(`${latestAnalysisDate}T00:00:00Z`)
    ) / 86400000))
    : null;

  return {
    trends,
    associations,
    aiOnlyThoughtIds,
    weekly: {
      checkins: recent.length,
      thoughts: weekRoots.length,
      questions: weekRoots.length,
      answers: answeredRoots.length,
      kept: weekRoots.filter(item => item.disposition === "kept").length,
      activeDays7: activeDates.size,
      pairedDays30,
      rootCount30: roots30.length,
      tracedRoots30: tracedRoots30.length,
      traceRate30: roots30.length
        ? Math.round(tracedRoots30.length / roots30.length * 100)
        : null,
      correctionActions30,
      reviewAgeDays,
      analysisCount: store.analyses.length
    }
  };
}
