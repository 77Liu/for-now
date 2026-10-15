const V1_REGISTRATIONS = [
  ["startup", "startup"],
  ["sync", "sync"],
  ["personal-context", "personalContext"],
  ["importance", "importance"],
  ["owner-ai-budget", "aiBudget"],
  ["onboarding-v2", "onboardingV2"],
  ["user-model", "userModel"],
  ["thoughts", "thoughts"],
  ["checkins", "checkins"],
  ["health", "health"],
  ["discovery", "discovery"],
  ["exports", "exports"],
  ["actions", "actions"],
  ["feedback", "feedback"],
  ["captures-journals", "capturesJournals"],
  ["library", "library"],
  ["reviews-chat", "reviewsChat"],
  ["content-attachments", "contentAttachments"]
];

export const apiV1RegistrationIds = Object.freeze(V1_REGISTRATIONS.map(([id]) => id));

export function registerApiV1(apiV1, handlers) {
  if (typeof apiV1?.register !== "function") {
    throw new TypeError("API v1 registry requires apiV1.register()");
  }
  for (const [id, key] of V1_REGISTRATIONS) {
    const handler = handlers?.[key];
    if (typeof handler !== "function") {
      throw new TypeError(`API v1 registry requires ${key} handler`);
    }
    apiV1.register(id, handler);
  }
  return apiV1;
}
