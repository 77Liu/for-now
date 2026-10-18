/**
 * 验证首批记录命令的生产者覆盖与既有后台输入绑定边界。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：合成状态与只读源码检查，不启用 F9 或访问生产。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./project-root.mjs";
import type { RecordEntity, RecordStore } from "../src/shared/persistence/record-command-types.mjs";
const root = projectRoot(import.meta.url);
// Legacy background services cross an explicit test boundary; domain commands compile in backend.
interface BackgroundOptions {
  repository: { read(): Promise<RecordStore>; update<T>(operation: (store: RecordStore) => T): Promise<T> };
  tasks: unknown;
  notifications: unknown;
  targets: { prepare(): { inputVersion: number; subtargetVersion: number; inputHash: string; markQueued(): void }; save(): string; result(): null };
  generate(): Promise<{ content: string }>;
  dispatch(callback: () => unknown): void;
  contextKey(): string;
  onError(error: Error): void;
}
const { createBackgroundAi }: { createBackgroundAi(options: BackgroundOptions): { resume(): Promise<void> } } =
  await import(pathToFileURL(path.join(root, "src/app/index.mjs")).href);
const { createNotificationService }: { createNotificationService(options: { createId(): string; now(): string }): unknown } =
  await import(pathToFileURL(path.join(root, "src/modules/notifications/index.mjs")).href);
const { createTaskLifecycle }: { createTaskLifecycle(options: { createId(): string; now(): string; hash(value: unknown): string }): unknown } =
  await import(pathToFileURL(path.join(root, "src/modules/tasks/index.mjs")).href);

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
  fs.readFile(path.join(root, "src/app/background-ai.mjs"), "utf8"),
  fs.readFile(path.join(root, "src/app/thought-workflows.mjs"), "utf8"),
  fs.readFile(path.join(root, "src/modules/thoughts/index.mjs"), "utf8"),
  fs.readFile(path.join(root, "src/app/trash.mjs"), "utf8")
]);

assert.match(background, /repository\.update\(store => createInStore/);
assert.match(background, /tasks\.claim\(store\.aiTasks/);
assert.match(background, /tasks\.recover\(store\.aiTasks/);
assert.match(thoughtWorkflows, /saveForegroundAnswer/);
assert.match(thoughtDomain, /createBlock/);
assert.match(trash, /function restoreTrashEntry/);
assert.ok(Object.values(coverage).every(entry => entry.f9Ready === false));

const deferredStore: { aiTasks: RecordEntity[]; notifications: RecordEntity[] } = {
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
const scheduled: (() => unknown)[] = [];
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
