/**
 * 图片原文生产者的 PostgreSQL 成功、冲突和末尾故障回滚验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：隔离合成账户；禁止文档读写及全库存枚举。
 */
import assert from "node:assert/strict";

const accountId = "thought-producer-test";
const paths = ["/attachments/producer-first.png", "/attachments/producer-second.png"];
const owner = { collection: "thoughts", id: "attachment-root" };
const targets = [
  ["thoughtRoot", "attachment-root", null],
  ["thoughtBlock", "attachment-block", null],
  ["capture", "attachment-capture", null],
  ["comment", "attachment-comment", owner]
];

async function snapshot(database) {
  const state = {};
  for (const table of ["accounts", "store_fields", "store_objects", "store_relations",
    "store_attachment_refs", "attachment_inventory", "resource_lifecycle", "thought_chain_index",
    "thought_tag_counts", "record_changes", "account_sync_heads", "idempotency_ledger"]) {
    state[table] = (await database.query(`SELECT to_jsonb(row) AS value FROM for_now.${table} row
      WHERE account_id=$1 ORDER BY to_jsonb(row)::text`, [accountId])).rows;
  }
  return state;
}

async function failure(database, commandId, invoke) {
  const before = await snapshot(database);
  await database.query(`ALTER TABLE for_now.record_changes ADD CONSTRAINT injected_attachment_failure
    CHECK(command_id <> '${commandId}') NOT VALID`);
  try {
    await assert.rejects(invoke(), /injected_attachment_failure/);
    assert.deepEqual(await snapshot(database), before);
  } finally {
    await database.query("ALTER TABLE for_now.record_changes DROP CONSTRAINT injected_attachment_failure");
  }
}

export function attachmentProducerFixtures(root) {
  const host = root("attachment-root");
  host.annotations = [{
    id: "attachment-comment", kind: "comment", text: "图片批注", quote: "局部", targetKey: "question:attachment-root",
    version: 1, attachmentPaths: [], replies: [], createdAt: host.createdAt
  }];
  const other = root("attachment-other");
  other.annotations = [{
    ...host.annotations[0], text: "同名异主批注", attachmentPaths: []
  }];
  return [host, other, {
    id: "attachment-block", type: "record", relatedTo: host.id, content: "图片块",
    attachmentPaths: [], version: 1, createdAt: host.createdAt, occurredAt: host.occurredAt
  }];
}

/** 四类正式目标逐入口提交与回滚，并保留同名异主和无关库存。 @since unreleased */
export async function runAttachmentProducerPostgresChecks({ database, service, scheduledTaskIds, cancelledTaskIds, repo, queries }) {
  await database.query(`INSERT INTO for_now.attachment_inventory
    (account_id,path,storage,object_key,bytes,sha256,state)
    SELECT $1, '/attachments/' || name || '.png', 'local', name || '.png', 0, repeat('a',64), 'verified'
    FROM unnest(ARRAY['producer-first','producer-second'] || ARRAY(
      SELECT 'unrelated-inventory-' || generate_series(1,1000))) name`, [accountId]);
  await assert.rejects(service.get("comment", "attachment-comment"), { code: "CONTENT_ATTACHMENT_OWNER_REQUIRED" });
  const untouched = await snapshot(database);
  const beforeSchedules = [...scheduledTaskIds];
  for (const [type, id, targetOwner] of targets) {
    await targetMatrix({ database, service, type, id, owner: targetOwner });
  }
  assert.deepEqual(scheduledTaskIds, beforeSchedules);
  assert.deepEqual((await database.query(`SELECT payload FROM for_now.store_objects
    WHERE account_id=$1 AND object_key=$2`, [accountId, '["thoughts","attachment-other","annotations","attachment-comment"]'])).rows[0].payload.attachmentPaths, []);
  const after = await snapshot(database);
  assert.deepEqual(after.attachment_inventory, untouched.attachment_inventory);
  assert.ok((await queries.detail("attachment-root")).annotations[0].imageUnderstandings.length);
  await cancellationMatrix({ database, service, repo, cancelledTaskIds });
  await repo.update(store => {
    store.trash.push({
      id: "invalid-attachment-trash", type: "contentAttachment", resourceId: "invalid-payload",
      payload: { id: "invalid-payload", attachmentPaths: [paths[0]] }
    });
  });
  const malformedBefore = await snapshot(database);
  assert.equal((await service.restoreOriginalImages("invalid-attachment-trash")).invalid, true);
  assert.deepEqual(await snapshot(database), malformedBefore);
  console.log("Attachment producer PostgreSQL passed: four target types, four mutation entries each with commit-time rollback; exact owner, stale/replay, 1000 unrelated inventory rows, queued/running cancellation.");
}

async function targetMatrix({ database, service, type, id, owner }) {
  const current = () => service.get(type, id, { owner });
  const replace = list => service.replaceOriginalImages(type, id, list, { owner });
  await failure(database, "contentAttachment.replace", () => replace(paths));
  assert.ok((await replace(paths)).value);
  const beforeNoop = await snapshot(database);
  assert.equal((await replace(paths)).unchanged, true);
  assert.deepEqual(await snapshot(database), beforeNoop);
  const input = {
    targetType: type, targetId: id, owner, attachmentPaths: [paths[0]], content: "图片派生理解",
    inputVersion: (await current()).value.version, sourceTaskId: `attachment-task-${type}`
  };
  const prepared = await service.prepareUnderstanding(input);
  assert.ok(prepared.value);
  await failure(database, "contentAttachment.saveUnderstanding", () => service.saveUnderstanding(input));
  assert.ok((await service.saveUnderstanding(input)).value);
  const understandingRefs = async () => (await database.query(`SELECT r.path FROM for_now.store_attachment_refs r
    JOIN for_now.store_objects o ON o.account_id=r.account_id AND o.object_key=r.owner_key
    WHERE r.account_id=$1 AND o.id=$2 AND r.value_path::jsonb->>0='imageUnderstandings'
      AND ($3::text IS NULL OR o.parent_key=$3)`,
  [accountId, id, owner ? JSON.stringify([owner.collection, owner.id]) : null])).rows;
  assert.deepEqual(await understandingRefs(), [{ path: paths[0] }]);
  const beforeReplay = await snapshot(database);
  assert.equal((await service.saveUnderstanding(input)).duplicate, true);
  assert.deepEqual(await snapshot(database), beforeReplay);
  assert.equal((await service.saveUnderstanding({ ...input, sourceTaskId: "stale-task" })).stale, true);
  assert.deepEqual(await snapshot(database), beforeReplay);
  await failure(database, "contentAttachment.remove", () => service.removeOriginalImage(type, id, paths[0], { owner }));
  const removed = await service.removeOriginalImage(type, id, paths[0], { owner });
  assert.ok(removed.trashId);
  assert.equal((await current()).value.imageUnderstandings.length, 0);
  assert.deepEqual(await understandingRefs(), []);
  await failure(database, "contentAttachment.restore", () => service.restoreOriginalImages(removed.trashId));
  const restored = await service.restoreOriginalImages(removed.trashId);
  assert.ok(restored.value);
  assert.equal(restored.value.imageUnderstandings.length, 1);
  assert.deepEqual(await understandingRefs(), [{ path: paths[0] }]);
  assert.equal((await service.restoreOriginalImages(removed.trashId)).missing, true);
  const conflict = await service.replaceOriginalImages(type, id, [], { owner, expectedVersion: 1 });
  assert.equal(conflict.versionConflict, true);
  assert.equal((await service.replaceOriginalImages(type, id, ["/attachments/other-account.png"], { owner })).forbidden, true);
}

async function cancellationMatrix({ database, service, repo, cancelledTaskIds }) {
  await repo.update(store => {
    store.aiTasks.push(...["queued", "running"].map(status => ({
      id: `attachment-cancel-${status}`, kind: "contentImageUnderstanding", status,
      resourceType: "thought", targetId: "attachment-root", inputVersion: 1, version: 1,
      payload: { targetType: "thoughtRoot", targetId: "attachment-root", attachmentPaths: [paths[0]] }
    })));
    store.notifications.push(...["queued", "running"].map(status => ({
      id: `attachment-notice-${status}`, taskId: `attachment-cancel-${status}`, status, version: 1
    })));
  });
  const cancelledBefore = [...cancelledTaskIds];
  await failure(database, "contentAttachment.remove", () => service.removeOriginalImage("thoughtRoot", "attachment-root", paths[0]));
  assert.deepEqual(cancelledTaskIds, cancelledBefore);
  assert.ok((await service.removeOriginalImage("thoughtRoot", "attachment-root", paths[0])).value);
  assert.deepEqual(cancelledTaskIds, [...cancelledBefore, "attachment-cancel-running"]);
  const tasks = (await database.query(`SELECT id,status FROM for_now.store_objects
    WHERE account_id=$1 AND id LIKE 'attachment-cancel-%' ORDER BY id`, [accountId])).rows;
  assert.deepEqual(tasks, [
    { id: "attachment-cancel-queued", status: "cancelled" },
    { id: "attachment-cancel-running", status: "cancelling" }
  ]);
}

export async function runAttachmentProducerHttpChecks({ base, request, cookie, otherCookie, attachmentPath }) {
  const created = await request(base, "/api/thought-chains", {
    method: "POST", cookie, body: { question: "HTTP 图片原文", clientRequestId: "attachment-http-root" }
  });
  assert.equal(created.status, 201);
  const id = created.body.items.find(item => item.type === "question").id;
  const route = `/api/v1/content-attachments/thoughtRoot/${id}`;
  assert.equal((await request(base, route, { cookie: otherCookie })).status, 404);
  const get = () => request(base, route, { cookie });
  const initial = await get();
  assert.equal(initial.status, 200);
  const replaced = await request(base, route, {
    cookie, method: "PUT", headers: { "if-match": `"${initial.body.data.version}"` },
    body: { attachmentPaths: [attachmentPath] }
  });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const removed = await request(base, `${route}/originals/${attachmentPath.split("/").at(-1)}`, {
    cookie, method: "DELETE", headers: { "if-match": `"${replaced.body.data.version}"` }
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const restoreRoute = `/api/v1/content-attachments/trash/${removed.body.meta.trashId}/restore`;
  assert.equal((await request(base, restoreRoute, {
    cookie: otherCookie, method: "POST", headers: { "if-match": `"${removed.body.data.version}"` }
  })).status, 404);
  assert.equal((await request(base, restoreRoute, {
    cookie, method: "POST", headers: { "if-match": `"${removed.body.data.version}"` }
  })).status, 200);
  assert.equal((await get()).body.data.originalImages[0].state, "verified");
  assert.equal((await request(base, route + "?ownerId=incomplete", { cookie })).status, 400);
  console.log("Attachment producer HTTP passed: formal runtime, exact inventory, versioned remove/restore and cross-account denial.");
}
