/**
 * 在隔离 PostgreSQL 比较真实分布脱敏语料的子串与全文搜索。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：只接收来源进程内字符替换的语料；回执仅含摘要、数量和查询计划。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { SqlClient } from "../src/modules/thoughts/query-contracts.mjs";
import { thoughtSearchGrams } from "../src/modules/thoughts/query-contracts.mjs";

type Sample = { id: string; text: string };
type Corpus = { sanitization: string; rootCount: number; samples: Sample[] };
function parseCorpus(value: unknown): Corpus {
  assert.ok(value && typeof value === "object" && "samples" in value && Array.isArray(value.samples));
  assert.ok("sanitization" in value && value.sanitization === "ephemeral-character-substitution-v1");
  const samples: Sample[] = value.samples.map((sample: unknown) => {
    assert.ok(sample && typeof sample === "object" && "id" in sample && typeof sample.id === "string"
      && "text" in sample && typeof sample.text === "string");
    assert.match(sample.id, /^sample-\d+$/u);
    return { id: sample.id, text: sample.text };
  });
  assert.ok(samples.length > 0 && samples.length <= 1000);
  return { sanitization: value.sanitization, rootCount: samples.length, samples };
}

/** 使用测试集群现有连接；缺少真实语料时明确 NOT_RUN，不伪造通过。 @since unreleased */
export async function runThoughtSearchCorpusChecks(database: SqlClient): Promise<void> {
  const corpusFile = process.env.THOUGHT_SEARCH_CORPUS;
  if (!corpusFile) {
    console.log("THOUGHT_SEARCH_CORPUS NOT_RUN: no sanitized real corpus supplied");
    return;
  }
  const bytes = await fs.readFile(corpusFile);
  const corpus = parseCorpus(JSON.parse(bytes.toString("utf8")) as unknown);
  const terms = new Set<string>();
  for (const sample of corpus.samples) {
    const word = sample.text.match(/[\u4e00-\u9fff]{4,}/u)?.[0];
    if (word) for (const size of [1, 2, 3, 4]) terms.add(word.slice(0, size));
    if (terms.size >= 32) break;
  }
  assert.ok(terms.size >= 4);
  await database.query(`CREATE TEMP TABLE thought_corpus_benchmark (
    id text PRIMARY KEY, body text NOT NULL, grams text[] NOT NULL, tokens tsvector NOT NULL
  )`);
  try {
    const rows = corpus.samples.map(sample => ({ id: sample.id, body: sample.text, grams: thoughtSearchGrams(sample.text) }));
    await database.query(`INSERT INTO thought_corpus_benchmark
      SELECT id,body,grams,to_tsvector('simple',body) FROM jsonb_to_recordset($1::jsonb)
      AS row(id text,body text,grams text[])`, [JSON.stringify(rows)]);
    await database.query("CREATE INDEX thought_corpus_grams_idx ON thought_corpus_benchmark USING gin(grams) WITH (fastupdate=off)");
    await database.query("CREATE INDEX thought_corpus_tokens_idx ON thought_corpus_benchmark USING gin(tokens)");
    await database.query(`INSERT INTO thought_corpus_benchmark
      SELECT 'noise-'||n::text,'unrelated noise',ARRAY['u','n','r'],to_tsvector('simple','unrelated noise')
      FROM generate_series(1,$1::int) n`, [corpus.rootCount * 99]);
    await database.query("ANALYZE thought_corpus_benchmark");
    let normalizedMatches = 0;
    let fullTextMatches = 0;
    let expectedMatches = 0;
    const plans: unknown[] = [];
    for (const term of terms) {
      const expected = corpus.samples.filter(sample => sample.text.includes(term)).map(sample => sample.id).sort();
      const actual = await database.query<{ id: string }>(`SELECT id FROM thought_corpus_benchmark
        WHERE grams @> $1::text[] AND position($2 in body)>0 ORDER BY id`, [thoughtSearchGrams(term), term]);
      assert.deepEqual(actual.rows.map(row => row.id), expected);
      const fullText = await database.query<{ id: string }>(`SELECT id FROM thought_corpus_benchmark
        WHERE tokens @@ plainto_tsquery('simple',$1) ORDER BY id`, [term]);
      expectedMatches += expected.length;
      normalizedMatches += actual.rows.length;
      fullTextMatches += fullText.rows.length;
      if (plans.length < 2) {
        const plan = await database.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
          SELECT id FROM thought_corpus_benchmark
          WHERE grams @> $1::text[] AND position($2 in body)>0 ORDER BY id DESC LIMIT 21`, [thoughtSearchGrams(term), term]);
        assert.doesNotMatch(JSON.stringify(plan.rows), /"Node Type":"Seq Scan"/u);
        plans.push(plan.rows);
      }
    }
    console.log("THOUGHT_SEARCH_CORPUS " + JSON.stringify({ status: "PASS",
      corpusSha256: crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 6),
      roots: corpus.rootCount, unrelatedRoots: corpus.rootCount * 99, queries: terms.size, expectedMatches, normalizedMatches, fullTextMatches,
      normalizedRecall: normalizedMatches / expectedMatches,
      fullTextRecall: fullTextMatches / expectedMatches,
      limitation: "Character substitution preserves substring equality and shape; it does not validate linguistic segmentation or production latency.",
      plans }));
  } finally {
    await database.query("DROP TABLE thought_corpus_benchmark");
  }
}
