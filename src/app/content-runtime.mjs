import crypto from "node:crypto";
import { createContentAttachmentService } from "../modules/content-attachments/index.mjs";
import { keepsakePayload } from "../modules/keepsakes/index.mjs";
import { createContentBackground, enqueueContentImageUnderstanding } from "./content/background.mjs";
import { createContentFoundation, createContentRecords } from "./content/resources.mjs";
import { createContentWorkflows } from "./content/workflows.mjs";
import { createMediaRuntime } from "./media-runtime.mjs";
import { createTrashCommands } from "./trash.mjs";

const requiredFunction = (value, name) => {
  if (typeof value !== "function") throw new TypeError(`Content runtime ${name} is required`);
};

export function createContentRuntime({
  repository,
  mediaOptions = {},
  trashRetentionDays,
  getAccountId,
  getCursorScope = getAccountId,
  backgroundContextKey,
  workflowContextKey,
  dispatchBackground,
  runDeepSeek,
  now = () => new Date().toISOString(),
  today,
  currentTime = () => Date.now(),
  createId = () => crypto.randomUUID(),
  hash = value => crypto.createHash("sha256").update(String(value)).digest("hex"),
  logEvent,
  debugServerUrl = "",
  debugRunId = "",
  debugFetch = fetch,
  mediaFactory = createMediaRuntime
} = {}) {
  if (!repository?.read || !repository?.update || !repository?.executeIdempotent) {
    throw new TypeError("Content runtime repository is required");
  }
  for (const [value, name] of [
    [getAccountId, "getAccountId"],
    [getCursorScope, "getCursorScope"],
    [backgroundContextKey, "backgroundContextKey"],
    [workflowContextKey, "workflowContextKey"],
    [dispatchBackground, "dispatchBackground"],
    [runDeepSeek, "runDeepSeek"],
    [today, "today"],
    [createId, "createId"],
    [hash, "hash"],
    [logEvent, "logEvent"],
    [debugFetch, "debugFetch"],
    [mediaFactory, "mediaFactory"]
  ]) requiredFunction(value, name);

  let backgroundAi;
  let mediaRuntime;
  const foundation = createContentFoundation({
    repository,
    trashRetentionDays,
    getAccountId,
    cancelTask: taskId => backgroundAi?.cancel(taskId) || false,
    now,
    createId,
    hash
  });
  const contentAttachmentService = createContentAttachmentService({
    repository,
    trash: foundation.trashService,
    attachmentInventory: (...args) => {
      if (!mediaRuntime) throw new Error("Content media runtime is not initialized");
      return mediaRuntime.listAttachmentInventory(...args);
    },
    getAccountId,
    cancelTask: taskId => backgroundAi?.cancel(taskId) || false,
    requestImageUnderstanding: work => (
      enqueueContentImageUnderstanding(backgroundAi, work)
    ),
    now,
    createId
  });
  const records = createContentRecords({
    repository,
    foundation,
    contentAttachments: contentAttachmentService,
    getCursorScope,
    now,
    createId
  });
  mediaRuntime = mediaFactory({
    ...mediaOptions,
    repository,
    books: records.bookRecords,
    quotes: records.quoteRecords,
    parseKeepsake: keepsakePayload,
    moveCollectionItemToTrash: foundation.trashMutations.moveCollectionItemToTrash,
    moveNestedItemToTrash: foundation.trashMutations.moveNestedItemToTrash,
    runDeepSeek,
    now,
    today,
    createId,
    hash,
    logEvent,
    debugServerUrl,
    debugRunId,
    debugFetch
  });
  const background = createContentBackground({
    repository,
    annotationService: foundation.annotationService,
    contentAttachments: contentAttachmentService,
    mediaRuntime,
    backgroundContextKey,
    dispatchBackground,
    runDeepSeek,
    now,
    createId,
    hash,
    logEvent,
    debugServerUrl,
    debugRunId,
    debugFetch
  });
  backgroundAi = background.backgroundAi;
  const workflows = createContentWorkflows({
    repository,
    records,
    backgroundAi,
    trashMutations: foundation.trashMutations,
    runDeepSeek,
    workflowContextKey,
    now,
    today,
    currentTime,
    hash,
    logEvent
  });
  const trashCommands = createTrashCommands({
    repository,
    trash: foundation.trashService,
    mutations: foundation.trashMutations,
    cleanup: mediaRuntime.attachmentCleanup
  });

  return {
    ...foundation,
    ...records,
    ...mediaRuntime,
    ...background,
    ...workflows,
    contentAttachmentService,
    trashCommands
  };
}
