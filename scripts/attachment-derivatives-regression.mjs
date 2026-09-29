import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KEEPSAKE_DERIVATIVE_PROFILES,
  createAttachmentStorage,
  createImageAttachments,
  createKeepsakeImageDerivatives
} from "../src/shared/attachments/index.mjs";
import {
  keepsakeMediaSources,
  keepsakeUploadPayload,
  uploadKeepsakeMedia
} from "../public/frontend/features/index.mjs";
import { createAttachmentHttp } from "../src/http/index.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-derivatives-"));
const scope = new AsyncLocalStorage();
const pngHeader = Buffer.from("iVBORw0KGgoAAAANSUhEUgAACWAAAAdQCAQAAADuJeQ=", "base64");
const original = Buffer.concat([pngHeader, Buffer.alloc(2 * 1024 * 1024, 1)]);
const mask = Buffer.concat([pngHeader, Buffer.alloc(64 * 1024, 2)]);
const dataUrl = (mimeType, data) => `data:${mimeType};base64,${data.toString("base64")}`;

function fakeProcessor(events = [], failKind = "") {
  return {
    async metadata() {
      return { width: 2400, height: 1900, orientation: 6 };
    },
    async encode({ kind, width, height, quality, autoOrient, stripMetadata, alphaMask }) {
      events.push({ action: "encode", kind, width, height, quality, autoOrient, stripMetadata, alphaMask: Boolean(alphaMask) });
      if (kind === failKind) throw new Error(`injected ${kind} failure`);
      const divisor = kind === "alphaMask" ? 48 : 5;
      return Buffer.alloc(Math.max(64, Math.ceil(width * height * quality / 100 / divisor)), kind.length);
    }
  };
}

try {
  assert.deepEqual(
    Object.fromEntries(Object.entries(KEEPSAKE_DERIVATIVE_PROFILES).map(([key, value]) => [
      key,
      { maxWidth: value.maxWidth, maxBytes: value.maxBytes, quality: value.quality, minQuality: value.minQuality }
    ])),
    {
      thumb: { maxWidth: 720, maxBytes: 160 * 1024, quality: 80, minQuality: 78 },
      display: { maxWidth: 1600, maxBytes: 400 * 1024, quality: 84, minQuality: 82 },
      edit: { maxWidth: 1600, maxBytes: 450 * 1024, quality: 84, minQuality: 78 },
      alphaMask: { maxWidth: 1600, maxBytes: 120 * 1024, quality: 90, minQuality: 78 }
    }
  );

  const events = [];
  const derivatives = await createKeepsakeImageDerivatives({
    original,
    alphaMask: mask,
    processor: fakeProcessor(events)
  });
  assert.deepEqual(Object.keys(derivatives), ["thumb", "display", "edit", "alphaMask"]);
  for (const [kind, derivative] of Object.entries(derivatives)) {
    const profile = KEEPSAKE_DERIVATIVE_PROFILES[kind];
    assert.equal(derivative.mimeType, "image/webp");
    assert.ok(derivative.bytes <= profile.maxBytes, `${kind} exceeds its byte cap`);
    assert.ok(derivative.bytes < original.length, `${kind} must be smaller than the original`);
    assert.ok(derivative.width <= 1900 && derivative.height <= 2400, `${kind} enlarged the EXIF-oriented source`);
    assert.ok(Math.max(derivative.width, derivative.height) <= profile.maxWidth, `${kind} exceeds its long-edge cap`);
    assert.ok(derivative.quality >= profile.minQuality, `${kind} fell below minimum quality`);
  }
  assert.ok(events.some(event => event.kind === "display" && event.width < 1600), "oversize output must reduce resolution");
  assert.ok(events.every(event => event.autoOrient && event.stripMetadata), "every derivative must auto-orient and strip metadata");
  assert.ok(events.filter(event => ["thumb", "display"].includes(event.kind)).every(event => event.alphaMask));
  assert.ok(events.filter(event => event.kind === "edit").every(event => !event.alphaMask));

  const context = {
    ownerId: "account-a",
    dataDir: path.join(root, "account-a"),
    attachmentsDir: path.join(root, "account-a", "attachments")
  };
  const run = operation => scope.run(context, operation);
  const writes = [];
  const local = createAttachmentStorage({ mode: "local" });
  const storage = {
    ...local,
    async put(value) {
      writes.push(value.name);
      await local.put(value);
    }
  };
  let sequence = 0;
  const uploads = createImageAttachments({
    storage,
    getContext: () => scope.getStore(),
    quotaBytes: 20 * 1024 * 1024,
    defaultMaxBytes: 8 * 1024 * 1024,
    createId: () => `image-${++sequence}`,
    deriveKeepsakeImages: input => createKeepsakeImageDerivatives({ ...input, processor: fakeProcessor() })
  });
  await run(() => uploads.prepareDirectory());
  const saved = await run(() => uploads.saveKeepsakeSet({
    image: dataUrl("image/png", original),
    alphaMask: dataUrl("image/png", mask)
  }));
  assert.deepEqual(Object.keys(saved.paths), ["originalPath", "thumbPath", "displayPath", "editPath", "alphaMaskPath"]);
  assert.equal(new Set(Object.values(saved.paths)).size, 5);
  assert.equal(writes.length, 5);
  assert.match(saved.paths.originalPath, /\.png$/);
  for (const key of ["thumbPath", "displayPath", "editPath", "alphaMaskPath"]) assert.match(saved.paths[key], /\.webp$/);
  for (const resourcePath of Object.values(saved.paths)) await run(() => uploads.remove(resourcePath));

  const noWrites = [];
  const failingDerivation = createImageAttachments({
    storage: { ...local, put: async value => { noWrites.push(value.name); await local.put(value); } },
    getContext: () => scope.getStore(),
    quotaBytes: 20 * 1024 * 1024,
    defaultMaxBytes: 8 * 1024 * 1024,
    deriveKeepsakeImages: input => createKeepsakeImageDerivatives({ ...input, processor: fakeProcessor([], "display") })
  });
  await assert.rejects(
    run(() => failingDerivation.saveKeepsakeSet({ image: dataUrl("image/png", original), alphaMask: dataUrl("image/png", mask) })),
    /injected display failure/
  );
  assert.deepEqual(noWrites, [], "no persistent write may start before every derivative succeeds");

  let putCount = 0;
  const partial = createImageAttachments({
    storage: {
      ...local,
      async put(value) {
        await local.put(value);
        if (++putCount === 3) throw new Error("injected persistent failure");
      }
    },
    getContext: () => scope.getStore(),
    quotaBytes: 20 * 1024 * 1024,
    defaultMaxBytes: 8 * 1024 * 1024,
    deriveKeepsakeImages: input => createKeepsakeImageDerivatives({ ...input, processor: fakeProcessor() })
  });
  await assert.rejects(
    run(() => partial.saveKeepsakeSet({ image: dataUrl("image/png", original), alphaMask: dataUrl("image/png", mask) })),
    /injected persistent failure/
  );
  assert.deepEqual(await fs.readdir(context.attachmentsDir), [], "a failed persistent batch must clean every partial file");

  const legacyOriginalPath = "/attachments/legacy-original.png";
  const legacyCutoutPath = "/attachments/legacy-cutout.png";
  await local.put({
    ownerId: context.ownerId,
    name: path.basename(legacyOriginalPath),
    data: original,
    mimeType: "image/png",
    localFile: path.join(context.attachmentsDir, path.basename(legacyOriginalPath))
  });
  await local.put({
    ownerId: context.ownerId,
    name: path.basename(legacyCutoutPath),
    data: mask,
    mimeType: "image/png",
    localFile: path.join(context.attachmentsDir, path.basename(legacyCutoutPath))
  });
  writes.length = 0;
  const migrated = await run(() => uploads.deriveKeepsakeSet({
    originalPath: legacyOriginalPath,
    alphaMaskPath: legacyCutoutPath
  }));
  assert.equal(migrated.paths.originalPath, legacyOriginalPath, "legacy migration must not upload the original again");
  assert.deepEqual(migrated.replacedPaths, [legacyCutoutPath]);
  assert.equal(writes.length, 4, "legacy migration persists only four derivatives");
  for (const resourcePath of [...Object.values(migrated.paths), legacyCutoutPath]) {
    await run(() => uploads.remove(resourcePath));
  }

  const record = { id: "keepsake-1", title: "票券", ...saved.paths };
  assert.deepEqual(keepsakeMediaSources(record, "list"), { imagePath: saved.paths.thumbPath });
  assert.deepEqual(keepsakeMediaSources(record, "detail"), { imagePath: saved.paths.displayPath });
  assert.deepEqual(keepsakeMediaSources(record, "edit"), {
    imagePath: saved.paths.editPath,
    alphaMaskPath: saved.paths.alphaMaskPath
  });
  assert.deepEqual(keepsakeMediaSources(record, "original"), { imagePath: saved.paths.originalPath });
  assert.doesNotMatch(JSON.stringify(keepsakeMediaSources(record, "list")), /original/);
  assert.throws(() => keepsakeMediaSources({ originalPath: saved.paths.originalPath }, "list"), /缩略图/);

  const payload = keepsakeUploadPayload({ image: "source", alphaMask: "mask" });
  assert.deepEqual(payload, { purpose: "keepsake", image: "source", alphaMask: "mask" });
  const requests = [];
  const uploaded = await uploadKeepsakeMedia({
    request: async (url, options) => {
      requests.push({ url, options });
      return { ...saved.paths };
    },
    image: "source",
    alphaMask: "mask"
  });
  assert.deepEqual(uploaded, saved.paths);
  assert.equal(requests.length, 1, "the original and derivatives must use one server batch");
  assert.equal(requests[0].url, "/api/images/upload");

  let response;
  const http = createAttachmentHttp({
    attachments: {
      save: async () => ({ attachmentPaths: ["/attachments/plain.png"] }),
      saveKeepsakeSet: async () => ({ paths: saved.paths })
    },
    bodyJson: async req => req.body,
    sendJson: (_res, status, value) => { response = { status, value }; },
    uploadBodyMaxBytes: 10,
    uploadImageMaxBytes: 8
  });
  await http.handle(
    { method: "POST", body: { purpose: "keepsake", image: "source", alphaMask: "mask" } },
    {},
    new URL("http://local/api/images/upload")
  );
  assert.deepEqual(response, {
    status: 201,
    value: { attachmentPath: saved.paths.originalPath, ...saved.paths }
  });
  await http.handle(
    { method: "POST", body: { purpose: "original", image: "source" } },
    {},
    new URL("http://local/api/images/upload")
  );
  assert.deepEqual(response, {
    status: 201,
    value: {
      attachmentPath: "/attachments/plain.png",
      attachmentPaths: ["/attachments/plain.png"]
    }
  });

  console.log("Attachment derivative checks passed: WebP profiles, EXIF/metadata policy, no enlargement, byte caps, batch persistence cleanup and explicit original access.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
