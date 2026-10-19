/**
 * 局部正文、附件和恢复命令的跨闭包来源关系组合验收。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：仅隔离合成账户；精准目标解析不得命中其他账户或改写目标。
 */
import assert from "node:assert/strict";
import { createAccountUnitOfWork, type QueryClient } from "../src/shared/persistence/account-unit-of-work.mjs";
import { createThoughtRecordRepository } from "../src/shared/persistence/thought-record-repository.mjs";
import type { RecordStore, StoreMapping } from "../src/shared/persistence/record-command-types.mjs";
import path from "node:path";
import { addThoughtClosureChanges } from "../src/modules/thoughts/local-changes.mjs";

const accountId = "thought-source-relations";
const key = (collection: string, id: string) => JSON.stringify([collection, id]);

async function seed(database: QueryClient, mapping: StoreMapping) {
  const { writeStoreObjects } = await import(path.resolve("src/shared/persistence/postgres-objects.mjs"));
  const store: RecordStore = {
    captures: [{ id: "source-a", content: "合成随记", version: 1 }],
    thoughts: [{
      id: "source-root", type: "question", content: "合成问题", version: 1,
      sourceRef: { type: "capture", id: "source-a", version: 1 },
      sourceTaskId: "outside-task", attachmentPaths: ["/attachments/source-before.png"]
    }, {
      id: "nested-a", type: "question", content: "父项甲", version: 1,
      followUps: [{ id: "shared-child", question: "甲追问", version: 1 }]
    }, {
      id: "nested-b", type: "question", content: "父项乙", version: 1,
      followUps: [{ id: "shared-child", question: "乙追问", version: 1 }],
      annotationDrift: [{
        id: "drift-child", text: "乙漂移批注", version: 1,
        replies: [{ id: "nested-reply", text: "乙回复", version: 1 }]
      }]
    }, {
      id: "shared-child", type: "question", content: "同名顶层不能抢占子项", version: 1
    }],
    aiTasks: [{
      id: "outside-task", kind: "thoughtAnswer", resourceType: "thought",
      targetId: "source-root", status: "failed", version: 1, internal: true
    }]
  };
  await database.query("INSERT INTO for_now.accounts(account_id) VALUES ($1),($2)", [accountId, accountId + "-peer"]);
  await writeStoreObjects(database, mapping.mapStoreObjects(accountId, store));
  await writeStoreObjects(database, mapping.mapStoreObjects(accountId + "-peer", {
    captures: [{ id: "peer-only-source", content: "其他账户", version: 1 }]
  }));
}

/** 正式 UoW 与映射器验证未加载、存在、删除、恢复及跨账户来源。 @since unreleased */
export async function runThoughtSourceRelationPostgresChecks(database: QueryClient) {
  const mapping = await import(path.resolve("src/shared/persistence/store-mapping.mjs")) as StoreMapping;
  await seed(database, mapping);
  const graph = createThoughtRecordRepository(mapping);
  const uow = createAccountUnitOfWork({
    transaction: async operation => {
      await database.query("BEGIN");
      try {
        await database.query("SET LOCAL ROLE runtime_data");
        await database.query("SELECT set_config('app.account_id',$1,true)", [accountId]);
        const value = await operation(database, accountId);
        await database.query("COMMIT");
        return value;
      } catch (error) {
        await database.query("ROLLBACK");
        throw error;
      }
    }
  });
  const relations = async (id: string) => (await database.query<{
    relation: string; target_key: string | null; resolution: string;
  }>("SELECT relation,target_key,resolution FROM for_now.store_relations WHERE account_id=$1 AND object_key=$2 ORDER BY relation",
  [accountId, key("thoughts", id)])).rows;
  const baseline = await relations("source-root");
  for (const mutation of [
    (store: RecordStore) => { store.thoughts[0].content = "正文编辑"; },
    (store: RecordStore) => { store.thoughts[0].attachmentPaths = ["/attachments/source-after.png"]; },
    (store: RecordStore) => { store.thoughts[0].attachmentPaths = []; },
    (store: RecordStore) => { store.thoughts[0].attachmentPaths = ["/attachments/source-restored.png"]; }
  ]) {
    await uow.run({ commandId: "thought.source.edit" }, async ports => {
      const closure = (await graph.readThoughtTargetClosure(ports, "source-root"))!;
      mutation(closure.store);
      const after = await graph.persistMappedClosure(ports, accountId, closure.rows, closure.store);
      addThoughtClosureChanges(ports, closure.rows, after, "source-root");
    });
    assert.deepEqual(await relations("source-root"), baseline);
    const found = await uow.run({ commandId: "thought.source.lookup" }, ports =>
      graph.createThoughtStoreClosure(ports, { sourceRef: { type: "capture", id: "source-a", version: 1 } }));
    assert.equal(found.value.store.thoughts.length, 1, "repeat conversion must see the original root");
  }
  await checkNewAndRestoredRelations(database, uow, graph, relations);
  await checkNestedSourceRelations(database, uow, graph);
  console.log("Thought source relations PostgreSQL passed: content, replace/remove/restore attachment, sourceTask, retryOf, missing and cross-account targets.");
}

async function checkNestedSourceRelations(
  database: QueryClient,
  uow: ReturnType<typeof createAccountUnitOfWork>,
  graph: ReturnType<typeof createThoughtRecordRepository>
) {
  for (const [childId, targetKey, expected] of [
    ["shared-child", "followup-question:shared-child", ["thoughts", "nested-b", "followUps", "shared-child"]],
    ["drift-child", "annotation:drift-child", ["thoughts", "nested-b", "annotationDrift", "drift-child"]],
    ["nested-reply", "annotation-reply:nested-reply", ["thoughts", "nested-b", "annotationDrift", "drift-child", "replies", "nested-reply"]],
    ["nested-reply", "annotation-reply:drift-child", ["thoughts", "nested-b", "annotationDrift", "drift-child", "replies", "nested-reply"]]
  ] as [string, string, string[]][]) {
    const sourceKey = JSON.stringify(["thought", childId, "nested-b", targetKey]);
    const permission = {
      id: sourceKey, accountId, sourceKey, revision: 1,
      contextAllowed: true, learningAllowed: false
    };
    await uow.run({ commandId: "thought.source.nested" }, async ports => {
      await graph.persistMappedClosure(ports, accountId, [], {
        evidencePermissions: [permission]
      });
      ports.addChange({
        entityType: "evidencePermission", entityId: sourceKey,
        version: 1, operation: "create", changedFields: ["sourceKey"]
      });
    });
    const found = await database.query<{ target_key: string; resolution: string }>(`
      SELECT target_key,resolution FROM for_now.store_relations
      WHERE account_id=$1 AND object_key=$2 AND relation='source'
    `, [accountId, key("evidencePermissions", sourceKey)]);
    assert.equal(found.rows[0].target_key, JSON.stringify(expected));
    assert.equal(found.rows[0].resolution, "live");
  }
  console.log("Nested source relations PostgreSQL passed: parent identity, top-level collisions, drift and annotation replies.");
}

async function checkNewAndRestoredRelations(
  database: QueryClient,
  uow: ReturnType<typeof createAccountUnitOfWork>,
  graph: ReturnType<typeof createThoughtRecordRepository>,
  relations: (id: string) => Promise<{ relation: string; target_key: string | null; resolution: string }[]>
) {
  await uow.run({ commandId: "thought.source.insert" }, async ports => {
    const root = (await graph.readThoughtTargetClosure(ports, "source-root"))!;
    root.store.thoughts.push({
      id: "generated-answer", type: "answer", relatedTo: "source-root",
      content: "模型合成结果", version: 1, sourceTaskId: "outside-task"
    });
    root.store.aiTasks = [{
      id: "retry-task", kind: "thoughtAnswer", resourceType: "thought", targetId: "source-root",
      status: "queued", version: 1, internal: true, retryOf: "outside-task"
    }];
    const after = await graph.persistMappedClosure(ports, accountId, root.rows, root.store);
    addThoughtClosureChanges(ports, root.rows, after, "source-root");
  });
  assert.ok((await relations("generated-answer")).some(row => row.relation === "sourceTask"
    && row.target_key === key("aiTasks", "outside-task") && row.resolution === "live"));
  const retry = await database.query<{ target_key: string; resolution: string }>(`
    SELECT target_key,resolution FROM for_now.store_relations
    WHERE account_id=$1 AND object_key=$2 AND relation='retryOf'`, [accountId, key("aiTasks", "retry-task")]);
  assert.equal(retry.rows[0].target_key, key("aiTasks", "outside-task"));
  for (const sourceId of ["peer-only-source", "source-a"]) {
    await uow.run({ commandId: "thought.source.change" }, async ports => {
      const root = (await graph.readThoughtTargetClosure(ports, "source-root"))!;
      root.store.thoughts.find(row => row.id === "source-root")!.sourceRef = {
        type: "capture", id: sourceId, version: 1
      };
      const after = await graph.persistMappedClosure(ports, accountId, root.rows, root.store);
      addThoughtClosureChanges(ports, root.rows, after, "source-root");
    });
    const source = (await relations("source-root")).find(row => row.relation === "source")!;
    assert.equal(source.resolution, sourceId === "source-a" ? "live" : "historical");
  }
  const archived = await uow.run({ commandId: "thought.source.archive" }, async ports => {
    const root = (await graph.readThoughtTargetClosure(ports, "source-root"))!;
    await graph.persistMappedClosure(ports, accountId, root.rows, { thoughts: [] });
    addThoughtClosureChanges(ports, root.rows, [], "source-root");
    return root;
  });
  await uow.run({ commandId: "thought.source.restore" }, async ports => {
    const after = await graph.persistMappedClosure(ports, accountId, [], archived.value.store, {
      restoredRows: archived.value.rows
    });
    addThoughtClosureChanges(ports, [], after, "source-root");
  });
  assert.equal((await relations("source-root")).find(row => row.relation === "source")!.resolution, "live");
  assert.equal((await relations("generated-answer")).find(row => row.relation === "sourceTask")!.resolution, "live");
  await uow.run({ commandId: "thought.source.detach" }, async ports => {
    await ports.relations.detachTargets([key("captures", "source-a")]);
    ports.addChange({ entityType: "capture", entityId: "source-a", version: 2,
      operation: "delete", changedFields: ["deleted"] });
  });
  await database.query("DELETE FROM for_now.store_objects WHERE account_id=$1 AND object_key=$2", [accountId, key("captures", "source-a")]);
  assert.equal((await relations("source-root")).find(row => row.relation === "source")!.resolution, "historical");
}
