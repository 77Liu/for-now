export const TRASH_TYPE_LABELS = Object.freeze({
  checkin: "状态",
  dailyRecord: "健康日录",
  capture: "捕念",
  captureAudio: "捕念语音",
  journal: "日记",
  journalReflection: "日记回望",
  thoughtChain: "思绪",
  thoughtBlock: "思绪内容",
  thoughtRemark: "思绪备注",
  thoughtFollowUp: "追问",
  annotation: "批注",
  annotationDrift: "漂流批注",
  chat: "对话",
  book: "书目",
  bookNote: "读书记录",
  keepsake: "小物",
  quote: "善言",
  experiment: "实验",
  analysis: "复盘",
  customMetric: "自定义指标",
  action: "行动",
  habit: "习惯",
  habitCheckin: "习惯打卡"
});

export const TRASH_DETAIL_LABELS = Object.freeze({
  content: "内容",
  question: "问题",
  idea: "初步想法",
  answer: "我的结论",
  title: "标题",
  message: "内容",
  text: "内容",
  note: "备注",
  description: "说明",
  summary: "摘要",
  source: "来源",
  author: "作者",
  publisher: "出版社",
  category: "类别",
  hypothesis: "假设",
  factor: "观察因素",
  outcome: "观察结果",
  duration: "周期",
  feeling: "感受",
  quote: "原文",
  tags: "标签",
  occurredOn: "发生日期",
  disposition: "处理状态",
  type: "内容类型",
  origin: "记录方式",
  authorType: "内容来源"
});

export const TRASH_DETAIL_VALUES = Object.freeze({
  disposition: Object.freeze({ kept: "已保留", discarded: "已舍弃" }),
  type: Object.freeze({
    question: "问题",
    idea: "初步想法",
    record: "经历",
    answer: "回答"
  }),
  origin: Object.freeze({ manual: "手动记录", model: "AI 生成" }),
  authorType: Object.freeze({ user: "本人", ai: "AI" })
});

const IGNORED_DETAIL_KEYS = new Set([
  "id",
  "clientRequestId",
  "requestHash",
  "originalPath",
  "cutoutPath",
  "imagePath",
  "attachmentPaths"
]);

const text = value => String(value ?? "").trim();

export function trashPayload(entry) {
  if (entry?.type !== "thoughtChain") return [entry?.payload];
  const records = Array.isArray(entry?.payload?.items) ? entry.payload.items : [];
  return records.map(record => record?.item).filter(Boolean);
}

export function trashTitleSource(entry) {
  const items = trashPayload(entry);
  const item = items.find(value => value?.type === "question") || items[0] || {};
  return item.content
    || item.question
    || item.title
    || item.message
    || item.source
    || item.hypothesis
    || item.name
    || item.text
    || "无标题记录";
}

export function trashDetailRows(entry, { limit = 80 } = {}) {
  const rows = [];
  const append = (label, value) => {
    if (rows.length < limit) rows.push(Object.freeze({ label, value }));
  };
  const visit = (value, key = "", label = TRASH_DETAIL_LABELS[key] || "") => {
    if (value == null || rows.length >= limit) return;
    if (Array.isArray(value)) {
      if (key === "tags") {
        const tags = value.map(text).filter(Boolean);
        if (tags.length) append(label, tags.map(tag => `#${tag}`).join(" "));
      } else {
        value.forEach(item => visit(item, key, label));
      }
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, item] of Object.entries(value)) {
        if (!IGNORED_DETAIL_KEYS.has(childKey)) {
          visit(item, childKey, TRASH_DETAIL_LABELS[childKey] || "");
        }
      }
      return;
    }
    const valueText = typeof value === "string" ? value.trim() : "";
    if (
      !label
      || !valueText
      || /^(?:[0-9a-f-]{24,}|\d{4}-\d{2}-\d{2}T)/i.test(valueText)
    ) return;
    append(label, TRASH_DETAIL_VALUES[key]?.[valueText] || valueText);
  };
  trashPayload(entry).forEach(item => visit(item));
  return Object.freeze(rows);
}

export function createTrashModel() {
  let items = [];
  let selectedIds = new Set();

  const availableIds = () => new Set(items.map(item => text(item?.id)).filter(Boolean));

  function replaceItems(value) {
    items = Array.isArray(value) ? value.filter(item => item && typeof item === "object") : [];
    const available = availableIds();
    selectedIds = new Set([...selectedIds].filter(id => available.has(id)));
  }

  function select(id, selected) {
    const value = text(id);
    if (!value || !availableIds().has(value)) return false;
    if (selected) selectedIds.add(value);
    else selectedIds.delete(value);
    return true;
  }

  function clear() {
    items = [];
    selectedIds.clear();
  }

  return Object.freeze({
    replaceItems,
    select,
    clear,
    has: id => items.some(item => text(item?.id) === text(id)),
    hasSelection: () => selectedIds.size > 0,
    snapshot: () => Object.freeze({
      items,
      selectedIds: Object.freeze([...selectedIds])
    })
  });
}
