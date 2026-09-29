import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createPostgresRuntime, initializePostgresSchema, buildPostgresMigrationPlan, applyPostgresMigration,
  canonicalJson, discoverJsonBundle, applyPostgresBundle, exportPostgresDirectory, readPostgresBundle
} from "../src/shared/persistence/index.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const empty = () => ({ version: 14, thoughts: [], captures: [], attachmentCleanup: [] });

export async function runRuntimeChecks({ admin, connect, temporary, password, port, freePort }) {
  await admin.query("CREATE DATABASE runtime_test");
  const database = await connect("postgres", "runtime_test");
  await initializePostgresSchema(database);
  for (const role of ["runtime_data", "runtime_auth", "runtime_backup"]) {
    await database.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  }
  await database.query(`
    GRANT USAGE ON SCHEMA for_now TO runtime_data;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA for_now TO runtime_data;
    GRANT USAGE ON SCHEMA for_now_auth TO runtime_auth;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA for_now_auth TO runtime_auth;
    GRANT EXECUTE ON FUNCTION for_now_auth.provision_account(text,jsonb,jsonb) TO runtime_auth;
    GRANT USAGE ON SCHEMA for_now, for_now_auth TO migration_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA for_now, for_now_auth TO migration_app;
    GRANT USAGE ON SCHEMA for_now, for_now_auth TO runtime_backup;
    GRANT SELECT ON ALL TABLES IN SCHEMA for_now, for_now_auth TO runtime_backup;
  `);
  const url = (role, db = "runtime_test") => `postgresql://${role}:${password}@127.0.0.1:${port}/${db}`;
  const context = new AsyncLocalStorage();
  const options = {
    connectionString: url("runtime_data"), authConnectionString: url("runtime_auth"),
    getAccountId: () => context.getStore()
  };
  await assert.rejects(createPostgresRuntime({ ...options, connectionString: url("postgres") }), /separate non-owner/);
  await assert.rejects(createPostgresRuntime({ ...options, requireMigration: true }), /verified full migration/);
  const runtime = await createPostgresRuntime(options), peer = await createPostgresRuntime(options);
  const repo = runtime.createStoreRepository({ normalize: value => value, emptyDocument: empty() });
  const peerRepo = peer.createStoreRepository({ normalize: value => value, emptyDocument: empty() });
  const account = (id, operation) => context.run(id, operation);
  const dataDir = path.join(temporary, "runtime-data");
  const children = new Set();
  let stderr = "";
  let providerCalls = 0;
  const platformToken = "postgres-runtime-platform-token-1";
  const provider = http.createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    providerCalls += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "数据库中的模型回答", reasoning_content: "隔离模型思考" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const startApp = async (db = "runtime_test", directory = dataDir, backend = "postgres") => {
    const appPort = await freePort();
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env, NODE_ENV: "test", PERSISTENCE_BACKEND: backend, DATA_DIR: directory,
        DATABASE_URL: url("runtime_data", db), AUTH_DATABASE_URL: url("runtime_auth", db),
        AUTH_REQUIRED: "1", INVITE_CODE_HASH: crypto.createHash("sha256").update("runtime-invite").digest("hex"),
        APP_BASE_PATH: "/now", PORT: String(appPort), LOCAL_TEST_MODE: "", UPSTREAM_ORIGIN: "",
        ATTACHMENT_STORAGE: "local", DEEPSEEK_API_URL: `http://127.0.0.1:${provider.address().port}`,
        PLATFORM_SERVICE_TOKEN_HASH: crypto.createHash("sha256").update(platformToken).digest("hex")
      }, stdio: ["ignore", "pipe", "pipe"]
    });
    child.stderr.on("data", data => { stderr += data; });
    children.add(child);
    const base = `http://127.0.0.1:${appPort}/now`;
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw new Error(`PostgreSQL app exited (${child.exitCode}): ${stderr}`);
      try { if ((await fetch(`${base}/readyz`)).ok) return { child, base }; } catch {}
      await pause(50);
    }
    throw new Error("PostgreSQL app startup timed out");
  };
  const stop = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    children.delete(child);
  };
  const request = async (base, route, { method = "GET", cookie = "", body, headers = {} } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method, headers: { "content-type": "application/json", cookie, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const waitTask = async (base, cookie, id) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      const task = await request(base, `/api/ai-tasks/${id}`, { cookie });
      assert.equal(task.status, 200);
      if (!["queued", "running"].includes(task.body.status)) return task.body;
      await pause(25);
    }
    throw new Error("PostgreSQL background task timed out");
  };
  try {
    // A provisioning failure rolls identity, session and all tenant rows back together.
    await database.query(`
      CREATE FUNCTION for_now.reject_provision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected provisioning failure'; END $$;
      CREATE TRIGGER reject_provision BEFORE INSERT ON for_now.store_fields FOR EACH ROW EXECUTE FUNCTION for_now.reject_provision()
    `);
    await assert.rejects(runtime.auth.update(auth => {
      auth.users.push({ id: "atomic-user", username: "atomic", passwordHash: "synthetic-hash" });
      runtime.auth.provision("atomic-user", empty(), {});
    }), /injected provisioning failure/);
    assert.equal((await runtime.auth.read()).users.length, 0);
    assert.equal((await database.query("SELECT count(*)::int AS n FROM for_now.accounts")).rows[0].n, 0);
    await database.query("DROP TRIGGER reject_provision ON for_now.store_fields");

    await account("repo-test", () => repo.initialize({ allowCreate: true }));
    await account("repo-other", () => repo.initialize({ allowCreate: true }));
    await account("repo-test", async () => {
      await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? repo : peerRepo).update(value => {
        value.captures.push({ id: `parallel-${index}`, content: `并发 ${index}` });
      })));
      assert.equal((await repo.read()).captures.length, 12);
      const before = await repo.read();
      await assert.rejects(repo.update(value => {
        value.captures.push({ id: "rolled-back", content: "不保存" });
        throw new Error("abort mutation");
      }), /abort mutation/);
      assert.deepEqual(await repo.read(), before);
      await assert.rejects(repo.transact(async ({ document, commit }) => {
        document.captures.push({ id: "stale-version", content: "拒绝覆盖" });
        await database.query("UPDATE for_now.accounts SET revision = revision + 1 WHERE account_id = 'repo-test'");
        await commit();
      }), error => error.code === "VERSION_CONFLICT" && error.statusCode === 409);
      assert.deepEqual(await repo.read(), before);
      await assert.rejects(repo.transact(async ({ document, commit }) => {
        document.captures.push({ id: "first-commit", content: "第一段持久" });
        await commit();
        document.captures.push({ id: "second-uncommitted", content: "第二段失败" });
        throw new Error("after commit");
      }), /after commit/);
      assert.ok((await peerRepo.read()).captures.some(item => item.id === "first-commit"));
      assert.ok(!(await peerRepo.read()).captures.some(item => item.id === "second-uncommitted"));

      // Kill the connection after a read, before commit. It must not fall back to JSON.
      let entered, release;
      const ready = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const failed = repo.update(async value => {
        value.captures.push({ id: "disconnected", content: "不能写入" });
        entered();
        await gate;
      });
      const rejected = assert.rejects(failed);
      await ready;
      const pids = (await database.query(`
        SELECT DISTINCT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND a.datname = current_database()
          AND a.application_name = 'for-now-runtime'
      `)).rows;
      assert.equal(pids.length, 1);
      await database.query("SELECT pg_terminate_backend($1)", [pids[0].pid]);
      release();
      await rejected;
      assert.ok(!(await repo.read()).captures.some(item => item.id === "disconnected"));
      await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? runtime : peer).documents.update(
        "usage", { entries: [] }, value => value.entries.push({ id: `call-${i}`, scene: "test", model: "synthetic" })
      )));
      assert.equal((await runtime.documents.read("usage")).entries.length, 8);
    });
    assert.equal((await account("repo-other", () => repo.read())).captures.length, 0);
    const migration = await connect("migration_app", "runtime_test");
    const backup = await connect("runtime_backup", "runtime_test");
    await assert.rejects(backup.query("DELETE FROM for_now_auth.users"), error => error.code === "42501");
    await assert.rejects(applyPostgresMigration(migration, buildPostgresMigrationPlan({
      accountId: "repo-test", store: empty()
    })), /entered runtime/);

    let app = await startApp();
    await assert.rejects(startApp(), /Only one application instance/);
    assert.equal((await request(app.base, "/api/state")).status, 401);
    const register = username => request(app.base, "/api/auth/register", {
      method: "POST", body: { username, password: "runtime-password-1", invitation: "runtime-invite" }
    });
    const [registration, second] = await Promise.all([register("runtime-owner"), register("runtime-second")]);
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal((await register("runtime-owner")).status, 409);
    const cookie = registration.cookie, otherCookie = second.cookie, id = registration.body.user.id;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1EAAAAASUVORK5CYII=", "base64");
    const upload = await request(app.base, "/api/images/upload", {
      method: "POST", cookie, body: { image: `data:image/png;base64,${png.toString("base64")}` }
    });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    const attachmentPath = upload.body.attachmentPath;
    assert.equal((await fetch(`${app.base}${attachmentPath}`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${app.base}${attachmentPath}`, { headers: { cookie: otherCookie } })).status, 404);
    assert.equal((await database.query("SELECT state FROM for_now.attachment_inventory WHERE account_id = $1", [id])).rows[0].state, "verified");
    const writes = await Promise.all(Array.from({ length: 6 }, (_, index) => request(app.base, "/api/captures", {
      method: "POST", cookie, body: { content: `HTTP 持久记录 ${index}`, occurredAt: "2026-09-29T02:00:00.000Z" }
    })));
    assert.ok(writes.every(value => value.status === 201), JSON.stringify(writes));
    const state = await request(app.base, "/api/state", { cookie });
    assert.equal(state.body.captures.length, 6);
    assert.equal((await request(app.base, "/api/state", { cookie: otherCookie })).body.captures.length, 0);
    assert.equal((await request(app.base, "/api/settings", { cookie })).body.automaticAnswers.thoughtAnswer, false);
    const disabledChain = await request(app.base, "/api/thought-chains", {
      method: "POST", cookie,
      body: { question: "默认关闭自动回答", occurredAt: "2026-09-29T01:00:00.000Z", generateAnswer: true, clientRequestId: "postgres-disabled-chain" }
    });
    assert.equal(disabledChain.status, 201, JSON.stringify(disabledChain.body));
    assert.equal(disabledChain.body.task, null);
    assert.equal(providerCalls, 0);
    const settingsWrites = await Promise.all([
      request(app.base, "/api/settings", {
        method: "POST", cookie,
        body: { assistantName: "数据库测试", apiKey: "synthetic-test-key", automaticAnswers: { thoughtAnswer: true } }
      }),
      request(app.base, "/api/settings", { method: "POST", cookie, body: { responseStyles: { thoughtAnswer: "deep" } } })
    ]);
    assert.ok(settingsWrites.every(result => result.status === 200), JSON.stringify(settingsWrites));
    const updatedSettings = (await request(app.base, "/api/settings", { cookie })).body;
    assert.equal(updatedSettings.assistantName, "数据库测试");
    assert.equal(updatedSettings.automaticAnswers.thoughtAnswer, true);
    assert.equal(updatedSettings.responseStyles.thoughtAnswer, "deep");
    const costWrites = await Promise.all([
      request(app.base, "/api/ai-cost-plan", { method: "PATCH", cookie, body: { monthlyBudgetCny: 81 } }),
      request(app.base, "/api/ai-cost-plan", { method: "PATCH", cookie: otherCookie, body: { monthlyBudgetCny: 42 } })
    ]);
    assert.ok(costWrites.every(result => result.status === 200), JSON.stringify(costWrites));
    assert.equal((await request(app.base, "/api/ai-cost-plan", { cookie })).body.monthlyBudgetCny, 81);
    assert.equal((await request(app.base, "/api/ai-cost-plan", { cookie: otherCookie })).body.monthlyBudgetCny, 42);
    assert.equal((await request(app.base, "/api/settings", { cookie })).body.assistantName, "数据库测试");
    const chainBody = { question: "**数据库问题**", occurredAt: "2026-09-29T02:00:00.000Z", generateAnswer: true, clientRequestId: "postgres-chain" };
    const chainResponses = await Promise.all([0, 1].map(() => request(app.base, "/api/thought-chains", { method: "POST", cookie, body: chainBody })));
    assert.deepEqual(chainResponses.map(value => value.status).sort(), [200, 201]);
    const backgroundTask = chainResponses[0].body.task;
    assert.equal(backgroundTask.id, chainResponses[1].body.task.id);
    assert.equal((await waitTask(app.base, cookie, backgroundTask.id)).status, "succeeded");
    assert.equal(providerCalls, 1);
    assert.equal((await request(app.base, `/api/ai-tasks/${backgroundTask.id}`, { cookie: otherCookie })).status, 404);
    const resultState = await account(id, () => repo.read());
    const generatedAnswer = resultState.thoughts.find(item => item.sourceTaskId === backgroundTask.id);
    assert.equal(resultState.thoughts.filter(item => item.sourceTaskId === backgroundTask.id).length, 1);
    assert.equal(generatedAnswer.content, "数据库中的模型回答");
    assert.equal(generatedAnswer.reasoningContent, "隔离模型思考");
    assert.equal(resultState.notifications.find(item => item.taskId === backgroundTask.id).status, "succeeded");
    const annotation = await request(app.base, `/api/thoughts/${backgroundTask.targetId}/annotations`, {
      method: "POST", cookie, body: { kind: "comment", targetKey: `question:${backgroundTask.targetId}`, quote: "数据库问题", start: 0, end: 5, text: "跨领域批注" }
    });
    assert.equal(annotation.status, 201, JSON.stringify(annotation.body));
    const annotationTask = await request(app.base, `/api/annotations/thought/${backgroundTask.targetId}/${annotation.body.id}/shenji`, {
      method: "POST", cookie, body: { message: "核对", clientRequestId: "postgres-annotation" }
    });
    assert.equal(annotationTask.status, 202, JSON.stringify(annotationTask.body));
    assert.equal((await waitTask(app.base, cookie, annotationTask.body.id)).status, "succeeded");
    const annotatedRoot = (await account(id, () => repo.read())).thoughts.find(item => item.id === backgroundTask.targetId);
    assert.equal(annotatedRoot.annotations[0].shenji[0].sourceTaskId, annotationTask.body.id);
    assert.equal(providerCalls, 2);
    assert.equal((await request(app.base, "/api/notifications", { cookie })).body.unread, 2);
    assert.equal((await request(app.base, "/api/notifications", { cookie: otherCookie })).body.unread, 0);
    const notificationId = resultState.notifications[0].id;
    assert.equal((await request(app.base, `/api/notifications/${notificationId}/read`, { method: "PATCH", cookie: otherCookie })).status, 404);
    assert.equal((await request(app.base, "/api/notifications/read-all", { method: "POST", cookie, body: {} })).body.updated, 2);
    assert.equal((await request(app.base, "/api/notifications", { cookie })).body.unread, 0);
    const captureId = state.body.captures[0].id;
    assert.equal((await request(app.base, `/api/captures/${captureId}`, { method: "DELETE", cookie: otherCookie })).status, 404);
    assert.equal((await request(app.base, `/api/captures/${captureId}`, { method: "DELETE", cookie })).status, 200);
    const trash = await request(app.base, "/api/trash", { cookie });
    assert.equal(trash.body.items.length, 1);
    assert.equal((await request(app.base, `/api/trash/${trash.body.items[0].id}/restore`, { method: "POST", cookie, body: {} })).status, 200);
    assert.equal((await request(app.base, "/api/state", { cookie })).body.captures.find(item => item.id === captureId).version, state.body.captures[0].version + 1);
    const derivativePaths = {};
    for (const key of ["thumbPath", "displayPath", "editPath", "alphaMaskPath"]) {
      const derivativeUpload = await request(app.base, "/api/images/upload", {
        method: "POST", cookie, body: { image: `data:image/png;base64,${png.toString("base64")}` }
      });
      assert.equal(derivativeUpload.status, 201, JSON.stringify(derivativeUpload.body));
      derivativePaths[key] = derivativeUpload.body.attachmentPath;
    }
    assert.equal(new Set([attachmentPath, ...Object.values(derivativePaths)]).size, 5);
    const media = await request(app.base, "/api/keepsakes", {
      method: "POST", cookie,
      body: { title: "关系附件", category: "小物", originalPath: attachmentPath, cutoutPath: derivativePaths.displayPath, ...derivativePaths, occurredAt: "2026-09-29T02:00:00.000Z" }
    });
    assert.equal(media.status, 201, JSON.stringify(media.body));
    assert.equal(media.body.derivativeState, "ready");
    for (const [key, value] of Object.entries(derivativePaths)) assert.equal(media.body[key], value);
    assert.equal((await request(app.base, `/api/keepsakes/${media.body.id}`, { method: "PATCH", cookie: otherCookie, body: { title: "越权" } })).status, 404);
    const editedMedia = await request(app.base, `/api/keepsakes/${media.body.id}`, {
      method: "PATCH", cookie, body: { title: "关系附件已编辑", occurredOn: "2026-09-30" }
    });
    assert.equal(editedMedia.status, 200);
    assert.equal(editedMedia.body.createdAt, media.body.createdAt);
    assert.equal(editedMedia.body.occurredOn, "2026-09-30");
    assert.equal(editedMedia.body.originalPath, undefined);
    assert.equal((await request(app.base, `/api/keepsakes/${media.body.id}/original`, { cookie })).body.originalPath, attachmentPath);
    assert.equal((await account(id, () => repo.read())).keepsakes.find(item => item.id === media.body.id).originalPath, attachmentPath);
    assert.equal((await request(app.base, `/api/keepsakes/${media.body.id}`, { method: "DELETE", cookie })).status, 200);
    const plan = await request(app.base, "/api/trash/purge-preview", { method: "POST", cookie, body: {} });
    const purge = await request(app.base, "/api/trash/purge", { method: "POST", cookie, body: {
      ids: plan.body.items.map(item => item.id), planHash: plan.body.planHash, confirmation: "永久删除"
    } });
    assert.equal(purge.status, 200, JSON.stringify(purge.body));
    assert.equal(purge.body.attachmentCleanupPending, 0);
    assert.equal((await database.query("SELECT count(*)::int AS n FROM for_now.attachment_inventory WHERE account_id = $1", [id])).rows[0].n, 0);
    assert.equal((await fetch(`${app.base}${attachmentPath}`, { headers: { cookie } })).status, 404);

    // A binary deletion failure must leave a relational cleanup task and inventory.
    const retryUpload = await request(app.base, "/api/images/upload", {
      method: "POST", cookie, body: { image: `data:image/png;base64,${png.toString("base64")}` }
    });
    assert.equal(retryUpload.status, 201);
    const retryPath = retryUpload.body.attachmentPath;
    const retryMedia = await request(app.base, "/api/keepsakes", {
      method: "POST", cookie, body: { title: "清理重试", originalPath: retryPath, cutoutPath: retryPath }
    });
    assert.equal(retryMedia.status, 201);
    await request(app.base, `/api/keepsakes/${retryMedia.body.id}`, { method: "DELETE", cookie });
    const retryFile = path.join(dataDir, "users", id, "attachments", path.basename(retryPath));
    await fs.unlink(retryFile);
    await fs.mkdir(retryFile);
    const retryPlan = await request(app.base, "/api/trash/purge-preview", { method: "POST", cookie, body: {} });
    const deferred = await request(app.base, "/api/trash/purge", { method: "POST", cookie, body: {
      ids: retryPlan.body.items.map(item => item.id), planHash: retryPlan.body.planHash, confirmation: "永久删除"
    } });
    assert.equal(deferred.status, 200, JSON.stringify(deferred.body));
    assert.equal(deferred.body.attachmentCleanupPending, 1);
    assert.equal((await account(id, () => repo.read())).attachmentCleanup[0].path, retryPath);
    assert.equal((await database.query("SELECT count(*)::int AS n FROM for_now.attachment_inventory WHERE account_id = $1", [id])).rows[0].n, 1);
    assert.equal((await request(app.base, "/api/trash", { cookie })).body.items.length, 0);
    assert.equal((await account(second.body.user.id, () => repo.read())).attachmentCleanup.length, 0);

    // Check runtime state across process death, including the original session.
    await stop(app.child);
    await fs.rmdir(retryFile);
    await fs.writeFile(retryFile, png, { mode: 0o600 });
    // Simulate termination before binary write and before upload confirmation.
    await account(id, async () => {
      await runtime.documents.update("settings", {}, value => {
        value.futureExtension = { nested: ["保留"] };
        value.profiles.lite.futureProfile = { marker: true };
      });
      await repo.update(value => {
        value.onboarding.futureOnboarding = { retained: true };
        const completed = value.aiTasks.find(item => item.id === backgroundTask.id);
        for (const status of ["queued", "running"]) value.aiTasks.push({
          ...completed, id: `restart-${status}`, clientRequestId: `restart-${status}`, status,
          resultId: "", completedAt: "", startedAt: "", attempt: 0
        });
      });
      for (const name of ["interrupted-present.png", "interrupted-missing.png"]) {
        await runtime.attachments.record({
          path: `/attachments/${name}`, storage: "local", objectKey: name, bytes: png.length,
          sha256: crypto.createHash("sha256").update(png).digest("hex")
        });
      }
    });
    await fs.writeFile(path.join(dataDir, "users", id, "attachments/interrupted-present.png"), png, { mode: 0o600 });
    app = await startApp();
    assert.equal((await waitTask(app.base, cookie, "restart-queued")).status, "succeeded");
    const interruptedTask = await waitTask(app.base, cookie, "restart-running");
    assert.equal(interruptedTask.status, "failed");
    assert.match(interruptedTask.error, /避免重复计费/);
    assert.equal(providerCalls, 3, "Restart must only replay queued tasks");
    const inventory = (await database.query("SELECT path,state FROM for_now.attachment_inventory WHERE account_id = $1", [id])).rows;
    assert.deepEqual(inventory, [{ path: "/attachments/interrupted-present.png", state: "verified" }]);
    assert.deepEqual((await account(id, () => repo.read())).attachmentCleanup, []);
    assert.equal((await fetch(`${app.base}${retryPath}`, { headers: { cookie } })).status, 404);
    await account(id, async () => {
      const settings = await runtime.documents.read("settings");
      assert.deepEqual(settings.futureExtension, { nested: ["保留"] });
      assert.deepEqual(settings.profiles.lite.futureProfile, { marker: true });
      assert.deepEqual((await repo.read()).onboarding.futureOnboarding, { retained: true });
    });
    assert.equal((await request(app.base, "/api/state", { cookie })).body.captures.length, 6);
    const restartedSettings = (await request(app.base, "/api/settings", { cookie })).body;
    assert.equal(restartedSettings.assistantName, "数据库测试");
    assert.equal(restartedSettings.automaticAnswers.thoughtAnswer, true);
    assert.equal(restartedSettings.responseStyles.thoughtAnswer, "deep");
    assert.equal((await request(app.base, "/api/ai-cost-plan", { cookie })).body.monthlyBudgetCny, 81);
    const adminSnapshot = await request(app.base, "/api/admin/v1/snapshot", {
      headers: { authorization: `Bearer ${platformToken}` }
    });
    assert.equal(adminSnapshot.status, 200, JSON.stringify(adminSnapshot.body));
    assert.equal(adminSnapshot.body.meta.source, "live-aggregate");
    assert.equal(adminSnapshot.body.users.length, 2);
    assert.ok(adminSnapshot.body.users.find(item => item.id === id).records >= 6);
    assert.doesNotMatch(JSON.stringify(adminSnapshot.body), /数据库中的模型回答|runtime-password-1|synthetic-test-key/);
    const files = await fs.readdir(dataDir, { recursive: true });
    assert.equal(files.filter(name => /(?:store|auth|llm-settings|ai-usage|ai-cost-plan)\.json$/.test(name)).length, 0);
    await assert.rejects(startApp("runtime_test", dataDir, "json"), /switched persistence backend/);

    // Export runtime mutations using a consistent relational snapshot; boot it
    // in an independently created database using the same session and contents.
    const restoredDir = path.join(temporary, "runtime-restored");
    const exportOptions = {
      outputDir: restoredDir,
      readAttachment: ({ accountId, item }) => fs.readFile(path.join(dataDir, "users", accountId, "attachments", path.basename(item.path)))
    };
    await assert.rejects(exportPostgresDirectory(backup, exportOptions), /Stop the application/);
    await stop(app.child);
    await backup.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    let expectedRelational;
    try {
      expectedRelational = await readPostgresBundle(backup, [id, second.body.user.id]);
    } finally {
      await backup.query("ROLLBACK");
    }
    await exportPostgresDirectory(backup, exportOptions);
    assert.equal((await fs.stat(path.join(restoredDir, "auth.json"))).mode & 0o777, 0o600);
    await database.query("CREATE DATABASE runtime_restored");
    const restoredAdmin = await connect("postgres", "runtime_restored");
    await initializePostgresSchema(restoredAdmin);
    await restoredAdmin.query(`
      GRANT USAGE ON SCHEMA for_now TO runtime_data, migration_app;
      GRANT USAGE ON SCHEMA for_now_auth TO runtime_auth, migration_app;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA for_now TO runtime_data, migration_app;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA for_now_auth TO runtime_auth, migration_app;
      GRANT EXECUTE ON FUNCTION for_now_auth.provision_account(text,jsonb,jsonb) TO runtime_auth;
    `);
    const restoredMigration = await connect("migration_app", "runtime_restored");
    const bundle = await discoverJsonBundle(restoredDir);
    await applyPostgresBundle(restoredMigration, bundle);
    await restoredMigration.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      assert.equal(
        canonicalJson(await readPostgresBundle(restoredMigration, [id, second.body.user.id])),
        canonicalJson(expectedRelational)
      );
    } finally {
      await restoredMigration.query("ROLLBACK");
    }
    const restoredApp = await startApp("runtime_restored", restoredDir);
    assert.equal((await request(restoredApp.base, "/api/state", { cookie })).body.captures.length, 6);
    assert.equal((await request(restoredApp.base, "/api/auth/me", { cookie })).body.user.id, id);
    assert.equal((await request(restoredApp.base, "/api/ai-cost-plan", { cookie })).body.monthlyBudgetCny, 81);
    assert.equal((await request(restoredApp.base, "/api/ai-cost-plan", { cookie: otherCookie })).body.monthlyBudgetCny, 42);
    const restoredAttachment = await fetch(`${restoredApp.base}/attachments/interrupted-present.png`, { headers: { cookie } });
    assert.equal(restoredAttachment.status, 200);
    assert.deepEqual(Buffer.from(await restoredAttachment.arrayBuffer()), png);
    assert.equal((await fetch(`${restoredApp.base}/attachments/interrupted-present.png`, { headers: { cookie: otherCookie } })).status, 404);
    assert.equal((await request(restoredApp.base, "/api/ai-tasks/restart-queued", { cookie })).body.status, "succeeded");
    assert.equal((await request(restoredApp.base, "/api/ai-tasks/restart-running", { cookie })).body.status, "failed");
    assert.equal(providerCalls, 3);
    await assert.rejects(applyPostgresBundle(restoredMigration, bundle), /entered runtime/);
    return ["runtime role validation", "atomic registration rollback", "cross-connection serialized writes",
      "multi-commit durability", "runtime disconnect rollback", "concurrent usage updates", "HTTP auth and account isolation",
      "settings patch serialization", "cost plan account isolation and restore", "atomic background task and notification writes", "annotation model dialogue", "task restart without double billing",
      "normalization preserves extensions", "versioned trash restore", "attachment upload/purge/crash recovery", "durable cleanup failure and restart", "PostgreSQL admin snapshot privacy", "single application guard",
      "process restart and sessions", "PostgreSQL-only writes",
      "JSON rollback guard", "runtime export and independent database boot with attachment bytes", "live migration overwrite guard"];
  } finally {
    await Promise.all([...children].map(stop));
    await new Promise(resolve => provider.close(resolve));
    await Promise.all([runtime.close(), peer.close()]);
  }
}
