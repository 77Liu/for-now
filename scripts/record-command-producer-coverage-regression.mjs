import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createBackgroundAi } from "../src/app/index.mjs";
import { createNotificationService } from "../src/modules/notifications/index.mjs";
import { createTaskLifecycle } from "../src/modules/tasks/index.mjs";

const coverage = Object.freeze({
  notification: Object.freeze({
    f9Ready: false,
    producers: Object.freeze([
      ["notification.read", "record"],
      ["notification.readAll", "record"],
      ["background task upsert", "legacy"],
      ["account recovery cancellation", "legacy"]
    ])
  }),
  aiTask: Object.freeze({
    f9Ready: false,
    producers: Object.freeze([
      ["task user cancellation", "record"],
      ["task create", "legacy"],
      ["task claim/wait/promote", "legacy"],
      ["task completion/failure/recovery/retry", "legacy"],
      ["foreground synthetic task", "legacy"],
      ["trash and attachment cancellation", "legacy"]
    ])
  }),
  thoughtChain: Object.freeze({
    f9Ready: false,
    producers: Object.freeze([
      ["chain update", "record"],
      ["chain delete", "record"],
      ["chain create", "partial"],
      ["thought AI writeback", "record"],
      ["foreground answer", "legacy"],
      ["block/remark/follow-up mutation", "legacy"],
      ["trash restore", "legacy"]
    ])
  })
});

for (const [entity, entry] of Object.entries(coverage)) {
  const names = entry.producers.map(([name]) => name);
  assert.equal(new Set(names).size, names.length, `${entity} producer names must be unique`);
  assert.ok(entry.producers.every(([, route]) => (
    ["record", "partial", "legacy"].includes(route)
  )));
  assert.equal(
    entry.f9Ready,
    entry.producers.every(([, route]) => route === "record"),
    `${entity} F9 readiness must match producer coverage`
  );
}

const [background, thoughtWorkflows, thoughtDomain, trash] = await Promise.all([
  fs.readFile(new URL("../src/app/background-ai.mjs", import.meta.url), "utf8"),
  fs.readFile(new URL("../src/app/thought-workflows.mjs", import.meta.url), "utf8"),
  fs.readFile(new URL("../src/modules/thoughts/index.mjs", import.meta.url), "utf8"),
  fs.readFile(new URL("../src/app/trash.mjs", import.meta.url), "utf8")
]);

assert.match(background, /repository\.update\(store => createInStore/);
assert.match(background, /tasks\.claim\(store\.aiTasks/);
assert.match(background, /tasks\.recover\(store\.aiTasks/);
assert.match(thoughtWorkflows, /saveForegroundAnswer/);
assert.match(thoughtDomain, /createBlock/);
assert.match(trash, /function restoreTrashEntry/);
assert.ok(Object.values(coverage).every(entry => entry.f9Ready === false));

const deferredStore = {
  aiTasks: [{
    id: "deferred-task",
    kind: "thoughtDraft",
    targetId: "draft-target",
    inputVersion: 1,
    requestedInputVersion: 1,
    subtargetVersion: 0,
    requestedSubtargetVersion: 0,
    inputHash: "",
    payload: {},
    status: "queued",
    deferredInputBinding: true,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    attempt: 0
  }],
  notifications: []
};
const scheduled = [];
const now = () => "2026-10-18T00:01:00.000Z";
const backgroundAi = createBackgroundAi({
  repository: {
    read: async () => structuredClone(deferredStore),
    update: async operation => operation(deferredStore)
  },
  tasks: createTaskLifecycle({
    createId: () => "unused",
    now,
    hash: value => String(value)
  }),
  notifications: createNotificationService({
    createId: () => "unused",
    now
  }),
  targets: {
    prepare: () => ({
      inputVersion: 1,
      subtargetVersion: 0,
      inputHash: "bound-input",
      markQueued() {}
    }),
    save: () => "unused",
    result: () => null
  },
  generate: async () => ({ content: "unused" }),
  dispatch: callback => scheduled.push(callback),
  contextKey: () => "coverage",
  onError: error => { throw error; }
});
await backgroundAi.resume();
assert.equal(deferredStore.aiTasks[0].inputHash, "");
assert.equal(deferredStore.aiTasks[0].deferredInputBinding, true);
assert.equal(scheduled.length, 1);

console.log("Record command producer coverage passed: notification, aiTask and thoughtChain remain incomplete and closed to F9.");
