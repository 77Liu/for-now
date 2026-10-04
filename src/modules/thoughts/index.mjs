import crypto from "node:crypto";
import { cleanAttachmentPaths } from "../../shared/attachments/index.mjs";
import {
  recordVersion as normalizedVersion,
  safeText
} from "../../shared/validation/index.mjs";
export { thoughtTask, thoughtPromptSystem, stripThoughtAnswerLead, thoughtPersonalContext, thoughtChainContext, thoughtDraftInput, thoughtStarterPrompt } from "./prompts.mjs";

const AFTER_COMMIT = Symbol.for("for-now.after-commit");
const requestDigest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isAiAnswer = item => (
  item?.authorType === "ai"
  || /^(?:deepseek|codex|openai|model|ai)(?:$|[-_:])/i.test(String(item?.origin || ""))
  || Boolean(item?.modelDraft)
  || Boolean(item?.reasoningContent)
);
const compareThoughtOccurrence = (left, right) => (
  String(left?.occurredAt || left?.createdAt || "").localeCompare(
    String(right?.occurredAt || right?.createdAt || "")
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
        const root = work.root, generation = thoughts.filter(item => item.relatedTo === root.id && item.type === "answer").length + 1, content = stripThoughtAnswerLead(result.content);
        answer = { id: createId(), createdAt: now(), occurredAt: root.occurredAt, occurredOn: root.occurredOn, type: "answer", content, modelDraft: content, editedFromModel: false, tags: root.tags, relatedTo: root.id, disposition: root.disposition || "kept", remarks: [], origin: "deepseek", authorType: "ai", version: 1, sourceVersion: task.inputVersion, generation, sourceTaskId: task.id, ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}), ...(result.contextReceipt ? { contextReceipt: structuredClone(result.contextReceipt) } : {}) };
        thoughts.unshift(answer);
      }
      return answer.id;
    },
    saveFollowUp(work, task, result) {
      const root = work.root, current = work.followUp;
      current.answer = result.content; current.modelDraft = result.content; current.answeredAt = now(); current.origin = "deepseek"; current.authorType = "ai"; current.version = normalizedVersion(current.version) + 1; current.clientRequestId = task.clientRequestId; current.sourceTaskId = task.id;
      if (result.reasoningContent) current.reasoningContent = result.reasoningContent;
      if (result.contextReceipt) current.contextReceipt = structuredClone(result.contextReceipt);
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
  reconcileOriginalImages = null
}) {
  const touchRoot = root => {
    root.version = recordVersion(root.version) + 1;
    root.updatedAt = now();
  };
  const chainValue = (thoughts, root) => root ? {
    ...root,
    blocks: thoughts.filter(item => item.relatedTo === root.id)
  } : null;

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
      const result = { value: question, ...(reconciled?.trashId ? { trashId: reconciled.trashId } : {}) };
      if (reconciled?.[AFTER_COMMIT]) Object.defineProperty(result, AFTER_COMMIT, { value: reconciled[AFTER_COMMIT] });
      return result;
    },

    saveGeneratedAnswerInStore(store, {
      id, clientRequestId, sourceVersion, content, reasoningContent, contextReceipt = null
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
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(contextReceipt ? { contextReceipt: structuredClone(contextReceipt) } : {})
      };
      store.thoughts.unshift(answer);
      return { value: answer, duplicate: false };
    },

    async getChain(id) {
      const store = await repository.read();
      return chainValue(store.thoughts, store.thoughts.find(item => item.id === id && item.type === "question"));
    },

    async getTaskResult(task) {
      return thoughtTaskResult((await repository.read()).thoughts, task);
    },

    async listChains({ limit, afterId = "" }) {
      const store = await repository.read();
      const roots = store.thoughts.filter(item => item.type === "question");
      const after = afterId ? roots.findIndex(item => item.id === afterId) : -1;
      if (afterId && after < 0) return { invalidCursor: true };
      const start = after + 1;
      const selected = roots.slice(start, start + limit);
      const hasMore = start + selected.length < roots.length;
      return {
        items: selected.map(root => chainValue(store.thoughts, root)),
        nextId: hasMore ? selected.at(-1)?.id || "" : ""
      };
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
      const remark = { id: createId(), text, createdAt: now(), version: 1 };
      return repository.update(store => {
        const item = store.thoughts.find(value => value.id === id);
        if (!item) return { missing: true };
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
          question,
          answer,
          ...(answer ? { answeredAt: now() } : {}),
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
          reanchorAnnotations(root, `followup-answer:${followUpId}`, followUp.answer || "", answer);
          followUp.answer = answer;
          followUp.answeredAt = answer ? now() : null;
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
