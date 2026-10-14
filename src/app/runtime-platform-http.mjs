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
import { prepareUserModelExtraction, userModelEvidenceCurrent } from "./user-model.mjs";

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
  const { createId, createBusinessId = createId, requestBinding } = identifiers;
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
      now,
      onCompleted(store, onboarding) {
        const prepared = prepareUserModelExtraction(store);
        if (prepared.empty) return { ready: true };
        if (!prepared.value) {
          throw Object.assign(new Error("原文暂不能整理，请检查内容长度后重试"), {
            statusCode: 422, code: "CLAIM_EXTRACTION_SOURCE_INVALID"
          });
        }
        const created = backgroundAi.createInStore(store, {
          kind: "onboardingClaimExtraction",
          resourceType: "onboardingV2",
          targetId: "onboarding-v2",
          inputVersion: onboarding.session.revision,
          clientRequestId: `onboarding-complete:${onboarding.session.revision}`
        });
        if (!created.task) {
          throw Object.assign(new Error("整理任务未创建，请重试提交"), {
            statusCode: 409, code: "CLAIM_EXTRACTION_ENQUEUE_FAILED"
          });
        }
        return created;
      },
      async afterCompleted(extraction) {
        if (extraction?.task?.status === "queued") backgroundAi.schedule(extraction.task.id);
        await backgroundAi.releaseWaiting();
      }
    }),
    extractions: userModelExtractions,
    bodyJson
  });
  const userModelHttp = createUserModelHttp({
    userModel: createUserModelService({
      repository: storeRepository,
      isEvidenceCurrent: userModelEvidenceCurrent,
      createId: createBusinessId,
      now
    }),
    permissions: contentRuntime.perception,
    canReadModelDetails: () => isOwner(requestStorage.getStore()?.user),
    onPermissionsChanged: async () => {
      try {
        await backgroundAi?.releaseWaiting?.();
      } catch (error) {
        await logEvent("system", "ai_task.waiting_release_failed", {
          level: "error",
          message: error?.message || String(error)
        });
      }
    },
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
