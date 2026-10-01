import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { strictDateKey, localDateTimeOn, eventTimeFields, localDateKey } from "../src/shared/time/index.mjs";
import {
  normalizeKeepsake,
  keepsakePayload,
  createKeepsakeRecords,
  publicKeepsake,
  originalKeepsakeMedia
} from "../src/modules/keepsakes/index.mjs";
import { createKeepsakeHttp } from "../src/http/index.mjs";

for (const value of ["2024-02-29", "2026-09-29", "2000-02-29"]) assert.equal(strictDateKey(value), value);
for (const value of ["2026-02-29", "1900-02-29", "2026-13-01", "2026-09-31", "bad"]) assert.equal(strictDateKey(value), null);
assert.equal(strictDateKey(""), "");
assert.equal(strictDateKey(" 2026-09-29 "), "2026-09-29");
assert.equal(localDateTimeOn("bad", new Date()), "");
assert.equal(localDateTimeOn("2026-09-29", "bad"), "");
assert.equal(eventTimeFields({ occurredAt: "" }), null);
assert.equal(eventTimeFields({ occurredAt: "bad", occurredOn: "2026-09-29" }), null);
assert.equal(eventTimeFields({ occurredOn: "" }), null);
assert.equal(eventTimeFields({}, { occurredAt: "bad" }), null);
const originalTime = "2026-09-28T16:20:30.456Z";
assert.deepEqual(eventTimeFields({}, { occurredAt: originalTime }), { occurredAt: originalTime, occurredOn: localDateKey(originalTime) });
const enteredAt = Date.now(), generated = eventTimeFields();
assert.ok(Date.parse(generated.occurredAt) >= enteredAt && Date.parse(generated.occurredAt) <= Date.now());
const submittedNow = "2026-09-29T16:00:05.678Z";
assert.deepEqual(
  eventTimeFields({ timeMode: "now", occurredAt: "2026-09-29T15:58:00.000Z" }, null, { now: () => submittedNow }),
  { occurredAt: submittedNow, occurredOn: localDateKey(submittedNow) }
);
for (const current of ["2026-09-29T15:59:40.000Z", "2026-10-02T00:30:00.000Z"]) {
  assert.deepEqual(
    eventTimeFields({ timeMode: "now" }, null, { now: () => current }),
    { occurredAt: current, occurredOn: localDateKey(current) }
  );
}
assert.deepEqual(
  eventTimeFields({ timeMode: "manual", occurredAt: "2026-09-20T09:08:07" }, null, { now: () => submittedNow }),
  {
    occurredAt: new Date("2026-09-20T09:08:07").toISOString(),
    occurredOn: localDateKey(new Date("2026-09-20T09:08:07"))
  }
);
assert.equal(eventTimeFields({ timeMode: "manual" }, null, { now: () => submittedNow }), null);
assert.equal(eventTimeFields({ timeMode: "manual", occurredAt: "2026-02-31T09:08:07" }, null, { now: () => submittedNow }), null);
assert.equal(eventTimeFields({ timeMode: "later" }, null, { now: () => submittedNow }), null);

const zoneScript = `
  import assert from "node:assert/strict";
  import { localDateKey, shiftDateKey, eventTimeFields } from "../src/shared/time/index.mjs";
  const original = "2026-09-28T16:20:30.456Z";
  const expected = process.env.TZ === "Asia/Shanghai" ? "2026-09-29" : "2026-09-28";
  assert.equal(localDateKey(original), expected);
  const changed = eventTimeFields({ occurredOn: "2026-10-01" }, { occurredAt: original });
  assert.equal(changed.occurredOn, "2026-10-01");
  const a = new Date(original), b = new Date(changed.occurredAt);
  for (const method of ["getHours", "getMinutes", "getSeconds", "getMilliseconds"]) assert.equal(a[method](), b[method]());
  assert.equal(shiftDateKey("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDateKey("2024-02-28", 1), "2024-02-29");
  // Legacy event date parsing rolls excess days; strict calendar validation above does not.
  assert.equal(eventTimeFields({ occurredOn: "2026-02-31" }, { occurredAt: original }).occurredOn, "2026-03-03");
  const local = eventTimeFields({ occurredAt: "2026-09-29T00:01:00" });
  assert.equal(local.occurredOn, "2026-09-29");
  if (process.env.TZ === "America/New_York") {
    assert.equal(eventTimeFields({ occurredAt: "2026-03-08T02:30:00" }).occurredAt, "2026-03-08T07:30:00.000Z");
  }
`;
for (const zone of ["UTC", "Asia/Shanghai", "America/New_York"]) {
  execFileSync(process.execPath, ["--input-type=module", "-e", zoneScript], { cwd: new URL(".", import.meta.url), env: { ...process.env, TZ: zone }, stdio: "pipe" });
}

const input = {
  title: "票券", occurredAt: originalTime,
  originalPath: "/attachments/original.png",
  thumbPath: "/attachments/thumb.webp",
  displayPath: "/attachments/display.webp",
  editPath: "/attachments/edit.webp",
  alphaMaskPath: "/attachments/mask.webp",
  category: "纸品", source: "auto", tags: ["展览", "", " ".repeat(2)], note: "当天记录", edgeExpansion: 8
};
const eventTime = eventTimeFields(input), normalized = normalizeKeepsake({ id: "old", ...input, version: 0, extension: { keep: true } }, eventTime);
assert.equal(normalized.version, 1);
assert.deepEqual(normalized.extension, { keep: true });
assert.deepEqual(normalized.tags, ["展览"]);
assert.equal(normalizeKeepsake({ ...input, originalPath: "https://external.invalid/image" }, eventTime).validationState, "invalid");
assert.equal(keepsakePayload({ title: " ", occurredAt: "bad" }).error, "请填写小物名称");
assert.equal(keepsakePayload({ ...input, occurredAt: "bad" }).error, "留存时间格式不正确");
assert.equal(keepsakePayload({ ...input, originalPath: "" }).error, "请先完成原图和全部派生图保存");
assert.equal(keepsakePayload({ ...input, thumbPath: "" }).error, "请先完成原图和全部派生图保存");
const partial = keepsakePayload({ title: "修改" }, normalized).value;
assert.equal(partial.originalPath, input.originalPath); assert.equal(partial.thumbPath, input.thumbPath);
assert.equal(partial.displayPath, input.displayPath); assert.equal(partial.editPath, input.editPath);
assert.equal(partial.alphaMaskPath, input.alphaMaskPath);
assert.deepEqual(partial.tags, ["展览"]); assert.equal(partial.occurredAt, input.occurredAt);
assert.equal(partial.note, ""); assert.equal(partial.edgeExpansion, 0);
assert.equal(keepsakePayload({ title: "修改", source: "manual" }, normalized).value.source, "auto");
assert.deepEqual(keepsakePayload({ title: "修改", tags: null }, normalized).value.tags, []);
assert.equal(keepsakePayload({ ...input, edgeExpansion: 500 }).value.edgeExpansion, 20);
assert.equal("originalPath" in publicKeepsake(normalized), false);
assert.equal(publicKeepsake(normalized).displayPath, input.displayPath);
assert.deepEqual(originalKeepsakeMedia(normalized), { originalPath: input.originalPath });
const legacy = normalizeKeepsake({
  id: "legacy", title: "旧小物", occurredAt: originalTime,
  originalPath: "/attachments/legacy-original.jpg", cutoutPath: "/attachments/legacy-cutout.png"
}, eventTime);
assert.equal(legacy.derivativeState, "legacy");
assert.equal(legacy.thumbPath, "/attachments/legacy-cutout.png");
assert.equal(legacy.displayPath, "/attachments/legacy-cutout.png");
assert.equal(publicKeepsake(legacy).originalPath, undefined);

let httpResponse, httpCreateOptions;
const keepsakeHttp = createKeepsakeHttp({
  records: {
    create: async (_input, options) => { httpCreateOptions = options; return { value: normalized, duplicate: Boolean(options.clientRequestId) }; },
    update: async () => ({ value: normalized })
  },
  bodyJson: async req => req.body,
  sendJson: (_res, status, value) => { httpResponse = { status, value }; },
  present: publicKeepsake,
  getOriginal: async id => id === normalized.id ? originalKeepsakeMedia(normalized) : null
});
await keepsakeHttp.handle({ method: "POST", body: input }, {}, new URL("http://local/api/keepsakes"));
assert.equal(httpResponse.status, 201);
assert.equal("originalPath" in httpResponse.value, false);
await keepsakeHttp.handle({ method: "POST", headers: { "idempotency-key": "keepsake-http-1" }, body: input }, {}, new URL("http://local/api/keepsakes"));
assert.equal(httpResponse.status, 200);
assert.deepEqual(httpCreateOptions, { clientRequestId: "keepsake-http-1" });
await keepsakeHttp.handle({ method: "GET" }, {}, new URL(`http://local/api/keepsakes/${normalized.id}/original`));
assert.deepEqual(httpResponse, { status: 200, value: { originalPath: input.originalPath } });
await keepsakeHttp.handle({ method: "GET" }, {}, new URL("http://local/api/keepsakes/missing/original"));
assert.equal(httpResponse.status, 404);

const context = new AsyncLocalStorage(), accounts = new Map([["a", []], ["b", []]]);
let sequence = 0, failCommit = false;
const records = createKeepsakeRecords({
  repository: { async update(mutate) {
    const id = context.getStore(), current = structuredClone(accounts.get(id));
    const result = mutate(current);
    if (failCommit) throw new Error("commit unavailable");
    accounts.set(id, current);
    return result;
  } },
  now: () => "2026-09-29T01:02:03.004Z", createId: () => `keepsake-${++sequence}`
});
const run = (id, operation) => context.run(id, operation);
const [a, b] = await Promise.all(["a", "b"].map(id => run(id, () => records.create(input))));
assert.notEqual(a.value.id, b.value.id);
assert.equal(accounts.get("a").length, 1); assert.equal(accounts.get("b").length, 1);
assert.equal(a.value.createdAt, "2026-09-29T01:02:03.004Z");
assert.equal(a.value.occurredAt, originalTime);
assert.deepEqual(await run("b", () => records.update(a.value.id, { title: "越权" })), { missing: true });
const before = structuredClone(accounts.get("a"));
assert.deepEqual(await run("a", () => records.update(a.value.id, { title: "" })), { error: "请填写小物名称" });
assert.deepEqual(accounts.get("a"), before);
failCommit = true;
await assert.rejects(run("a", () => records.update(a.value.id, { title: "失败" })), /commit unavailable/);
await assert.rejects(run("a", () => records.create(input)), /commit unavailable/);
assert.deepEqual(accounts.get("a"), before);
failCommit = false;
const updated = (await run("a", () => records.update(a.value.id, { title: "新标题", occurredOn: "2026-10-01" }))).value;
assert.equal(updated.createdAt, before[0].createdAt);
assert.equal(updated.occurredOn, "2026-10-01");
assert.equal(updated.originalPath, before[0].originalPath);
assert.equal(accounts.get("b")[0].title, "票券");

const idempotentStore = { keepsakes: [], trash: [] }, idempotency = new Map();
const idempotentRecords = createKeepsakeRecords({
  repository: {
    read: async () => structuredClone(idempotentStore.keepsakes),
    update: async mutate => mutate(idempotentStore.keepsakes, idempotentStore.trash),
    executeIdempotent: async (request, operation, { onReplay = value => value } = {}) => {
      const key = `${request.scope}:${request.key}`, prior = idempotency.get(key);
      if (prior) {
        if (prior.requestHash !== request.requestHash) throw Object.assign(new Error("reused"), { code: "IDEMPOTENCY_KEY_REUSED" });
        return onReplay(structuredClone(prior.response));
      }
      const response = await operation(idempotentStore.keepsakes, idempotentStore.trash);
      idempotency.set(key, { requestHash: request.requestHash, response: structuredClone(response) });
      return response;
    }
  },
  now: () => "2026-09-29T01:02:03.004Z",
  createId: () => "keepsake-idempotent"
});
const firstIdempotent = await idempotentRecords.create(input, { clientRequestId: "keepsake-create-1" });
const replayedIdempotent = await idempotentRecords.create(input, { clientRequestId: "keepsake-create-1" });
assert.equal(firstIdempotent.value.id, "keepsake-idempotent");
assert.equal(replayedIdempotent.value.id, firstIdempotent.value.id);
assert.equal(replayedIdempotent.duplicate, true);
assert.equal(idempotentStore.keepsakes.length, 1);
assert.deepEqual(
  await idempotentRecords.create({ ...input, title: "不同内容" }, { clientRequestId: "keepsake-create-1" }),
  { conflict: true }
);
console.log("Keepsake/time contracts passed: calendar/timezone boundaries, legacy event parsing, payload compatibility, original data, account scoping and failed commits.");
