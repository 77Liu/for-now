/**
 * F9 v2 record batch, rebase and frontend-state contract regression.
 * Created: 2026-10-19
 * Status: active
 */
import assert from "node:assert/strict";
import {
  assembleRecordChangePage,
  type StoredRecordChange
} from "../src/shared/persistence/record-sync-repository.mjs";
import {
  createRecordSyncEntityRegistry,
  projectRecordChanges
} from "../src/app/sync-projection.mjs";
import { rebaseRecordSyncScopes } from "../src/app/sync-rebase.mjs";
import {
  createRecordState,
  recordEntityKey
} from "../public/frontend/state/record-sync.mjs";

const stored = (
  cursor: number,
  ordinal: number,
  entityType: string,
  entityId: string
): StoredRecordChange => ({
  cursor,
  ordinal,
  commandId: `command-${cursor}`,
  entityType,
  entityId,
  parentType: null,
  parentId: null,
  version: cursor,
  operation: "update",
  changedFields: ["content"],
  scopeKeys: ["thought:list", `thought:${entityId}`],
  summary: null,
  createdAt: "2026-10-19T00:00:00.000Z"
});

const page = assembleRecordChangePage({
  after: 0,
  highWaterCursor: 3,
  oldestCursor: 1,
  limit: 2,
  rows: [
    stored(1, 0, "thoughtChain", "root-a"),
    stored(2, 0, "thoughtChain", "root-b"),
    stored(2, 1, "thoughtBlock", "block-b"),
    stored(3, 0, "notification", "notification-c")
  ]
});
assert.deepEqual(page.rows.map(row => [row.cursor, row.ordinal]), [[1, 0]]);
assert.equal(page.nextCursor, 1);
assert.equal(page.hasMore, true);
assert.equal(page.oversized, false);

const oversized = assembleRecordChangePage({
  after: 0,
  highWaterCursor: 1,
  oldestCursor: 1,
  limit: 1,
  rows: [
    stored(1, 0, "thoughtChain", "root-a"),
    stored(1, 1, "thoughtBlock", "block-a")
  ]
});
assert.equal(oversized.oversized, true);
assert.equal(oversized.nextCursor, 0);

assert.throws(() => assembleRecordChangePage({
  after: 4,
  highWaterCursor: 3,
  oldestCursor: 1,
  limit: 10,
  rows: []
}), { code: "SYNC_CURSOR_AHEAD" });
assert.throws(() => assembleRecordChangePage({
  after: 1,
  highWaterCursor: 6,
  oldestCursor: 4,
  limit: 10,
  rows: []
}), { code: "SYNC_CURSOR_EXPIRED" });

const detail = {
  id: "root-a",
  type: "question",
  content: "question",
  version: 4,
  remarks: [{ id: "remark-a", text: "remark", version: 2 }],
  blocks: [{
    id: "block-a",
    type: "idea",
    relatedTo: "root-a",
    content: "idea",
    version: 3
  }]
};
const registry = createRecordSyncEntityRegistry({ thoughtsComplete: true });
let projectedRootId = "";
const projected = await projectRecordChanges({
  rows: [
    {
      ...stored(4, 0, "thoughtRemark", "remark-a"),
      parentType: "thoughtChain",
      parentId: "root-a",
      scopeKeys: ["thought:list", "thought:root-a"],
      changedFields: ["content", "requestHash"],
      version: 2
    },
    stored(4, 1, "notification", "notification-a")
  ],
  reader: { detail: async rootId => {
    projectedRootId = rootId;
    return detail;
  } },
  registry
});
assert.equal(projected.length, 1);
assert.equal(projected[0].key.entityType, "thoughtChain");
assert.equal(projectedRootId, "root-a");
assert.equal(projected[0].version, 4);
assert.equal(projected[0].summary?.content, "question");
assert.deepEqual(projected[0].changedFields, ["content"]);
const foldedDelete = await projectRecordChanges({
  rows: [{
    ...stored(4, 0, "annotationReply", "removed-reply"),
    parentType: "annotation",
    parentId: "removed-annotation",
    scopeKeys: ["thought:list", "thought:root-a"],
    operation: "delete"
  }],
  reader: { detail: async () => detail },
  registry
});
assert.equal(foldedDelete[0].key.entityType, "thoughtChain");
assert.equal(foldedDelete[0].refetch, "detail");
const foldedBlockLifecycle = await projectRecordChanges({
  rows: [
    {
      ...stored(4, 0, "thoughtBlock", "removed-block"),
      operation: "create",
      parentType: "thoughtChain",
      parentId: "root-a",
      scopeKeys: ["thought:list", "thought:root-a"]
    },
    {
      ...stored(5, 0, "thoughtBlock", "removed-block"),
      operation: "delete",
      parentType: "thoughtChain",
      parentId: "root-a",
      scopeKeys: ["thought:list", "thought:root-a"]
    }
  ],
  reader: { detail: async () => detail },
  registry
});
assert.equal(foldedBlockLifecycle.length, 1);
assert.equal(foldedBlockLifecycle[0].operation, "delete");
await assert.rejects(projectRecordChanges({
  rows: [{
    ...stored(4, 0, "thoughtChain", "already-deleted"),
    operation: "create",
    scopeKeys: ["thought:list", "thought:already-deleted"]
  }],
  reader: { detail: async () => null },
  registry
}), { code: "SYNC_REBASE_REQUIRED" });

await assert.rejects(projectRecordChanges({
  rows: [stored(5, 0, "unregistered", "bad")],
  reader: { detail: async () => detail },
  registry
}), { code: "SYNC_ENTITY_TYPE_UNREGISTERED" });

let rebasedAfterId = "";
const encodedPageCursor = Buffer.from(JSON.stringify({
  v: 1,
  after: JSON.stringify({
    v: 4,
    scope: "scope",
    primary: "2026-10-19T00:00:00.000Z",
    created: "2026-10-19T00:00:00.000Z",
    id: "root-before"
  })
})).toString("base64url");
const rebased = await rebaseRecordSyncScopes({
  reader: {
    list: async input => {
      rebasedAfterId = input.afterId || "";
      return {
      items: [{ id: "root-a", type: "question", content: "summary", version: 4 }],
      nextId: "",
      prevId: "",
      tags: []
      };
    },
    detail: async () => detail
  },
  scopes: [
    {
      scopeKey: "thoughtPage:active",
      kind: "thoughtPage",
      cursor: encodedPageCursor
    },
    { scopeKey: "thoughtDetail:root-a", kind: "thoughtDetail", id: "root-a" }
  ],
  activeScopeKey: "thoughtDetail:root-a",
  highWaterCursor: 7,
  maximumScopes: 5
});
assert.equal(rebased.highWaterCursor, 7);
assert.equal(rebased.scopes[0].entities.length, 1);
assert.equal(rebased.scopes[1].entities.length, 2);
assert.equal(rebased.scopes[1].orderedEntityKeys[1].includes("block-a"), true);
assert.equal(rebased.scopes[0].entities[0].deliveryCursor, 7);
assert.match(rebasedAfterId, /"root-before"/);

const projectionState = createRecordState();
projectionState.rebaseScopes({
  highWaterCursor: rebased.highWaterCursor,
  activeScopeKey: rebased.scopes[0].scopeKey,
  scopes: [rebased.scopes[0]]
}, { accountId: "projection-account", workspace: "", generation: 1 });
assert.equal(projectionState.selectLegacyDomain("thoughts")[0].content, "summary");
projectionState.rebaseScopes({
  highWaterCursor: rebased.highWaterCursor,
  activeScopeKey: rebased.scopes[1].scopeKey,
  scopes: rebased.scopes
}, { accountId: "projection-account", workspace: "", generation: 1 });
assert.equal(projectionState.selectLegacyDomain("thoughts")[0].content, "question");
assert.equal(projectionState.inspect().entities.length, 2);
projectionState.rebaseScopes({
  highWaterCursor: rebased.highWaterCursor,
  activeScopeKey: rebased.scopes[0].scopeKey,
  scopes: [rebased.scopes[0]]
}, { accountId: "projection-account", workspace: "", generation: 1 });
assert.equal(projectionState.selectLegacyDomain("thoughts")[0].content, "summary");
assert.equal(projectionState.inspect().entities.length, 0);

const boundedState = createRecordState();
for (let index = 1; index <= 50; index += 1) {
  const key = {
    entityType: "thoughtChain" as const,
    entityId: `bounded-${index}`,
    parentType: null,
    parentId: null
  };
  boundedState.rebaseScopes({
    highWaterCursor: index,
    activeScopeKey: `thoughtDetail:${index}`,
    scopes: [{
      scopeKey: `thoughtDetail:${index}`,
      descriptorVersion: 1,
      kind: "thoughtDetail",
      entities: [{
        key,
        version: 1,
        deliveryCursor: index,
        projection: { id: key.entityId, type: "question", content: "bounded", version: 1 },
        tombstone: false
      }],
      orderedEntityKeys: [recordEntityKey(key)]
    }]
  }, { accountId: "bounded-account", workspace: "", generation: 1 });
}
assert.equal(boundedState.inspect().scopes.length, 1);
assert.equal(boundedState.inspect().entities.length, 1);

const searchContext = { accountId: "search-account", workspace: "", generation: 1 };
const searchState = createRecordState();
const searchKey = {
  entityType: "thoughtChain" as const,
  entityId: "search-root",
  parentType: null,
  parentId: null
};
searchState.rebaseScopes({
  highWaterCursor: 1,
  activeScopeKey: "thoughtPage:search",
  scopes: [{
    scopeKey: "thoughtPage:search",
    descriptorVersion: 1,
    kind: "thoughtPage",
    entities: [{
      key: searchKey,
      version: 1,
      deliveryCursor: 1,
      projection: { id: "search-root", type: "question", content: "apple", version: 1 },
      tombstone: false
    }],
    orderedEntityKeys: [recordEntityKey(searchKey)],
    metadata: { query: "apple" }
  }]
}, searchContext);
const searchChanges = await projectRecordChanges({
  rows: [{
    ...stored(2, 0, "thoughtChain", "search-root"),
    version: 2,
    changedFields: ["content", "version"],
    scopeKeys: ["thought:list", "thought:search-root"]
  }],
  reader: {
    detail: async () => ({
      id: "search-root",
      type: "question",
      content: "banana",
      version: 2,
      blocks: []
    })
  },
  registry
});
assert.equal(searchChanges[0].refetch, "filter");
const searchApplied = searchState.applyRecordBatch({
  fromCursor: 1,
  nextCursor: 2,
  highWaterCursor: 2,
  hasMore: false,
  changes: searchChanges
}, searchContext);
assert.deepEqual(searchApplied.staleScopeKeys, ["thoughtPage:search"]);

const context = { accountId: "account-a", workspace: "", generation: 1 };
const store = createRecordState();
const rootKey = recordEntityKey({
  entityType: "thoughtChain",
  entityId: "root-a",
  parentType: null,
  parentId: null
});
const scopeKey = "thoughtPage:active";
store.rebaseScopes({
  highWaterCursor: 4,
  activeScopeKey: scopeKey,
  scopes: [{
    scopeKey,
    descriptorVersion: 1,
    kind: "thoughtPage",
    entities: [{
      key: {
        entityType: "thoughtChain",
        entityId: "root-a",
        parentType: null,
        parentId: null
      },
      version: 1,
      projection: { id: "root-a", type: "question", content: "old", version: 1 },
      tombstone: false
    }],
    orderedEntityKeys: [rootKey]
  }]
}, context);
assert.equal(store.selectLegacyDomain("thoughts")[0].content, "old");

store.applyRecordBatch({
  fromCursor: 4,
  nextCursor: 5,
  highWaterCursor: 5,
  hasMore: false,
  changes: [{
    cursor: 5,
    ordinal: 0,
    key: {
      entityType: "thoughtChain",
      entityId: "root-a",
      parentType: null,
      parentId: null
    },
    version: 2,
    operation: "update",
    changedFields: ["content"],
    scopeKeys: ["thought:list", "thought:root-a"],
    summary: { id: "root-a", type: "question", content: "new", version: 2 },
    tombstone: false,
    refetch: "none"
  }]
}, context);
assert.equal(store.selectLegacyDomain("thoughts")[0].content, "new");

const beforeUnknown = store.inspect();
assert.throws(() => store.applyRecordBatch({
  fromCursor: 5,
  nextCursor: 6,
  highWaterCursor: 6,
  hasMore: false,
  changes: [{
    cursor: 6,
    ordinal: 0,
    key: {
      entityType: "unknownType",
      entityId: "unknown",
      parentType: null,
      parentId: null
    },
    version: 1,
    operation: "create",
    changedFields: [],
    scopeKeys: [],
    summary: {},
    tombstone: false,
    refetch: "none"
  }]
}, context), { code: "SYNC_ENTITY_TYPE_UNKNOWN" });
assert.deepEqual(store.inspect(), beforeUnknown);

store.applyRecordBatch({
  fromCursor: 5,
  nextCursor: 6,
  highWaterCursor: 6,
  hasMore: false,
  changes: [{
    cursor: 6,
    ordinal: 0,
    key: {
      entityType: "thoughtChain",
      entityId: "root-a",
      parentType: null,
      parentId: null
    },
    version: 2,
    operation: "update",
    changedFields: ["content"],
    scopeKeys: [],
    summary: { id: "root-a", type: "question", content: "nested-refresh", version: 2 },
    tombstone: false,
    refetch: "none"
  }]
}, context);
assert.equal(store.selectLegacyDomain("thoughts")[0].content, "nested-refresh");
assert.throws(() => store.rebaseScopes({
  highWaterCursor: 6,
  activeScopeKey: scopeKey,
  scopes: [{
    scopeKey,
    descriptorVersion: 1,
    kind: "thoughtPage",
    entities: [{
      key: {
        entityType: "thoughtChain",
        entityId: "root-a",
        parentType: null,
        parentId: null
      },
      version: 2,
      deliveryCursor: 6,
      projection: { id: "root-a", type: "question", content: "conflict", version: 2 },
      tombstone: false
    }],
    orderedEntityKeys: [rootKey]
  }]
}, context), { code: "SYNC_ENTITY_VERSION_CONFLICT" });
assert.equal(store.selectLegacyDomain("thoughts")[0].content, "nested-refresh");

assert.throws(() => store.applyRecordBatch({
  fromCursor: 6,
  nextCursor: 7,
  highWaterCursor: 7,
  hasMore: false,
  changes: []
}, { accountId: "account-b", workspace: "", generation: 1 }), {
  code: "SYNC_STATE_CONTEXT_MISMATCH"
});

console.log("Record sync v2 regression passed.");
