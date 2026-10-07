import {
  normalizeOnboarding,
  normalizeOnboardingV2
} from "../modules/onboarding/index.mjs";
import {
  evidenceEventKey,
  evidenceFingerprint,
  normalizeEvidencePermission,
  normalizeEvidenceSource,
  normalizeModelUnknowns,
  normalizePerceptionEvent,
  normalizeUserClaims
} from "../modules/user-model/index.mjs";
import { normalizeKeepsake } from "../modules/keepsakes/index.mjs";
import { localDateKey, localDateTimeOn, strictDateKey } from "../shared/time/index.mjs";
import {
  nullableNumber,
  numberOrFallback as commercialNumber,
  recordVersion,
  safeIso,
  safeText
} from "../shared/validation/index.mjs";
import { normalizeSpeechCacheStore } from "./speech-cache.mjs";
import {
  COMMERCIALIZATION_VERSION,
  STORE_COLLECTION_KEYS,
  STORE_VERSION,
  TRASH_RETENTION_DAYS,
  commercialModelKeys,
  commercialStageKeys,
  commercialStagePresets,
  commercialUsageProfileKeys,
  defaultCommercialization,
  emptyStore
} from "./store-schema.mjs";

const clone = value => structuredClone(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const clamp5 = value => Math.min(5, Math.max(1, Number(value) || 3));
const round = value => value == null ? null : Math.round(value * 100) / 100;
const storageInvalid = message => Object.assign(new Error(message), {
  code: "STORAGE_READ_FAILED"
});
const strictCollection = (source, key, normalize, identity) => {
  if (!hasOwn(source, key)) return [];
  if (!Array.isArray(source[key])) throw storageInvalid(`Store ${key} must be an array`);
  const values = source[key].map(normalize);
  if (values.some(item => !item)) throw storageInvalid(`Store ${key} contains an invalid record`);
  const identities = values.map(identity);
  if (identities.some(value => !value) || new Set(identities).size !== identities.length) {
    throw storageInvalid(`Store ${key} contains duplicate identities`);
  }
  return values;
};
const WEIGHT_CLOTHING_MODEL = {
  none: { label: "不穿衣", mean: 0, lower: 0, upper: 0 },
  light: { label: "轻便衣物", mean: 0.5, lower: 0.1, upper: 0.9 },
  heavy: { label: "厚重衣物", mean: 1.5, lower: 0.5, upper: 2.5 }
};

const authorTypeFor = item => {
  if (["question", "idea", "record"].includes(item?.type)) return "user";
  if (item?.type === "answer"
    && !/^(?:deepseek|codex)/.test(String(item?.origin || ""))
    && !item?.modelDraft
    && !item?.reasoningContent) return "user";
  return item?.type === "answer" ? "ai" : "user";
};

function normalizeCommercialValidation(
  input = {},
  fallback = commercialStagePresets.validation[0],
  previousVersion = COMMERCIALIZATION_VERSION
) {
  return {
    participants: commercialNumber(input.participants, fallback.participants, 1, 1_000_000, true),
    rewardPerParticipantCny: commercialNumber(input.rewardPerParticipantCny ?? (previousVersion < 2 ? input.feePerParticipantCny : null), fallback.rewardPerParticipantCny, 0, 1_000_000),
    testDays: commercialNumber(input.testDays, fallback.testDays, 1, 3650, true),
    tasksPerParticipant: commercialNumber(input.tasksPerParticipant, fallback.tasksPerParticipant, 1, 10_000, true),
    validSuggestionsPerParticipant: commercialNumber(input.validSuggestionsPerParticipant, fallback.validSuggestionsPerParticipant, 1, 10_000, true),
    interviewMinutesPerParticipant: commercialNumber(input.interviewMinutesPerParticipant, fallback.interviewMinutesPerParticipant, 0, 10_000, true),
    developmentHoursTotal: commercialNumber(input.developmentHoursTotal, fallback.developmentHoursTotal, 0, 1_000_000),
    aiCallsPerParticipant: commercialNumber(input.aiCallsPerParticipant, fallback.aiCallsPerParticipant, 0, 100_000, true),
    imageCallsPerParticipant: commercialNumber(input.imageCallsPerParticipant, fallback.imageCallsPerParticipant, 0, 100_000, true)
  };
}

function normalizeCommercialSubscription(input = {}, fallback = commercialStagePresets.subscription[0]) {
  const payingUsers = commercialNumber(input.payingUsers, fallback.payingUsers, 0, 100_000_000, true);
  return {
    dailyActiveUsers: commercialNumber(input.dailyActiveUsers, fallback.dailyActiveUsers, 0, 100_000_000, true),
    monthlyActiveUsers: commercialNumber(input.monthlyActiveUsers, Math.max(fallback.monthlyActiveUsers, payingUsers), 0, 100_000_000, true),
    payingUsers,
    newPaidUsersPerMonth: commercialNumber(input.newPaidUsersPerMonth, fallback.newPaidUsersPerMonth, 0, 100_000_000, true),
    simulationMonths: commercialNumber(input.simulationMonths, fallback.simulationMonths, 1, 120, true),
    monthlyPriceCny: commercialNumber(input.monthlyPriceCny, fallback.monthlyPriceCny, 0, 1_000_000),
    paymentFeePct: commercialNumber(input.paymentFeePct, fallback.paymentFeePct, 0, 100),
    refundPct: commercialNumber(input.refundPct, fallback.refundPct, 0, 100),
    fixedMonthlyCostCny: commercialNumber(input.fixedMonthlyCostCny, fallback.fixedMonthlyCostCny, 0, 1_000_000_000),
    operationsHoursPerMonth: commercialNumber(input.operationsHoursPerMonth, fallback.operationsHoursPerMonth, 0, 1_000_000),
    developmentHoursPerMonth: commercialNumber(input.developmentHoursPerMonth, fallback.developmentHoursPerMonth, 0, 1_000_000),
    acquisitionCostPerNewUserCny: commercialNumber(input.acquisitionCostPerNewUserCny, fallback.acquisitionCostPerNewUserCny, 0, 10_000_000),
    monthlyChurnPct: commercialNumber(input.monthlyChurnPct, fallback.monthlyChurnPct, 0, 100)
  };
}

function normalizeCommercialDelivery(
  input = {},
  fallback = commercialStagePresets.delivery[0],
  previousVersion = COMMERCIALIZATION_VERSION
) {
  return {
    ordersPerMonth: commercialNumber(input.ordersPerMonth, fallback.ordersPerMonth, 0, 100_000_000, true),
    serviceFeePerOrderCny: commercialNumber(input.serviceFeePerOrderCny ?? (previousVersion < 3 ? input.pricePerOrderCny : null), fallback.serviceFeePerOrderCny, 0, 10_000_000),
    byokPct: commercialNumber(input.byokPct, fallback.byokPct, 0, 100),
    hostedPrepaidPerOrderCny: commercialNumber(input.hostedPrepaidPerOrderCny, fallback.hostedPrepaidPerOrderCny, 0, 10_000_000),
    maintenanceMarkupPct: commercialNumber(input.maintenanceMarkupPct, fallback.maintenanceMarkupPct, 0, 1000),
    prepaidUtilizationPct: commercialNumber(input.prepaidUtilizationPct, fallback.prepaidUtilizationPct, 0, 100),
    deliveryHoursPerOrder: commercialNumber(input.deliveryHoursPerOrder, fallback.deliveryHoursPerOrder, 0, 100_000),
    supportHoursPerOrder: commercialNumber(input.supportHoursPerOrder, fallback.supportHoursPerOrder, 0, 100_000),
    developmentHoursPerMonth: commercialNumber(input.developmentHoursPerMonth, fallback.developmentHoursPerMonth, 0, 1_000_000),
    paymentFeePct: commercialNumber(input.paymentFeePct, fallback.paymentFeePct, 0, 100),
    refundPct: commercialNumber(input.refundPct, fallback.refundPct, 0, 100),
    acquisitionCostPerOrderCny: commercialNumber(input.acquisitionCostPerOrderCny, fallback.acquisitionCostPerOrderCny, 0, 10_000_000)
  };
}

function normalizeCommercialUsagePack(input = {}, fallback = commercialStagePresets.usagePack[0]) {
  return {
    buyersPerMonth: commercialNumber(input.buyersPerMonth, fallback.buyersPerMonth, 0, 100_000_000, true),
    packsPerBuyer: commercialNumber(input.packsPerBuyer, fallback.packsPerBuyer, 0, 100_000),
    pricePerPackCny: commercialNumber(input.pricePerPackCny, fallback.pricePerPackCny, 0, 10_000_000),
    includedAiCallsPerPack: commercialNumber(input.includedAiCallsPerPack, fallback.includedAiCallsPerPack, 0, 100_000, true),
    includedImageCallsPerPack: commercialNumber(input.includedImageCallsPerPack, fallback.includedImageCallsPerPack, 0, 100_000, true),
    utilizationPct: commercialNumber(input.utilizationPct, fallback.utilizationPct, 0, 100),
    supportHoursPerMonth: commercialNumber(input.supportHoursPerMonth, fallback.supportHoursPerMonth, 0, 1_000_000),
    paymentFeePct: commercialNumber(input.paymentFeePct, fallback.paymentFeePct, 0, 100),
    refundPct: commercialNumber(input.refundPct, fallback.refundPct, 0, 100),
    acquisitionCostPerBuyerCny: commercialNumber(input.acquisitionCostPerBuyerCny, fallback.acquisitionCostPerBuyerCny, 0, 10_000_000)
  };
}

export function normalizeCommercialization(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const assumptions = source.assumptions && typeof source.assumptions === "object" ? source.assumptions : {};
  const previousVersion = Number(source.version || 1);
  const legacySubscription = assumptions.subscription || {};
  const legacyDelivery = assumptions.delivery || {};
  const hasLegacySubscriptionUsage = previousVersion < 3
    && ["activeDaysPerMonth", "aiCallsPerActiveDay", "imageCallsPerUserMonth"].some(key => hasOwn(legacySubscription, key));
  const hasLegacyDeliveryUsage = previousVersion < 3
    && ["aiCallsPerOrder", "imageCallsPerOrder"].some(key => hasOwn(legacyDelivery, key));
  const normalizers = {
    validation: (input, fallback) => normalizeCommercialValidation(input, fallback, previousVersion),
    subscription: normalizeCommercialSubscription,
    delivery: (input, fallback) => normalizeCommercialDelivery(input, fallback, previousVersion),
    usagePack: normalizeCommercialUsagePack
  };
  const stageByModel = Object.fromEntries(commercialModelKeys.map(model => [
    model,
    commercialNumber(assumptions.stageByModel?.[model], 0, 0, commercialStageKeys.length - 1, true)
  ]));
  const stagePresets = Object.fromEntries(commercialModelKeys.map(model => [
    model,
    commercialStagePresets[model].map((fallback, index) => {
      const stored = assumptions.stagePresets?.[model]?.[index];
      const selectedAlias = index === stageByModel[model] ? assumptions[model] : null;
      return normalizers[model](selectedAlias || stored || {}, fallback);
    })
  ]));
  const usageProfiles = Object.fromEntries(commercialUsageProfileKeys.map(key => {
    const fallback = defaultCommercialization.assumptions.usageProfiles[key];
    const input = assumptions.usageProfiles?.[key] || (hasLegacySubscriptionUsage ? {
      ...fallback,
      activeDaysPerMonth: legacySubscription.activeDaysPerMonth,
      foregroundAiCallsPerActiveDay: legacySubscription.aiCallsPerActiveDay,
      backgroundAiCallsPerActiveDay: 0,
      imageCallsPerMonth: legacySubscription.imageCallsPerUserMonth
    } : {});
    return [key, {
      sharePct: commercialNumber(input.sharePct, fallback.sharePct, 0, 100),
      activeDaysPerMonth: commercialNumber(input.activeDaysPerMonth, fallback.activeDaysPerMonth, 0, 31, true),
      requestsPerActiveDay: commercialNumber(input.requestsPerActiveDay, fallback.requestsPerActiveDay, 0, 100_000),
      foregroundAiCallsPerActiveDay: commercialNumber(input.foregroundAiCallsPerActiveDay, fallback.foregroundAiCallsPerActiveDay, 0, 100_000),
      backgroundAiCallsPerActiveDay: commercialNumber(input.backgroundAiCallsPerActiveDay, fallback.backgroundAiCallsPerActiveDay, 0, 100_000),
      imageCallsPerMonth: commercialNumber(input.imageCallsPerMonth, fallback.imageCallsPerMonth, 0, 100_000)
    }];
  }));
  const common = assumptions.common || {};
  const legacyV2 = source.legacyV2 && typeof source.legacyV2 === "object"
    ? clone(source.legacyV2)
    : (hasLegacySubscriptionUsage || hasLegacyDeliveryUsage ? {
      migratedFromVersion: previousVersion,
      subscription: hasLegacySubscriptionUsage ? {
        activeDaysPerMonth: commercialNumber(legacySubscription.activeDaysPerMonth, 0, 0, 31, true),
        aiCallsPerActiveDay: commercialNumber(legacySubscription.aiCallsPerActiveDay, 0, 0, 100_000),
        imageCallsPerUserMonth: commercialNumber(legacySubscription.imageCallsPerUserMonth, 0, 0, 100_000)
      } : null,
      delivery: hasLegacyDeliveryUsage ? {
        aiCallsPerOrder: commercialNumber(legacyDelivery.aiCallsPerOrder, 0, 0, 100_000),
        imageCallsPerOrder: commercialNumber(legacyDelivery.imageCallsPerOrder, 0, 0, 100_000)
      } : null
    } : null);
  return {
    version: COMMERCIALIZATION_VERSION,
    updatedAt: safeIso(source.updatedAt),
    assumptions: {
      stageByModel,
      stagePresets,
      ...Object.fromEntries(commercialModelKeys.map(model => [model, stagePresets[model][stageByModel[model]]])),
      usageProfiles,
      common: {
        usdCny: commercialNumber(common.usdCny, defaultCommercialization.assumptions.common.usdCny, 0.01, 1000),
        aiCostFloorPerCallCny: commercialNumber(common.aiCostFloorPerCallCny, defaultCommercialization.assumptions.common.aiCostFloorPerCallCny, 0, 100_000),
        segmentationCostPerImageCny: commercialNumber(common.segmentationCostPerImageCny, defaultCommercialization.assumptions.common.segmentationCostPerImageCny, 0, 100_000),
        laborHourlyCny: commercialNumber(common.laborHourlyCny, defaultCommercialization.assumptions.common.laborHourlyCny, 0, 1_000_000)
      }
    },
    ...(legacyV2 ? { legacyV2 } : {})
  };
}

function normalizeCaptureTranscription(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    ...value,
    rawText: safeText(value.rawText, 120_000),
    polishedText: safeText(value.polishedText, 120_000),
    condensedText: safeText(value.condensedText, 120_000),
    errorCode: safeText(value.errorCode, 120),
    condenseErrorCode: safeText(value.condenseErrorCode, 120)
  };
}

export function createStoreNormalizer({
  now = () => new Date().toISOString(),
  today = () => localDateKey(),
  currentTime = () => Date.now()
} = {}) {
  if (![now, today, currentTime].every(value => typeof value === "function")) {
    throw new TypeError("Store normalizer clocks must be functions");
  }

  const normalizedOccurredOn = (item, previousVersion) => {
    const createdUtcDate = item.createdAt?.slice(0, 10);
    const createdLocalDate = item.createdAt ? localDateKey(item.createdAt) : "";
    const current = item.occurredOn || createdLocalDate || today();
    if (previousVersion < 4
      && current === createdUtcDate
      && createdLocalDate
      && createdLocalDate !== createdUtcDate) return createdLocalDate;
    return current;
  };

  const normalizedEventTime = (item, previousVersion) => {
    const legacyDate = normalizedOccurredOn(item, previousVersion);
    const parsed = new Date(item.occurredAt || "");
    const occurredAt = Number.isNaN(parsed.getTime())
      ? localDateTimeOn(legacyDate, item.createdAt || new Date(currentTime()))
      : parsed.toISOString();
    return { occurredAt: occurredAt || now(), occurredOn: localDateKey(occurredAt) || legacyDate };
  };

  return function normalizeStore(value = {}) {
    const source = clone(value);
    const previousVersion = Number(source.version || 1);
    const hasOnboardingV2 = Object.hasOwn(source || {}, "onboardingV2");
    const store = { ...clone(emptyStore), ...source, version: STORE_VERSION };
    for (const key of STORE_COLLECTION_KEYS) if (!Array.isArray(store[key])) store[key] = [];
    store.checkins = store.checkins.map(item => ({ factors: [], custom: {}, notes: {}, ...item, ...normalizedEventTime(item, previousVersion), sleep: item.sleep || 3, stress: previousVersion < 3 ? 6 - clamp5(item.stress) : clamp5(item.stress), version: recordVersion(item.version) }));
    store.dailyRecords = store.dailyRecords.map(item => {
      const normalized = { source: "manual", attachmentPaths: [], ...item, ...normalizedEventTime(item, previousVersion), version: recordVersion(item.version) };
      if (normalized.type === "weight") {
        const model = WEIGHT_CLOTHING_MODEL[normalized.clothing] || WEIGHT_CLOTHING_MODEL.none;
        const measuredWeight = nullableNumber(normalized.measuredWeight, 20, 400);
        return { ...normalized, clothing: WEIGHT_CLOTHING_MODEL[normalized.clothing] ? normalized.clothing : "none", measuredWeight, adjustmentMean: model.mean, adjustedWeight: measuredWeight == null ? null : round(measuredWeight - model.mean), lower95: measuredWeight == null ? null : round(measuredWeight - model.upper), upper95: measuredWeight == null ? null : round(measuredWeight - model.lower) };
      }
      return normalized;
    }).map(item => ["sleep", "heartRate", "weight", "exercise"].includes(item.type) ? item : { ...item, validationState: "invalid" });
    store.captures = store.captures.map(item => ({
      tags: [],
      attachmentPaths: [],
      imageUnderstandings: [],
      annotations: [],
      annotationDrift: [],
      ...item,
      ...(Object.hasOwn(item, "transcription")
        ? { transcription: normalizeCaptureTranscription(item.transcription) }
        : {}),
      ...normalizedEventTime(item, previousVersion),
      version: recordVersion(item.version)
    }));
    store.journals = store.journals.map(item => ({ tags: [], reflections: [], annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion), version: recordVersion(item.version) }));
    if (store.journalDraft && typeof store.journalDraft === "object") {
      const journalId = safeText(store.journalDraft.journalId, 100);
      store.journalDraft = {
        journalId: store.journals.some(item => item.id === journalId) ? journalId : "",
        title: safeText(store.journalDraft.title, 120),
        content: safeText(store.journalDraft.content, 50000),
        updatedAt: safeIso(store.journalDraft.updatedAt) || now()
      };
    } else store.journalDraft = null;
    delete store.bookDraft;
    store.thoughts = store.thoughts.map(item => {
      const normalized = { disposition: "pending", remarks: [], tags: [], attachmentPaths: [], imageUnderstandings: [], followUps: [], annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion), type: ["question", "idea", "answer", "record"].includes(item.type) ? item.type : "question", authorType: ["user", "ai", "system"].includes(item.authorType) ? item.authorType : authorTypeFor(item), version: recordVersion(item.version) };
      if (normalized.discovery && typeof normalized.discovery === "object" && !Array.isArray(normalized.discovery)) {
        normalized.discovery = { ...normalized.discovery, version: recordVersion(normalized.discovery.version) };
      }
      normalized.remarks = normalized.remarks.map(remark => ({ ...remark, version: recordVersion(remark.version) }));
      normalized.followUps = normalized.followUps.map(followUp => ({ ...followUp, version: recordVersion(followUp.version) }));
      return normalized;
    });
    store.chats = store.chats.map(item => ({ annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion), version: recordVersion(item.version) }));
    store.books = store.books.map(item => {
      const readingStartedOn = strictDateKey(item.readingStartedOn) || "";
      const normalizedFinishedOn = strictDateKey(item.readingFinishedOn) || "";
      const book = {
        notes: [],
        annotations: [],
        annotationDrift: [],
        ...item,
        readingStartedOn,
        readingFinishedOn: readingStartedOn && normalizedFinishedOn >= readingStartedOn ? normalizedFinishedOn : "",
        version: recordVersion(item.version)
      };
      book.notes = book.notes.map(note => ({
        ...note,
        type: note.type === "thought" ? "thought" : "record",
        favorite: ["none", "star", "sprout"].includes(note.favorite) ? note.favorite : "none",
        ...normalizedEventTime({ createdAt: note.createdAt || book.createdAt, ...note }, previousVersion)
      }));
      return book;
    });
    store.keepsakes = store.keepsakes.map(item => normalizeKeepsake(item, normalizedEventTime(item, previousVersion)));
    store.quotes = store.quotes.map(item => ({ tags: [], annotations: [], annotationDrift: [], ...item, ...normalizedEventTime(item, previousVersion), version: recordVersion(item.version) }));
    store.analyses = store.analyses.map(item => ({ annotations: [], annotationDrift: [], ...item, version: recordVersion(item.version) }));
    for (const collection of ["captures", "journals", "thoughts", "chats", "books", "quotes", "analyses"]) {
      for (const item of store[collection]) {
        item.annotations = (item.annotations || []).map(annotation => ({
          attachmentPaths: [],
          imageUnderstandings: [],
          ...annotation,
          version: recordVersion(annotation.version)
        }));
        item.annotationDrift = (item.annotationDrift || []).map(annotation => ({
          attachmentPaths: [],
          imageUnderstandings: [],
          ...annotation,
          version: recordVersion(annotation.version)
        }));
      }
    }
    store.experiments = store.experiments.map(item => ({ ...item, version: recordVersion(item.version) }));
    store.actions = store.actions.filter(item => item && item.id).map(item => ({
      statusHistory: [],
      ...item,
      version: recordVersion(item.version),
      statusHistory: Array.isArray(item.statusHistory) ? item.statusHistory : []
    }));
    store.habits = store.habits.filter(item => item && item.id).map(item => ({
      statusHistory: [],
      adjustmentHistory: [],
      ...item,
      version: recordVersion(item.version),
      statusHistory: Array.isArray(item.statusHistory) ? item.statusHistory : [],
      adjustmentHistory: Array.isArray(item.adjustmentHistory) ? item.adjustmentHistory : []
    }));
    store.habitCheckins = store.habitCheckins.filter(item => item && item.id).map(item => ({
      ...item,
      version: recordVersion(item.version)
    }));
    store.feedback = store.feedback.filter(item => item && item.id).map(item => ({
      statusHistory: [],
      ...item,
      version: recordVersion(item.version),
      statusHistory: Array.isArray(item.statusHistory) ? item.statusHistory : []
    }));
    store.validationLedger = store.validationLedger.filter(item => item && item.id).map(item => ({
      compensationRecords: [],
      rewardRecords: [],
      participationRecords: [],
      statusHistory: [],
      ...item,
      version: recordVersion(item.version),
      compensationRecords: Array.isArray(item.compensationRecords) ? item.compensationRecords : [],
      rewardRecords: Array.isArray(item.rewardRecords) ? item.rewardRecords : [],
      participationRecords: Array.isArray(item.participationRecords) ? item.participationRecords : [],
      statusHistory: Array.isArray(item.statusHistory) ? item.statusHistory : []
    }));
    store.trash = store.trash.filter(item => item && item.id && item.payload && item.type).map(item => {
      const { category: legacyCategory, ...keepsakePayloadWithoutCategory } = item.type === "keepsake" ? item.payload : {};
      void legacyCategory;
      const normalized = {
        ...item,
        ...(item.type === "keepsake" ? { payload: keepsakePayloadWithoutCategory } : {}),
        deletedAt: safeIso(item.deletedAt) || now(),
        purgeAfter: safeIso(item.purgeAfter) || new Date(currentTime() + TRASH_RETENTION_DAYS * 86400000).toISOString()
      };
      if (normalized.type === "capture" && Object.hasOwn(normalized.payload, "transcription")) {
        normalized.payload.transcription = normalizeCaptureTranscription(normalized.payload.transcription);
      }
      return normalized;
    });
    normalizeSpeechCacheStore(store);
    store.attachmentCleanup = store.attachmentCleanup.filter(item => item && /^\/attachments\/[\w.-]+$/.test(item.path)).map(item => ({
      path: item.path,
      createdAt: safeIso(item.createdAt) || now(),
      lastAttemptAt: safeIso(item.lastAttemptAt),
      attempts: Math.max(0, Math.round(Number(item.attempts) || 0)),
      errorCode: safeText(item.errorCode, 100)
    }));
    store.aiTasks = store.aiTasks.filter(item => item && item.id && item.kind).map(item => ({
      ...item,
      ...(previousVersion < STORE_VERSION
        && item.kind === "annotationShenji"
        && Number(item.inputVersion) > 0
        && !Number(item.subtargetVersion)
        ? { legacyUnversionedSubtarget: true }
        : {})
    }));
    store.notifications = store.notifications.filter(item => item && item.id);
    store.userClaims = normalizeUserClaims(store.userClaims);
    store.modelUnknowns = normalizeModelUnknowns(store.modelUnknowns);
    store.evidenceSources = strictCollection(
      source,
      "evidenceSources",
      normalizeEvidenceSource,
      item => `${item.id}\u0000${evidenceFingerprint(item)}`
    );
    if (new Set(store.evidenceSources.map(item => item.id)).size !== store.evidenceSources.length) {
      throw storageInvalid("Store evidenceSources contains duplicate ids");
    }
    if (new Set(store.evidenceSources.map(evidenceFingerprint)).size !== store.evidenceSources.length) {
      throw storageInvalid("Store evidenceSources contains duplicate evidence");
    }
    store.evidencePermissions = strictCollection(
      source,
      "evidencePermissions",
      normalizeEvidencePermission,
      item => item.sourceKey
    );
    store.perceptionEvents = strictCollection(
      source,
      "perceptionEvents",
      normalizePerceptionEvent,
      item => `${item.id}\u0000${evidenceEventKey(item)}`
    );
    if (new Set(store.perceptionEvents.map(item => item.id)).size !== store.perceptionEvents.length) {
      throw storageInvalid("Store perceptionEvents contains duplicate ids");
    }
    if (new Set(store.perceptionEvents.map(evidenceEventKey)).size !== store.perceptionEvents.length) {
      throw storageInvalid("Store perceptionEvents contains duplicate event inputs");
    }
    store.onboarding = normalizeOnboarding(store.onboarding);
    if (previousVersion < 14 && !Object.keys(store.onboarding.answers).length) {
      const hasRecords = ["checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books", "keepsakes", "quotes"].some(key => store[key].length);
      if (hasRecords) store.onboarding.status = "completed";
      else if (store.onboarding.status === "dismissed") store.onboarding.status = "pending";
    }
    store.onboardingV2 = normalizeOnboardingV2(
      hasOnboardingV2 ? store.onboardingV2 : undefined,
      store.onboarding
    );
    store.commercialization = normalizeCommercialization(store.commercialization);
    return store;
  };
}

export const normalizeStore = createStoreNormalizer();
