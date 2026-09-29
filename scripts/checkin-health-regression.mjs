import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createCheckinRecords } from "../src/modules/checkins/index.mjs";
import { createDailyRecordRecords } from "../src/modules/health/index.mjs";
import { createCheckinHttp, createHealthRecordHttp } from "../src/http/index.mjs";
import { localDateKey } from "../src/shared/time/index.mjs";

const context = new AsyncLocalStorage();
const accounts = new Map([
  ["account-a", { checkins: [], dailyRecords: [], trash: [] }],
  ["account-b", { checkins: [], dailyRecords: [], trash: [] }]
]);
const failedCommits = new Set();
const updateAttempts = new Map();
const repository = collection => ({
  async read() {
    const accountId = context.getStore();
    assert.ok(accounts.has(accountId), "repository requires an account context");
    return structuredClone(accounts.get(accountId)[collection]);
  },
  async update(mutate) {
    const accountId = context.getStore();
    assert.ok(accounts.has(accountId), "repository requires an account context");
    const items = structuredClone(accounts.get(accountId)[collection]);
    const result = await mutate(items, accounts.get(accountId).trash);
    const key = `${accountId}:${collection}`;
    updateAttempts.set(key, (updateAttempts.get(key) || 0) + 1);
    if (failedCommits.has(key)) throw new Error("commit unavailable");
    accounts.set(accountId, { ...accounts.get(accountId), [collection]: items });
    return result;
  }
});
const run = (accountId, operation) => context.run(accountId, operation);

let checkinSequence = 0;
let healthSequence = 0;
const checkins = createCheckinRecords({
  repository: repository("checkins"),
  now: () => "2026-09-29T08:00:00.000Z",
  createId: () => `checkin-${++checkinSequence}`
});
const dailyRecords = createDailyRecordRecords({
  repository: repository("dailyRecords"),
  now: () => "2026-09-29T08:00:00.000Z",
  createId: () => `daily-${++healthSequence}`
});

const checkinTime = "2026-09-29T01:02:03.456Z";
const createdCheckin = (await run("account-a", () => checkins.create({
  occurredAt: checkinTime,
  mood: 8,
  energy: 0,
  stress: "4",
  sleep: "",
  factors: [" 散步 ", "", "咖啡"],
  custom: { 专注: 5, 平静: 0 },
  notes: { mood: " 原始心情 " }
}))).value;
assert.deepEqual({
  occurredAt: createdCheckin.occurredAt,
  occurredOn: createdCheckin.occurredOn,
  mood: createdCheckin.mood,
  energy: createdCheckin.energy,
  stress: createdCheckin.stress,
  sleep: createdCheckin.sleep,
  factors: createdCheckin.factors,
  custom: createdCheckin.custom,
  notes: createdCheckin.notes
}, {
  occurredAt: checkinTime,
  occurredOn: localDateKey(checkinTime),
  mood: 5,
  energy: 3,
  stress: 4,
  sleep: 3,
  factors: ["散步", "咖啡"],
  custom: { 专注: 5, 平静: 3 },
  notes: { mood: "原始心情" }
});
assert.equal(Object.hasOwn(createdCheckin, "version"), false);
assert.equal((await run("account-a", () => checkins.get(createdCheckin.id))).id, createdCheckin.id);
assert.equal((await run("account-a", () => checkins.list({ limit: 1 }))).items.length, 1);

const v1CheckinInput = {
  occurredAt: "2026-09-29T03:00:00.000Z",
  mood: 4,
  energy: 4,
  stress: 2,
  sleep: 4
};
const v1Checkin = await run("account-a", () => checkins.create(v1CheckinInput, { clientRequestId: "checkin-v1-key" }));
assert.equal(v1Checkin.value.version, 1);
assert.equal(v1Checkin.duplicate, false);
assert.equal((await run("account-a", () => checkins.create(v1CheckinInput, { clientRequestId: "checkin-v1-key" }))).duplicate, true);
assert.equal((await run("account-a", () => checkins.create({ ...v1CheckinInput, mood: 1 }, { clientRequestId: "checkin-v1-key" }))).conflict, true);
const v1CheckinUpdated = await run("account-a", () => checkins.update(
  v1Checkin.value.id,
  { mood: 5 },
  { expectedVersion: 1 }
));
assert.equal(v1CheckinUpdated.value.version, 2);
assert.deepEqual({
  mood: v1CheckinUpdated.value.mood,
  energy: v1CheckinUpdated.value.energy,
  stress: v1CheckinUpdated.value.stress,
  sleep: v1CheckinUpdated.value.sleep
}, { mood: 5, energy: 4, stress: 2, sleep: 4 });
assert.deepEqual(await run("account-a", () => checkins.update(
  v1Checkin.value.id,
  { ...v1CheckinInput, mood: 2 },
  { expectedVersion: 1 }
)), { versionConflict: true, currentVersion: 2 });

const otherCheckin = (await run("account-b", () => checkins.create({
  occurredAt: checkinTime,
  mood: 2,
  energy: 2,
  stress: 2,
  sleep: 2
}))).value;
assert.notEqual(createdCheckin.id, otherCheckin.id);
assert.deepEqual(await run("account-b", () => checkins.update(createdCheckin.id, {
  occurredAt: checkinTime,
  mood: 1,
  energy: 1,
  stress: 1,
  sleep: 1
})), { missing: true });

const storedCheckin = accounts.get("account-a").checkins.find(item => item.id === createdCheckin.id);
Object.assign(storedCheckin, {
  createdAt: "2026-09-28T00:00:00.000Z",
  version: 7,
  annotations: [{ id: "opaque-checkin-annotation" }],
  extension: { retained: true }
});
const originalCheckin = structuredClone(storedCheckin);
const updatedCheckin = (await run("account-a", () => checkins.update(createdCheckin.id, {
  occurredAt: "2026-10-01T09:08:07.000Z",
  mood: 4,
  energy: 2,
  stress: 5,
  sleep: 3,
  factors: ["补记因素"],
  custom: { 平静: 4 },
  notes: { [`${"m".repeat(70)}`]: "更新备注" }
}))).value;
assert.equal(updatedCheckin.createdAt, originalCheckin.createdAt);
assert.equal(updatedCheckin.version, 7);
assert.deepEqual(updatedCheckin.annotations, originalCheckin.annotations);
assert.deepEqual(updatedCheckin.extension, originalCheckin.extension);
assert.equal(Object.keys(updatedCheckin.notes)[0].length, 60);
assert.equal(updatedCheckin.occurredAt, "2026-10-01T09:08:07.000Z");

const checkinBeforeInvalidTime = structuredClone(accounts.get("account-a").checkins);
assert.deepEqual(await run("account-a", () => checkins.update(createdCheckin.id, {
  occurredAt: "not-a-time",
  mood: 1
})), { error: "发生时间格式不正确" });
assert.deepEqual(accounts.get("account-a").checkins, checkinBeforeInvalidTime);
const checkinAttemptsBeforeInvalidCreate = updateAttempts.get("account-a:checkins");
assert.deepEqual(await run("account-a", () => checkins.create({
  occurredAt: "not-a-time",
  mood: 3
})), { error: "发生时间格式不正确" });
assert.equal(updateAttempts.get("account-a:checkins"), checkinAttemptsBeforeInvalidCreate);

const weightTime = "2026-09-29T02:03:04.000Z";
const createdWeight = (await run("account-a", () => dailyRecords.create({
  type: "weight",
  occurredAt: weightTime,
  measuredWeight: 70,
  bodyWaterMass: 42.2,
  clothing: "light",
  description: " 原始体成分 ",
  attachmentPaths: ["/attachments/weight.png", "https://invalid.example/image.png"]
}))).value;
assert.deepEqual({
  adjustedWeight: createdWeight.adjustedWeight,
  lower95: createdWeight.lower95,
  upper95: createdWeight.upper95,
  source: createdWeight.source,
  attachmentPaths: createdWeight.attachmentPaths
}, {
  adjustedWeight: 69.5,
  lower95: 69.1,
  upper95: 69.9,
  source: "manual",
  attachmentPaths: ["/attachments/weight.png"]
});
assert.equal(Object.hasOwn(createdWeight, "version"), false);
assert.equal((await run("account-a", () => dailyRecords.get(createdWeight.id))).id, createdWeight.id);
assert.equal((await run("account-a", () => dailyRecords.list({ limit: 1 }))).items.length, 1);

const v1HealthInput = {
  type: "heartRate",
  occurredAt: "2026-09-29T04:00:00.000Z",
  minimum: 52,
  maximum: 116,
  trendAnalysis: "运动后回落正常",
  average: 66
};
const v1Health = await run("account-a", () => dailyRecords.create(v1HealthInput, { clientRequestId: "health-v1-key" }));
assert.equal(v1Health.value.version, 1);
assert.equal(v1Health.duplicate, false);
assert.equal((await run("account-a", () => dailyRecords.create(v1HealthInput, { clientRequestId: "health-v1-key" }))).duplicate, true);
assert.equal((await run("account-a", () => dailyRecords.create({ ...v1HealthInput, average: 77 }, { clientRequestId: "health-v1-key" }))).conflict, true);
const v1HealthUpdated = await run("account-a", () => dailyRecords.update(
  v1Health.value.id,
  { average: 68 },
  { expectedVersion: 1 }
));
assert.equal(v1HealthUpdated.value.version, 2);
assert.deepEqual({
  minimum: v1HealthUpdated.value.minimum,
  maximum: v1HealthUpdated.value.maximum,
  average: v1HealthUpdated.value.average,
  trendAnalysis: v1HealthUpdated.value.trendAnalysis
}, { minimum: 52, maximum: 116, average: 68, trendAnalysis: "运动后回落正常" });
assert.deepEqual(await run("account-a", () => dailyRecords.update(
  v1Health.value.id,
  { ...v1HealthInput, average: 70 },
  { expectedVersion: 1 }
)), { versionConflict: true, currentVersion: 2 });

const createdSleep = (await run("account-b", () => dailyRecords.create({
  type: "sleep",
  occurredAt: weightTime,
  deepMinutes: 100,
  lightMinutes: 200,
  remMinutes: 60
}))).value;
assert.equal(createdSleep.totalMinutes, 360);
assert.deepEqual(await run("account-b", () => dailyRecords.update(createdWeight.id, {
  occurredAt: weightTime,
  measuredWeight: 80
})), { missing: true });

const storedWeight = accounts.get("account-a").dailyRecords.find(item => item.id === createdWeight.id);
Object.assign(storedWeight, {
  createdAt: "2026-09-28T01:00:00.000Z",
  version: 4,
  annotations: [{ id: "opaque-health-annotation" }],
  annotationDrift: [{ id: "opaque-health-drift" }],
  extension: { retained: true }
});
const originalWeight = structuredClone(storedWeight);
const updatedWeight = (await run("account-a", () => dailyRecords.update(createdWeight.id, {
  occurredOn: "2026-10-01",
  measuredWeight: null,
  description: "核对后修改",
  musclePercent: null
}))).value;
assert.equal(updatedWeight.createdAt, originalWeight.createdAt);
assert.equal(updatedWeight.version, 4);
assert.equal(updatedWeight.bodyWaterMass, 42.2);
assert.equal(updatedWeight.measuredWeight, null);
assert.equal(updatedWeight.adjustedWeight, null);
assert.deepEqual(updatedWeight.attachmentPaths, originalWeight.attachmentPaths);
assert.deepEqual(updatedWeight.annotations, originalWeight.annotations);
assert.deepEqual(updatedWeight.annotationDrift, originalWeight.annotationDrift);
assert.deepEqual(updatedWeight.extension, originalWeight.extension);
assert.equal(updatedWeight.occurredOn, "2026-10-01");

const healthBeforeInvalidTime = structuredClone(accounts.get("account-a").dailyRecords);
assert.deepEqual(await run("account-a", () => dailyRecords.update(createdWeight.id, {
  occurredAt: "not-a-time",
  description: "不应保存"
})), { error: "发生时间格式不正确" });
assert.deepEqual(accounts.get("account-a").dailyRecords, healthBeforeInvalidTime);
assert.deepEqual(await run("account-a", () => dailyRecords.create({
  type: "exercise",
  occurredAt: weightTime,
  exerciseType: "力量训练",
  durationSeconds: 30,
  warmUpSeconds: 20,
  aerobicSeconds: 20
})), { error: "心率区间时长合计不能超过运动时长" });

for (const [collection, service, createInput, updateId, updateInput] of [
  ["checkins", checkins, {
    occurredAt: checkinTime,
    mood: 3,
    energy: 3,
    stress: 3,
    sleep: 3
  }, createdCheckin.id, {
    occurredAt: checkinTime,
    mood: 1,
    energy: 1,
    stress: 1,
    sleep: 1
  }],
  ["dailyRecords", dailyRecords, {
    type: "heartRate",
    occurredAt: weightTime,
    average: 60
  }, createdWeight.id, {
    occurredAt: weightTime,
    measuredWeight: 72
  }]
]) {
  const key = `account-a:${collection}`;
  const before = structuredClone(accounts.get("account-a")[collection]);
  failedCommits.add(key);
  await assert.rejects(run("account-a", () => service.update(updateId, updateInput)), /commit unavailable/);
  await assert.rejects(run("account-a", () => service.create(createInput)), /commit unavailable/);
  failedCommits.delete(key);
  assert.deepEqual(accounts.get("account-a")[collection], before);
}
assert.equal(accounts.get("account-b").checkins[0].mood, 2);
assert.equal(accounts.get("account-b").dailyRecords[0].id, createdSleep.id);

function httpHarness(createHttp, pathname, missingMessage) {
  const calls = [];
  const records = {
    async create(input) {
      calls.push(["create", input]);
      return input.invalid ? { error: "输入无效" } : { value: { id: "created", ...input } };
    },
    async update(id, input) {
      calls.push(["update", id, input]);
      if (id === "missing") return { missing: true };
      if (input.invalid) return { error: "输入无效" };
      return { value: { id, ...input } };
    }
  };
  const http = createHttp({
    records,
    async remove(id) {
      calls.push(["remove", id]);
      return { id: `trash-${id}` };
    },
    async sendTrashResult(res, entry, message) {
      calls.push(["trash", entry, message]);
      res.status = 200;
      res.value = { removed: 1, trashId: entry.id };
    },
    bodyJson: async req => req.body,
    sendJson(res, status, value) {
      res.status = status;
      res.value = value;
    }
  });
  return { http, pathname, missingMessage, calls };
}

for (const harness of [
  httpHarness(createCheckinHttp, "/api/checkins", "这次状态记录不存在"),
  httpHarness(createHealthRecordHttp, "/api/daily-records", "这条每日记录不存在")
]) {
  let response = {};
  assert.equal(await harness.http.handle({ method: "POST", body: { marker: "create" } }, response, new URL(`http://local${harness.pathname}`)), true);
  assert.deepEqual(response, { status: 201, value: { id: "created", marker: "create" } });
  response = {};
  await harness.http.handle({ method: "POST", body: { invalid: true } }, response, new URL(`http://local${harness.pathname}`));
  assert.deepEqual(response, { status: 400, value: { error: "输入无效" } });
  response = {};
  await harness.http.handle({ method: "PATCH", body: {} }, response, new URL(`http://local${harness.pathname}/missing`));
  assert.deepEqual(response, { status: 404, value: { error: harness.missingMessage } });
  response = {};
  await harness.http.handle({ method: "PATCH", body: { marker: "update" } }, response, new URL(`http://local${harness.pathname}/record-1`));
  assert.deepEqual(response, { status: 200, value: { id: "record-1", marker: "update" } });
  response = {};
  await harness.http.handle({ method: "PATCH", body: { invalid: true } }, response, new URL(`http://local${harness.pathname}/record-1`));
  assert.deepEqual(response, { status: 400, value: { error: "输入无效" } });
  response = {};
  assert.equal(await harness.http.handle({ method: "DELETE" }, response, new URL(`http://local${harness.pathname}/record-1`)), true);
  assert.deepEqual(response, { status: 200, value: { removed: 1, trashId: "trash-record-1" } });
  assert.deepEqual(harness.calls.slice(-2), [
    ["remove", "record-1"],
    ["trash", { id: "trash-record-1" }, harness.missingMessage]
  ]);
  assert.equal(await harness.http.handle({ method: "GET" }, {}, new URL(`http://local${harness.pathname}`)), false);
}
assert.equal(await httpHarness(createHealthRecordHttp, "/api/daily-records", "").http.handle(
  { method: "POST", body: {} },
  {},
  new URL("http://local/api/images/parse")
), false);

console.log("Checkin/health contracts passed: CRUD payloads, HTTP compatibility, event time, versions, original metadata, account isolation, trash delegation and failed commits.");
