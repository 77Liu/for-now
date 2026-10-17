/**
 * 账户凭据、会话签发与账户权限管理。
 * 建立时间：未知
 * 状态：active
 * 边界：密码计算不占持久化写锁；凭据快照必须在提交时复验；改密撤销全部旧会话。
 */
import crypto from "node:crypto";
import { createAuthAdmission, assertAuthRequestActive } from "../../../.build/typescript/backend/modules/auth/admission.mjs";
import { loadAuthAdmissionConfig } from "../../config/index.mjs";
import { DEFAULT_RECORD_TIMEZONE } from "../../shared/time/index.mjs";

export const AUTH_DOCUMENT_VERSION = 3;
export const SESSION_TTL_MS = 30 * 86400000;
/** Owner 账户列表默认页大小。 @since unreleased */
export const AUTH_USER_PAGE_DEFAULT = 50;
/** Owner 账户列表单页硬上限。 @since unreleased */
export const AUTH_USER_PAGE_MAX = 100;
export const AUTH_ROLES = Object.freeze(["user", "owner"]);
export { DEFAULT_RECORD_TIMEZONE };
export const OWNER_CAPABILITIES = Object.freeze([
  "ai-costs",
  "architecture",
  "commercialization",
  "local-testing",
  "ai-configuration",
  "account-roles"
]);
const roleOf = user => AUTH_ROLES.includes(user?.role) ? user.role : "user";
const versionOf = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 1;
const normalizeRecordTimezone = value => {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_RECORD_TIMEZONE;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    return DEFAULT_RECORD_TIMEZONE;
  }
};
const requestedRecordTimezone = value => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) {
    fail(400, "记录时区必须是有效的 IANA 时区", "AUTH_TIMEZONE_INVALID");
  }
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    fail(400, "记录时区必须是有效的 IANA 时区", "AUTH_TIMEZONE_INVALID");
  }
};
export const isOwner = user => roleOf(user) === "owner";
export const capabilitiesFor = user => isOwner(user) ? [...OWNER_CAPABILITIES] : [];
export const publicUser = user => ({
  id: user.id,
  username: user.username,
  role: roleOf(user),
  createdAt: user.createdAt,
  recordTimezone: normalizeRecordTimezone(user?.recordTimezone)
});
const now = () => new Date().toISOString();
const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const fail = (statusCode, message, code) => { throw Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) }); };
const reauth = () => fail(401, "账户权限已变更，请重新登录", "AUTH_REAUTH_REQUIRED");
const ownerRequired = () => fail(403, "当前账户没有 Owner 权限", "OWNER_REQUIRED");
const usernameValue = value => String(value ?? "").trim().slice(0, 32);
/** 生成用户名唯一键，供文档与 PostgreSQL 适配器共同使用。 @since unreleased */
export const normalizeUsernameKey = value => String(value || "")
  .toLocaleLowerCase();
const validateUsername = username => {
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) fail(400, "用户名需为 3–32 位文字、数字、点、横线或下划线");
};
const validatePassword = password => {
  if (!(password.length >= 8 && password.length <= 128 && /[A-Za-z]/.test(password) && /\d/.test(password))) fail(400, "密码需为 8–128 位，且同时包含字母和数字");
};
const passwordHash = password => new Promise((resolve, reject) => {
  const salt = crypto.randomBytes(16);
  crypto.scrypt(password, salt, 64, (error, derived) => error ? reject(error) : resolve(`scrypt$${salt.toString("base64")}$${derived.toString("base64")}`));
});
const passwordMatches = (password, encoded) => new Promise(resolve => {
  const [, saltText, hashText] = String(encoded || "").split("$");
  if (!saltText || !hashText) return resolve(false);
  const expected = Buffer.from(hashText, "base64");
  crypto.scrypt(password, Buffer.from(saltText, "base64"), expected.length, (error, derived) => {
    resolve(!error && expected.length === derived.length && crypto.timingSafeEqual(expected, derived));
  });
});

export function normalizeAuthDocument(value = {}) {
  const auth = value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
  auth.version = AUTH_DOCUMENT_VERSION;
  auth.users = (Array.isArray(auth.users) ? auth.users : []).map((user, index) => ({
    ...user,
    usernameKey: normalizeUsernameKey(user?.username),
    role: AUTH_ROLES.includes(user?.role) ? user.role : index === 0 ? "owner" : "user",
    sessionVersion: versionOf(user?.sessionVersion),
    recordTimezone: normalizeRecordTimezone(user?.recordTimezone)
  }));
  const users = new Map(auth.users.map(user => [user.id, user]));
  auth.sessions = (Array.isArray(auth.sessions) ? auth.sessions : []).map(session => ({
    ...session,
    sessionVersion: versionOf(session?.sessionVersion ?? users.get(session?.userId)?.sessionVersion)
  }));
  return auth;
}

const invalidCredentials = () => fail(
  401,
  "用户名或密码错误",
  "AUTH_INVALID_CREDENTIALS"
);
const credentialSnapshot = user => user ? Object.freeze({
  id: user.id,
  usernameKey: normalizeUsernameKey(user.username),
  passwordHash: user.passwordHash,
  sessionVersion: versionOf(user.sessionVersion)
}) : null;
const createSession = user => {
  const token = crypto.randomBytes(32).toString("base64url");
  return {
    token,
    session: {
      tokenHash: sha256(token),
      userId: user.id,
      sessionVersion: versionOf(user.sessionVersion),
      createdAt: now(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    }
  };
};
const authenticationFromPair = pair => {
  if (!pair || Date.parse(pair.session?.expiresAt || "") <= Date.now()) {
    return { user: null, reauthRequired: false };
  }
  if (versionOf(pair.session.sessionVersion) !== versionOf(pair.user?.sessionVersion)) {
    return { user: null, reauthRequired: true };
  }
  return { user: pair.user, reauthRequired: false };
};
const encodeUserCursor = boundary => boundary
  ? Buffer.from(JSON.stringify({ version: 1, ...boundary })).toString("base64url")
  : null;
const decodeUserCursor = cursor => {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (value?.version !== 1
      || typeof value.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.id !== "string"
      || !value.id) throw new Error("invalid");
    return { createdAt: new Date(value.createdAt).toISOString(), id: value.id };
  } catch {
    fail(400, "账户分页游标无效", "AUTH_CURSOR_INVALID");
  }
};
const pageLimit = value => {
  if (value === undefined || value === null || value === "") {
    return AUTH_USER_PAGE_DEFAULT;
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AUTH_USER_PAGE_MAX) {
    fail(400, `账户页大小必须是 1–${AUTH_USER_PAGE_MAX}`, "AUTH_LIMIT_INVALID");
  }
  return limit;
};

function createSessionAccess({ repository, authRequired }) {
  async function authenticate(token) {
    if (!authRequired) {
      return {
        user: { id: "local", username: "本机用户", role: "owner", createdAt: "" },
        reauthRequired: false
      };
    }
    if (!token) return { user: null, reauthRequired: false };
    return authenticationFromPair(
      await repository.findAuthenticationByTokenHash(sha256(token))
    );
  }
  const requireUser = async token => {
    const authentication = await authenticate(token);
    if (authentication.reauthRequired) reauth();
    if (!authentication.user) fail(401, "请先登录", "AUTH_REQUIRED");
    return authentication.user;
  };
  return {
    authenticate,
    requireUser,
    resolveUser: async token => (await authenticate(token)).user
  };
}

function createRegistration({ repository, initializeUserStorage, authRequired, inviteCodeHash }) {
  return async input => {
    if (!authRequired) fail(400, "本机模式无需注册");
    const username = usernameValue(input.username);
    const password = String(input.password || "");
    validateUsername(username);
    validatePassword(password);
    const expected = Buffer.from(inviteCodeHash, "hex");
    const supplied = Buffer.from(sha256(String(input.invitation || "")), "hex");
    if (expected.length !== supplied.length
      || !crypto.timingSafeEqual(expected, supplied)) fail(403, "内测码无效");
    const user = {
      id: crypto.randomUUID(),
      username,
      usernameKey: normalizeUsernameKey(username),
      passwordHash: await passwordHash(password),
      role: "user",
      sessionVersion: 1,
      recordTimezone: DEFAULT_RECORD_TIMEZONE,
      createdAt: now()
    };
    const { token, session } = createSession(user);
    let rollbackStorage = null;
    try {
      const result = await repository.register({
        user,
        session,
        initialize: async (persistedUser, first) => {
          rollbackStorage = await initializeUserStorage(persistedUser, first);
          return rollbackStorage;
        }
      });
      return { user: result.user, token };
    } catch (error) {
      if (typeof rollbackStorage === "function") {
        let persisted = true;
        try { persisted = Boolean(await repository.findUserById(user.id)); } catch {}
        if (!persisted) await rollbackStorage().catch(() => {});
      }
      throw error;
    }
  };
}

function createLogin({ repository, admission, authRequired, dummyHash }) {
  return async (input, remoteAddress, { signal } = {}) => {
    if (!authRequired) fail(400, "本机模式无需登录");
    if (typeof input?.username !== "string" || typeof input?.password !== "string") {
      fail(400, "请输入用户名和密码");
    }
    const username = usernameValue(input.username);
    const password = input.password;
    validateUsername(username);
    if (password.length > 128 || !password.length) fail(400, "请输入有效密码");
    const key = normalizeUsernameKey(username);
    const attempt = admission.reserve(remoteAddress, key, signal);
    try {
      const snapshot = credentialSnapshot(
        await repository.findCredentialByUsernameKey(key)
      );
      const release = await admission.acquireKdf(attempt);
      let matched;
      try {
        assertAuthRequestActive(attempt);
        matched = await passwordMatches(password, snapshot?.passwordHash || dummyHash);
      } finally { release(); }
      assertAuthRequestActive(attempt);
      if (!snapshot || !matched) {
        attempt.confirmFailure();
        await admission.delayFailure(attempt);
        invalidCredentials();
      }
      const seed = { id: snapshot.id, sessionVersion: snapshot.sessionVersion };
      const { token, session } = createSession(seed);
      const result = await repository.issueSessionIfCredentialCurrent({
        snapshot, session
      });
      assertAuthRequestActive(attempt);
      if (!result) invalidCredentials();
      return { user: result.user, token };
    } finally { attempt.settle(); }
  };
}

function createAccountManagement({ repository, authRequired }) {
  const accountMode = () => {
    if (!authRequired) fail(400, "本机模式无需账户管理");
  };
  return {
    async listUsers(token, query = {}) {
      accountMode();
      const page = await repository.listUsersPage({
        tokenHash: sha256(token || ""),
        limit: pageLimit(query.limit),
        after: decodeUserCursor(query.cursor),
        nowMs: Date.now()
      });
      return {
        users: page.users.map(publicUser),
        nextCursor: encodeUserCursor(page.next)
      };
    },
    async setRole(token, userId, role) {
      accountMode();
      if (!AUTH_ROLES.includes(role)) {
        fail(400, "角色只能是 user 或 owner", "AUTH_ROLE_INVALID");
      }
      return repository.setRole({
        tokenHash: sha256(token || ""),
        userId,
        role,
        updatedAt: now(),
        nowMs: Date.now()
      });
    },
    async rename(token, input) {
      accountMode();
      const username = usernameValue(input.username);
      validateUsername(username);
      return repository.rename({
        tokenHash: sha256(token || ""),
        username,
        usernameKey: normalizeUsernameKey(username),
        updatedAt: now(),
        nowMs: Date.now()
      });
    },
    async setRecordTimezone(token, input) {
      accountMode();
      return repository.setRecordTimezone({
        tokenHash: sha256(token || ""),
        recordTimezone: requestedRecordTimezone(input?.timezone),
        updatedAt: now(),
        nowMs: Date.now()
      });
    }
  };
}

function createPasswordChange({ repository, admission, requireUser, authRequired }) {
  return async (token, input, { source, signal } = {}) => {
    if (!authRequired) fail(400, "本机模式无需账户管理");
    const requester = await requireUser(token);
    const currentPassword = String(input.currentPassword || "");
    const newPassword = String(input.newPassword || "");
    validatePassword(newPassword);
    if (!currentPassword.length || currentPassword.length > 128) invalidCredentials();
    const snapshot = credentialSnapshot(
      await repository.findCredentialByUserId(requester.id)
    );
    if (!snapshot) invalidCredentials();
    const attempt = admission.reserve(source, snapshot.usernameKey, signal);
    try {
      const release = await admission.acquireKdf(attempt);
      let matched, hashed;
      try {
        assertAuthRequestActive(attempt);
        matched = await passwordMatches(currentPassword, snapshot.passwordHash);
        assertAuthRequestActive(attempt);
        if (matched) hashed = await passwordHash(newPassword);
      } finally { release(); }
      assertAuthRequestActive(attempt);
      if (!matched) {
        attempt.confirmFailure();
        await admission.delayFailure(attempt);
        invalidCredentials();
      }
      const result = await repository.changePasswordAndRevokeSessions({
        tokenHash: sha256(token || ""),
        snapshot,
        passwordHash: hashed,
        updatedAt: now(),
        nowMs: Date.now()
      });
      assertAuthRequestActive(attempt);
      if (!result) invalidCredentials();
      return { authenticated: false, reauthRequired: true };
    } finally { attempt.settle(); }
  };
}

/**
 * Provides credential, session, and account management over an explicit identity port.
 * @since unreleased
 */
export function createAuthService({
  repository,
  initializeUserStorage,
  authRequired,
  inviteCodeHash,
  authAdmission = loadAuthAdmissionConfig({})
}) {
  const requiredMethods = [
    "findCredentialByUsernameKey", "findCredentialByUserId",
    "findAuthenticationByTokenHash", "findUserById",
    "findFirstOwner", "countUsers", "scanUsersPage", "listUsersPage", "register",
    "issueSessionIfCredentialCurrent", "setRole", "rename", "setRecordTimezone",
    "changePasswordAndRevokeSessions", "deleteSession", "migrate", "verify"
  ];
  for (const method of requiredMethods) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`Authentication identity port requires ${method}`);
    }
  }
  const admission = createAuthAdmission(authAdmission);
  const dummyHash = `scrypt$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(64).toString("base64")}`;
  const access = createSessionAccess({ repository, authRequired });
  const management = createAccountManagement({ repository, authRequired });
  return {
    ...access,
    ...management,
    migrate: () => repository.migrate(),
    verify: () => repository.verify(),
    findUserById: id => repository.findUserById(id),
    findFirstOwner: () => repository.findFirstOwner(),
    scanUsersPage: query => repository.scanUsersPage(query),
    async me(token) {
      const authentication = await access.authenticate(token);
      if (authentication.reauthRequired) reauth();
      const user = authentication.user;
      return {
        authenticated: Boolean(user),
        authRequired,
        registrationAvailable: !authRequired || Boolean(inviteCodeHash),
        user: user ? publicUser(user) : null,
        capabilities: capabilitiesFor(user),
        userCount: authRequired ? await repository.countUsers() : 0
      };
    },
    register: createRegistration({
      repository, initializeUserStorage, authRequired, inviteCodeHash
    }),
    login: createLogin({ repository, admission, authRequired, dummyHash }),
    changePassword: createPasswordChange({
      repository, admission, requireUser: access.requireUser, authRequired
    }),
    async logout(token) {
      if (token && authRequired) await repository.deleteSession(sha256(token));
    }
  };
}
