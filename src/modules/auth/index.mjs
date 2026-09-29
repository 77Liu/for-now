import crypto from "node:crypto";

export const SESSION_TTL_MS = 30 * 86400000;
export const publicUser = user => ({ id: user.id, username: user.username, createdAt: user.createdAt });
const now = () => new Date().toISOString();
const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const fail = (statusCode, message, code) => { throw Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) }); };
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

export function createAuthService({ repository, initializeUserStorage, authRequired, inviteCodeHash }) {
  const loginAttempts = new Map();
  const loginQueues = new Map();
  const withLoginLock = (key, operation) => {
    const previous = loginQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    loginQueues.set(key, current);
    return current.finally(() => {
      if (loginQueues.get(key) === current) loginQueues.delete(key);
    });
  };
  const update = mutator => repository.update(auth => {
    auth.sessions = auth.sessions.filter(session => new Date(session.expiresAt).getTime() > Date.now());
    return mutator(auth);
  });
  const issueSession = (auth, user) => {
    const token = crypto.randomBytes(32).toString("base64url");
    auth.sessions.push({ tokenHash: sha256(token), userId: user.id, createdAt: now(), expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
    return { user, token };
  };
  const accountMode = () => { if (!authRequired) fail(400, "本机模式无需账户管理"); };
  const requireUser = async token => {
    const user = await resolveUser(token);
    if (!user) fail(401, "请先登录", "AUTH_REQUIRED");
    return user;
  };
  async function resolveUser(token) {
    if (!authRequired) return { id: "local", username: "本机用户", createdAt: "" };
    if (!token) return null;
    const auth = await repository.read(), tokenHash = sha256(token);
    const session = auth.sessions.find(item => item.tokenHash === tokenHash && new Date(item.expiresAt).getTime() > Date.now());
    return session ? auth.users.find(user => user.id === session.userId) || null : null;
  }
  return {
    resolveUser,
    async me(token) {
      const user = await resolveUser(token), auth = authRequired ? await repository.read() : null;
      return { authenticated: Boolean(user), authRequired, registrationAvailable: !authRequired || Boolean(inviteCodeHash), user: user ? publicUser(user) : null, userCount: auth?.users.length || 0 };
    },
    async register(input) {
      if (!authRequired) fail(400, "本机模式无需注册");
      const username = usernameValue(input.username), password = String(input.password || "");
      validateUsername(username);
      validatePassword(password);
      const expected = Buffer.from(inviteCodeHash, "hex"), supplied = Buffer.from(sha256(String(input.invitation || "")), "hex");
      if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) fail(403, "内测码无效");
      const hashed = await passwordHash(password);
      return update(async auth => {
        if (auth.users.some(user => user.username.toLocaleLowerCase() === username.toLocaleLowerCase())) fail(409, "用户名已存在");
        const user = { id: crypto.randomUUID(), username, passwordHash: hashed, createdAt: now() };
        await initializeUserStorage(user, auth.users.length === 0);
        auth.users.push(user);
        return issueSession(auth, user);
      });
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
