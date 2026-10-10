import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccountLifecycle } from "../src/app/index.mjs";
import { createAuthService } from "../src/modules/auth/index.mjs";

const RECOVERY_ORDER = [
  "store",
  "settings",
  "usage",
  "audit",
  "attachment-cleanup",
  "background-ai",
  "keepsake-media"
];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-account-lifecycle-"));

const mode = async directory => (await fs.stat(directory)).mode & 0o777;
const steps = events => events.map(event => event.step);

function harness({
  name,
  authRequired = false,
  postgresRuntime = null,
  localTestRuntime = null,
  readUsers = null,
  failAt = () => false
}) {
  const dataDir = path.join(root, name);
  const requestStorage = new AsyncLocalStorage();
  const events = [];
  const operation = step => async () => {
    const context = requestStorage.getStore();
    events.push({
      step,
      userId: context?.user?.id || "",
      dataDir: context?.dataDir || ""
    });
    if (failAt(step, context)) throw new Error(`failed:${step}:${context?.user?.id || "current"}`);
  };
  const lifecycle = createAccountLifecycle({
    dataDir,
    authRequired,
    postgresRuntime,
    requestStorage,
    emptyStore: { version: 18, captures: [] },
    normalizeStore: value => ({ ...value, normalized: true }),
    normalizeLlmSettings: () => ({ version: 5, kind: "settings" }),
    normalizeAiUsage: () => ({ version: 1, entries: [] }),
    ensureStore: operation("store"),
    ensureLlmSettings: operation("settings"),
    ensureAiUsage: operation("usage"),
    ensureAuditLogs: operation("audit"),
    resumeAttachmentCleanup: operation("attachment-cleanup"),
    backgroundAi: { resume: operation("background-ai") },
    keepsakeMediaWorkflows: { resume: operation("keepsake-media") },
    localTestRuntime,
    readUsers
  });
  return { dataDir, events, lifecycle, requestStorage };
}

{
  const current = harness({ name: "current-order" });
  await current.lifecycle.recoverCurrentStorage();
  assert.deepEqual(steps(current.events), RECOVERY_ORDER);

  const failed = harness({
    name: "current-failure",
    failAt: step => step === "usage"
  });
  await assert.rejects(failed.lifecycle.recoverCurrentStorage(), /failed:usage:current/);
  assert.deepEqual(steps(failed.events), ["store", "settings", "usage"]);
}

{
  const legacy = harness({ name: "json-legacy" });
  await fs.mkdir(path.join(legacy.dataDir, "attachments"), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.join(legacy.dataDir, "logs"), { recursive: true, mode: 0o755 });
  await fs.chmod(path.join(legacy.dataDir, "attachments"), 0o755);
  await fs.chmod(path.join(legacy.dataDir, "logs"), 0o755);
  await Promise.all([
    fs.writeFile(path.join(legacy.dataDir, "store.json"), "{\"legacy\":\"store\"}\n"),
    fs.writeFile(path.join(legacy.dataDir, "llm-settings.json"), "{\"legacy\":\"settings\"}\n"),
    fs.writeFile(path.join(legacy.dataDir, "ai-usage.json"), "{\"legacy\":\"usage\"}\n"),
    fs.writeFile(path.join(legacy.dataDir, "attachments", "legacy.bin"), "attachment"),
    fs.writeFile(path.join(legacy.dataDir, "logs", "legacy.ndjson"), "{}\n")
  ]);

  const owner = { id: "owner", role: "owner" };
  await legacy.lifecycle.initializeUserStorage(owner, true);
  const ownerDir = legacy.lifecycle.userDataDir(owner);
  assert.equal(ownerDir, path.join(legacy.dataDir, "users", "owner"));
  assert.equal(await mode(ownerDir), 0o700);
  assert.equal(await mode(path.join(ownerDir, "attachments")), 0o700);
  assert.equal(await mode(path.join(ownerDir, "logs")), 0o700);
  assert.match(await fs.readFile(path.join(ownerDir, "store.json"), "utf8"), /legacy/);
  assert.equal(await fs.readFile(path.join(ownerDir, "attachments", "legacy.bin"), "utf8"), "attachment");
  assert.deepEqual(steps(legacy.events), ["store", "settings", "usage", "audit"]);
  assert.ok(legacy.events.every(event => event.userId === "owner" && event.dataDir === ownerDir));

  const regular = { id: "regular", role: "user" };
  await legacy.lifecycle.initializeUserStorage(regular, false);
  await assert.rejects(
    fs.access(path.join(legacy.lifecycle.userDataDir(regular), "store.json")),
    error => error.code === "ENOENT"
  );
}

{
  const transactionStorage = new AsyncLocalStorage();
  const provisions = [];
  const postgresRuntime = {
    auth: {
      provision(id, store, documents) {
        provisions.push({
          id,
          store,
          documents,
          transactionId: transactionStorage.getStore()?.id || ""
        });
      }
    }
  };
  const postgres = harness({ name: "postgres", postgresRuntime, authRequired: true });
  await fs.mkdir(postgres.dataDir, { recursive: true });
  await fs.writeFile(path.join(postgres.dataDir, "store.json"), "{\"legacy\":true}\n");

  const user = { id: "pg-user", role: "owner" };
  await transactionStorage.run(
    { id: "auth-transaction" },
    () => postgres.lifecycle.initializeUserStorage(user, true)
  );

  const target = postgres.lifecycle.userDataDir(user);
  assert.deepEqual(provisions, [{
    id: "pg-user",
    store: { version: 18, captures: [], normalized: true },
    documents: {
      settings: { version: 5, kind: "settings" },
      usage: { version: 1, entries: [] }
    },
    transactionId: "auth-transaction"
  }]);
  assert.deepEqual(steps(postgres.events), ["audit"]);
  assert.equal(postgres.events[0].userId, "pg-user");
  assert.equal(postgres.events[0].dataDir, target);
  assert.equal(await mode(target), 0o700);
  assert.equal(await mode(path.join(target, "attachments")), 0o700);
  await assert.rejects(fs.access(path.join(target, "store.json")), error => error.code === "ENOENT");
}

{
  const defaultStartup = harness({
    name: "startup-default",
    postgresRuntime: { auth: { provision() {} } }
  });
  await defaultStartup.lifecycle.recoverAtStartup();
  assert.deepEqual(steps(defaultStartup.events), RECOVERY_ORDER);
  assert.equal(await mode(path.join(defaultStartup.dataDir, "users")), 0o700);
}

{
  const calls = [];
  const disabledLocalTestRuntime = {
    async initialize() {
      calls.push("initialize-disabled");
      return false;
    }
  };
  const disabledLocal = harness({
    name: "startup-local-disabled",
    localTestRuntime: disabledLocalTestRuntime
  });
  await disabledLocal.lifecycle.recoverAtStartup();
  assert.deepEqual(calls, ["initialize-disabled"]);
  assert.deepEqual(steps(disabledLocal.events), RECOVERY_ORDER);
}

{
  const localDataDir = path.join(root, "startup-local", "local-test-workspaces", "cold");
  const calls = [];
  let local;
  const localTestRuntime = {
    async initialize(recover) {
      calls.push("initialize");
      await fs.mkdir(localDataDir, { recursive: true });
      await local.requestStorage.run(
        { user: { id: "local-test-cold", role: "owner" }, dataDir: localDataDir },
        recover
      );
      return true;
    }
  };
  local = harness({ name: "startup-local", localTestRuntime });
  await local.lifecycle.recoverAtStartup();
  assert.deepEqual(calls, ["initialize"]);
  assert.deepEqual(steps(local.events), RECOVERY_ORDER);
  assert.ok(local.events.every(event => (
    event.userId === "local-test-cold" && event.dataDir === localDataDir
  )));
}

{
  const users = [
    { id: "account-a", role: "owner" },
    { id: "account-b", role: "user" }
  ];
  const authenticated = harness({
    name: "startup-auth",
    authRequired: true,
    postgresRuntime: { auth: { provision() {} } }
  });
  await authenticated.lifecycle.recoverAtStartup({ readUsers: async () => users });
  assert.deepEqual(steps(authenticated.events), [...RECOVERY_ORDER, ...RECOVERY_ORDER]);
  for (const [index, user] of users.entries()) {
    const accountEvents = authenticated.events.slice(
      index * RECOVERY_ORDER.length,
      (index + 1) * RECOVERY_ORDER.length
    );
    const expectedDataDir = authenticated.lifecycle.userDataDir(user);
    assert.ok(accountEvents.every(event => (
      event.userId === user.id && event.dataDir === expectedDataDir
    )));
    assert.equal(await mode(expectedDataDir), 0o700);
  }
  assert.equal(authenticated.requestStorage.getStore(), undefined);
}

{
  const users = [
    { id: "json-account-a", role: "owner" },
    { id: "json-account-b", role: "user" }
  ];
  const authenticatedJson = harness({
    name: "startup-auth-json",
    authRequired: true
  });
  await authenticatedJson.lifecycle.recoverAtStartup({ readUsers: async () => users });
  assert.deepEqual(
    authenticatedJson.events.map(event => event.userId),
    users.flatMap(user => RECOVERY_ORDER.map(() => user.id))
  );
  assert.equal(
    authenticatedJson.events.some(event => !event.userId || event.dataDir === authenticatedJson.dataDir),
    false
  );
}

{
  const failedAccounts = harness({
    name: "startup-auth-failure",
    authRequired: true,
    postgresRuntime: { auth: { provision() {} } },
    failAt: (step, context) => step === "usage" && context?.user?.id === "account-b"
  });
  const users = ["account-a", "account-b", "account-c"].map(id => ({ id, role: "user" }));
  await assert.rejects(
    failedAccounts.lifecycle.recoverAtStartup({ readUsers: async () => users }),
    /failed:usage:account-b/
  );
  assert.deepEqual(
    failedAccounts.events.map(event => `${event.userId}:${event.step}`),
    [
      ...RECOVERY_ORDER.map(step => `account-a:${step}`),
      "account-b:store",
      "account-b:settings",
      "account-b:usage"
    ]
  );
}

{
  const registration = harness({ name: "registration-write-failure", authRequired: true });
  const invitation = "registration-cleanup";
  const service = createAuthService({
    authRequired: true,
    inviteCodeHash: crypto.createHash("sha256").update(invitation).digest("hex"),
    initializeUserStorage: registration.lifecycle.initializeUserStorage,
    repository: {
      read: async () => ({ version: 1, users: [], sessions: [] }),
      update: async mutator => {
        const auth = { version: 1, users: [], sessions: [] };
        await mutator(auth);
        throw Object.assign(new Error("auth write failed"), { code: "WRITE_FAILED" });
      }
    }
  });
  await assert.rejects(
    service.register({
      username: "owner",
      password: "registration-password-1",
      invitation
    }),
    error => error.code === "WRITE_FAILED"
  );
  const usersDir = path.join(registration.dataDir, "users");
  assert.deepEqual(await fs.readdir(usersDir), []);
}

{
  const registration = harness({ name: "registration-post-commit-failure", authRequired: true });
  const invitation = "registration-post-commit";
  let persisted = { version: 1, users: [], sessions: [] };
  const service = createAuthService({
    authRequired: true,
    inviteCodeHash: crypto.createHash("sha256").update(invitation).digest("hex"),
    initializeUserStorage: registration.lifecycle.initializeUserStorage,
    repository: {
      read: async () => structuredClone(persisted),
      update: async mutator => {
        const auth = structuredClone(persisted);
        await mutator(auth);
        persisted = structuredClone(auth);
        throw Object.assign(new Error("post-commit audit failed"), { code: "AUDIT_FAILED" });
      }
    }
  });
  await assert.rejects(
    service.register({
      username: "owner",
      password: "registration-password-2",
      invitation
    }),
    error => error.code === "AUDIT_FAILED"
  );
  assert.equal(persisted.users.length, 1);
  await fs.access(registration.lifecycle.userDataDir(persisted.users[0]));
}

await fs.rm(root, { recursive: true, force: true });
console.log("Account lifecycle checks passed: private initialization, transactional provisioning, ordered fail-fast recovery, and startup traversal.");
