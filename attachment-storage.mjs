import { promises as fs } from "node:fs";
import path from "node:path";
import OSS from "ali-oss";
import Credential from "@alicloud/credentials";

const cleanSegment = value => String(value || "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160);

export function createAttachmentStorage({
  mode = process.env.ATTACHMENT_STORAGE || "local",
  bucket = process.env.OSS_ATTACHMENT_BUCKET || "",
  prefix = process.env.OSS_ATTACHMENT_PREFIX || "for-now-attachments",
  endpoint = process.env.OSS_ENDPOINT || "",
  region = process.env.OSS_REGION || "cn-beijing",
  roleName = process.env.ALIBABA_CLOUD_ECS_RAM_ROLE || "",
  mockDir = process.env.OSS_MOCK_DIR || ""
} = {}) {
  if (!["local", "oss", "mock"].includes(mode)) throw new Error("ATTACHMENT_STORAGE must be local, oss, or mock");
  if (mode === "mock" && process.env.NODE_ENV !== "test") throw new Error("Mock attachment storage is test-only");
  if (mode === "oss" && (!bucket || !endpoint)) throw new Error("OSS attachment storage requires OSS_ATTACHMENT_BUCKET and OSS_ENDPOINT");

  const objectPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const credentials = mode === "oss" ? new Credential.default(roleName ? {
    type: "ecs_ram_role",
    roleName,
    disableIMDSv1: String(process.env.ALIBABA_CLOUD_IMDSV1_DISABLED || "true").toLowerCase() !== "false"
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

  async function get({ ownerId, name, localFile }) {
    if (mode === "local") return fs.readFile(localFile);
    try {
      if (mode === "mock") return fs.readFile(mockFile(ownerId, name));
      return (await (await client()).get(objectKey(ownerId, name))).content;
    } catch (error) {
      if (!["ENOENT", "NoSuchKey"].includes(error?.code) && Number(error?.status) !== 404) throw error;
      return fs.readFile(localFile);
    }
  }

  async function remove({ ownerId, name, localFile }) {
    if (mode === "local") return fs.unlink(localFile).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (mode === "mock") return fs.unlink(mockFile(ownerId, name)).catch(error => { if (error.code !== "ENOENT") throw error; });
    try {
      await (await client()).delete(objectKey(ownerId, name));
    } catch (error) {
      if (!["ENOENT", "NoSuchKey"].includes(error?.code) && Number(error?.status) !== 404) throw error;
    }
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

  return { mode, objectKey, put, get, remove, usageBytes };
}
