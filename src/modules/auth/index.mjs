import crypto from "node:crypto";

export const AUTH_DOCUMENT_VERSION = 2;
export const SESSION_TTL_MS = 30 * 86400000;
export const AUTH_ROLES = Object.freeze(["user", "owner"]);
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
export const isOwner = user => roleOf(user) === "owner";
export const capabilitiesFor = user => isOwner(user) ? [...OWNER_CAPABILITIES] : [];
export const publicUser = user => ({ id: user.id, username: user.username, role: roleOf(user), createdAt: user.createdAt });
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
    sessionVersion: versionOf(user?.sessionVersion)
  }));
  const users = new Map(auth.users.map(user => [user.id, user]));
  auth.sessions = (Array.isArray(auth.sessions) ? auth.sessions : []).map(session => ({
    ...session,
    sessionVersion: versionOf(session?.sessionVersion ?? users.get(session?.userId)?.sessionVersion)
  }));
  return auth;
}

export function createAuthService({ repository, initializeUserStorage, authRequired, inviteCodeHash }) {
  const loginAttempts = new Map();
  const loginQueues = new Map();
  const replaceDocument = (target, value) => {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, value);
    return target;
  };
  const withLoginLock = (key, operation) => {
    const previous = loginQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    loginQueues.set(key, current);
    return current.finally(() => {
      if (loginQueues.get(key) === current) loginQueues.delete(key);
    });
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
    async login(input, remoteAddress) {
      if (!authRequired) fail(400, "本机模式无需登录");
      const username = usernameValue(input.username), password = String(input.password || ""), key = `${remoteAddress}:${username.toLocaleLowerCase()}`;
      return withLoginLock(key, async () => {
        const recent = (loginAttempts.get(key) || []).filter(value => Date.now() - value < 15 * 60000);
        loginAttempts.set(key, recent);
        if (recent.length >= 8) fail(429, "登录尝试过多，请 15 分钟后再试");
        const result = await update(async auth => {
          const user = auth.users.find(item => item.username.toLocaleLowerCase() === username.toLocaleLowerCase());
          if (!user || !await passwordMatches(password, user.passwordHash)) {
            recent.push(Date.now());
            await new Promise(resolve => setTimeout(resolve, 250));
            fail(401, "用户名或密码错误");
          }
          return issueSession(auth, user);
        });
        loginAttempts.delete(key);
        return result;
      });
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
    async changePassword(token, input) {
      accountMode();
      const requester = await requireUser(token), currentPassword = String(input.currentPassword || ""), newPassword = String(input.newPassword || "");
      validatePassword(newPassword);
      const tokenHash = sha256(token || "");
      return update(async auth => {
        const user = auth.users.find(item => item.id === requester.id);
        if (!user) fail(404, "账户不存在");
        if (!await passwordMatches(currentPassword, user.passwordHash)) fail(403, "当前密码不正确");
        user.passwordHash = await passwordHash(newPassword);
        user.updatedAt = now();
        auth.sessions = auth.sessions.filter(session => session.userId !== user.id || session.tokenHash === tokenHash);
        return user;
      });
    },
    async logout(token) {
      if (token && authRequired) await update(auth => { auth.sessions = auth.sessions.filter(item => item.tokenHash !== sha256(token)); });
    }
  };
}
