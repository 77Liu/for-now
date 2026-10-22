/**
 * 为服务端回归准备已认证的隔离 JSON 运行时。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：只写调用方提供的临时目录，并且只使用合成凭据。
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const ACCOUNT_FILES = Object.freeze({
  "store.json": () => ({ version: 18 }),
  "llm-settings.json": () => ({ version: 5 }),
  "ai-usage.json": () => ({ version: 4, entries: [] })
});

async function copyOrInitialize(
  dataDir: string,
  userDir: string,
  name: string,
  fallback: () => unknown
): Promise<void> {
  const source = path.join(dataDir, name);
  const target = path.join(userDir, name);
  try {
    await fs.copyFile(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.writeFile(target, `${JSON.stringify(fallback(), null, 2)}\n`, {
      mode: 0o600
    });
  }
}

async function copyDirectory(dataDir: string, userDir: string, name: string): Promise<void> {
  try {
    await fs.cp(path.join(dataDir, name), path.join(userDir, name), {
      recursive: true
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(path.join(userDir, name), { recursive: true, mode: 0o700 });
  }
}

async function copyOptionalFile(dataDir: string, userDir: string, name: string): Promise<void> {
  try {
    await fs.copyFile(path.join(dataDir, name), path.join(userDir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function linkRootFixture(dataDir: string, userDir: string, name: string): Promise<void> {
  const source = path.join(dataDir, name);
  await fs.rm(source, { recursive: true, force: true });
  await fs.symlink(path.join(userDir, name), source);
}

export type AuthenticatedRuntimeFixture = Readonly<{
  userId: string;
  userDir: string;
  token: string;
  cookie: string;
  invitation: string;
  env: Readonly<Record<string, string>>;
}>;

/**
 * Moves a temporary root fixture behind one real synthetic Owner identity.
 * @since unreleased
 */
export async function installAuthenticatedJsonRuntime(
  dataDir: string,
  {
    userId = "test-owner",
    username = "test-owner",
    password = "test-password-1",
    token = "test-session-token",
    invitation = "test-invitation",
    mirrorRootPaths = true
  }: {
    userId?: string;
    username?: string;
    password?: string;
    token?: string;
    invitation?: string;
    mirrorRootPaths?: boolean;
  } = {}
): Promise<AuthenticatedRuntimeFixture> {
  const userDir = path.join(dataDir, "users", userId);
  await fs.mkdir(userDir, { recursive: true, mode: 0o700 });
  for (const [name, fallback] of Object.entries(ACCOUNT_FILES)) {
    await copyOrInitialize(dataDir, userDir, name, fallback);
    if (mirrorRootPaths) await linkRootFixture(dataDir, userDir, name);
  }
  await copyOptionalFile(dataDir, userDir, "ai-cost-plan.json");
  if (mirrorRootPaths) {
    await linkRootFixture(dataDir, userDir, "ai-cost-plan.json");
  }
  await copyDirectory(dataDir, userDir, "attachments");
  if (mirrorRootPaths) await linkRootFixture(dataDir, userDir, "attachments");
  await copyDirectory(dataDir, userDir, "logs");
  const salt = Buffer.alloc(16, 19);
  const createdAt = "2026-10-18T00:00:00.000Z";
  const auth = {
    version: 3,
    users: [{
      id: userId,
      username,
      passwordHash: `scrypt$${salt.toString("base64")}$${crypto.scryptSync(password, salt, 64).toString("base64")}`,
      role: "owner",
      sessionVersion: 1,
      recordTimezone: "Asia/Shanghai",
      createdAt
    }],
    sessions: [{
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId,
      sessionVersion: 1,
      createdAt,
      expiresAt: "2099-10-18T00:00:00.000Z"
    }]
  };
  await fs.writeFile(
    path.join(dataDir, "auth.json"),
    `${JSON.stringify(auth, null, 2)}\n`,
    { mode: 0o600 }
  );
  const env = Object.freeze({
    AUTH_REQUIRED: "1",
    AUTH_QUERY_MODE: "document",
    INVITE_CODE_HASH: crypto.createHash("sha256").update(invitation).digest("hex")
  });
  return Object.freeze({
    userId,
    userDir,
    token,
    cookie: `for_now_session=${encodeURIComponent(token)}`,
    invitation,
    env
  });
}
