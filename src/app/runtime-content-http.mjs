import { createImportanceHttp } from "../../.build/typescript/backend/shared/ai-context/index.mjs";
import {
  createActionsHttp,
  createCaptureJournalHttp,
  createCheckinHttp,
  createDiscoveryHttp,
  createExportHttp,
  createFeedbackHttp,
  createHealthRecordHttp,
  createImageRecognitionHttp,
  createLibraryHttp,
  createThoughtHttp
} from "../http/index.mjs";
import { isOwner } from "../modules/auth/index.mjs";
import { createAccountExport } from "../modules/exports/index.mjs";
import { eventTimeFields } from "../shared/time/index.mjs";
import { recordVersion } from "../shared/validation/index.mjs";
import { storeForUser } from "./public-state.mjs";

export function createRuntimeContentHttp({
  clock,
  identifiers,
  observability,
  persistence,
  contentRuntime,
  domainServices,
  publicStateFromStore,
  access,
  platformHttp
}) {
  const { now } = clock;
  const { createId, requestBinding } = identifiers;
  const { requestStorage } = observability;
  const { readStore, updateStore } = persistence;
  const {
    trashService,
    trashMutations,
    trashCommands,
    thoughtService,
    captureRecords,
    journalRecords,
    checkinRecords,
    dailyRecordRecords,
    contentAttachmentService,
    backgroundAi,
    requestCaptureTranscription,
    thoughtWorkflows,
    captureJournalWorkflows,
    parseImageRequest,
    listAttachmentInventory,
    prepareCaptureAudio,
    libraryWorkflows,
    updateSourceStore = updateStore
  } = contentRuntime;
  const {
    moveCollectionItemToTrash,
    moveNestedItemToTrash
  } = trashMutations;
  const { bodyJson, sendJson, respondModel } = access;
  const {
    aiSettingsHttp,
    taskHttp,
    sendTrashResult
  } = platformHttp;

  const thoughtHttp = createThoughtHttp({
    service: thoughtService,
    workflows: thoughtWorkflows,
    removeBlock: id => trashCommands.removeThoughtBlock(id),
    removeNested: input => trashCommands.removeThoughtNested(input),
    backgroundAi,
    sendTaskCreation: taskHttp.sendCreation,
    eventTimeFields,
    bodyJson,
    sendJson,
    sendTrashResult,
    respondModel,
    createId,
    prepareContentAttachments: contentAttachmentService.prepareOriginalContent,
    automaticAnswer: aiSettingsHttp.automaticAnswer
  });
  const checkinHttp = createCheckinHttp({
    records: checkinRecords,
    remove: (id, expectedVersion = null) => updateStore(store => {
      const record = store.checkins.find(item => item.id === id);
      if (record && expectedVersion != null
        && recordVersion(record.version) !== expectedVersion) {
        return {
          versionConflict: true,
          currentVersion: recordVersion(record.version)
        };
      }
      return moveCollectionItemToTrash(store, "checkins", "checkin", id);
    }),
    bodyJson,
    sendJson,
    sendTrashResult
  });
  const healthRecordHttp = createHealthRecordHttp({
    records: dailyRecordRecords,
    remove: (id, expectedVersion = null) => updateStore(store => {
      const record = store.dailyRecords.find(item => item.id === id);
      if (record && expectedVersion != null
        && recordVersion(record.version) !== expectedVersion) {
        return {
          versionConflict: true,
          currentVersion: recordVersion(record.version)
        };
      }
      return moveCollectionItemToTrash(store, "dailyRecords", "dailyRecord", id);
    }),
    bodyJson,
    sendJson,
    sendTrashResult
  });
  const discoveryHttp = createDiscoveryHttp({
    discovery: domainServices.discoveryService,
    bodyJson
  });
  const exportHttp = createExportHttp({
    createExport: createAccountExport,
    snapshot: async () => ({
      accountId: requestStorage.getStore()?.user?.id || "local",
      snapshotAt: now(),
      store: storeForUser(
        await readStore(),
        requestStorage.getStore()?.user,
        isOwner
      )
    }),
    attachmentInventory: listAttachmentInventory
  });

  const removeActionResource = (type, id, expectedVersion) => updateStore(store => {
    const config = {
      action: { collection: "actions", trashType: "action" },
      habit: { collection: "habits", trashType: "habit" },
      habitCheckin: { collection: "habitCheckins", trashType: "habitCheckin" }
    }[type];
    if (!config) {
      return { error: "删除资源类型无效", code: "INVALID_RESOURCE_TYPE" };
    }
    const record = store[config.collection].find(item => item.id === id);
    if (!record) {
      const existing = trashService.find(store.trash, config.trashType, id);
      return existing
        ? { value: { trashId: existing.id }, duplicate: true }
        : { missing: true };
    }
    const currentVersion = recordVersion(record.version);
    if (currentVersion !== expectedVersion) {
      return { versionConflict: true, currentVersion };
    }
    if (type === "habit") {
      for (const checkin of store.habitCheckins.filter(item => item.habitId === id)) {
        const dependent = moveCollectionItemToTrash(
          store,
          "habitCheckins",
          "habitCheckin",
          checkin.id
        );
        dependent.location.parentId = id;
        dependent.location.parentCollection = "habits";
      }
    }
    const entry = moveCollectionItemToTrash(
      store,
      config.collection,
      config.trashType,
      id
    );
    return { value: { trashId: entry.id } };
  });
  const actionsHttp = createActionsHttp({
    actions: domainServices.actionsService,
    remove: removeActionResource,
    bodyJson
  });
  const feedbackHttp = createFeedbackHttp({
    feedback: domainServices.feedbackService,
    bodyJson
  });
  const removeVersionedCollection = (
    collection,
    type,
    id,
    expectedVersion = null
  ) => updateSourceStore(store => {
    const record = store[collection]?.find(item => item.id === id);
    if (record && expectedVersion != null) {
      const currentVersion = recordVersion(record.version);
      if (Number(expectedVersion) !== currentVersion) {
        return { versionConflict: true, currentVersion };
      }
    }
    return moveCollectionItemToTrash(store, collection, type, id);
  });
  const removeJournalReflection = (
    journalId,
    reflectionId,
    expectedVersion = null
  ) => updateSourceStore(store => {
    const journal = store.journals.find(item => item.id === journalId);
    const reflection = journal?.reflections?.find(item => item.id === reflectionId);
    if (reflection && expectedVersion != null) {
      const currentVersion = recordVersion(reflection.version);
      if (Number(expectedVersion) !== currentVersion) {
        return { versionConflict: true, currentVersion };
      }
    }
    return moveNestedItemToTrash(store, {
      parentCollection: "journals",
      parentId: journalId,
      field: "reflections",
      type: "journalReflection",
      id: reflectionId,
      annotationTargetKeys: [`reflection:${reflectionId}`]
    });
  });
  const captureJournalHttp = createCaptureJournalHttp({
    captures: captureRecords,
    journals: journalRecords,
    workflows: captureJournalWorkflows,
    prepareContentAttachments: contentAttachmentService.prepareOriginalContent,
    prepareCaptureAudio,
    requestCaptureTranscription,
    removeCapture: (id, expectedVersion = null) => (
      removeVersionedCollection("captures", "capture", id, expectedVersion)
    ),
    removeJournal: (id, expectedVersion = null) => (
      removeVersionedCollection("journals", "journal", id, expectedVersion)
    ),
    removeReflection: removeJournalReflection,
    sendTrashResult,
    sendTaskCreation: taskHttp.sendCreation,
    bodyJson,
    sendJson,
    respondModel
  });
  const libraryHttp = createLibraryHttp({
    library: libraryWorkflows,
    bodyJson,
    sendJson,
    sendTrashResult
  });
  const imageRecognitionHttp = createImageRecognitionHttp({
    parseImage: parseImageRequest,
    parseBook: input => libraryWorkflows.parseBook(input),
    bodyJson,
    sendJson,
    requestBinding
  });

  return {
    importanceHttp: createImportanceHttp(contentRuntime.importanceService, bodyJson),
    thoughtHttp,
    checkinHttp,
    healthRecordHttp,
    discoveryHttp,
    exportHttp,
    actionsHttp,
    feedbackHttp,
    captureJournalHttp,
    libraryHttp,
    imageRecognitionHttp,
    removeVersionedCollection
  };
}
