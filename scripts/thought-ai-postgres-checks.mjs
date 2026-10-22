/**
 * 前台回答与图片/批注 AI 写回的 PostgreSQL 生产者矩阵。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：隔离合成账户，mock 生成；正式写回禁止文档 updater。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createThoughtWorkflows } from "../src/app/index.mjs";

const accountId = "thought-producer-test";
const timestamp = "2026-10-19T00:00:00.000Z";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const paths = ["/attachments/producer-first.png"];

async function snapshot(database) {
  const state = {};
  for (const table of ["accounts", "store_fields", "store_objects", "store_relations",
    "store_attachment_refs", "resource_lifecycle", "thought_chain_index", "thought_tag_counts",
    "record_changes", "account_sync_heads", "idempotency_ledger"]) {
    state[table] = (await database.query(`SELECT to_jsonb(row) AS value FROM for_now.${table} row
      WHERE account_id=$1 ORDER BY to_jsonb(row)::text`, [accountId])).rows;
  }
  return state;
}

async function failure(database, commandId, invoke) {
  const before = await snapshot(database);
  await database.query(`ALTER TABLE for_now.record_changes ADD CONSTRAINT injected_content_ai_failure
    CHECK(command_id <> '${commandId}') NOT VALID`);
  try {
    await assert.rejects(invoke(), /injected_content_ai_failure/);
    assert.deepEqual(await snapshot(database), before, commandId);
  } finally {
    await database.query("ALTER TABLE for_now.record_changes DROP CONSTRAINT injected_content_ai_failure");
  }
}

async function createTask(repo, input) {
  const task = {
    id: crypto.randomUUID(), status: "running", internal: false, inputHash: "",
    clientRequestId: crypto.randomUUID(), createdAt: timestamp, updatedAt: timestamp,
    inputVersion: 1, subtargetVersion: 0, payload: {}, ...input
  };
  await repo.update(store => {
    store.aiTasks.push(task);
    store.notifications.push({
      id: crypto.randomUUID(), taskId: task.id, kind: "aiTask", status: "running",
      createdAt: timestamp, updatedAt: timestamp
    });
  });
  return task;
}

async function writebackMatrix(context, service, input) {
  const { repo, database, queries } = context;
  const task = await createTask(repo, input);
  const currentRevision = () => repo.accountUnitOfWork.readRevision();
  const write = async () => service.contentAi.writeback({
    taskId: task.id, result: { content: "事务 AI 结果", reasoningContent: "生成推理" },
    contextFingerprint: task.kind === "annotationShenji" ? "verified-context" : "",
    expectedRevision: await currentRevision()
  });
  await failure(database, "content.aiWriteback", write);
  await failure(database, "content.aiWriteback.failure", () => service.contentAi.failWriteback(
    task.id, { code: "AI_TASK_FAILED", message: "供应商失败" }
  ));
  const revision = await currentRevision();
  await repo.update(store => {
    store.thoughts.find(item => item.id === "attachment-other").probe = crypto.randomUUID();
  });
  const beforeStale = await snapshot(database);
  await assert.rejects(service.contentAi.writeback({
    taskId: task.id, result: { content: "过期回答" }, expectedRevision: revision
  }), { code: "VERSION_CONFLICT" });
  assert.deepEqual(await snapshot(database), beforeStale);
  assert.equal((await write()).status, "succeeded");
  const stored = await repo.read();
  const completed = stored.aiTasks.find(item => item.id === task.id);
  assert.equal(stored.notifications.find(item => item.taskId === task.id).status, "succeeded");
  assert.ok(completed.resultId);
  const changes = (await database.query(`SELECT entity_type, parent_type, parent_id, cursor
    FROM for_now.record_changes WHERE account_id=$1 AND command_id='content.aiWriteback'
    AND cursor=(SELECT max(cursor) FROM for_now.record_changes WHERE account_id=$1)`, [accountId])).rows;
  assert.equal(new Set(changes.map(row => row.cursor)).size, 1);
  assert.ok(changes.some(row => row.entity_type === "aiTask"));
  assert.ok(changes.some(row => row.entity_type === "notification"));
  if (input.kind === "annotationShenji") {
    const root = stored.thoughts.find(item => item.id === input.targetId);
    const exchange = root.annotations.find(item => item.id === input.subtargetId).shenji.at(-1);
    assert.equal(exchange.id, completed.resultId);
    assert.equal(exchange.sourceTaskId, task.id);
    assert.ok(changes.some(row => row.parent_id === input.subtargetId));
  }
  const beforeReplay = await snapshot(database);
  assert.equal(await write(), null);
  assert.deepEqual(await snapshot(database), beforeReplay);
  const failedTask = await createTask(repo, { ...input, status: "running" });
  assert.equal((await service.contentAi.failWriteback(failedTask.id, {
    code: "AI_TASK_FAILED", message: "供应商失败"
  })).status, "failed");
  const cancelled = await createTask(repo, { ...input, status: "cancelling" });
  assert.equal((await service.contentAi.writeback({
    taskId: cancelled.id, result: { content: "不得保存" }, expectedRevision: await currentRevision()
  })).status, "cancelled");
  if (input.resourceType === "thought") {
    const detail = await queries.detail(input.payload?.targetType === "thoughtBlock"
      ? "ai-image-root" : input.targetId);
    assert.ok(detail);
    assert.equal((await queries.list({ query: "事务 AI 结果" })).items.length, 0,
      "AI 图片与批注回复不得变成原始全文检索正文");
  }
}

async function foregroundMatrix(context, service) {
  const { repo, database, queries } = context;
  const created = await service.rootCommands.create({
    questionText: "前台回答问题", tags: [],
    eventTime: { occurredAt: timestamp, occurredOn: "2026-10-19" },
    clientRequestId: "foreground-root", requestHash: "foreground-root"
  });
  const id = created.items.find(item => item.type === "question").id;
  let generated = 0;
  let changeDuringGeneration = false;
  const workflows = createThoughtWorkflows({
    repository: {
      ...service.producerRepository,
      read: () => repo.read(),
      update: () => { throw new Error("Foreground answer must not update the account document"); }
    },
    thoughts: service.thoughtService,
    backgroundAi: { enqueue: () => null },
    removeChain: () => null, removeBlock: () => null,
    generate: async () => {
      generated += 1;
      if (changeDuringGeneration) await repo.update(store => {
        const root = store.thoughts.find(item => item.id === id);
        root.content = "生成期间更新问题";
        root.version += 1;
      });
      return { content: JSON.stringify({ answer: "前台事务回答词", references: [], citations: [] }),
        reasoningContent: "前台推理" };
    },
    hash, getAccountId: () => accountId, contextKey: () => accountId,
    now: () => timestamp,
    recordCommands: { enabled: name => name === "thought.aiWriteback", thoughts: service.rootCommands }
  });
  const input = { id, clientRequestId: "foreground-answer" };
  await failure(database, "thought.foregroundAnswer", () => workflows.answerRoot(input));
  const answer = await workflows.answerRoot(input);
  assert.equal(answer.content, "前台事务回答词");
  assert.equal((await queries.list({ query: "前台事务回答词" })).items[0].id, id);
  const callsBeforeReplay = generated;
  const beforeReplay = await snapshot(database);
  assert.equal((await workflows.answerRoot(input)).id, answer.id);
  assert.equal(generated, callsBeforeReplay);
  assert.deepEqual(await snapshot(database), beforeReplay);
  changeDuringGeneration = true;
  const beforeStale = await database.query(`SELECT count(*)::int AS count FROM for_now.store_objects
    WHERE account_id=$1 AND collection='thoughts' AND kind='answer'`, [accountId]);
  await assert.rejects(workflows.answerRoot({ id, clientRequestId: "foreground-stale" }), {
    code: "STALE_PERSONAL_CONTEXT"
  });
  assert.deepEqual((await database.query(`SELECT count(*)::int AS count FROM for_now.store_objects
    WHERE account_id=$1 AND collection='thoughts' AND kind='answer'`, [accountId])).rows, beforeStale.rows);
}

/** 按实际目标类型覆盖成功、提交故障、重放、修订竞态及取消。 @since unreleased */
export async function runThoughtAiPostgresChecks(context, service) {
  const fixtures = [
    ["thoughtRoot", "ai-image-root", "thought", "ai-image-root", ""],
    ["thoughtBlock", "ai-image-block", "thought", "ai-image-block", ""],
    ["capture", "ai-image-capture", "capture", "ai-image-capture", ""],
    ["comment", "ai-image-comment", "thought", "ai-image-root", "ai-image-comment"]
  ];
  await context.repo.update(store => {
    const root = {
      id: "ai-image-root", type: "question", content: "AI 图片原文", version: 1,
      attachmentPaths: paths, createdAt: timestamp, occurredAt: timestamp,
      annotations: [{ id: "ai-image-comment", kind: "comment", text: "AI 批注原文",
        quote: "AI", targetKey: "question:ai-image-root", start: 0, end: 2, version: 1,
        attachmentPaths: paths, createdAt: timestamp }]
    };
    store.thoughts.push(root, {
      id: "ai-image-block", type: "record", relatedTo: root.id, content: "AI 图片块",
      version: 1, attachmentPaths: paths, createdAt: timestamp
    });
    store.captures.push({
      id: "ai-image-capture", content: "AI 图片捕念", version: 1,
      attachmentPaths: paths, createdAt: timestamp
    });
  });
  for (const [targetType, targetId, resourceType, taskTargetId, subtargetId] of fixtures) {
    const owner = targetType === "comment" ? { collection: "thoughts", id: taskTargetId } : null;
    const prepared = await service.attachments.prepareUnderstanding({
      targetType, targetId, attachmentPaths: paths, owner
    });
    assert.ok(prepared.value);
    await writebackMatrix(context, service, {
      kind: "contentImageUnderstanding", resourceType, targetId: taskTargetId, subtargetId,
      inputVersion: prepared.value.inputVersion,
      payload: { targetType, targetId, attachmentPaths: paths, ...(owner ? { owner } : {}) }
    });
  }
  const store = await context.repo.read();
  const root = store.thoughts.find(item => item.id === "ai-image-root");
  await writebackMatrix(context, service, {
    kind: "annotationShenji", resourceType: "thought", targetId: root.id,
    subtargetId: "ai-image-comment", inputVersion: root.version,
    subtargetVersion: root.annotations[0].version, payload: { message: "AI 批注追问" }
  });
  await foregroundMatrix(context, service);
  console.log("Content AI PostgreSQL passed: four image targets and thought annotation, terminal failures atomic, revision conflicts, replay/cancellation; foreground answer atomic with idempotent replay and stale-context rejection.");
}

/** 正式 HTTP 在开启记录命令的重启应用上验证生成结果与账户隔离。 @since unreleased */
export async function runThoughtAiHttpChecks({ base, request, cookie, otherCookie, waitTask, attachmentPath }) {
  const created = await request(base, "/api/thought-chains", {
    cookie, method: "POST", body: { question: "HTTP AI 闭包问题", clientRequestId: "http-ai-root" }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.items.find(item => item.type === "question").id;
  const answerRoute = `/api/thoughts/${id}/answer`;
  const input = { clientRequestId: "http-ai-foreground" };
  assert.equal((await request(base, answerRoute, { cookie: otherCookie, method: "POST", body: input })).status, 404);
  const answer = await request(base, answerRoute, { cookie, method: "POST", body: input });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(answer.body.content, "数据库中的模型回答");
  const replay = await request(base, answerRoute, { cookie, method: "POST", body: input });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.id, answer.body.id);
  const annotation = await request(base, `/api/thoughts/${id}/annotations`, {
    cookie, method: "POST", body: { quote: "HTTP", start: 0, end: 4,
      targetKey: `question:${id}`, kind: "comment", text: "HTTP AI 批注" }
  });
  assert.equal(annotation.status, 201, JSON.stringify(annotation.body));
  const shenjiRoute = `/api/annotations/thought/${id}/${annotation.body.id}/shenji`;
  assert.equal((await request(base, shenjiRoute, {
    cookie: otherCookie, method: "POST", body: { message: "核对", clientRequestId: "http-ai-annotation" }
  })).status, 404);
  const shenji = await request(base, shenjiRoute, {
    cookie, method: "POST", body: { message: "核对", clientRequestId: "http-ai-annotation" }
  });
  assert.equal(shenji.status, 202, JSON.stringify(shenji.body));
  assert.equal((await waitTask(base, cookie, shenji.body.id)).status, "succeeded");
  const imageRoute = `/api/v1/content-attachments/thoughtRoot/${id}`;
  const initial = await request(base, imageRoute, { cookie });
  const replaced = await request(base, imageRoute, {
    cookie, method: "PUT", headers: { "if-match": `"${initial.body.data.version}"` },
    body: { attachmentPaths: [attachmentPath] }
  });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const understandingInput = {
    targetType: "thoughtRoot", targetId: id, inputVersion: replaced.body.data.version,
    attachmentPaths: [attachmentPath]
  };
  const understandingOptions = {
    method: "POST", headers: { "idempotency-key": "http-ai-image" }, body: understandingInput
  };
  assert.equal((await request(base, "/api/v1/content-attachments/understandings", {
    ...understandingOptions, cookie: otherCookie
  })).status, 404);
  const understanding = await request(base, "/api/v1/content-attachments/understandings", {
    ...understandingOptions, cookie
  });
  assert.equal(understanding.status, 202, JSON.stringify(understanding.body));
  assert.equal((await waitTask(base, cookie, understanding.body.data.id)).status, "succeeded");
  const original = await request(base, imageRoute, { cookie });
  assert.equal(original.body.data.imageUnderstandings.length, 1);
  assert.equal(original.body.data.imageUnderstandings[0].sourceTaskId, understanding.body.data.id);
  assert.equal((await request(base, "/api/settings", {
    cookie, method: "POST", body: { automaticAnswers: { thoughtAnswer: true } }
  })).status, 200);
  const automatic = await request(base, "/api/thought-chains", {
    cookie, method: "POST", body: {
      question: "HTTP 后台回答闭包", generateAnswer: true, clientRequestId: "http-ai-background"
    }
  });
  assert.equal(automatic.status, 201, JSON.stringify(automatic.body));
  assert.equal((await waitTask(base, cookie, automatic.body.task.id)).status, "succeeded");
  const followUp = await request(base, `/api/thoughts/${id}/follow-ups`, {
    cookie, method: "POST", body: { question: "HTTP 后台追问", answer: "" }
  });
  assert.equal(followUp.status, 201);
  const followUpTask = await request(base, `/api/thoughts/${id}/follow-ups/${followUp.body.id}/answer`, {
    cookie, method: "POST", body: { clientRequestId: "http-ai-followup" }
  });
  assert.equal(followUpTask.status, 202, JSON.stringify(followUpTask.body));
  assert.equal((await waitTask(base, cookie, followUpTask.body.id)).status, "succeeded");
  console.log("Content AI HTTP passed: foreground replay, annotation and image tasks through formal runtime, cross-account denial, original image result persisted.");
}
