import crypto from "node:crypto";
import {
  compactPersonalContextReceipt,
  diaryActivityContext,
  personalContextProjection,
  personalContextReceiptFingerprint,
  personalContextReceiptMatches
} from "./personal-context.mjs";
import { userPrompt } from "../modules/ai/index.mjs";
import { assertCoreModelReady } from "../shared/core-model-gate.mjs";
import {
  diaryAssistSystemPrompt,
  diarySystemPrompt,
  journalAssistPrompt,
  journalReflectionInput,
  markJournalAssistContent,
  JOURNAL_REFLECTION_IDEMPOTENCY_SCOPE
} from "../modules/journals/index.mjs";
import { eventTimeFields, localDateKey } from "../shared/time/index.mjs";
import { recordVersion, safeText } from "../shared/validation/index.mjs";

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
  backgroundAi,
  generate,
  hash,
  createId = () => crypto.randomUUID(),
  coreModelReadiness = () => ({ ready: true }),
  contextKey = () => "",
  today = () => localDateKey()
}) {
  const activeReflections = new Map();
  const intentHash = (kind, targetId, payload) => hash(JSON.stringify({
    kind,
    targetId: targetId || "",
    payload: payload || {}
  }));
  const reflectionIntent = (store, task) => {
    const journal = store.journals.find(item => item.id === task.targetId);
    if (!journal) return false;
    const sourceUpdatedAt = journal.updatedAt || journal.createdAt;
    return {
      inputVersion: recordVersion(journal.version),
      subtargetVersion: 0,
      inputHash: hash(JSON.stringify({
        kind: task.kind,
        targetId: journal.id,
        inputVersion: recordVersion(journal.version),
        sourceUpdatedAt
      }))
    };
  };
  const queueColdTask = async (kind, targetId, payload, clientRequestId) => {
    const store = await repository.read();
    if (coreModelReadiness(store)?.ready !== false) return null;
    return backgroundAi.enqueue({ kind, targetId, payload, clientRequestId });
  };
  const personalizedTaskHandler = {
    inspectIntent(store, task) {
      if (task.kind === "journalReflection") return reflectionIntent(store, task);
      if (task.kind !== "journalAssist") return false;
      return { inputVersion: 0, subtargetVersion: 0, inputHash: intentHash(task.kind, task.targetId, task.payload) };
    },
    prepare(store, task) {
      if (task.kind === "journalAssist") {
        const payload = task.payload;
        const personalContext = personalContextProjection(store);
        const activityContext = diaryActivityContext(store, payload.occurredOn);
        return {
          kind: task.kind,
          inputVersion: 0,
          subtargetVersion: 0,
          inputHash: intentHash(task.kind, task.targetId, task.payload),
          prompt: journalAssistPrompt(activityContext, {
            mode: payload.mode,
            title: payload.title,
            content: payload.content
          }),
          contextFingerprint: hash(JSON.stringify({
            receipt: personalContextReceiptFingerprint(personalContext.receipt),
            prompt: personalContext.prompt,
            activityContext
          })),
          scene: ASSIST_SCENES[payload.mode],
          systemPrompt: diaryAssistSystemPrompt(),
          maxTokens: 2_000,
          taskOutput: {
            mode: payload.mode,
            binding: payload.binding || {}
          }
        };
      }
      if (task.kind === "journalReflection") {
        const journal = store.journals.find(item => item.id === task.targetId);
        if (!journal) return null;
        const sourceUpdatedAt = journal.updatedAt || journal.createdAt;
        const personalContext = personalContextProjection(store);
        return {
          kind: task.kind,
          inputVersion: recordVersion(journal.version),
          subtargetVersion: 0,
          inputHash: reflectionIntent(store, task).inputHash,
          prompt: userPrompt({
            context: personalContext.prompt,
            ...journalReflectionInput(journal)
          }),
          scene: "diaryReflection",
          systemPrompt: diarySystemPrompt(),
          contextReceipt: personalContext.receipt,
          contextFingerprint: personalContextReceiptFingerprint(personalContext.receipt),
          sourceUpdatedAt
        };
      }
      return null;
    },
    save(store, work, task, result) {
      if (task.kind === "journalAssist") {
        task.output = {
          mode: work.taskOutput.mode,
          content: markJournalAssistContent(work.taskOutput.mode, result.content),
          ...(work.taskOutput.binding || {})
        };
        return task.id;
      }
      const saved = journals.addReflectionInStore(store, task.targetId, {
        sourceUpdatedAt: work.sourceUpdatedAt,
        content: result.content,
        reasoningContent: result.reasoningContent,
        contextReceipt: compactPersonalContextReceipt(work.contextReceipt)
      }, {
        clientRequestId: task.clientRequestId,
        requestHash: hash(JSON.stringify({ id: task.targetId }))
      });
      if (saved.conflict) {
        throw failure("同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED", 409);
      }
      if (saved.missing) {
        throw Object.assign(new Error("这篇日记已被删除，回望结果未写入"), {
          code: "AI_TASK_STALE",
          statusCode: 409
        });
      }
      return saved.value.id;
    },
    result(store, task) {
      if (task.kind === "journalAssist") return task.output || null;
      for (const journal of store.journals || []) {
        const reflection = (journal.reflections || []).find(item => item.id === task.resultId);
        if (reflection) return reflection;
      }
      return null;
    }
  };

  return {
    personalizedTaskHandler,
    async queueAssistIfCold(input, { binding = {}, clientRequestId = "" } = {}) {
      const mode = ASSIST_SCENES[input.mode] ? input.mode : "";
      if (!mode) throw failure("日记辅助类型无效", "INVALID_JOURNAL_ASSIST_MODE");
      const eventTime = eventTimeFields(input);
      const occurredOn = eventTime?.occurredOn
        || (/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn || "") ? input.occurredOn : today());
      const requestId = clientRequestId || binding.requestId || createId();
      return queueColdTask("journalAssist", binding.targetId || requestId, {
        mode,
        occurredOn,
        title: safeText(input.title, 120),
        content: safeText(input.content, 50_000),
        binding: {
          requestId,
          targetId: binding.targetId || "",
          inputVersion: Math.max(0, Number(binding.inputVersion) || 0)
        }
      }, requestId);
    },
    async queueReflectionIfCold({ id, clientRequestId = "" }) {
      const journal = await journals.get(id);
      if (!journal) throw failure("这篇日记不存在", "JOURNAL_NOT_FOUND", 404);
      const requestId = clientRequestId || createId();
      return queueColdTask("journalReflection", id, {}, requestId);
    },
    async assist(input, { binding = {}, onDelta } = {}) {
      const mode = ASSIST_SCENES[input.mode] ? input.mode : "";
      if (!mode) throw failure("日记辅助类型无效", "INVALID_JOURNAL_ASSIST_MODE");
      const eventTime = eventTimeFields(input);
      const occurredOn = eventTime?.occurredOn
        || (/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn || "") ? input.occurredOn : today());
      const store = await repository.read();
      assertCoreModelReady(coreModelReadiness(store));
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
        assertCoreModelReady(coreModelReadiness(store));
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
