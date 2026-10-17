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
}>;

const USER_EXPLICIT = ["user_explicit"] as const;
const USER_OR_AUTO = ["user_explicit", "user_action_auto"] as const;

const liveUserScene = (): SceneContract => ({
  allowedTriggers: USER_EXPLICIT,
  defaultTrigger: "user_explicit",
  resultAudience: "user",
  reasoningVisibility: "user_viewable",
  persistenceMode: "live_only"
});

const durableUserScene = (
  allowedTriggers: readonly AiTriggerType[] = USER_EXPLICIT
): SceneContract => ({
  allowedTriggers,
  defaultTrigger: "user_explicit",
  resultAudience: "user",
  reasoningVisibility: "user_viewable",
  persistenceMode: "business_result"
});

const internalScene = (): SceneContract => ({
  allowedTriggers: ["system_internal"],
  defaultTrigger: "system_internal",
  resultAudience: "internal",
  reasoningVisibility: "privileged_only",
  persistenceMode: "audit_only"
});

const SCENES: Readonly<Record<string, SceneContract>> = Object.freeze({
  thoughtPrompt: liveUserScene(),
  thoughtDraft: liveUserScene(),
  thoughtAnswer: durableUserScene(USER_OR_AUTO),
  followUpAnswer: durableUserScene(),
  chat: durableUserScene(),
  diaryLead: liveUserScene(),
  diaryStructure: liveUserScene(),
  diaryTopic: liveUserScene(),
  diaryReflection: durableUserScene(),
  annotationShenji: durableUserScene(),
  analysis: durableUserScene(["user_explicit", "scheduled"]),
  bookRecognition: liveUserScene(),
  healthRecognition: liveUserScene(),
  contentImageUnderstanding: durableUserScene(USER_OR_AUTO),
  capturePolish: durableUserScene(USER_OR_AUTO),
  onboardingClaimExtraction: internalScene(),
  perceptionExtraction: internalScene(),
  recordCompression: internalScene(),
  importanceScoring: internalScene(),
  speechSynthesis: liveUserScene(),
  speechPreview: liveUserScene(),
  speechRecognition: liveUserScene(),
  visionOcr: internalScene(),
  documentParsing: liveUserScene(),
  keepsakeSegmentation: durableUserScene(USER_OR_AUTO)
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
