import assert from "node:assert/strict";
import OSS from "ali-oss";
import {
  createAttachmentDelivery, validateDeliveryConfig, MEDIA_DELIVERY_TTL_SECONDS
} from "../src/shared/attachments/index.mjs";
import { loadAttachmentConfig, loadAppConfig } from "../src/config/index.mjs";

const defaults = loadAttachmentConfig({});
assert.equal(defaults.delivery.mode, "proxy");
assert.equal(MEDIA_DELIVERY_TTL_SECONDS, 60);
const config = {
  mode: "cdn-signed", bucket: "synthetic-delivery", endpoint: "https://oss-cn-beijing.aliyuncs.com",
  cdnOrigin: "https://media.synthetic.test", cdnKey: "syntheticKey123456"
};
for (const bad of [
  { ...config, mode: "public" }, { ...config, bucket: "synthetic-originals" },
  { ...config, endpoint: "http://oss-cn-beijing.aliyuncs.com" },
  { ...config, endpoint: "https://oss-cn-beijing-internal.aliyuncs.com" },
  { ...config, endpoint: "https://user:secret@oss-cn-beijing.aliyuncs.com" },
  { ...config, cdnOrigin: "https://media.synthetic.test/path" },
  { ...config, cdnOrigin: "https://media.synthetic.test/?token=secret" },
  { ...config, cdnKey: "" }
]) assert.throws(() => validateDeliveryConfig(bad, "synthetic-originals"));
assert.throws(() => loadAppConfig({ rootDir: "/tmp", env: {
  LOCAL_TEST_MODE: "1", MEDIA_DELIVERY_MODE: "cdn-signed"
} }), /cannot sign cloud/);
assert.throws(() => loadAppConfig({ rootDir: "/tmp", env: {
  NODE_ENV: "production", MEDIA_DELIVERY_MODE: "oss-signed", ATTACHMENT_STORAGE: "local"
} }), /requires OSS/);

const objects = new Map();
const calls = [];
let unavailable = false;
const sdk = new OSS({
  region: "oss-cn-beijing", bucket: config.bucket, endpoint: config.endpoint,
  accessKeyId: "synthetic-id", accessKeySecret: "synthetic-secret", stsToken: "synthetic-token"
});
const client = {
  async put(key, data, options) {
    if (unavailable) throw new Error("synthetic outage");
    calls.push({ action: "put", key, options });
    objects.set(key, Buffer.from(data));
  },
  async delete(key) {
    if (unavailable) throw new Error("synthetic outage");
    calls.push({ action: "delete", key }); objects.delete(key);
  },
  async getObjectMeta(key) {
    if (unavailable) throw new Error("synthetic outage");
    if (!objects.has(key)) throw Object.assign(new Error("synthetic missing"), { code: "NoSuchKey" });
    return { res: { headers: { "content-length": objects.get(key).length } } };
  },
  signatureUrlV4: (...args) => sdk.signatureUrlV4(...args)
};
const clock = { now: 1_790_000_000_000 };
const create = mode => createAttachmentDelivery({
  config: { ...config, mode }, sourceBucket: "synthetic-originals", getClient: async () => client,
  now: () => clock.now, nonce: () => "1234567890abcdef"
});
const cdn = create("cdn-signed");
const request = { ownerId: "account-a", name: "synthetic-1.thumb.webp", bytes: 8, method: "GET" };
assert.equal(await cdn.put({ ...request, data: Buffer.from("12345678"), mimeType: "image/webp" }), true);
assert.equal(calls[0].options.headers["x-oss-object-acl"], "private");
assert.equal(calls[0].key.includes("account-a"), false);
assert.equal(calls[0].key.startsWith("delivery/"), true);
const signed = await cdn.sign(request);
const url = new URL(signed.url);
assert.equal(url.origin, config.cdnOrigin);
assert.equal(signed.ttlSeconds, 60);
assert.match(url.searchParams.get("auth_key"), /^1790000000-1234567890abcdef-0-[a-f0-9]{32}$/);
assert.equal([...url.searchParams.keys()].join(), "auth_key");
assert.equal(await cdn.sign({ ...request, ownerId: "account-b" }), null);
assert.equal(await cdn.sign({ ...request, bytes: 9 }), null);
assert.equal(await cdn.sign({ ...request, method: "PUT" }), null);
assert.equal(await cdn.sign({ ...request, name: "../synthetic-1.thumb.webp" }), null);
for (const name of ["image.original.png", "image.source-mask.png", "image.edit.webp", "image.alpha.webp", "raw.m4a", "raw.mp3"]) {
  assert.equal(await cdn.put({ ...request, name, data: Buffer.from("12345678") }), false);
  assert.equal(await cdn.sign({ ...request, name }), null);
}
const oss = create("oss-signed");
const getUrl = new URL((await oss.sign(request)).url);
const headUrl = new URL((await oss.sign({ ...request, method: "HEAD" })).url);
assert.equal(getUrl.protocol, "https:");
assert.equal(getUrl.searchParams.get("x-oss-signature-version"), "OSS4-HMAC-SHA256");
assert.equal(getUrl.searchParams.get("x-oss-expires"), "60");
assert.equal(getUrl.searchParams.has("auth_key"), false);
assert.notEqual(getUrl.searchParams.get("x-oss-signature"), headUrl.searchParams.get("x-oss-signature"));
unavailable = true;
assert.equal(await cdn.sign(request), null);
assert.equal(await cdn.put({ ...request, data: Buffer.from("12345678") }), false);
await assert.rejects(cdn.remove(request), /synthetic outage/);
unavailable = false;
const proxy = create("proxy");
assert.equal(await proxy.sign(request), null);
assert.equal(await proxy.put({ ...request, data: Buffer.from("12345678") }), false);
await proxy.remove(request);
assert.equal(objects.has(cdn.objectKey(request.ownerId, request.name)), false);
assert.equal(await cdn.sign(request), null);
console.log("Attachment delivery checks passed: private separate bucket, 60s Type A/V4, account namespace, derivative allowlist, method signing, outage fallback and purge after proxy rollback. External calls: 0.");
