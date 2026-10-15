import { summarizeThoughtWindowItems } from "../../../generated/thought-page-window.mjs";
import { plainPreview } from "../../content/index.mjs";
import { eventDate, eventTimestamp } from "../../time/index.mjs";
import { isPendingAiTaskStatus } from "../../shared/ai-task-status.mjs";

export function normalizeThoughtSearch(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/g, " ")
    .trim();
}

function searchableText(...values) {
  const parts = [];
  const append = value => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach(append);
      return;
    }
    if (typeof value === "object") {
      Object.values(value).forEach(append);
      return;
    }
    parts.push(String(value));
  };
  values.forEach(append);
  return normalizeThoughtSearch(parts.join(" "));
}

export function thoughtMatchesSearch(chain, query) {
  const normalized = normalizeThoughtSearch(query);
  if (!normalized) return true;
  const { question, children } = chain;
  const haystack = searchableText(
    question.content,
    question.tags,
    question.remarks,
    question.followUps,
    children.map(item => [item.content, item.modelDraft, item.tags])
  );
  return normalized.split(" ").every(term => haystack.includes(term));
}

export function thoughtDate(chain) {
  return eventDate(chain.question);
}

export function thoughtSortTimestamp(chain, mode = "occurred") {
  return mode === "created"
    ? chain.question.createdAt || eventTimestamp(chain.question)
    : eventTimestamp(chain.question);
}

export function createThoughtChains(records = [], mode = "occurred") {
  const values = Array.isArray(records) ? records : [];
  const roots = values.filter(item => item.type === "question");
  const ids = new Set(roots.map(item => item.id));
  const grouped = roots.map(question => ({
    question,
    children: values
      .filter(item => item.relatedTo === question.id)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
  }));
  values
    .filter(item => item.type !== "question" && (!item.relatedTo || !ids.has(item.relatedTo)))
    .forEach(item => grouped.push({
      question: { ...item, type: "question", content: "（旧记录未关联问题）" },
      children: [item]
    }));
  return grouped.sort((left, right) => (
    thoughtSortTimestamp(right, mode).localeCompare(thoughtSortTimestamp(left, mode))
    || String(right.question.id).localeCompare(String(left.question.id))
  ));
}

export function thoughtAnswerPreview(content) {
  return plainPreview(content)
    .replace(
      /^(?:核心判断|给我判断|给你(?:一个)?判断|我的判断|结论)(?:\s*[：:]|\s+)\s*/u,
      ""
    )
    .trimStart();
}

export function isAiThoughtBlock(item) {
  return item?.authorType === "ai"
    || /^(?:deepseek|codex|openai|model|ai)(?:$|[-_:])/i.test(item?.origin || "")
    || Boolean(item?.reasoningContent);
}

function compareThoughtOccurrence(left, right) {
  return eventTimestamp(left).localeCompare(eventTimestamp(right))
    || String(left?.createdAt || "").localeCompare(String(right?.createdAt || ""))
    || String(left?.id || "").localeCompare(String(right?.id || ""));
}

export function currentUserConclusion(children = []) {
  return children
    .filter(item => (
      item.type === "answer"
      && item.authorType !== "ai"
      && !isAiThoughtBlock(item)
      && item.disposition !== "discarded"
      && plainPreview(item.content)
    ))
    .sort((left, right) => compareThoughtOccurrence(right, left))[0] || null;
}

export function initialThoughtIdea(children = []) {
  return children
    .filter(item => (
      item.type === "idea"
      && item.authorType !== "ai"
      && !isAiThoughtBlock(item)
      && item.disposition !== "discarded"
      && plainPreview(item.content)
    ))
    .sort(compareThoughtOccurrence)[0] || null;
}

export function thoughtListPreview(children = [], summary = null) {
  if (summary?.content) {
    return {
      kind: summary.kind,
      label: summary.kind === "conclusion" ? "我的结论" : "初步想法",
      text: summary.content
    };
  }
  const conclusion = currentUserConclusion(children);
  if (conclusion) {
    return {
      kind: "conclusion",
      label: "我的结论",
      text: thoughtAnswerPreview(conclusion.content)
    };
  }
  const idea = initialThoughtIdea(children);
  return idea
    ? { kind: "idea", label: "初步想法", text: plainPreview(idea.content) }
    : null;
}

export function thoughtMonthLabel(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]} 年 ${Number(match[2])} 月` : "时间未记录";
}

export function visibleThoughtChains({
  records,
  mode = "occurred",
  tag = "all",
  query = "",
  complete = true
} = {}) {
  const chains = createThoughtChains(records, mode);
  const tagged = tag === "all"
    ? chains
    : chains.filter(({ question, children }) => (
      [...(question.tags || []), ...children.flatMap(item => item.tags || [])].includes(tag)
    ));
  return {
    chains,
    items: complete ? tagged.filter(chain => thoughtMatchesSearch(chain, query)) : tagged
  };
}

export function pendingThoughtTask(tasks, kind, targetId, subtargetId = "") {
  return (Array.isArray(tasks) ? tasks : []).find(task => (
    task.kind === kind
    && task.targetId === targetId
    && (!subtargetId || task.subtargetId === subtargetId)
    && isPendingAiTaskStatus(task.status)
  ));
}

/**
 * 将本地思绪变更接入当前列表摘要，保留既有_sync及用户结论语义。
 * 连续分页失效后释放旧页引用；完整原文仍属于持久队列、草稿或单条详情。
 * @since unreleased
 */
export function reconcileThoughtWindowMutation(snapshot, route, enabled, limits) {
  if (!enabled || route?.view !== "thoughts" || route.kind === "detail" || !snapshot.thoughtPage?.window) return false;
  const page = snapshot.thoughtPage, window = page.window;
  if (!window.stale) { window.stale = true; window.generation += 1; }
  page.stale = true;
  window.pages = [];
  snapshot.thoughts = summarizeThoughtWindowItems(snapshot.thoughts || [], limits, (blocks, previous) => thoughtListPreview(blocks, blocks.length ? null : previous));
  return true;
}
