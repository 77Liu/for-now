import { supplementalImportanceContext, supplementalImportanceReceiptMatches } from "./task-context.mjs";
import crypto from "node:crypto";
import {
  compactPersonalContextReceipt,
  diaryActivityContext,
  personalContextProjection,
  personalContextReceiptFingerprint,
  personalContextReceiptMatches
} from "./personal-context.mjs";
import { coreUserModelProjection } from "./user-model.mjs";
import { userPrompt } from "../modules/ai/index.mjs";
import { promptText } from "../shared/prompts/index.mjs";
import { assertCoreModelReady } from "../shared/core-model-gate.mjs";
import { evidenceSourceKey } from "../modules/user-model/index.mjs";
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
import { answerCitationSources, prepareReferenceRequest, verifyReferenceAnswer } from "./answer-citations.mjs";

const ASSIST_SCENES = {
  lead: "diaryLead",
  structure: "diaryStructure",
  topic: "diaryTopic"
};
const list = value => Array.isArray(value) ? value : [];
const trendCitationSources = trend => [
  ...list(trend?.historicalUserSupplementCitationSources),
  ...list(trend?.citationSources)
];
const citationSystemPrompt = base => [
  base,
  promptText("orchestration.answer.citations")
].filter(Boolean).join("\n\n");
const replayVerifiedAnswerDeltas = (notify, deltas, content) => {
  if (typeof notify !== "function") return;
  const contentCount = deltas.filter(event => event.type === "content").length;
  const chunkCount = Math.min(content.length, Math.max(1, contentCount));
  const chunkSize = Math.ceil(content.length / chunkCount);
  const chunks = [];
  for (let start = 0; start < content.length; start += chunkSize) {
    chunks.push(content.slice(start, start + chunkSize));
  }
  let nextContent = 0;
  for (const event of deltas) {
    if (event.type === "reasoning") {
      notify(event);
    } else if (event.type === "content") {
      const delta = chunks[nextContent++];
      if (delta) notify({ type: "content", delta });
    }
  }
  while (nextContent < chunks.length) {
    notify({ type: "content", delta: chunks[nextContent++] });
  }
};
const journalCitationSource = journal => ({
  citationId: `current-journal:${String(journal.id || "")}:${recordVersion(journal.version)}`,
  text: String(journal.content || ""),
  source: {
    resourceType: "journal",
    resourceId: String(journal.id || ""),
    recordType: "当前日记",
    version: recordVersion(journal.version),
    location: {
      view: "journal-reflection",
      targetId: String(journal.id || ""),
      rootId: String(journal.id || ""),
      targetKey: "content",
      occurredOn: String(journal.occurredOn || "")
    }
  }
});
const failure = (message, code, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const staleCoreModel = () => failure("核心用户模型或来源权限已变化，本次结果未写入", "AI_TASK_STALE", 409);
const staleJournalContext = () => failure("日记来源或趋势已变化，本次结果未写入", "AI_TASK_STALE", 409);
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
  getRecentTrend = () => null,
  getImportanceModelSnapshot = () => null,
  getAccountId = () => "local",
  currentTime = () => Date.now(),
  contextKey = () => "",
  today = () => localDateKey()
}) {
  const activeReflections = new Map();
  const reflectionContextReceiptMatches = (store, receipt) => personalContextReceiptMatches(store, receipt)
    && supplementalImportanceReceiptMatches(store, receipt?.importanceReferences, getAccountId());
  const addImportance = (store, context, journal, seed, frozenPlan = null) => {
    const supplemental = supplementalImportanceContext(store, {
      accountId: getAccountId(), text: journal.content || "日记回望", seed,
      choice: getImportanceModelSnapshot(), frozenPlan,
      excludeSourceRefs: [{ resourceType: "journal", resourceId: journal.id, rootId: "",
        targetKey: "", version: recordVersion(journal.version) }]
    });
    if (!supplemental) return false;
    context.prompt = [context.prompt, supplemental.prompt].filter(Boolean).join("\n\n");
    context.receipt = { ...context.receipt, importanceReferences: supplemental.receipt };
    context.importanceSources = supplemental.sources;
    return true;
  };
  const coreModelSnapshot = store => {
    if (!coreModelReadiness(store)?.ready) return null;
    const projected = coreUserModelProjection(store);
    // Legacy workflow tests inject a ready gate without a v2 onboarding fixture.
    // The production wiring uses userModelCoreReadiness, for which a ready model is always projected.
    const model = projected || {
      schemaVersion: 1,
      claims: [],
      answers: [],
      unknowns: [],
      fingerprint: hash("core-user-model-empty-compatibility.v1")
    };
    const sourceKeys = list(model.answers).map(answer => evidenceSourceKey({
      resourceType: "onboardingV2",
      resourceId: answer.sourceId,
      rootId: "",
      targetKey: `answer:${answer.sourceId}`,
      version: answer.sourceVersion
    })).filter(Boolean);
    const permissionVector = list(store?.evidencePermissions)
      .filter(permission => sourceKeys.includes(permission?.sourceKey))
      .map(permission => [
        String(permission.sourceKey || ""),
        String(permission.accountId || ""),
        permission.contextAllowed === true,
        Math.max(0, Math.round(Number(permission.revision) || 0))
      ])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const permissionFingerprint = hash(JSON.stringify(permissionVector));
    return {
      model,
      modelFingerprint: model.fingerprint,
      permissionFingerprint,
      fingerprint: hash(JSON.stringify({
        modelFingerprint: model.fingerprint,
        permissionFingerprint
      }))
    };
  };
  const coreContextPayload = (snapshot, trend) => '<reference_context_data format="application/json">' + JSON.stringify({
    coreUserModel: {
      fingerprint: snapshot.model.fingerprint,
      claims: list(snapshot.model.claims),
      answers: list(snapshot.model.answers),
      unknowns: list(snapshot.model.unknowns)
    },
    ...(trend?.historicalUserSupplement && typeof trend.historicalUserSupplement === "object"
      ? { historicalUserSupplement: trend.historicalUserSupplement }
      : {}),
    ...(trend?.payload && typeof trend.payload === "object"
      ? { sevenDayTrend: trend.payload,
        referenceEvidence: list(trend.citationSources).map(source => ({ citationId: source.citationId, text: source.text,
      origin: source.source?.origin || "user", informationType: source.source?.informationType || "user_original" })) }
      : {})
  }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e") + '</reference_context_data>';

  const assertCoreModelCurrent = (store, expected) => {
    const current = coreModelSnapshot(store);
    if (!current || current.fingerprint !== expected?.fingerprint) throw staleCoreModel();
  };
  const stableContext = (snapshot, trend, dynamicContext = "") => [
    coreContextPayload(snapshot, trend),
    String(dynamicContext || "")
  ].filter(Boolean).join("\n\n");
  const trendFor = (store, asOf) => getRecentTrend(store, asOf);
  const contextAsOf = () => new Date(currentTime()).toISOString();
  const trendSnapshot = (store, generatedAt) => {
    const trend = trendFor(store, generatedAt);
    return { generatedAt, trend, fingerprint: trend?.fingerprint || "" };
  };
  const assertTrendCurrent = (store, expected) => {
    const current = trendFor(store, expected?.generatedAt);
    if ((current?.fingerprint || "") !== (expected?.fingerprint || "")) {
      throw staleJournalContext();
    }
  };
  const journalTargetSnapshot = (store, binding = {}) => {
    const targetId = String(binding?.targetId || "");
    if (!targetId) return { targetId, fingerprint: "" };
    if (targetId === "journal-draft") {
      const draft = store?.journalDraft;
      return {
        targetId,
        fingerprint: hash(JSON.stringify(draft ? {
          journalId: String(draft.journalId || ""),
          title: String(draft.title || ""),
          content: String(draft.content || "")
        } : null))
      };
    }
    const journal = list(store?.journals).find(item => item?.id === targetId);
    return {
      targetId,
      fingerprint: hash(JSON.stringify(journal ? {
        id: journal.id,
        title: journal.title,
        content: journal.content,
        tags: journal.tags,
        occurredAt: journal.occurredAt,
        occurredOn: journal.occurredOn,
        createdAt: journal.createdAt,
        updatedAt: journal.updatedAt,
        version: recordVersion(journal.version)
      } : null))
    };
  };
  const assertJournalTargetCurrent = (store, binding, expected) => {
    if (journalTargetSnapshot(store, binding).fingerprint !== expected?.fingerprint) {
      throw staleJournalContext();
    }
  };
  const assertAssistContextCurrent = (store, expected) => {
    assertCoreModelCurrent(store, expected.coreModel);
    if (!reflectionContextReceiptMatches(store, expected.personalContext.receipt)
      || hash(diaryActivityContext(store, expected.occurredOn)) !== expected.activityFingerprint) {
      throw staleJournalContext();
    }
    assertJournalTargetCurrent(store, expected.binding, expected.target);
    if (expected.trend) assertTrendCurrent(store, expected.trend);
  };
  const taskContextAsOf = task => task.contextGeneratedAt || task.createdAt || contextAsOf();
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
        const coreModel = coreModelSnapshot(store);
        if (!coreModel) return null;
        const personalContext = personalContextProjection(store);
        const activityContext = diaryActivityContext(store, payload.occurredOn);
        const prompt = journalAssistPrompt(stableContext(coreModel, null, activityContext), {
          mode: payload.mode,
          title: payload.title,
          content: payload.content
        });
        return {
          kind: task.kind,
          inputVersion: 0,
          subtargetVersion: 0,
          inputHash: intentHash(task.kind, task.targetId, task.payload),
          prompt,
          contextFingerprint: hash(JSON.stringify({
            receipt: personalContextReceiptFingerprint(personalContext.receipt),
            importanceReferences: personalContext.receipt.importanceReferences || null,
            prompt: personalContext.prompt,
            activityContext,
            coreModel: coreModel.fingerprint
          })),
          coreModelFingerprint: coreModel.fingerprint,
          coreModelModelFingerprint: coreModel.modelFingerprint,
          coreModelPermissionFingerprint: coreModel.permissionFingerprint,
          scene: ASSIST_SCENES[payload.mode],
          triggerType: "user_explicit",
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
        const coreModel = coreModelSnapshot(store);
        if (!coreModel) return null;
        const trend = trendFor(store, taskContextAsOf(task));
        const personalContext = personalContextProjection(store);
        if (!addImportance(store, personalContext, journal,
          hash(JSON.stringify([task.clientRequestId || task.id, coreModel.fingerprint])), task.importanceSelectionPlan || null)) return null;
        const currentJournal = journalCitationSource(journal);
        const citationContext = '<reference_context_data format="application/json">' + JSON.stringify({
          currentMaterial: { citationId: currentJournal.citationId, text: currentJournal.text }
        }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e") + '</reference_context_data>';
        return {
          kind: task.kind,
          inputVersion: recordVersion(journal.version),
          subtargetVersion: 0,
          inputHash: reflectionIntent(store, task).inputHash,
          prompt: userPrompt({
            context: stableContext(coreModel, trend, [personalContext.prompt, citationContext]
              .filter(Boolean).join("\n\n")),
            ...journalReflectionInput(journal, { materialInContext: true })
          }),
          scene: "diaryReflection",
          triggerType: "user_explicit",
          json: true,
          citationsEnabled: true,
          citationSources: answerCitationSources(coreModel.model, [
            ...trendCitationSources(trend),
            currentJournal, ...(personalContext.importanceSources || [])
          ]),
          systemPrompt: citationSystemPrompt(diarySystemPrompt()),
          contextReceipt: personalContext.receipt,
          contextFingerprint: hash(JSON.stringify({
            receipt: personalContextReceiptFingerprint(personalContext.receipt),
            importanceReferences: personalContext.receipt.importanceReferences || null,
            coreModel: coreModel.fingerprint,
            trend: trend?.fingerprint || ""
          })),
          coreModelFingerprint: coreModel.fingerprint,
          coreModelModelFingerprint: coreModel.modelFingerprint,
          coreModelPermissionFingerprint: coreModel.permissionFingerprint,
          sourceUpdatedAt
        };
      }
      return null;
    },
    save(store, work, task, result) {
      assertCoreModelCurrent(store, {
        fingerprint: work.coreModelFingerprint
      });
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
        ...(Array.isArray(result.citations) ? {
          citations: result.citations,
          citationStatus: result.citationStatus,
          providedReferences: result.providedReferences,
          rejectedReferences: result.rejectedReferences
        } : {}),
        reasoningContent: result.reasoningContent,
        contextReceipt: { ...compactPersonalContextReceipt(work.contextReceipt),
          ...(result.referenceReceipt ? { referenceRequest: result.referenceReceipt } : {}) }
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
      const coreModel = coreModelSnapshot(store);
      const activityContext = diaryActivityContext(store, occurredOn);
      const personalContext = personalContextProjection(store);
      const target = journalTargetSnapshot(store, binding);
      const freshness = {
        coreModel,
        occurredOn,
        binding,
        target,
        personalContext,
        activityFingerprint: hash(activityContext)
      };
      const bufferedDeltas = [];
      const result = await generate(
        journalAssistPrompt(stableContext(coreModel, null, activityContext), {
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
          onDelta: event => bufferedDeltas.push(event)
        }
      );
      assertAssistContextCurrent(await repository.read(), freshness);
      for (const event of bufferedDeltas) onDelta?.(event);
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
        const coreModel = coreModelSnapshot(store);
        const generatedAt = contextAsOf();
        const trend = trendSnapshot(store, generatedAt);
        const personalContext = personalContextProjection(store);
        const target = journalTargetSnapshot(store, { targetId: id });
        const freshness = {
          coreModel,
          trend,
          personalContext,
          target
        };
        const currentJournal = journalCitationSource(journal);
        addImportance(store, personalContext, journal, hash(JSON.stringify([clientRequestId, coreModel.fingerprint])));
        const citationContext = '<reference_context_data format="application/json">' + JSON.stringify({
          currentMaterial: { citationId: currentJournal.citationId, text: currentJournal.text }
        }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e") + '</reference_context_data>';
        const bufferedDeltas = [];
        const referenceRequest = prepareReferenceRequest(userPrompt({
          context: stableContext(coreModel, trend.trend, [personalContext.prompt, citationContext]
            .filter(Boolean).join("\n\n")), ...journalReflectionInput(journal, { materialInContext: true })
        }), answerCitationSources(coreModel.model, [...trendCitationSources(trend.trend), currentJournal, ...(personalContext.importanceSources || [])]),
        JSON.stringify([contextKey(), id, personalContext.receipt, sourceUpdatedAt]));
        const result = await generate(referenceRequest.prompt, {
          scene: "diaryReflection",
          json: true,
          systemPrompt: citationSystemPrompt(diarySystemPrompt()),
          captureReasoning: true,
          contextReceipt: { ...personalContext.receipt, referenceRequest: referenceRequest.receipt },
          onDelta: notify ? event => bufferedDeltas.push(event) : null
        });
        const currentStore = await repository.read();
        assertCoreModelCurrent(currentStore, coreModel);
        if (!reflectionContextReceiptMatches(currentStore, personalContext.receipt)) {
          throw failure("个人语境已变化，本次回望未写入", "STALE_PERSONAL_CONTEXT", 409);
        }
        assertJournalTargetCurrent(currentStore, { targetId: id }, target);
        assertTrendCurrent(currentStore, trend);
        const verified = verifyReferenceAnswer(result.content, referenceRequest);
        const validateFreshness = document => {
          assertCoreModelCurrent(document, freshness.coreModel);
          if (!reflectionContextReceiptMatches(document, freshness.personalContext.receipt)) {
            throw failure("个人语境已变化，本次回望未写入", "STALE_PERSONAL_CONTEXT", 409);
          }
          assertJournalTargetCurrent(document, { targetId: id }, freshness.target);
          assertTrendCurrent(document, freshness.trend);
        };
        const reflectionInput = {
          sourceUpdatedAt,
          content: verified.content,
          ...(verified.citations ? {
            citations: verified.citations,
            citationStatus: verified.citationStatus,
            providedReferences: verified.providedReferences,
            rejectedReferences: verified.rejectedReferences
          } : {}),
          reasoningContent: result.reasoningContent,
          contextReceipt: { ...compactPersonalContextReceipt(personalContext.receipt), referenceRequest: verified.referenceReceipt }
        };
        let saved;
        if (idempotencyRequest && typeof repository.executeIdempotent === "function") {
          let executed = false;
          saved = await repository.executeIdempotent(idempotencyRequest, document => {
            executed = true;
            validateFreshness(document);
            const response = journals.addReflectionInStore(document, id, reflectionInput, {
              clientRequestId,
              requestHash,
              useLegacyLookup: false
            });
            if (response.conflict) {
              throw failure("同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED", 409);
            }
            if (response.missing) throw staleJournalContext();
            return response;
          }, {
            onReplay: value => value && typeof value === "object"
              ? { ...value, duplicate: true }
              : value
          });
          if (!executed && saved && typeof saved === "object") saved = { ...saved, duplicate: true };
        } else if (typeof repository.update === "function") {
          saved = await repository.update(document => {
            validateFreshness(document);
            return journals.addReflectionInStore(document, id, reflectionInput, {
              clientRequestId,
              requestHash
            });
          });
        } else {
          // Compatibility for legacy adapters that expose only read(); the journal
          // records layer still owns its atomic/idempotent write transaction.
          saved = await journals.addReflection(id, reflectionInput, { clientRequestId, requestHash });
        }
        if (saved.conflict) {
          throw failure("同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED", 409);
        }
        if (saved.missing) throw new Error("这篇日记已被删除");
        if (!saved.duplicate && verified.content) {
          replayVerifiedAnswerDeltas(notify, bufferedDeltas, verified.content);
        }
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
