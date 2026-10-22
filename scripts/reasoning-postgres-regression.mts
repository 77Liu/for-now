/**
 * Verifies actual domain reasoning writes, reload, RLS and private atomic audits in PostgreSQL.
 * Established: 2026-10-19
 * Status: active
 * Boundary: fresh local cluster and synthetic accounts; no production URLs or paid provider.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

const source = (file: string) => pathToFileURL(path.resolve(file)).href;
await import(source("scripts/prompt-test-setup.mjs"));
const { createPostgresRuntime, initializePostgresSchema, applyPostgresMigration, buildPostgresMigrationPlan } =
  await import(source("src/shared/persistence/index.mjs"));
const { createEmptyStore } = await import(source("src/app/index.mjs"));
const { createAiGenerator, createAiAudit, normalizeLlmSettings, projectProductReasoning } =
  await import(source("src/modules/ai/index.mjs"));
const { createChatRecords, chatHistory } = await import(source("src/modules/chats/index.mjs"));
const { createJournalRecords } = await import(source("src/modules/journals/index.mjs"));
const { createReviewRecords } = await import(source("src/modules/reviews/index.mjs"));
const { createThoughtService, createThoughtTaskTarget, thoughtChainDetail } =
  await import(source("src/modules/thoughts/index.mjs"));
const { createAnnotationService } = await import(source("src/modules/annotations/index.mjs"));
const { buildExportManifest } = await import(source("src/modules/exports/index.mjs"));

const binaryDir = process.env.PG_TEST_BIN;
assert.ok(binaryDir, "PG_TEST_BIN must identify verified local PostgreSQL binaries");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "for-now-reasoning-pg-"));
const cluster = path.join(temporary, "cluster");
const password = crypto.randomBytes(24).toString("hex");
const binaryEnvironment = {
  ...process.env, LC_ALL: "C", LANG: "C",
  DYLD_LIBRARY_PATH: path.resolve(binaryDir, "../lib")
};
const execute = promisify(execFile);
const command = (name: string, args: string[]) => execute(path.join(binaryDir, name), args, {
  timeout: 30_000, env: binaryEnvironment, maxBuffer: 1024 * 1024
});
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as net.AddressInfo).port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});
const clients: pg.Client[] = [];
let started = false;
let runtime: any;
const accountContext = new AsyncLocalStorage<string>();
const account = (id: string, action: () => Promise<any>) => accountContext.run(id, action);

try {
  const version = (await command("postgres", ["--version"])).stdout.trim();
  assert.match(version, /PostgreSQL\) 16\./);
  const port = await freePort();
  const passwordFile = path.join(temporary, "password");
  await fs.writeFile(passwordFile, password, { mode: 0o600 });
  await command("initdb", [
    "-D", cluster, "-U", "postgres", "-A", "scram-sha-256",
    "--pwfile", passwordFile, "--locale=C", "--encoding=UTF8"
  ]);
  await fs.appendFile(path.join(cluster, "postgresql.conf"),
    `\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\n`);
  await command("pg_ctl", ["-D", cluster, "-l", path.join(temporary, "postgres.log"), "-w", "start"]);
  started = true;
  const connect = async (user: string) => {
    const client = new pg.Client({ host: "127.0.0.1", port, database: "postgres", user, password });
    await client.connect();
    clients.push(client);
    return client;
  };
  const admin = await connect("postgres");
  await initializePostgresSchema(admin);
  for (const role of ["reasoning_data", "reasoning_auth", "reasoning_budget"]) {
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  }
  await admin.query(`
    GRANT USAGE ON SCHEMA for_now TO reasoning_data;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA for_now TO reasoning_data;
    REVOKE ALL ON for_now.site_ai_budget FROM reasoning_data;
    GRANT USAGE ON SCHEMA for_now_auth TO reasoning_auth;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA for_now_auth TO reasoning_auth;
    GRANT EXECUTE ON FUNCTION for_now_auth.provision_account(text,jsonb,jsonb) TO reasoning_auth;
    GRANT USAGE ON SCHEMA for_now TO reasoning_budget;
    GRANT SELECT,UPDATE ON for_now.site_ai_budget TO reasoning_budget
  `);
  const data = await connect("reasoning_data");
  const time = "2026-10-19T00:00:00.000Z";
  for (const id of ["reasoning-a", "reasoning-b"]) {
    const store = createEmptyStore();
    store.thoughts.push({
      id: "root", type: "question", content: "Synthetic question", version: 1,
      createdAt: time, occurredAt: time, occurredOn: "2026-10-19", tags: []
    });
    store.journals.push({
      id: "journal", content: "Synthetic journal", version: 1, reflections: [],
      createdAt: time, occurredAt: time, occurredOn: "2026-10-19"
    });
    await applyPostgresMigration(data, buildPostgresMigrationPlan({ accountId: id, store }));
  }
  const url = (role: string) => `postgresql://${role}:${password}@127.0.0.1:${port}/postgres`;
  runtime = await createPostgresRuntime({
    connectionString: url("reasoning_data"), authConnectionString: url("reasoning_auth"),
    budgetConnectionString: url("reasoning_budget"), getAccountId: () => accountContext.getStore()
  });
  const repository = runtime.createStoreRepository({
    normalize: (value: unknown) => value, emptyDocument: createEmptyStore()
  });
  const audit = createAiAudit({
    textLimit: 1_000_000,
    repository: runtime.aiAudit,
    getContext: () => ({ user: { id: accountContext.getStore() }, secrets: [] }),
    append: async () => {},
    updateUsage: async () => {},
    logEvent: async () => {},
    now: () => time
  });
  const generate = createAiGenerator({
    readSettings: async () => normalizeLlmSettings({ apiKey: "isolated-only" }),
    getContext: () => ({ user: { id: accountContext.getStore() }, secrets: [] }),
    reserveAttempt: async () => () => {},
    gate: { acquire: async () => () => {} },
    audit,
    provider: {
      endpointHost: "isolated.invalid",
      imageInput: async () => { throw new Error("No images in this fixture"); },
      complete: async () => ({ content: "Synthetic answer", reasoningContent: "SUPPLIER_REASONING_MARKER", httpStatus: 200 })
    }
  });
  await account("reasoning-a", async () => {
    const visible = await generate("Synthetic prompt", { scene: "thoughtAnswer", captureReasoning: true });
    const hidden = await generate("Synthetic internal", {
      scene: "perceptionExtraction", captureReasoning: true, retryWithoutThinking: false
    });
    assert.equal(Object.hasOwn(hidden, "reasoningContent"), false);
    const thoughts = createThoughtService({
      repository,
      createId: () => crypto.randomUUID(),
      now: () => time,
      recordVersion: (value: unknown) => Math.max(1, Number(value) || 1),
      eventTimeFields: () => ({ occurredAt: time, occurredOn: "2026-10-19" }),
      reanchorAnnotations: () => {}
    });
    const thoughtTarget = createThoughtTaskTarget({
      createId: () => crypto.randomUUID(), now: () => time, stripThoughtAnswerLead: (value: string) => value
    });
    const annotations = createAnnotationService({
      createId: () => crypto.randomUUID(), now: () => time
    });
    const chats = createChatRecords({ repository });
    const journals = createJournalRecords({ repository, reanchorAnnotations: () => {} });
    const reviews = createReviewRecords({ repository });
    await repository.update((store: any) => {
      thoughts.saveGeneratedAnswerInStore(store, {
        id: "root", clientRequestId: "answer-request", sourceVersion: 1, ...visible
      });
      const root = store.thoughts.find((item: any) => item.id === "root");
      root.followUps = [{ id: "follow-up", question: "Synthetic follow up", version: 1 }];
      thoughtTarget.saveFollowUp({ root, followUp: root.followUps[0] }, {
        id: "follow-up-task", clientRequestId: "follow-up-request"
      }, visible);
      const annotation = { id: "annotation", shenji: [] };
      root.annotations = [annotation];
      annotations.saveTaskReply(annotation, {
        id: "annotation-task", clientRequestId: "annotation-request", payload: { message: "Synthetic comment" }
      }, visible);
      chats.saveInStore(store, {
        message: "Synthetic chat", answer: visible.content, reasoningContent: visible.reasoningContent,
        eventTime: { occurredAt: time, occurredOn: "2026-10-19" }
      });
      journals.addReflectionInStore(store, "journal", { sourceUpdatedAt: time, ...visible });
      reviews.saveAnalysisInStore(store, { reason: "manual", ...visible });
      const assertJson = (value: any, location = "store") => {
        assert.notEqual(value, undefined, `Undefined fixture field: ${location}`);
        if (value && typeof value === "object") {
          for (const [key, item] of Object.entries(value)) assertJson(item, `${location}.${key}`);
        }
      };
      assertJson(store);
    });
    const reloaded = await repository.read();
    const detail = thoughtChainDetail(reloaded.thoughts, "root");
    assert.equal(detail.blocks[0].reasoningVisibility, "user_viewable");
    assert.equal(detail.followUps[0].reasoningContent, visible.reasoningContent);
    assert.equal(detail.annotations[0].shenji[0].reasoningContent, visible.reasoningContent);
    assert.equal(reloaded.chats[0].reasoningVisibility, "user_viewable");
    assert.equal(reloaded.journals[0].reflections[0].reasoningContent, visible.reasoningContent);
    assert.equal(reloaded.analyses[0].reasoningVisibility, "user_viewable");
    assert.equal(JSON.stringify(chatHistory(reloaded.chats)).includes("SUPPLIER_REASONING_MARKER"), false);
    assert.equal(JSON.stringify(buildExportManifest(reloaded)).includes("SUPPLIER_REASONING_MARKER"), false);
    assert.equal(JSON.stringify(projectProductReasoning({ reasoningContent: "HISTORICAL" })).includes("HISTORICAL"), false);
  });
  await account("reasoning-b", async () => {
    const other = await repository.read();
    assert.equal(other.chats.length, 0);
    assert.equal(other.analyses.length, 0);
    assert.equal(other.journals[0].reflections.length, 0);
  });
  const rows = (await admin.query(`SELECT scene,reasoning_visibility,request_payload,response_payload
    FROM for_now.ai_request_audit ORDER BY scene`)).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.response_payload.reasoningContent === "SUPPLIER_REASONING_MARKER"));
  assert.ok(rows.every(row => row.request_payload.systemPrompt && row.request_payload.userPrompt));
  assert.equal(rows.find(row => row.scene === "perceptionExtraction").reasoning_visibility, "privileged_only");
  await data.query("BEGIN");
  try {
    await data.query("SELECT set_config('app.account_id','reasoning-b',true)");
    assert.equal((await data.query("SELECT count(*)::int AS n FROM for_now.ai_request_audit")).rows[0].n, 0);
  } finally { await data.query("ROLLBACK"); }
  console.log(`Reasoning PostgreSQL passed: ${version}, six durable result types reload, same-row full audit, RLS isolation, context/export exclusion.`);
} finally {
  await runtime?.close();
  await Promise.all(clients.map(client => client.end().catch(() => {})));
  if (started) await command("pg_ctl", ["-D", cluster, "-m", "immediate", "-w", "stop"]);
  await fs.rm(temporary, { recursive: true, force: true });
}
