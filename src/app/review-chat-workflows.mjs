import { supplementalImportanceContext, supplementalImportanceReceiptMatches } from "./task-context.mjs";
import crypto from "node:crypto";
import { chatHistory, chatMessage } from "../modules/chats/index.mjs";
import { reflectionEvidence, reflectionPrompt } from "../modules/reviews/index.mjs";
import { systemPrompt, userPrompt } from "../modules/ai/index.mjs";
import { promptText, renderPrompt } from "../shared/prompts/index.mjs";
import { answerCitationSources, prepareReferenceRequest, verifyReferenceAnswer } from "./answer-citations.mjs";
import { assertCoreModelReady } from "../shared/core-model-gate.mjs";
import { evidenceSourceKey, normalizeEvidencePermission } from "../modules/user-model/index.mjs";
import { recordVersion } from "../shared/validation/index.mjs";
import { coreUserModelProjection } from "./user-model.mjs";
import {
  compactPersonalContextReceipt,
  learningThoughtSelection,
  personalContextProjection,
  personalContextReceiptFingerprint,
  personalContextReceiptMatches
} from "./personal-context.mjs";

const idempotencyConflict = () => Object.assign(new Error("同一幂等键不能用于不同内容"), {
  statusCode: 409,
  code: "IDEMPOTENCY_KEY_REUSED"
});
const sourceEligible = item => item
  && item.contextAllowed !== false
  && item.allowInContext !== false
  && item.disposition !== "discarded";
const stalePersonalizedChat = () => Object.assign(
  new Error("聊天上下文或来源权限已变化，本次应答未写入"),
  { code: "AI_TASK_STALE", statusCode: 409 }
);
const staleCoreModel = () => Object.assign(
  new Error("核心用户模型或来源权限已变化，本次结果未写入"),
  { code: "AI_TASK_STALE", statusCode: 409 }
);
const staleTrend = () => Object.assign(
  new Error("生成期间七日趋势已变化，本次结果未写入"),
  { code: "AI_TASK_STALE", statusCode: 409 }
);
const list = value => Array.isArray(value) ? value : [];
const trendCitationSources = trend => [
  ...list(trend?.historicalUserSupplementCitationSources),
  ...list(trend?.citationSources)
];
const citationSystemPrompt = (base, additional = "") => [
  base,
  promptText("orchestration.answer.citations"),
  additional
].filter(Boolean).join("\n\n");

export function createReviewChatWorkflows({
  repository,
  chats,
  reviews,
  backgroundAi,
  generate,
  hash,
  coreModelReadiness = () => ({ ready: true }),
  getRecentTrend = () => null,
  getImportanceModelSnapshot = () => null,
  contextKey = () => "local",
  getAccountId = contextKey,
  periodicAnalysisEnabled = false,
  readPeriodicPreferences = async () => ({}),
  currentTime = () => Date.now(),
  createId = () => crypto.randomUUID()
}) {
  const answerContextReceiptMatches = (store, receipt) => personalContextReceiptMatches(store, receipt)
    && supplementalImportanceReceiptMatches(store, receipt?.importanceReferences, getAccountId());
  const addImportance = (store, context, text, seed, frozenPlan = null) => {
    const supplemental = supplementalImportanceContext(store, { accountId: getAccountId(), text, seed,
      choice: getImportanceModelSnapshot(), frozenPlan, purpose: context.receipt.permissionPurpose || "context" });
    if (!supplemental) return false;
    context.prompt = [context.prompt, supplemental.prompt].filter(Boolean).join("\n\n");
    context.receipt = { ...context.receipt, importanceReferences: supplemental.receipt };
    context.importanceSources = supplemental.sources;
    return true;
  };
  if (!repository
    || typeof repository.read !== "function"
    || typeof repository.update !== "function") {
    throw new TypeError("Review/chat workflows require a repository with read() and update()");
  }
  for (const [name, dependency] of Object.entries({
    generate,
    hash,
    contextKey,
    getAccountId,
    currentTime
  })) {
    if (typeof dependency !== "function") throw new TypeError(`Review/chat workflows require ${name}()`);
  }

  const active = new Map();
  const periodicAllowed = async () => periodicAnalysisEnabled === true
    && (await readPeriodicPreferences())?.periodicReviews?.analysisEnabled === true;
  const assertPeriodicConsent = async () => {
    if (await periodicAllowed()) return;
    throw Object.assign(new Error("周期认知复盘未开启，未创建新结果"), {
      code: "PERIODIC_ANALYSIS_CONSENT_REQUIRED",
      statusCode: 409
    });
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
  const stableContext = (snapshot, trend, dynamicContext = "") => [
    coreContextPayload(snapshot, trend),
    String(dynamicContext || "")
  ].filter(Boolean).join("\n\n");
  const trendSnapshot = (store, generatedAt) => {
    const trend = getRecentTrend(store, generatedAt);
    return { generatedAt, trend, fingerprint: trend?.fingerprint || "" };
  };
  const assertTrendCurrent = (store, generatedAt, expectedFingerprint) => {
    const current = getRecentTrend(store, generatedAt);
    if ((current?.fingerprint || "") !== (expectedFingerprint || "")) throw staleTrend();
  };
  const taskContextAsOf = task => (
    task.contextGeneratedAt || task.createdAt || new Date(currentTime()).toISOString()
  );
  const assertCoreModelCurrent = (store, expected) => {
    const current = coreModelSnapshot(store);
    if (!current || current.fingerprint !== expected?.fingerprint) throw staleCoreModel();
  };
  const intentHash = task => hash(JSON.stringify({
    kind: task.kind,
    targetId: task.targetId || "",
    payload: task.payload || {}
  }));
  const queueColdTask = async (kind, targetId, payload, clientRequestId) => {
    const store = await repository.read();
    if (coreModelReadiness(store)?.ready !== false) return null;
    return backgroundAi.enqueue({ kind, targetId, payload, clientRequestId });
  };
  const chatHistorySnapshot = store => {
    const accountId = String(getAccountId() || "");
    const eligible = [];
    const permissionRevisions = [];
    const permissions = Array.isArray(store?.evidencePermissions)
      ? store.evidencePermissions
      : [];
    for (const item of Array.isArray(store?.chats) ? store.chats : []) {
      if (!sourceEligible(item)) continue;
      const sourceRef = {
        resourceType: "chat",
        resourceId: String(item.id || ""),
        rootId: "",
        targetKey: "message",
        version: recordVersion(item.version)
      };
      const sourceKey = evidenceSourceKey(sourceRef);
      if (!sourceKey) continue;
      const matching = permissions.filter(permission => permission?.sourceKey === sourceKey);
      let permissionRevision = 0;
      if (matching.length) {
        const permission = matching.length === 1
          ? normalizeEvidencePermission(matching[0])
          : null;
        if (!permission || permission.accountId !== accountId
          || permission.contextAllowed !== true) {
          continue;
        }
        permissionRevision = permission.revision;
      }
      eligible.push(item);
      permissionRevisions.push([sourceKey, permissionRevision]);
    }
    const selected = eligible.slice(0, 12);
    const selectedPermissions = permissionRevisions.slice(0, selected.length);
    const history = chatHistory(selected);
    return {
      history,
      permissionRevisions: selectedPermissions,
      fingerprint: hash(JSON.stringify({
        accountId,
        history,
        permissionRevisions: selectedPermissions
      }))
    };
  };
  const assertChatHistoryCurrent = (store, expectedFingerprint, expectedPermissionRevisions) => {
    const current = chatHistorySnapshot(store);
    if (!expectedFingerprint
      || current.fingerprint !== expectedFingerprint
      || JSON.stringify(current.permissionRevisions) !== JSON.stringify(expectedPermissionRevisions)) {
      throw stalePersonalizedChat();
    }
  };
  const personalizedTaskHandler = {
    async canExecute(task) {
      return task?.kind !== "analysis"
        || task.payload?.reason !== "weekly-background"
        || await periodicAllowed();
    },
    inspectIntent(_store, task) {
      if (!["chat", "analysis"].includes(task?.kind)) return false;
      return { inputVersion: 0, subtargetVersion: 0, inputHash: intentHash(task) };
    },
    prepare(store, task) {
      if (task.kind === "chat") {
        const payload = task.payload;
        const eventTime = {
          occurredAt: payload.occurredAt,
          occurredOn: payload.occurredOn,
          ...(payload.eventTimePrecision === "date" ? { eventTimePrecision: "date" } : {})
        };
        if ((!eventTime.occurredAt && eventTime.eventTimePrecision !== "date") || !eventTime.occurredOn) return null;
        const coreModel = coreModelSnapshot(store);
        if (!coreModel) return null;
        const generatedAt = taskContextAsOf(task);
        const trend = trendSnapshot(store, generatedAt);
        const personalContext = personalContextProjection(store);
        if (!addImportance(store, personalContext, payload.message,
          hash(JSON.stringify([task.clientRequestId || task.id, coreModel.fingerprint])), task.importanceSelectionPlan || null)) return null;
        const history = chatHistorySnapshot(store);
        const contextReceipt = {
          ...personalContext.receipt,
          chatHistoryFingerprint: history.fingerprint,
          chatHistoryPermissionRevisions: history.permissionRevisions
        };
        return {
          kind: task.kind,
          inputVersion: 0,
          subtargetVersion: 0,
          inputHash: intentHash(task),
          prompt: userPrompt({
            context: stableContext(coreModel, trend.trend, personalContext.prompt),
            task: payload.message
          }),
          scene: "chat",
          triggerType: "user_explicit",
          json: true,
          citationsEnabled: true,
          citationSources: answerCitationSources(coreModel.model, [...trendCitationSources(trend.trend), ...(personalContext.importanceSources || [])]),
          systemPrompt: citationSystemPrompt(systemPrompt()),
          history: history.history,
          contextReceipt,
          contextFingerprint: hash(JSON.stringify({
            receipt: personalContextReceiptFingerprint(personalContext.receipt),
            importanceReferences: personalContext.receipt.importanceReferences || null,
            history: history.fingerprint,
            coreModel: coreModel.fingerprint,
            trend: trend?.fingerprint || ""
          })),
          coreModelFingerprint: coreModel.fingerprint,
          coreModelModelFingerprint: coreModel.modelFingerprint,
          coreModelPermissionFingerprint: coreModel.permissionFingerprint,
          trendGeneratedAt: generatedAt,
          trendFingerprint: trend.fingerprint
        };
      }
      if (task.kind === "analysis") {
        const coreModel = coreModelSnapshot(store);
        if (!coreModel) return null;
        const generatedAt = taskContextAsOf(task);
        const trend = trendSnapshot(store, generatedAt);
        const { personalContext, evidence, evidenceHash } = analysisSnapshot(store);
        const citationEvidence = analysisSources(evidence);
        if (!addImportance(store, personalContext, JSON.stringify(citationEvidence.reflectionData),
          hash(JSON.stringify([task.clientRequestId || task.id, coreModel.fingerprint])), task.importanceSelectionPlan || null)) return null;
        if (!evidence.evidenceCount) {
          return {
            kind: task.kind,
            inputVersion: 0,
            subtargetVersion: 0,
            inputHash: intentHash(task),
            preflightError: {
              code: "REVIEW_EVIDENCE_REQUIRED",
              message: "先留下一条状态、健康、捕念、日记或思绪记录，再开始认知复盘"
            }
          };
        }
        return {
          kind: task.kind,
          inputVersion: 0,
          subtargetVersion: 0,
          inputHash: intentHash(task),
          prompt: reflectionPrompt({
            personalContext: stableContext(coreModel, trend.trend, personalContext.prompt),
            reflectionData: citationEvidence.reflectionData,
            evidenceLevel: evidence.evidenceLevel
          }),
          scene: "analysis",
          triggerType: task.payload?.reason === "weekly-background" ? "scheduled" : "user_explicit",
          json: true,
          citationsEnabled: true,
          citationSources: answerCitationSources(coreModel.model, [
            ...trendCitationSources(trend.trend),
            ...citationEvidence.sources, ...(personalContext.importanceSources || [])
          ]),
          systemPrompt: citationSystemPrompt(
            renderPrompt("orchestration.role.periodicSynthesis"),
            "reflectionData 中明确标记的 citationId 对应本轮获准的思绪、追问、回答或行动反馈原文。"
          ),
          contextReceipt: personalContext.receipt,
          evidenceHash,
          contextFingerprint: hash(JSON.stringify({
            receipt: personalContextReceiptFingerprint(personalContext.receipt),
            importanceReferences: personalContext.receipt.importanceReferences || null,
            evidenceHash,
            coreModel: coreModel.fingerprint,
            trend: trend?.fingerprint || ""
          })),
          coreModelFingerprint: coreModel.fingerprint,
          coreModelModelFingerprint: coreModel.modelFingerprint,
          coreModelPermissionFingerprint: coreModel.permissionFingerprint,
          trendGeneratedAt: generatedAt,
          trendFingerprint: trend.fingerprint
        };
      }
      return null;
    },
    save(document, work, task, result) {
      assertCoreModelCurrent(document, {
        fingerprint: work.coreModelFingerprint
      });
      if (task.kind === "chat") {
        const generatedReceipt = result?.contextReceipt;
        if (!answerContextReceiptMatches(document, generatedReceipt)) {
          throw stalePersonalizedChat();
        }
        assertChatHistoryCurrent(
          document,
          generatedReceipt.chatHistoryFingerprint,
          generatedReceipt.chatHistoryPermissionRevisions
        );
        assertTrendCurrent(document, work.trendGeneratedAt, work.trendFingerprint);
        const payload = task.payload;
        const requestHash = hash(JSON.stringify({
          message: payload.message,
          occurredAt: payload.eventTimeHash
        }));
        const saved = chats.saveInStore(document, {
          message: payload.message,
          eventTime: {
            occurredAt: payload.occurredAt,
            occurredOn: payload.occurredOn,
            ...(payload.eventTimePrecision === "date" ? { eventTimePrecision: "date" } : {})
          },
          answer: result.content,
          ...(Array.isArray(result.citations) ? {
            citations: result.citations,
            citationStatus: result.citationStatus,
          providedReferences: result.providedReferences,
          rejectedReferences: result.rejectedReferences
          } : {}),
          reasoningContent: result.reasoningContent,
          contextReceipt: { ...compactPersonalContextReceipt(generatedReceipt),
            ...(result.referenceReceipt ? { referenceRequest: result.referenceReceipt } : {}) }
        }, { clientRequestId: task.clientRequestId, requestHash });
        if (saved.conflict) throw idempotencyConflict();
        if (saved.error) throw new Error(saved.error);
        return saved.value.id;
      }
      const generated = {
        reason: task.payload.reason || "manual",
        content: result.content,
        ...(Array.isArray(result.citations) ? {
          citations: result.citations,
          citationStatus: result.citationStatus,
          providedReferences: result.providedReferences,
          rejectedReferences: result.rejectedReferences
        } : {}),
        reasoningContent: result.reasoningContent,
        contextReceipt: work.contextReceipt,
        evidenceHash: work.evidenceHash,
        coreModelFingerprint: work.coreModelFingerprint,
        trendGeneratedAt: work.trendGeneratedAt,
        trendFingerprint: work.trendFingerprint
      };
      assertAnalysisCurrent(document, generated);
      const requestHash = hash(JSON.stringify({ reason: generated.reason }));
      const saved = reviews.saveAnalysisInStore(document, {
        ...generated,
        contextReceipt: { ...compactPersonalContextReceipt(work.contextReceipt),
          ...(result.referenceReceipt ? { referenceRequest: result.referenceReceipt } : {}) }
      }, { clientRequestId: task.clientRequestId, requestHash });
      if (saved.conflict) throw idempotencyConflict();
      if (saved.error) throw new Error(saved.error);
      return saved.value.id;
    },
    result(store, task) {
      if (task.kind === "chat") return (store.chats || []).find(item => item.id === task.resultId) || null;
      if (task.kind === "analysis") return (store.analyses || []).find(item => item.id === task.resultId) || null;
      return null;
    }
  };
  const analysisEvidence = (store, allowedSourceKeys, permissionPurpose) => {
    const allowed = (type, id, rootId = "", targetKey = "") => allowedSourceKeys.has(
      JSON.stringify([type, String(id || ""), String(rootId || ""), String(targetKey || "")])
    );
    const thoughts = learningThoughtSelection(store);
    return reflectionEvidence({
      thoughts,
      checkins: store.checkins?.filter(item => sourceEligible(item) && allowed("checkin", item.id)),
      dailyRecords: store.dailyRecords?.filter(item => sourceEligible(item) && allowed("dailyRecord", item.id)),
      captures: store.captures?.filter(item => sourceEligible(item) && allowed("capture", item.id)),
      journals: store.journals?.filter(item => sourceEligible(item) && allowed("journal", item.id)),
      actions: store.actions,
      permissionPurpose
    });
  };
  const analysisEvidenceHash = evidence => hash(JSON.stringify(evidence));
  const analysisSnapshot = (store, permissionPurpose = "learning") => {
    const personalContext = personalContextProjection(store, {
      permissionPurpose
    });
    const accountId = String(getAccountId() || "");
    const allowedSourceKeys = new Set((store.evidencePermissions || [])
      .filter(permission => (
        permission?.accountId === accountId
        && permission?.learningAllowed === true
      ))
      .map(permission => permission.sourceKey));
    const evidence = analysisEvidence(store, allowedSourceKeys, permissionPurpose);
    const permissionVector = (store.evidencePermissions || [])
      .filter(permission => (
        permission?.accountId === accountId
        && allowedSourceKeys.has(permission.sourceKey)
      ))
      .map(permission => [permission.sourceKey, permission.revision])
      .sort(([left], [right]) => left.localeCompare(right));
    return {
      personalContext,
      evidence,
      evidenceHash: analysisEvidenceHash({ evidence, permissionVector })
    };
  };
  const analysisSources = evidence => {
    const sources = [];
    const reflectionData = list(evidence?.reflectionData).map((item, index) => {
      if (item?.id) {
        const citationId = `analysis:${item.type || "record"}:${item.id}:${item.version || 0}`;
        if (item.content) {
          sources.push({
            citationId,
            text: String(item.content),
            source: {
              resourceType: ["question", "answer"].includes(item.type) ? "thought" : "action",
              resourceId: String(item.id),
              recordType: String(item.type || "思绪记录"),
              version: recordVersion(item.version),
              location: { view: "thoughts", targetId: item.relatedTo || item.id,
                rootId: item.relatedTo || item.id, targetKey: `${item.type || "record"}:${item.id}` }
            }
          });
        }
        const followUps = list(item.followUps).map((followUp, followUpIndex) => {
          const followUpCitationId = `${citationId}:follow-up:${followUp.id || followUpIndex}`;
          const text = [followUp.question, followUp.answer].filter(Boolean).join("\n");
          if (text) {
            sources.push({
              citationId: followUpCitationId,
              text,
              source: {
                resourceType: "thought",
                resourceId: String(item.id),
                recordType: "思绪追问与回答",
                version: recordVersion(followUp.version || item.version),
              location: { view: "thoughts", targetId: item.id, rootId: item.id,
                targetKey: `followup-question:${followUp.id || followUpIndex}` }
              }
            });
          }
          return { ...followUp, citationId: followUpCitationId };
        });
        return { ...item, citationId, followUps };
      }
      if (item?.actionId) {
        const citationId = `analysis:action-feedback:${item.actionId}:${item.completedAt || index}`;
        const text = [item.title, item.note, item.outcome].filter(Boolean).join("\n");
        if (text) {
          sources.push({
            citationId,
            text,
            source: {
              resourceType: "action",
              resourceId: String(item.actionId),
              recordType: "行动反馈",
              version: 0
            }
          });
        }
        return { ...item, citationId };
      }
      return item;
    });
    return { reflectionData, sources };
  };
  const assertAnalysisCurrent = (store, generated) => {
    assertCoreModelCurrent(store, {
      fingerprint: generated.coreModelFingerprint
    });
    const snapshot = analysisSnapshot(
      store,
      generated.contextReceipt?.permissionPurpose || "learning"
    );
    if (!answerContextReceiptMatches(store, generated.contextReceipt)
      || snapshot.evidenceHash !== generated.evidenceHash) {
      throw Object.assign(new Error("个人语境已变化，本次复盘未写入"), {
        code: "STALE_PERSONAL_CONTEXT",
        statusCode: 409
      });
    }
    assertTrendCurrent(store, generated.trendGeneratedAt, generated.trendFingerprint);
  };

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
        assertCoreModelReady(coreModelReadiness(store));
        const coreModel = coreModelSnapshot(store);
        const generatedAt = new Date(currentTime()).toISOString();
        const trend = trendSnapshot(store, generatedAt);
        const personalContext = personalContextProjection(store);
        addImportance(store, personalContext, message, hash(JSON.stringify([clientRequestId, coreModel.fingerprint])));
        const history = chatHistorySnapshot(store);
        const contextReceipt = {
          ...personalContext.receipt,
          chatHistoryFingerprint: history.fingerprint,
          chatHistoryPermissionRevisions: history.permissionRevisions
        };
        const referenceRequest = prepareReferenceRequest(userPrompt({
          context: stableContext(coreModel, trend.trend, personalContext.prompt), task: message
        }), answerCitationSources(coreModel.model, [...trendCitationSources(trend.trend), ...(personalContext.importanceSources || [])]),
        JSON.stringify([getAccountId(), clientRequestId, contextReceipt]));
        const result = await generate(referenceRequest.prompt, {
          scene: "chat",
          history: history.history,
          json: true,
          systemPrompt: citationSystemPrompt(systemPrompt()),
          captureReasoning: true,
          contextReceipt: { ...contextReceipt, referenceRequest: referenceRequest.receipt }
        });
        const current = await repository.read();
        assertCoreModelCurrent(current, coreModel);
        if (!answerContextReceiptMatches(current, contextReceipt)) {
          throw stalePersonalizedChat();
        }
        assertChatHistoryCurrent(
          current,
          contextReceipt.chatHistoryFingerprint,
          contextReceipt.chatHistoryPermissionRevisions
        );
        assertTrendCurrent(current, generatedAt, trend.fingerprint);
        const verified = verifyReferenceAnswer(result.content, referenceRequest);
        return {
          message,
          eventTime,
          answer: verified.content,
          ...(verified.citations ? {
            citations: verified.citations,
            citationStatus: verified.citationStatus,
            providedReferences: verified.providedReferences,
            rejectedReferences: verified.rejectedReferences
          } : {}),
          reasoningContent: result.reasoningContent,
          contextReceipt: { ...contextReceipt, referenceRequest: verified.referenceReceipt },
          coreModelFingerprint: coreModel.fingerprint,
          trendGeneratedAt: generatedAt,
          trendFingerprint: trend.fingerprint
        };
      },
      save: async generated => {
        const current = await repository.read();
        assertCoreModelCurrent(current, {
          fingerprint: generated.coreModelFingerprint
        });
        if (!answerContextReceiptMatches(current, generated.contextReceipt)) {
          throw stalePersonalizedChat();
        }
        assertChatHistoryCurrent(
          current,
          generated.contextReceipt?.chatHistoryFingerprint,
          generated.contextReceipt?.chatHistoryPermissionRevisions
        );
        assertTrendCurrent(current, generated.trendGeneratedAt, generated.trendFingerprint);
        const input = {
          ...generated,
          contextReceipt: compactPersonalContextReceipt(generated.contextReceipt)
        };
        if (clientRequestId && typeof repository.executeIdempotent !== "function") {
          return chats.save(input, { clientRequestId, requestHash });
        }
        if (typeof chats.saveInStore === "function") {
          return repository.update(document => {
            assertCoreModelCurrent(document, { fingerprint: generated.coreModelFingerprint });
            if (!answerContextReceiptMatches(document, generated.contextReceipt)) {
              throw stalePersonalizedChat();
            }
            assertChatHistoryCurrent(
              document,
              generated.contextReceipt?.chatHistoryFingerprint,
              generated.contextReceipt?.chatHistoryPermissionRevisions
            );
            assertTrendCurrent(document, generated.trendGeneratedAt, generated.trendFingerprint);
            return chats.saveInStore(document, input, { clientRequestId, requestHash });
          });
        }
        return chats.save(input, { clientRequestId, requestHash });
      },
      saveInStore: typeof chats.saveInStore === "function"
        ? (document, generated) => {
            assertCoreModelCurrent(document, {
              fingerprint: generated.coreModelFingerprint
            });
            if (!answerContextReceiptMatches(document, generated.contextReceipt)) {
              throw stalePersonalizedChat();
            }
            assertChatHistoryCurrent(
              document,
              generated.contextReceipt?.chatHistoryFingerprint,
              generated.contextReceipt?.chatHistoryPermissionRevisions
            );
            assertTrendCurrent(document, generated.trendGeneratedAt, generated.trendFingerprint);
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
    if (reason === "weekly-background") await assertPeriodicConsent();
    const requestHash = clientRequestId ? hash(JSON.stringify({ reason })) : "";
    return generatedIdempotent({
      kind: "analysis",
      clientRequestId,
      requestHash,
      findExisting: () => reviews.findAnalysisRequest(clientRequestId, requestHash),
      generateValue: async () => {
        const store = await repository.read();
        assertCoreModelReady(coreModelReadiness(store));
        const coreModel = coreModelSnapshot(store);
        const {
          personalContext,
          evidence,
          evidenceHash
        } = analysisSnapshot(store);
        const generatedAt = new Date(currentTime()).toISOString();
        const trend = trendSnapshot(store, generatedAt);
        if (!evidence.evidenceCount) {
          throw new Error("先留下一条状态、健康、捕念、日记或思绪记录，再开始认知复盘");
        }
        const citationEvidence = analysisSources(evidence);
        addImportance(store, personalContext, JSON.stringify(citationEvidence.reflectionData),
          hash(JSON.stringify([clientRequestId, coreModel.fingerprint])));
        const referenceRequest = prepareReferenceRequest(reflectionPrompt({
          personalContext: stableContext(coreModel, trend.trend, personalContext.prompt),
          reflectionData: citationEvidence.reflectionData, evidenceLevel: evidence.evidenceLevel
        }), answerCitationSources(coreModel.model, [
          ...trendCitationSources(trend.trend), ...citationEvidence.sources, ...(personalContext.importanceSources || [])
        ]), JSON.stringify([getAccountId(), clientRequestId, personalContext.receipt, evidenceHash]));
        const result = await generate(referenceRequest.prompt, {
          scene: "analysis",
          triggerType: reason === "weekly-background" ? "scheduled" : "user_explicit",
          json: true,
          systemPrompt: citationSystemPrompt(
            renderPrompt("orchestration.role.periodicSynthesis"),
            "reflectionData 中明确标记的 citationId 对应本轮获准的思绪、追问、回答或行动反馈原文。"
          ),
          captureReasoning: true,
          isCurrent: async () => reason !== "weekly-background" || await periodicAllowed(),
          contextReceipt: { ...personalContext.receipt, referenceRequest: referenceRequest.receipt }
        });
        if (reason === "weekly-background") await assertPeriodicConsent();
        const freshness = {
          reason,
          contextReceipt: personalContext.receipt,
          evidenceHash,
          coreModelFingerprint: coreModel.fingerprint,
          trendGeneratedAt: generatedAt,
          trendFingerprint: trend.fingerprint
        };
        assertAnalysisCurrent(await repository.read(), freshness);
        const verified = verifyReferenceAnswer(result.content, referenceRequest);
        return {
          reason,
          content: verified.content,
          ...(verified.citations ? {
            citations: verified.citations,
            citationStatus: verified.citationStatus,
            providedReferences: verified.providedReferences,
            rejectedReferences: verified.rejectedReferences
          } : {}),
          reasoningContent: result.reasoningContent,
          contextReceipt: { ...personalContext.receipt, referenceRequest: verified.referenceReceipt },
          evidenceHash,
          coreModelFingerprint: coreModel.fingerprint,
          trendGeneratedAt: generatedAt,
          trendFingerprint: trend.fingerprint
        };
      },
      save: async generated => {
        if (typeof reviews.saveAnalysisInStore !== "function") {
          throw new TypeError("Analysis persistence requires saveAnalysisInStore()");
        }
        return repository.update(document => {
          assertAnalysisCurrent(document, generated);
          return reviews.saveAnalysisInStore(document, {
            ...generated,
            contextReceipt: compactPersonalContextReceipt(generated.contextReceipt)
          }, { clientRequestId, requestHash });
        });
      },
      saveInStore: typeof reviews.saveAnalysisInStore === "function"
        ? (document, generated) => {
            assertAnalysisCurrent(document, generated);
            return reviews.saveAnalysisInStore(document, {
              ...generated,
              contextReceipt: compactPersonalContextReceipt(generated.contextReceipt)
            }, { clientRequestId, requestHash });
          }
        : null
    });
  }

  async function maybeRunPeriodicAnalysis() {
    if (!await periodicAllowed()) return null;
    const store = await repository.read();
    if (store.thoughts.filter(item => item.type === "question").length < 5) return null;
    const last = store.analyses[0]?.createdAt
      ? new Date(store.analyses[0].createdAt).getTime()
      : 0;
    if (currentTime() - last < 7 * 86400000) return null;
    const period = Math.floor(currentTime() / (7 * 86400000));
    return (await runAnalysis({
      reason: "weekly-background",
      clientRequestId: `periodic-analysis:${period}`
    })).value;
  }

  return {
    answerChat,
    runAnalysis,
    maybeRunPeriodicAnalysis,
    personalizedTaskHandler,
    async queueChatIfCold({ message, eventTime, eventTimeHash = "", clientRequestId = "" }) {
      const store = await repository.read();
      if (coreModelReadiness(store)?.ready !== false) return null;
      const parsed = chatMessage({ message });
      if (parsed.error) return { error: parsed.error };
      if ((!eventTime?.occurredAt && eventTime?.eventTimePrecision !== "date") || !eventTime?.occurredOn) return { error: "发生时间格式不正确" };
      const requestId = clientRequestId || createId();
      return queueColdTask("chat", "", {
        message: parsed.value,
        occurredAt: eventTime.occurredAt,
        occurredOn: eventTime.occurredOn,
        ...(eventTime.eventTimePrecision === "date" ? { eventTimePrecision: "date" } : {}),
        eventTimeHash
      }, requestId);
    },
    async queueAnalysisIfCold({ reason = "manual", clientRequestId = "" } = {}) {
      if (reason === "weekly-background") await assertPeriodicConsent();
      const requestId = clientRequestId || createId();
      return queueColdTask("analysis", "", { reason }, requestId);
    }
  };
}
