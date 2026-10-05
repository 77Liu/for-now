import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createLocalTestRuntime,
  createStoreNormalizer,
  emptyStore
} from "../src/app/index.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-local-runtime-"));
const controlFile = path.join(root, "local-test-mode.json");
const workspacesDir = path.join(root, "local-test-workspaces");
const requestStorage = new AsyncLocalStorage();
const documents = new Map();
const clone = value => structuredClone(value);
let failControlWrite = false;
let failControlWriteAt = 0;
let controlWriteCount = 0;
let failEnsureUsage = false;
let upstreamItems = [];
let holdUpdateCommit = false;
let updateMutatorDone;
let releaseUpdateCommit;
let pauseNextControlRead = false;
let controlReadEntered;
let releaseControlRead;
const readDocument = async (file, fallback) => {
  if (file === controlFile && pauseNextControlRead) {
    pauseNextControlRead = false;
    controlReadEntered?.();
    await new Promise(resolve => { releaseControlRead = resolve; });
  }
  return documents.has(file) ? clone(documents.get(file)) : clone(fallback);
};
const writeDocument = async (file, value) => {
  if (file === controlFile) controlWriteCount += 1;
  if (
    file === controlFile
    && (failControlWrite || controlWriteCount === failControlWriteAt)
  ) {
    throw Object.assign(new Error("control write failed"), { code: "WRITE_FAILED" });
  }
  documents.set(file, clone(value));
};
const fixedNow = "2026-10-05T10:00:00.000Z";
const normalizeStore = createStoreNormalizer({
  now: () => fixedNow,
  today: () => "2026-10-05",
  currentTime: () => Date.parse(fixedNow)
});
const stores = new Map();
let replaceCalls = 0;
let holdReplace = false;
let replaceEntered;
let releaseReplace;
let stagedStore = null;
const storagePaths = () => {
  const dataDir = requestStorage.getStore()?.dataDir || root;
  return {
    dataDir,
    storeFile: path.join(dataDir, "store.json"),
    attachmentsDir: path.join(dataDir, "attachments")
  };
};
const currentStore = () => (
  stores.get(storagePaths().storeFile) || normalizeStore({})
);
const storeRepository = {
  async replace(value, { beforeWrite } = {}) {
    replaceCalls += 1;
    const next = normalizeStore(value);
    await beforeWrite?.(clone(currentStore()));
    stores.set(storagePaths().storeFile, next);
    stagedStore = next;
    return clone(next);
  },
  async withExclusive(operation) {
    const file = storagePaths().storeFile;
    if (holdReplace) {
      replaceEntered?.();
      await new Promise(resolve => { releaseReplace = resolve; });
    }
    const result = await operation({ file, document: clone(currentStore()) });
    if (stagedStore) stores.set(file, clone(stagedStore));
    return result;
  }
};
const ownerSession = {
  token: "owner-session",
  cookie: "upstream=session",
  user: { id: "main-user", username: "owner", role: "owner" }
};
const runtime = createLocalTestRuntime({
  enabled: true,
  upstreamConfigured: true,
  dataDir: root,
  controlFile,
  workspacesDir,
  resetOnStart: false,
  mainUserId: "main-user",
  requestStorage,
  storeRepository,
  storagePaths,
  emptyStore,
  normalizeStore,
  readDocument,
  writeDocument,
  ensureStore: async () => {},
  ensureSettings: async () => {},
  ensureUsage: async () => {
    if (failEnsureUsage) throw Object.assign(new Error("usage failed"), { code: "USAGE_FAILED" });
  },
  ensureAuditLogs: async () => {},
  writeSettings: async () => {},
  projectState: clone,
  readStore: async () => clone(currentStore()),
  updateStore: async mutator => {
    const next = clone(currentStore());
    const result = await mutator(next);
    if (holdUpdateCommit) {
      updateMutatorDone?.();
      await new Promise(resolve => { releaseUpdateCommit = resolve; });
    }
    stores.set(storagePaths().storeFile, normalizeStore(next));
    return result;
  },
  sessionForRequest: () => ownerSession,
  isOwner: user => user?.role === "owner",
  upstream: {
    json: async () => ({}),
    list: async () => clone(upstreamItems)
  },
  now: () => fixedNow,
  removeDocument: async file => { documents.delete(file); }
});
const ownerRequest = { headers: {} };
const workspaceStore = mode => stores.get(path.join(runtime.workspaceDir(mode), "store.json"));

failControlWrite = true;
await assert.rejects(
  runtime.switchMode(ownerRequest, "simulation"),
  error => error.code === "WRITE_FAILED"
);
assert.equal(replaceCalls, 0);
assert.equal(documents.has(controlFile), false);
failControlWrite = false;

holdReplace = true;
const replaceStarted = new Promise(resolve => { replaceEntered = resolve; });
const switching = requestStorage.run(
  { traceId: "switch-trace" },
  () => runtime.switchMode(ownerRequest, "simulation")
);
await replaceStarted;
assert.equal((await readDocument(controlFile, {})).mode, "cold");
const requestContext = {};
let requestPrepared = false;
const preparing = runtime.prepareRequestContext(requestContext).then(() => {
  requestPrepared = true;
});
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(requestPrepared, false);
releaseReplace();
await switching;
await preparing;
assert.equal(requestPrepared, true);
assert.equal(requestContext.localTestMode, "simulation");
assert.equal(requestContext.dataDir, runtime.workspaceDir("simulation"));
assert.equal(workspaceStore("simulation").onboarding.status, "completed");

holdReplace = false;
workspaceStore("simulation").captures.push({ id: "preserved-local" });
const beforeFailedReset = clone(workspaceStore("simulation"));
failEnsureUsage = true;
await assert.rejects(
  runtime.switchMode(ownerRequest, "simulation"),
  error => error.code === "USAGE_FAILED"
);
failEnsureUsage = false;
assert.deepEqual(workspaceStore("simulation"), beforeFailedReset);
failControlWriteAt = controlWriteCount + 2;
await assert.rejects(
  runtime.switchMode(ownerRequest, "simulation"),
  error => error.code === "WRITE_FAILED"
);
failControlWriteAt = 0;
assert.deepEqual(workspaceStore("simulation"), beforeFailedReset);
assert.equal((await readDocument(controlFile, {})).mode, "simulation");
stores.set(
  path.join(runtime.workspaceDir("cold"), "store.json"),
  normalizeStore({
    ...clone(emptyStore),
    aiTasks: [{ id: "queued-task", kind: "analysis", status: "queued" }]
  })
);
await assert.rejects(
  runtime.switchMode(ownerRequest, "cold"),
  error => error.code === "LOCAL_TEST_TASKS_ACTIVE"
);
assert.equal(workspaceStore("cold").aiTasks[0].id, "queued-task");
assert.deepEqual(await readDocument(controlFile, {}), {
  mode: "simulation",
  switchedAt: fixedNow,
  snapshotAt: "",
  sourceUser: { id: "main-user", username: "owner" },
  recordCount: 0,
  loadedScopes: [],
  loadedCollections: []
});

workspaceStore("cold").aiTasks = [];
holdReplace = true;
const firstReplacementStarted = new Promise(resolve => { replaceEntered = resolve; });
const firstSwitch = runtime.switchMode(ownerRequest, "cold");
await firstReplacementStarted;
pauseNextControlRead = true;
const pausedControlRead = new Promise(resolve => { controlReadEntered = resolve; });
const racedContext = {};
let racedPrepared = false;
const racedPreparation = runtime.prepareRequestContext(racedContext).then(() => {
  racedPrepared = true;
});
const releaseFirstReplacement = releaseReplace;
releaseFirstReplacement();
await pausedControlRead;
const secondReplacementStarted = new Promise(resolve => { replaceEntered = resolve; });
const secondSwitch = runtime.switchMode(ownerRequest, "simulation");
await secondReplacementStarted;
releaseControlRead();
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(racedPrepared, false);
releaseReplace();
await Promise.all([firstSwitch, secondSwitch, racedPreparation]);
assert.equal(racedContext.localTestMode, "simulation");
assert.equal(racedContext.dataDir, runtime.workspaceDir("simulation"));

upstreamItems = [{ id: "remote-hydrated", content: "remote" }];
holdUpdateCommit = true;
const updateReachedCommit = new Promise(resolve => { updateMutatorDone = resolve; });
failControlWriteAt = controlWriteCount + 1;
const hydration = requestStorage.run({
  user: ownerSession.user,
  dataDir: runtime.workspaceDir("simulation")
}, () => runtime.hydrateScope(ownerRequest, "captures"));
await updateReachedCommit;
assert.equal(documents.has(`${controlFile}.pending`), false);
releaseUpdateCommit();
await assert.rejects(
  hydration,
  error => error.code === "WRITE_FAILED"
);
holdUpdateCommit = false;
failControlWriteAt = 0;
assert.equal(
  workspaceStore("simulation").captures.some(item => item.id === "remote-hydrated"),
  true
);
assert.equal(documents.has(`${controlFile}.pending`), true);
const recoveredControl = await runtime.readControl();
assert.ok(recoveredControl.loadedScopes.includes("captures"));
assert.ok(recoveredControl.loadedCollections.includes("captures"));
assert.equal(documents.has(`${controlFile}.pending`), false);

await fs.rm(root, { recursive: true, force: true });
console.log("Local test runtime checks passed: staged resets, generation-safe switch barriers, pending-control recovery and active-task rejection.");
