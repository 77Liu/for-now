import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  uploadPendingMediaItems,
  validatedImageFiles
} from "../public/frontend/media/index.mjs";
import {
  createContentImageDraftManager,
  isUncertainContentImageSubmission,
  rotateContentImageFile
} from "../public/frontend/media/content-image-drafts.mjs";
import { resolveHeadlessBrowser } from "./browser-runtime.mjs";

const moduleSource = await readFile(
  new URL("../public/frontend/media/content-image-drafts.mjs", import.meta.url),
  "utf8"
);
const rotationModuleSource = await readFile(
  new URL("../public/frontend/media/content-image-draft-model.mjs", import.meta.url),
  "utf8"
);
assert.doesNotMatch(moduleSource, /\b(?:window|router)\b|state\.thoughts/);

const sleep = milliseconds => new Promise(resolve => {
  setTimeout(resolve, milliseconds);
});

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function pageDebuggerUrl(port, browser) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (browser.exitCode != null) {
      throw new Error(`Image rotation browser exited early: ${browser.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find(item => item.type === "page" && item.url === "about:blank");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(50);
  }
  throw new Error("Timed out waiting for the image rotation browser");
}

class Cdp {
  constructor(url, Socket = WebSocket) {
    this.socket = new Socket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      const callback = this.pending.get(message.id);
      if (!callback) return;
      this.pending.delete(message.id);
      clearTimeout(callback.timer);
      if (message.error) callback.reject(Object.assign(new Error(`${callback.method}: ${message.error.message}`), {
        cdpMethod: callback.method, cdpMessage: message.error.message
      }));
      else callback.resolve(message.result);
    });
    for (const event of ["error", "close"]) this.socket.addEventListener(event, () => {
      for (const callback of this.pending.values()) {
        clearTimeout(callback.timer); callback.reject(new Error(`CDP ${event} while waiting for ${callback.method}`));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ready.then(() => {
        if (this.pending.has(id)) this.socket.send(JSON.stringify({ id, method, params }));
      }).catch(error => {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }

  close() { this.socket.close(); }
}

async function waitForFixtureReady(cdp, { url, title, timeoutMs = 10_000,
  now = () => Date.now(), wait = sleep, pollMs = 25 } = {}) {
  const deadline = now() + timeoutMs;
  let contextDestroys = 0;
  while (now() < deadline) {
    try {
      const result = await cdp.send("Runtime.evaluate", {
        expression: "({url:location.href,title:document.title,readyState:document.readyState})", returnByValue: true
      }, Math.max(1, deadline - now()));
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      const value = result.result?.value;
      if (value?.url === url && value?.title === title && value?.readyState === "complete" && now() < deadline) return;
    } catch (error) {
      if (error.cdpMethod !== "Runtime.evaluate" || error.cdpMessage !== "Execution context was destroyed."
        || ++contextDestroys > 3) throw error;
    }
    await wait(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  throw new Error("Image rotation fixture readiness timed out (URL/title/complete required)");
}

async function readinessChecks() {
  const url = "http://fixture.invalid/", title = "image rotation regression";
  const ready = { url, title, readyState: "complete" };
  let cases = 0;
  const inspect = async ({ probes = [ready], fixtureError = "", pixel = [255, 0, 0, 255], timeoutMs = 30,
    socketEvent = "", neverOpen = false } = {}) => {
    let probeCalls = 0, fixtureCalls = 0, clock = 0;
    class FakeSocket {
      listeners = new Map();
      constructor() { if (!neverOpen) queueMicrotask(() => this.emit("open", {})); }
      addEventListener(name, callback) {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(callback);
      }
      emit(name, event) { for (const callback of this.listeners.get(name) || []) callback(event); }
      close() { this.emit("close", {}); }
      send(text) {
        const command = JSON.parse(text);
        queueMicrotask(() => {
          const fixture = command.params.awaitPromise === true;
          if (fixture) fixtureCalls += 1;
          const value = fixture ? { pixel } : probes[Math.min(probeCalls++, probes.length - 1)];
          if (socketEvent) { this.emit(socketEvent, {}); return; }
          if (value?.pending) return;
          const error = fixture ? fixtureError : value?.protocolError;
          this.emit("message", { data: JSON.stringify(error ? { id: command.id, error: { message: error } }
            : { id: command.id, result: value?.exceptionDetails ? { exceptionDetails: value.exceptionDetails }
              : { result: { value } } }) });
        });
      }
    }
    const cdp = new Cdp("ws://fixture.invalid", FakeSocket);
    let error;
    try {
      await waitForFixtureReady(cdp, { url, title, timeoutMs, now: () => clock, wait: async ms => { clock += ms; }, pollMs: 5 });
      const result = await cdp.send("Runtime.evaluate", { expression: "single fixture with internal side effects", awaitPromise: true }, timeoutMs);
      assertPixelColor(result.result.value.pixel, "red", "fake fixture pixel");
    } catch (failure) { error = failure; }
    finally { cdp.close(); }
    assert.equal(cdp.pending.size, 0);
    return { error, probeCalls, fixtureCalls };
  };
  for (const probes of [[{ ...ready, readyState: "loading" }, { ...ready, readyState: "interactive" }, ready],
    [{ protocolError: "Execution context was destroyed." }, ready]]) {
    const result = await inspect({ probes }); assert.equal(result.error, undefined); assert.equal(result.fixtureCalls, 1); cases += 1;
  }
  for (const probes of [[{ ...ready, url: "about:blank" }], [{ ...ready, title: "wrong title" }], [{ ...ready, readyState: "loading" }]]) {
    const result = await inspect({ probes }); assert.match(result.error.message, /readiness timed out/);
    assert.equal(result.fixtureCalls, 0); cases += 1;
  }
  const repeated = await inspect({ probes: [{ protocolError: "Execution context was destroyed." }] });
  assert.equal(repeated.probeCalls, 4); assert.equal(repeated.fixtureCalls, 0); assert.match(repeated.error.message, /context was destroyed/); cases += 1;
  for (const options of [{ probes: [{ pending: true }] }, { neverOpen: true }]) {
    const result = await inspect({ ...options, timeoutMs: 15 }); assert.match(result.error.message, /timed out/);
    assert.equal(result.fixtureCalls, 0); cases += 1;
  }
  for (const options of [{ probes: [{ protocolError: "Cannot find default execution context." }] },
    { probes: [{ exceptionDetails: { text: "probe JS error" } }] }, { socketEvent: "close" }, { socketEvent: "error" }]) {
    const result = await inspect(options); assert.ok(result.error); assert.equal(result.fixtureCalls, 0); cases += 1;
  }
  for (const options of [{ fixtureError: "Execution context was destroyed." }, { fixtureError: "fixture execution failed" }, { pixel: [0, 0, 0, 255] }]) {
    const result = await inspect(options); assert.ok(result.error); assert.equal(result.fixtureCalls, 1); cases += 1;
  }
  console.log(JSON.stringify({ suite: "image-fixture-cdp-readiness", status: "passed", cases, externalCalls: 0, browserLaunches: 0 }));
}

async function stopBrowser(browser) {
  if (browser.exitCode != null || browser.signalCode != null) return;
  const exited = new Promise(resolve => browser.once("exit", resolve));
  browser.kill("SIGKILL");
  await exited;
}

async function inspectExifRotationInBrowser() {
  const server = http.createServer((request, response) => {
    if (request.url === "/content-image-draft-model.mjs") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/javascript; charset=utf-8"
      });
      response.end(rotationModuleSource);
      return;
    }
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>image rotation regression</title>");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const debugPort = await freePort();
  const profile = await mkdtemp(path.join(os.tmpdir(), "content-image-rotation-"));
  const browser = spawn(resolveHeadlessBrowser(), [
    "--headless=new",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-crash-reporter",
    "--disable-default-apps",
    "--disable-gpu",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "about:blank"
  ], { stdio: "ignore" });

  let cdp;
  try {
    cdp = new Cdp(await pageDebuggerUrl(debugPort, browser));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const fixtureUrl = `http://127.0.0.1:${port}/`;
    const navigation = await cdp.send("Page.navigate", { url: fixtureUrl });
    assert.ok(!navigation.errorText, `Image rotation fixture navigation failed: ${navigation.errorText}`);
    await waitForFixtureReady(cdp, { url: fixtureUrl, title: "image rotation regression" });
    const expression = `(async () => {
      const { rotateContentImageFile } = await import(
        ${JSON.stringify(`http://127.0.0.1:${port}/content-image-draft-model.mjs`)}
      );
      const fixtureCanvas = new OffscreenCanvas(40, 24);
      const fixtureContext = fixtureCanvas.getContext("2d");
      fixtureContext.fillStyle = "#ff0000";
      fixtureContext.fillRect(0, 0, 20, 12);
      fixtureContext.fillStyle = "#00ff00";
      fixtureContext.fillRect(20, 0, 20, 12);
      fixtureContext.fillStyle = "#0000ff";
      fixtureContext.fillRect(0, 12, 20, 12);
      fixtureContext.fillStyle = "#ffff00";
      fixtureContext.fillRect(20, 12, 20, 12);
      const rawJpeg = new Uint8Array(await (
        await fixtureCanvas.convertToBlob({
          type: "image/jpeg",
          quality: 1
        })
      ).arrayBuffer());
      const exifOrientation6 = Uint8Array.from([
        0xff, 0xe1, 0x00, 0x22,
        0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
        0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
        0x00, 0x01,
        0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,
        0x00, 0x06, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00
      ]);
      const bytes = new Uint8Array(rawJpeg.length + exifOrientation6.length);
      bytes.set(rawJpeg.subarray(0, 2), 0);
      bytes.set(exifOrientation6, 2);
      bytes.set(rawJpeg.subarray(2), 2 + exifOrientation6.length);
      const file = new File([bytes], "orientation-6.jpg", {
        type: "image/jpeg",
        lastModified: 1
      });
      const sample = async blob => {
        const bitmap = await createImageBitmap(blob, {
          imageOrientation: "from-image"
        });
        try {
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d", { willReadFrequently: true });
          context.drawImage(bitmap, 0, 0);
          const points = [
            [0.25, 0.25],
            [0.75, 0.25],
            [0.25, 0.75],
            [0.75, 0.75]
          ];
          return {
            size: [bitmap.width, bitmap.height],
            pixels: points.map(([x, y]) => Array.from(context.getImageData(
              Math.floor(bitmap.width * x),
              Math.floor(bitmap.height * y),
              1,
              1
            ).data))
          };
        } finally {
          bitmap.close();
        }
      };
      const source = await sample(file);
      const rotatedFile = await rotateContentImageFile(file, {
        quarterTurns: 1
      });
      const rotated = await sample(rotatedFile);
      const corrupted = bytes.slice();
      corrupted[0] = 0;
      corrupted[1] = 0;
      let corruptedFixtureRejected = false;
      try {
        await rotateContentImageFile(
          new File([corrupted], "corrupted.jpg", { type: "image/jpeg" })
        );
      } catch {
        corruptedFixtureRejected = true;
      }
      return {
        fixture: {
          exifSignature: Array.from(bytes.subarray(6, 12)),
          orientation: (bytes[30] << 8) | bytes[31]
        },
        source,
        rotated,
        corruptedFixtureRejected
      };
    })()`;
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
          || response.exceptionDetails.text
      );
    }
    return response.result.value;
  } finally {
    cdp?.close();
    await stopBrowser(browser);
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { force: true, recursive: true });
  }
}

function assertPixelColor(pixel, color, label) {
  const [red, green, blue, alpha] = pixel;
  assert.equal(alpha, 255, `${label} must be opaque`);
  if (color === "red") {
    assert.ok(red > 180 && green < 90 && blue < 90, `${label}: ${pixel}`);
  } else if (color === "green") {
    assert.ok(red < 90 && green > 150 && blue < 90, `${label}: ${pixel}`);
  } else if (color === "blue") {
    assert.ok(red < 90 && green < 90 && blue > 180, `${label}: ${pixel}`);
  } else {
    assert.ok(red > 180 && green > 150 && blue < 90, `${label}: ${pixel}`);
  }
}

function assertPixelGrid(actual, expected, label) {
  assert.equal(actual.length, expected.length);
  for (const [index, color] of expected.entries()) {
    assertPixelColor(actual[index], color, `${label} pixel ${index}`);
  }
}

await readinessChecks();
if (process.argv.includes("--cdp-readiness-only")) process.exit(0);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createStore(initial = [], getOverride = null) {
  const records = new Map();
  const calls = [];
  const recordKey = (owner, id) => JSON.stringify([owner, id]);
  for (const record of initial) {
    records.set(recordKey(record.owner, record.id), structuredClone(record));
  }
  return {
    calls,
    records,
    async get(owner, id) {
      calls.push(["get", owner, id]);
      const overridden = getOverride?.(owner, id);
      if (overridden) return overridden;
      return structuredClone(records.get(recordKey(owner, id)) || null);
    },
    async put(record) {
      calls.push(["put", record.owner, record.id]);
      records.set(recordKey(record.owner, record.id), structuredClone(record));
    },
    async delete(owner, id) {
      calls.push(["delete", owner, id]);
      records.delete(recordKey(owner, id));
    },
    record(owner, id) {
      return structuredClone(records.get(recordKey(owner, id)) || null);
    }
  };
}

const image = name => ({
  name,
  type: "image/png",
  size: 12,
  lastModified: 1
});
const storedImage = (name, extra = {}) => ({
  blob: image(name),
  name,
  type: "image/png",
  lastModified: 1,
  ...extra
});
const createFile = (parts, name, options) => ({
  ...parts[0],
  blob: parts[0],
  name,
  type: options.type,
  lastModified: options.lastModified,
  size: parts[0]?.size || 0
});

function createObjectUrls() {
  let sequence = 0;
  const created = [];
  const createdFiles = [];
  const revoked = [];
  return {
    created,
    createdFiles,
    revoked,
    createObjectURL(file) {
      const value = `blob:test-${++sequence}-${file.name}`;
      created.push(value);
      createdFiles.push(file);
      return value;
    },
    revokeObjectURL(value) {
      revoked.push(value);
    }
  };
}

function createContentImageDom(keys) {
  let clickHandler = null;
  const editors = new Map();
  const root = {
    addEventListener(type, handler) {
      if (type === "click") clickHandler = handler;
    },
    createElement() {
      const attributes = new Map();
      return {
        attributes,
        dataset: {},
        style: {},
        disabled: false,
        parentElement: null,
        setAttribute(name, value) {
          attributes.set(name, String(value));
        },
        removeAttribute(name) {
          attributes.delete(name);
        },
        closest(selector) {
          if (selector === "[data-content-image-rotate]") return this;
          if (selector === "[data-content-image-editor]") {
            return this.parentElement?.editor || null;
          }
          return null;
        },
        remove() {
          const children = this.parentElement?.children;
          const index = children?.indexOf(this) ?? -1;
          if (index >= 0) children.splice(index, 1);
          this.parentElement = null;
        }
      };
    },
    querySelector(selector) {
      const match = selector.match(/^\[data-content-image-editor="([^"]+)"\]$/);
      return match ? editors.get(match[1])?.editor || null : null;
    },
    async click(button) {
      assert.equal(typeof clickHandler, "function", "the delegated DOM handler must bind");
      await clickHandler({ target: button });
    }
  };

  for (const key of keys) {
    const imageElement = { src: "" };
    const figure = {
      children: [],
      editor: null,
      querySelector(selector) {
        if (selector === "img") return imageElement;
        if (selector === "[data-content-image-rotate]") {
          return this.children.find(
            child => child.dataset.contentImageRotate != null
          ) || null;
        }
        return null;
      },
      append(child) {
        child.parentElement = this;
        this.children.push(child);
      }
    };
    const previews = {
      querySelectorAll(selector) {
        return selector === ".content-image-preview" ? [figure] : [];
      }
    };
    const status = { textContent: "" };
    const form = {
      querySelector(selector) {
        return selector === ".status" ? status : null;
      }
    };
    const editor = {
      dataset: { contentImageEditor: key },
      querySelector(selector) {
        return selector === "[data-content-image-previews]" ? previews : null;
      },
      closest(selector) {
        return selector === "form" ? form : null;
      }
    };
    figure.editor = editor;
    editors.set(key, {
      editor,
      figure,
      imageElement,
      status,
      get rotateButton() {
        return figure.querySelector("[data-content-image-rotate]");
      }
    });
  }
  return { root, editors };
}

function createManager({
  store,
  objectUrls,
  uploadItem = async file => `/attachments/${file.name}`,
  discardItem = async () => true,
  rotateFile,
  domRoot,
  draftKeys = ["thoughtRoot", "thoughtBlock"]
}) {
  let id = 0;
  return createContentImageDraftManager({
    store,
    objectUrls,
    draftKeys,
    validateFiles: validatedImageFiles,
    uploadPendingItems: uploadPendingMediaItems,
    uploadItem,
    discardItem,
    ...(rotateFile ? { rotateFile } : {}),
    ...(domRoot ? { domRoot } : {}),
    createFile,
    createId: () => `upload-${++id}`,
    now: () => Date.parse("2026-10-06T08:00:00.000Z")
  });
}

{
  const browserResult = await inspectExifRotationInBrowser();
  assert.deepEqual(
    browserResult.fixture.exifSignature,
    [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]
  );
  assert.equal(browserResult.fixture.orientation, 6);
  assert.deepEqual(browserResult.source.size, [24, 40]);
  assertPixelGrid(
    browserResult.source.pixels,
    ["blue", "red", "yellow", "green"],
    "EXIF-oriented source"
  );
  assert.deepEqual(browserResult.rotated.size, [40, 24]);
  assertPixelGrid(
    browserResult.rotated.pixels,
    ["yellow", "blue", "green", "red"],
    "clockwise output"
  );
  assert.equal(
    browserResult.corruptedFixtureRejected,
    true,
    "the browser must reject a corrupted copy of the EXIF fixture"
  );

  const transforms = [];
  const bitmap = {
    width: 3,
    height: 2,
    closeCalls: 0,
    close() {
      this.closeCalls += 1;
    }
  };
  const canvas = {
    width: 3,
    height: 2,
    getContext() {
      return {
        translate(x, y) {
          transforms.push(["translate", x, y]);
        },
        rotate(radians) {
          transforms.push(["rotate", radians]);
        },
        drawImage(source, x, y) {
          transforms.push(["drawImage", source, x, y]);
        }
      };
    }
  };
  const normalized = await rotateContentImageFile(
    {
      ...image("exif-portrait.jpg"),
      type: "image/jpeg"
    },
    {
      quarterTurns: 3,
      async decodeImage(file, options) {
        assert.equal(file.name, "exif-portrait.jpg");
        assert.deepEqual(options, { imageOrientation: "from-image" });
        return bitmap;
      },
      createCanvas(width, height) {
        assert.deepEqual([width, height], [2, 3]);
        return canvas;
      },
      async encodeCanvas(value, options) {
        assert.equal(value, canvas);
        assert.deepEqual(options, { type: "image/jpeg", quality: 0.92 });
        return {
          type: "image/jpeg",
          size: 24
        };
      },
      createFile(parts, name, options) {
        return { blob: parts[0], name, ...options, size: parts[0].size };
      }
    }
  );
  assert.deepEqual(transforms, [
    ["translate", 0, 3],
    ["rotate", -Math.PI / 2],
    ["drawImage", bitmap, 0, 0]
  ]);
  assert.equal(normalized.name, "exif-portrait.jpg");
  assert.equal(normalized.type, "image/jpeg");
  assert.equal(bitmap.closeCalls, 1);
}

{
  let webpEncoding;
  const bitmap = {
    width: 4,
    height: 2,
    close() {}
  };
  const canvas = {
    getContext() {
      return {
        translate() {},
        rotate() {},
        drawImage() {}
      };
    }
  };
  await rotateContentImageFile(
    { ...image("quality.webp"), type: "image/webp" },
    {
      decodeImage: async () => bitmap,
      createCanvas: () => canvas,
      async encodeCanvas(value, options) {
        assert.equal(value, canvas);
        webpEncoding = options;
        return { type: "image/webp", size: 24 };
      },
      createFile(parts, name, options) {
        return { blob: parts[0], name, ...options, size: parts[0].size };
      }
    }
  );
  assert.deepEqual(
    webpEncoding,
    { type: "image/webp", quality: 0.92 },
    "WebP rotation must encode with quality 0.92"
  );
}

{
  const rotationStore = createStore();
  const rotationUrls = createObjectUrls();
  const rotationCalls = [];
  const uploadedDirections = [];
  const rotationManager = createManager({
    store: rotationStore,
    objectUrls: rotationUrls,
    draftKeys: ["thoughtRoot"],
    async rotateFile(file, options) {
      rotationCalls.push([file.name, file.direction, options.quarterTurns]);
      const directions = ["north", "east", "south", "west"];
      return {
        ...file,
        direction: directions[
          (directions.indexOf(file.direction) + options.quarterTurns) % directions.length
        ],
        pixels: `${file.pixels}>derived-${options.quarterTurns}`
      };
    },
    async uploadItem(file) {
      uploadedDirections.push([file.name, file.direction, file.pixels]);
      return `/attachments/${file.name}-${file.direction}.png`;
    }
  });
  await rotationManager.restore("rotation-owner");
  await rotationManager.select("thoughtRoot", [
    { ...image("first.png"), direction: "north", pixels: "first-original" },
    { ...image("second.png"), direction: "west", pixels: "second-original" }
  ]);
  const initialPreviews = rotationManager.snapshot("thoughtRoot").items.map(
    item => item.preview
  );

  const firstTurn = rotationManager.rotate("thoughtRoot", 0);
  const secondTurn = rotationManager.rotate("thoughtRoot", 0);
  await Promise.all([firstTurn, secondTurn]);
  await rotationManager.rotate("thoughtRoot", 1);
  assert.deepEqual(rotationCalls, [
    ["first.png", "north", 1],
    ["first.png", "north", 2],
    ["second.png", "west", 1]
  ]);
  assert.deepEqual(
    rotationManager.snapshot("thoughtRoot").items.map(item => item.file.direction),
    ["south", "north"],
    "each draft item must continue from its own current direction"
  );
  assert.deepEqual(
    rotationManager.snapshot("thoughtRoot").items.map(item => item.file.pixels),
    [
      "first-original>derived-2",
      "second-original>derived-1"
    ],
    "lossy formats must derive every orientation from the original file"
  );
  assert.ok(initialPreviews.every(value => rotationUrls.revoked.includes(value)));
  assert.deepEqual(
    rotationUrls.createdFiles.slice(-2).map(file => file.direction),
    ["south", "north"],
    "preview URLs must use each item's final rotated file"
  );
  assert.deepEqual(
    rotationStore.record("rotation-owner", "thoughtRoot").items.map(
      item => item.blob.direction
    ),
    ["south", "north"],
    "the durable draft must contain the same final pixels as the preview"
  );
  assert.deepEqual(
    rotationStore.record("rotation-owner", "thoughtRoot").items.map(item => [
      item.originalBlob.direction,
      item.quarterTurns
    ]),
    [["north", 2], ["west", 1]],
    "the durable draft must retain each original and cumulative turn count"
  );

  const submission = await rotationManager.submit("thoughtRoot");
  assert.deepEqual(uploadedDirections, [
    ["first.png", "south", "first-original>derived-2"],
    ["second.png", "north", "second-original>derived-1"]
  ]);
  assert.deepEqual(submission.attachmentPaths, [
    "/attachments/first.png-south.png",
    "/attachments/second.png-north.png"
  ]);

  await rotationManager.rotate("thoughtRoot", 0);
  await rotationManager.rotate("thoughtRoot", 0);
  assert.deepEqual(rotationCalls.at(-1), ["first.png", "north", 3]);
  const originalAgain = rotationManager.snapshot("thoughtRoot").items[0];
  assert.equal(originalAgain.quarterTurns, 0);
  assert.equal(originalAgain.file, originalAgain.originalFile);
  assert.equal(originalAgain.file.pixels, "first-original");
  assert.equal(
    rotationCalls.length,
    4,
    "the fourth turn must restore the original without another lossy encode"
  );
  assert.equal(
    rotationStore.record("rotation-owner", "thoughtRoot").items[0].blob.pixels,
    "first-original",
    "preview and persistence must return to the original pixels after four turns"
  );
  await rotationManager.submit("thoughtRoot");
  assert.deepEqual(
    uploadedDirections.at(-1),
    ["first.png", "north", "first-original"],
    "upload must use the same original pixels shown and persisted after four turns"
  );

  rotationManager.resetSession();
  await rotationManager.restore("rotation-owner");
  await rotationManager.rotate("thoughtRoot", 1);
  assert.deepEqual(
    rotationCalls.at(-1),
    ["second.png", "west", 2],
    "rotation after restore must still derive from the persisted original"
  );

  await rotationManager.replaceExisting(
    "thoughtRoot",
    ["/attachments/historical.png"]
  );
  assert.equal(await rotationManager.rotate("thoughtRoot", 0), false);
  assert.equal(
    rotationCalls.length,
    5,
    "historical attachment paths must never enter draft pixel rotation"
  );
}

{
  const keys = ["capture", "thoughtRoot", "thoughtBlock", "comment"];
  const dom = createContentImageDom(keys);
  const handlerCalls = [];
  const handlerManager = createManager({
    store: createStore(),
    objectUrls: createObjectUrls(),
    draftKeys: keys,
    domRoot: dom.root,
    async rotateFile(file, options) {
      handlerCalls.push([file.name, options.quarterTurns]);
      return { ...file, pixels: `${file.pixels}>dom-${options.quarterTurns}` };
    }
  });
  await handlerManager.restore("dom-owner");
  for (const key of keys) {
    await handlerManager.select(key, [{
      ...image(`${key}.jpg`),
      type: "image/jpeg",
      pixels: `${key}-original`
    }]);
  }
  await Promise.resolve();

  for (const key of keys) {
    const surface = dom.editors.get(key);
    assert.ok(
      surface.rotateButton,
      `${key} must render a production rotation control`
    );
    assert.equal(surface.rotateButton.dataset.contentImageRotate, "0");
    await dom.root.click(surface.rotateButton);
    assert.match(
      surface.imageElement.src,
      /^blob:test-/,
      `${key} handler must refresh the visible preview`
    );
  }
  assert.deepEqual(
    handlerCalls,
    keys.map(key => [`${key}.jpg`, 1]),
    "all four shared draft keys must reach rotate through the DOM handler"
  );
}

{
  const failureStore = createStore();
  const failureUrls = createObjectUrls();
  const failureGate = deferred();
  const failureManager = createManager({
    store: failureStore,
    objectUrls: failureUrls,
    draftKeys: ["thoughtRoot"],
    rotateFile: () => failureGate.promise
  });
  await failureManager.restore("failure-owner");
  await failureManager.select("thoughtRoot", [
    { ...image("cancelled.png"), direction: "north" }
  ]);
  const preview = failureManager.snapshot("thoughtRoot").items[0].preview;
  const pendingRotation = failureManager.rotate("thoughtRoot", 0);
  await Promise.resolve();
  assert.equal((await failureManager.remove("thoughtRoot", 0)).items.length, 0);
  failureGate.resolve({
    ...image("cancelled.png"),
    direction: "east"
  });
  assert.equal(await pendingRotation, false);
  assert.deepEqual(failureUrls.created, [preview]);
  assert.deepEqual(failureUrls.revoked, [preview]);
  assert.equal(failureStore.record("failure-owner", "thoughtRoot"), null);

  const expected = new Error("pixel decode failed");
  const rejectManager = createManager({
    store: createStore(),
    objectUrls: createObjectUrls(),
    draftKeys: ["thoughtRoot"],
    rotateFile: async () => {
      throw expected;
    }
  });
  await rejectManager.restore("failure-owner");
  await rejectManager.select("thoughtRoot", [
    { ...image("failed.png"), direction: "south" }
  ]);
  const before = rejectManager.snapshot("thoughtRoot").items[0];
  await assert.rejects(rejectManager.rotate("thoughtRoot", 0), expected);
  assert.deepEqual(rejectManager.snapshot("thoughtRoot").items[0], before);
}

{
  const accountRotationGate = deferred();
  const accountRotationStore = createStore([{
    owner: "rotation-b",
    id: "thoughtRoot",
    items: [storedImage("rotation-b.png", { direction: "west" })]
  }]);
  const accountRotationUrls = createObjectUrls();
  const accountRotationManager = createManager({
    store: accountRotationStore,
    objectUrls: accountRotationUrls,
    draftKeys: ["thoughtRoot"],
    rotateFile: () => accountRotationGate.promise
  });
  await accountRotationManager.restore("rotation-a");
  await accountRotationManager.select("thoughtRoot", [
    { ...image("rotation-a.png"), direction: "north" }
  ]);
  const accountARotation = accountRotationManager.rotate("thoughtRoot", 0);
  await Promise.resolve();
  assert.equal(await accountRotationManager.restore("rotation-b"), true);
  const putsBeforeLateRotation = accountRotationStore.calls.filter(
    call => call[0] === "put"
  ).length;
  accountRotationGate.resolve({
    ...image("rotation-a.png"),
    direction: "east"
  });
  assert.equal(await accountARotation, false);
  assert.equal(accountRotationManager.snapshot().owner, "rotation-b");
  assert.equal(
    accountRotationManager.snapshot("thoughtRoot").items[0].file.name,
    "rotation-b.png"
  );
  assert.equal(
    accountRotationStore.calls.filter(call => call[0] === "put").length,
    putsBeforeLateRotation,
    "a late rotation from account A must not persist into account B"
  );
  assert.equal(
    accountRotationUrls.created.length,
    2,
    "a stale transformed file must not allocate a preview URL"
  );
}

const accountAGate = deferred();
const accountARecord = {
  owner: "account-a",
  id: "thoughtRoot",
  items: [storedImage("account-a-root.png")]
};
const isolatedStore = createStore([
  {
    owner: "account-b",
    id: "thoughtRoot",
    context: { rootId: "root-b" },
    items: [storedImage("account-b-root.png")]
  },
  {
    owner: "account-b",
    id: "thoughtBlock",
    context: { rootId: "root-b", blockId: "block-b" },
    items: [storedImage("account-b-block.png")]
  }
], (owner, id) => (
  owner === "account-a" && id === "thoughtRoot"
    ? accountAGate.promise
    : null
));
const isolatedUrls = createObjectUrls();
const isolated = createManager({
  store: isolatedStore,
  objectUrls: isolatedUrls
});

const lateAccountA = isolated.restore("account-a");
await Promise.resolve();
assert.equal(await isolated.restore("account-b"), true);
assert.equal(isolated.snapshot().owner, "account-b");
assert.equal(
  isolated.snapshot("thoughtRoot").items[0].file.name,
  "account-b-root.png"
);
assert.equal(
  isolated.snapshot("thoughtBlock").items[0].file.name,
  "account-b-block.png"
);
accountAGate.resolve(accountARecord);
assert.equal(await lateAccountA, false);
assert.equal(isolated.snapshot().owner, "account-b");
assert.equal(
  isolated.snapshot("thoughtRoot").items[0].file.name,
  "account-b-root.png"
);
assert.equal(
  isolatedStore.calls.filter(call => call[0] === "put").length,
  0,
  "a late account A restore must not write account B"
);

await isolated.persist("thoughtRoot", { rootId: "root-b-updated" });
assert.deepEqual(
  isolatedStore.record("account-b", "thoughtRoot").context,
  { rootId: "root-b-updated" }
);
assert.deepEqual(
  isolatedStore.record("account-b", "thoughtBlock").context,
  { rootId: "root-b", blockId: "block-b" }
);
assert.equal(isolated.resetSession(), true);
assert.equal(isolated.resetSession(), false);
assert.equal(isolated.snapshot().owner, "");
assert.deepEqual(
  isolatedUrls.revoked.sort(),
  isolatedUrls.created.sort(),
  "account switch cleanup must revoke each restored Blob URL"
);
assert.equal(
  isolatedUrls.revoked.length,
  new Set(isolatedUrls.revoked).size,
  "restored Blob URLs must be revoked exactly once"
);

const store = createStore();
const objectUrls = createObjectUrls();
const uploadCalls = [];
const attempts = new Map();
const discardCalls = [];
const manager = createManager({
  store,
  objectUrls,
  async uploadItem(file, requestId, index) {
    uploadCalls.push([file.name, requestId, index]);
    const attempt = (attempts.get(file.name) || 0) + 1;
    attempts.set(file.name, attempt);
    if (file.name === "two.png" && attempt === 1) {
      throw Object.assign(new Error("second upload failed"), { status: 503 });
    }
    return `/attachments/${file.name}`;
  },
  async discardItem(item, fallbackRequestId) {
    discardCalls.push([
      item.uploadedPath,
      item.uploadRequestId || fallbackRequestId
    ]);
    return true;
  }
});

assert.equal(await manager.restore("account-main"), true);
await manager.select("thoughtRoot", [image("one.png"), image("two.png")]);
await manager.select("thoughtBlock", [image("block.png")]);
await manager.persist("thoughtBlock", {
  rootId: "thought-root-1",
  blockId: "thought-block-1"
});
assert.deepEqual(
  manager.snapshot("thoughtRoot").items.map(item => item.file.name),
  ["one.png", "two.png"]
);
assert.deepEqual(
  manager.snapshot("thoughtBlock").items.map(item => item.file.name),
  ["block.png"]
);
assert.deepEqual(
  store.record("account-main", "thoughtBlock").context,
  { rootId: "thought-root-1", blockId: "thought-block-1" }
);
assert.deepEqual(
  store.calls.filter(call => call[0] === "put").map(call => call[2]).slice(0, 3),
  ["thoughtRoot", "thoughtBlock", "thoughtBlock"],
  "thoughtRoot and thoughtBlock must remain separate store keys"
);

await assert.rejects(
  manager.submit("thoughtRoot"),
  error => error instanceof AggregateError
    && error.failedIndexes.length === 1
    && error.failedIndexes[0] === 1
);
assert.deepEqual(
  uploadCalls.map(call => call[0]),
  ["one.png", "two.png"]
);
assert.equal(
  manager.snapshot("thoughtRoot").items[0].uploadedPath,
  "/attachments/one.png"
);
assert.equal(
  manager.snapshot("thoughtRoot").items[1].lastError.message,
  "second upload failed"
);

const rootSubmission = await manager.submit("thoughtRoot");
assert.deepEqual(
  uploadCalls.map(call => call[0]),
  ["one.png", "two.png", "two.png"],
  "retry must upload only the failed item"
);
assert.deepEqual(rootSubmission, {
  attachmentPaths: [
    "/attachments/one.png",
    "/attachments/two.png"
  ],
  uploadedPaths: [
    "/attachments/one.png",
    "/attachments/two.png"
  ]
});
assert.deepEqual(
  manager.snapshot("thoughtRoot").items.map(item => item.file.name),
  ["one.png", "two.png"],
  "partial retry must preserve item order"
);

const rollback = await manager.rollback(
  "thoughtRoot",
  Object.assign(new Error("validation failed"), { status: 400 }),
  { uploadedPaths: rootSubmission.uploadedPaths }
);
assert.deepEqual(rollback, {
  retained: false,
  compensated: [
    "/attachments/one.png",
    "/attachments/two.png"
  ],
  failed: []
});
assert.deepEqual(
  manager.snapshot("thoughtRoot").items.map(item => item.uploadedPath),
  ["", ""]
);
const discardCountAfterRollback = discardCalls.length;
await manager.rollback(
  "thoughtRoot",
  Object.assign(new Error("validation failed"), { status: 400 }),
  { uploadedPaths: rootSubmission.uploadedPaths }
);
assert.equal(
  discardCalls.length,
  discardCountAfterRollback,
  "repeated rollback must not compensate the same leases twice"
);

const blockSubmission = await manager.submit("thoughtBlock");
assert.deepEqual(blockSubmission.attachmentPaths, ["/attachments/block.png"]);
const uncertainErrors = [
  new Error("network failed"),
  Object.assign(new Error("timeout"), { status: 408 }),
  Object.assign(new Error("too early"), { status: 425 }),
  Object.assign(new Error("limited"), { status: 429 }),
  Object.assign(new Error("server failed"), { status: 503 })
];
for (const error of uncertainErrors) {
  assert.equal(isUncertainContentImageSubmission(error), true);
  assert.equal((await manager.rollback("thoughtBlock", error)).retained, true);
}
assert.equal(
  manager.snapshot("thoughtBlock").items[0].uploadedPath,
  "/attachments/block.png"
);
assert.equal(discardCalls.length, discardCountAfterRollback);
assert.equal(
  isUncertainContentImageSubmission(
    Object.assign(new Error("bad request"), { status: 400 })
  ),
  false
);

const blockDeletesBefore = store.calls.filter(
  call => call[0] === "delete" && call[2] === "thoughtBlock"
).length;
assert.equal(await manager.complete("thoughtBlock"), true);
assert.equal(await manager.complete("thoughtBlock"), false);
assert.equal(
  store.calls.filter(
    call => call[0] === "delete" && call[2] === "thoughtBlock"
  ).length,
  blockDeletesBefore + 1,
  "repeated complete must delete the stored draft once"
);

await manager.replaceExisting("thoughtRoot", [
  "/attachments/existing.png",
  "/attachments/existing.png"
]);
assert.deepEqual(
  manager.snapshot("thoughtRoot").items.map(item => item.path),
  ["/attachments/existing.png"]
);
await manager.select("thoughtRoot", [image("replacement.png")]);
const replacementSubmission = await manager.submit("thoughtRoot");
assert.deepEqual(replacementSubmission.attachmentPaths, [
  "/attachments/existing.png",
  "/attachments/replacement.png"
]);
const discardBeforeReplace = discardCalls.length;
await manager.replaceExisting(
  "thoughtRoot",
  ["/attachments/committed.png"]
);
assert.deepEqual(
  discardCalls.slice(discardBeforeReplace),
  [["/attachments/replacement.png", uploadCalls.at(-1)[1]]],
  "replaceExisting must compensate a replaced pending upload"
);
await manager.replaceExisting(
  "thoughtRoot",
  ["/attachments/committed.png"]
);
assert.equal(discardCalls.length, discardBeforeReplace + 1);
assert.equal(await manager.abandon("thoughtRoot"), true);
assert.equal(await manager.abandon("thoughtRoot"), false);

await manager.persist("thoughtBlock", { rootId: "abandon-root" });
await manager.select("thoughtBlock", [image("abandon.png")]);
await manager.submit("thoughtBlock");
const discardBeforeAbandon = discardCalls.length;
assert.equal(await manager.abandon("thoughtBlock"), true);
assert.equal(await manager.abandon("thoughtBlock"), false);
assert.equal(discardCalls.length, discardBeforeAbandon + 1);
assert.equal(discardCalls.at(-1)[0], "/attachments/abandon.png");

await manager.select("thoughtRoot", [image("session.png")]);
const storedBeforeReset = store.record("account-main", "thoughtRoot");
assert.equal(manager.resetSession(), true);
assert.equal(manager.resetSession(), false);
assert.deepEqual(
  store.record("account-main", "thoughtRoot"),
  storedBeforeReset,
  "session reset must preserve the durable draft"
);
assert.equal(objectUrls.revoked.length, objectUrls.created.length);
assert.equal(
  objectUrls.revoked.length,
  new Set(objectUrls.revoked).size,
  "every Blob URL must be revoked exactly once"
);

{
  const removeStore = createStore();
  const removeUrls = createObjectUrls();
  const removeManager = createManager({
    store: removeStore,
    objectUrls: removeUrls,
    draftKeys: ["thoughtBlock"]
  });
  await removeManager.restore("remove-owner");
  await removeManager.select("thoughtBlock", [image("remove.png")]);
  assert.equal((await removeManager.remove("thoughtBlock", 0)).items.length, 0);
  assert.equal(await removeManager.remove("thoughtBlock", 0), false);
  assert.deepEqual(removeUrls.revoked, removeUrls.created);
}

{
  const reusedUrls = {
    revoked: [],
    createObjectURL() {
      return "blob:reused-value";
    },
    revokeObjectURL(value) {
      this.revoked.push(value);
    }
  };
  const reusedManager = createManager({
    store: createStore(),
    objectUrls: reusedUrls,
    draftKeys: ["comment"]
  });
  await reusedManager.restore("reused-owner");
  await reusedManager.select("comment", [image("first-reused.png")]);
  await reusedManager.remove("comment", 0);
  await reusedManager.select("comment", [image("second-reused.png")]);
  await reusedManager.remove("comment", 0);
  assert.deepEqual(
    reusedUrls.revoked,
    ["blob:reused-value", "blob:reused-value"],
    "revoked URL ownership must be released so a reused value is independently owned"
  );
}

console.log(
  "Content image draft manager checks passed: EXIF pixels, DOM rotation handlers, original-derived turns, account generations, isolated keys, partial retry order, rollback classification, compensation, item removal, durable reset and idempotent Blob URL cleanup."
);
