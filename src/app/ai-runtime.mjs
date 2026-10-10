import nodeCrypto from "node:crypto";
import { promises as nodeFs } from "node:fs";
import nodePath from "node:path";
import {
  AI_BUDGET_POLICY,
  createAiAudit,
  createAiBudgetService,
  createAiCostService,
  createAiGenerator,
  createAiUsageService,
  createLlmSettingsService,
  defaultLlmSettings,
  normalizeAiUsage,
  normalizeLlmSettings,
  resolveOfficialProviderPricing,
  usageEntryFromAudit
} from "../modules/ai/index.mjs";
import { createDeepSeekTransport } from "../infrastructure/ai-providers/index.mjs";
import { createRateGate } from "../shared/concurrency/index.mjs";
import { RECORD_COMPRESSION_TASK_KIND } from "../modules/record-compressions/index.mjs";
import {
  createAccountDocumentRepository,
  createAiBudgetRepository
} from "../shared/persistence/index.mjs";
import {
  appendPrivateJsonLine,
  errorMetadata,
  pruneLogs
} from "../shared/observability/index.mjs";
import { safeText } from "../shared/validation/index.mjs";
import {
  createAiBudgetRuntime,
  deepSeekBudgetStages,
  estimateDeepSeekPeakCostCny
} from "./ai-budget-runtime.mjs";

const DEFAULT_BILLING_GAP = "运行时计量单位或合同单价尚未完成映射";

export async function createAiRuntime({
  dataRoot,
  postgresRuntime = null,
  storagePaths,
  requestStorage,
  readStoredJson,
  writeJsonAtomic,
  auditChanges = null,
  logEvent,
  deepSeekApiUrl,
  aiQps,
  aiConcurrency,
  userDailyCallLimit,
  userDailyCostLimitCny,
  recordCompressionPerCallBudgetCny = 0,
  cnyPerUsd,
  auditTextLimit,
  auditRetentionDays,
  budgetPolicy = AI_BUDGET_POLICY,
  now = () => new Date().toISOString(),
  dependencies = {}
}) {
  if (typeof storagePaths !== "function") throw new TypeError("AI runtime storagePaths is required");
  if (typeof requestStorage?.getStore !== "function") throw new TypeError("AI runtime requestStorage is required");
  if (typeof logEvent !== "function") throw new TypeError("AI runtime logEvent is required");

  const {
    fs: fileSystem = nodeFs,
    path: pathApi = nodePath,
    crypto: cryptoApi = nodeCrypto,
    appendPrivateJsonLine: appendPrivateJsonLineImpl = appendPrivateJsonLine,
    createAccountDocumentRepository: createAccountDocumentRepositoryImpl = createAccountDocumentRepository,
    createAiAudit: createAiAuditImpl = createAiAudit,
    createAiBudgetRepository: createAiBudgetRepositoryImpl = createAiBudgetRepository,
    createAiBudgetRuntime: createAiBudgetRuntimeImpl = createAiBudgetRuntime,
    createAiBudgetService: createAiBudgetServiceImpl = createAiBudgetService,
    createAiCostService: createAiCostServiceImpl = createAiCostService,
    createAiGenerator: createAiGeneratorImpl = createAiGenerator,
    createAiUsageService: createAiUsageServiceImpl = createAiUsageService,
    createDeepSeekTransport: createDeepSeekTransportImpl = createDeepSeekTransport,
    createLlmSettingsService: createLlmSettingsServiceImpl = createLlmSettingsService,
    createRateGate: createRateGateImpl = createRateGate,
    pruneLogs: pruneLogsImpl = pruneLogs
  } = dependencies;
  const createId = () => cryptoApi.randomUUID();

  const aiGate = createRateGateImpl(aiQps, aiConcurrency);
  const recordCompressionGate = createRateGateImpl(aiQps, 1);
  const aiBudgetRepository = createAiBudgetRepositoryImpl({
    runtime: postgresRuntime,
    dataRoot
  });
  const aiBudgetService = createAiBudgetServiceImpl({
    repository: aiBudgetRepository,
    policy: budgetPolicy,
    now,
    createId
  });
  const aiBudgetRuntime = createAiBudgetRuntimeImpl({
    budget: aiBudgetService,
    onRecoveryError: (error, details) => logEvent("system", "ai.budget_recovery_failed", {
      level: "error",
      ...details,
      error: errorMetadata(error)
    })
  });
  const aiBudgetRecovery = await aiBudgetRuntime.recover();
  if (aiBudgetRecovery.scanned || aiBudgetRecovery.failures.length) {
    await logEvent("system", "ai.budget_recovery_completed", {
      level: aiBudgetRecovery.failures.length ? "error" : "info",
      scanned: aiBudgetRecovery.scanned,
      released: aiBudgetRecovery.released.length,
      settled: aiBudgetRecovery.settled.length,
      failed: aiBudgetRecovery.failures.length
    });
  }

  const settingsRepository = createAccountDocumentRepositoryImpl({
    runtime: postgresRuntime,
    name: "settings",
    getFile: () => storagePaths().llmSettingsFile,
    readDocument: readStoredJson,
    writeDocument: writeJsonAtomic,
    normalize: normalizeLlmSettings,
    emptyDocument: defaultLlmSettings,
    onCommit: auditChanges
  });
  const llmSettingsService = createLlmSettingsServiceImpl({
    repository: settingsRepository
  });
  const {
    read: readLlmSettings,
    write: writeLlmSettings,
    ensure: ensureLlmSettings
  } = llmSettingsService;

  const usageRepository = createAccountDocumentRepositoryImpl({
    runtime: postgresRuntime,
    name: "usage",
    getFile: () => storagePaths().aiUsageFile,
    readDocument: readStoredJson,
    writeDocument: writeJsonAtomic,
    normalize: normalizeAiUsage,
    emptyDocument: {}
  });
  const aiUsageService = createAiUsageServiceImpl({
    repository: usageRepository,
    getAccountKey: () => storagePaths().aiUsageFile,
    dailyCallLimit: userDailyCallLimit,
    dailyCostLimitCny: userDailyCostLimitCny,
    cnyPerUsd,
    now
  });
  const {
    read: readAiUsage,
    update: updateAiUsage,
    ensure: ensureAiUsage,
    reserveAttempt: reserveAiAttempt
  } = aiUsageService;

  const aiAudit = createAiAuditImpl({
    textLimit: auditTextLimit,
    getContext: () => requestStorage.getStore(),
    append: (day, entry) => appendPrivateJsonLineImpl(
      pathApi.join(storagePaths().logsDir, `ai-audit-${day}.ndjson`),
      entry
    ),
    updateUsage: updateAiUsage,
    logEvent,
    now,
    createId
  });

  const providerBudgetStage = (details, id = "provider-call") => {
    const official = details.costKnown === true ? null : resolveOfficialProviderPricing(details);
    const costKnown = details.costKnown === true || official?.costKnown === true;
    return {
      id,
      provider: safeText(details.provider, 80),
      service: safeText(details.service, 100),
      action: safeText(details.action, 120),
      scene: safeText(details.scene, 120),
      costKnown,
      ...(costKnown
        ? {
            estimatedCostCny: Math.max(
              0,
              Number(details.estimatedCostCny
                ?? (details.costKnown === true ? details.costCny : official.costCny)) || 0
            )
          }
        : {
            billingGap: safeText(details.costSource || official?.costSource, 500)
              || DEFAULT_BILLING_GAP
          })
    };
  };

  const conservativeDeepSeekStage = ({
    id,
    scene,
    maxOutputTokens = 4000,
    model = "deepseek-v4-pro"
  }) => ({
    ...deepSeekBudgetStages({
      model,
      scene,
      maxInputTokens: 128_000,
      maxOutputTokens,
      maxAttempts: 1,
      stageIdPrefix: id
    })[0],
    id
  });

  const currentBudgetAccountId = () => (
    safeText(requestStorage.getStore()?.user?.id, 100) || "local"
  );

  const logBudgetRejection = (details, error) => (
    logEvent("system", "ai.budget_rejected", {
      level: "warn",
      provider: details.provider,
      service: details.service,
      action: details.action,
      scene: details.scene,
      error: errorMetadata(error)
    })
  );

  async function meteredProviderCall(details, invoke, summarize, budgetContext = null) {
    const {
      budgeted = true,
      estimatedCostCny,
      ...auditDetails
    } = details;
    const budgetStage = providerBudgetStage(details);
    const reservedCostCny = Math.max(
      0,
      Number(estimatedCostCny ?? budgetStage.estimatedCostCny) || 0
    );
    if (!budgeted) return aiAudit.providerCall(auditDetails, invoke, summarize);

    const execute = async execution => {
      const accountReservation = await reserveAiAttempt({
        estimatedCostCny: reservedCostCny
      });
      const releaseQuota = typeof accountReservation?.release === "function"
        ? accountReservation.release
        : accountReservation;
      const commitQuota = typeof accountReservation?.commit === "function"
        ? accountReservation.commit
        : accountReservation;
      let recordSiteUsage = () => false;
      const reservation = {
        retain: entry => {
          accountReservation?.retain?.(entry);
          recordSiteUsage(entry);
        },
        commit: typeof commitQuota === "function" ? () => commitQuota() : () => {}
      };
      const auditedCall = () => aiAudit.providerCall({
        ...auditDetails,
        reservation
      }, invoke, summarize);
      let stageStarted = false;
      try {
        return await execution.runStage(
          budgetContext?.stageId || "provider-call",
          async ({ recordUsage }) => {
            recordSiteUsage = typeof recordUsage === "function"
              ? recordUsage
              : () => false;
            stageStarted = true;
            return auditedCall();
          }
        );
      } catch (error) {
        if (!stageStarted && typeof releaseQuota === "function") releaseQuota();
        throw error;
      }
    };

    try {
      if (budgetContext?.execution) return await execute(budgetContext.execution);
      return await aiBudgetRuntime.executeTask({
        accountId: currentBudgetAccountId(),
        taskId: createId(),
        stages: [budgetStage]
      }, execute);
    } catch (error) {
      if (error.statusCode === 429 || /(?:BUDGET|LIMIT)/.test(error.code || "")) {
        await logBudgetRejection(details, error);
      }
      throw error;
    }
  }

  async function executeDeepSeekBudgetTask(details, execute) {
    try {
        if (details.scene === RECORD_COMPRESSION_TASK_KIND) {
        const maximumCost = estimateDeepSeekPeakCostCny({
          model: details.model,
          maxInputTokens: details.maxInputTokens,
          maxOutputTokens: details.maxOutputTokens
        });
        if (!(recordCompressionPerCallBudgetCny > 0)
          || maximumCost > recordCompressionPerCallBudgetCny) {
          throw Object.assign(new Error("日压缩单次费用超过已配置上限"), {
            statusCode: 429,
            code: "RECORD_COMPRESSION_PER_CALL_BUDGET"
          });
        }
      }
      return await aiBudgetRuntime.executeTask({
        accountId: details.accountId,
        taskId: details.taskId,
        stages: deepSeekBudgetStages({
          model: details.model,
          scene: details.scene,
          maxInputTokens: details.maxInputTokens,
          maxOutputTokens: details.maxOutputTokens,
          maxAttempts: details.maxAttempts
        })
      }, execute);
    } catch (error) {
      if (error.statusCode === 429 || /(?:BUDGET|LIMIT)/.test(error.code || "")) {
        await logBudgetRejection(details, error);
      }
      throw error;
    }
  }

  const costRepository = createAccountDocumentRepositoryImpl({
    runtime: postgresRuntime,
    name: "costPlan",
    getFile: () => storagePaths().aiCostPlanFile,
    readDocument: readStoredJson,
    writeDocument: writeJsonAtomic,
    normalize: value => value,
    emptyDocument: null,
    onCommit: auditChanges
  });
  const aiCosts = createAiCostServiceImpl({
    repository: costRepository,
    readSettings: readLlmSettings,
    readUsage: readAiUsage,
    cnyPerUsd,
    now
  });

  let readModelRuntimeSettings = readLlmSettings;
  const deepSeekProvider = createDeepSeekTransportImpl({
    endpoint: deepSeekApiUrl
  });
  const runDeepSeek = createAiGeneratorImpl({
    readSettings: () => readModelRuntimeSettings(),
    provider: deepSeekProvider,
    getContext: () => requestStorage.getStore(),
    reserveAttempt: reserveAiAttempt,
    gate: aiGate,
    sceneGates: { [RECORD_COMPRESSION_TASK_KIND]: recordCompressionGate },
    audit: aiAudit,
    executeBudgetTask: executeDeepSeekBudgetTask,
    now,
    createId
  });

  const installModelRuntimeSettingsReader = reader => {
    if (typeof reader !== "function") {
      throw new TypeError("AI runtime model settings reader must be a function");
    }
    readModelRuntimeSettings = reader;
  };

  async function recoverAiUsageFromAuditLogs() {
    let names = [];
    try {
      names = await fileSystem.readdir(storagePaths().logsDir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const recovered = new Map();
    for (const name of names
      .filter(value => /^ai-audit-\d{4}-\d{2}-\d{2}\.ndjson$/.test(value))
      .sort()) {
      const content = await fileSystem.readFile(
        pathApi.join(storagePaths().logsDir, name),
        "utf8"
      );
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = usageEntryFromAudit(JSON.parse(line));
          if (entry?.callId) recovered.set(entry.callId, entry);
        } catch {}
      }
    }
    if (recovered.size) {
      await updateAiUsage(usage => {
        if (!Array.isArray(usage.entries)) usage.entries = [];
        const existing = new Set(
          usage.entries.map(item => item.callId || item.id).filter(Boolean)
        );
        for (const [callId, entry] of recovered) {
          if (!existing.has(callId)) usage.entries.push(entry);
        }
      });
    }
    await aiAudit.recoverPending();
  }

  async function ensureAuditLogs() {
    await pruneLogsImpl(storagePaths().logsDir, auditRetentionDays);
    await recoverAiUsageFromAuditLogs();
  }

  return Object.freeze({
    aiGate,
    recordCompressionGate,
    deepSeekProvider,
    aiBudgetRepository,
    aiBudgetService,
    aiBudgetRuntime,
    aiBudgetRecovery,
    settingsRepository,
    llmSettingsService,
    readLlmSettings,
    writeLlmSettings,
    ensureLlmSettings,
    usageRepository,
    aiUsageService,
    readAiUsage,
    updateAiUsage,
    ensureAiUsage,
    reserveAiAttempt,
    costRepository,
    aiCosts,
    aiAudit,
    runDeepSeek,
    providerBudgetStage,
    conservativeDeepSeekStage,
    currentBudgetAccountId,
    logBudgetRejection,
    meteredProviderCall,
    executeDeepSeekBudgetTask,
    recoverAiUsageFromAuditLogs,
    ensureAuditLogs,
    installModelRuntimeSettingsReader,
    readModelRuntimeSettings: () => readModelRuntimeSettings()
  });
}
