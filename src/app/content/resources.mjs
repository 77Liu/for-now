import { eventTimeFields } from "../../shared/time/index.mjs";
import { recordVersion } from "../../shared/validation/index.mjs";
import { createAnnotationService } from "../../modules/annotations/index.mjs";
import { createBookRecords } from "../../modules/books/index.mjs";
import { createCaptureRecords } from "../../modules/captures/index.mjs";
import { createChatRecords } from "../../modules/chats/index.mjs";
import { createCheckinRecords } from "../../modules/checkins/index.mjs";
import { createDailyRecordRecords } from "../../modules/health/index.mjs";
import { createJournalRecords } from "../../modules/journals/index.mjs";
import { createKeepsakeRecords } from "../../modules/keepsakes/index.mjs";
import { createQuoteRecords } from "../../modules/quotes/index.mjs";
import { createReviewRecords } from "../../modules/reviews/index.mjs";
import { createThoughtService } from "../../modules/thoughts/index.mjs";
import { createTrashService } from "../../modules/trash/index.mjs";
import { createAnnotationCommands } from "../annotation-resources.mjs";
import { createTrashMutations } from "../trash.mjs";

export function createContentFoundation({
  repository,
  trashRetentionDays,
  getAccountId,
  cancelTask,
  now,
  createId,
  hash
}) {
  const annotationService = createAnnotationService({ createId, now });
  const trashService = createTrashService({
    createId,
    now,
    hash,
    retentionDays: trashRetentionDays
  });
  const trashMutations = createTrashMutations({
    trash: trashService,
    annotations: annotationService,
    now,
    getAccountId,
    cancelTask
  });
  const annotationCommands = createAnnotationCommands({
    repository,
    annotations: annotationService,
    moveNestedItemToTrash: trashMutations.moveNestedItemToTrash
  });
  return {
    annotationService,
    annotationCommands,
    trashService,
    trashMutations
  };
}

const createCollectionRepository = (repository, collection) => ({
  read: async () => (await repository.read())[collection],
  update: mutate => repository.update(store => (
    mutate(store[collection], store.trash, store)
  )),
  executeIdempotent: (request, operation, options) => repository.executeIdempotent(
    request,
    store => operation(store[collection], store.trash, store),
    options
  )
});

const createJournalRepository = repository => ({
  read: async () => {
    const store = await repository.read();
    return {
      journals: store.journals,
      journalDraft: store.journalDraft,
      trash: store.trash
    };
  },
  update: mutate => repository.update(async store => {
    const value = {
      journals: store.journals,
      journalDraft: store.journalDraft,
      trash: store.trash
    };
    const result = await mutate(value);
    store.journals = value.journals;
    store.journalDraft = value.journalDraft;
    store.trash = value.trash;
    return result;
  }),
  executeIdempotent: (request, operation, options) => repository.executeIdempotent(
    request,
    async store => {
      const value = {
        journals: store.journals,
        journalDraft: store.journalDraft,
        trash: store.trash
      };
      const result = await operation(value);
      store.journals = value.journals;
      store.journalDraft = value.journalDraft;
      store.trash = value.trash;
      return result;
    },
    options
  )
});

const createReviewRepository = repository => ({
  read: async () => {
    const store = await repository.read();
    return {
      analyses: store.analyses,
      experiments: store.experiments,
      customMetrics: store.customMetrics,
      trash: store.trash
    };
  },
  update: mutate => repository.update(async store => {
    const value = {
      analyses: store.analyses,
      experiments: store.experiments,
      customMetrics: store.customMetrics
    };
    const result = await mutate(value, store.trash);
    store.analyses = value.analyses;
    store.experiments = value.experiments;
    store.customMetrics = value.customMetrics;
    return result;
  }),
  executeIdempotent: (request, operation, options) => repository.executeIdempotent(
    request,
    async store => {
      const value = {
        analyses: store.analyses,
        experiments: store.experiments,
        customMetrics: store.customMetrics
      };
      const result = await operation(value, store.trash);
      store.analyses = value.analyses;
      store.experiments = value.experiments;
      store.customMetrics = value.customMetrics;
      return result;
    },
    options
  )
});

export function createContentRecords({
  repository,
  sourceRepository = repository,
  foundation,
  contentAttachments,
  getCursorScope,
  now,
  createId
}) {
  const {
    annotationService,
    trashService
  } = foundation;
  const collectionRepository = collection => (
    createCollectionRepository(repository, collection)
  );
  const thoughtService = createThoughtService({
    repository: sourceRepository,
    createId,
    now,
    recordVersion,
    eventTimeFields,
    reanchorAnnotations: annotationService.reanchorAnnotations,
    getCursorScope,
    reconcileOriginalImages: (...args) => (
      contentAttachments.reconcileOriginalImagesInStore(...args)
    )
  });
  const captureRecords = createCaptureRecords({
    repository: createCollectionRepository(sourceRepository, "captures"),
    reanchorAnnotations: annotationService.reanchorAnnotations,
    reconcileOriginalImages: (...args) => (
      contentAttachments.reconcileOriginalImagesInStore(...args)
    ),
    reconcileAudioAttachment: (
      store,
      { captureId, previousAudio, previousTranscription, nextAudio }
    ) => {
      if (
        !previousAudio?.attachmentPath
        || previousAudio.attachmentPath === nextAudio?.attachmentPath
      ) return null;
      const entry = trashService.add(store.trash, "captureAudio", {
        id: captureId,
        audio: previousAudio,
        transcription: previousTranscription
      }, {
        kind: "captureAudio",
        parentCollection: "captures",
        parentId: captureId
      });
      return { trashId: entry.id };
    },
    now,
    createId
  });
  return {
    thoughtService,
    captureRecords,
    journalRecords: createJournalRecords({
      repository: createJournalRepository(sourceRepository),
      reanchorAnnotations: annotationService.reanchorAnnotations,
      now,
      createId
    }),
    checkinRecords: createCheckinRecords({
      repository: createCollectionRepository(sourceRepository, "checkins"),
      now,
      createId
    }),
    dailyRecordRecords: createDailyRecordRecords({
      repository: createCollectionRepository(sourceRepository, "dailyRecords"),
      now,
      createId
    }),
    keepsakeRecords: createKeepsakeRecords({
      repository: collectionRepository("keepsakes"),
      now,
      createId
    }),
    bookRecords: createBookRecords({
      repository: collectionRepository("books"),
      reanchorAnnotations: annotationService.reanchorAnnotations,
      now,
      createId
    }),
    quoteRecords: createQuoteRecords({
      repository: collectionRepository("quotes"),
      reanchorAnnotations: annotationService.reanchorAnnotations,
      now,
      createId
    }),
    chatRecords: createChatRecords({
      repository: collectionRepository("chats"),
      now,
      createId
    }),
    reviewRecords: createReviewRecords({
      repository: createReviewRepository(repository),
      now,
      createId
    })
  };
}
