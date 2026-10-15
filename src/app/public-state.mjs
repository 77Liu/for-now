import { publicCapture } from "../modules/captures/index.mjs";
import { publicKeepsake } from "../modules/keepsakes/index.mjs";
import { notificationUnread } from "../modules/notifications/index.mjs";
import { publicAiTask } from "../modules/tasks/index.mjs";
import { safeText } from "../shared/validation/index.mjs";
import { deriveStateInsights, deriveThoughtClusters } from "./derived-statistics.mjs";
import { publicSpeechAssets } from "./speech-cache.mjs";

export function withoutOwnerMetadata(value, field = "") {
  if (Array.isArray(value)) {
    return value
      .map(item => withoutOwnerMetadata(item, field))
      .filter(item => item !== null);
  }
  if (!value || typeof value !== "object") return value;
  if (["userClaim", "modelUnknown"].includes(value.resourceType)
    || /^user-claim-/.test(String(value.id || ""))) {
    return null;
  }
  if (field === "userModel") {
    return {
      readiness: withoutOwnerMetadata(value.readiness),
      claims: [],
      unknowns: []
    };
  }
  if (Array.isArray(value.providedReferences)) value = withoutReferenceOwnerMetadata(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["tokenBudget", "userClaims", "modelUnknowns"].includes(key))
      .map(([key, item]) => {
        if (key === "sourceIds" && Array.isArray(item)) {
          return [key, item.filter(id => (
            !/^(?:userClaim|modelUnknown):/.test(String(id))
          ))];
        }
        return [key, withoutOwnerMetadata(item, key)];
      })
  );
}

export function storeForUser(store, user, isOwner) {
  const { commercialization: _commercialization, ...visible } = store;
  return isOwner(user) ? visible : withoutOwnerMetadata(visible);
}

export function createPublicStateProjection({
  getUser,
  isOwner,
  speechProvider,
  visionProvider,
  hash,
  now,
  today
} = {}) {
  if (typeof getUser !== "function"
      || typeof isOwner !== "function"
      || !speechProvider || typeof speechProvider !== "object"
      || !visionProvider || typeof visionProvider !== "object"
      || typeof hash !== "function"
      || typeof now !== "function"
      || typeof today !== "function") {
    throw new TypeError(
      "Public state projection requires user, owner, provider, hash and clock dependencies"
    );
  }

  return function publicStateFromStore(store, user = getUser()) {
    const {
      trash,
      attachmentCleanup: _attachmentCleanup,
      speechCache: _speechCache,
      importanceScores: _importanceScores,
      importanceJobs: _importanceJobs,
      evidenceSources: _evidenceSources,
      evidencePermissions: _evidencePermissions,
      perceptionEvents: _perceptionEvents,
      ...visible
    } = storeForUser(store, user, isOwner);
    const ownerId = safeText(user?.id, 100) || "local";
    const state = {
      ...visible,
      captures: visible.captures.map(publicCapture),
      keepsakes: visible.keepsakes.map(publicKeepsake),
      aiTasks: store.aiTasks.filter(task => task.internal !== true).slice(0, 100).map(publicAiTask),
      notificationUnread: notificationUnread(store.notifications),
      clusters: deriveThoughtClusters(store),
      insights: deriveStateInsights(store, { currentDate: today() }),
      trashCount: trash.length,
      speech: {
        configured: speechProvider.configured,
        defaultVoice: speechProvider.defaultVoice,
        voices: speechProvider.voices,
        supportedAsrMimeTypes: speechProvider.supportedAsrMimeTypes,
        assets: publicSpeechAssets(store, {
          ownerHash: hash(ownerId),
          currentTime: now(),
          hash
        })
      },
      vision: { configured: visionProvider.configured }
    };
    return isOwner(user) ? state : withoutOwnerMetadata(state);
  };
}

/**
 * 对真实 HTTP/事件流结果裁剪新增参考目录的模型来源细节，保留发送总数。
 * 只治理本次新增参考字段，不改变既有业务 DTO 或鉴权结果。
 * @since unreleased
 */
export function withoutReferenceOwnerMetadata(value) {
  if (Array.isArray(value)) return value.map(withoutReferenceOwnerMetadata);
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || typeof value.toJSON === "function") return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, withoutReferenceOwnerMetadata(item)
  ]));
  if (Array.isArray(value.providedReferences)) {
    result.providedReferenceCount = value.contextReceipt?.referenceRequest?.providedCount
      ?? value.providedReferenceCount ?? value.providedReferences.length;
    result.providedReferences = value.providedReferences.filter(item => (
      !["onboardingV2", "userClaim", "modelUnknown"].includes(item?.resourceType)
    )).map(withoutReferenceOwnerMetadata);
  }
  return result;
}
