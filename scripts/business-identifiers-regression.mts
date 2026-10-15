/**
 * 账户业务身份的碰撞、并发作用域与耗尽回滚验证。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：合成文档与注入随机源；不读取生产、不分配协议身份。
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import { BUSINESS_ID_BYTES, encodeBusinessId, isBusinessId } from "../src/shared/business-identifiers/index.mjs";
import { createBusinessId, withBusinessIdTransaction } from "../src/shared/persistence/business-identifiers.mjs";
import { projectRoot } from "./project-root.mjs";

const bytes = (value: number) => new Uint8Array(BUSINESS_ID_BYTES).fill(value);
assert.equal(encodeBusinessId(bytes(255)), "________________");
assert.equal(encodeBusinessId(bytes(0)), "AAAAAAAAAAAAAAAA");
assert.ok(isBusinessId(encodeBusinessId(bytes(17))));
assert.ok(!isBusinessId("历史-uuid"));
assert.throws(() => createBusinessId(), { code: "BUSINESS_ID_TRANSACTION_REQUIRED" });
let calls = 0;
const document = {
  books: [{ id: "old-uuid", annotations: [{ replies: [{ id: encodeBusinessId(bytes(1)) }] }] }],
  trash: [{ payload: { items: [{ id: encodeBusinessId(bytes(2)) }] } }],
  lifecycle: [{ resourceId: encodeBusinessId(bytes(3)) }]
};
withBusinessIdTransaction(document, () => {
  assert.equal(createBusinessId(), encodeBusinessId(bytes(4)));
  assert.equal(createBusinessId(), encodeBusinessId(bytes(5)));
}, () => bytes(++calls));
assert.equal(calls, 5);
let exhausted = 0;
assert.throws(() => withBusinessIdTransaction(document, () => createBusinessId(), () => {
  exhausted += 1;
  return bytes(2);
}), { code: "BUSINESS_ID_COLLISION_EXHAUSTED", statusCode: 503 });
assert.equal(exhausted, 8);
const concurrent = await Promise.all([7, 8].map(value => withBusinessIdTransaction({}, async () => {
  await Promise.resolve();
  return createBusinessId();
}, () => bytes(value))));
assert.deepEqual(concurrent, [7, 8].map(value => encodeBusinessId(bytes(value))));
console.log("业务身份格式、子项/回收站占用、8次耗尽及异步账户隔离通过。");

const root = projectRoot(import.meta.url);
const runtimeImport = (name: string) => import(pathToFileURL(path.join(root, name)).href);
const { createJsonStoreRepository } = await runtimeImport("src/shared/persistence/json-repository.mjs");
const { createBusinessId: createRuntimeBusinessId, withBusinessIdTransaction: withRuntimeBusinessIdTransaction } = await runtimeImport(".build/typescript/backend/shared/persistence/business-identifiers.mjs");
let savedDocument: Record<string, unknown> = { thoughts: [], captures: [], trash: [] };
const body = "{}";
const context: Record<string, unknown> = {
  user: { id: "account-a" }, method: "POST", resource: "/api/v1/captures", contentType: "application/json",
  requestBodySha256: crypto.createHash("sha256").update(body).digest("hex"),
  clientOperationId: "create-capture", clientProvisionalId: encodeBusinessId(bytes(19))
};
context.clientOperationFingerprint = crypto.createHash("sha256").update(JSON.stringify({
  method: context.method, resource: context.resource, contentType: context.contentType,
  ifMatch: "", requestBodySha256: context.requestBodySha256
})).digest("hex");
const repository = createJsonStoreRepository({ getFile: () => "synthetic-account-a",
  readDocument: async () => structuredClone(savedDocument),
  writeDocument: async (_file: string, value: Record<string, unknown>) => { savedDocument = structuredClone(value); },
  normalize: (value: unknown) => value, emptyDocument: {}, getContext: () => context });
const key = { scope: "capture", key: "request-1", requestHash: "synthetic-hash" };
const result = await repository.executeIdempotent(key, (store: { captures: { id: string }[] }) => {
  const value = { id: createRuntimeBusinessId() };
  store.captures.push(value);
  return { value };
});
assert.ok(isBusinessId(result.value.id));
assert.equal(result.businessIdMapping.canonicalId, result.value.id);
assert.equal(context.operationCommitted, true);
delete context.businessIdMapping;
const replay = await repository.executeIdempotent(key, () => { throw new Error("不得重新创建"); });
assert.equal(replay.value.id, result.value.id);
assert.deepEqual(context.businessIdMapping, result.businessIdMapping);
const snapshot = await repository.readSyncSnapshot();
assert.deepEqual(snapshot.metadata.sync.operations[0].businessIdMapping, result.businessIdMapping);
const beforeFailure = structuredClone(savedDocument);
await assert.rejects(repository.update((store: { captures: { id: string }[] }) => {
  store.captures.push({ id: createRuntimeBusinessId() });
  throw new Error("synthetic rollback");
}));
assert.deepEqual(savedDocument, beforeFailure);
await assert.rejects(repository.update((store: { captures: { id: string }[] }) => {
  return withRuntimeBusinessIdTransaction(store, () => {
    store.captures.push({ id: "uncommitted-before-collision" });
    return createRuntimeBusinessId();
  }, () => Buffer.from(result.value.id, "base64url"));
}), { code: "BUSINESS_ID_COLLISION_EXHAUSTED" });
assert.deepEqual(savedDocument, beforeFailure);

const { createMemorySyncStore, createRequestCoordinator, syncOperationFingerprint } = await runtimeImport("public/frontend/sync/index.mjs");
const syncStore = createMemorySyncStore();
const provisionalId = encodeBusinessId(bytes(23));
const canonicalId = encodeBusinessId(bytes(24));
let releaseParent!: () => void;
const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
let parentStarted!: () => void;
const started = new Promise<void>(resolve => { parentStarted = resolve; });
const sends: { url: string; body: string; headers: Record<string, string> }[] = [];
let serial = 0;
const coordinator = createRequestCoordinator({ store: syncStore, createId: () => `operation-${++serial}`,
  send: async (url: string, options: { body: string; headers: Record<string, string> }) => {
    sends.push({ url, ...options });
    if (url === "/api/v1/captures") {
      parentStarted();
      await parentGate;
      return { data: { id: canonicalId }, meta: { operation: { id: "operation-1", status: "committed",
        businessIdMapping: { accountId: "account-a", operationId: "operation-1", provisionalId, canonicalId } } } };
    }
    return { data: { saved: true }, meta: { operation: { status: "committed" } } };
  } });
const parent = coordinator.request({ owner: "account-a", url: "/api/v1/captures", allocateBusinessId: true,
  provisionalId, options: { method: "POST", body: "{}" } });
await started;
for (const kind of ["projection", "resource"] as const) {
  const url = "/api/v1/unchanged";
  const headers = { "content-type": "application/json" };
  const fingerprint = await syncOperationFingerprint({ method: "PATCH", url, headers, body: "{}" });
  await syncStore.put({ id: `${kind}-only`, owner: "account-a", operationId: `${kind}-operation`,
    status: "pending", attempts: 0, createdAt: "2026-10-14T00:00:00Z", url, method: "PATCH", body: "{}", headers,
    fingerprint, resourceKey: kind === "resource" ? `/api/v1/captures/${provisionalId}` : url,
    projection: { targetId: provisionalId },
    dependsOn: [{ operationId: "operation-1", urlSegments: kind === "resource" ? [4] : [],
      projectionPointers: kind === "projection" ? ["/targetId"] : [] }] });
}
const child = coordinator.request({ owner: "account-a", url: `/api/v1/captures/${provisionalId}`,
  dependsOn: [{ operationId: "operation-1", urlSegments: [4], bodyPointers: ["/targetId", "/sourceRef/id"] }], options: { method: "PATCH", body: JSON.stringify({ targetId: provisionalId,
    sourceRef: { id: provisionalId }, content: provisionalId, clientRequestId: provisionalId }) } });
const existing = coordinator.request({ owner: "account-a", url: `/api/v1/books/${provisionalId}`,
  options: { method: "PATCH", body: JSON.stringify({ targetId: provisionalId }) } });
const mixed = coordinator.request({ owner: "account-a", url: `/api/v1/actions/${provisionalId}`,
  dependsOn: [{ operationId: "operation-1", urlSegments: [4] }],
  options: { method: "PATCH", body: JSON.stringify({ sourceRef: { resourceType: "book", resourceId: provisionalId, rootId: provisionalId } }) } });
await new Promise(resolve => setTimeout(resolve, 10));
releaseParent();
await Promise.all([parent, child, existing, mixed]);
const childSend = sends.find(item => item.url === `/api/v1/captures/${canonicalId}`);
assert.ok(childSend);
assert.deepEqual(JSON.parse(childSend.body), { targetId: canonicalId, sourceRef: { id: canonicalId },
  content: provisionalId, clientRequestId: provisionalId });
assert.ok(sends.some(item => item.url === `/api/v1/books/${provisionalId}`));
const mixedSend = sends.find(item => item.url === `/api/v1/actions/${canonicalId}`);
assert.ok(mixedSend);
assert.deepEqual(JSON.parse(mixedSend.body), { sourceRef: { resourceType: "book", resourceId: provisionalId, rootId: provisionalId } });
assert.equal(childSend.headers["x-client-operation-id"], "operation-2");
assert.equal(childSend.headers["x-client-operation-fingerprint"], await syncOperationFingerprint({ method: "PATCH", ...childSend }));
assert.equal((await syncStore.readMappings("account-a")).length, 1);
assert.equal((await syncStore.readMappings("account-b")).length, 0);
assert.equal((await syncStore.list("account-a", ["committed"])).length, 4);
for (const kind of ["projection", "resource"] as const) {
  const row = await syncStore.get("account-a", `${kind}-only`);
  assert.equal(row.url, "/api/v1/unchanged");
  assert.equal(row.fingerprint, await syncOperationFingerprint({ method: "PATCH", url: row.url, headers: row.headers, body: row.body }));
  assert.equal(kind === "projection" ? row.projection.targetId : row.resourceKey,
    kind === "projection" ? canonicalId : `/api/v1/captures/${canonicalId}`);
}
console.log("JSON 原子回滚/幂等映射/恢复回执、显式依赖映射、碰撞已有对象保护及正文/协议身份保留通过。");

const failingStore = createMemorySyncStore();
const atomicWrite = failingStore.atomicWrite.bind(failingStore);
const failingCoordinator = createRequestCoordinator({ store: failingStore, createId: () => "failure-operation",
  send: async (url: string) => {
    if (url.startsWith("/api/v1/sync/operations/")) return { data: { status: "unknown" } };
    failingStore.atomicWrite = async () => false;
    return { data: { id: canonicalId }, meta: { operation: { status: "committed",
      businessIdMapping: { accountId: "account-a", operationId: "failure-operation", provisionalId, canonicalId } } } };
  } });
await assert.rejects(failingCoordinator.request({ owner: "account-a", url: "/api/v1/captures", allocateBusinessId: true,
  provisionalId, options: { method: "POST", body: "{}" } }));
assert.equal((await failingStore.list("account-a"))[0].status, "pending");
assert.equal((await failingStore.list("account-a"))[0].body, "{}");
assert.equal((await failingStore.readMappings("account-a")).length, 0);
failingStore.atomicWrite = atomicWrite;
console.log("碰撞耗尽不提交、原子 ACK 保存失败保留 pending 和请求体通过。");
