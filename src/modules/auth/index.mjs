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

/**
 * 提供认证与会话管理；密码计算及失败延时在写事务外，签发与撤销在原子提交后生效。
 */
export function createAuthService({ repository, initializeUserStorage, authRequired, inviteCodeHash, authAdmission = loadAuthAdmissionConfig({}) }) {
  const admission = createAuthAdmission(authAdmission);
  // 合法固定占位散列保证未知账户也执行一次相同算法；不对应任何可登录账户。
  const dummyHash = `scrypt$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(64).toString("base64")}`;
  const credentialSnapshot = user => user ? Object.freeze({
    id: user.id, username: user.username.toLocaleLowerCase(),
    passwordHash: user.passwordHash, sessionVersion: versionOf(user.sessionVersion)
  }) : null;
  const sameCredentials = (user, snapshot) => Boolean(user && snapshot
    && user.id === snapshot.id && user.username.toLocaleLowerCase() === snapshot.username
    && user.passwordHash === snapshot.passwordHash && versionOf(user.sessionVersion) === snapshot.sessionVersion);
  const invalidCredentials = () => fail(401, "用户名或密码错误", "AUTH_INVALID_CREDENTIALS");
  const replaceDocument = (target, value) => {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, value);
    return target;
  };
  const update = mutator => repository.update(auth => {
    replaceDocument(auth, normalizeAuthDocument(auth));
    auth.sessions = auth.sessions.filter(session => new Date(session.expiresAt).getTime() > Date.now());
    return mutator(auth);
  });
  const issueSession = (auth, user) => {
    const token = crypto.randomBytes(32).toString("base64url");
    auth.sessions.push({
      tokenHash: sha256(token),
      userId: user.id,
      sessionVersion: versionOf(user.sessionVersion),
      createdAt: now(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    });
    return { user, token };
  };
  const accountMode = () => { if (!authRequired) fail(400, "本机模式无需账户管理"); };
  const requireUser = async token => {
    const authentication = await authenticate(token);
    if (authentication.reauthRequired) reauth();
    if (!authentication.user) fail(401, "请先登录", "AUTH_REQUIRED");
    return authentication.user;
  };
  const authenticationFromDocument = (auth, tokenHash) => {
    const session = auth.sessions.find(item => item.tokenHash === tokenHash && new Date(item.expiresAt).getTime() > Date.now());
    if (!session) return { user: null, reauthRequired: false };
    const user = auth.users.find(item => item.id === session.userId) || null;
    if (!user) return { user: null, reauthRequired: false };
    if (versionOf(session.sessionVersion) !== versionOf(user.sessionVersion)) return { user: null, reauthRequired: true };
    return { user, reauthRequired: false };
  };
  async function authenticate(token) {
    if (!authRequired) return { user: { id: "local", username: "本机用户", role: "owner", createdAt: "" }, reauthRequired: false };
    if (!token) return { user: null, reauthRequired: false };
    return authenticationFromDocument(normalizeAuthDocument(await repository.read()), sha256(token));
  }
  async function resolveUser(token) {
    return (await authenticate(token)).user;
  }
  return {
    authenticate,
    resolveUser,
    migrate: () => update(auth => auth),
    async me(token) {
      const authentication = await authenticate(token);
      if (authentication.reauthRequired) reauth();
      const user = authentication.user, auth = authRequired ? normalizeAuthDocument(await repository.read()) : null;
      return {
        authenticated: Boolean(user),
        authRequired,
        registrationAvailable: !authRequired || Boolean(inviteCodeHash),
        user: user ? publicUser(user) : null,
        capabilities: capabilitiesFor(user),
        userCount: auth?.users.length || 0
      };
    },
    async register(input) {
      if (!authRequired) fail(400, "本机模式无需注册");
      const username = usernameValue(input.username), password = String(input.password || "");
      validateUsername(username);
      validatePassword(password);
      const expected = Buffer.from(inviteCodeHash, "hex"), supplied = Buffer.from(sha256(String(input.invitation || "")), "hex");
      if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) fail(403, "内测码无效");
      const hashed = await passwordHash(password);
      let rollbackStorage = null, initializedUserId = "";
      try {
        return await update(async auth => {
          if (auth.users.some(user => user.username.toLocaleLowerCase() === username.toLocaleLowerCase())) fail(409, "用户名已存在");
          const user = {
            id: crypto.randomUUID(),
            username,
            passwordHash: hashed,
            role: auth.users.length === 0 ? "owner" : "user",
            sessionVersion: 1,
            recordTimezone: DEFAULT_RECORD_TIMEZONE,
            createdAt: now()
          };
          rollbackStorage = await initializeUserStorage(user, auth.users.length === 0);
          initializedUserId = user.id;
          auth.users.push(user);
          return issueSession(auth, user);
        });
      } catch (error) {
        if (typeof rollbackStorage === "function" && initializedUserId) {
          let persisted = true;
          try {
            persisted = normalizeAuthDocument(await repository.read()).users
              .some(user => user.id === initializedUserId);
          } catch {}
          if (!persisted) await rollbackStorage().catch(() => {});
        }
        throw error;
      }
    },
    async login(input, remoteAddress, { signal } = {}) {
      if (!authRequired) fail(400, "本机模式无需登录");
      if (typeof input?.username !== "string" || typeof input?.password !== "string") fail(400, "请输入用户名和密码");
      const username = usernameValue(input.username), password = input.password;
      validateUsername(username);
      if (password.length > 128 || !password.length) fail(400, "请输入有效密码");
      const attempt = admission.reserve(remoteAddress, username.toLocaleLowerCase(), signal);
      try {
        const auth = normalizeAuthDocument(await repository.read());
        const snapshot = credentialSnapshot(auth.users.find(item => item.username.toLocaleLowerCase() === username.toLocaleLowerCase()));
        const release = await admission.acquireKdf(attempt);
        let matched;
        try {
          assertAuthRequestActive(attempt);
          matched = await passwordMatches(password, snapshot?.passwordHash || dummyHash);
        }
        finally { release(); }
        assertAuthRequestActive(attempt);
        if (!snapshot || !matched) {
          attempt.confirmFailure();
          await admission.delayFailure(attempt);
          invalidCredentials();
        }
        return await update(document => {
          assertAuthRequestActive(attempt);
          const current = document.users.find(user => user.id === snapshot.id);
          if (!sameCredentials(current, snapshot)) invalidCredentials();
          return issueSession(document, current);
        });
      } finally { attempt.settle(); }
    },
    async listUsers(token) {
      accountMode();
      const requester = await requireUser(token);
      if (!isOwner(requester)) ownerRequired();
      return normalizeAuthDocument(await repository.read()).users.map(publicUser);
    },
    async setRole(token, userId, role) {
      accountMode();
      if (!AUTH_ROLES.includes(role)) fail(400, "角色只能是 user 或 owner", "AUTH_ROLE_INVALID");
      const tokenHash = sha256(token || "");
      return update(auth => {
        const authentication = authenticationFromDocument(auth, tokenHash);
        if (authentication.reauthRequired) reauth();
        if (!authentication.user) fail(401, "请先登录", "AUTH_REQUIRED");
        if (!isOwner(authentication.user)) ownerRequired();
        const user = auth.users.find(item => item.id === userId);
        if (!user) fail(404, "账户不存在", "AUTH_USER_NOT_FOUND");
        if (user.role === role) return user;
        if (user.role === "owner" && role === "user" && auth.users.filter(isOwner).length <= 1) {
          fail(409, "至少需要保留一个 Owner", "LAST_OWNER_REQUIRED");
        }
        user.role = role;
        user.sessionVersion = versionOf(user.sessionVersion) + 1;
        user.updatedAt = now();
        return user;
      });
    },
    async rename(token, input) {
      accountMode();
      const requester = await requireUser(token), username = usernameValue(input.username);
      validateUsername(username);
      return update(auth => {
        const user = auth.users.find(item => item.id === requester.id);
        if (!user) fail(404, "账户不存在");
        if (auth.users.some(item => item.id !== user.id && item.username.toLocaleLowerCase() === username.toLocaleLowerCase())) fail(409, "用户名已存在");
        user.username = username;
        user.updatedAt = now();
        return user;
      });
    },
    async setRecordTimezone(token, input) {
      accountMode();
      const requester = await requireUser(token);
      const recordTimezone = requestedRecordTimezone(input?.timezone);
      return update(auth => {
        const user = auth.users.find(item => item.id === requester.id);
        if (!user) fail(404, "账户不存在", "AUTH_USER_NOT_FOUND");
        user.recordTimezone = recordTimezone;
        user.updatedAt = now();
        return user;
      });
    },
    async changePassword(token, input, { source, signal } = {}) {
      accountMode();
      const requester = await requireUser(token);
      const currentPassword = String(input.currentPassword || ""), newPassword = String(input.newPassword || "");
      validatePassword(newPassword);
      if (!currentPassword.length || currentPassword.length > 128) invalidCredentials();
      const snapshot = credentialSnapshot(requester);
      const attempt = admission.reserve(source, snapshot.username, signal);
      const tokenHash = sha256(token || "");
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
        return await update(auth => {
          assertAuthRequestActive(attempt);
          const authentication = authenticationFromDocument(auth, tokenHash);
          const user = authentication.user;
          if (!sameCredentials(user, snapshot)) invalidCredentials();
          user.passwordHash = hashed;
          user.sessionVersion = versionOf(user.sessionVersion) + 1;
          user.updatedAt = now();
          auth.sessions = auth.sessions.filter(session => session.userId !== user.id);
          return { authenticated: false, reauthRequired: true };
        });
      } finally { attempt.settle(); }
    },
    async logout(token) {
      if (token && authRequired) await update(auth => { auth.sessions = auth.sessions.filter(item => item.tokenHash !== sha256(token)); });
    }
  };
}
