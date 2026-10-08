import {
  contentTypeFor,
  createAiBudgetHttp,
  createAiCostHttp,
  createAiSettingsHttp,
  createAnnotationHttp,
  createAttachmentHttp,
  createKeepsakeHttp,
  createOnboardingHttp,
  createOnboardingV2Http,
  createSpeechHttp,
  createTaskHttp,
  createTrashHttp,
  createUserModelHttp,
  createVisionHttp
} from "../http/index.mjs";
import {
  originalKeepsakeMedia,
  publicKeepsake
} from "../modules/keepsakes/index.mjs";
import {
  createOnboardingService,
  createOnboardingV2Service
} from "../modules/onboarding/index.mjs";
import { createUserModelService } from "../modules/user-model/index.mjs";
import { isOwner } from "../modules/auth/index.mjs";
import { userModelEvidenceCurrent } from "./user-model.mjs";

export function createRuntimePlatformHttp({
  appConfig,
  httpLimits,
  clock,
  identifiers,
  observability,
  persistence,
  aiRuntime,
  contentRuntime,
  access
}) {
  const { now } = clock;
  const { createId, requestBinding } = identifiers;
  const { requestStorage, logEvent } = observability;
  const { storeRepository, updateStore } = persistence;
  const {
    aiBudgetService,
    llmSettingsService,
    readLlmSettings,
    aiCosts,
    runDeepSeek,
    currentBudgetAccountId,
    meteredProviderCall
  } = aiRuntime;
  const {
    annotationCommands,
    trashMutations,
    keepsakeRecords,
    contentAttachmentService,
    backgroundAi,
    trashCommands,
    imageAttachments,
    saveOriginalImages,
    saveKeepsakeImages,
    saveOriginalAudio,
    discardOriginalUploads,
    discardOriginalAudio,
    speechProvider,
    visionProvider,
    speechGate,
    ocrGate,
    documentParseGate,
    speechCache,
    keepsakeMediaWorkflows,
    segmentKeepsakeImage,
    understandKeepsakeImage,
    userModelExtractions
  } = contentRuntime;
  const {
    sendJson,
    bodyJson,
    localTestHttp,
    proxyToUpstream
  } = access;

  const taskHttp = createTaskHttp({ backgroundAi, bodyJson, sendJson });
  const speechHttp = createSpeechHttp({
    speech: speechProvider,
    gate: speechGate,
    auditCall: (details, invoke, summarize) => (
      meteredProviderCall(details, invoke, summarize)
    ),
    bodyJson,
    sendJson,
    readSettings: readLlmSettings,
    getContext: () => requestStorage.getStore(),
    cache: speechCache
  });
  const visionHttp = createVisionHttp({
    vision: visionProvider,
    ocrGate,
    documentGate: documentParseGate,
    auditCall: (details, invoke, summarize) => (
      meteredProviderCall(details, invoke, summarize)
    ),
    bodyJson,
    sendJson,
    uploadBodyMaxBytes: httpLimits.uploadBodyBytes
  });
  const aiSettingsHttp = createAiSettingsHttp({
    settings: llmSettingsService,
    canConfigureOpening: () => isOwner(requestStorage.getStore()?.user),
    speech: speechProvider,
    generate: runDeepSeek,
    bodyJson,
    sendJson
  });
  const aiCostHttp = createAiCostHttp({ costs: aiCosts, bodyJson, sendJson });
  const aiBudgetHttp = createAiBudgetHttp({
    budget: aiBudgetService,
    bodyJson,
    getActorId: () => currentBudgetAccountId()
  });
  const onboardingHttp = createOnboardingHttp({
    onboarding: createOnboardingService({
      repository: {
        update: mutate => updateStore(store => {
          store.onboarding = mutate(store.onboarding);
          return store.onboarding;
        })
      },
      now
    }),
    bodyJson,
    sendJson
  });
  const onboardingV2Http = createOnboardingV2Http({
    onboardingV2: createOnboardingV2Service({
      repository: storeRepository,
      now
    }),
    extractions: userModelExtractions,
    bodyJson
  });
  const userModelHttp = createUserModelHttp({
    userModel: createUserModelService({
      repository: storeRepository,
      isEvidenceCurrent: userModelEvidenceCurrent,
      createId,
      now
    }),
    permissions: contentRuntime.perception,
    bodyJson
  });
  const trashHttp = createTrashHttp({
    commands: trashCommands,
    bodyJson,
    sendJson,
    logEvent
  });
  const { sendMoved: sendTrashResult } = trashHttp;
  const keepsakeHttp = createKeepsakeHttp({
    segment: segmentKeepsakeImage,
    understand: understandKeepsakeImage,
    records: keepsakeRecords,
    remove: id => updateStore(store => (
      trashMutations.moveCollectionItemToTrash(
        store,
        "keepsakes",
        "keepsake",
        id
      )
    )),
    bodyJson,
    sendJson,
    requestBinding,
    sendTrashResult,
    present: publicKeepsake,
    getOriginal: async id => originalKeepsakeMedia(await keepsakeRecords.get(id)),
    media: keepsakeMediaWorkflows,
    mediaBodyMaxBytes: httpLimits.uploadBodyBytes
  });
  const attachmentHttp = createAttachmentHttp({
    attachments: imageAttachments,
    signDelivery: contentRuntime.signAttachmentDelivery,
    uploadOriginals: (req, images) => saveOriginalImages(images, {
      idempotencyKey: req.headers["idempotency-key"]
    }),
    uploadKeepsake: (req, input) => saveKeepsakeImages(input, {
      idempotencyKey: req.headers["idempotency-key"]
    }),
    discardUploads: discardOriginalUploads,
    uploadAudio: (req, input) => saveOriginalAudio(input, {
      idempotencyKey: req.headers["idempotency-key"]
    }),
    discardAudio: discardOriginalAudio,
    bodyJson,
    sendJson,
    uploadBodyMaxBytes: httpLimits.uploadBodyBytes,
    uploadImageMaxBytes: httpLimits.uploadImageBytes,
    contentType: contentTypeFor,
    onMissing: async (req, res, url) => {
      if (!localTestHttp.canProxyAttachment(requestStorage.getStore())) return false;
      await proxyToUpstream(req, res, url);
      return true;
    },
    debugServerUrl: appConfig.debug.serverUrl,
    debugRunId: appConfig.debug.runId
  });
  const annotationHttp = createAnnotationHttp({
    commands: annotationCommands,
    backgroundAi,
    prepareContentAttachments: contentAttachmentService.prepareOriginalContent,
    sendTaskCreation: taskHttp.sendCreation,
    bodyJson,
    sendJson,
    sendTrashResult
  });

  return {
    taskHttp,
    speechHttp,
    visionHttp,
    aiSettingsHttp,
    aiCostHttp,
    aiBudgetHttp,
    onboardingHttp,
    onboardingV2Http,
    userModelHttp,
    trashHttp,
    keepsakeHttp,
    attachmentHttp,
    annotationHttp,
    sendTrashResult
  };
}
