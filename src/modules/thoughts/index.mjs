import { THOUGHT_PAGING } from "../../../.build/typescript/backend/shared/thought-pagination/index.mjs";
import crypto from "node:crypto";
import { cleanAttachmentPaths } from "../../shared/attachments/index.mjs";
import {
  recordVersion as normalizedVersion,
  safeText
} from "../../shared/validation/index.mjs";
import { stripThoughtAnswerLead } from "./prompts.mjs";
export { thoughtTask, thoughtPromptSystem, stripThoughtAnswerLead, thoughtPersonalContext, thoughtChainContext, thoughtDraftInput, thoughtStarterPrompt } from "./prompts.mjs";

const AFTER_COMMIT = Symbol.for("for-now.after-commit");
const CHAIN_LIST_LIMIT = THOUGHT_PAGING.pageSize;
const QUESTION_PREVIEW_LIMIT = THOUGHT_PAGING.questionPreviewLimit;
const USER_PREVIEW_LIMIT = THOUGHT_PAGING.userPreviewLimit;
const requestDigest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isAiAnswer = item => (
  item?.authorType === "ai"
  || /^(?:deepseek|codex|openai|model|ai)(?:$|[-_:])/i.test(String(item?.origin || ""))
  || Boolean(item?.modelDraft)
  || Boolean(item?.reasoningContent)
);
const compareThoughtOccurrence = (left, right) => (
  String(left?.occurredAt || left?.occurredOn || left?.createdAt || "").localeCompare(
    String(right?.occurredAt || right?.occurredOn || right?.createdAt || "")
  )
  || String(left?.createdAt || "").localeCompare(String(right?.createdAt || ""))
  || String(left?.id || "").localeCompare(String(right?.id || ""))
);
const latestSpeechAnswer = (items, ai) => items
  .filter(item => (
    item?.type === "answer"
    && item.disposition !== "discarded"
    && Boolean(safeText(item.content, 120_000))
    && isAiAnswer(item) === ai
  ))
  .sort((left, right) => compareThoughtOccurrence(right, left))[0] || null;
const normalizedSearchText = value => String(value ?? "")
  .normalize("NFKC")
  .toLocaleLowerCase("zh-CN")
  .replace(/\s+/g, " ")
  .trim();
const limitedText = (value, limit) => {
  const full = String(value ?? "").trim();
  return { content: full.slice(0, limit), truncated: full.length > limit };
};
const normalizedListSort = value => value === "created" ? "created" : "occurred";
const normalizedListTag = value => safeText(value, 30).normalize("NFKC").trim();
const chainSortTuple = (root, sort) => ({
  primary: String(sort === "created"
    ? root?.createdAt || root?.occurredAt || ""
    : root?.occurredAt || root?.createdAt || ""),
  created: String(root?.createdAt || ""),
  id: String(root?.id || "")
});
const compareChainTuples = (left, right) => (
  right.primary.localeCompare(left.primary)
  || right.created.localeCompare(left.created)
  || right.id.localeCompare(left.id)
);
const chainCursorScope = ({ query, tag, sort, cursorScope }) => requestDigest({
  version: 3,
  resource: "thought-chain",
  cursorScope: String(cursorScope || ""),
  query,
  tag,
  sort
}).slice(0, 20);
const chainCursor = (root, filters) => JSON.stringify({
  v: 3,
  ...chainSortTuple(root, filters.sort),
  scope: chainCursorScope(filters)
});
const parseChainCursor = (value, filters) => {
  if (!value) return null;
  try {
    const cursor = JSON.parse(value);
    if (
      cursor?.v !== 3
      || typeof cursor.primary !== "string"
      || typeof cursor.created !== "string"
      || typeof cursor.id !== "string"
      || !cursor.id
      || cursor.id.length > 100
      || cursor.scope !== chainCursorScope(filters)
    ) return false;
    return cursor;
  } catch {
    return false;
  }
};
const chainSearchText = (root, blocks) => normalizedSearchText([
  root.content,
  ...(Array.isArray(root.tags) ? root.tags : []),
  ...(Array.isArray(root.remarks) ? root.remarks.map(item => item?.text) : []),
  ...(Array.isArray(root.followUps)
    ? root.followUps.flatMap(item => [item?.question, item?.answer])
    : []),
  ...blocks.flatMap(item => [
    item?.content,
    ...(Array.isArray(item?.tags) ? item.tags : [])
  ])
].filter(Boolean).join(" "));
const chainMatchesQuery = (root, blocks, query) => {
  if (!query) return true;
  const content = chainSearchText(root, blocks);
  return query.split(" ").every(term => content.includes(term));
};
const userChainPreview = blocks => {
  const conclusion = blocks
    .filter(item => (
      item?.type === "answer"
      && item.disposition !== "discarded"
      && !isAiAnswer(item)
      && Boolean(safeText(item.content, 120_000))
    ))
    .sort((left, right) => compareThoughtOccurrence(right, left))[0];
  const idea = conclusion ? null : blocks
    .filter(item => (
      item?.type === "idea"
      && item.disposition !== "discarded"
      && !isAiAnswer(item)
      && Boolean(safeText(item.content, 120_000))
    ))
    .sort(compareThoughtOccurrence)[0];
  const item = conclusion || idea;
  if (!item) return null;
  const raw = conclusion ? stripThoughtAnswerLead(item.content) || item.content : item.content;
  const preview = limitedText(raw, USER_PREVIEW_LIMIT);
  return {
    kind: conclusion ? "conclusion" : "idea",
    content: preview.content,
    truncated: preview.truncated
  };
};
export const thoughtChainSummary = (root, blocks) => {
  const question = limitedText(root.content, QUESTION_PREVIEW_LIMIT);
  const tags = [...new Set([...(root.tags || []), ...blocks.flatMap(item => item?.tags || [])]
    .map(tag => safeText(tag, 30))
    .filter(Boolean))].slice(0, 8);
  return {
    id: String(root.id),
    type: "question",
    content: question.content,
    contentTruncated: question.truncated,
    version: normalizedVersion(root.version),
    occurredAt: root.occurredAt || null,
    occurredOn: root.occurredOn || null,
    createdAt: root.createdAt || null,
    updatedAt: root.updatedAt || null,
    tags,
    disposition: ["pending", "kept", "discarded"].includes(root.disposition)
      ? root.disposition
      : "kept",
    attachmentCount: cleanAttachmentPaths(root.attachmentPaths).length,
    blockCount: blocks.length,
    answerCount: blocks.filter(item => item?.type === "answer").length,
    preview: userChainPreview(blocks),
    ...(root.sourceRef ? {
      sourceRef: {
        type: root.sourceRef.type,
        id: root.sourceRef.id,
        version: normalizedVersion(root.sourceRef.version)
      }
    } : {})
  };
};

function publicThoughtValue(value) {
  if (Array.isArray(value)) return value.map(publicThoughtValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["modelDraft", "modelReasoning", "reasoningContent", "requestHash"].includes(key))
    .map(([key, item]) => [key, publicThoughtValue(item)]));
}

export function thoughtChainDetail(thoughts, id) {
  const items = Array.isArray(thoughts) ? thoughts : [];
  const root = items.find(item => item?.id === id && item.type === "question");
  return root ? {
    ...publicThoughtValue(root),
    blocks: items
      .filter(item => item?.relatedTo === root.id)
      .map(publicThoughtValue)
  } : null;
}

/**
 * 在同一账户与筛选scope下按稳定tuple双向读取摘要；prev保持既有展示排序。
 * 空页以原游标保留反向恢复边界；每次读取是实时列表，不构成跨请求冻结快照。
 */
export function thoughtChainListPage(thoughts, {
  limit = CHAIN_LIST_LIMIT,
  maxLimit = CHAIN_LIST_LIMIT,
  afterId = "",
  direction = "next",
  query = "",
  tag = "",
  sort = "occurred",
  cursorScope = ""
} = {}) {
  const items = Array.isArray(thoughts) ? thoughts : [];
  const blocksByRoot = new Map();
  const roots = [];
  for (const item of items) {
    if (item.type === "question") {
      roots.push(item);
    } else if (item.relatedTo) {
      const blocks = blocksByRoot.get(item.relatedTo) || [];
      blocks.push(item);
      blocksByRoot.set(item.relatedTo, blocks);
    }
  }
  const normalizedQuery = normalizedSearchText(query);
  const normalizedTag = normalizedListTag(tag);
  const normalizedSort = normalizedListSort(sort);
  const availableTags = [...new Set(roots.flatMap(root => [
    ...(root.tags || []),
    ...(blocksByRoot.get(root.id) || []).flatMap(item => item?.tags || [])
  ]).map(normalizedListTag).filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN")).slice(0, 100);
  const filters = { query: normalizedQuery, tag: normalizedTag, sort: normalizedSort, cursorScope };
  const matches = roots
    .filter(root => {
      const blocks = blocksByRoot.get(root.id) || [];
      const tags = [...(root.tags || []), ...blocks.flatMap(item => item?.tags || [])]
        .map(normalizedListTag);
      return (!normalizedTag || tags.includes(normalizedTag))
        && chainMatchesQuery(root, blocks, normalizedQuery);
    })
    .sort((left, right) => compareChainTuples(
      chainSortTuple(left, normalizedSort),
      chainSortTuple(right, normalizedSort)
    ));
  const cursor = parseChainCursor(afterId, filters);
  if (cursor === false) return { invalidCursor: true };
  if (!["next", "prev"].includes(direction) || (direction === "prev" && !cursor)) return { invalidQuery: true };
  const pageLimit = Number.isSafeInteger(limit)
    ? Math.min(Math.max(CHAIN_LIST_LIMIT, Number(maxLimit) || 0), Math.max(1, limit))
    : CHAIN_LIST_LIMIT;
  const candidates = cursor ? matches.filter(root => {
    const comparison = compareChainTuples(chainSortTuple(root, normalizedSort), cursor);
    return direction === "prev" ? comparison < 0 : comparison > 0;
  }) : matches;
  const selected = direction === "prev" ? candidates.slice(-pageLimit) : candidates.slice(0, pageLimit);
  const first = selected[0], last = selected.at(-1);
  const newer = first ? matches.some(root => compareChainTuples(chainSortTuple(root, normalizedSort), chainSortTuple(first, normalizedSort)) < 0) : direction === "next" && matches.length > 0;
  const older = last ? matches.some(root => compareChainTuples(chainSortTuple(root, normalizedSort), chainSortTuple(last, normalizedSort)) > 0) : direction === "prev" && matches.length > 0;
  return {
    items: selected.map(root => thoughtChainSummary(root, blocksByRoot.get(root.id) || [])),
    nextId: older ? (last ? chainCursor(last, filters) : afterId) : "",
    prevId: newer ? (first ? chainCursor(first, filters) : afterId) : "",
    tags: availableTags
  };
}

export function thoughtChainSpeechSource(thoughts, rootId) {
  const items = Array.isArray(thoughts) ? thoughts : [];
  const root = items.find(item => item?.id === rootId && item.type === "question");
  if (!root) return null;
  const related = items.filter(item => item?.relatedTo === root.id);
  const conclusion = latestSpeechAnswer(related, false);
  const answer = latestSpeechAnswer(related, true);
  const sections = [
    { kind: "question", label: "我的问题", item: root },
    ...(conclusion ? [{ kind: "conclusion", label: "我的结论", item: conclusion }] : []),
    ...(answer ? [{ kind: "answer", label: "专属回答", item: answer }] : [])
  ].flatMap(({ kind, label, item }) => {
    const content = safeText(item.content, 120_000);
    return content ? [{ kind, label, content }] : [];
  });
  return {
    source: root,
    sourceVersion: normalizedVersion(root.version),
    sourceVersions: {
      question: { id: root.id, version: normalizedVersion(root.version) },
      ...(conclusion ? {
        conclusion: { id: conclusion.id, version: normalizedVersion(conclusion.version) }
      } : {}),
      ...(answer ? {
        answer: { id: answer.id, version: normalizedVersion(answer.version) }
      } : {})
    },
    sections
  };
}

export function thoughtTaskResult(thoughts, task) {
  if (!Array.isArray(thoughts) || !task?.id || !task?.targetId || !task?.resultId) return null;
  if (task.kind === "thoughtAnswer") {
    return thoughts.find(item => (
      item?.id === task.resultId
      && item.type === "answer"
      && item.relatedTo === task.targetId
      && item.sourceTaskId === task.id
    )) || null;
  }
  if (task.kind !== "followUpAnswer" || !task.subtargetId) return null;
  const root = thoughts.find(item => item?.id === task.targetId && item.type === "question");
  const followUp = root?.followUps?.find(item => item?.id === task.subtargetId);
  return followUp?.id === task.resultId && followUp.sourceTaskId === task.id ? followUp : null;
}

export function createThoughtTaskTarget({ createId, now, stripThoughtAnswerLead }) {
  return {
    inspect(thoughts, task) {
      const root = thoughts.find(item => item.id === task.targetId && item.type === "question");
      if (!root) return null;
      if (task.kind === "thoughtAnswer") return { root, inputVersion: normalizedVersion(root.version) };
      const followUp = root.followUps?.find(item => item.id === task.subtargetId);
      if (!followUp) return null;
      return { root, followUp, inputVersion: normalizedVersion(root.version), subtargetVersion: normalizedVersion(followUp.version), alreadyAnswered: Boolean(followUp.answer) };
    },
    saveAnswer(thoughts, work, task, result) {
      let answer = thoughts.find(item => item.sourceTaskId === task.id);
      if (!answer) {
        const root = work.root;
        const generation = thoughts.filter(item => (
          item.relatedTo === root.id && item.type === "answer"
        )).length + 1;
        const content = stripThoughtAnswerLead(result.content);
        answer = {
          id: createId(),
          createdAt: now(),
          occurredAt: root.occurredAt,
          occurredOn: root.occurredOn,
          type: "answer",
          content,
          modelDraft: content,
          editedFromModel: false,
          tags: root.tags,
          relatedTo: root.id,
          disposition: root.disposition || "kept",
          remarks: [],
          origin: "deepseek",
          authorType: "ai",
          version: 1,
          sourceVersion: task.inputVersion,
          generation,
          sourceTaskId: task.id,
          ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}),
          ...(result.contextReceipt ? { contextReceipt: structuredClone(result.contextReceipt) } : {}),
          ...(Array.isArray(result.citations) ? { citations: structuredClone(result.citations) } : {}),
          ...(Array.isArray(result.providedReferences) ? { providedReferences: structuredClone(result.providedReferences) } : {}),
          ...(Array.isArray(result.rejectedReferences) ? { rejectedReferences: structuredClone(result.rejectedReferences) } : {}),
          ...(result.citationStatus ? { citationStatus: result.citationStatus } : {})
        };
        thoughts.unshift(answer);
      }
      return answer.id;
    },
    saveFollowUp(work, task, result) {
      const root = work.root;
      const current = work.followUp;
      current.answer = result.content;
      current.modelDraft = result.content;
      current.answeredAt = now();
      current.answerOccurredAt ||= current.answeredAt;
      current.origin = "deepseek";
      current.authorType = "ai";
      current.version = normalizedVersion(current.version) + 1;
      current.clientRequestId = task.clientRequestId;
      current.sourceTaskId = task.id;
      if (result.reasoningContent) current.reasoningContent = result.reasoningContent;
      if (result.contextReceipt) current.contextReceipt = structuredClone(result.contextReceipt);
      if (Array.isArray(result.citations)) current.citations = structuredClone(result.citations);
      if (result.citationStatus) current.citationStatus = result.citationStatus;
      if (Array.isArray(result.providedReferences)) current.providedReferences = structuredClone(result.providedReferences);
      if (Array.isArray(result.rejectedReferences)) current.rejectedReferences = structuredClone(result.rejectedReferences);
      root.version = normalizedVersion(root.version) + 1; root.updatedAt = now();
      return current.id;
    }
  };
}

export function createThoughtService({
  repository,
  createId,
  now,
  recordVersion,
  eventTimeFields,
  reanchorAnnotations,
  reconcileOriginalImages = null,
  getCursorScope = () => ""
}) {
  const touchRoot = root => {
    root.version = recordVersion(root.version) + 1;
    root.updatedAt = now();
  };

  return {
    createChainInStore(store, {
      questionText, eventTime, tags, clientRequestId, requestHash,
      idea, answer, modelDraft, modelReasoning, attachmentPaths = [], sourceRef = null
    }) {
      const originalImages = cleanAttachmentPaths(attachmentPaths);
      if (!questionText && !originalImages.length) {
        return { invalid: true, error: "请填写问题或插入图片" };
      }
      if (clientRequestId) {
        const existing = store.thoughts.filter(item => item.clientRequestId === clientRequestId);
        if (existing.length) {
          return existing.every(item => !item.requestHash || item.requestHash === requestHash)
            ? { items: existing, duplicate: true }
            : { conflict: true };
        }
      }
      let source = null;
      if (sourceRef) {
        const sourceId = typeof sourceRef.id === "string" ? sourceRef.id.trim() : "";
        const sourceVersion = Number(sourceRef.version);
        if (sourceRef.type !== "capture" || !sourceId || !Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
          return { invalid: true, error: "来源念起格式无效" };
        }
        const capture = (store.captures || []).find(item => item.id === sourceId);
        if (!capture) return { sourceMissing: true };
        const currentSourceVersion = normalizedVersion(capture.version);
        if (sourceVersion !== currentSourceVersion) return { sourceVersionConflict: true, currentVersion: currentSourceVersion };
        const existingRoot = store.thoughts.find(item => item.type === "question" && item.sourceRef?.type === "capture" && item.sourceRef.id === sourceId);
        if (existingRoot) return { sourceConflict: true, rootId: existingRoot.id };
        source = { type: "capture", id: sourceId, version: currentSourceVersion };
      }
      const question = {
        id: createId(),
        createdAt: now(),
        ...eventTime,
        type: "question",
        content: questionText,
        attachmentPaths: originalImages,
        tags,
        relatedTo: null,
        disposition: "kept",
        remarks: [],
        origin: "manual",
        authorType: "user",
        version: 1,
        clientRequestId,
        requestHash,
        ...(source ? { sourceRef: source } : {})
      };
      store.thoughts.unshift(question);
      const items = [question];
      for (const [type, content] of [["idea", idea], ["answer", answer]]) {
        const draft = type === "answer" ? modelDraft : "";
        const reasoningContent = type === "answer" && draft ? modelReasoning : "";
        if (!content && !draft) continue;
        const item = {
          id: createId(),
          createdAt: now(),
          ...eventTime,
          type,
          content,
          tags,
          relatedTo: question.id,
          disposition: "kept",
          remarks: [],
          origin: draft ? "deepseek-edited" : "manual",
          authorType: draft ? "ai" : "user",
          version: 1,
          clientRequestId,
          requestHash,
          ...(draft ? { modelDraft: draft, editedFromModel: draft !== content } : {}),
          ...(reasoningContent ? { reasoningContent } : {})
        };
        store.thoughts.unshift(item);
        items.push(item);
      }
      return { items, duplicate: false };
    },

    updateChainInStore(store, {
      id, questionText, tags, changesEventTime, eventTimeInput, idea, answer,
      hasIdea, hasAnswer, expectedVersion, removeBlock, attachmentPaths, hasAttachmentPaths = false
    }) {
      const question = store.thoughts.find(item => item.id === id && item.type === "question");
      if (!question) return { missing: true };
      const currentVersion = recordVersion(question.version);
      if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
        return { versionConflict: true, currentVersion };
      }
      for (const type of ["idea", "answer"]) {
        const changed = type === "idea" ? hasIdea : hasAnswer;
        if (changed && store.thoughts.filter(item => item.relatedTo === id && item.type === type).length > 1) {
          return { blocksConflict: true };
        }
      }
      const eventTime = changesEventTime ? eventTimeFields(eventTimeInput, question) : null;
      if (changesEventTime && !eventTime) return { invalidTime: true };
      const originalImages = hasAttachmentPaths
        ? cleanAttachmentPaths(attachmentPaths)
        : cleanAttachmentPaths(question.attachmentPaths);
      if (!questionText && !originalImages.length) {
        return { invalid: true, error: "请保留问题文字或至少一张图片" };
      }
      const chainItems = store.thoughts.filter(item => item.id === id || item.relatedTo === id);
      const updatedAt = now();
      let reconciled = null;
      if (hasAttachmentPaths && typeof reconcileOriginalImages === "function") {
        reconciled = reconcileOriginalImages(store, "thoughtRoot", id, originalImages, {
          changedAt: updatedAt,
          touchResource: false,
          allowEmptyImages: true
        });
        if (!reconciled.value) return reconciled;
      }
      reanchorAnnotations(question, `question:${id}`, question.content, questionText);
      question.content = questionText;
      question.attachmentPaths = originalImages;
      question.tags = tags;
      question.updatedAt = updatedAt;
      question.version = currentVersion + 1;
      if (eventTime) for (const item of chainItems) Object.assign(item, eventTime);
      for (const [type, content, changed] of [["idea", idea, hasIdea], ["answer", answer, hasAnswer]]) {
        if (!changed) continue;
        const matches = store.thoughts.filter(item => item.relatedTo === id && item.type === type);
        const first = matches[0];
        if (content && first) {
          reanchorAnnotations(question, `${type}:${first.id}`, first.content, content);
          first.content = content;
          first.tags = tags;
          first.updatedAt = now();
          first.version = recordVersion(first.version) + 1;
          if (type === "answer" && first.modelDraft) first.editedFromModel = first.modelDraft !== content;
        } else if (content) {
          store.thoughts.unshift({
            id: createId(),
            createdAt: now(),
            occurredAt: question.occurredAt,
            occurredOn: question.occurredOn,
            type,
            content,
            tags,
            relatedTo: id,
            disposition: question.disposition || "kept",
            remarks: [],
            origin: "manual",
            authorType: "user",
            version: 1
          });
        } else if (first) removeBlock(store, first.id);
      }
      // A chain update advances the aggregate once; standalone block deletion
      // may touch the same root through its reusable trash mutation.
      question.updatedAt = updatedAt;
      question.version = currentVersion + 1;
      const result = { value: question, ...(reconciled?.trashId ? { trashId: reconciled.trashId } : {}) };
      if (reconciled?.[AFTER_COMMIT]) Object.defineProperty(result, AFTER_COMMIT, { value: reconciled[AFTER_COMMIT] });
      return result;
    },

    saveGeneratedAnswerInStore(store, {
      id, clientRequestId, sourceVersion, sourceTaskId = "", content, reasoningContent, contextReceipt = null
    }) {
      const duplicate = store.thoughts.find(item => item.relatedTo === id && item.type === "answer" && item.clientRequestId === clientRequestId);
      if (duplicate) return { value: duplicate, duplicate: true };
      const question = store.thoughts.find(item => item.id === id && item.type === "question");
      if (!question || recordVersion(question.version) !== sourceVersion) return { stale: true };
      const answer = {
        id: createId(),
        createdAt: now(),
        occurredAt: question.occurredAt,
        occurredOn: question.occurredOn,
        type: "answer",
        content,
        modelDraft: content,
        editedFromModel: false,
        tags: question.tags,
        relatedTo: id,
        disposition: question.disposition || "kept",
        remarks: [],
        origin: "deepseek",
        authorType: "ai",
        version: 1,
        sourceVersion,
        generation: store.thoughts.filter(item => item.relatedTo === id && item.type === "answer").length + 1,
        clientRequestId,
        ...(sourceTaskId ? { sourceTaskId } : {}),
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(contextReceipt ? { contextReceipt: structuredClone(contextReceipt) } : {})
      };
      store.thoughts.unshift(answer);
      return { value: answer, duplicate: false };
    },

    async getChain(id) {
      const store = await repository.read();
      return thoughtChainDetail(store.thoughts, id);
    },

    async getTaskResult(task) {
      return thoughtTaskResult((await repository.read()).thoughts, task);
    },

    async listChains({ limit = CHAIN_LIST_LIMIT, afterId = "", direction = "next", query = "", tag = "", sort = "occurred" } = {}) {
      const store = await repository.read();
      return thoughtChainListPage(store.thoughts, {
        limit,
        afterId,
        direction,
        query,
        tag,
        sort,
        cursorScope: getCursorScope()
      });
    },

    createBlock({ content, eventTime, type, relatedTo, tags, attachmentPaths = [], clientRequestId = "" }) {
      const originalImages = cleanAttachmentPaths(attachmentPaths);
      if (!content && !originalImages.length) return Promise.resolve({ invalid: true, error: "请填写文字或插入图片" });
      const requestHash = clientRequestId ? requestDigest({ content, eventTime, type, relatedTo, tags, attachmentPaths: originalImages }) : "";
      const createInStore = store => {
        const root = relatedTo ? store.thoughts.find(item => item.id === relatedTo && item.type === "question") : null;
        if (relatedTo && !root) return { missing: true };
        const entry = {
          id: createId(),
          createdAt: now(),
          ...eventTime,
          type,
          content,
          attachmentPaths: originalImages,
          tags,
          relatedTo,
          disposition: "kept",
          remarks: [],
          origin: "manual",
          authorType: "user",
          version: 1,
          ...(clientRequestId ? { clientRequestId, requestHash } : {})
        };
        store.thoughts.unshift(entry);
        if (root) touchRoot(root);
        return { value: entry };
      };
      if (!clientRequestId || typeof repository.executeIdempotent !== "function") {
        return repository.update(createInStore);
      }
      return repository.executeIdempotent({
        scope: `thoughtBlocks.create:${relatedTo || "root"}`,
        key: clientRequestId,
        requestHash
      }, createInStore);
    },

    updateBlock({ id, content, eventTimeInput, expectedVersion, attachmentPaths }) {
      return repository.update(store => {
        const item = store.thoughts.find(value => value.id === id);
        if (!item || item.type === "question") return { missing: true };
        if (expectedVersion != null && Number(expectedVersion) !== recordVersion(item.version)) {
          return { conflict: true, currentVersion: recordVersion(item.version) };
        }
        const originalImages = attachmentPaths !== undefined
          ? cleanAttachmentPaths(attachmentPaths)
          : cleanAttachmentPaths(item.attachmentPaths);
        if (!content && !originalImages.length) return { invalid: true, error: "请保留文字或至少一张图片" };
        const eventTime = eventTimeFields(eventTimeInput, item);
        if (!eventTime) return { invalidTime: true };
        const root = store.thoughts.find(value => value.id === item.relatedTo && value.type === "question");
        const updatedAt = now();
        let reconciled = null;
        if (attachmentPaths !== undefined && typeof reconcileOriginalImages === "function") {
          reconciled = reconcileOriginalImages(store, "thoughtBlock", id, originalImages, {
            changedAt: updatedAt,
            touchResource: false,
            allowEmptyImages: true
          });
          if (!reconciled.value) return reconciled;
        }
        if (root) reanchorAnnotations(root, `${item.type}:${item.id}`, item.content, content);
        item.content = content;
        item.attachmentPaths = originalImages;
        Object.assign(item, eventTime);
        item.updatedAt = updatedAt;
        item.version = recordVersion(item.version) + 1;
        if (item.type === "answer" && item.modelDraft) item.editedFromModel = item.modelDraft !== content;
        if (root) touchRoot(root);
        const result = { value: item, ...(reconciled?.trashId ? { trashId: reconciled.trashId } : {}) };
        if (reconciled?.[AFTER_COMMIT]) Object.defineProperty(result, AFTER_COMMIT, { value: reconciled[AFTER_COMMIT] });
        return result;
      });
    },

    async getBlock(id) {
      const store = await repository.read();
      return store.thoughts.find(item => item.id === id && item.type !== "question") || null;
    },

    setDisposition({ id, disposition }) {
      return repository.update(store => {
        const found = store.thoughts.find(value => value.id === id);
        if (!found) return { missing: true };
        const updatedAt = now();
        for (const item of store.thoughts.filter(value => value.id === id || value.relatedTo === id)) {
          item.disposition = disposition;
          item.dispositionAt = updatedAt;
          item.updatedAt = updatedAt;
          item.version = recordVersion(item.version) + 1;
        }
        return { value: found };
      });
    },

    addRemark({ id, text }) {
      return repository.update(store => {
        const item = store.thoughts.find(value => value.id === id);
        if (!item) return { missing: true };
        const occurredAt = now();
        const remark = { id: createId(), text, createdAt: occurredAt, occurredAt, version: 1 };
        item.remarks.push(remark);
        touchRoot(item);
        return { value: remark };
      });
    },

    updateRemark({ id, remarkId, text }) {
      return repository.update(store => {
        const item = store.thoughts.find(value => value.id === id);
        const remark = item?.remarks.find(value => value.id === remarkId);
        if (!remark) return { missing: true };
        remark.text = text;
        remark.updatedAt = now();
        remark.version = recordVersion(remark.version) + 1;
        touchRoot(item);
        return { value: remark };
      });
    },

    addFollowUp({ id, question, answer, clientRequestId = "" }) {
      return repository.update(store => {
        const root = store.thoughts.find(item => item.id === id && item.type === "question");
        if (!root) return { missing: true };
        root.followUps ||= [];
        if (clientRequestId) {
          const existing = root.followUps.find(item => item.clientRequestId === clientRequestId);
          if (existing) {
            return existing.question === question && (existing.answer || "") === answer
              ? { value: existing, duplicate: true }
              : { conflict: true };
          }
        }
        const followUp = {
          id: createId(),
          createdAt: now(),
          questionOccurredAt: now(),
          question,
          answer,
          ...(answer ? { answeredAt: now(), answerOccurredAt: now() } : {}),
          ...(clientRequestId ? { clientRequestId } : {}),
          origin: "manual",
          version: 1
        };
        root.followUps.push(followUp);
        touchRoot(root);
        return { value: followUp };
      });
    },

    updateFollowUp({ id, followUpId, hasQuestion, question, hasAnswer, answer, expectedVersion }) {
      return repository.update(store => {
        const root = store.thoughts.find(item => item.id === id && item.type === "question");
        const followUp = root?.followUps?.find(item => item.id === followUpId);
        if (!followUp) return { missing: true };
        if (expectedVersion != null && Number(expectedVersion) !== recordVersion(followUp.version)) return { conflict: true };
        if (hasQuestion) {
          reanchorAnnotations(root, `followup-question:${followUpId}`, followUp.question, question);
          followUp.question = question;
        }
        if (hasAnswer) {
          const originalAnswerAt = followUp.answerOccurredAt || followUp.answeredAt;
          reanchorAnnotations(root, `followup-answer:${followUpId}`, followUp.answer || "", answer);
          followUp.answer = answer;
          followUp.answeredAt = answer ? now() : null;
          if (answer) followUp.answerOccurredAt ||= originalAnswerAt || followUp.answeredAt;
          if (followUp.modelDraft) followUp.editedFromModel = followUp.modelDraft !== answer;
          followUp.origin = "manual";
        }
        followUp.updatedAt = now();
        followUp.version = recordVersion(followUp.version) + 1;
        touchRoot(root);
        return { value: followUp };
      });
    }
  };
}

export { createThoughtRecordCommands } from "../../../.build/typescript/backend/modules/thoughts/record-commands.mjs";
