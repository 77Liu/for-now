import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createAuthService } from "../src/modules/auth/index.mjs";

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
  repository,
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
    let passwordChanged = false;
    const change = service.changePassword(existingToken, {
      currentPassword: "old-password-1",
      newPassword: "new-password-2"
    }).then(value => {
      passwordChanged = true;
      return value;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(passwordChanged, false, "password change must serialize with password verification and session issuance");
    releaseOldPasswordCheck();
    const [{ token }] = await Promise.all([login, change]);
    assert.equal(await service.resolveUser(token), null, "password change must revoke the concurrently issued session");
  } finally {
    crypto.scrypt = originalScrypt;
  }
}

console.log("Auth concurrency checks passed: failed-login limit is atomic and password changes cannot race old-password session issuance.");
