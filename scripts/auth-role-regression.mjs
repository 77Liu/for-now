import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  AUTH_DOCUMENT_VERSION,
  DEFAULT_RECORD_TIMEZONE,
  capabilitiesFor,
  createAuthService,
  normalizeAuthDocument,
  publicUser
} from "../src/modules/auth/index.mjs";
import { createDocumentAuthPort } from "../src/shared/persistence/index.mjs";

const passwordHash = password => {
  const salt = Buffer.alloc(16, 11);
  return `scrypt$${salt.toString("base64")}$${crypto.scryptSync(password, salt, 64).toString("base64")}`;
};
const tokenHash = token => crypto.createHash("sha256").update(token).digest("hex");
const clone = value => structuredClone(value);

function memoryRepository(initial) {
  let document = clone(initial);
  return {
    async read() {
      return clone(document);
    },
    async update(mutator) {
      const draft = clone(document);
      const result = await mutator(draft);
      document = draft;
      return result;
    },
    snapshot() {
      return clone(document);
    }
  };
}

const legacyOwnerToken = "legacy-owner-session";
const legacyUserToken = "legacy-user-session";
const repository = memoryRepository({
  version: 1,
  extension: { retained: true },
  users: [
    {
      id: "main",
      username: "main",
      passwordHash: passwordHash("main-password-1"),
      createdAt: "2026-09-28T01:00:00.000Z",
      extension: ["keep"]
    },
    {
      id: "member",
      username: "member",
      passwordHash: passwordHash("member-password-2"),
      createdAt: "2026-09-29T01:00:00.000Z"
    }
  ],
  sessions: [
    {
      tokenHash: tokenHash(legacyOwnerToken),
      userId: "main",
      createdAt: "2026-09-30T01:00:00.000Z",
      expiresAt: "2099-09-30T01:00:00.000Z"
    },
    {
      tokenHash: tokenHash(legacyUserToken),
      userId: "member",
      createdAt: "2026-09-30T01:00:00.000Z",
      expiresAt: "2099-09-30T01:00:00.000Z"
    }
  ]
});
const service = createAuthService({
  repository: createDocumentAuthPort({
    source: repository,
    normalizeDocument: normalizeAuthDocument
  }),
  initializeUserStorage: async () => {},
  authRequired: true,
  inviteCodeHash: crypto.createHash("sha256").update("invite").digest("hex")
});

const normalized = normalizeAuthDocument(await repository.read());
assert.equal(normalized.version, AUTH_DOCUMENT_VERSION);
assert.deepEqual(normalized.users.map(user => user.role), ["owner", "user"]);
assert.deepEqual(normalized.users.map(user => user.sessionVersion), [1, 1]);
assert.deepEqual(normalized.sessions.map(session => session.sessionVersion), [1, 1]);
assert.deepEqual(normalized.extension, { retained: true });
assert.deepEqual(normalized.users[0].extension, ["keep"]);
assert.deepEqual(publicUser(normalized.users[0]), {
  id: "main",
  username: "main",
  role: "owner",
  createdAt: "2026-09-28T01:00:00.000Z",
  recordTimezone: DEFAULT_RECORD_TIMEZONE
});
assert.deepEqual(capabilitiesFor(normalized.users[1]), []);
assert.ok(capabilitiesFor(normalized.users[0]).includes("account-roles"));

await service.migrate();
const migrated = repository.snapshot();
assert.equal(migrated.version, AUTH_DOCUMENT_VERSION);
assert.equal((await service.authenticate(legacyOwnerToken)).user.role, "owner");
assert.equal((await service.authenticate(legacyUserToken)).user.role, "user");

await assert.rejects(
  service.listUsers(legacyUserToken),
  error => error.statusCode === 403 && error.code === "OWNER_REQUIRED"
);
await assert.rejects(
  service.setRole(legacyOwnerToken, "main", "user"),
  error => error.statusCode === 409 && error.code === "LAST_OWNER_REQUIRED"
);

const promoted = await service.setRole(legacyOwnerToken, "member", "owner");
assert.equal(promoted.role, "owner");
assert.deepEqual(await service.authenticate(legacyUserToken), { user: null, reauthRequired: true });
await assert.rejects(
  service.me(legacyUserToken),
  error => error.statusCode === 401 && error.code === "AUTH_REAUTH_REQUIRED"
);

const memberLogin = await service.login({
  username: "member",
  password: "member-password-2"
}, "127.0.0.2");
assert.equal(memberLogin.user.role, "owner");
await service.setRole(legacyOwnerToken, "member", "user");
assert.deepEqual(await service.authenticate(memberLogin.token), { user: null, reauthRequired: true });
assert.equal((await service.authenticate(legacyOwnerToken)).user.role, "owner");

const emptyRepository = memoryRepository({ version: 1, users: [], sessions: [] });
const emptyService = createAuthService({
  repository: createDocumentAuthPort({
    source: emptyRepository,
    normalizeDocument: normalizeAuthDocument
  }),
  initializeUserStorage: async () => {},
  authRequired: true,
  inviteCodeHash: crypto.createHash("sha256").update("invite").digest("hex")
});
const first = await emptyService.register({
  username: "first",
  password: "first-password-1",
  invitation: "invite"
});
const second = await emptyService.register({
  username: "second",
  password: "second-password-2",
  invitation: "invite"
});
assert.equal(first.user.role, "owner");
assert.equal(second.user.role, "user");

console.log("Auth role checks passed: legacy owner migration, user defaults, capability projection, role audit mutations and stale-session reauthentication.");
