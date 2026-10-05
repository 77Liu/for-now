import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { safeText } from "../shared/validation/index.mjs";
import {
  LOCAL_TEST_COLLECTION_ENDPOINTS,
  LOCAL_TEST_SCOPE_COLLECTIONS,
  isLocalTestMode,
  isLocalTestScope,
  localTestRecordCount,
  mergeLocalTestCollection,
  normalizeLocalTestControl
} from "./local-test-control.mjs";

const localTestUser = mode => ({
  id: `local-test-${mode}`,
  username: mode === "simulation" ? "使用模拟" : "冷启测试",
  role: "owner",
  createdAt: ""
});

const fail = (statusCode, message, code) => {
  throw Object.assign(new Error(message), { statusCode, code });
};

export function createLocalTestRuntime({
  enabled,
  upstreamConfigured,
  dataDir,
  controlFile,
  workspacesDir,
  resetOnStart,
  mainUserId,
  requestStorage,
  storeRepository,
  storagePaths,
  emptyStore,
  normalizeStore,
  readDocument,
  writeDocument,
  ensureStore,
  ensureSettings,
  ensureUsage,
  ensureAuditLogs,
  writeSettings,
  projectState,
  readStore,
  updateStore,
  sessionForRequest,
  isOwner,
  upstream,
  now,
  clone = structuredClone,
  removeDocument = file => fs.rm(file, { force: true })
}) {
  let controlQueue = Promise.resolve();
  let switchBarrier = Promise.resolve();
  const pendingControlFile = `${controlFile}.pending`;

  const workspaceDir = mode => path.join(
    workspacesDir,
    mode === "simulation" ? "simulation" : "cold"
  );
  const runSerial = operation => {
    const current = controlQueue.then(operation);
    controlQueue = current.catch(() => {});
    return current;
  };
  const requireOwner = request => {
    const session = sessionForRequest(request);
    if (!session?.user?.id) {
      fail(401, "本地登录会话已失效，请重新登录", "AUTH_REQUIRED");
    }
    if (!isOwner(session.user)) {
      fail(403, "当前账户没有 Owner 权限", "OWNER_REQUIRED");
    }
    return session;
  };
  const requireMainOwner = request => {
    const session = requireOwner(request);
    if (mainUserId && session.user.id !== mainUserId) {
      fail(403, "当前登录账户不是配置的线上主账户", "LOCAL_TEST_MAIN_ACCOUNT_REQUIRED");
    }
    return session;
  };
  const writeControlDocument = async (file, value) => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await fs.chmod(dataDir, 0o700);
    const normalized = normalizeLocalTestControl(value);
    await writeDocument(file, normalized);
    return normalized;
  };
  const writeControl = value => writeControlDocument(controlFile, value);
  const writePendingControl = value => writeControlDocument(pendingControlFile, value);
  const clearPendingControl = () => removeDocument(pendingControlFile);
  const readControl = async () => {
    const pending = await readDocument(pendingControlFile, null);
    if (pending) {
      const recovered = await writeControl(pending);
      await clearPendingControl().catch(() => {});
      return recovered;
    }
    return normalizeLocalTestControl(
      await readDocument(controlFile, { mode: "cold" })
    );
  };

  async function resetWorkspace(
    mode,
    store,
    settings = null,
    attachmentCopies = new Map(),
    nextControl = null
  ) {
    const targetDir = workspaceDir(mode);
    const stagingDir = path.join(
      workspacesDir,
      `.switch-${mode}-${crypto.randomUUID()}`
    );
    const backupDir = `${stagingDir}.backup`;
    const currentSettings = await readDocument(
      path.join(targetDir, "llm-settings.json"),
      null
    );
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 });
    await fs.chmod(stagingDir, 0o700);
    try {
      if (mode === "simulation" && currentSettings) {
        await writeDocument(
          path.join(stagingDir, "llm-settings.json"),
          currentSettings
        );
      }
      await requestStorage.run({
        ...(requestStorage.getStore() || {}),
        user: localTestUser(mode),
        dataDir: stagingDir
      }, async () => {
        await ensureStore();
        await storeRepository.replace(normalizeStore(store));
        await fs.mkdir(storagePaths().attachmentsDir, { recursive: true, mode: 0o700 });
        await fs.chmod(storagePaths().attachmentsDir, 0o700);
        for (const [resourcePath, bytes] of attachmentCopies) {
          const name = resourcePath.slice("/attachments/".length);
          await fs.writeFile(
            path.join(storagePaths().attachmentsDir, name),
            bytes,
            { mode: 0o600 }
          );
        }
        await ensureSettings();
        if (settings) {
          await writeSettings({
            ...settings,
            apiKey: safeText(currentSettings?.apiKey, 300)
          });
        }
        await ensureUsage();
        await ensureAuditLogs();
      });

      let backupPresent = false;
      await requestStorage.run({
        ...(requestStorage.getStore() || {}),
        user: localTestUser(mode),
        dataDir: targetDir
      }, () => storeRepository.withExclusive(async ({ document }) => {
        if (document?.aiTasks?.some(task => ["queued", "running"].includes(task.status))) {
          fail(
            409,
            "该测试空间仍有后台任务，请等待完成后再切换",
            "LOCAL_TEST_TASKS_ACTIVE"
          );
        }
        await fs.rm(backupDir, { recursive: true, force: true });
        try {
          await fs.rename(targetDir, backupDir);
          backupPresent = true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        try {
          await fs.rename(stagingDir, targetDir);
          if (nextControl) await writeControl(nextControl);
        } catch (error) {
          await fs.rm(targetDir, { recursive: true, force: true });
          if (backupPresent) await fs.rename(backupDir, targetDir);
          throw error;
        }
      }));
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
      return nextControl ? normalizeLocalTestControl(nextControl) : null;
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  let upstreamStatePromise = null;
  async function scopePatch(request, collections) {
    const patch = {};
    upstreamStatePromise = null;
    const upstreamState = () => upstreamStatePromise ||= upstream.json(request, "/api/state");
    const loadCollection = async collection => {
      if (collection === "trash") {
        const value = await upstream.json(request, "/api/trash");
        patch.trash = Array.isArray(value?.items) ? value.items : [];
        return;
      }
      if (collection === "journalDraft") {
        try {
          patch.journalDraft = (await upstream.json(request, "/api/v1/journal-draft"))?.data || null;
        } catch (error) {
          if (error.statusCode !== 404) throw error;
          patch.journalDraft = clone((await upstreamState()).journalDraft || null);
        }
        return;
      }
      if (collection === "habitCheckins") return;
      const endpoint = LOCAL_TEST_COLLECTION_ENDPOINTS[collection];
      if (endpoint) {
        try {
          const items = await upstream.list(request, endpoint);
          patch[collection] = collection === "thoughts"
            ? items.flatMap(({ blocks = [], ...root }) => [
                root,
                ...(Array.isArray(blocks) ? blocks : [])
              ])
            : items;
          return;
        } catch (error) {
          if (error.statusCode !== 404) throw error;
        }
      }
      patch[collection] = clone((await upstreamState())[collection] ?? emptyStore[collection]);
    };
    await Promise.all(collections.map(loadCollection));
    if (collections.includes("habitCheckins")) {
      const habits = patch.habits
        || await upstream.list(request, LOCAL_TEST_COLLECTION_ENDPOINTS.habits);
      patch.habitCheckins = (await Promise.all(
        habits.map(habit => upstream.list(
          request,
          `/api/v1/habits/${encodeURIComponent(habit.id)}/checkins`
        ))
      )).flat();
    }
    if (patch.keepsakes) {
      patch.keepsakes = await Promise.all(patch.keepsakes.map(async item => (
        item.originalPath
          ? item
          : {
              ...item,
              ...(await upstream.json(
                request,
                `/api/keepsakes/${encodeURIComponent(item.id)}/original`
              ))
            }
      )));
    }
    return patch;
  }

  const switchMode = (request, mode) => {
    const operation = runSerial(async () => {
      if (!isLocalTestMode(mode)) {
        fail(400, "本地测试模式无效", "LOCAL_TEST_MODE_INVALID");
      }
      const previousControl = await readControl();
      const session = mode === "simulation" ? requireMainOwner(request) : null;
      const snapshot = mode === "simulation"
        ? normalizeStore({
          ...clone(emptyStore),
          onboarding: {
            ...clone(emptyStore.onboarding),
            status: "completed"
          }
        })
        : emptyStore;
      const nextControl = {
        mode,
        switchedAt: now(),
        snapshotAt: "",
        sourceUser: session?.user || null,
        recordCount: 0,
        loadedScopes: [],
        loadedCollections: []
      };
      await writeControl({
        ...previousControl,
        snapshotAt: "",
        recordCount: 0,
        loadedScopes: [],
        loadedCollections: []
      });
      await resetWorkspace(mode, snapshot, null, new Map(), nextControl);
      return normalizeLocalTestControl(nextControl);
    });
    switchBarrier = operation.catch(() => {});
    return operation;
  };

  const hydrateScope = (request, scope) => runSerial(async () => {
    if (!isLocalTestScope(scope)) {
      fail(400, "本地测试数据范围无效", "LOCAL_TEST_SCOPE_INVALID");
    }
    const control = await readControl();
    if (control.mode !== "simulation") {
      fail(409, "当前不是使用模拟模式", "LOCAL_TEST_MODE_MISMATCH");
    }
    const missingCollections = LOCAL_TEST_SCOPE_COLLECTIONS[scope]
      .filter(collection => !control.loadedCollections.includes(collection));
    if (control.loadedScopes.includes(scope) || !missingCollections.length) {
      const nextControl = control.loadedScopes.includes(scope)
        ? control
        : await writeControl({
            ...control,
            loadedScopes: [...control.loadedScopes, scope]
          });
      return {
        control: nextControl,
        state: projectState(await readStore()),
        hydrated: false
      };
    }
    requireMainOwner(request);
    const patch = await scopePatch(request, missingCollections);
    let nextControl = null;
    const merged = await updateStore(store => {
      for (const [collection, value] of Object.entries(patch)) {
        store[collection] = mergeLocalTestCollection(
          collection,
          store[collection],
          value
        );
      }
      nextControl = normalizeLocalTestControl({
        ...control,
        snapshotAt: now(),
        loadedScopes: [...control.loadedScopes, scope],
        loadedCollections: [...control.loadedCollections, ...missingCollections],
        recordCount: localTestRecordCount(store)
      });
      return store;
    });
    await writePendingControl(nextControl);
    const committedControl = await writeControl(nextControl);
    await clearPendingControl().catch(() => {});
    return {
      control: committedControl,
      state: projectState(merged),
      hydrated: true
    };
  });

  const initialize = async recoverWorkspace => {
    if (!enabled) return false;
    await fs.mkdir(workspacesDir, { recursive: true, mode: 0o700 });
    await fs.chmod(workspacesDir, 0o700);
    if (resetOnStart) await resetWorkspace("cold", emptyStore);
    const control = resetOnStart
      ? normalizeLocalTestControl({
          mode: "cold",
          switchedAt: now(),
          snapshotAt: "",
          sourceUser: null,
          recordCount: 0,
          loadedScopes: [],
          loadedCollections: []
        })
      : await readControl();
    await writeControl(control);
    await requestStorage.run({
      user: localTestUser(control.mode),
      dataDir: workspaceDir(control.mode)
    }, recoverWorkspace);
    return true;
  };

  const prepareRequestContext = async context => {
    if (!enabled) return null;
    while (true) {
      const barrier = switchBarrier;
      await barrier;
      const control = await readControl();
      if (barrier !== switchBarrier) continue;
      context.localTestMode = control.mode;
      context.dataDir = workspaceDir(control.mode);
      return control;
    }
  };

  return Object.freeze({
    enabled: Boolean(enabled),
    upstreamConfigured: Boolean(upstreamConfigured),
    workspaceDir,
    readControl,
    publicControl: control => ({
      enabled: Boolean(enabled),
      upstreamConfigured: Boolean(upstreamConfigured),
      ...normalizeLocalTestControl(control)
    }),
    requireOwner,
    switchMode,
    hydrateScope,
    initialize,
    prepareRequestContext,
    canProxyAttachment: context => Boolean(
      enabled
      && upstreamConfigured
      && context?.localTestMode === "simulation"
    )
  });
}
