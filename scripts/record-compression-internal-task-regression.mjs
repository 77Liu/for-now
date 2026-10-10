import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createBackgroundAi } from "../src/app/index.mjs";
import { createTaskHttp } from "../src/http/index.mjs";
import { createNotificationService } from "../src/modules/notifications/index.mjs";
import { createTaskLifecycle } from "../src/modules/tasks/index.mjs";
import {
  RECORD_COMPRESSION_MAX_BUDGET_WAITING_TASKS_PER_ACCOUNT,
  RECORD_COMPRESSION_TASK_KIND
} from "../src/modules/record-compressions/index.mjs";
import { WAITING_FOR_BUDGET_STATUS } from "../src/modules/tasks/index.mjs";

const store = { aiTasks: [], notifications: [] };
const ledger = new Map();
const scheduled = [];
let id = 0;
const now = () => "2026-10-10T08:00:00.000Z";
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const repository = {
  async read() { return structuredClone(store); },
  async update(operation) { return operation(store); },
  async executeIdempotent(request, operation, { onReplay = value => value } = {}) {
    const key = `${request.scope}:${request.key}`;
    const existing = ledger.get(key);
    if (existing) {
      if (existing.requestHash !== request.requestHash) {
        throw Object.assign(new Error("idempotency key reused"), { code: "IDEMPOTENCY_KEY_REUSED" });
      }
      return structuredClone(onReplay(structuredClone(existing.response)));
    }
    const response = await operation(store);
    ledger.set(key, { requestHash: request.requestHash, response: structuredClone(response) });
    return response;
  }
};
const target = {
  prepare() { return { inputVersion: 1, subtargetVersion: 0, inputHash: "compression-input" }; },
  save() { return "compression-result"; },
  result() { return { coverage: { complete: true } }; }
};
const backgroundAi = createBackgroundAi({
  repository,
  tasks: createTaskLifecycle({ createId: () => `task-${++id}`, now, hash }),
  notifications: createNotificationService({ createId: () => `notice-${++id}`, now }),
  targets: target,
  generate: async () => ({ content: "synthetic" }),
  dispatch: callback => scheduled.push(callback),
  contextKey: () => "account-a",
  now
});
const historicalInput = {
  kind: RECORD_COMPRESSION_TASK_KIND,
  resourceType: RECORD_COMPRESSION_TASK_KIND,
  targetId: "supplement-target",
  inputVersion: 1,
  clientRequestId: "scheduler-historical-batch",
  payload: {
    operation: "historicalSupplement",
    localDate: "2026-10-10",
    timezone: "America/Los_Angeles",
    promptVersion: "historical-user-supplement.v1",
    sourceManifestHash: "a".repeat(64),
    windowStart: "2026-10-04",
    windowEnd: "2026-10-10",
    batchIndex: 1,
    inputAsOf: "2026-10-10T08:00:00.000Z",
    recordId: "supplement-target"
  }
};

const publicCreate = await backgroundAi.enqueue(historicalInput);
assert.deepEqual(publicCreate, { unsupported: true },
  "public task creation cannot bypass scheduler budgets with recordCompression");
assert.equal(store.aiTasks.length, 0);
assert.deepEqual(await backgroundAi.enqueueInternal({
  ...historicalInput,
  kind: "thoughtAnswer",
  clientRequestId: "internal-entry-rejects-other-kind"
}), { unsupported: true }, "the internal entry point accepts only the compression service kind");

const created = await backgroundAi.enqueueInternal(historicalInput);
assert.ok(created.task);
assert.equal(created.task.internal, true);
assert.equal(created.task.payload.batchIndex, 1);
assert.equal(scheduled.length, 1);
const replay = await backgroundAi.enqueueInternal(historicalInput);
assert.equal(replay.duplicate, true,
  "internal scheduler creation uses the same durable idempotency path");
assert.equal(scheduled.length, 1, "an idempotent replay does not schedule twice");

// Treat a pre-boundary persisted task that lacks the new internal marker as
// internal by kind as well, so upgrades cannot expose old compression work.
delete store.aiTasks[0].internal;
store.notifications.push({
  id: "legacy-compression-notice",
  taskId: created.task.id,
  kind: "aiTask",
  status: "failed",
  readAt: ""
});
assert.deepEqual(await backgroundAi.list(), { items: [] });
assert.equal(await backgroundAi.get(created.task.id), null);
assert.equal(await backgroundAi.getResult(created.task.id), null);
assert.deepEqual(await backgroundAi.listNotifications(), { unread: 0, items: [] });
assert.equal(await backgroundAi.readNotification("legacy-compression-notice"), null);
assert.equal(await backgroundAi.readAllNotifications(), 0);
assert.deepEqual(await backgroundAi.retry(created.task.id), { missing: true });
assert.deepEqual(await backgroundAi.retryInternal(created.task.id), { missing: true },
  "internal recovery must not retry compression work outside the scheduler budget");

const http = createTaskHttp({
  backgroundAi,
  bodyJson: async request => request.body,
  sendJson(response, status, body) {
    response.status = status;
    response.body = body;
  }
});
const request = async (method, pathname, body) => {
  const response = {};
  await http.handle({ method, body }, response, new URL(`http://local${pathname}`));
  return response;
};
const deniedCreate = await request("POST", "/api/ai-tasks", historicalInput);
assert.equal(deniedCreate.status, 400);
assert.equal(deniedCreate.body.error, "不支持这种后台任务");
assert.equal((await request("GET", "/api/ai-tasks")).body.items.length, 0);
assert.equal((await request("GET", `/api/ai-tasks/${created.task.id}`)).status, 404);
assert.equal((await request("GET", `/api/ai-tasks/${created.task.id}/result`)).status, 404);
assert.equal((await request("POST", `/api/ai-tasks/${created.task.id}/retry`)).status, 409);
assert.deepEqual((await request("GET", "/api/notifications")).body, { unread: 0, items: [] });
assert.equal((await request("PATCH", "/api/notifications/legacy-compression-notice/read")).status, 404);

const scheduledBeforeBudgetWaits = scheduled.length;
for (let index = 0; index < RECORD_COMPRESSION_MAX_BUDGET_WAITING_TASKS_PER_ACCOUNT; index += 1) {
  const result = await backgroundAi.enqueueBudgetWaiting({
    ...historicalInput,
    targetId: `waiting-target-${index}`,
    clientRequestId: `waiting-budget-${index}`,
    payload: {
      ...historicalInput.payload,
      recordId: `waiting-target-${index}`,
      sourceManifestHash: String(index).padStart(64, "a")
    }
  });
  assert.equal(result.task.status, WAITING_FOR_BUDGET_STATUS);
}
const fullBudgetWait = await backgroundAi.enqueueBudgetWaiting({
  ...historicalInput,
  targetId: "waiting-target-overflow",
  clientRequestId: "waiting-budget-overflow",
  payload: { ...historicalInput.payload, recordId: "waiting-target-overflow" }
});
assert.deepEqual(fullBudgetWait, { budgetQueueFull: true },
  "durable budget waits must remain bounded per account");
assert.equal(store.aiTasks.filter(task => task.status === WAITING_FOR_BUDGET_STATUS).length,
  RECORD_COMPRESSION_MAX_BUDGET_WAITING_TASKS_PER_ACCOUNT);
assert.equal(scheduled.length, scheduledBeforeBudgetWaits,
  "persisting a budget wait must not dispatch or reserve provider work");
assert.equal(JSON.stringify(store.aiTasks.filter(task => task.status === WAITING_FOR_BUDGET_STATUS))
  .includes("must not persist"), false);

console.log("Record-compression internal-task visibility, budget boundary and scheduler idempotency regression passed.");
