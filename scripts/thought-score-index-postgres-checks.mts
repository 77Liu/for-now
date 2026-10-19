/**
 * 存量评分索引的补建、更新、回滚与账户隔离验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：原字段保持无损；只对合成账户模拟旧结构和索引失败。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { QueryClient } from "../src/shared/persistence/account-unit-of-work.mjs";

/** 补建和日后字段更新均保持评分顺序；索引失败使原写入回滚。 @since unreleased */
export async function runThoughtScoreIndexPostgresChecks(database: QueryClient) {
  const schema = await fs.readFile(
    path.resolve("src/shared/persistence/postgres-schema.sql"), "utf8"
  );
  const marker = "-- migration:task-importance-score-index-v1";
  assert.ok(schema.includes(marker));
  const migration = schema.slice(schema.indexOf(marker));
  const accountId = "score-index-legacy";
  const peer = "score-index-peer";
  const scores = [
    { accountId, sourceKey: "first", sourceVersion: 1, contentSha256: "a", score: 70 },
    { accountId, sourceKey: "first", sourceVersion: 2, contentSha256: "b", score: 80 },
    { accountId: peer, sourceKey: "foreign", sourceVersion: 1, contentSha256: "c", score: 90 }
  ];
  await database.query("INSERT INTO for_now.accounts(account_id) VALUES($1),($2)", [accountId, peer]);
  await database.query("ALTER TABLE for_now.store_fields DISABLE TRIGGER importance_score_index_write");
  await database.query(`
    INSERT INTO for_now.store_fields(account_id, field, shape, payload)
    VALUES($1, 'importanceScores', 'value', $2::jsonb)
  `, [accountId, JSON.stringify(scores)]);
  await database.query("ALTER TABLE for_now.store_fields ENABLE TRIGGER importance_score_index_write");
  const read = async () => (await database.query<{ payload: unknown }>(`
    SELECT payload FROM for_now.importance_score_index WHERE account_id = $1 ORDER BY ordinal
  `, [accountId])).rows.map(row => row.payload);
  assert.deepEqual(await read(), []);
  await database.query(migration);
  assert.deepEqual(await read(), scores);
  await database.query(migration);
  assert.deepEqual(await read(), scores, "repeat score migration must preserve order");
  const original = (await database.query<{ payload: unknown }>(`
    SELECT payload FROM for_now.store_fields WHERE account_id=$1 AND field='importanceScores'
  `, [accountId])).rows[0].payload;
  assert.deepEqual(original, scores, "index migration must retain the source field");
  await database.query("BEGIN");
  try {
    await database.query("SET LOCAL ROLE runtime_data");
    await database.query("SELECT set_config('app.account_id',$1,true)", [peer]);
    assert.deepEqual(await read(), [], "RLS must hide another account's score index");
  } finally {
    await database.query("ROLLBACK");
  }
  const corrected = { ...scores[0], score: 99 };
  await database.query("BEGIN");
  try {
    await database.query("SET LOCAL ROLE runtime_data");
    await database.query("SELECT set_config('app.account_id',$1,true)", [accountId]);
    await database.query(`
      UPDATE for_now.store_fields SET payload=$2::jsonb
      WHERE account_id=$1 AND field='importanceScores'
    `, [accountId, JSON.stringify([corrected])]);
    assert.deepEqual(await read(), [corrected], "field update must correct and shrink its index");
  } finally {
    await database.query("ROLLBACK");
  }
  assert.deepEqual(await read(), scores, "rollback must restore both field and index");
  await database.query(`
    ALTER TABLE for_now.importance_score_index ADD CONSTRAINT score_index_test_failure
      CHECK (source_key <> 'reject-this')
  `);
  try {
    await assert.rejects(database.query(`
      UPDATE for_now.store_fields SET payload=$2::jsonb
      WHERE account_id=$1 AND field='importanceScores'
    `, [accountId, JSON.stringify([{ ...corrected, sourceKey: "reject-this" }])]),
    /score_index_test_failure/);
    assert.deepEqual(await read(), scores);
    assert.deepEqual((await database.query<{ payload: unknown }>(`
      SELECT payload FROM for_now.store_fields WHERE account_id=$1 AND field='importanceScores'
    `, [accountId])).rows[0].payload, scores);
  } finally {
    await database.query(
      "ALTER TABLE for_now.importance_score_index DROP CONSTRAINT score_index_test_failure"
    );
  }
  await database.query(`
    DELETE FROM for_now.store_fields WHERE account_id=$1 AND field='importanceScores'
  `, [accountId]);
  assert.deepEqual(await read(), [], "explicit field deletion must remove its derived index");
  console.log("THOUGHT_SCORE_INDEX " + JSON.stringify({
    checks: ["legacy backfill", "idempotent score migration", "source field retained",
      "RLS account isolation", "correction/shrink", "transaction rollback",
      "index failure preserves source", "field deletion cascade"]
  }));
}
