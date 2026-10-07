import {
  optionalPromptText,
  promptCatalogMetadata,
  promptRoleId,
  promptText,
  renderPrompt
} from "../shared/prompts/index.mjs";

export const STRUCTURED_WORKING_CONTEXT_SCHEMA_VERSION = 1;

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

function materialPayload(item) {
  return {
    id: String(item?.id || ""),
    channel: String(item?.channel || ""),
    resourceType: String(item?.sourceRef?.resourceType || ""),
    recordType: String(item?.recordType || item?.informationType || ""),
    origin: String(item?.origin || "user"),
    informationType: String(item?.informationType || "user_viewpoint"),
    occurredAt: String(item?.occurredAt || ""),
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
  const history = list(historicalMaterial).map(materialPayload);
  const payload = {
    schemaVersion: STRUCTURED_WORKING_CONTEXT_SCHEMA_VERSION,
    scene,
    currentTask: {
      kind: String(task?.kind || ""),
      text: String(task?.text || ""),
      targetId: String(task?.targetId || ""),
      subtargetId: String(task?.subtargetId || ""),
      ...(taskDetails && typeof taskDetails === "object" && !Array.isArray(taskDetails)
        ? { details: structuredClone(taskDetails) }
        : {})
    },
    currentMaterial: list(currentMaterial).map(materialPayload),
    applicableUserModel: history.filter(item => item.resourceType === "userClaim"),
    relevantEpisodes: history.filter(item => (
      !["userClaim", "modelUnknown"].includes(item.resourceType)
    )),
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
    ]
  };
  return {
    prompt: renderPrompt(contract.envelopeId, {
      taskContract: promptText(contract.taskPromptId),
      payload: promptSafeJson(payload)
    }),
    contract
  };
}
