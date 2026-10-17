/**
 * PostgreSQL 身份、会话与账户列表的精准查询和条件命令。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：调用方持有事务；密码 KDF 与其他远程工作不得进入这些函数。
 */

import type { PgQueryClient } from "./ai-audit-repository.mjs";

export type AuthRole = "user" | "owner";

export type AuthUser = Record<string, unknown> & {
  id: string;
  username: string;
  usernameKey: string;
  passwordHash: string;
  role: AuthRole;
  sessionVersion: number;
  recordTimezone: string;
  createdAt: string;
  updatedAt?: string;
  lastSessionAt?: string;
};

export type AuthSession = Record<string, unknown> & {
  tokenHash: string;
  userId: string;
  sessionVersion: number;
  createdAt: string;
  expiresAt: string;
};

export type CredentialSnapshot = Pick<
  AuthUser,
  "id" | "usernameKey" | "passwordHash" | "sessionVersion"
>;

export type AuthPageBoundary = Readonly<{
  createdAt: string;
  id: string;
}>;

type Authentication = Readonly<{
  session: AuthSession;
  user: AuthUser;
}>;

type UserPage = Readonly<{
  users: AuthUser[];
  next: AuthPageBoundary | null;
}>;

const PUBLIC_USER_COLUMNS = `
  id, username, username_key AS "usernameKey",
  role, session_version AS "sessionVersion", record_timezone AS "recordTimezone",
  created_at AS "createdAt", updated_at AS "updatedAt", payload
`;
const CREDENTIAL_USER_COLUMNS = `
  ${PUBLIC_USER_COLUMNS}, password_hash AS "passwordHash"
`;
const SESSION_COLUMNS = `
  token_hash AS "tokenHash", user_id AS "userId",
  session_version AS "sessionVersion", created_at AS "createdAt",
  expires_at AS "expiresAt", payload
`;
const DOCUMENT_FIELDS_MARKER = "__forNowAuthDocumentFieldsV1";

const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);
const timestamp = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};
const version = (value: unknown): number => Number.isSafeInteger(Number(value))
  && Number(value) > 0 ? Number(value) : 1;
const conflict = (message: string, code: string) => Object.assign(
  new Error(message),
  { statusCode: 409, code }
);
const unauthorized = (message: string, code: string) => Object.assign(
  new Error(message),
  { statusCode: 401, code }
);
const forbidden = () => Object.assign(
  new Error("当前账户没有 Owner 权限"),
  { statusCode: 403, code: "OWNER_REQUIRED" }
);

function userFromRow(row: Record<string, unknown>): AuthUser {
  const payload = { ...record(row.payload) };
  delete payload[DOCUMENT_FIELDS_MARKER];
  return {
    ...payload,
    id: String(row.id || ""),
    username: String(row.username || ""),
    usernameKey: String(row.usernameKey || ""),
    passwordHash: String(row.passwordHash || ""),
    role: row.role === "owner" ? "owner" : "user",
    sessionVersion: version(row.sessionVersion),
    recordTimezone: String(row.recordTimezone || "Asia/Shanghai"),
    createdAt: timestamp(row.createdAt),
    ...(row.updatedAt ? { updatedAt: timestamp(row.updatedAt) } : {}),
    ...(row.lastSessionAt ? { lastSessionAt: timestamp(row.lastSessionAt) } : {})
  };
}

function sessionFromRow(row: Record<string, unknown>): AuthSession {
  const payload = { ...record(row.payload) };
  delete payload[DOCUMENT_FIELDS_MARKER];
  return {
    ...payload,
    tokenHash: String(row.tokenHash || ""),
    userId: String(row.userId || ""),
    sessionVersion: version(row.sessionVersion),
    createdAt: timestamp(row.createdAt),
    expiresAt: timestamp(row.expiresAt)
  };
}

function userValues(user: AuthUser): unknown[] {
  const {
    id, username, usernameKey, passwordHash, role, sessionVersion,
    recordTimezone, createdAt, updatedAt, ...payload
  } = user;
  return [
    id, username, usernameKey, passwordHash, role, sessionVersion,
    recordTimezone, createdAt, updatedAt || null, JSON.stringify(payload)
  ];
}

function sessionValues(session: AuthSession): unknown[] {
  const {
    tokenHash, userId, sessionVersion, createdAt, expiresAt, ...payload
  } = session;
  return [
    tokenHash, userId, sessionVersion, createdAt, expiresAt,
    JSON.stringify(payload)
  ];
}

async function lockedAuthentication(
  client: PgQueryClient,
  tokenHash: string
): Promise<Authentication | null> {
  const sessionResult = await client.query(`
    SELECT ${SESSION_COLUMNS}
    FROM for_now_auth.sessions
    WHERE token_hash = $1
    FOR UPDATE
  `, [tokenHash]);
  if (!sessionResult.rows[0]) return null;
  const session = sessionFromRow(sessionResult.rows[0]);
  const userResult = await client.query(`
    SELECT ${PUBLIC_USER_COLUMNS}
    FROM for_now_auth.users
    WHERE id = $1
    FOR UPDATE
  `, [session.userId]);
  if (!userResult.rows[0]) return null;
  return { session, user: userFromRow(userResult.rows[0]) };
}

async function lockedUserById(
  client: PgQueryClient,
  id: string
): Promise<AuthUser | null> {
  const result = await client.query(`
    SELECT ${PUBLIC_USER_COLUMNS}
    FROM for_now_auth.users
    WHERE id = $1
    FOR UPDATE
  `, [id]);
  return result.rows[0] ? userFromRow(result.rows[0]) : null;
}

async function lockedCredentialById(
  client: PgQueryClient,
  id: string
): Promise<AuthUser | null> {
  const result = await client.query(`
    SELECT ${CREDENTIAL_USER_COLUMNS}
    FROM for_now_auth.users
    WHERE id = $1
    FOR UPDATE
  `, [id]);
  return result.rows[0] ? userFromRow(result.rows[0]) : null;
}

function requireCurrentAuthentication(
  authentication: Authentication | null,
  nowMs: number
): Authentication {
  if (!authentication || Date.parse(authentication.session.expiresAt) <= nowMs) {
    throw unauthorized("请先登录", "AUTH_REQUIRED");
  }
  if (authentication.session.sessionVersion !== authentication.user.sessionVersion) {
    throw unauthorized("账户权限已变更，请重新登录", "AUTH_REAUTH_REQUIRED");
  }
  return authentication;
}

/** Reads at most one credential row by its normalized username. @since unreleased */
export async function findAuthCredential(
  client: PgQueryClient,
  usernameKey: string
): Promise<AuthUser | null> {
  const result = await client.query(`
    SELECT ${CREDENTIAL_USER_COLUMNS}
    FROM for_now_auth.users
    WHERE username_key = $1
  `, [usernameKey]);
  return result.rows[0] ? userFromRow(result.rows[0]) : null;
}

/** Reads one credential row by stable user ID. @since unreleased */
export async function findAuthCredentialById(
  client: PgQueryClient,
  id: string
): Promise<AuthUser | null> {
  const result = await client.query(`
    SELECT ${CREDENTIAL_USER_COLUMNS}
    FROM for_now_auth.users
    WHERE id = $1
  `, [id]);
  return result.rows[0] ? userFromRow(result.rows[0]) : null;
}

/** Reads one session and its user by token digest. @since unreleased */
export async function findAuthAuthentication(
  client: PgQueryClient,
  tokenHash: string
): Promise<Authentication | null> {
  const result = await client.query(`
    SELECT
      s.token_hash AS "tokenHash", s.user_id AS "userId",
      s.session_version AS "sessionVersion", s.created_at AS "createdAt",
      s.expires_at AS "expiresAt", s.payload AS "sessionPayload",
      u.id AS "authUserId", u.username AS "authUsername",
      u.username_key AS "authUsernameKey",
      u.role AS "authRole", u.session_version AS "authSessionVersion",
      u.record_timezone AS "authRecordTimezone", u.created_at AS "authCreatedAt",
      u.updated_at AS "authUpdatedAt", u.payload AS "authUserPayload"
    FROM for_now_auth.sessions s
    JOIN for_now_auth.users u ON u.id = s.user_id
    WHERE s.token_hash = $1
  `, [tokenHash]);
  const row = result.rows[0];
  if (!row) return null;
  const session = sessionFromRow({ ...row, payload: row.sessionPayload });
  const user = userFromRow({
    id: row.authUserId,
    username: row.authUsername,
    usernameKey: row.authUsernameKey,
    role: row.authRole,
    sessionVersion: row.authSessionVersion,
    recordTimezone: row.authRecordTimezone,
    createdAt: row.authCreatedAt,
    updatedAt: row.authUpdatedAt,
    payload: row.authUserPayload
  });
  return { session, user };
}

/** Reads one user by stable account ID. @since unreleased */
export async function findAuthUserById(
  client: PgQueryClient,
  id: string
): Promise<AuthUser | null> {
  const result = await client.query(`
    SELECT ${PUBLIC_USER_COLUMNS}
    FROM for_now_auth.users
    WHERE id = $1
  `, [id]);
  return result.rows[0] ? userFromRow(result.rows[0]) : null;
}

/** Reads the oldest Owner without scanning unrelated identities. @since unreleased */
export async function findFirstAuthOwner(client: PgQueryClient): Promise<AuthUser | null> {
  const result = await client.query(`
    SELECT ${PUBLIC_USER_COLUMNS}
    FROM for_now_auth.users
    WHERE role = 'owner'
    ORDER BY created_at, id
    LIMIT 1
  `);
  return result.rows[0] ? userFromRow(result.rows[0]) : null;
}

/** Counts identities without materializing their rows. @since unreleased */
export async function countAuthUsers(client: PgQueryClient): Promise<number> {
  const result = await client.query(
    "SELECT count(*)::int AS count FROM for_now_auth.users"
  );
  return Number(result.rows[0]?.count) || 0;
}

/** Returns one stable keyset page; callers enforce the public page-size ceiling. @since unreleased */
export async function listAuthUsersPage(
  client: PgQueryClient,
  limit: number,
  after: AuthPageBoundary | null = null
): Promise<UserPage> {
  const result = await client.query(`
    SELECT ${PUBLIC_USER_COLUMNS},
      (SELECT max(session.created_at)
       FROM for_now_auth.sessions session
       WHERE session.user_id = users.id) AS "lastSessionAt"
    FROM for_now_auth.users users
    WHERE ($2::timestamptz IS NULL OR (users.created_at, users.id) > ($2::timestamptz, $3))
    ORDER BY users.created_at, users.id
    LIMIT $1
  `, [limit + 1, after?.createdAt || null, after?.id || ""]);
  const users = result.rows.slice(0, limit).map(userFromRow);
  const tail = result.rows.length > limit ? users.at(-1) : null;
  return {
    users,
    next: tail ? { createdAt: tail.createdAt, id: tail.id } : null
  };
}

/** Inserts one identity and one session. The caller serializes bootstrap ownership. @since unreleased */
export async function insertAuthRegistration(
  client: PgQueryClient,
  user: AuthUser,
  session: AuthSession
): Promise<void> {
  try {
    await client.query(`
      INSERT INTO for_now_auth.users (
        id, username, username_key, password_hash, role, session_version,
        record_timezone, created_at, updated_at, payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    `, userValues(user));
  } catch (error) {
    const databaseError = error as { code?: string; constraint?: string };
    if (databaseError.code === "23505"
      && databaseError.constraint === "users_username_key_key") {
      throw conflict("用户名已存在", "AUTH_USERNAME_CONFLICT");
    }
    throw error;
  }
  await client.query(`
    INSERT INTO for_now_auth.sessions (
      token_hash, user_id, session_version, created_at, expires_at, payload
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
  `, sessionValues(session));
}

/** Locks and revalidates the full credential identity before issuing a session. @since unreleased */
export async function issueAuthSessionIfCurrent(
  client: PgQueryClient,
  snapshot: CredentialSnapshot,
  session: AuthSession
): Promise<AuthUser | null> {
  const result = await client.query(`
    SELECT ${CREDENTIAL_USER_COLUMNS}
    FROM for_now_auth.users
    WHERE id = $1
    FOR UPDATE
  `, [snapshot.id]);
  if (!result.rows[0]) return null;
  const user = userFromRow(result.rows[0]);
  if (user.usernameKey !== snapshot.usernameKey
    || user.passwordHash !== snapshot.passwordHash
    || user.sessionVersion !== snapshot.sessionVersion) return null;
  await client.query(`
    INSERT INTO for_now_auth.sessions (
      token_hash, user_id, session_version, created_at, expires_at, payload
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
  `, sessionValues(session));
  return user;
}

/** Lists one Owner-authorized page from the same database snapshot. @since unreleased */
export async function listAuthorizedAuthUsersPage(
  client: PgQueryClient,
  tokenHash: string,
  limit: number,
  after: AuthPageBoundary | null,
  nowMs: number
): Promise<UserPage> {
  const authentication = requireCurrentAuthentication(
    await findAuthAuthentication(client, tokenHash),
    nowMs
  );
  if (authentication.user.role !== "owner") throw forbidden();
  return listAuthUsersPage(client, limit, after);
}

/** Changes one target role while preserving the last Owner invariant. @since unreleased */
export async function updateAuthRole(
  client: PgQueryClient,
  tokenHash: string,
  userId: string,
  role: AuthRole,
  updatedAt: string,
  nowMs: number
): Promise<{ before: AuthUser; after: AuthUser }> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('for-now-auth-owner-role', 0))"
  );
  const requester = requireCurrentAuthentication(
    await lockedAuthentication(client, tokenHash),
    nowMs
  );
  if (requester.user.role !== "owner") throw forbidden();
  const target = await lockedUserById(client, userId);
  if (!target) throw Object.assign(new Error("账户不存在"), {
    statusCode: 404, code: "AUTH_USER_NOT_FOUND"
  });
  if (target.role === role) return { before: target, after: target };
  if (target.role === "owner" && role === "user") {
    const owners = await client.query(
      "SELECT count(*)::int AS count FROM for_now_auth.users WHERE role = 'owner'"
    );
    if (Number(owners.rows[0]?.count) <= 1) {
      throw conflict("至少需要保留一个 Owner", "LAST_OWNER_REQUIRED");
    }
  }
  const result = await client.query(`
    UPDATE for_now_auth.users
    SET role = $2, session_version = session_version + 1, updated_at = $3
    WHERE id = $1
    RETURNING ${PUBLIC_USER_COLUMNS}
  `, [userId, role, updatedAt]);
  return { before: target, after: userFromRow(result.rows[0]) };
}

/** Changes one authenticated username under its unique key. @since unreleased */
export async function updateAuthUsername(
  client: PgQueryClient,
  tokenHash: string,
  username: string,
  usernameKey: string,
  updatedAt: string,
  nowMs: number
): Promise<{ before: AuthUser; after: AuthUser }> {
  const { user } = requireCurrentAuthentication(
    await lockedAuthentication(client, tokenHash),
    nowMs
  );
  try {
    const result = await client.query(`
      UPDATE for_now_auth.users
      SET username = $2, username_key = $3, updated_at = $4
      WHERE id = $1
      RETURNING ${PUBLIC_USER_COLUMNS}
    `, [user.id, username, usernameKey, updatedAt]);
    return { before: user, after: userFromRow(result.rows[0]) };
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw conflict("用户名已存在", "AUTH_USERNAME_CONFLICT");
    }
    throw error;
  }
}

/** Changes one authenticated record timezone. @since unreleased */
export async function updateAuthRecordTimezone(
  client: PgQueryClient,
  tokenHash: string,
  recordTimezone: string,
  updatedAt: string,
  nowMs: number
): Promise<{ before: AuthUser; after: AuthUser }> {
  const { user } = requireCurrentAuthentication(
    await lockedAuthentication(client, tokenHash),
    nowMs
  );
  const result = await client.query(`
    UPDATE for_now_auth.users
    SET record_timezone = $2, updated_at = $3
    WHERE id = $1
    RETURNING ${PUBLIC_USER_COLUMNS}
  `, [user.id, recordTimezone, updatedAt]);
  return { before: user, after: userFromRow(result.rows[0]) };
}

/** Revalidates credentials, changes one password, and revokes all of that user's sessions. @since unreleased */
export async function changeAuthPassword(
  client: PgQueryClient,
  tokenHash: string,
  snapshot: CredentialSnapshot,
  passwordHash: string,
  updatedAt: string,
  nowMs: number
): Promise<{ before: AuthUser; after: AuthUser } | null> {
  const authentication = await lockedAuthentication(client, tokenHash);
  if (!authentication || Date.parse(authentication.session.expiresAt) <= nowMs) return null;
  const { user } = authentication;
  const credential = await lockedCredentialById(client, user.id);
  if (!credential
    || credential.id !== snapshot.id
    || credential.usernameKey !== snapshot.usernameKey
    || credential.passwordHash !== snapshot.passwordHash
    || credential.sessionVersion !== snapshot.sessionVersion) return null;
  const result = await client.query(`
    UPDATE for_now_auth.users
    SET password_hash = $2, session_version = session_version + 1, updated_at = $3
    WHERE id = $1
    RETURNING ${PUBLIC_USER_COLUMNS}
  `, [user.id, passwordHash, updatedAt]);
  await client.query(
    "DELETE FROM for_now_auth.sessions WHERE user_id = $1",
    [user.id]
  );
  return { before: user, after: userFromRow(result.rows[0]) };
}

/** Deletes one session by token digest without touching unrelated rows. @since unreleased */
export async function deleteAuthSession(
  client: PgQueryClient,
  tokenHash: string
): Promise<string | null> {
  const result = await client.query(`
    DELETE FROM for_now_auth.sessions
    WHERE token_hash = $1
    RETURNING user_id AS "userId"
  `, [tokenHash]);
  return result.rows[0] ? String(result.rows[0].userId || "") : null;
}
