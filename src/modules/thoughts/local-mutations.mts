/**
 * 内容块、备注、追问及处置状态的思绪领域规则。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：仅修改调用方提供的思绪闭包；不读取仓库、不调用模型。
 */
import { AFTER_COMMIT } from "../../shared/persistence/record-command-types.mjs";
import type { RecordEntity, RecordStore } from "../../shared/persistence/record-command-types.mjs";

export type LocalThoughtInput = {
  id?: string;
  relatedTo?: string | null;
  content?: string;
  type?: string;
  tags?: string[];
  attachmentPaths?: string[];
  clientRequestId?: string;
  requestHash?: string;
  eventTime?: Record<string, unknown>;
  eventTimeInput?: Record<string, unknown>;
  expectedVersion?: number;
  disposition?: string;
  remarkId?: string;
  text?: string;
  followUpId?: string;
  question?: string;
  answer?: string;
  hasQuestion?: boolean;
  hasAnswer?: boolean;
};
type NestedThought = RecordEntity & {
  remarks?: RecordEntity[];
  followUps?: RecordEntity[];
};
export type LocalThoughtResult = {
  value?: RecordEntity;
  missing?: boolean;
  conflict?: boolean;
  currentVersion?: number;
  duplicate?: boolean;
  invalid?: boolean;
  invalidTime?: boolean;
  error?: string;
  trashId?: string;
  [AFTER_COMMIT]?: () => void;
};
type Dependencies = {
  createId(): string;
  now(): string;
  recordVersion(value: unknown): number;
  cleanAttachmentPaths(value: unknown): string[];
  eventTimeFields(input: unknown, previous: RecordEntity): Record<string, unknown> | null;
  reanchorAnnotations(root: RecordEntity, key: string, previous: unknown, next: unknown): void;
  reconcileOriginalImages?: ((store: RecordStore, type: string, id: string, paths: string[], options: {
    changedAt: string; touchResource: boolean; allowEmptyImages: boolean;
  }) => LocalThoughtResult) | null;
};

/** 创建供记录事务与文档适配器共用的纯修改规则。 @since unreleased */
export function createLocalThoughtMutations(dependencies: Dependencies) {
  const {
    createId, now, recordVersion, cleanAttachmentPaths,
    eventTimeFields, reanchorAnnotations, reconcileOriginalImages
  } = dependencies;
  const find = (store: RecordStore, id: string | undefined) => (
    store.thoughts.find(item => item.id === id) as NestedThought | undefined
  );
  const rootOf = (store: RecordStore, id: string | undefined) => {
    const root = find(store, id);
    return root?.type === "question" ? root : undefined;
  };
  const touch = (item: RecordEntity) => {
    item.version = recordVersion(item.version) + 1;
    item.updatedAt = now();
  };

  const createBlock = (store: RecordStore, input: LocalThoughtInput): LocalThoughtResult => {
    const paths = cleanAttachmentPaths(input.attachmentPaths);
    if (!input.content && !paths.length) {
      return { invalid: true, error: "请填写文字或插入图片" };
    }
    const root = input.relatedTo ? rootOf(store, input.relatedTo) : null;
    if (input.relatedTo && !root) return { missing: true };
    const entry: RecordEntity = {
      id: createId(),
      createdAt: now(),
      ...input.eventTime,
      type: input.type,
      content: input.content,
      attachmentPaths: paths,
      tags: input.tags,
      relatedTo: input.relatedTo,
      disposition: "kept",
      remarks: [],
      origin: "manual",
      authorType: "user",
      version: 1,
      ...(input.clientRequestId ? {
        clientRequestId: input.clientRequestId,
        requestHash: input.requestHash
      } : {})
    };
    store.thoughts.unshift(entry);
    if (root) touch(root);
    return { value: entry };
  };

  const updateBlock = (store: RecordStore, input: LocalThoughtInput): LocalThoughtResult => {
    const item = find(store, input.id);
    if (!item || item.type === "question") return { missing: true };
    if (input.expectedVersion != null && Number(input.expectedVersion) !== recordVersion(item.version)) {
      return { conflict: true, currentVersion: recordVersion(item.version) };
    }
    const paths = cleanAttachmentPaths(input.attachmentPaths === undefined
      ? item.attachmentPaths
      : input.attachmentPaths);
    if (!input.content && !paths.length) {
      return { invalid: true, error: "请保留文字或至少一张图片" };
    }
    const eventTime = eventTimeFields(input.eventTimeInput, item);
    if (!eventTime) return { invalidTime: true };
    const root = rootOf(store, item.relatedTo || undefined);
    const updatedAt = now();
    const reconciled = input.attachmentPaths !== undefined && reconcileOriginalImages
      ? reconcileOriginalImages(store, "thoughtBlock", item.id, paths, {
          changedAt: updatedAt,
          touchResource: false,
          allowEmptyImages: true
        })
      : null;
    if (reconciled && !reconciled.value) return reconciled;
    if (root) reanchorAnnotations(root, `${item.type}:${item.id}`, item.content, input.content);
    item.content = input.content;
    item.attachmentPaths = paths;
    Object.assign(item, eventTime);
    item.updatedAt = updatedAt;
    item.version = recordVersion(item.version) + 1;
    if (item.type === "answer" && item.modelDraft) item.editedFromModel = item.modelDraft !== input.content;
    if (root) touch(root);
    const result: LocalThoughtResult = {
      value: item,
      ...(reconciled?.trashId ? { trashId: reconciled.trashId } : {})
    };
    if (reconciled?.[AFTER_COMMIT]) {
      Object.defineProperty(result, AFTER_COMMIT, { value: reconciled[AFTER_COMMIT] });
    }
    return result;
  };

  const setDisposition = (store: RecordStore, input: LocalThoughtInput): LocalThoughtResult => {
    const found = find(store, input.id);
    if (!found) return { missing: true };
    const updatedAt = now();
    for (const item of store.thoughts.filter(value => value.id === input.id || value.relatedTo === input.id)) {
      item.disposition = input.disposition;
      item.dispositionAt = updatedAt;
      item.updatedAt = updatedAt;
      item.version = recordVersion(item.version) + 1;
    }
    return { value: found };
  };

  const addRemark = (store: RecordStore, input: LocalThoughtInput): LocalThoughtResult => {
    const item = find(store, input.id);
    if (!item) return { missing: true };
    const occurredAt = now();
    const remark = { id: createId(), text: input.text, createdAt: occurredAt, occurredAt, version: 1 };
    (item.remarks ||= []).push(remark);
    touch(item);
    return { value: remark };
  };

  const updateRemark = (store: RecordStore, input: LocalThoughtInput): LocalThoughtResult => {
    const item = find(store, input.id);
    const remark = item?.remarks?.find(value => value.id === input.remarkId);
    if (!item || !remark) return { missing: true };
    remark.text = input.text;
    remark.updatedAt = now();
    remark.version = recordVersion(remark.version) + 1;
    touch(item);
    return { value: remark };
  };

  const addFollowUp = (store: RecordStore, input: LocalThoughtInput): LocalThoughtResult => {
    const root = rootOf(store, input.id);
    if (!root) return { missing: true };
    const followUps = root.followUps ||= [];
    const existing = input.clientRequestId
      ? followUps.find(item => item.clientRequestId === input.clientRequestId)
      : null;
    if (existing) {
      return existing.question === input.question && (existing.answer || "") === input.answer
        ? { value: existing, duplicate: true }
        : { conflict: true };
    }
    const followUp: RecordEntity = {
      id: createId(),
      createdAt: now(),
      questionOccurredAt: now(),
      question: input.question,
      answer: input.answer,
      ...(input.answer ? { answeredAt: now(), answerOccurredAt: now() } : {}),
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      origin: "manual",
      version: 1
    };
    followUps.push(followUp);
    touch(root);
    return { value: followUp };
  };

  const updateFollowUp = (store: RecordStore, input: LocalThoughtInput): LocalThoughtResult => {
    const root = rootOf(store, input.id);
    const followUp = root?.followUps?.find(item => item.id === input.followUpId);
    if (!root || !followUp) return { missing: true };
    if (input.expectedVersion != null && Number(input.expectedVersion) !== recordVersion(followUp.version)) {
      return { conflict: true };
    }
    if (input.hasQuestion) {
      reanchorAnnotations(root, `followup-question:${input.followUpId}`, followUp.question, input.question);
      followUp.question = input.question;
    }
    if (input.hasAnswer) {
      const originalAnswerAt = followUp.answerOccurredAt || followUp.answeredAt;
      reanchorAnnotations(root, `followup-answer:${input.followUpId}`, followUp.answer || "", input.answer);
      followUp.answer = input.answer;
      followUp.answeredAt = input.answer ? now() : null;
      if (input.answer) followUp.answerOccurredAt ||= originalAnswerAt || followUp.answeredAt;
      if (followUp.modelDraft) followUp.editedFromModel = followUp.modelDraft !== input.answer;
      followUp.origin = "manual";
    }
    followUp.updatedAt = now();
    followUp.version = recordVersion(followUp.version) + 1;
    touch(root);
    return { value: followUp };
  };
  return { createBlock, updateBlock, setDisposition, addRemark, updateRemark, addFollowUp, updateFollowUp };
}
export type LocalThoughtMutations = ReturnType<typeof createLocalThoughtMutations>;
