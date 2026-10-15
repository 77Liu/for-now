import {
  defaultOnboarding,
  defaultOnboardingV2
} from "../modules/onboarding/index.mjs";
import { emptyHistoricalUserSupplement } from "../modules/record-compressions/index.mjs";

export const STORE_VERSION = 18;
export const TRASH_RETENTION_DAYS = 30;
export const COMMERCIALIZATION_VERSION = 3;

export const commercialStageKeys = ["internal", "mvp", "growth", "influence", "market"];
export const commercialModelKeys = ["validation", "subscription", "delivery", "usagePack"];
export const commercialUsageProfileKeys = ["low", "medium", "high", "full"];

export const commercialStagePresets = {
  validation: [
    { participants: 5, rewardPerParticipantCny: 100, testDays: 14, tasksPerParticipant: 3, validSuggestionsPerParticipant: 2, interviewMinutesPerParticipant: 45, developmentHoursTotal: 12, aiCallsPerParticipant: 20, imageCallsPerParticipant: 2 },
    { participants: 20, rewardPerParticipantCny: 120, testDays: 21, tasksPerParticipant: 5, validSuggestionsPerParticipant: 2, interviewMinutesPerParticipant: 45, developmentHoursTotal: 60, aiCallsPerParticipant: 30, imageCallsPerParticipant: 3 },
    { participants: 100, rewardPerParticipantCny: 150, testDays: 30, tasksPerParticipant: 6, validSuggestionsPerParticipant: 2, interviewMinutesPerParticipant: 40, developmentHoursTotal: 240, aiCallsPerParticipant: 40, imageCallsPerParticipant: 4 },
    { participants: 300, rewardPerParticipantCny: 180, testDays: 30, tasksPerParticipant: 6, validSuggestionsPerParticipant: 2, interviewMinutesPerParticipant: 35, developmentHoursTotal: 600, aiCallsPerParticipant: 50, imageCallsPerParticipant: 5 },
    { participants: 1000, rewardPerParticipantCny: 200, testDays: 45, tasksPerParticipant: 8, validSuggestionsPerParticipant: 2, interviewMinutesPerParticipant: 30, developmentHoursTotal: 2000, aiCallsPerParticipant: 60, imageCallsPerParticipant: 6 }
  ],
  subscription: [
    { dailyActiveUsers: 5, monthlyActiveUsers: 20, payingUsers: 5, newPaidUsersPerMonth: 2, simulationMonths: 6, monthlyPriceCny: 39, paymentFeePct: 1, refundPct: 3, fixedMonthlyCostCny: 100, operationsHoursPerMonth: 6, developmentHoursPerMonth: 20, acquisitionCostPerNewUserCny: 30, monthlyChurnPct: 8 },
    { dailyActiveUsers: 100, monthlyActiveUsers: 400, payingUsers: 50, newPaidUsersPerMonth: 30, simulationMonths: 12, monthlyPriceCny: 49, paymentFeePct: 1, refundPct: 3, fixedMonthlyCostCny: 5000, operationsHoursPerMonth: 40, developmentHoursPerMonth: 120, acquisitionCostPerNewUserCny: 60, monthlyChurnPct: 7 },
    { dailyActiveUsers: 10000, monthlyActiveUsers: 40000, payingUsers: 4000, newPaidUsersPerMonth: 600, simulationMonths: 18, monthlyPriceCny: 49, paymentFeePct: 1, refundPct: 3, fixedMonthlyCostCny: 200000, operationsHoursPerMonth: 600, developmentHoursPerMonth: 1800, acquisitionCostPerNewUserCny: 100, monthlyChurnPct: 6 },
    { dailyActiveUsers: 25000, monthlyActiveUsers: 100000, payingUsers: 10000, newPaidUsersPerMonth: 1800, simulationMonths: 24, monthlyPriceCny: 59, paymentFeePct: 0.8, refundPct: 2.5, fixedMonthlyCostCny: 650000, operationsHoursPerMonth: 1800, developmentHoursPerMonth: 4800, acquisitionCostPerNewUserCny: 140, monthlyChurnPct: 5 },
    { dailyActiveUsers: 46000, monthlyActiveUsers: 184000, payingUsers: 18400, newPaidUsersPerMonth: 3000, simulationMonths: 24, monthlyPriceCny: 59, paymentFeePct: 0.8, refundPct: 2.5, fixedMonthlyCostCny: 1200000, operationsHoursPerMonth: 3200, developmentHoursPerMonth: 8000, acquisitionCostPerNewUserCny: 180, monthlyChurnPct: 5 }
  ],
  delivery: [
    { ordersPerMonth: 4, serviceFeePerOrderCny: 299, byokPct: 60, hostedPrepaidPerOrderCny: 100, maintenanceMarkupPct: 20, prepaidUtilizationPct: 70, deliveryHoursPerOrder: 2, supportHoursPerOrder: 0.5, developmentHoursPerMonth: 8, paymentFeePct: 1, refundPct: 3, acquisitionCostPerOrderCny: 20 },
    { ordersPerMonth: 30, serviceFeePerOrderCny: 399, byokPct: 65, hostedPrepaidPerOrderCny: 120, maintenanceMarkupPct: 20, prepaidUtilizationPct: 70, deliveryHoursPerOrder: 1.5, supportHoursPerOrder: 0.4, developmentHoursPerMonth: 80, paymentFeePct: 1, refundPct: 3, acquisitionCostPerOrderCny: 60 },
    { ordersPerMonth: 800, serviceFeePerOrderCny: 499, byokPct: 70, hostedPrepaidPerOrderCny: 150, maintenanceMarkupPct: 18, prepaidUtilizationPct: 75, deliveryHoursPerOrder: 0.35, supportHoursPerOrder: 0.15, developmentHoursPerMonth: 900, paymentFeePct: 0.8, refundPct: 2.5, acquisitionCostPerOrderCny: 100 },
    { ordersPerMonth: 5000, serviceFeePerOrderCny: 599, byokPct: 75, hostedPrepaidPerOrderCny: 180, maintenanceMarkupPct: 15, prepaidUtilizationPct: 80, deliveryHoursPerOrder: 0.18, supportHoursPerOrder: 0.08, developmentHoursPerMonth: 3000, paymentFeePct: 0.8, refundPct: 2, acquisitionCostPerOrderCny: 140 },
    { ordersPerMonth: 15000, serviceFeePerOrderCny: 699, byokPct: 80, hostedPrepaidPerOrderCny: 200, maintenanceMarkupPct: 12, prepaidUtilizationPct: 85, deliveryHoursPerOrder: 0.12, supportHoursPerOrder: 0.05, developmentHoursPerMonth: 6000, paymentFeePct: 0.6, refundPct: 2, acquisitionCostPerOrderCny: 180 }
  ],
  usagePack: [
    { buyersPerMonth: 10, packsPerBuyer: 1, pricePerPackCny: 29, includedAiCallsPerPack: 80, includedImageCallsPerPack: 10, utilizationPct: 70, supportHoursPerMonth: 2, paymentFeePct: 1, refundPct: 3, acquisitionCostPerBuyerCny: 10 },
    { buyersPerMonth: 80, packsPerBuyer: 1, pricePerPackCny: 35, includedAiCallsPerPack: 100, includedImageCallsPerPack: 12, utilizationPct: 72, supportHoursPerMonth: 16, paymentFeePct: 1, refundPct: 3, acquisitionCostPerBuyerCny: 35 },
    { buyersPerMonth: 4000, packsPerBuyer: 1.2, pricePerPackCny: 39, includedAiCallsPerPack: 120, includedImageCallsPerPack: 15, utilizationPct: 75, supportHoursPerMonth: 320, paymentFeePct: 0.8, refundPct: 2.5, acquisitionCostPerBuyerCny: 70 },
    { buyersPerMonth: 15000, packsPerBuyer: 1.25, pricePerPackCny: 45, includedAiCallsPerPack: 140, includedImageCallsPerPack: 18, utilizationPct: 78, supportHoursPerMonth: 900, paymentFeePct: 0.8, refundPct: 2, acquisitionCostPerBuyerCny: 100 },
    { buyersPerMonth: 36800, packsPerBuyer: 1.3, pricePerPackCny: 49, includedAiCallsPerPack: 160, includedImageCallsPerPack: 20, utilizationPct: 80, supportHoursPerMonth: 1800, paymentFeePct: 0.6, refundPct: 2, acquisitionCostPerBuyerCny: 130 }
  ]
};

export const defaultCommercialization = {
  version: COMMERCIALIZATION_VERSION,
  updatedAt: "",
  assumptions: {
    stageByModel: { validation: 0, subscription: 0, delivery: 0, usagePack: 0 },
    stagePresets: commercialStagePresets,
    validation: commercialStagePresets.validation[0],
    subscription: commercialStagePresets.subscription[0],
    delivery: commercialStagePresets.delivery[0],
    usagePack: commercialStagePresets.usagePack[0],
    usageProfiles: {
      low: { sharePct: 40, activeDaysPerMonth: 4, requestsPerActiveDay: 2, foregroundAiCallsPerActiveDay: 0.5, backgroundAiCallsPerActiveDay: 0.25, imageCallsPerMonth: 1 },
      medium: { sharePct: 35, activeDaysPerMonth: 10, requestsPerActiveDay: 3, foregroundAiCallsPerActiveDay: 1.5, backgroundAiCallsPerActiveDay: 0.6, imageCallsPerMonth: 3 },
      high: { sharePct: 20, activeDaysPerMonth: 20, requestsPerActiveDay: 6, foregroundAiCallsPerActiveDay: 6.5, backgroundAiCallsPerActiveDay: 2, imageCallsPerMonth: 8 },
      full: { sharePct: 5, activeDaysPerMonth: 30, requestsPerActiveDay: 10, foregroundAiCallsPerActiveDay: 10, backgroundAiCallsPerActiveDay: 5, imageCallsPerMonth: 20 }
    },
    common: {
      usdCny: 7.2,
      aiCostFloorPerCallCny: 0.03,
      segmentationCostPerImageCny: 0.01,
      laborHourlyCny: 80
    }
  }
};

export const STORE_COLLECTION_KEYS = [
  "checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "books",
  "keepsakes", "quotes", "experiments", "analyses", "recordCompressions", "customMetrics", "trash",
  "attachmentCleanup", "speechCache", "aiTasks", "notifications", "actions", "habits",
  "habitCheckins", "feedback", "validationLedger", "userClaims", "modelUnknowns",
  "evidenceSources", "evidencePermissions", "perceptionEvents"
];

export const emptyStore = {
  version: STORE_VERSION,
  checkins: [],
  dailyRecords: [],
  captures: [],
  journals: [],
  journalDraft: null,
  thoughts: [],
  chats: [],
  books: [],
  keepsakes: [],
  quotes: [],
  experiments: [],
  analyses: [],
  recordCompressions: [],
  customMetrics: [],
  trash: [],
  attachmentCleanup: [],
  speechCache: [],
  aiTasks: [],
  notifications: [],
  actions: [],
  habits: [],
  habitCheckins: [],
  feedback: [],
  validationLedger: [],
  userClaims: [],
  modelUnknowns: [],
  importanceScores: [],
  importanceJobs: [],
  evidenceSources: [],
  evidencePermissions: [],
  perceptionEvents: [],
  historicalUserSupplement: emptyHistoricalUserSupplement(),
  onboarding: defaultOnboarding,
  onboardingV2: defaultOnboardingV2,
  commercialization: defaultCommercialization
};

export const createEmptyStore = () => structuredClone(emptyStore);
