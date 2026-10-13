import { boundedReferenceEvidence } from "../../.build/typescript/backend/shared/ai-context/index.mjs";
import {
  optionalPromptText,
  promptCatalogMetadata,
  promptRoleId,
  promptText,
  renderPrompt
} from "../shared/prompts/index.mjs";
import { safeIso } from "../shared/validation/index.mjs";
import { workingContextTimestamp } from "./task-context.mjs";

export const STRUCTURED_WORKING_CONTEXT_SCHEMA_VERSION = 1;
export const WORKING_CONTEXT_SERIALIZATION_ORDER = Object.freeze({
  POLICY_V1: "policy-v1",
  LEGACY_REPLAY_V1: "legacy-replay-v1"
});

const PAYLOAD_KEY_ORDER = Object.freeze({
  [WORKING_CONTEXT_SERIALIZATION_ORDER.POLICY_V1]: Object.freeze([
    "coreUserModel",
    "historicalUserSupplement",
    "sevenDayTrend",
    "relevantEpisodes",
    "applicableUserModel",
    "currentTask",
    "currentMaterial",
    "scene",
    "asOf",
    "evidencePackets",
    "unresolved",
    "schemaVersion"
  ]),
  [WORKING_CONTEXT_SERIALIZATION_ORDER.LEGACY_REPLAY_V1]: Object.freeze([
    "schemaVersion",
    "coreUserModel",
    "scene",
    "asOf",
    "currentTask",
    "currentMaterial",
    "applicableUserModel",
    "relevantEpisodes",
    "evidencePackets",
    "unresolved"
  ])
});

const ROLE_BY_SCENE = Object.freeze({
  thoughtAnswer: "answer",
  followUpAnswer: "answer",
  annotationShenji: "answer",
  perceptionExtraction: "perception"
});
const TASK_PROMPT_BY_SCENE = Object.freeze({
  thoughtAnswer: "thought.task.answer",
  followUpAnswer: "thought.task.followUp",
  annotationShenji: "annotation.task.default",
  perceptionExtraction: "perception.source.extract"
});
const list = value => Array.isArray(value) ? value : [];

function promptSafeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function orderPayloadKeys(payload, serializationOrder) {
  const preferred = PAYLOAD_KEY_ORDER[serializationOrder];
  if (!preferred) throw new Error(`Unknown working context serialization order: ${serializationOrder}`);
  const keys = [
    ...preferred.filter(key => Object.hasOwn(payload, key)),
    ...Object.keys(payload).filter(key => !preferred.includes(key))
  ];
  return Object.fromEntries(keys.map(key => [key, payload[key]]));
}

function materialPayload(item, temporalScope = "", includeCitationId = false) {
  return {
    id: String(item?.id || ""),
    ...(includeCitationId ? { citationId: `context:${String(item?.id || "")}` } : {}),
    channel: String(item?.channel || ""),
    resourceType: String(item?.sourceRef?.resourceType || ""),
    recordType: String(item?.recordType || item?.informationType || ""),
    origin: String(item?.origin || "user"),
    informationType: String(item?.informationType || "user_viewpoint"),
    ...(item?.selectionReason ? { selectionReason: item.selectionReason } : {}),
    occurredAt: String(item?.occurredAt || ""),
    ...(temporalScope ? { temporalScope } : {}),
    text: String(item?.text || ""),
    attachmentCount: list(item?.attachmentPaths).length
  };
}

export function promptRoleText(role) {
  const id = promptRoleId(role);
  return id ? optionalPromptText(id) : "";
}

export function answerRolePrompt(scene) {
  return ROLE_BY_SCENE[scene] === "answer" ? promptRoleText("answer") : "";
}

export function workingContextPromptContract(scene) {
  const taskPromptId = TASK_PROMPT_BY_SCENE[scene] || "";
  const roleId = promptRoleId(ROLE_BY_SCENE[scene]);
  const envelopeId = "orchestration.user.envelope";
  const catalog = promptCatalogMetadata();
  const structured = Boolean(
    roleId
    && taskPromptId
    && optionalPromptText(roleId)
    && optionalPromptText(taskPromptId)
    && optionalPromptText(envelopeId)
  );
  return {
    schemaVersion: STRUCTURED_WORKING_CONTEXT_SCHEMA_VERSION,
    mode: structured ? "structured-json" : "legacy",
    roleId: structured ? roleId : "",
    taskPromptId: structured ? taskPromptId : "",
    envelopeId: structured ? envelopeId : "",
    catalogVersion: catalog.version,
    catalogSha256: catalog.sha256
  };
}

export function compileWorkingContextPrompt({
  scene,
  task,
  currentMaterial,
  historicalMaterial,
  coreUserModel = null,
  historicalUserSupplement = null,
  recentTrend = null,
  referenceEvidence = [],
  serializationOrder = WORKING_CONTEXT_SERIALIZATION_ORDER.POLICY_V1,
  generatedAt = "",
  notice = "",
  taskDetails = null
}) {
  if (!ROLE_BY_SCENE[scene] || task?.kind !== scene) {
    throw new Error("Structured working context requires a matching scene");
  }
  const contract = workingContextPromptContract(scene);
  if (contract.mode === "legacy") {
    throw new Error(`Prompt catalog ${contract.catalogVersion} does not support structured working context`);
  }
  const sourceBoundaries = optionalPromptText("orchestration.context.boundaries");
  const temporalContract = optionalPromptText("orchestration.context.temporal");
  const answerCitationContract = ROLE_BY_SCENE[scene] === "answer"
    ? optionalPromptText("orchestration.answer.citations")
    : "";
  const sevenDayTrendContract = recentTrend || historicalUserSupplement
    ? optionalPromptText("orchestration.context.sevenDayTrend")
    : "";
  const includeCitationIds = Boolean(answerCitationContract);
  const asOf = typeof generatedAt === "string" && generatedAt === safeIso(generatedAt)
    ? generatedAt || null : null;
  const temporalScope = item => {
    if (!temporalContract) return "";
    const occurredAt = workingContextTimestamp(item?.occurredAt);
    if (!occurredAt || !asOf) return "unknown";
    return Date.parse(occurredAt) < Date.parse(asOf) ? "historical-record"
      : Date.parse(occurredAt) > Date.parse(asOf) ? "future-record" : "reference-time-record";
  };
  const history = list(historicalMaterial).map(item => materialPayload(item,
    temporalScope(item), includeCitationIds));
  const payload = {
    ...(coreUserModel && typeof coreUserModel === "object" ? {
      coreUserModel: {
        fingerprint: String(coreUserModel.fingerprint || ""),
        claims: list(coreUserModel.claims).map(item => ({
          domain: String(item?.domain || ""),
          epistemic: String(item?.epistemic || ""),
          statement: String(item?.statement || ""),
          scope: String(item?.scope || ""),
          evidence: list(item?.evidence).map(evidence => ({
            sourceId: String(evidence?.sourceId || ""),
            citationId: String(evidence?.citationId || ""),
            sourceVersion: Number(evidence?.sourceVersion) || 0,
            exactQuote: String(evidence?.exactQuote || "")
          }))
        })),
        answers: list(coreUserModel.answers).map(item => ({
          sourceId: String(item?.sourceId || ""),
          citationId: String(item?.citationId || ""),
          title: String(item?.title || ""),
          informationType: String(item?.informationType || ""),
          text: String(item?.text || ""),
          sourceVersion: Number(item?.sourceVersion) || 0
        })),
        unknowns: list(coreUserModel.unknowns).map(item => ({
          questionId: String(item?.questionId || ""),
          answerDisposition: String(item?.answerDisposition || "")
        }))
      }
    } : {}),
    ...(historicalUserSupplement && typeof historicalUserSupplement === "object"
      && !Array.isArray(historicalUserSupplement) ? {
        historicalUserSupplement: structuredClone(historicalUserSupplement)
      } : {}),
    ...(recentTrend && typeof recentTrend === "object" && !Array.isArray(recentTrend) ? {
      sevenDayTrend: structuredClone(recentTrend)
    } : {}),
    ...(referenceEvidence.length ? { referenceEvidence: boundedReferenceEvidence(list(referenceEvidence).map(source => ({
      citationId: source.citationId, text: source.text,
      origin: source.source?.origin || "user", informationType: source.source?.informationType || "user_original"
    }))) } : {}),
    relevantEpisodes: history.filter(item => (
      !["userClaim", "modelUnknown"].includes(item.resourceType)
    )),
    applicableUserModel: history.filter(item => item.resourceType === "userClaim"),
    currentTask: {
      kind: String(task?.kind || ""),
      text: String(task?.text || ""),
      targetId: String(task?.targetId || ""),
      subtargetId: String(task?.subtargetId || ""),
      ...(taskDetails && typeof taskDetails === "object" && !Array.isArray(taskDetails)
        ? { details: structuredClone(taskDetails) }
        : {})
    },
    currentMaterial: list(currentMaterial).map(item => materialPayload(item, "", includeCitationIds)),
    scene,
    ...(sourceBoundaries ? { asOf } : {}),
    evidencePackets: list(historicalMaterial).map(item => ({
      id: String(item?.id || ""),
      evidenceId: String(item?.evidenceId || ""),
      eventId: String(item?.eventId || ""),
      sourceKey: String(item?.sourceKey || ""),
      contentSha256: String(item?.contentSha256 || "")
    })),
    unresolved: [
      ...history.filter(item => item.resourceType === "modelUnknown"),
      ...(notice ? [{ kind: "retrieval", message: String(notice) }] : [])
    ],
    schemaVersion: STRUCTURED_WORKING_CONTEXT_SCHEMA_VERSION
  };
  return {
    prompt: renderPrompt(contract.envelopeId, {
      taskContract: [
        promptText(contract.taskPromptId),
        answerCitationContract,
        sourceBoundaries,
        temporalContract,
        sevenDayTrendContract
      ].filter(Boolean).join("\n\n"),
      payload: promptSafeJson(orderPayloadKeys(payload, serializationOrder))
    }),
    contract
  };
}
