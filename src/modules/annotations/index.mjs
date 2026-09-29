import { cleanAttachmentPaths } from "../../shared/attachments/index.mjs";
import { markdownText } from "../../shared/content/index.mjs";
import { recordVersion, safeText } from "../../shared/validation/index.mjs";
export { shenjiSystemPrompt, annotationPrompt } from "./prompts.mjs";

export const ANNOTATION_KINDS = Object.freeze(["comment", "highlight", "emphasis"]);
const ANNOTATION_KIND_SET = new Set(ANNOTATION_KINDS);

export function sortAnnotationsByPosition(items, targetOrder = []) {
  const order = new Map(targetOrder.map((targetKey, index) => [targetKey, index]));
  const rank = item => order.has(item?.targetKey) ? order.get(item.targetKey) : targetOrder.length;
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => (
    rank(left) - rank(right)
    || String(left?.targetKey || "").localeCompare(String(right?.targetKey || ""))
    || (Number(left?.start) || 0) - (Number(right?.start) || 0)
    || (Number(left?.end) || 0) - (Number(right?.end) || 0)
    || String(left?.createdAt || "").localeCompare(String(right?.createdAt || ""))
    || String(left?.id || "").localeCompare(String(right?.id || ""))
  ));
}

export function annotationTaskResult(root, task) {
  if (task?.kind !== "annotationShenji" || !task.id || !task.subtargetId || !task.resultId) return null;
  const annotation = root?.annotations?.find(item => item?.id === task.subtargetId);
  return annotation?.shenji?.find(item => item?.id === task.resultId && item.sourceTaskId === task.id) || null;
}

export function annotationExcerpt(source, annotation) {
  let start = Math.max(0, Number(annotation.start) || 0), end = Math.max(start, Number(annotation.end) || start);
  if (source.slice(start, end) !== annotation.quote) { const found = source.indexOf(annotation.quote); if (found >= 0) { start = found; end = found + annotation.quote.length; } }
  return { before: source.slice(Math.max(0, start - 1000), start), focus: annotation.quote, after: source.slice(end, end + 1000) };
}

export function annotationAnchorContext(source, start, end, quote) {
  const raw = String(source || ""), focus = String(quote || "");
  let rawStart = Math.max(0, Number(start) || 0);
  if (raw.slice(rawStart, rawStart + focus.length) !== focus) {
    const candidates = []; let cursor = raw.indexOf(focus);
    while (cursor >= 0) { candidates.push(cursor); cursor = raw.indexOf(focus, cursor + 1); }
    if (candidates.length) rawStart = candidates.reduce((best, value) => Math.abs(value - rawStart) < Math.abs(best - rawStart) ? value : best, candidates[0]);
  }
  const rawEnd = rawStart + focus.length;
  return { rawStart, contextBefore: raw.slice(Math.max(0, rawStart - 240), rawStart), contextAfter: raw.slice(rawEnd, rawEnd + 240), originalContext: { before: raw.slice(Math.max(0, rawStart - 1000), rawStart), focus, after: raw.slice(rawEnd, rawEnd + 1000) } };
}

function commonPrefixLength(a = "", b = "") { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1; return i; }
function commonSuffixLength(a = "", b = "") { return commonPrefixLength([...a].reverse().join(""), [...b].reverse().join("")); }

function bestAnnotationAnchor(source, annotation) {
  const raw = String(source || ""), quote = String(annotation.quote || "");
  if (!quote) return null;
  const candidates = []; let cursor = raw.indexOf(quote);
  while (cursor >= 0) { candidates.push(cursor); cursor = raw.indexOf(quote, cursor + 1); }
  if (!candidates.length) return null;
  const priorRawStart = Number.isFinite(Number(annotation.rawStart)) ? Number(annotation.rawStart) : Number(annotation.start) || 0;
  return candidates.map(start => {
    const before = raw.slice(Math.max(0, start - 240), start), after = raw.slice(start + quote.length, start + quote.length + 240);
    const contextScore = commonSuffixLength(annotation.contextBefore || annotation.originalContext?.before || "", before) * 4 + commonPrefixLength(annotation.contextAfter || annotation.originalContext?.after || "", after) * 4;
    return { start, score: contextScore - Math.min(500, Math.abs(start - priorRawStart)) / 500 };
  }).sort((a, b) => b.score - a.score)[0].start;
}

export function createAnnotationService({ createId, now }) {
  const normalizedKind = value => ANNOTATION_KIND_SET.has(value) ? value : null;

  return {
    detachTargets(parent, targetKeys) {
      const keys = new Set(targetKeys);
      if (!keys.size) return { annotations: [], annotationDrift: [] };
      const annotations = (parent.annotations || []).filter(item => keys.has(item.targetKey));
      const annotationDrift = (parent.annotationDrift || []).filter(item => keys.has(item.targetKey) || keys.has(item.originalTargetKey));
      parent.annotations = (parent.annotations || []).filter(item => !keys.has(item.targetKey));
      parent.annotationDrift = (parent.annotationDrift || []).filter(item => !keys.has(item.targetKey) && !keys.has(item.originalTargetKey));
      return { annotations, annotationDrift };
    },

    restoreDependents(parent, dependents) {
      parent.annotations = [...(parent.annotations || []), ...(dependents?.annotations || [])];
      parent.annotationDrift = [...(parent.annotationDrift || []), ...(dependents?.annotationDrift || [])];
    },

    creationInput(input) {
      const kind = normalizedKind(input.kind || "comment");
      const targetKey = safeText(input.targetKey, 160), quote = safeText(input.quote, 1000), text = safeText(input.text, 4000);
      const attachmentPaths = cleanAttachmentPaths(input.attachmentPaths);
      const start = Math.max(0, Number(input.start) || 0), end = Math.max(start, Number(input.end) || start);
      if (!kind) return { invalid: true, error: "标记类型无效" };
      if (!targetKey || !quote || (kind === "comment" && !text && !attachmentPaths.length) || end <= start || end - start > 2000) {
        return { invalid: true, error: kind === "comment" ? "请选中正文，并填写评论或插入图片" : "请先选中需要标记的正文" };
      }
      return { value: { kind, targetKey, quote, text, attachmentPaths, start, end } };
    },

    create(root, source, { kind, targetKey, quote, text, attachmentPaths = [], start, end }) {
      if (!root || !source.includes(quote)) return { missing: true };
      const annotation = { id: createId(), kind, targetKey, start, end, quote, text, attachmentPaths, createdAt: now(), resolved: false, replies: [], version: 1, ...annotationAnchorContext(source, start, end, quote) };
      root.annotations ||= [];
      root.annotations.push(annotation);
      return { value: annotation };
    },

    convert(root, annotationId, input = {}) {
      const annotation = root?.annotations?.find(item => item.id === annotationId);
      if (!annotation) return { missing: true };
      const kind = normalizedKind(input.kind);
      if (!kind) return { invalid: true, error: "标记类型无效" };
      const hasText = Object.prototype.hasOwnProperty.call(input, "text");
      const nextText = hasText ? safeText(input.text, 4000) : safeText(annotation.text, 4000);
      if (kind === "comment" && !nextText && !cleanAttachmentPaths(annotation.attachmentPaths).length) {
        return { invalid: true, error: "转为评论前请填写评论内容" };
      }
      annotation.kind = kind;
      if (hasText || kind === "comment") annotation.text = nextText;
      annotation.updatedAt = now();
      annotation.version = recordVersion(annotation.version) + 1;
      return { value: annotation };
    },

    list(root, { targetOrder = [] } = {}) {
      return sortAnnotationsByPosition(root?.annotations, targetOrder);
    },

    taskResult(root, task) {
      return annotationTaskResult(root, task);
    },

    replyInput(input) {
      const text = safeText(input.text, 4000);
      if (!text) return { invalid: true, error: "回复不能为空" };
      return { value: text };
    },

    reply(root, annotationId, text) {
      const annotation = root?.annotations?.find(item => item.id === annotationId);
      if (!annotation || annotation.kind !== "comment") return { missing: true };
      const reply = { id: createId(), text, createdAt: now() };
      annotation.replies ||= [];
      annotation.replies.push(reply);
      return { value: reply };
    },

    saveTaskReply(annotation, task, result) {
      let exchange = (annotation.shenji || []).find(item => item.sourceTaskId === task.id);
      if (!exchange) {
        exchange = { id: createId(), createdAt: now(), message: safeText(task.payload?.message, 6000), answer: result.content, sourceTaskId: task.id, clientRequestId: task.clientRequestId, ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}) };
        annotation.shenji ||= [];
        annotation.shenji.push(exchange);
      }
      return exchange.id;
    },

    reanchorAnnotations(root, targetKey, oldSource, newSource, reason = "正文已修改") {
      root.annotations ||= []; root.annotationDrift ||= [];
      const oldDisplay = markdownText(oldSource), newDisplay = markdownText(newSource);
      const keep = [];
      for (const annotation of root.annotations) {
        if (annotation.targetKey !== targetKey) { keep.push(annotation); continue; }
        const oldAnchor = annotationAnchorContext(oldDisplay, annotation.start, annotation.end, annotation.quote);
        annotation.originalContext ||= oldAnchor.originalContext;
        const nextRawStart = bestAnnotationAnchor(newDisplay, { ...annotation, rawStart: oldAnchor.rawStart, contextBefore: oldAnchor.contextBefore, contextAfter: oldAnchor.contextAfter });
        if (nextRawStart == null) { root.annotationDrift.push({ ...annotation, driftedAt: now(), driftReason: reason, originalTargetKey: targetKey }); continue; }
        const next = annotationAnchorContext(newDisplay, nextRawStart, nextRawStart + annotation.quote.length, annotation.quote);
        annotation.start = nextRawStart; annotation.end = nextRawStart + annotation.quote.length;
        annotation.rawStart = nextRawStart; annotation.contextBefore = next.contextBefore; annotation.contextAfter = next.contextAfter; annotation.updatedAt = now();
        keep.push(annotation);
      }
      root.annotations = keep;
    }
  };
}
