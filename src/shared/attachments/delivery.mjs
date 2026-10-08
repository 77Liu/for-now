import crypto from "node:crypto";
import OSS from "ali-oss";
import Credential from "@alicloud/credentials";

export const MEDIA_DELIVERY_TTL_SECONDS = 60;
const MODES = new Set(["proxy", "oss-signed", "cdn-signed"]);
const deliveryName = name => /^[\w-]+\.(?:(?:thumb|display)\.webp|tts\.mp3)$/.test(name || "");
const header = (headers, name) => Object.entries(headers || {})
  .find(([key]) => key.toLowerCase() === name)?.[1];

export function validateDeliveryConfig(value = {}, sourceBucket = "") {
  const mode = value.mode || "proxy";
  if (!MODES.has(mode)) throw new Error("MEDIA_DELIVERY_MODE must be proxy, oss-signed, or cdn-signed");
  if (mode === "proxy" && !value.bucket) return Object.freeze({ mode });
  const bucket = String(value.bucket || "");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || bucket === sourceBucket) {
    throw new Error("Media delivery requires a separate private distribution bucket");
  }
  const endpoint = new URL(value.endpoint || "https://invalid.local");
  if (!value.endpoint || endpoint.protocol !== "https:" || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || !["", "/"].includes(endpoint.pathname)
    || /(?:-internal|localhost|invalid\.local)/i.test(endpoint.hostname)) {
    throw new Error("Media delivery requires a public HTTPS OSS endpoint");
  }
  const config = { mode, bucket, endpoint: endpoint.origin, region: value.region || "cn-beijing" };
  if (mode === "cdn-signed") {
    const origin = new URL(value.cdnOrigin || "https://invalid.local");
    if (!value.cdnOrigin || origin.protocol !== "https:" || origin.username || origin.password
      || origin.search || origin.hash || !["", "/"].includes(origin.pathname)) {
      throw new Error("MEDIA_CDN_ORIGIN must be an HTTPS origin");
    }
    if (!/^[A-Za-z0-9]{6,128}$/.test(value.cdnKey || "")) {
      throw new Error("MEDIA_CDN_AUTH_KEY is required for Type A signing");
    }
    config.cdnOrigin = origin.origin;
    config.cdnKey = value.cdnKey;
  }
  return Object.freeze(config);
}

// Only server-created display derivatives enter this bucket. Names are immutable
// upload UUIDs; the owner hash provides an account namespace without identity text.
export function createAttachmentDelivery({
  config = {}, sourceBucket = "", roleName = "", disableIMDSv1 = true,
  getClient = null, now = () => Date.now(), nonce = () => crypto.randomBytes(8).toString("hex")
} = {}) {
  const settings = validateDeliveryConfig(config, sourceBucket);
  const credentials = !settings.bucket || getClient ? null : new Credential.default(
    roleName ? { type: "ecs_ram_role", roleName, disableIMDSv1 } : null
  );
  const client = getClient || (async () => {
    const value = await credentials.getCredential();
    return new OSS({
      accessKeyId: value.accessKeyId, accessKeySecret: value.accessKeySecret,
      stsToken: value.securityToken, bucket: settings.bucket, endpoint: settings.endpoint,
      region: settings.region.startsWith("oss-") ? settings.region : `oss-${settings.region}`,
      secure: true, retryMax: 1, timeout: 5000
    });
  });
  const objectKey = (ownerId, name) => {
    if (!ownerId || !deliveryName(name)) return "";
    const owner = crypto.createHash("sha256").update(String(ownerId)).digest("hex");
    return `delivery/${owner}/${name}`;
  };

  async function put({ ownerId, name, data, mimeType }) {
    const key = objectKey(ownerId, name);
    if (settings.mode === "proxy" || !key) return false;
    try {
      await (await client()).put(key, data, {
        mime: mimeType,
        headers: { "x-oss-object-acl": "private", "Cache-Control": "private, max-age=60" }
      });
      return true;
    } catch {
      // The durable original remains usable through proxy if replication fails.
      return false;
    }
  }

  async function remove({ ownerId, name }) {
    const key = objectKey(ownerId, name);
    if (!settings.bucket || !key) return;
    try { await (await client()).delete(key); }
    catch (error) {
      if (!["NoSuchKey", "ENOENT"].includes(error?.code) && Number(error?.status) !== 404) throw error;
    }
  }

  async function sign({ ownerId, name, method = "GET", bytes }) {
    const key = objectKey(ownerId, name);
    if (settings.mode === "proxy" || !key || !["GET", "HEAD"].includes(method)) return null;
    try {
      const store = await client();
      const metadata = await store.getObjectMeta(key);
      if (Number(header(metadata?.res?.headers, "content-length")) !== bytes) return null;
      let url;
      if (settings.mode === "oss-signed") {
        url = await store.signatureUrlV4(method, MEDIA_DELIVERY_TTL_SECONDS, undefined, key);
        const target = new URL(url);
        if (target.protocol !== "https:" || target.username || target.password
          || target.searchParams.get("x-oss-signature-version") !== "OSS4-HMAC-SHA256"
          || Number(target.searchParams.get("x-oss-expires")) !== MEDIA_DELIVERY_TTL_SECONDS) return null;
      } else {
        const pathname = `/${key}`;
        const timestamp = Math.floor(now() / 1000);
        const random = nonce();
        if (!Number.isSafeInteger(timestamp) || !/^[a-f0-9]{16}$/.test(random)) return null;
        const digest = crypto.createHash("md5")
          .update(`${pathname}-${timestamp}-${random}-0-${settings.cdnKey}`).digest("hex");
        const target = new URL(pathname, settings.cdnOrigin);
        target.searchParams.set("auth_key", `${timestamp}-${random}-0-${digest}`);
        url = target.href;
      }
      return { url, mode: settings.mode, ttlSeconds: MEDIA_DELIVERY_TTL_SECONDS };
    } catch { return null; }
  }

  return Object.freeze({ mode: settings.mode, objectKey, put, remove, sign });
}
