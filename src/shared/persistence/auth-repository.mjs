/**
 * 将 JSON 文档或 PostgreSQL 行适配为账户身份端口。
 * 建立时间：未知
 * 状态：active
 * 边界：row 模式查询或命令失败后绝不回退完整文档。
 */

const versionOf = value => Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? Number(value) : 1;
const usernameKeyOf = value => String(value || "").toLocaleLowerCase();
const currentAuthentication = (pair, nowMs) => {
  if (!pair || Date.parse(pair.session?.expiresAt || "") <= nowMs) return {
    user: null, reauthRequired: false
  };
  if (versionOf(pair.session.sessionVersion) !== versionOf(pair.user?.sessionVersion)) {
    return { user: null, reauthRequired: true };
  }
  return { user: pair.user, reauthRequired: false };
};
const requireAuthentication = (pair, nowMs) => {
  const authentication = currentAuthentication(pair, nowMs);
  if (authentication.reauthRequired) {
    throw Object.assign(new Error("账户权限已变更，请重新登录"), {
      statusCode: 401, code: "AUTH_REAUTH_REQUIRED"
    });
  }
  if (!authentication.user) {
    throw Object.assign(new Error("请先登录"), {
      statusCode: 401, code: "AUTH_REQUIRED"
    });
  }
  return authentication.user;
};
const sameCredentials = (user, snapshot) => Boolean(user && snapshot
  && user.id === snapshot.id
  && usernameKeyOf(user.username) === snapshot.usernameKey
  && user.passwordHash === snapshot.passwordHash
  && versionOf(user.sessionVersion) === snapshot.sessionVersion);
const sortedUsers = users => [...users].sort((left, right) => (
  String(left.createdAt || "").localeCompare(String(right.createdAt || ""))
  || String(left.id || "").localeCompare(String(right.id || ""))
));
const afterBoundary = (user, after) => !after
  || String(user.createdAt || "").localeCompare(after.createdAt) > 0
  || (
    String(user.createdAt || "") === after.createdAt
    && String(user.id || "").localeCompare(after.id) > 0
  );

function authenticationFromDocument(auth, tokenHash) {
  const session = auth.sessions.find(item => item.tokenHash === tokenHash) || null;
  const user = session
    ? auth.users.find(item => item.id === session.userId) || null
    : null;
  return session && user ? { session, user } : null;
}

function change(type, values = {}) {
  return Object.freeze({ type, ...values });
}

function documentAccess(source, normalizeDocument, onCommitted) {
  const read = async () => normalizeDocument(await source.read());
  const transact = async mutator => {
    const outcome = await source.update(async raw => {
      const auth = normalizeDocument(raw);
      auth.sessions = auth.sessions.filter(
        session => Date.parse(session.expiresAt) > Date.now()
      );
      const result = await mutator(auth);
      for (const key of Object.keys(raw)) delete raw[key];
      Object.assign(raw, auth);
      return result;
    });
    if (outcome?.change) await onCommitted(outcome.change);
    return outcome?.value;
  };
  return { read, transact };
}

function documentQueries(read) {
  const findAuthenticationByTokenHash = async tokenHash => (
    authenticationFromDocument(await read(), tokenHash)
  );
  const scanUsersPage = async ({ limit, after = null }) => {
    const auth = await read();
    const selected = sortedUsers(auth.users.map(user => ({
      ...user,
      lastSessionAt: auth.sessions
        .filter(session => session.userId === user.id)
        .map(session => session.createdAt)
        .sort()
        .at(-1)
    })))
      .filter(user => afterBoundary(user, after))
      .slice(0, limit + 1);
    const users = selected.slice(0, limit);
    const tail = selected.length > limit ? users.at(-1) : null;
    return {
      users,
      next: tail ? { createdAt: String(tail.createdAt || ""), id: tail.id } : null
    };
  };
  return {
    findCredentialByUsernameKey: async key => (
      (await read()).users.find(user => usernameKeyOf(user.username) === key) || null
    ),
    findCredentialByUserId: async id => (
      (await read()).users.find(user => user.id === id) || null
    ),
    findAuthenticationByTokenHash,
    findUserById: async id => (await read()).users.find(user => user.id === id) || null,
    findFirstOwner: async () => sortedUsers((await read()).users)
      .find(user => user.role === "owner") || null,
    countUsers: async () => (await read()).users.length,
    scanUsersPage
  };
}

const documentListUsers = queries => async ({
  tokenHash, limit, after = null, nowMs
}) => {
  const user = requireAuthentication(
    await queries.findAuthenticationByTokenHash(tokenHash),
    nowMs
  );
  if (user.role !== "owner") {
    throw Object.assign(new Error("当前账户没有 Owner 权限"), {
      statusCode: 403, code: "OWNER_REQUIRED"
    });
  }
  return queries.scanUsersPage({ limit, after });
};

const documentRegister = transact => command => transact(async auth => {
  if (auth.users.some(user => (
    usernameKeyOf(user.username) === command.user.usernameKey
  ))) {
    throw Object.assign(new Error("用户名已存在"), { statusCode: 409 });
  }
  const first = auth.users.length === 0;
  const user = { ...command.user, role: first ? "owner" : "user" };
  const session = {
    ...command.session,
    userId: user.id,
    sessionVersion: user.sessionVersion
  };
  const rollbackStorage = await command.initialize(user, first);
  auth.users.push(user);
  auth.sessions.push(session);
  return {
    value: { user, session, rollbackStorage },
    change: change("registered", { user, session })
  };
});

const documentIssueSession = transact => command => transact(auth => {
  const user = auth.users.find(item => item.id === command.snapshot.id);
  if (!sameCredentials(user, command.snapshot)) {
    return { value: null, change: null };
  }
  auth.sessions.push(command.session);
  return {
    value: { user, session: command.session },
    change: change("session-issued", { user, session: command.session })
  };
});

const documentSetRole = transact => command => transact(auth => {
  const requester = requireAuthentication(
    authenticationFromDocument(auth, command.tokenHash),
    command.nowMs
  );
  if (requester.role !== "owner") {
    throw Object.assign(new Error("当前账户没有 Owner 权限"), {
      statusCode: 403, code: "OWNER_REQUIRED"
    });
  }
  const user = auth.users.find(item => item.id === command.userId);
  if (!user) {
    throw Object.assign(new Error("账户不存在"), {
      statusCode: 404, code: "AUTH_USER_NOT_FOUND"
    });
  }
  const before = structuredClone(user);
  if (user.role !== command.role) {
    if (user.role === "owner" && command.role === "user"
      && auth.users.filter(item => item.role === "owner").length <= 1) {
      throw Object.assign(new Error("至少需要保留一个 Owner"), {
        statusCode: 409, code: "LAST_OWNER_REQUIRED"
      });
    }
    user.role = command.role;
    user.sessionVersion = versionOf(user.sessionVersion) + 1;
    user.updatedAt = command.updatedAt;
  }
  return {
    value: user,
    change: user.role === before.role ? null : change("user-updated", {
      beforeUser: before,
      afterUser: structuredClone(user),
      revokedUserIds: [user.id]
    })
  };
});

const documentRename = transact => command => transact(auth => {
  const user = requireAuthentication(
    authenticationFromDocument(auth, command.tokenHash),
    command.nowMs
  );
  if (auth.users.some(item => (
    item.id !== user.id && usernameKeyOf(item.username) === command.usernameKey
  ))) {
    throw Object.assign(new Error("用户名已存在"), { statusCode: 409 });
  }
  const before = structuredClone(user);
  user.username = command.username;
  user.updatedAt = command.updatedAt;
  return {
    value: user,
    change: change("user-updated", {
      beforeUser: before, afterUser: structuredClone(user)
    })
  };
});

const documentSetRecordTimezone = transact => command => transact(auth => {
  const user = requireAuthentication(
    authenticationFromDocument(auth, command.tokenHash),
    command.nowMs
  );
  const before = structuredClone(user);
  user.recordTimezone = command.recordTimezone;
  user.updatedAt = command.updatedAt;
  return {
    value: user,
    change: change("user-updated", {
      beforeUser: before, afterUser: structuredClone(user)
    })
  };
});

const documentChangePassword = transact => command => transact(auth => {
  const pair = authenticationFromDocument(auth, command.tokenHash);
  if (!pair || Date.parse(pair.session.expiresAt) <= command.nowMs
    || !sameCredentials(pair.user, command.snapshot)) {
    return { value: null, change: null };
  }
  const before = structuredClone(pair.user);
  pair.user.passwordHash = command.passwordHash;
  pair.user.sessionVersion = versionOf(pair.user.sessionVersion) + 1;
  pair.user.updatedAt = command.updatedAt;
  auth.sessions = auth.sessions.filter(
    session => session.userId !== pair.user.id
  );
  return {
    value: { before, after: pair.user },
    change: change("credentials-changed", {
      beforeUser: before,
      afterUser: structuredClone(pair.user),
      revokedUserIds: [pair.user.id]
    })
  };
});

const documentDeleteSession = transact => tokenHash => transact(auth => {
  const session = auth.sessions.find(item => item.tokenHash === tokenHash);
  auth.sessions = auth.sessions.filter(item => item.tokenHash !== tokenHash);
  return {
    value: session?.userId || null,
    change: session
      ? change("session-deleted", {
          userId: session.userId, tokenHash: session.tokenHash
        })
      : null
  };
});

/**
 * Wraps a serialized authentication document in the explicit identity port.
 * @since unreleased
 */
export function createDocumentAuthPort({
  source,
  normalizeDocument,
  onCommitted = async () => {}
}) {
  const { read, transact } = documentAccess(
    source,
    normalizeDocument,
    onCommitted
  );
  const queries = documentQueries(read);
  return {
    mode: "document",
    readDocument: source.read,
    ...queries,
    listUsersPage: documentListUsers(queries),
    register: documentRegister(transact),
    issueSessionIfCredentialCurrent: documentIssueSession(transact),
    setRole: documentSetRole(transact),
    rename: documentRename(transact),
    setRecordTimezone: documentSetRecordTimezone(transact),
    changePasswordAndRevokeSessions: documentChangePassword(transact),
    deleteSession: documentDeleteSession(transact),
    migrate: () => transact(auth => ({ value: auth, change: null })),
    verify: async () => ({ valid: Boolean(await read()) })
  };
}

function rowPort(runtime, onCommitted) {
  const committed = async (result, nextChange) => {
    if (nextChange) await onCommitted(nextChange);
    return result;
  };
  return {
    mode: "row",
    readDocument: runtime.auth.read,
    ...Object.fromEntries([
      "findCredentialByUsernameKey", "findAuthenticationByTokenHash",
      "findCredentialByUserId", "findUserById", "findFirstOwner",
      "countUsers", "scanUsersPage",
      "listUsersPage", "verify"
    ].map(name => [name, runtime.auth.row[name]])),
    register: async command => {
      const result = await runtime.auth.row.register(command);
      return committed(result, change("registered", {
        user: result.user, session: result.session
      }));
    },
    issueSessionIfCredentialCurrent: async command => {
      const result = await runtime.auth.row.issueSessionIfCredentialCurrent(command);
      return committed(result, result && change("session-issued", result));
    },
    setRole: async command => {
      const result = await runtime.auth.row.setRole(command);
      await committed(null, result.before.role === result.after.role
        ? null
        : change("user-updated", {
            beforeUser: result.before, afterUser: result.after,
            revokedUserIds: [result.after.id]
          }));
      return result.after;
    },
    rename: async command => {
      const result = await runtime.auth.row.rename(command);
      await committed(null, change("user-updated", {
        beforeUser: result.before, afterUser: result.after
      }));
      return result.after;
    },
    setRecordTimezone: async command => {
      const result = await runtime.auth.row.setRecordTimezone(command);
      await committed(null, change("user-updated", {
        beforeUser: result.before, afterUser: result.after
      }));
      return result.after;
    },
    changePasswordAndRevokeSessions: async command => {
      const result = await runtime.auth.row.changePasswordAndRevokeSessions(command);
      return committed(result, result && change("credentials-changed", {
        beforeUser: result.before, afterUser: result.after,
        revokedUserIds: [result.after.id]
      }));
    },
    deleteSession: async tokenHash => {
      const userId = await runtime.auth.row.deleteSession(tokenHash);
      return committed(userId, userId && change("session-deleted", { userId, tokenHash }));
    },
    migrate: () => runtime.auth.row.verify()
  };
}

function jsonSource({
  file,
  readDocument,
  writeDocument,
  onInvalid,
  canInitialize
}) {
  let queue = Promise.resolve();
  let observedDocument = false;
  const read = async () => {
    const value = await readDocument(file, null);
    if (value !== null) {
      observedDocument = true;
      if (Array.isArray(value.users) && Array.isArray(value.sessions)) return value;
      const error = Object.assign(
        new Error("认证数据无法读取，已保留原文件，请联系管理员"),
        { code: "STORAGE_READ_FAILED", statusCode: 503 }
      );
      await onInvalid(error);
      throw error;
    }
    let bootstrap = false;
    try { bootstrap = !observedDocument && await canInitialize(); }
    catch (error) { await onInvalid(error); throw error; }
    if (bootstrap) return { version: 1, users: [], sessions: [] };
    const error = Object.assign(
      new Error("认证数据缺失，已保留账户数据，禁止重新初始化"),
      { code: "AUTH_STORAGE_MISSING", statusCode: 503 }
    );
    await onInvalid(error);
    throw error;
  };
  return {
    read,
    update(mutator) {
      const operation = queue.then(async () => {
        const auth = await read();
        const result = await mutator(auth);
        await writeDocument(file, auth);
        observedDocument = true;
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
}

/**
 * Creates the configured identity port; PostgreSQL row mode has no document fallback.
 * @since unreleased
 */
export function createAuthRepository({
  runtime,
  queryMode = "document",
  normalizeDocument,
  onCommitted,
  file,
  readDocument,
  writeDocument,
  onInvalid,
  canInitialize = async () => false
}) {
  if (queryMode === "row") {
    if (!runtime?.auth?.row) throw new Error("AUTH_QUERY_MODE=row requires PostgreSQL");
    return rowPort(runtime, onCommitted);
  }
  const source = runtime?.auth || jsonSource({
    file, readDocument, writeDocument, onInvalid, canInitialize
  });
  return createDocumentAuthPort({ source, normalizeDocument, onCommitted });
}
