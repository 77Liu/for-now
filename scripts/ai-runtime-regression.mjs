import assert from "node:assert/strict";
import { createAiRuntime } from "../src/app/index.mjs";
import { createAiAudit } from "../src/modules/ai/index.mjs";

const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));

function createBudgetDouble({
  reservations = [],
  readBarrier = null,
  readError = null,
  reserveError = null,
  startError = null,
  settlementErrors = new Map()
} = {}) {
  const calls = [];
  const active = clone(reservations);
  return {
    calls,
    events: null,
    async read() {
      calls.push({ type: "budget-read" });
      this.events?.push("budget-read");
      if (readBarrier) await readBarrier;
      if (readError) throw readError;
      return { reservations: clone(active) };
    },
    async reserveTask(plan) {
      calls.push({ type: "site-reserve", plan: clone(plan) });
      this.events?.push("site-reserve");
      if (reserveError) throw reserveError;
      const reservation = {
        id: `reservation-${plan.taskId}`,
        accountId: plan.accountId,
        taskId: plan.taskId,
        stages: plan.stages.map(stage => ({ ...clone(stage), startedAt: "" }))
      };
      active.push(reservation);
      return { reservation: clone(reservation), events: [] };
    },
    async startStage(input) {
      calls.push({ type: "site-stage", input: clone(input) });
      this.events?.push("site-stage");
      if (startError) throw startError;
      const reservation = active.find(item => item.id === input.reservationId);
      const stage = reservation?.stages.find(item => item.id === input.stageId);
      if (!stage) throw new Error("test budget stage missing");
      stage.startedAt = "2026-10-06T00:00:00.000Z";
      return { reservation: clone(reservation) };
    },
    async settleTask(input) {
      calls.push({ type: "site-settle", input: clone(input) });
      this.events?.push("site-settle");
      const failure = settlementErrors.get(input.reservationId);
      if (failure) throw failure;
      const index = active.findIndex(item => item.id === input.reservationId);
      if (index >= 0) active.splice(index, 1);
      return { settlement: { stages: clone(input.stages) } };
    },
    async releaseTask(input) {
      calls.push({ type: "site-release", input: clone(input) });
      this.events?.push("site-release");
      const index = active.findIndex(item => item.id === input.reservationId);
      if (index >= 0) active.splice(index, 1);
      return { released: index >= 0 };
    }
  };
}

function createHarness({
  budget = createBudgetDouble(),
  files = new Map(),
  generatorFactory = null,
  gateError = null
} = {}) {
  const events = [];
  const logs = [];
  const repositoryOptions = [];
  const captures = {};
  const documents = new Map([
    ["settings", { version: 10, apiKey: "member-key", marker: "member" }],
    ["usage", { version: 5, entries: [] }],
    ["costPlan", null]
  ]);
  const context = {
    current: { user: { id: "member" }, traceId: "trace-member", secrets: [] },
    getStore() {
      return this.current;
    }
  };
  let sequence = 0;
  budget.events = events;

  const createRepository = options => {
    repositoryOptions.push(options);
    const read = async () => clone(documents.get(options.name));
    const write = async value => {
      documents.set(options.name, clone(value));
    };
    const update = async mutator => {
      const document = clone(documents.get(options.name));
      const result = await mutator(document);
      documents.set(options.name, document);
      return result;
    };
    return {
      read,
      write,
      update,
      ensure: async () => {
        const current = documents.get(options.name);
        documents.set(options.name, options.normalize(current || {}));
      }
    };
  };

  const createSettingsService = ({ repository }) => {
    captures.settingsRepository = repository;
    return {
      read: repository.read,
      write: repository.write,
      update: repository.update,
      ensure: repository.ensure
    };
  };

  const createUsageService = options => {
    captures.usageOptions = options;
    return {
      read: options.repository.read,
      update: options.repository.update,
      ensure: options.repository.ensure,
      async reserveAttempt(input) {
        events.push("account-reserve");
        captures.accountReservationInput = clone(input);
        let settled = false;
        return {
          retain(entry) {
            events.push("account-retain");
            captures.accountUsage = clone(entry);
          },
          commit() {
            if (settled) return;
            settled = true;
            events.push("account-commit");
          },
          release() {
            if (settled) return;
            settled = true;
            events.push("account-release");
          }
        };
      }
    };
  };

  const createAudit = options => {
    captures.auditOptions = options;
    const invokePrepared = async (details, invoke, summarize) => {
      let result;
      let response = {};
      try {
        result = await invoke();
        response = summarize(result) || {};
        return result;
      } finally {
        const usage = {
          callId: `call-${++sequence}`,
          costKnown: response.costKnown ?? details.costKnown ?? false,
          costCny: response.costCny ?? details.costCny ?? 0
        };
        details.reservation?.retain?.(usage);
        events.push("usage");
        await options.updateUsage(document => {
          if (!Array.isArray(document.entries)) document.entries = [];
          document.entries.push(usage);
        });
        details.reservation?.commit?.();
        events.push("audit");
      }
    };
    return {
      async recoverPending() {
        events.push("audit-recover-pending");
        return {
          recoveredUsage: 0,
          recoveredAudit: 0,
          pendingUsage: 0,
          pendingAudit: 0
        };
      },
      async prepareProviderCall(details, summarize = value => value || {}) {
        events.push("audit-start");
        return {
          invoke: operation => invokePrepared(details, operation, summarize),
          async finishUninvoked() {
            events.push("audit-not-invoked");
            return true;
          }
        };
      },
      async providerCall(details, invoke, summarize = value => value || {}) {
        return (await this.prepareProviderCall(details, summarize)).invoke(invoke);
      }
    };
  };

  const provider = {
    endpointHost: "provider.invalid",
    imageInput: async () => {
      throw new Error("image input is outside this runtime regression");
    },
    async complete() {
      events.push("provider");
      return {
        content: "answer",
        costKnown: true,
        costCny: 0.001,
        providerRequestId: "provider-request"
      };
    }
  };

  const dependencies = {
    fs: {
      async readdir(directory) {
        events.push("audit-list");
        return [...files.keys()]
          .filter(file => file.startsWith(`${directory}/`))
          .map(file => file.slice(directory.length + 1));
      },
      async readFile(file) {
        events.push(`audit-read:${file.split("/").at(-1)}`);
        if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return files.get(file);
      }
    },
    path: {
      join: (...parts) => parts.join("/").replace(/\/+/g, "/")
    },
    crypto: {
      randomUUID: () => `runtime-id-${++sequence}`
    },
    createAiBudgetRepository: options => {
      captures.budgetRepositoryOptions = options;
      return budget;
    },
    createAiBudgetService: options => {
      captures.budgetServiceOptions = options;
      return options.repository;
    },
    createAccountDocumentRepository: createRepository,
    createLlmSettingsService: createSettingsService,
    createAiUsageService: createUsageService,
    createAiCostService: options => {
      captures.costOptions = options;
      return {
        read: async () => options.repository.read(),
        save: async value => options.repository.write(value),
        dashboard: () => ({})
      };
    },
    createAiAudit: createAudit,
    createDeepSeekTransport: options => {
      captures.providerOptions = options;
      return provider;
    },
    createRateGate: (qps, concurrency) => {
      captures.gateOptions ||= [];
      captures.gateOptions.push({ qps, concurrency });
      return {
        async acquire() {
          events.push("gate");
          if (gateError) throw gateError;
          return () => events.push("gate-release");
        }
      };
    },
    createAiGenerator: options => {
      captures.generatorOptions = options;
      if (generatorFactory) return generatorFactory(options, { events, captures });
      return () => options.readSettings();
    },
    appendPrivateJsonLine: async (file, entry) => {
      events.push("audit-append");
      captures.appended = { file, entry };
    },
    pruneLogs: async (directory, retentionDays) => {
      events.push("audit-prune");
      captures.prune = { directory, retentionDays };
    }
  };

  const create = (runtimeOptions = {}) => createAiRuntime({
    ...runtimeOptions,
    dataRoot: "/data",
    postgresRuntime: { kind: "postgres-double" },
    storagePaths: () => ({
      llmSettingsFile: `/accounts/${context.current.user.id}/llm-settings.json`,
      aiUsageFile: `/accounts/${context.current.user.id}/ai-usage.json`,
      aiCostPlanFile: `/accounts/${context.current.user.id}/ai-cost-plan.json`,
      logsDir: `/accounts/${context.current.user.id}/logs`
    }),
    requestStorage: context,
    readStoredJson: async () => {
      throw new Error("repository double must own reads");
    },
    writeJsonAtomic: async () => {
      throw new Error("repository double must own writes");
    },
    auditChanges: async () => {},
    logEvent: async (scope, event, fields) => {
      logs.push({ scope, event, fields });
    },
    deepSeekApiUrl: "https://provider.invalid/chat/completions",
    aiQps: 20,
    aiConcurrency: 20,
    userDailyCallLimit: 200,
    userDailyCostLimitCny: 14.4,
    cnyPerUsd: 7.2,
    auditTextLimit: 10_000,
    auditRetentionDays: 30,
    now: () => "2026-10-06T00:00:00.000Z",
    dependencies
  });

  return {
    budget,
    captures,
    context,
    create,
    documents,
    events,
    logs,
    repositoryOptions
  };
}

const deepSeekGeneratorDouble = (options, { events }) => async () => (
  options.executeBudgetTask({
    accountId: "member",
    taskId: "deepseek-task",
    provider: "deepseek",
    service: "chat-completions",
    scene: "thoughtAnswer",
    model: "deepseek-flash",
    maxAttempts: 1,
    maxInputTokens: 1_000,
    maxOutputTokens: 100
  }, async execution => {
    await options.audit.recoverPending();
    const accountReservation = await options.reserveAttempt({ estimatedCostCny: 0.0028 });
    let releaseCapacity;
    let providerStarted = false;
    try {
      releaseCapacity = await options.gate.acquire();
      return await execution.runStage("deepseek-attempt-1", async ({ recordUsage }) => {
        providerStarted = true;
        const result = await options.audit.providerCall({
          provider: "deepseek",
          service: "chat-completions",
          scene: "thoughtAnswer",
          action: "complete",
          costKnown: true,
          reservation: {
            retain(entry) {
              accountReservation.retain(entry);
              recordUsage(entry);
            },
            commit: accountReservation.commit
          }
        }, () => options.provider.complete(), result => result);
        return result.content;
      });
    } finally {
      releaseCapacity?.();
      if (!providerStarted) accountReservation.release?.();
    }
  })
);

{
  let releaseRecovery;
  const recoveryBarrier = new Promise(resolve => {
    releaseRecovery = resolve;
  });
  const harness = createHarness({
    budget: createBudgetDouble({ readBarrier: recoveryBarrier })
  });
  let returned = false;
  const pending = harness.create().then(runtime => {
    returned = true;
    return runtime;
  });
  await tick();
  assert.equal(returned, false);
  assert.equal(harness.repositoryOptions.length, 0);
  releaseRecovery();
  await pending;
  assert.equal(returned, true);

  const corrupted = new Error("corrupted budget ledger");
  const failed = createHarness({
    budget: createBudgetDouble({ readError: corrupted })
  });
  await assert.rejects(failed.create(), error => error === corrupted);
  assert.equal(failed.repositoryOptions.length, 0);
}

{
  const recoveryFailure = new Error("cannot settle one reservation");
  const budget = createBudgetDouble({
    reservations: [
      {
        id: "failed-started",
        stages: [{ id: "attempt-1", startedAt: "2026-10-05T23:59:00.000Z" }]
      },
      {
        id: "released-after-failure",
        stages: [{ id: "attempt-1", startedAt: "" }]
      }
    ],
    settlementErrors: new Map([["failed-started", recoveryFailure]])
  });
  const harness = createHarness({ budget });
  const runtime = await harness.create();
  assert.equal(runtime.aiBudgetRecovery.scanned, 2);
  assert.equal(runtime.aiBudgetRecovery.failures.length, 1);
  assert.equal(runtime.aiBudgetRecovery.failures[0].error, recoveryFailure);
  assert.deepEqual(runtime.aiBudgetRecovery.released, ["released-after-failure"]);
  assert.ok(harness.logs.some(entry => (
    entry.event === "ai.budget_recovery_failed"
    && entry.fields.reservationId === "failed-started"
  )));
  assert.ok(harness.logs.some(entry => (
    entry.event === "ai.budget_recovery_completed"
    && entry.fields.failed === 1
    && entry.fields.released === 1
  )));
}

{
  const harness = createHarness();
  const runtime = await harness.create();
  assert.deepEqual(
    harness.repositoryOptions.map(options => options.name),
    ["settings", "usage", "costPlan"]
  );
  assert.deepEqual(
    harness.repositoryOptions.map(options => options.getFile()),
    [
      "/accounts/member/llm-settings.json",
      "/accounts/member/ai-usage.json",
      "/accounts/member/ai-cost-plan.json"
    ]
  );
  assert.ok(harness.repositoryOptions.every(options => (
    options.runtime === harness.captures.budgetRepositoryOptions.runtime
  )));
  assert.equal(harness.captures.usageOptions.dailyCallLimit, 200);
  assert.equal(harness.captures.usageOptions.dailyCostLimitCny, 14.4);
  assert.equal(harness.captures.usageOptions.cnyPerUsd, 7.2);
  assert.equal(harness.captures.costOptions.repository, runtime.costRepository);
  assert.equal(harness.captures.auditOptions.updateUsage, runtime.updateAiUsage);
  assert.equal(harness.captures.providerOptions.endpoint, "https://provider.invalid/chat/completions");
  assert.deepEqual(harness.captures.gateOptions, [
    { qps: 20, concurrency: 20 },
    { qps: 20, concurrency: 1 }
  ]);
  assert.equal(harness.captures.generatorOptions.provider, runtime.deepSeekProvider);
  assert.equal(harness.captures.generatorOptions.gate, runtime.aiGate);
  assert.equal(harness.captures.generatorOptions.sceneGates.recordCompression, runtime.recordCompressionGate);
  assert.equal((await runtime.runDeepSeek()).marker, "member");

  runtime.installModelRuntimeSettingsReader(async () => ({
    version: 10,
    apiKey: "owner-key",
    marker: "owner"
  }));
  assert.equal((await runtime.readModelRuntimeSettings()).marker, "owner", "importance choice sees the same effective reader as generation");
  assert.equal((await runtime.runDeepSeek()).marker, "owner");
  await assert.rejects(
    async () => runtime.installModelRuntimeSettingsReader(null),
    /reader must be a function/
  );
}

{
  const rejection = Object.assign(new Error("site budget rejected"), {
    statusCode: 429,
    code: "AI_SITE_DAILY_COST_LIMIT"
  });
  const harness = createHarness({
    budget: createBudgetDouble({ reserveError: rejection }),
    generatorFactory: deepSeekGeneratorDouble
  });
  const runtime = await harness.create();
  harness.events.length = 0;
  await assert.rejects(runtime.runDeepSeek(), error => error === rejection);
  assert.equal(harness.events.includes("account-reserve"), false);
  assert.equal(harness.events.includes("gate"), false);
  assert.equal(harness.events.includes("provider"), false);
  assert.ok(harness.logs.some(entry => (
    entry.event === "ai.budget_rejected"
    && entry.fields.provider === "deepseek"
  )));
}

{
  const harness = createHarness({ generatorFactory: deepSeekGeneratorDouble });
  const runtime = await harness.create();
  harness.events.length = 0;
  harness.budget.calls.length = 0;
  assert.equal(await runtime.runDeepSeek(), "answer");
  assert.deepEqual(harness.events, [
    "site-reserve",
    "audit-recover-pending",
    "account-reserve",
    "gate",
    "site-stage",
    "audit-start",
    "provider",
    "account-retain",
    "usage",
    "account-commit",
    "audit",
    "gate-release",
    "site-settle"
  ]);
  const settlement = harness.budget.calls.find(call => call.type === "site-settle").input;
  assert.deepEqual(settlement.stages, [{
    stageId: "deepseek-attempt-1",
    started: true,
    actualCostCny: 0.001
  }]);
}

{
  const startError = new Error("stage did not start");
  const harness = createHarness({
    budget: createBudgetDouble({ startError })
  });
  const runtime = await harness.create();
  harness.events.length = 0;
  harness.budget.calls.length = 0;
  await assert.rejects(runtime.meteredProviderCall({
    provider: "volcengine",
    service: "speech",
    action: "synthesize",
    scene: "speechSynthesis",
    unitType: "character",
    units: 12
  }, async () => {
    harness.events.push("provider");
  }), error => error === startError);
  assert.equal(harness.events.includes("provider"), false);
  assert.ok(harness.events.includes("audit-not-invoked"));
  assert.equal(harness.events.includes("usage"), false);
  assert.ok(harness.events.includes("account-release"));
  assert.ok(harness.events.includes("site-release"));
  assert.equal(harness.budget.calls.some(call => call.type === "site-settle"), false);
}

{
  const harness = createHarness();
  const runtime = await harness.create();
  const stage = runtime.providerBudgetStage({
    provider: "unmapped",
    service: "custom",
    action: "invoke",
    scene: "analysis",
    units: 1
  });
  assert.equal(stage.costKnown, false);
  assert.equal(Object.hasOwn(stage, "estimatedCostCny"), false);
  assert.match(stage.billingGap, /尚未完成映射/);

  harness.events.length = 0;
  harness.budget.calls.length = 0;
  await runtime.meteredProviderCall({
    provider: "unmapped",
    service: "custom",
    action: "invoke",
    scene: "analysis",
    unitType: "call",
    units: 1
  }, async () => {
    harness.events.push("provider");
    return { costKnown: false };
  }, result => result);
  const settlement = harness.budget.calls.find(call => call.type === "site-settle").input;
  assert.deepEqual(settlement.stages, [{
    stageId: "provider-call",
    started: true,
    costKnown: false
  }]);
  assert.equal(harness.captures.accountReservationInput.estimatedCostCny, 0);
}

{
  const harness = createHarness();
  const runtime = await harness.create();
  harness.budget.calls.length = 0;
  assert.equal(await runtime.executeDeepSeekBudgetTask({
    accountId: "member",
    taskId: "no-provider-io",
    model: "deepseek-flash",
    scene: "thoughtAnswer",
    maxInputTokens: 1_000,
    maxOutputTokens: 100,
    maxAttempts: 1
  }, async () => "cached"), "cached");
  assert.equal(harness.budget.calls.some(call => call.type === "site-stage"), false);
  assert.equal(harness.budget.calls.some(call => call.type === "site-settle"), false);
  assert.deepEqual(
    harness.budget.calls.find(call => call.type === "site-release").input,
    {
      reservationId: "reservation-no-provider-io",
      reason: "completed_without_io"
    }
  );
}

{
  const lines = [];
  const producer = createAiAudit({
    textLimit: 10_000,
    getContext: () => ({
      user: { id: "member" },
      traceId: "usage-restart-trace",
      secrets: []
    }),
    append: async (_day, entry) => {
      lines.push(JSON.stringify(entry));
    },
    updateUsage: async () => {
      throw new Error("usage document unavailable");
    },
    logEvent: async () => {},
    now: () => "2026-10-06T00:00:00.000Z",
    createId: () => "provider-restart-recovery"
  });
  await producer.providerCall({
    provider: "volcengine",
    service: "vision",
    scene: "visionOcr",
    action: "OCRNormal",
    costKnown: true,
    costCny: 0.005
  }, async () => ({ requestId: "provider-restart-request" }));
  const terminal = lines.map(line => JSON.parse(line))
    .find(entry => entry.callId === "provider-restart-recovery" && entry.status === "success");
  assert.equal(terminal.persistence.usage, "pending");
  assert.equal(terminal.usageRecovery.callId, "provider-restart-recovery");

  const files = new Map([[
    "/accounts/member/logs/ai-audit-2026-10-06.ndjson",
    lines.join("\n")
  ]]);
  const restarted = createHarness({ files });
  const runtime = await restarted.create();
  await runtime.ensureAuditLogs();
  await runtime.ensureAuditLogs();
  assert.deepEqual(
    restarted.documents.get("usage").entries.map(entry => entry.callId),
    ["provider-restart-recovery"]
  );
}

{
  const files = new Map([
    ["/accounts/member/logs/ai-audit-2026-10-05.ndjson", [
      JSON.stringify({
        usageRecovery: { callId: "recovered-a", marker: "older" }
      }),
      "{invalid-json",
      JSON.stringify({ type: "without-usage" })
    ].join("\n")],
    ["/accounts/member/logs/ai-audit-2026-10-06.ndjson", [
      JSON.stringify({
        usageRecovery: { callId: "recovered-a", marker: "newer" }
      }),
      JSON.stringify({
        usageRecovery: { callId: "already-present", marker: "duplicate" }
      }),
      JSON.stringify({
        usageRecovery: { callId: "recovered-b", marker: "new" }
      })
    ].join("\n")]
  ]);
  const harness = createHarness({ files });
  harness.documents.set("usage", {
    version: 5,
    entries: [{ callId: "already-present", marker: "existing" }]
  });
  const runtime = await harness.create();
  harness.events.length = 0;
  await runtime.ensureAuditLogs();
  const usage = harness.documents.get("usage");
  assert.deepEqual(
    usage.entries.map(entry => [entry.callId, entry.marker]),
    [
      ["already-present", "existing"],
      ["recovered-a", "newer"],
      ["recovered-b", "new"]
    ]
  );
  assert.equal(harness.events[0], "audit-prune");
  assert.ok(harness.events.indexOf("audit-list") > harness.events.indexOf("audit-prune"));
  assert.equal(harness.events.at(-1), "audit-recover-pending");
  assert.deepEqual(harness.captures.prune, {
    directory: "/accounts/member/logs",
    retentionDays: 30
  });
}

// F2共享账本先只读核验已有语义；不得将非法金额归零、丢弃事件或改写引用后恢复。
for (const raw of [
  { days: [{ key: "2026-10-16", knownCostMicros: "invalid" }] },
  { events: [{ id: "event", type: "charge", createdAt: "invalid" }] },
  { days: [{ key: "2026-10-16", users: [{ accountId: "same", calls: 1 }, { accountId: "same", calls: 2 }] }] },
  { reservations: [{ id: "reservation", accountId: "account", taskId: "task", day: "2026-10-16", month: "2026-09", stages: [{ id: "stage" }] }] }
]) {
  const harness = createHarness(); const original = clone(raw);
  harness.budget.read = async () => clone(raw);
  await assert.rejects(harness.create({ accountRuntime: { enabled: true } }), /全局预算/);
  assert.deepEqual(raw, original);
  assert.equal(harness.budget.calls.length, 0, "invalid ledger must be rejected before recovery writes");
}
{
  const harness = createHarness();
  harness.budget.read = async () => ({ days: [{ key: "2026-10-16", knownCostMicros: 12 }], reservations: [] });
  await harness.create({ accountRuntime: { enabled: true } });
}

console.log("AI runtime regression passed: recovery, wiring, late-bound settings, budget ordering, unknown costs, release and audit usage recovery.");
