import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createCheckinRecords } from "../src/modules/checkins/index.mjs";
import { createDailyRecordRecords } from "../src/modules/health/index.mjs";
import {
  createApiV1Http,
  createCheckinHttp,
  createHealthRecordHttp,
  openApiV1,
  recordComponents,
  recordPaths,
  recordsOpenApiFragment
} from "../src/http/index.mjs";
import { recordVersion } from "../src/shared/validation/index.mjs";

const context = new AsyncLocalStorage();
const stores = new Map([
  ["account-a", { checkins: [], dailyRecords: [], trash: [] }],
  ["account-b", { checkins: [], dailyRecords: [], trash: [] }]
]);
const run = (accountId, operation) => context.run({ accountId, traceId: `trace-${accountId}` }, operation);
const collectionRepository = collection => ({
  async read() {
    return structuredClone(stores.get(context.getStore().accountId)[collection]);
  },
  async update(mutate) {
    const accountId = context.getStore().accountId;
    const store = structuredClone(stores.get(accountId));
    const result = await mutate(store[collection], store.trash);
    stores.set(accountId, store);
    return result;
  }
});

let sequence = 0;
const recordsByType = {
  checkins: createCheckinRecords({
    repository: collectionRepository("checkins"),
    now: () => "2026-09-29T08:00:00.000Z",
    createId: () => `checkin-${++sequence}`
  }),
  dailyRecords: createDailyRecordRecords({
    repository: collectionRepository("dailyRecords"),
    now: () => "2026-09-29T08:00:00.000Z",
    createId: () => `daily-${++sequence}`
  })
};

const remove = (collection, type) => async (id, expectedVersion = null) => {
  const accountId = context.getStore().accountId;
  const store = structuredClone(stores.get(accountId));
  const index = store[collection].findIndex(item => item.id === id);
  if (index < 0) return null;
  const item = store[collection][index];
  if (expectedVersion != null && recordVersion(item.version) !== expectedVersion) {
    return { versionConflict: true, currentVersion: recordVersion(item.version) };
  }
  store[collection].splice(index, 1);
  const entry = { id: `trash-${id}`, type, payload: item };
  store.trash.unshift(entry);
  stores.set(accountId, store);
  return entry;
};

const sendJson = (res, status, value) => {
  res.status = status;
  res.body = value;
  res.headersSent = true;
  return value;
};
const bodyJson = async req => req.body || {};
const noLegacyTrash = () => {
  throw new Error("legacy trash response must not be used by v1");
};
const checkinHttp = createCheckinHttp({
  records: recordsByType.checkins,
  remove: remove("checkins", "checkin"),
  sendTrashResult: noLegacyTrash,
  bodyJson,
  sendJson
});
const healthHttp = createHealthRecordHttp({
  records: recordsByType.dailyRecords,
  remove: remove("dailyRecords", "dailyRecord"),
  sendTrashResult: noLegacyTrash,
  bodyJson,
  sendJson
});
const api = createApiV1Http({ sendJson, getContext: () => context.getStore(), openApi: openApiV1 });
api.register("checkins", checkinHttp.handleV1);
api.register("health", healthHttp.handleV1);

async function request(accountId, method, pathname, { body = {}, headers = {} } = {}) {
  const responseHeaders = new Map();
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      responseHeaders.set(String(name).toLowerCase(), String(value));
    }
  };
  const handled = await run(accountId, () => api.handle(
    { method, headers, body },
    res,
    new URL(`http://local${pathname}`)
  ));
  return { handled, status: res.status, body: res.body, headers: responseHeaders };
}

const checkinInput = {
  occurredAt: "2026-09-29T01:02:03.000Z",
  mood: 4,
  energy: 3,
  stress: 2,
  sleep: 5,
  factors: ["运动"]
};
let response = await request("account-a", "POST", "/api/v1/checkins", {
  headers: { "idempotency-key": "checkin-create-1" },
  body: checkinInput
});
assert.equal(response.handled, true);
assert.equal(response.status, 201);
assert.equal(response.body.error, null);
assert.equal(response.body.meta.traceId, "trace-account-a");
assert.equal(response.body.data.version, 1);
assert.equal(response.headers.get("etag"), "\"1\"");
const checkinId = response.body.data.id;

response = await request("account-a", "POST", "/api/v1/checkins", {
  headers: { "idempotency-key": "checkin-create-1" },
  body: checkinInput
});
assert.equal(response.status, 200);
assert.equal(response.body.data.id, checkinId);

response = await request("account-a", "POST", "/api/v1/checkins", {
  headers: { "idempotency-key": "checkin-create-1" },
  body: { ...checkinInput, mood: 1 }
});
assert.equal(response.status, 409);
assert.equal(response.body.error.code, "IDEMPOTENCY_KEY_REUSED");
const undatedCheckin = await request("account-a", "POST", "/api/v1/checkins", {
  headers: { "idempotency-key": "checkin-undated" },
  body: { mood: 3, energy: 3, stress: 3, sleep: 3 }
});
await new Promise(resolve => setTimeout(resolve, 5));
const undatedCheckinReplay = await request("account-a", "POST", "/api/v1/checkins", {
  headers: { "idempotency-key": "checkin-undated" },
  body: { mood: 3, energy: 3, stress: 3, sleep: 3 }
});
assert.equal(undatedCheckinReplay.status, 200);
assert.equal(undatedCheckinReplay.body.data.id, undatedCheckin.body.data.id);

await request("account-a", "POST", "/api/v1/checkins", {
  headers: { "idempotency-key": "checkin-create-2" },
  body: { ...checkinInput, occurredAt: "2026-09-29T02:02:03.000Z" }
});
response = await request("account-a", "GET", "/api/v1/checkins?limit=1");
assert.equal(response.status, 200);
assert.equal(response.body.data.length, 1);
assert.ok(response.body.meta.nextCursor);
response = await request("account-a", "GET", `/api/v1/checkins?limit=1&cursor=${encodeURIComponent(response.body.meta.nextCursor)}`);
assert.equal(response.body.data.length, 1);
assert.ok(response.body.meta.nextCursor);
response = await request("account-a", "GET", `/api/v1/checkins?limit=1&cursor=${encodeURIComponent(response.body.meta.nextCursor)}`);
assert.equal(response.body.data.length, 1);
assert.equal(response.body.meta.nextCursor, null);

response = await request("account-a", "GET", `/api/v1/checkins/${checkinId}`);
assert.equal(response.status, 200);
assert.equal(response.headers.get("etag"), "\"1\"");
response = await request("account-b", "GET", `/api/v1/checkins/${checkinId}`);
assert.equal(response.status, 404);

response = await request("account-a", "PATCH", `/api/v1/checkins/${checkinId}`, {
  headers: { "if-match": "\"1\"" },
  body: { mood: 5 }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.version, 2);
assert.deepEqual({
  mood: response.body.data.mood,
  energy: response.body.data.energy,
  stress: response.body.data.stress,
  sleep: response.body.data.sleep,
  factors: response.body.data.factors
}, { mood: 5, energy: 3, stress: 2, sleep: 5, factors: ["运动"] });
assert.equal(response.headers.get("etag"), "\"2\"");
response = await request("account-a", "PATCH", `/api/v1/checkins/${checkinId}`, {
  headers: { "if-match": "\"1\"" },
  body: { ...checkinInput, mood: 2 }
});
assert.equal(response.status, 412);
assert.equal(response.body.error.details.currentVersion, 2);
response = await request("account-a", "DELETE", `/api/v1/checkins/${checkinId}`, {
  headers: { "if-match": "\"2\"" }
});
assert.equal(response.status, 200);
response = await request("account-a", "POST", "/api/v1/checkins", {
  headers: { "idempotency-key": "checkin-create-1" },
  body: checkinInput
});
assert.equal(response.status, 200);
assert.equal(response.body.data.id, checkinId);
assert.equal((await run("account-a", () => recordsByType.checkins.get(checkinId))), null);
response = await request("account-a", "POST", "/api/v1/checkins", {
  headers: { "idempotency-key": "checkin-create-1" },
  body: { ...checkinInput, mood: 1 }
});
assert.equal(response.status, 409);

const healthInput = {
  type: "exercise",
  occurredAt: "2026-09-29T03:02:03.000Z",
  exerciseType: "力量训练",
  durationSeconds: 1800,
  activeCalories: 180,
  totalCalories: 230
};
response = await request("account-a", "POST", "/api/v1/daily-records", {
  headers: { "idempotency-key": "health-create-1" },
  body: healthInput
});
assert.equal(response.status, 201);
assert.equal(response.body.data.version, 1);
const healthId = response.body.data.id;
response = await request("account-a", "GET", `/api/v1/daily-records/${healthId}`);
assert.equal(response.status, 200);
assert.equal(response.body.data.exerciseType, "力量训练");
response = await request("account-a", "PATCH", `/api/v1/daily-records/${healthId}`, {
  headers: { "if-match": "\"1\"" },
  body: { activeCalories: 190 }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.version, 2);
assert.equal(response.body.data.totalCalories, 230);
response = await request("account-a", "DELETE", `/api/v1/daily-records/${healthId}`, {
  headers: { "if-match": "\"1\"" }
});
assert.equal(response.status, 412);
response = await request("account-a", "DELETE", `/api/v1/daily-records/${healthId}`, {
  headers: { "if-match": "\"2\"" }
});
assert.equal(response.status, 200);
assert.equal(response.body.data.trashId, `trash-${healthId}`);
assert.equal((await run("account-a", () => recordsByType.dailyRecords.get(healthId))), null);
response = await request("account-a", "POST", "/api/v1/daily-records", {
  headers: { "idempotency-key": "health-create-1" },
  body: healthInput
});
assert.equal(response.status, 200);
assert.equal(response.body.data.id, healthId);
assert.equal((await run("account-a", () => recordsByType.dailyRecords.get(healthId))), null);
response = await request("account-a", "POST", "/api/v1/daily-records", {
  headers: { "idempotency-key": "health-create-1" },
  body: { ...healthInput, durationSeconds: 900 }
});
assert.equal(response.status, 409);
assert.equal(response.body.error.code, "IDEMPOTENCY_KEY_REUSED");

assert.deepEqual(Object.keys(recordsOpenApiFragment).sort(), ["components", "paths"]);
assert.strictEqual(recordsOpenApiFragment.paths, recordPaths);
assert.strictEqual(recordsOpenApiFragment.components, recordComponents);
for (const path of ["/checkins", "/checkins/{id}", "/daily-records", "/daily-records/{id}"]) {
  assert.strictEqual(openApiV1.paths[path], recordPaths[path]);
}
const operations = Object.values(recordPaths)
  .flatMap(pathItem => Object.entries(pathItem))
  .filter(([method]) => ["get", "post", "patch", "delete"].includes(method));
assert.equal(operations.length, 10);
assert.equal(new Set(operations.map(([, operation]) => operation.operationId)).size, 10);

response = await request("account-a", "GET", "/api/v1/not-a-record");
assert.equal(response.handled, false);

console.log("Record v1 contracts passed: check-in/health list, detail, idempotent create, ETag updates, conditional delete, account isolation and OpenAPI composition.");
