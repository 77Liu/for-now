import { publicCapture } from "../modules/captures/index.mjs";
import { publicKeepsake } from "../modules/keepsakes/index.mjs";
import { notificationUnread } from "../modules/notifications/index.mjs";
import { publicAiTask } from "../modules/tasks/index.mjs";
import { safeText } from "../shared/validation/index.mjs";
import { deriveStateInsights, deriveThoughtClusters } from "./derived-statistics.mjs";
import { publicSpeechAssets } from "./speech-cache.mjs";

export function withoutOwnerMetadata(value) {
  if (Array.isArray(value)) return value.map(withoutOwnerMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "tokenBudget")
      .map(([key, item]) => [key, withoutOwnerMetadata(item)])
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
