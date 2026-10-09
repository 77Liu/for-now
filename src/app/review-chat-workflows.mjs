import crypto from "node:crypto";
import { chatHistory, chatMessage } from "../modules/chats/index.mjs";
import { reflectionEvidence, reflectionPrompt } from "../modules/reviews/index.mjs";
import { userPrompt } from "../modules/ai/index.mjs";
import { renderPrompt } from "../shared/prompts/index.mjs";
import { assertCoreModelReady } from "../shared/core-model-gate.mjs";
import { evidenceSourceKey, normalizeEvidencePermission } from "../modules/user-model/index.mjs";
import { recordVersion } from "../shared/validation/index.mjs";
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

export function createReviewChatWorkflows({
  repository,
  chats,
  reviews,
  backgroundAi,
  generate,
  hash,
  coreModelReadiness = () => ({ ready: true }),
  contextKey = () => "local",
  getAccountId = contextKey,
  currentTime = () => Date.now(),
  createId = () => crypto.randomUUID()
}) {
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
    inspectIntent(_store, task) {
      if (!["chat", "analysis"].includes(task?.kind)) return false;
      return { inputVersion: 0, subtargetVersion: 0, inputHash: intentHash(task) };
    },
    prepare(store, task) {
      if (task.kind === "chat") {
        const payload = task.payload;
        const eventTime = {
          occurredAt: payload.occurredAt,
          occurredOn: payload.occurredOn
        };
        if (!eventTime.occurredAt || !eventTime.occurredOn) return null;
        const personalContext = personalContextProjection(store);
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
          prompt: userPrompt({ context: personalContext.prompt, task: payload.message }),
          scene: "chat",
          history: history.history,
          contextReceipt,
          contextFingerprint: hash(JSON.stringify({
            receipt: personalContextReceiptFingerprint(personalContext.receipt),
            history: history.fingerprint
          }))
        };
      }
      if (task.kind === "analysis") {
        const { personalContext, evidence, evidenceHash } = analysisSnapshot(store);
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
            personalContext: personalContext.prompt,
            reflectionData: evidence.reflectionData,
            evidenceLevel: evidence.evidenceLevel
          }),
          scene: "analysis",
          systemPrompt: renderPrompt("orchestration.role.periodicSynthesis"),
          contextReceipt: personalContext.receipt,
          evidenceHash,
          contextFingerprint: hash(JSON.stringify({
            receipt: personalContextReceiptFingerprint(personalContext.receipt),
            evidenceHash
          }))
        };
      }
      return null;
    },
    save(document, work, task, result) {
      if (task.kind === "chat") {
        const generatedReceipt = result?.contextReceipt;
        if (!personalContextReceiptMatches(document, generatedReceipt)) {
          throw stalePersonalizedChat();
        }
        assertChatHistoryCurrent(
          document,
          generatedReceipt.chatHistoryFingerprint,
          generatedReceipt.chatHistoryPermissionRevisions
        );
        const payload = task.payload;
        const requestHash = hash(JSON.stringify({
          message: payload.message,
          occurredAt: payload.eventTimeHash
        }));
        const saved = chats.saveInStore(document, {
          message: payload.message,
          eventTime: {
            occurredAt: payload.occurredAt,
            occurredOn: payload.occurredOn
          },
          answer: result.content,
          reasoningContent: result.reasoningContent,
          contextReceipt: compactPersonalContextReceipt(generatedReceipt)
        }, { clientRequestId: task.clientRequestId, requestHash });
        if (saved.conflict) throw idempotencyConflict();
        if (saved.error) throw new Error(saved.error);
        return saved.value.id;
      }
      const generated = {
        reason: task.payload.reason || "manual",
        content: result.content,
        reasoningContent: result.reasoningContent,
        contextReceipt: work.contextReceipt,
        evidenceHash: work.evidenceHash
      };
      assertAnalysisCurrent(document, generated);
      const requestHash = hash(JSON.stringify({ reason: generated.reason }));
      const saved = reviews.saveAnalysisInStore(document, {
        ...generated,
        contextReceipt: compactPersonalContextReceipt(work.contextReceipt)
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
  const assertAnalysisCurrent = (store, generated) => {
    const snapshot = analysisSnapshot(
      store,
      generated.contextReceipt?.permissionPurpose || "learning"
    );
    if (!personalContextReceiptMatches(store, generated.contextReceipt)
      || snapshot.evidenceHash !== generated.evidenceHash) {
      throw Object.assign(new Error("个人语境已变化，本次复盘未写入"), {
        code: "STALE_PERSONAL_CONTEXT",
        statusCode: 409
      });
    }
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
        const personalContext = personalContextProjection(store);
        const history = chatHistorySnapshot(store);
        const contextReceipt = {
          ...personalContext.receipt,
          chatHistoryFingerprint: history.fingerprint,
          chatHistoryPermissionRevisions: history.permissionRevisions
        };
        const result = await generate(userPrompt({
          context: personalContext.prompt,
          task: message
        }), {
          scene: "chat",
          history: history.history,
          captureReasoning: true,
          contextReceipt
        });
        return {
          message,
          eventTime,
          answer: result.content,
          reasoningContent: result.reasoningContent,
          contextReceipt
        };
      },
      save: async generated => {
        const current = await repository.read();
        if (!personalContextReceiptMatches(current, generated.contextReceipt)) {
          throw stalePersonalizedChat();
        }
        assertChatHistoryCurrent(
          current,
          generated.contextReceipt?.chatHistoryFingerprint,
          generated.contextReceipt?.chatHistoryPermissionRevisions
        );
        return chats.save({
          ...generated,
          contextReceipt: compactPersonalContextReceipt(generated.contextReceipt)
        }, { clientRequestId, requestHash });
      },
      saveInStore: typeof chats.saveInStore === "function"
        ? (document, generated) => {
            if (!personalContextReceiptMatches(document, generated.contextReceipt)) {
              throw stalePersonalizedChat();
            }
            assertChatHistoryCurrent(
              document,
              generated.contextReceipt?.chatHistoryFingerprint,
              generated.contextReceipt?.chatHistoryPermissionRevisions
            );
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
        assertCoreModelReady(coreModelReadiness(store));
        const {
          personalContext,
          evidence,
          evidenceHash
        } = analysisSnapshot(store);
        if (!evidence.evidenceCount) {
          throw new Error("先留下一条状态、健康、捕念、日记或思绪记录，再开始认知复盘");
        }
        const result = await generate(reflectionPrompt({
          personalContext: personalContext.prompt,
          reflectionData: evidence.reflectionData,
          evidenceLevel: evidence.evidenceLevel
        }), {
          scene: "analysis",
          systemPrompt: renderPrompt("orchestration.role.periodicSynthesis"),
          captureReasoning: true,
          contextReceipt: personalContext.receipt
        });
        return {
          reason,
          content: result.content,
          reasoningContent: result.reasoningContent,
          contextReceipt: personalContext.receipt,
          evidenceHash
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
      if (!eventTime?.occurredAt || !eventTime?.occurredOn) return { error: "发生时间格式不正确" };
      const requestId = clientRequestId || createId();
      return queueColdTask("chat", "", {
        message: parsed.value,
        occurredAt: eventTime.occurredAt,
        occurredOn: eventTime.occurredOn,
        eventTimeHash
      }, requestId);
    },
    async queueAnalysisIfCold({ reason = "manual", clientRequestId = "" } = {}) {
      const requestId = clientRequestId || createId();
      return queueColdTask("analysis", "", { reason }, requestId);
    }
  };
}
