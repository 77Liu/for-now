/**
 * 思绪局部生产者的真实 PostgreSQL 成功、冲突与故障回滚验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：仅隔离合成账户；正式领域服务禁止调用文档 read/update。
 */
import assert from "node:assert/strict";
import type { AccountUnitOfWork } from "../src/shared/persistence/account-unit-of-work.mjs";
import type { RecordStore } from "../src/shared/persistence/record-command-types.mjs";
import type { LocalThoughtInput, LocalThoughtResult } from "../src/modules/thoughts/local-mutations.mjs";
import type { ThoughtLocalCommands } from "../src/modules/thoughts/local-commands.mjs";
import type { SqlClient } from "../src/modules/thoughts/query-contracts.mjs";
import type { createThoughtRecordCommands } from "../src/modules/thoughts/record-commands.mjs";
import type { ThoughtNestedDeleteInput } from "../src/modules/thoughts/trash-commands.mjs";

type Repository = {
  initialize(options: { allowCreate: boolean }): Promise<void>;
  read(): Promise<RecordStore>;
  update<T>(operation: (store: RecordStore) => T): Promise<T>;
  accountUnitOfWork: AccountUnitOfWork;
};
type Queries = {
  rebuild(): Promise<unknown>;
  list(input: { query?: string; tag?: string }): Promise<{ items: { id: string }[] }>;
  detail(id: string): Promise<Record<string, unknown> | null>;
};
type AnnotationCommands = {
  create(type: string, id: string, input: Record<string, unknown>, options?: { clientRequestId: string }): Promise<LocalThoughtResult>;
  reply(type: string, id: string, annotationId: string, input: { text: string }): Promise<LocalThoughtResult>;
  convert(type: string, id: string, annotationId: string, input: { kind: string; text?: string }): Promise<LocalThoughtResult>;
  remove(type: string, id: string, annotationId: string, drift?: boolean): Promise<LocalThoughtResult>;
};
type Context = {
  database: SqlClient;
  repo: Repository;
  account<T>(id: string, operation: () => Promise<T>): Promise<T>;
  createQueries(repo: Repository): Queries;
  createService(repo: Repository, queries: Queries): ThoughtLocalCommands & {
    scheduledTaskIds: string[];
    cancelledTaskIds: string[];
    annotationCommands: AnnotationCommands;
    rootCommands: ReturnType<typeof createThoughtRecordCommands>;
    trashCommands: {
      removeThoughtBlock(id: string): Promise<Record<string, unknown> | null>;
      removeThoughtNested(input: ThoughtNestedDeleteInput): Promise<Record<string, unknown> | null>;
      restore(id: string): Promise<Record<string, unknown>>;
    };
    attachments: unknown;
  };
  attachmentFixtures(root: (id: string) => RecordStore["thoughts"][number]): RecordStore["thoughts"];
  attachmentChecks(input: Record<string, unknown>): Promise<void>;
  aiChecks(context: Record<string, unknown>, service: unknown): Promise<void>;
};
const accountId = "thought-producer-test";
const rootId = "producer-root";
const timestamp = "2026-10-19T00:00:00.000Z";
const root = (id: string) => ({
  id,
  type: "question",
  content: "局部生产者问题",
  version: 1,
  createdAt: timestamp,
  occurredAt: timestamp,
  occurredOn: "2026-10-19",
  tags: ["基线标签"],
  remarks: [],
  followUps: [],
  annotations: [],
  annotationDrift: [],
  disposition: "kept"
});

async function snapshot(database: SqlClient) {
  const tables = [
    "store_objects", "store_relations", "store_attachment_refs", "resource_lifecycle",
    "thought_chain_index", "thought_tag_counts", "record_changes", "account_sync_heads",
    "idempotency_ledger"
  ];
  const state: Record<string, unknown> = {};
  for (const table of tables) {
    const result = await database.query(`SELECT to_jsonb(row) AS value
      FROM for_now.${table} row WHERE account_id=$1 ORDER BY to_jsonb(row)::text`, [accountId]);
    state[table] = result.rows;
  }
  return state;
}

async function failureCase(context: Context, commandId: string, invoke: () => Promise<unknown>) {
  const before = await snapshot(context.database);
  await context.database.query(`ALTER TABLE for_now.record_changes
    ADD CONSTRAINT injected_local_producer_failure CHECK(command_id <> '${commandId}') NOT VALID`);
  try {
    await assert.rejects(invoke(), /injected_local_producer_failure/);
    assert.deepEqual(await snapshot(context.database), before, `${commandId} must roll back all derived state`);
  } finally {
    await context.database.query("ALTER TABLE for_now.record_changes DROP CONSTRAINT injected_local_producer_failure");
  }
}

/** 在正式服务上逐入口验证有界事务，故障发生于投影完成后的 ChangeDraft 入库。 @since unreleased */
export async function runThoughtProducerPostgresChecks(context: Context) {
  const { repo, database } = context;
  await context.account(accountId, async () => {
    await repo.initialize({ allowCreate: true });
    await repo.update(store => {
      store.thoughts = [
        root(rootId), ...context.attachmentFixtures(root),
        ...Array.from({ length: 1000 }, (_, index) => root(`unrelated-${index}`))
      ];
      store.captures = [{
        id: "attachment-capture", content: "图片捕念", attachmentPaths: [], version: 1,
        createdAt: timestamp, occurredAt: timestamp, occurredOn: "2026-10-19"
      }];
    });
    const queries = context.createQueries(repo);
    await queries.rebuild();
    const transactions: { reads: number; writes: number; commandId: string }[] = [];
    const run: AccountUnitOfWork["run"] = async (options, operation) => {
      const result = await repo.accountUnitOfWork.run(options, operation);
      transactions.push({ reads: result.reads, writes: result.writes, commandId: options.commandId });
      return result;
    };
    const boundedRepository = {
      ...repo,
      read: async () => { throw new Error("Local producer must not read the account document"); },
      update: async () => { throw new Error("Local producer must not update the account document"); },
      accountUnitOfWork: {
        ...repo.accountUnitOfWork,
        run
      }
    };
    const service = context.createService(boundedRepository, queries);
    const beforeOthers = (await database.query(`SELECT object_key, version, payload FROM for_now.store_objects
      WHERE account_id=$1 AND id LIKE 'unrelated-%' ORDER BY object_key`, [accountId])).rows;
    const blockInput: LocalThoughtInput = {
      relatedTo: rootId,
      type: "idea",
      content: "内容块新增词",
      tags: ["内容块标签"],
      eventTime: { occurredAt: "2026-10-18T04:00:00.000Z", occurredOn: "2026-10-18" },
      clientRequestId: "producer-create-block"
    };
    const block = await service.createBlock(blockInput);
    assert.ok(block.value);
    assert.equal((await queries.list({ query: "内容块新增词" })).items[0]?.id, rootId);
    assert.equal((await queries.list({ tag: "内容块标签" })).items[0]?.id, rootId);
    const replay = await service.createBlock(blockInput);
    assert.equal(replay.value?.id, block.value.id);
    assert.equal(replay.duplicate, true);
    await assert.rejects(service.createBlock({ ...blockInput, content: "重用标识冲突" }), { code: "IDEMPOTENCY_KEY_REUSED" });
    await failureCase(context, "thought.block.create", () => service.createBlock({
      ...blockInput, clientRequestId: "producer-failed-block"
    }));
    const blockId = block.value.id;
    const blockSourceKey = JSON.stringify(["thought", blockId, rootId, `idea:${blockId}`]);
    const permissionRow = (await database.query(`SELECT payload FROM for_now.store_objects
      WHERE account_id=$1 AND collection='evidencePermissions' AND id=$2`, [accountId, blockSourceKey])).rows[0];
    assert.equal((permissionRow?.payload as { learningAllowed: boolean })?.learningAllowed, false);
    await repo.update(store => {
      const permission = store.evidencePermissions.find(item => item.sourceKey === blockSourceKey);
      assert.ok(permission);
      permission.learningAllowed = true;
      permission.revision = Number(permission.revision) + 1;
      store.recordCompressions = [{
        id: "affected-summary", localDate: "2026-10-19", timezone: "Asia/Shanghai", status: "ready", version: 1
      }, {
        id: "unaffected-summary", localDate: "2026-10-17", timezone: "Asia/Shanghai", status: "ready", version: 1
      }, {
        id: "affected-evening-slot", localDate: "2026-10-18", timezone: "Asia/Shanghai", status: "ready", version: 1,
        windowKey: "record-compression-window.v2:2026-10-18:evening"
      }, {
        id: "unaffected-morning-slot", localDate: "2026-10-18", timezone: "Asia/Shanghai", status: "ready", version: 1,
        windowKey: "record-compression-window.v2:2026-10-18:morning"
      }];
    });
    await service.updateBlock({ id: blockId, content: "内容块修改词", eventTimeInput: {}, expectedVersion: 1 });
    const sideEffects = (await database.query(`SELECT collection, id, status, payload FROM for_now.store_objects
      WHERE account_id=$1 AND collection IN ('aiTasks', 'recordCompressions') ORDER BY id`, [accountId])).rows;
    assert.equal(sideEffects.find(row => row.id === "affected-summary")?.status, "invalidated");
    assert.equal(sideEffects.find(row => row.id === "unaffected-summary")?.status, "ready");
    assert.equal(sideEffects.find(row => row.id === "affected-evening-slot")?.status, "invalidated");
    assert.equal(sideEffects.find(row => row.id === "unaffected-morning-slot")?.status, "ready");
    const extraction = sideEffects.find(row => row.collection === "aiTasks");
    assert.equal((extraction?.payload as { kind: string })?.kind, "perceptionExtraction");
    assert.deepEqual(service.scheduledTaskIds, [extraction?.id]);
    assert.equal((await queries.list({ query: "内容块新增词" })).items.length, 0);
    assert.equal((await queries.list({ query: "内容块修改词" })).items[0]?.id, rootId);
    const conflictSnapshot = await snapshot(database);
    assert.equal((await service.updateBlock({
      id: blockId, content: "旧版本覆盖", eventTimeInput: {}, expectedVersion: 1
    })).conflict, true);
    assert.deepEqual(await snapshot(database), conflictSnapshot);
    const scheduledBeforeFailure = [...service.scheduledTaskIds];
    await failureCase(context, "thought.block.update", () => service.updateBlock({
      id: blockId, content: "失败更新词", eventTimeInput: {}
    }));
    assert.deepEqual(service.scheduledTaskIds, scheduledBeforeFailure);
    await service.setDisposition({ id: rootId, disposition: "pending" });
    await failureCase(context, "thought.disposition", () => service.setDisposition({ id: rootId, disposition: "discarded" }));
    const remark = await service.addRemark({ id: rootId, text: "备注新增词" });
    assert.ok(remark.value);
    assert.equal((await queries.list({ query: "备注新增词" })).items[0]?.id, rootId);
    await failureCase(context, "thought.remark.create", () => service.addRemark({ id: rootId, text: "失败备注" }));
    await service.updateRemark({ id: rootId, remarkId: remark.value.id, text: "备注修改词" });
    assert.equal((await queries.list({ query: "备注新增词" })).items.length, 0);
    assert.equal((await queries.list({ query: "备注修改词" })).items[0]?.id, rootId);
    await failureCase(context, "thought.remark.update", () => service.updateRemark({
      id: rootId, remarkId: remark.value!.id, text: "失败改备注"
    }));
    const followUp = await service.addFollowUp({ id: rootId, question: "追问新增词", answer: "", clientRequestId: "follow-up-one" });
    assert.ok(followUp.value);
    assert.equal((await queries.list({ query: "追问新增词" })).items[0]?.id, rootId);
    const beforeReplay = await snapshot(database);
    assert.equal((await service.addFollowUp({
      id: rootId, question: "追问新增词", answer: "", clientRequestId: "follow-up-one"
    })).duplicate, true);
    assert.deepEqual(await snapshot(database), beforeReplay);
    await failureCase(context, "thought.followUp.create", () => service.addFollowUp({
      id: rootId, question: "失败追问", answer: ""
    }));
    await service.updateFollowUp({
      id: rootId, followUpId: followUp.value.id, hasQuestion: true, question: "追问修改词",
      hasAnswer: true, answer: "追问回答词", expectedVersion: 1
    });
    assert.equal((await queries.list({ query: "追问新增词" })).items.length, 0);
    assert.equal((await queries.list({ query: "追问回答词" })).items[0]?.id, rootId);
    await failureCase(context, "thought.followUp.update", () => service.updateFollowUp({
      id: rootId, followUpId: followUp.value!.id, hasAnswer: true, answer: "失败追问回答"
    }));
    await annotationMatrix(context, service.annotationCommands, queries);
    await rootCommandMatrix(context, service, queries);
    await trashCommandMatrix(context, service, queries, {
      blockId, remarkId: remark.value.id, followUpId: followUp.value.id
    });
    await context.attachmentChecks({
      database, repo, service: service.attachments, scheduledTaskIds: service.scheduledTaskIds,
      cancelledTaskIds: service.cancelledTaskIds, queries
    });
    await context.aiChecks({ database, repo, queries }, service);
    const afterOthers = (await database.query(`SELECT object_key, version, payload FROM for_now.store_objects
      WHERE account_id=$1 AND id LIKE 'unrelated-%' ORDER BY object_key`, [accountId])).rows;
    assert.deepEqual(afterOthers, beforeOthers);
    assert.ok(transactions.every(transaction => transaction.reads < 100), JSON.stringify(transactions));
    assert.ok(transactions.every(transaction => transaction.writes < 100), JSON.stringify(transactions));
    const commands = (await database.query(`SELECT DISTINCT command_id FROM for_now.record_changes
      WHERE account_id=$1 ORDER BY command_id`, [accountId])).rows.map(row => row.command_id);
    assert.equal(commands.length, 27);
    console.log("Thought producer PostgreSQL matrix passed: twenty-seven public commands, document mutation forbidden, 1000 unrelated roots unchanged, commit-time failures atomic.");
  });
}

async function rootCommandMatrix(
  context: Context,
  service: ReturnType<Context["createService"]>,
  queries: Queries
) {
  const commands = service.rootCommands;
  const input = {
    questionText: "根生产者新增词",
    tags: ["根生产者标签"],
    eventTime: { occurredAt: timestamp, occurredOn: "2026-10-19" },
    clientRequestId: "producer-root-create",
    requestHash: "producer-root-create-hash",
    generateAnswer: true
  };
  const created = await commands.create(input);
  const createdRoot = created.items?.find(item => item.type === "question");
  assert.ok(createdRoot);
  assert.ok(created.task);
  assert.equal((await queries.list({ query: "根生产者新增词" })).items[0]?.id, createdRoot.id);
  assert.equal((await queries.list({ tag: "根生产者标签" })).items[0]?.id, createdRoot.id);
  const beforeReplay = await snapshot(context.database);
  assert.equal((await commands.create(input)).duplicate, true);
  assert.deepEqual(await snapshot(context.database), beforeReplay);
  await assert.rejects(commands.create({ ...input, requestHash: "changed" }), { code: "IDEMPOTENCY_KEY_REUSED" });
  await failureCase(context, "thought.create", () => commands.create({
    ...input, clientRequestId: "producer-root-create-failure"
  }));
  await context.repo.update(store => {
    const sourceKey = JSON.stringify(["thought", createdRoot.id, createdRoot.id, `question:${createdRoot.id}`]);
    const permission = store.evidencePermissions.find(item => item.sourceKey === sourceKey);
    assert.ok(permission);
    permission.learningAllowed = true;
    permission.revision = Number(permission.revision) + 1;
  });
  const scheduledBeforeUpdate = service.scheduledTaskIds.length;
  await commands.update({
    id: createdRoot.id, questionText: "根生产者修改词", tags: ["根修改标签"], expectedVersion: 1
  });
  assert.equal(service.scheduledTaskIds.length, scheduledBeforeUpdate + 1);
  assert.equal((await queries.list({ query: "根生产者新增词" })).items.length, 0);
  assert.equal((await queries.list({ tag: "根修改标签" })).items[0]?.id, createdRoot.id);
  const scheduledBeforeFailure = [...service.scheduledTaskIds];
  await failureCase(context, "thought.update", () => commands.update({
    id: createdRoot.id, questionText: "失败根更新", tags: ["根修改标签"]
  }));
  assert.deepEqual(service.scheduledTaskIds, scheduledBeforeFailure);
  await context.repo.update(store => {
    const task = store.aiTasks.find(item => item.id === created.task!.id);
    assert.ok(task);
    task.status = "running";
    task.inputVersion = 2;
    task.subtargetVersion = 0;
    task.inputHash = "";
    delete task.deferredInputBinding;
  });
  const writeback = {
    taskId: created.task.id,
    result: { content: "后台根回答词", reasoningContent: "后台根推理", contextReceipt: { version: 1 } }
  };
  await failureCase(context, "thought.aiWriteback", () => commands.writeback(writeback));
  await failureCase(context, "thought.aiWriteback.failure", () => commands.failWriteback(
    created.task!.id, { code: "AI_TASK_FAILED", message: "模拟失败" }
  ));
  assert.equal((await commands.writeback(writeback))?.status, "succeeded");
  assert.equal((await queries.list({ query: "后台根回答词" })).items[0]?.id, createdRoot.id);
  const second = await commands.create({ ...input, clientRequestId: "producer-root-create-second" });
  await context.repo.update(store => {
    const task = store.aiTasks.find(item => item.id === second.task!.id);
    assert.ok(task);
    task.status = "running";
  });
  assert.equal((await commands.failWriteback(second.task!.id, { code: "AI_TASK_FAILED", message: "失败用例" }))?.status, "failed");
  const scheduledBefore = [...service.scheduledTaskIds];
  await failureCase(context, "thought.delete", () => commands.remove(createdRoot.id));
  assert.deepEqual(service.scheduledTaskIds, scheduledBefore);
  assert.ok(await commands.remove(createdRoot.id));
  assert.ok(await commands.remove(createdRoot.id));
  assert.equal(await queries.detail(createdRoot.id), null);
  assert.equal((await queries.list({ tag: "根修改标签" })).items.length, 0);
  const lifecycle = (await context.database.query(`SELECT state FROM for_now.resource_lifecycle
    WHERE account_id=$1 AND resource_id=$2`, [accountId, createdRoot.id])).rows[0];
  assert.equal(lifecycle?.state, "deleted");
  const trashEntry = (await context.database.query(`SELECT id FROM for_now.store_objects
    WHERE account_id=$1 AND collection='trash' AND payload->>'resourceId'=$2`,
  [accountId, createdRoot.id])).rows[0];
  await failureCase(context, "thought.trash.restore", () => service.trashCommands.restore(String(trashEntry.id)));
  assert.ok((await service.trashCommands.restore(String(trashEntry.id))).value);
  assert.ok(await queries.detail(createdRoot.id));
  assert.equal((await context.database.query(`SELECT state FROM for_now.resource_lifecycle
    WHERE account_id=$1 AND resource_id=$2`, [accountId, createdRoot.id])).rows[0]?.state, "active");
  const deletedAgain = await commands.remove(createdRoot.id);
  assert.ok(deletedAgain);
  await context.repo.update(store => {
    const item = store.trash.find(item => item.id === deletedAgain.id);
    assert.ok(item);
    item.permanentlyPurged = true;
  });
  await assert.rejects(commands.remove(createdRoot.id), { code: "RESOURCE_PERMANENTLY_PURGED" });
  await assert.rejects(service.trashCommands.restore(String(deletedAgain.id)), { code: "RESOURCE_PERMANENTLY_PURGED" });
}

async function trashCommandMatrix(
  context: Context,
  service: ReturnType<Context["createService"]>,
  queries: Queries,
  ids: { blockId: string; remarkId: string; followUpId: string }
) {
  const commands = service.trashCommands;
  const targetAnnotation = {
    targetKey: `idea:${ids.blockId}`, quote: "内容", text: "随块恢复批注",
    kind: "comment", start: 0, end: 2
  };
  const kept = await service.annotationCommands.create("thought", rootId, targetAnnotation);
  const previouslyDeleted = await service.annotationCommands.create("thought", rootId, {
    ...targetAnnotation, text: "先前单删批注"
  });
  assert.ok(kept.value && previouslyDeleted.value);
  await service.annotationCommands.remove("thought", rootId, previouslyDeleted.value.id);
  await failureCase(context, "thought.block.delete", () => commands.removeThoughtBlock(ids.blockId));
  const entry = await commands.removeThoughtBlock(ids.blockId);
  assert.ok(entry);
  assert.equal((await commands.removeThoughtBlock(ids.blockId))?.id, entry.id);
  assert.equal((await queries.list({ query: "内容块修改词" })).items.length, 0);
  const beforeSchedule = [...service.scheduledTaskIds];
  await failureCase(context, "thought.trash.restore", () => commands.restore(String(entry.id)));
  assert.deepEqual(service.scheduledTaskIds, beforeSchedule);
  assert.ok((await commands.restore(String(entry.id))).value);
  assert.deepEqual(service.scheduledTaskIds, beforeSchedule);
  assert.equal((await queries.list({ query: "内容块修改词" })).items[0]?.id, rootId);
  const detail = await queries.detail(rootId);
  const annotations = detail?.annotations as { id: string }[];
  assert.ok(annotations.some(item => item.id === kept.value!.id));
  assert.ok(!annotations.some(item => item.id === previouslyDeleted.value!.id));
  const blockSourceKey = JSON.stringify(["thought", ids.blockId, rootId, `idea:${ids.blockId}`]);
  const permission = (await context.database.query(`SELECT payload FROM for_now.store_objects
    WHERE account_id=$1 AND collection='evidencePermissions' AND id=$2`, [accountId, blockSourceKey])).rows[0];
  assert.equal((permission?.payload as { learningAllowed: boolean })?.learningAllowed, false);
  const versions = (await context.database.query(`SELECT entity_version, operation FROM for_now.record_changes
    WHERE account_id=$1 AND entity_id=$2 AND entity_type='thoughtBlock'
    ORDER BY cursor, ordinal`, [accountId, ids.blockId])).rows;
  assert.ok(Number(versions.at(-1)?.entity_version) > Number(versions.at(-2)?.entity_version));
  assert.equal((await commands.restore(String(entry.id))).missing, true);
  for (const [field, type, id] of [
    ["remarks", "thoughtRemark", ids.remarkId],
    ["followUps", "thoughtFollowUp", ids.followUpId]
  ]) {
    const input = {
      parentCollection: "thoughts", parentId: rootId, field, type, id,
      annotationTargetKeys: field === "followUps" ? [`followup-question:${id}`, `followup-answer:${id}`] : []
    };
    await failureCase(context, `thought.${field === "remarks" ? "remark" : "followUp"}.delete`,
      () => commands.removeThoughtNested(input));
    const deleted = await commands.removeThoughtNested(input);
    assert.ok(deleted);
    await failureCase(context, "thought.trash.restore", () => commands.restore(String(deleted.id)));
    assert.ok((await commands.restore(String(deleted.id))).value);
    assert.equal((await context.database.query(`SELECT state FROM for_now.resource_lifecycle
      WHERE account_id=$1 AND resource_id=$2`, [accountId, id])).rows[0]?.state, "active");
  }
  await permanentlyPurgedMatrix(context, commands, ids.blockId);
  const remarkRoot = await service.rootCommands.create({
    questionText: "块内备注所属根", tags: [],
    clientRequestId: "nested-remark-root", requestHash: "nested-remark-root"
  });
  const parentRoot = remarkRoot.items?.find(item => item.type === "question");
  assert.ok(parentRoot);
  const remarkBlock = await service.createBlock({
    relatedTo: parentRoot.id, type: "record", content: "块内备注正文", tags: [],
    clientRequestId: "nested-remark-block"
  });
  assert.ok(remarkBlock.value);
  const blockRemark = await service.addRemark({ id: remarkBlock.value.id, text: "块内备注" });
  assert.ok(blockRemark.value);
  const blockRemarkTrash = await commands.removeThoughtNested({
    parentCollection: "thoughts", parentId: remarkBlock.value.id,
    field: "remarks", type: "thoughtRemark", id: blockRemark.value.id
  });
  assert.ok(blockRemarkTrash);
  const lifecycleKey = `thoughtBlock:${remarkBlock.value.id}/thoughtRemark:${blockRemark.value.id}`;
  const state = async () => (await context.database.query(`SELECT state FROM for_now.resource_lifecycle
    WHERE account_id=$1 AND resource_key=$2`, [accountId, lifecycleKey])).rows[0]?.state;
  assert.equal(await state(), "deleted");
  assert.ok((await commands.restore(String(blockRemarkTrash.id))).value);
  assert.equal(await state(), "active");
}

async function permanentlyPurgedMatrix(
  context: Context,
  commands: ReturnType<Context["createService"]>["trashCommands"],
  blockId: string
) {
  const entry = await commands.removeThoughtBlock(blockId);
  assert.ok(entry);
  await context.repo.update(store => {
    const item = store.trash.find(item => item.id === entry.id);
    assert.ok(item);
    item.permanentlyPurged = true;
  });
  const before = await snapshot(context.database);
  await assert.rejects(commands.restore(String(entry.id)), { code: "RESOURCE_PERMANENTLY_PURGED" });
  await assert.rejects(commands.removeThoughtBlock(blockId), { code: "RESOURCE_PERMANENTLY_PURGED" });
  assert.deepEqual(await snapshot(context.database), before);
}

async function annotationMatrix(context: Context, commands: AnnotationCommands, queries: Queries) {
  const input = {
    targetKey: `question:${rootId}`, quote: "局部", text: "批注正文",
    kind: "comment", start: 0, end: 2
  };
  const created = await commands.create("thought", rootId, input, { clientRequestId: "annotation-one" });
  assert.ok(created.value);
  const detail = await queries.detail(rootId);
  assert.equal((detail?.annotations as { id: string }[])?.[0]?.id, created.value.id);
  const replay = await commands.create("thought", rootId, input, { clientRequestId: "annotation-one" });
  assert.equal(replay.value?.id, created.value.id);
  assert.equal(replay.duplicate, true);
  await failureCase(context, "thought.annotation.create", () => commands.create("thought", rootId, input));
  const reply = await commands.reply("thought", rootId, created.value.id, { text: "批注回复" });
  assert.ok(reply.value);
  const draft = (await context.database.query(`SELECT parent_type, parent_id FROM for_now.record_changes
    WHERE account_id=$1 AND entity_id=$2 AND entity_type='annotationReply'`, [accountId, reply.value.id])).rows[0];
  assert.deepEqual(draft, { parent_type: "annotation", parent_id: created.value.id });
  await failureCase(context, "thought.annotation.reply", () => commands.reply(
    "thought", rootId, created.value!.id, { text: "失败回复" }
  ));
  await commands.convert("thought", rootId, created.value.id, { kind: "highlight" });
  await failureCase(context, "thought.annotation.convert", () => commands.convert(
    "thought", rootId, created.value!.id, { kind: "comment", text: "失败转换" }
  ));
  await failureCase(context, "thought.annotation.delete", () => commands.remove("thought", rootId, created.value!.id));
  const removed = await commands.remove("thought", rootId, created.value.id);
  assert.ok(removed);
  const lifecycle = (await context.database.query(`SELECT state FROM for_now.resource_lifecycle
    WHERE account_id=$1 AND resource_id=$2`, [accountId, created.value.id])).rows[0];
  assert.equal(lifecycle?.state, "deleted");
}
