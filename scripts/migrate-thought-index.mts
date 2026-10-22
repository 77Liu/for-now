/**
 * 按受信账户显式分批回填思绪当前索引；默认只展示计划。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：不读取用户正文到输出，不在查询失败时调用；应用业务事实不变。
 */
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./project-root.mjs";
import type { ThoughtQueryRepository, createThoughtQueryRuntime } from "../src/modules/thoughts/query-runtime.mjs";

const args = process.argv.slice(2);
const accountPosition = args.indexOf("--account-id");
const accountId = accountPosition >= 0 ? args[accountPosition + 1] : "";
const known = new Set(["--account-id", "--apply"]);
if (!accountId || !/^[A-Za-z0-9_-]{1,100}$/u.test(accountId)
  || args.some((arg, index) => index !== accountPosition + 1 && !known.has(arg))) {
  throw new Error("Usage: migrate:thought-index -- --account-id <trusted-account-id> [--apply]");
}
if (!args.includes("--apply")) {
  console.log(JSON.stringify({ mode: "plan", accountId, batchRoots: 100,
    operation: "Rebuild the current thought index in bounded account transactions; business records remain unchanged" }));
} else {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const root = projectRoot(import.meta.url);
  type Runtime = {
    createStoreRepository(options: { normalize(value: unknown): unknown; emptyDocument: unknown }): ThoughtQueryRepository;
    close(): Promise<void>;
  };
  const { createPostgresRuntime }: { createPostgresRuntime(options: {
    connectionString: string; authConnectionString?: string; budgetConnectionString?: string;
    getAccountId(): string;
  }): Promise<Runtime> } = await import(pathToFileURL(path.join(root, "src/shared/persistence/index.mjs")).href);
  const { createThoughtQueries }: { createThoughtQueries(options: {
    repository: ThoughtQueryRepository; enabled: boolean;
    discoveryProjection: (thoughts: unknown[]) => unknown;
    speechProjection: (thoughts: unknown[]) => unknown;
  }): NonNullable<ReturnType<typeof createThoughtQueryRuntime>> } = await import(pathToFileURL(path.join(root, "src/modules/thoughts/index.mjs")).href);
  const { thoughtDiscoveryProjection }: { thoughtDiscoveryProjection(thoughts: unknown[]): unknown } =
    await import(pathToFileURL(path.join(root, "src/modules/discovery/index.mjs")).href);
  const { thoughtSpeechProjection }: { thoughtSpeechProjection(thoughts: unknown[], hash: (value: string) => string): unknown } =
    await import(pathToFileURL(path.join(root, "src/app/index.mjs")).href);
  const hash = (value: string) => crypto.createHash("sha256").update(String(value)).digest("hex");
  const runtime = await createPostgresRuntime({
    connectionString: process.env.DATABASE_URL,
    authConnectionString: process.env.AUTH_DATABASE_URL,
    budgetConnectionString: process.env.AI_BUDGET_DATABASE_URL,
    getAccountId: () => accountId
  });
  try {
    const repository = runtime.createStoreRepository({ normalize: value => value, emptyDocument: {} });
    const queries = createThoughtQueries({ repository, enabled: false, discoveryProjection: thoughtDiscoveryProjection,
      speechProjection: thoughts => thoughtSpeechProjection(thoughts, hash) });
    console.log(JSON.stringify({ mode: "applied", accountId, ...await queries.rebuild() }));
  } finally {
    await runtime.close();
  }
}
