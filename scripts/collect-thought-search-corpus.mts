/**
 * 只读采集有界真实思绪搜索语料；在来源进程内替换文字后才输出。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：使用 SELECT-only 备份角色与只读事务；不输出账户、身份、正文或替换密钥。
 */
import crypto from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

type Row = { account_id: string; id: string; content: string; payload: Record<string, unknown>; field?: string };
type Client = {
  connect(): Promise<void>;
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};
const require = createRequire(path.join(process.cwd(), "package.json"));
const { Client: PgClient } = require("pg") as { Client: new (options: { connectionString: string }) => Client };

/** 无固定点置换保持字频、长度与子串相等关系；置换只在采集进程内存中存在。 @since unreleased */
function characterSubstitution() {
  const replacements = new Map<string, string>();
  for (const alphabet of [
    Array.from({ length: 0x9fff - 0x4e00 + 1 }, (_, index) => String.fromCodePoint(0x4e00 + index)),
    [..."abcdefghijklmnopqrstuvwxyz"], [..."0123456789"]
  ]) {
    const shuffled = [...alphabet];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const other = crypto.randomInt(index);
      [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
    }
    alphabet.forEach((char, index) => replacements.set(char, shuffled[index]));
  }
  let extended = 0;
  return (value: string) => [...value.normalize("NFKC").toLocaleLowerCase("zh-CN")].map(char => {
    if (!replacements.has(char) && /[\p{L}\p{N}]/u.test(char)) {
      if (extended >= 0x19c0) throw new Error("Character substitution capacity exceeded");
      if (char === String.fromCodePoint(0x3400 + extended)) extended += 1;
      replacements.set(char, String.fromCodePoint(0x3400 + extended++));
    }
    return replacements.get(char) ?? char;
  }).join("");
}
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string") : [];
const string = (value: unknown) => typeof value === "string" ? value : "";

async function collect(client: Client) {
  const identities = await client.query<{ id: string }>("SELECT id FROM for_now_auth.users ORDER BY id LIMIT 26");
  if (identities.rows.length > 25) throw new Error("Account collection bound exceeded");
  const roots: { rows: Row[] } = { rows: [] };
  let truncated = false;
  for (const { id } of identities.rows.length ? identities.rows : [{ id: "local" }]) {
    await client.query("SELECT set_config('app.account_id',$1,true)", [id]);
    const selected = await client.query<Row>(`
      SELECT account_id,id,content,payload FROM for_now.store_objects
      WHERE account_id=$1 AND collection='thoughts' AND parent_key IS NULL AND payload->>'type'='question'
      ORDER BY id LIMIT 1001
    `, [id]);
    roots.rows.push(...selected.rows);
    truncated ||= selected.rows.length > 1000 || roots.rows.length > 1000;
  }
  const substitute = characterSubstitution();
  const accounts = new Set<string>();
  const samples: Array<{ id: string; text: string; tags: string[] }> = [];
  for (const root of roots.rows.slice(0, 1000)) {
    accounts.add(root.account_id);
    await client.query("SELECT set_config('app.account_id',$1,true)", [root.account_id]);
    const owned = await client.query<Row>(`
      SELECT id,content,payload,field FROM for_now.store_objects
      WHERE account_id=$1 AND collection='thoughts'
        AND ((parent_key IS NULL AND payload->>'relatedTo'=$2) OR parent_key=$3)
      ORDER BY object_key LIMIT 1001
    `, [root.account_id, root.id, JSON.stringify(["thoughts", root.id])]);
    if (owned.rows.length > 1000) throw new Error("Owned sample exceeds collection bound");
    const pieces = [root.content, ...strings(root.payload.tags)];
    const tags = [...strings(root.payload.tags)];
    for (const row of owned.rows) {
      if (row.payload.relatedTo === root.id) {
        pieces.push(row.content, ...strings(row.payload.tags));
        tags.push(...strings(row.payload.tags));
      } else if (row.field === "remarks") pieces.push(string(row.payload.text));
      else if (row.field === "followUps") pieces.push(string(row.payload.question), string(row.payload.answer));
    }
    const text = substitute(pieces.filter(Boolean).join(" ").replace(/\s+/gu, " ").trim());
    samples.push({ id: `sample-${samples.length + 1}`, text, tags: [...new Set(tags.map(substitute))] });
  }
  return { schemaVersion: 1, sanitization: "ephemeral-character-substitution-v1",
    collectedAt: new Date().toISOString(), maxRoots: 1000, truncated, sourceVersion: path.basename(process.cwd()),
    accountCount: accounts.size, rootCount: samples.length, samples };
}

const client = new PgClient({ connectionString: process.env.PG_BACKUP_DATABASE_URL || "" });
try {
  if (!process.env.PG_BACKUP_DATABASE_URL) throw new Error("Missing SELECT-only connection");
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout='15s'");
  const result = await collect(client);
  await client.query("COMMIT");
  process.stdout.write(JSON.stringify(result) + "\n");
} catch {
  process.stderr.write("Thought search corpus collection failed; no corpus published.\n");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
