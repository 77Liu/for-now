import assert from "node:assert/strict";
import crypto from "node:crypto";
import { loadAuthAdmissionConfig } from "../src/config/index.mjs";
import { createAuthAdmission } from "../.build/typescript/backend/modules/auth/admission.mjs";
import {
  createAuthService,
  normalizeAuthDocument
} from "../src/modules/auth/index.mjs";
import { createDocumentAuthPort } from "../src/shared/persistence/index.mjs";

const passwordHash = password => {
  const salt = Buffer.alloc(16, 7);
  return `scrypt$${salt.toString("base64")}$${crypto.scryptSync(password, salt, 64).toString("base64")}`;
};
const tokenHash = token => crypto.createHash("sha256").update(token).digest("hex");
const clone = value => structuredClone(value);

function memoryRepository(initial) {
  let document = clone(initial);
  let queue = Promise.resolve();
  return {
    async read() {
      await Promise.resolve();
      return clone(document);
    },
    update(mutate) {
      const operation = queue.then(async () => {
        const draft = clone(document);
        const result = await mutate(draft);
        document = draft;
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
}

const baseAuth = () => ({
  version: 1,
  users: [{
    id: "owner",
    username: "owner",
    passwordHash: passwordHash("old-password-1"),
    createdAt: "2026-09-29T00:00:00.000Z"
  }],
  sessions: []
});
const serviceFor = repository => createAuthService({
  repository: createDocumentAuthPort({
    source: repository,
    normalizeDocument: normalizeAuthDocument
  }),
  initializeUserStorage: async () => {},
  authRequired: true,
  inviteCodeHash: crypto.createHash("sha256").update("invite").digest("hex")
});

{
  const service = serviceFor(memoryRepository(baseAuth()));
  const failures = await Promise.all(Array.from({ length: 9 }, async () => {
    try {
      await service.login({ username: "missing-user", password: "wrong-password-1" }, "127.0.0.1");
      return 200;
    } catch (error) {
      return error.statusCode;
    }
  }));
  assert.equal(failures.filter(status => status === 401).length, 8);
  assert.equal(failures.filter(status => status === 429).length, 1);
}

{
  const existingToken = "existing-session";
  const auth = baseAuth();
  auth.sessions.push({
    tokenHash: tokenHash(existingToken),
    userId: "owner",
    createdAt: "2026-09-29T00:00:00.000Z",
    expiresAt: "2099-09-29T00:00:00.000Z"
  });
  const service = serviceFor(memoryRepository(auth));
  const originalScrypt = crypto.scrypt;
  let releaseOldPasswordCheck;
  let oldPasswordCheckFinished;
  const oldPasswordCheck = new Promise(resolve => { oldPasswordCheckFinished = resolve; });
  let intercepted = false;
  crypto.scrypt = (password, salt, length, callback) => originalScrypt(password, salt, length, (error, derived) => {
    if (!intercepted && String(password) === "old-password-1") {
      intercepted = true;
      oldPasswordCheckFinished();
      releaseOldPasswordCheck = () => callback(error, derived);
      return;
    }
    callback(error, derived);
  });
  try {
    const login = service.login({ username: "owner", password: "old-password-1" }, "127.0.0.2");
    await oldPasswordCheck;
    const rejectedLogin = assert.rejects(login, error => error.code === "AUTH_INVALID_CREDENTIALS");
    const change = service.changePassword(existingToken, {
      currentPassword: "old-password-1",
      newPassword: "new-password-2"
    });
    await change;
    assert.equal(await service.resolveUser(existingToken), null, "password change revokes the current session");
    releaseOldPasswordCheck();
    await rejectedLogin;
    const { token } = await service.login({ username: "owner", password: "new-password-2" }, "127.0.0.3");
    assert.equal((await service.resolveUser(token)).id, "owner");
  } finally {
    crypto.scrypt = originalScrypt;
  }
}

// 写事务不得执行密码计算；其他账户也不等待失败延时。
{
  const initial = baseAuth();
  initial.users.push({ ...initial.users[0], id: "second", username: "second" });
  const repository = memoryRepository(initial);
  const originalUpdate = repository.update;
  let inWrite = false;
  repository.update = mutator => originalUpdate(async document => {
    inWrite = true;
    try { return await mutator(document); } finally { inWrite = false; }
  });
  const originalScrypt = crypto.scrypt;
  crypto.scrypt = (...args) => {
    assert.equal(inWrite, false, "KDF must not hold the authentication write lock");
    return originalScrypt(...args);
  };
  try {
    const service = serviceFor(repository);
    const wrong = service.login({ username: "owner", password: "wrong-password-1" }, "source-a")
      .then(() => "unexpected", error => { assert.equal(error.statusCode, 401); return "failure"; });
    const normal = service.login({ username: "second", password: "old-password-1" }, "source-b");
    assert.equal(await Promise.race([normal.then(() => "normal"), wrong]), "normal");
    await wrong;
  } finally { crypto.scrypt = originalScrypt; }
}

// 许可计数覆盖同 tick 取消、排队取消及运行中取消；归还必须等待实际计算结束。
{
  const config = { ...loadAuthAdmissionConfig({}), kdfConcurrency: 1, kdfMaxPending: 1, maxCounterKeys: 2 };
  const admission = createAuthAdmission(config);
  const controller = new AbortController();
  const running = admission.reserve("source", "account", controller.signal);
  const release = await admission.acquireKdf(running);
  controller.abort();
  assert.equal(admission.statistics().computing, 1);
  const queued = new AbortController();
  const attempt = { deadline: performance.now() + config.requestTimeoutMs, signal: queued.signal };
  const pending = admission.acquireKdf(attempt);
  assert.equal(admission.statistics().pending, 1);
  await assert.rejects(admission.acquireKdf({ deadline: attempt.deadline }), error => error.statusCode === 429);
  queued.abort();
  await assert.rejects(pending, error => error.code === "AUTH_REQUEST_TIMEOUT");
  assert.equal(admission.statistics().pending, 0);
  const cancelled = admission.acquireKdf({ deadline: attempt.deadline, signal: controller.signal });
  await assert.rejects(cancelled, error => error.code === "AUTH_REQUEST_TIMEOUT");
  assert.throws(() => admission.reserve("new-source", "new-account"), error => error.statusCode === 429);
  release(); release(); running.settle(); running.settle();
  assert.equal(admission.statistics().computing, 0);
  assert.equal(admission.statistics().counterKeys, 2);
}

// 排队预算耗尽是可重试429；总请求截止仍为503。
{
  const admission = createAuthAdmission({ ...loadAuthAdmissionConfig({}), kdfConcurrency: 1, kdfQueueTimeoutMs: 5 });
  const release = await admission.acquireKdf({ deadline: performance.now() + 1000 });
  await assert.rejects(admission.acquireKdf({ deadline: performance.now() + 1000 }), error =>
    error.statusCode === 429 && error.code === "AUTH_RATE_LIMITED" && error.retryAfterMs > 0);
  await assert.rejects(admission.acquireKdf({ deadline: performance.now() + 1 }), error => error.statusCode === 503);
  release();
}

// 持久化失败不改密码、不撤销会话；持久化成功则包括当前会话在内全部撤销。
{
  const auth = baseAuth();
  auth.sessions = ["one", "two", "three"].map(token => ({
    tokenHash: tokenHash(token), userId: "owner", expiresAt: "2099-09-29T00:00:00.000Z"
  }));
  const repository = memoryRepository(auth);
  const update = repository.update;
  repository.update = mutator => update(async draft => { await mutator(draft); throw new Error("commit failed"); });
  const service = serviceFor(repository);
  await assert.rejects(service.changePassword("one", {
    currentPassword: "old-password-1", newPassword: "new-password-2"
  }), /commit failed/);
  assert.equal((await service.resolveUser("two")).id, "owner");
  assert.equal((await repository.read()).users[0].passwordHash, auth.users[0].passwordHash);
  repository.update = update;
  await service.changePassword("one", { currentPassword: "old-password-1", newPassword: "new-password-2" });
  for (const token of ["one", "two", "three"]) assert.equal(await service.resolveUser(token), null);
}

console.log("Auth concurrency checks passed: bounded admission, cancellation cleanup, lock-free KDF and delay, credential snapshot conflict, atomic password changes and full-session revocation.");
