import {
  compactPersonalContextReceipt,
  diaryActivityContext,
  personalContextProjection,
  personalContextReceiptMatches
} from "./personal-context.mjs";
import { userPrompt } from "../modules/ai/index.mjs";
import {
  diaryAssistSystemPrompt,
  diarySystemPrompt,
  journalAssistPrompt,
  journalReflectionInput,
  markJournalAssistContent,
  JOURNAL_REFLECTION_IDEMPOTENCY_SCOPE
} from "../modules/journals/index.mjs";
import { eventTimeFields, localDateKey } from "../shared/time/index.mjs";
import { safeText } from "../shared/validation/index.mjs";

const ASSIST_SCENES = {
  lead: "diaryLead",
  structure: "diaryStructure",
  topic: "diaryTopic"
};
const failure = (message, code, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const replayResult = replay => {
  const value = replay && typeof replay === "object" && hasOwn(replay, "value")
    ? replay.value
    : replay;
  return value && typeof value === "object" ? { ...value, duplicate: true } : value;
};

export function createCaptureJournalWorkflows({
  repository,
  journals,
  generate,
  hash,
  contextKey = () => "",
  today = () => localDateKey()
}) {
  const activeReflections = new Map();

  return {
    async assist(input, { binding = {}, onDelta } = {}) {
      const mode = ASSIST_SCENES[input.mode] ? input.mode : "";
      if (!mode) throw failure("日记辅助类型无效", "INVALID_JOURNAL_ASSIST_MODE");
      const eventTime = eventTimeFields(input);
      const occurredOn = eventTime?.occurredOn
        || (/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn || "") ? input.occurredOn : today());
      const store = await repository.read();
      const result = await generate(
        journalAssistPrompt(diaryActivityContext(store, occurredOn), {
          mode,
          title: safeText(input.title, 120),
          content: safeText(input.content, 50000)
        }),
        {
          scene: ASSIST_SCENES[mode],
          systemPrompt: diaryAssistSystemPrompt(),
          maxTokens: 2000,
          retryWithoutThinking: true,
          captureReasoning: true,
          onDelta
        }
      );
      return {
        mode,
        content: markJournalAssistContent(mode, result.content),
        ...binding
      };
    },

    async reflect({ id, clientRequestId = "", onDelta }) {
      const requestHash = clientRequestId ? hash(JSON.stringify({ id })) : "";
      const idempotencyRequest = clientRequestId ? {
        scope: JOURNAL_REFLECTION_IDEMPOTENCY_SCOPE,
        key: clientRequestId,
        requestHash
      } : null;
      const execute = async notify => {
        if (idempotencyRequest && typeof repository.readIdempotent === "function") {
          try {
            const persisted = await repository.readIdempotent(idempotencyRequest);
            if (persisted !== undefined) return replayResult(persisted);
          } catch (error) {
            if (error?.code === "IDEMPOTENCY_KEY_REUSED") {
              throw failure("同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED", 409);
            }
            throw error;
          }
        }
        const replay = await journals.findReflectionRequest(id, clientRequestId, requestHash);
        if (replay?.conflict) {
          throw failure("同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED", 409);
        }
        if (replay?.value) return replayResult(replay);
        const store = await repository.read();
        const journal = store.journals.find(item => item.id === id);
        if (!journal) throw failure("这篇日记不存在", "JOURNAL_NOT_FOUND", 404);
        const sourceUpdatedAt = journal.updatedAt || journal.createdAt;
        const personalContext = personalContextProjection(store);
        const result = await generate(userPrompt({
          context: personalContext.prompt,
          ...journalReflectionInput(journal)
        }), {
          scene: "diaryReflection",
          systemPrompt: diarySystemPrompt(),
          captureReasoning: true,
          contextReceipt: personalContext.receipt,
          onDelta: notify
        });
        if (!personalContextReceiptMatches(await repository.read(), personalContext.receipt)) {
          throw failure("个人语境已变化，本次回望未写入", "STALE_PERSONAL_CONTEXT", 409);
        }
        const saved = await journals.addReflection(id, {
          sourceUpdatedAt,
          content: result.content,
          reasoningContent: result.reasoningContent,
          contextReceipt: compactPersonalContextReceipt(personalContext.receipt)
        }, { clientRequestId, requestHash });
        if (saved.conflict) {
          throw failure("同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED", 409);
        }
        if (saved.missing) throw new Error("这篇日记已被删除");
        return saved.duplicate ? replayResult(saved) : saved.value;
      };

      if (!clientRequestId) return execute(onDelta);
      const key = `${contextKey()}:journalReflection:${clientRequestId}`;
      let entry = activeReflections.get(key);
      if (entry && entry.requestHash !== requestHash) {
        throw failure("同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED", 409);
      }
      if (!entry) {
        entry = { requestHash, listeners: new Set() };
        entry.promise = Promise.resolve().then(() => execute(event => {
          for (const listener of entry.listeners) listener(event);
        }));
        activeReflections.set(key, entry);
        entry.promise.finally(() => {
          if (activeReflections.get(key) === entry) activeReflections.delete(key);
        }).catch(() => {});
      }
      if (onDelta) entry.listeners.add(onDelta);
      try {
        return await entry.promise;
      } finally {
        if (onDelta) entry.listeners.delete(onDelta);
      }
    }
  };
}
