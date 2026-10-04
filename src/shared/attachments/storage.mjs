import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import OSS from "ali-oss";
import Credential from "@alicloud/credentials";

const cleanSegment = value => String(value || "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160);
const missing = error => ["ENOENT", "NoSuchKey"].includes(error?.code) || Number(error?.status) === 404;
const header = (headers, name) => {
  const key = Object.keys(headers || {}).find(item => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
};
const strongEtag = value => {
  const input = String(value || "").trim();
  if (!input || /^W\//i.test(input)) return "";
  const opaque = input.startsWith("\"") && input.endsWith("\"") ? input.slice(1, -1) : input;
  if (!opaque || /["\u0000-\u0020\u007f]/.test(opaque)) return "";
  return `"${opaque}"`;
};
const sourceChanged = cause => Object.assign(new Error("Attachment changed while opening its stream"), {
  code: "ATTACHMENT_SOURCE_CHANGED",
  statusCode: 503,
  ...(cause ? { cause } : {})
});

const streamRange = (bytes, { start, end } = {}) => {
  if (start === undefined && end === undefined) return null;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || end >= bytes) {
    throw new RangeError("Attachment stream range is invalid");
  }
  return { start, end };
};

const localReadSource = async file => {
  const handle = await fs.open(file, "r");
  try {
    const [entry, stat] = await Promise.all([
      fs.lstat(file, { bigint: true }),
      handle.stat({ bigint: true })
    ]);
    if (!entry.isFile() || entry.isSymbolicLink()
      || entry.dev !== stat.dev || entry.ino !== stat.ino) {
      throw new Error("Attachment must be a regular file");
    }
    const bytes = Number(stat.size);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Attachment size metadata is invalid");
    const version = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    const etag = `"${crypto.createHash("sha256").update(version).digest("base64url")}"`;
    let closed = false;
    return {
      bytes,
      etag,
      lastModified: new Date(Number(stat.mtimeMs)).toUTCString(),
      async createReadStream(options = {}) {
        if (closed) throw new Error("Attachment read source is closed");
        const current = await handle.stat({ bigint: true });
        const currentVersion = [current.dev, current.ino, current.size, current.mtimeNs, current.ctimeNs].join(":");
        if (currentVersion !== version) throw sourceChanged();
        const range = streamRange(bytes, options);
        return handle.createReadStream({
          autoClose: false,
          start: range?.start ?? 0,
          ...(range ? { end: range.end } : bytes > 0 ? { end: bytes - 1 } : {})
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        await handle.close();
      }
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
};

export function createAttachmentStorage({
  mode = "local", bucket = "", prefix = "for-now-attachments",
  endpoint = "", region = "cn-beijing", roleName = "",
  mockDir = "", testMode = false, disableIMDSv1 = true
} = {}) {
  if (!["local", "oss", "mock"].includes(mode)) throw new Error("ATTACHMENT_STORAGE must be local, oss, or mock");
  if (mode === "mock" && !testMode) throw new Error("Mock attachment storage is test-only");
  if (mode === "oss" && (!bucket || !endpoint)) throw new Error("OSS attachment storage requires OSS_ATTACHMENT_BUCKET and OSS_ENDPOINT");

  const objectPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const credentials = mode === "oss" ? new Credential.default(roleName ? {
    type: "ecs_ram_role",
    roleName,
    disableIMDSv1
  } : {}) : null;

  const objectKey = (ownerId, name) => `${objectPrefix}/${cleanSegment(ownerId) || "local"}/${cleanSegment(name)}`;
  const mockFile = (ownerId, name) => path.join(mockDir, objectKey(ownerId, name));
  const client = async () => {
    const value = await credentials.getCredential();
    return new OSS({
      accessKeyId: value.accessKeyId,
      accessKeySecret: value.accessKeySecret,
      stsToken: value.securityToken,
      bucket,
      endpoint,
      region: region.startsWith("oss-") ? region : `oss-${region}`,
      secure: true,
      retryMax: 1,
      timeout: 30_000
    });
  };

  async function put({ ownerId, name, data, mimeType, localFile }) {
    if (mode === "local") {
      await fs.writeFile(localFile, data, { mode: 0o600 });
      await fs.chmod(localFile, 0o600);
      return;
    }
    if (mode === "mock") {
      const file = mockFile(ownerId, name);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, data, { mode: 0o600 });
      return;
    }
    await (await client()).put(objectKey(ownerId, name), data, { mime: mimeType });
  }

  async function get({ ownerId, name, localFile, allowLocalFallback = true }) {
    if (mode === "local") return fs.readFile(localFile);
    try {
      if (mode === "mock") return await fs.readFile(mockFile(ownerId, name));
      return (await (await client()).get(objectKey(ownerId, name))).content;
    } catch (error) {
      if (!missing(error)) throw error;
      if (!allowLocalFallback) throw error;
      return fs.readFile(localFile);
    }
  }

  async function openRead({ ownerId, name, localFile, allowLocalFallback = true }) {
    if (mode === "local") return localReadSource(localFile);
    try {
      if (mode === "mock") return await localReadSource(mockFile(ownerId, name));
      const store = await client();
      const key = objectKey(ownerId, name);
      const metadata = await store.getObjectMeta(key);
      const metadataHeaders = metadata?.res?.headers || {};
      const bytes = Number(header(metadataHeaders, "content-length"));
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error("Attachment size metadata is invalid");
      }
      const etag = strongEtag(header(metadataHeaders, "etag"));
      if (!etag) throw new Error("Attachment ETag metadata is invalid");
      const versionId = String(header(metadataHeaders, "x-oss-version-id") || "");
      const modifiedAt = Date.parse(String(header(metadataHeaders, "last-modified") || ""));
      return {
        bytes,
        etag,
        ...(Number.isFinite(modifiedAt) ? { lastModified: new Date(modifiedAt).toUTCString() } : {}),
        async createReadStream(options = {}) {
          const range = streamRange(bytes, options);
          const headers = {
            "If-Match": etag,
            ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {})
          };
          let result;
          try {
            result = await store.getStream(key, { headers });
          } catch (error) {
            if (Number(error?.status) === 412 || error?.code === "PreconditionFailed") {
              throw sourceChanged(error);
            }
            throw error;
          }
          if (!result?.stream) throw new Error("Attachment storage returned no readable stream");
          const responseHeaders = result.res?.headers || {};
          const responseEtagValue = header(responseHeaders, "etag");
          const responseEtag = responseEtagValue === undefined ? "" : strongEtag(responseEtagValue);
          const responseVersionId = String(header(responseHeaders, "x-oss-version-id") || "");
          const responseLengthValue = header(responseHeaders, "content-length");
          const responseLength = responseLengthValue === undefined ? null : Number(responseLengthValue);
          const expectedLength = range ? range.end - range.start + 1 : bytes;
          const expectedContentRange = range ? `bytes ${range.start}-${range.end}/${bytes}` : "";
          const inconsistent = (responseEtagValue !== undefined && responseEtag !== etag)
            || (versionId && responseVersionId && responseVersionId !== versionId)
            || result.res?.status !== (range ? 206 : 200)
            || (range && header(responseHeaders, "content-range") !== expectedContentRange)
            || (responseLength !== null && responseLength !== expectedLength);
          if (inconsistent) {
            result.stream.destroy();
            throw sourceChanged();
          }
          return result.stream;
        }
      };
    } catch (error) {
      if (!missing(error)) throw error;
      if (!allowLocalFallback) throw error;
      return localReadSource(localFile);
    }
  }

  async function inspect({ ownerId, name, localFile, allowLocalFallback = true }) {
    const local = async file => {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Attachment must be a regular file");
      return fs.readFile(file);
    };
    let data, storage = mode, key = mode === "local" ? name : objectKey(ownerId, name);
    if (mode === "local") data = await local(localFile);
    else {
      try {
        data = mode === "mock" ? await local(mockFile(ownerId, name)) : (await (await client()).get(key)).content;
      } catch (error) {
        if (!missing(error)) throw error;
        if (!allowLocalFallback) throw error;
        data = await local(localFile);
        storage = "local";
        key = name;
      }
    }
    return { storage, objectKey: key, bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex"), state: "verified" };
  }

  async function remove({ ownerId, name, localFile }) {
    const removeLocal = file => fs.unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (mode === "local") return removeLocal(localFile);
    if (mode === "mock") await removeLocal(mockFile(ownerId, name));
    else {
      try {
        await (await client()).delete(objectKey(ownerId, name));
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    // A successful purge must remove both the object and its legacy fallback.
    await removeLocal(localFile);
  }

  async function usageBytes({ ownerId, localDir }) {
    if (mode === "local") {
      let total = 0;
      for (const entry of await fs.readdir(localDir, { withFileTypes: true })) {
        if (entry.isFile()) total += (await fs.stat(path.join(localDir, entry.name))).size;
      }
      return total;
    }
    if (mode === "mock") {
      const dir = path.dirname(mockFile(ownerId, "placeholder"));
      try {
        let total = 0;
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.isFile()) total += (await fs.stat(path.join(dir, entry.name))).size;
        }
        return total;
      } catch (error) {
        if (error.code === "ENOENT") return 0;
        throw error;
      }
    }
    const store = await client(), objectRoot = `${objectPrefix}/${cleanSegment(ownerId) || "local"}/`;
    let marker = null, total = 0;
    do {
      const result = await store.list({ prefix: objectRoot, marker, "max-keys": 1000 });
      total += (result.objects || []).reduce((sum, object) => sum + Number(object.size || 0), 0);
      marker = result.isTruncated ? result.nextMarker : null;
    } while (marker);
    return total;
  }

  async function list({ ownerId, localDir }) {
    const listDirectory = async (directory, keyForName) => {
      try {
        const result = [];
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !/^[\w.-]+$/.test(entry.name) || entry.name.endsWith(".tmp")) continue;
          const file = path.join(directory, entry.name);
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Attachment must be a regular file");
          result.push({ name: entry.name, bytes: stat.size, objectKey: keyForName(entry.name) });
        }
        return result.sort((left, right) => left.name.localeCompare(right.name));
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    };
    if (mode === "local") return listDirectory(localDir, name => name);
    if (mode === "mock") {
      return listDirectory(path.dirname(mockFile(ownerId, "placeholder")), name => objectKey(ownerId, name));
    }
    const store = await client(), objectRoot = `${objectPrefix}/${cleanSegment(ownerId) || "local"}/`;
    let marker = null;
    const result = [];
    do {
      const page = await store.list({ prefix: objectRoot, marker, "max-keys": 1000 });
      for (const object of page.objects || []) {
        const name = String(object.name || "").slice(objectRoot.length);
        if (!/^[\w.-]+$/.test(name)) throw new Error("Attachment storage contains an invalid object name");
        if (name.endsWith(".tmp")) continue;
        result.push({ name, bytes: Number(object.size || 0), objectKey: object.name });
      }
      marker = page.isTruncated ? page.nextMarker : null;
    } while (marker);
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  return { mode, objectKey, put, get, openRead, inspect, remove, usageBytes, list };
}
