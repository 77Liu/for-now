import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAttachmentStorage, createImageAttachments, cleanupTemporaryFiles, decodeAudioDataUrl, imageDimensions } from "../src/shared/attachments/index.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-uploads-"));
const scope = new AsyncLocalStorage();
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const png = Buffer.from(pixel.split(",")[1], "base64");
const m4a = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(36)]);
const audio = `data:audio/mp4;base64,${m4a.toString("base64")}`;
const context = (group, ownerId) => {
  const dataDir = path.join(root, group, ownerId);
  return { ownerId, dataDir, attachmentsDir: path.join(dataDir, "attachments") };
};
const inScope = (group, ownerId, callback) => scope.run(context(group, ownerId), callback);
const options = { getContext: () => scope.getStore(), quotaBytes: png.length, defaultMaxBytes: 8 * 1024 * 1024 };

try {
  assert.deepEqual(imageDimensions(png, "image/png"), { width: 1, height: 1 });
  assert.deepEqual(imageDimensions(png, "image/jpeg"), { width: 0, height: 0 });
  assert.deepEqual(decodeAudioDataUrl(audio, { maxBytes: 1024 }), {
    data: m4a,
    mimeType: "audio/mp4",
    extension: "m4a",
    bytes: m4a.length
  });
  assert.throws(() => decodeAudioDataUrl("data:audio/mp4;base64,AAAA", { maxBytes: 1024 }), /格式不匹配/);
  assert.throws(() => decodeAudioDataUrl("data:audio/mpeg;base64,AAAA", { maxBytes: 1024 }), /M4A/);
  for (const mode of ["local", "mock"]) {
    const storage = createAttachmentStorage({ mode, testMode: true, mockDir: path.join(root, `${mode}-objects`) });
    const uploads = createImageAttachments({ ...options, storage });
    await Promise.all(["a", "b"].map(owner => inScope(mode, owner, () => uploads.prepareDirectory())));
    await inScope(mode, "a", async () => {
      for (const [images, maxImages, settings, message] of [
        [[], 1, {}, /请选择/],
        [[pixel, pixel], 1, {}, /请选择/],
        [["data:image/svg+xml;base64,AAAA"], 1, {}, /PNG/],
        [["data:image/jpeg;base64,AAAA"], 1, {}, /格式不匹配/],
        [[pixel, pixel], 2, { maxBytes: png.length }, /总大小/]
      ]) await assert.rejects(uploads.save(images, maxImages, settings), message);
      assert.equal(await storage.usageBytes({ ownerId: "a", localDir: context(mode, "a").attachmentsDir }), 0);
    });
    // Two requests for the same account compete for one image of space.
    // The other account has its own queue and quota.
    const results = await Promise.allSettled([
      inScope(mode, "a", () => uploads.save([pixel], 1, { needsLocalFiles: true })),
      inScope(mode, "a", () => uploads.save([pixel])),
      inScope(mode, "b", () => uploads.save([pixel]))
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].reason.code, "ATTACHMENT_QUOTA_EXCEEDED");
    assert.equal(results[2].status, "fulfilled");
    const uploaded = results[0].value, other = results[2].value;
    assert.deepEqual(await fs.readFile(uploaded.files[0]), png);
    await cleanupTemporaryFiles(uploaded.cleanupFiles);
    if (mode === "mock") await assert.rejects(fs.access(uploaded.files[0]), { code: "ENOENT" });
    else assert.equal(uploaded.cleanupFiles.length, 0);
    await inScope(mode, "a", async () => {
      assert.deepEqual(await uploads.read(uploaded.attachmentPaths[0]), png);
      await assert.rejects(uploads.read(other.attachmentPaths[0]), { code: "ENOENT" });
      const temporary = await uploads.save([pixel], 1, { persist: false, needsLocalFiles: true });
      assert.deepEqual(temporary.attachmentPaths, []);
      assert.equal((await fs.stat(temporary.files[0])).mode & 0o777, 0o600);
      assert.deepEqual(await fs.readFile(temporary.files[0]), png);
      await cleanupTemporaryFiles(temporary.cleanupFiles);
      assert.equal(await storage.usageBytes({ ownerId: "a", localDir: context(mode, "a").attachmentsDir }), png.length);
      await uploads.remove(uploaded.attachmentPaths[0]);
      // A rejected upload must not poison the account's queue.
      const retry = await uploads.save([pixel]);
      await uploads.remove(retry.attachmentPaths[0]);
      const recorded = await uploads.saveAudio(audio, { maxBytes: 1024 });
      assert.equal(recorded.mimeType, "audio/mp4");
      assert.equal(recorded.bytes, m4a.length);
      assert.match(recorded.attachmentPath, /^\/attachments\/[\w.-]+\.m4a$/);
      assert.deepEqual(await uploads.read(recorded.attachmentPath), m4a);
      const derived = await uploads.saveAsrAudio({
        sourcePath: recorded.attachmentPath,
        data: wav
      });
      assert.equal(derived.mimeType, "audio/wav");
      assert.equal(derived.bytes, wav.length);
      assert.equal(derived.attachmentPath, recorded.attachmentPath.replace(/\.m4a$/, ".asr.wav"));
      assert.deepEqual(await uploads.read(derived.attachmentPath), wav);
      await uploads.remove(derived.attachmentPath);
      await uploads.remove(recorded.attachmentPath);
    });

    // Fail after a partial two-image batch: local and mock binaries both clean up.
    let writes = 0;
    const failingStorage = { ...storage, put: async value => {
      await storage.put(value);
      if (++writes === 2) throw new Error("injected put failure");
    } };
    const failing = createImageAttachments({ ...options, quotaBytes: 10000, storage: failingStorage });
    await inScope(`${mode}-partial`, "a", async () => {
      await failing.prepareDirectory();
      await assert.rejects(failing.save([pixel, pixel], 2, { needsLocalFiles: true }), /injected put failure/);
      assert.equal(await storage.usageBytes({ ownerId: "a", localDir: scope.getStore().attachmentsDir }), 0);
      assert.deepEqual(await fs.readdir(path.join(scope.getStore().dataDir, "tmp")).catch(() => []), []);
    });
  }

  // Durable inventory doubles assert ordering and recovery errors. The real
  // PostgreSQL suite separately verifies the transaction/lock implementation.
  for (const fault of ["none", "record", "put", "confirm", "cleanup"]) {
    const group = `inventory-${fault}`, events = [], rows = new Map(), deferred = [];
    const storage = createAttachmentStorage({ mode: "local" });
    let locked = false, recordCount = 0, service;
    const inventory = {
      lock: async operation => { locked = true; try { return await operation(); } finally { locked = false; } },
      record: async item => {
        assert.equal(locked, true);
        events.push("record");
        if (fault === "record") throw new Error("injected record failure");
        recordCount++;
        rows.set(item.path, { ...item, state: "uploading" });
      },
      confirm: async item => {
        events.push("confirm");
        if (fault === "confirm") throw new Error("injected confirm failure");
        assert.equal(item.sha256, rows.get(item.path).sha256);
        rows.set(item.path, item);
      },
      pending: async () => [...rows.values()].filter(item => item.state === "uploading"),
      removed: async resourcePath => { events.push("removed"); rows.delete(resourcePath); }
    };
    const adapter = { ...storage, put: async item => {
      assert.equal(locked, true);
      events.push("put");
      if (fault === "put" || (fault === "cleanup" && recordCount === 2)) throw new Error("injected put failure");
      await storage.put(item);
    } };
    service = createImageAttachments({
      ...options, quotaBytes: 10000, storage: adapter, inventory,
      cleanFailedUploads: async paths => {
        events.push("cleanup");
        if (fault === "cleanup") throw new Error("injected cleanup commit failure");
        for (const resourcePath of paths) await service.remove(resourcePath);
      },
      onCleanupDeferred: error => deferred.push(error.message)
    });
    await inScope(group, "a", async () => {
      await service.prepareDirectory();
      if (fault === "none") {
        const result = await service.save([pixel]);
        assert.deepEqual(events, ["record", "put", "confirm"]);
        assert.equal(rows.get(result.attachmentPaths[0]).state, "verified");
        await service.discard(result.attachmentPaths);
        assert.equal(rows.size, 0);
      } else {
        await assert.rejects(service.save(fault === "cleanup" ? [pixel, pixel] : [pixel], 2, { needsLocalFiles: true }), /injected/);
        const files = await fs.readdir(scope.getStore().attachmentsDir);
        if (fault === "cleanup") {
          assert.deepEqual(deferred, ["injected cleanup commit failure"]);
          assert.equal(files.length, 1, "Failed cleanup commit must preserve the completed binary");
          assert.equal(rows.size, 2);
          await service.recover();
          assert.equal(rows.size, 1, "Missing interrupted upload is reconciled on restart");
          for (const resourcePath of rows.keys()) await service.remove(resourcePath);
        } else {
          assert.deepEqual(files, []);
          assert.equal(rows.size, 0);
        }
      }
    });
  }

  await inScope("recovery", "a", async () => {
    const storage = createAttachmentStorage({ mode: "local" });
    let confirmed = [], removed = [];
    const inventory = {
      pending: async () => [{ path: "/attachments/present.png" }, { path: "/attachments/missing.png" }],
      confirm: async item => confirmed.push(item), removed: async name => removed.push(name)
    };
    const service = createImageAttachments({ ...options, storage, inventory });
    await service.prepareDirectory();
    await fs.writeFile(path.join(scope.getStore().attachmentsDir, "present.png"), png);
    await service.recover();
    assert.equal(confirmed[0].state, "verified");
    assert.equal(confirmed[0].bytes, png.length);
    assert.deepEqual(removed, ["/attachments/missing.png"]);
    confirmed = []; removed = [];
    const denied = createImageAttachments({ ...options, inventory, storage: {
      ...storage, inspect: async () => { throw Object.assign(new Error("access denied"), { code: "EACCES" }); }
    } });
    await assert.rejects(denied.recover(), { code: "EACCES" });
    assert.deepEqual(confirmed, []);
    assert.deepEqual(removed, [], "A storage outage must not erase pending inventory");
  });
  console.log("Attachment upload checks passed: image/audio validation, per-account quota races, local/mock batches, temporary files, inventory ordering, deferred cleanup and startup recovery.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
