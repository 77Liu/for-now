import { chatHistory, chatMessage } from "../modules/chats/index.mjs";
import { reflectionEvidence, reflectionPrompt } from "../modules/reviews/index.mjs";
import { userPrompt } from "../modules/ai/index.mjs";
import {
  compactPersonalContextReceipt,
  personalContextProjection,
  personalContextReceiptMatches
} from "./personal-context.mjs";

const idempotencyConflict = () => Object.assign(new Error("同一幂等键不能用于不同内容"), {
  statusCode: 409,
  code: "IDEMPOTENCY_KEY_REUSED"
});

export function createReviewChatWorkflows({
  repository,
  chats,
  reviews,
  generate,
  hash,
  contextKey = () => "local",
  currentTime = () => Date.now()
}) {
  if (!repository || typeof repository.read !== "function") {
    throw new TypeError("Review/chat workflows require a repository with read()");
  }
  for (const [name, dependency] of Object.entries({ generate, hash, contextKey, currentTime })) {
    if (typeof dependency !== "function") throw new TypeError(`Review/chat workflows require ${name}()`);
  }

  const active = new Map();

  async function readPersistent(request) {
    try {
      const response = await repository.readIdempotent(request);
      return response === undefined ? null : { ...structuredClone(response), duplicate: true };
    } catch (error) {
      if (error?.code === "IDEMPOTENCY_KEY_REUSED") return { conflict: true };
      throw error;
    }
  }

  async function persistGenerated(request, operation) {
    let executed = false;
    try {
      const response = await repository.executeIdempotent(request, document => {
        executed = true;
        const result = operation(document);
        if (result?.conflict) throw idempotencyConflict();
        return result;
      });
      return executed ? response : { ...structuredClone(response), duplicate: true };
    } catch (error) {
      if (error?.code === "IDEMPOTENCY_KEY_REUSED") return { conflict: true };
      throw error;
    }
  }

  async function generatedIdempotent({
    kind,
    clientRequestId,
    requestHash,
    findExisting,
    generateValue,
    save,
    saveInStore
  }) {
    if (!clientRequestId) return save(await generateValue());
    const request = {
      scope: kind === "analysis" ? "analyses.create" : "chats.create",
      key: clientRequestId,
      requestHash
    };
    const key = `${contextKey()}:${kind}:${clientRequestId}`;
    let entry = active.get(key);
    if (entry && entry.requestHash !== requestHash) return { conflict: true };
    if (!entry) {
      entry = { requestHash };
      entry.promise = Promise.resolve().then(async () => {
        if (typeof repository.readIdempotent === "function") {
          const replay = await readPersistent(request);
          if (replay) return replay;
        }
        const existing = await findExisting();
        if (existing) return existing;
        const generated = await generateValue();
        if (typeof repository.executeIdempotent === "function" && saveInStore) {
          return persistGenerated(request, document => saveInStore(document, generated));
        }
        return save(generated);
      });
      active.set(key, entry);
      entry.promise.finally(() => {
        if (active.get(key) === entry) active.delete(key);
      }).catch(() => {});
    }
    return entry.promise;
  }

  async function answerChat({
    message: rawMessage,
    eventTime,
    eventTimeHash = "",
    clientRequestId = ""
  }) {
    const parsed = chatMessage({ message: rawMessage });
    if (parsed.error) return parsed;
    if (!eventTime?.occurredAt || !eventTime?.occurredOn) return { error: "发生时间格式不正确" };
    const message = parsed.value;
    const requestHash = clientRequestId
      ? hash(JSON.stringify({ message, occurredAt: eventTimeHash }))
      : "";
    return generatedIdempotent({
      kind: "chat",
      clientRequestId,
      requestHash,
      findExisting: () => chats.findRequest(clientRequestId, requestHash),
      generateValue: async () => {
        const store = await repository.read();
        const personalContext = personalContextProjection(store);
        const result = await generate(userPrompt({
          context: personalContext.prompt,
          task: message
        }), {
          scene: "chat",
          history: chatHistory(store.chats),
          captureReasoning: true,
          contextReceipt: personalContext.receipt
        });
        return {
          message,
          eventTime,
          answer: result.content,
          reasoningContent: result.reasoningContent,
          contextReceipt: personalContext.receipt
        };
      },
      save: async generated => {
        if (!personalContextReceiptMatches(await repository.read(), generated.contextReceipt)) {
          throw Object.assign(new Error("个人语境已变化，本次应答未写入"), { code: "STALE_PERSONAL_CONTEXT", statusCode: 409 });
        }
        return chats.save({
          ...generated,
          contextReceipt: compactPersonalContextReceipt(generated.contextReceipt)
        }, { clientRequestId, requestHash });
      },
      saveInStore: typeof chats.saveInStore === "function"
        ? (document, generated) => {
            if (!personalContextReceiptMatches(document, generated.contextReceipt)) {
              throw Object.assign(new Error("个人语境已变化，本次应答未写入"), { code: "STALE_PERSONAL_CONTEXT", statusCode: 409 });
            }
            return chats.saveInStore(document, {
              ...generated,
              contextReceipt: compactPersonalContextReceipt(generated.contextReceipt)
            }, { clientRequestId, requestHash });
          }
        : null
    });
  }

  async function runAnalysis({
    reason = "manual",
    clientRequestId = ""
  } = {}) {
    const requestHash = clientRequestId ? hash(JSON.stringify({ reason })) : "";
    return generatedIdempotent({
      kind: "analysis",
      clientRequestId,
      requestHash,
      findExisting: () => reviews.findAnalysisRequest(clientRequestId, requestHash),
      generateValue: async () => {
        const store = await repository.read();
        const personalContext = personalContextProjection(store);
        const evidence = reflectionEvidence({
          thoughts: store.thoughts,
          checkins: store.checkins,
          dailyRecords: store.dailyRecords,
          captures: store.captures,
          journals: store.journals
        });
        if (!evidence.evidenceCount) {
          throw new Error("先留下一条状态、健康、捕念、日记或思绪记录，再开始认知复盘");
        }
        const result = await generate(reflectionPrompt({
          personalContext: personalContext.prompt,
          reflectionData: evidence.reflectionData,
          evidenceLevel: evidence.evidenceLevel
        }), {
          scene: "analysis",
          captureReasoning: true,
          contextReceipt: personalContext.receipt
        });
        return {
          reason,
          content: result.content,
          reasoningContent: result.reasoningContent,
          contextReceipt: personalContext.receipt
        };
      },
      save: async generated => {
        if (!personalContextReceiptMatches(await repository.read(), generated.contextReceipt)) {
          throw Object.assign(new Error("个人语境已变化，本次复盘未写入"), { code: "STALE_PERSONAL_CONTEXT", statusCode: 409 });
        }
        return reviews.saveAnalysis({
          ...generated,
          contextReceipt: compactPersonalContextReceipt(generated.contextReceipt)
        }, { clientRequestId, requestHash });
      },
      saveInStore: typeof reviews.saveAnalysisInStore === "function"
        ? (document, generated) => {
            if (!personalContextReceiptMatches(document, generated.contextReceipt)) {
              throw Object.assign(new Error("个人语境已变化，本次复盘未写入"), { code: "STALE_PERSONAL_CONTEXT", statusCode: 409 });
            }
            return reviews.saveAnalysisInStore(document, {
              ...generated,
              contextReceipt: compactPersonalContextReceipt(generated.contextReceipt)
            }, { clientRequestId, requestHash });
          }
        : null
    });
  }

  async function maybeRunPeriodicAnalysis() {
    const store = await repository.read();
    if (store.thoughts.filter(item => item.type === "question").length < 5) return null;
    const last = store.analyses[0]?.createdAt
      ? new Date(store.analyses[0].createdAt).getTime()
      : 0;
    if (currentTime() - last < 7 * 86400000) return null;
    return (await runAnalysis({ reason: "weekly-background" })).value;
  }

  return { answerChat, runAnalysis, maybeRunPeriodicAnalysis };
}
