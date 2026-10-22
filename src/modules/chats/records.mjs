import crypto from "node:crypto";
import { businessReasoning } from "../ai/index.mjs";
import { recordVersion, safeText } from "../../shared/validation/index.mjs";

const clone = value => structuredClone(value);
const IDEMPOTENCY_SCOPE = "chats.create";
const idempotencyConflict = () => Object.assign(new Error("同一幂等键不能用于不同内容"), {
  statusCode: 409,
  code: "IDEMPOTENCY_KEY_REUSED"
});
const markReplay = result => (
  result && typeof result === "object" ? { ...clone(result), duplicate: true } : result
);

function readData(value) {
  if (Array.isArray(value)) return { items: value, trash: [] };
  return {
    items: Array.isArray(value?.items)
      ? value.items
      : Array.isArray(value?.chats) ? value.chats : [],
    trash: Array.isArray(value?.trash) ? value.trash : []
  };
}

function priorRequest(data, clientRequestId) {
  return data.items.find(item => item.clientRequestId === clientRequestId)
    || data.trash.find(item => item.type === "chat" && item.payload?.clientRequestId === clientRequestId)?.payload
    || null;
}

function pageOf(items, { afterId = "", limit = 20 } = {}) {
  const start = afterId ? items.findIndex(item => item.id === afterId) + 1 : 0;
  if (afterId && start === 0) return { invalidCursor: true };
  const page = items.slice(start, start + limit);
  return {
    items: page,
    nextId: start + page.length < items.length ? page.at(-1)?.id || "" : ""
  };
}

const versioned = item => item ? { ...item, version: recordVersion(item.version) } : null;

export function chatMessage(input = {}) {
  const message = safeText(input.message);
  return message ? { value: message } : { error: "请先写下问题" };
}

export function chatHistory(items, limit = 12) {
  return [...(Array.isArray(items) ? items : [])]
    .slice(0, limit)
    .reverse()
    .flatMap(item => [
      { role: "user", content: item.message },
      { role: "assistant", content: item.answer }
    ]);
}

export function createChatRecords({
  repository,
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID()
}) {
  if (!repository || typeof repository.read !== "function" || typeof repository.update !== "function") {
    throw new TypeError("Chat records require a repository with read() and update()");
  }

  function saveInStore(document, input, { clientRequestId = "", requestHash = "" } = {}) {
    const parsed = chatMessage(input);
    if (parsed.error) return parsed;
    if ((!input.eventTime?.occurredAt && input.eventTime?.eventTimePrecision !== "date") || !input.eventTime?.occurredOn) {
      return { error: "发生时间格式不正确" };
    }
    const data = readData(document);
    if (clientRequestId) {
      const duplicate = priorRequest(data, clientRequestId);
      if (duplicate) {
        return duplicate.requestHash === requestHash
          ? { value: clone(versioned(duplicate)), duplicate: true }
          : { conflict: true };
      }
    }
    const chat = {
      id: createId(),
      createdAt: now(),
      ...input.eventTime,
      message: parsed.value,
      answer: String(input.answer ?? ""),
      ...(Array.isArray(input.citations) ? { citations: clone(input.citations) } : {}),
      ...(Array.isArray(input.providedReferences) ? { providedReferences: clone(input.providedReferences) } : {}),
      ...(Array.isArray(input.rejectedReferences) ? { rejectedReferences: clone(input.rejectedReferences) } : {}),
      ...(input.citationStatus ? { citationStatus: safeText(input.citationStatus, 20) } : {}),
      annotations: [],
      annotationDrift: [],
      ...businessReasoning("chat", input.reasoningContent, 12000),
      ...(input.contextReceipt ? { contextReceipt: structuredClone(input.contextReceipt) } : {}),
      ...(clientRequestId ? {
        version: 1,
        clientRequestId,
        requestHash
      } : {})
    };
    data.items.unshift(chat);
    return { value: clone(chat), duplicate: false };
  }

  return {
    async list(options, { includeVersion = false } = {}) {
      const page = pageOf(readData(await repository.read()).items, options);
      if (page.invalidCursor || !includeVersion) return clone(page);
      return { ...page, items: page.items.map(versioned) };
    },

    async get(id, { includeVersion = false } = {}) {
      const item = readData(await repository.read()).items.find(entry => entry.id === id) || null;
      return clone(includeVersion ? versioned(item) : item);
    },

    async findRequest(clientRequestId, requestHash) {
      if (!clientRequestId) return null;
      const item = priorRequest(readData(await repository.read()), clientRequestId);
      if (!item) return null;
      return item.requestHash === requestHash
        ? { value: clone(versioned(item)), duplicate: true }
        : { conflict: true };
    },

    async save(input, options = {}) {
      if (options.clientRequestId && typeof repository.executeIdempotent === "function") {
        let executed = false;
        try {
          const result = await repository.executeIdempotent({
            scope: IDEMPOTENCY_SCOPE,
            key: options.clientRequestId,
            requestHash: options.requestHash
          }, (document, trash = []) => {
            executed = true;
            const response = saveInStore(
              Array.isArray(document) ? { items: document, trash } : document,
              input,
              options
            );
            if (response?.conflict) throw idempotencyConflict();
            return response;
          });
          return executed ? result : markReplay(result);
        } catch (error) {
          if (error?.code === "IDEMPOTENCY_KEY_REUSED") return { conflict: true };
          throw error;
        }
      }
      return repository.update((document, trash = []) => (
        saveInStore(Array.isArray(document) ? { items: document, trash } : document, input, options)
      ));
    },

    saveInStore
  };
}
