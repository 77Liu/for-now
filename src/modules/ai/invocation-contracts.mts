/**
 * Defines the server-owned product contract for every AI provider attempt.
 * Established: 2026-10-18
 * Status: active
 * Boundary: callers may select an allowed trigger, but cannot elevate audience, visibility, or persistence.
 */

export type AiTriggerType =
  | "user_explicit"
  | "user_action_auto"
  | "scheduled"
  | "system_internal";

export type AiResultAudience = "user" | "internal";
export type AiReasoningVisibility = "user_viewable" | "privileged_only";
export type AiPersistenceMode = "business_result" | "live_only" | "audit_only";

export type AiInvocationContract = Readonly<{
  triggerType: AiTriggerType;
  resultAudience: AiResultAudience;
  reasoningVisibility: AiReasoningVisibility;
  persistenceMode: AiPersistenceMode;
  contractSchemaVersion: 1;
}>;

type SceneContract = Readonly<{
  allowedTriggers: readonly AiTriggerType[];
  defaultTrigger: AiTriggerType;
  resultAudience: AiResultAudience;
  reasoningVisibility: AiReasoningVisibility;
  persistenceMode: AiPersistenceMode;
  persistenceOwner: string | null;
  dtoOwner: string | null;
  uiOwner: string | null;
  reasoningTextPolicy: string | null;
}>;

const USER_EXPLICIT = ["user_explicit"] as const;
const USER_OR_AUTO = ["user_explicit", "user_action_auto"] as const;

const liveUserScene = (owner: string, policy: string): SceneContract => ({
  allowedTriggers: USER_EXPLICIT,
  defaultTrigger: "user_explicit",
  resultAudience: "user",
  reasoningVisibility: "user_viewable",
  persistenceMode: "live_only",
  persistenceOwner: null,
  dtoOwner: `${owner}.live`,
  uiOwner: owner,
  reasoningTextPolicy: policy
});

const durableUserScene = (
  owner: string,
  policy: string,
  allowedTriggers: readonly AiTriggerType[] = USER_EXPLICIT
): SceneContract => ({
  allowedTriggers,
  defaultTrigger: "user_explicit",
  resultAudience: "user",
  reasoningVisibility: "user_viewable",
  persistenceMode: "business_result",
  persistenceOwner: owner,
  dtoOwner: `${owner}.detail`,
  uiOwner: owner,
  reasoningTextPolicy: policy
});

const internalScene = (): SceneContract => ({
  allowedTriggers: ["system_internal"],
  defaultTrigger: "system_internal",
  resultAudience: "internal",
  reasoningVisibility: "privileged_only",
  persistenceMode: "audit_only",
  persistenceOwner: null,
  dtoOwner: null,
  uiOwner: null,
  reasoningTextPolicy: null
});

const SCENES: Readonly<Record<string, SceneContract>> = Object.freeze({
  thoughtPrompt: liveUserScene("thoughts", "thoughts.content"),
  thoughtDraft: liveUserScene("thoughts", "thoughts.content"),
  thoughtAnswer: durableUserScene("thoughts", "thoughts.content", USER_OR_AUTO),
  followUpAnswer: durableUserScene("thoughts", "thoughts.content"),
  chat: durableUserScene("chats", "chats.message"),
  diaryLead: liveUserScene("capture-journal", "journals.content"),
  diaryStructure: liveUserScene("capture-journal", "journals.content"),
  diaryTopic: liveUserScene("capture-journal", "journals.content"),
  diaryReflection: durableUserScene("journals", "journals.content"),
  annotationShenji: durableUserScene("annotations", "annotations.message"),
  analysis: durableUserScene("reviews", "reviews.content", ["user_explicit", "scheduled"]),
  bookRecognition: liveUserScene("library", "books.recognition"),
  healthRecognition: liveUserScene("health", "health.recognition"),
  contentImageUnderstanding: durableUserScene("content-attachments", "content-attachments.description", USER_OR_AUTO),
  capturePolish: durableUserScene("captures", "captures.transcription", USER_OR_AUTO),
  onboardingClaimExtraction: internalScene(),
  perceptionExtraction: internalScene(),
  recordCompression: internalScene(),
  importanceScoring: internalScene(),
  speechSynthesis: liveUserScene("speech", "speech.text"),
  speechPreview: liveUserScene("speech", "speech.text"),
  speechRecognition: liveUserScene("speech", "speech.transcript"),
  visionOcr: internalScene(),
  documentParsing: liveUserScene("keepsakes", "keepsakes.document"),
  keepsakeSegmentation: durableUserScene("keepsakes", "keepsakes.document", USER_OR_AUTO),
  lite: liveUserScene("account-settings", "settings.connection-test"),
  mid: liveUserScene("account-settings", "settings.connection-test"),
  high: liveUserScene("account-settings", "settings.connection-test"),
  ultra: liveUserScene("account-settings", "settings.connection-test")
});

export const LLM_SCENARIOS = Object.freeze([
  "thoughtPrompt",
  "thoughtDraft",
  "thoughtAnswer",
  "followUpAnswer",
  "chat",
  "diaryLead",
  "diaryStructure",
  "diaryTopic",
  "diaryReflection",
  "annotationShenji",
  "analysis",
  "bookRecognition",
  "healthRecognition",
  "contentImageUnderstanding",
  "capturePolish",
  "onboardingClaimExtraction",
  "perceptionExtraction",
  "recordCompression",
  "importanceScoring"
] as const);

const safeDefault = (): AiInvocationContract => Object.freeze({
  triggerType: "system_internal",
  resultAudience: "internal",
  reasoningVisibility: "privileged_only",
  persistenceMode: "audit_only",
  contractSchemaVersion: 1
});

/**
 * Resolves immutable audit metadata from a server-owned scene.
 * Unknown scenes fail closed; an invalid trigger for a known scene is rejected before provider I/O.
 * @since unreleased
 */
export function resolveInvocationContract(
  scene: unknown,
  requestedTrigger?: unknown
): AiInvocationContract {
  const contract = typeof scene === "string" ? SCENES[scene] : undefined;
  if (!contract) return safeDefault();
  const triggerType = requestedTrigger === undefined || requestedTrigger === null || requestedTrigger === ""
    ? contract.defaultTrigger
    : requestedTrigger;
  if (!contract.allowedTriggers.includes(triggerType as AiTriggerType)) {
    throw Object.assign(new Error(`AI invocation trigger is invalid for scene "${String(scene)}"`), {
      code: "AI_INVOCATION_CONTRACT_INVALID"
    });
  }
  return Object.freeze({
    triggerType: triggerType as AiTriggerType,
    resultAudience: contract.resultAudience,
    reasoningVisibility: contract.reasoningVisibility,
    persistenceMode: contract.persistenceMode,
    contractSchemaVersion: 1
  });
}

/**
 * Returns all registered scenes for startup and regression validation.
 * @since unreleased
 */
export function registeredInvocationScenes(): readonly string[] {
  return Object.freeze(Object.keys(SCENES));
}

/** Returns the scene's product owners and policy without allowing caller overrides. @since unreleased */
export function invocationSceneContract(scene: string): SceneContract {
  const contract = SCENES[scene] || internalScene();
  return Object.freeze({
    ...contract,
    allowedTriggers: Object.freeze([...contract.allowedTriggers])
  });
}
