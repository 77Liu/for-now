import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as actionsModule from "../public/frontend/features/actions/index.mjs";
import {
  ACTIONS_ENDPOINT,
  ACTIONS_SELECTORS,
  HABITS_ENDPOINT,
  actionCommandBuilders,
  buildCompleteActionCommand,
  buildCreateActionCommand,
  buildSetActionStatusCommand,
  buildUpdateActionCommand,
  createActionsCoordinator,
  createActionsFeatureController,
  createActionsViewModel,
  projectActionCommand
} from "../public/frontend/features/actions/index.mjs";

const clone = value => structuredClone(value);
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

function action(id, overrides = {}) {
  return {
    id,
    title: `行动-${id}`,
    priority: "P1",
    status: "todo",
    version: 1,
    createdAt: "2026-10-06T08:00:00.000Z",
    updatedAt: "2026-10-06T08:00:00.000Z",
    statusHistory: [],
    ...overrides
  };
}

function habit(id, overrides = {}) {
  return {
    id,
    title: `习惯-${id}`,
    status: "active",
    version: 1,
    frequency: { cadence: "daily", target: 1 },
    ...overrides
  };
}

function createSession(owner = "account-a") {
  let generation = 0;
  let accountId = owner;
  return {
    capture() {
      return Object.freeze({ generation, accountId });
    },
    isCurrent(ticket) {
      return ticket?.generation === generation && ticket?.accountId === accountId;
    },
    activate(nextOwner) {
      generation += 1;
      accountId = nextOwner;
    }
  };
}

function coordinatorWith({
  listAllV1,
  requestV1 = async () => ({ data: null }),
  session = createSession(),
  id = (() => {
    let sequence = 0;
    return () => `request-${++sequence}`;
  })()
} = {}) {
  return createActionsCoordinator({
    listAllV1,
    requestV1,
    session,
    date: () => "2026-10-06",
    id,
    clone
  });
}

const indexUrl = new URL(
  "../public/frontend/features/actions/index.mjs",
  import.meta.url
);
const controllerUrl = new URL(
  "../public/frontend/features/actions/controller.mjs",
  import.meta.url
);
const [indexSource, controllerSource] = await Promise.all([
  readFile(indexUrl, "utf8"),
  readFile(controllerUrl, "utf8")
]);
const originalExports = [
  "actionCommandBuilders",
  "buildCompleteActionCommand",
  "buildCreateActionCommand",
  "buildCreateHabitCommand",
  "buildDeleteActionCommand",
  "buildDeleteHabitCheckinCommand",
  "buildDeleteHabitCommand",
  "buildHabitAdjustmentCommand",
  "buildHabitCheckinCommand",
  "buildSetActionStatusCommand",
  "buildSetHabitEnabledCommand",
  "buildUndoActionCompletionCommand",
  "buildUpdateActionCommand",
  "buildUpdateHabitCheckinCommand",
  "buildUpdateHabitCommand",
  "createActionsViewModel",
  "projectActionCommand"
];
for (const name of originalExports) {
  assert.ok(name in actionsModule, `missing legacy actions export: ${name}`);
}
assert.equal(ACTIONS_ENDPOINT, "/api/v1/actions");
assert.equal(HABITS_ENDPOINT, "/api/v1/habits");
assert.equal(typeof createActionsCoordinator, "function");
assert.equal(typeof createActionsFeatureController, "function");
assert.ok(indexSource.split("\n").length - 1 < 800, "actions/index.mjs exceeds 800 lines");
assert.ok(controllerSource.split("\n").length - 1 < 800, "actions/controller.mjs exceeds 800 lines");
assert.doesNotMatch(controllerSource, /^\s*import\s/m, "controller must use injected ports only");
assert.doesNotMatch(controllerSource, /\b(?:document|window|fetch)\b/);
const localReferences = [
  ...indexSource.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g),
  ...controllerSource.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)
].map(match => match[1]);
assert.deepEqual(localReferences, ["./controller.mjs"]);
assert.throws(() => createActionsCoordinator(), /requires listAllV1/);

// Concurrent reads use a monotonic ticket, so an older response cannot win.
{
  const firstActions = deferred();
  const firstHabits = deferred();
  const secondActions = deferred();
  const secondHabits = deferred();
  let actionReads = 0;
  let habitReads = 0;
  const coordinator = coordinatorWith({
    listAllV1(path) {
      if (path === ACTIONS_ENDPOINT) {
        actionReads += 1;
        return actionReads === 1 ? firstActions.promise : secondActions.promise;
      }
      if (path === HABITS_ENDPOINT) {
        habitReads += 1;
        return habitReads === 1 ? firstHabits.promise : secondHabits.promise;
      }
      throw new Error(`unexpected path: ${path}`);
    }
  });
  const first = coordinator.load();
  const second = coordinator.load();
  secondActions.resolve([action("new")]);
  secondHabits.resolve([]);
  assert.equal(await second, true);
  assert.equal(coordinator.snapshot().actions[0].id, "new");
  firstActions.resolve([action("old")]);
  firstHabits.resolve([]);
  assert.equal(await first, false);
  assert.equal(coordinator.snapshot().actions[0].id, "new");
}

// A -> B -> A is isolated by coordinator generation as well as session identity.
{
  const session = createSession("account-a");
  const oldActions = deferred();
  const oldHabits = deferred();
  const coordinator = coordinatorWith({
    session,
    listAllV1(path) {
      return path === ACTIONS_ENDPOINT ? oldActions.promise : oldHabits.promise;
    }
  });
  const oldLoad = coordinator.load();
  session.activate("account-b");
  coordinator.resetSession();
  session.activate("account-a");
  coordinator.resetSession();
  coordinator.applyIncrementalSnapshot({
    actions: [action("new-a")],
    habits: [],
    habitCheckins: []
  });
  oldActions.resolve([action("old-a")]);
  oldHabits.resolve([]);
  assert.equal(await oldLoad, false);
  assert.equal(coordinator.snapshot().actions[0].id, "new-a");
}

function commandCoordinator({ request, server: initialServer, listFailure = () => false }) {
  const server = clone(initialServer);
  const calls = [];
  const coordinator = coordinatorWith({
    async listAllV1(path) {
      if (listFailure()) throw new Error("refresh unavailable");
      if (path === ACTIONS_ENDPOINT) return clone(server.actions);
      if (path === HABITS_ENDPOINT) return clone(server.habits);
      const habitId = decodeURIComponent(path.split("/")[4] || "");
      return clone(server.habitCheckins.filter(item => item.habitId === habitId));
    },
    async requestV1(path, options, coordination) {
      calls.push({ path, options, coordination });
      return request({ path, options, coordination, server });
    }
  });
  coordinator.applyIncrementalSnapshot(server);
  return { coordinator, calls, server };
}

// Success uses the existing paths/headers, applies queued state and refreshes.
{
  const fixture = commandCoordinator({
    server: {
      actions: [action("a1")],
      habits: [],
      habitCheckins: []
    },
    request({ options, coordination, server }) {
      coordination.onQueued({
        operationId: "operation-success",
        status: "sending",
        createdAt: "2026-10-06T09:00:00.000Z"
      });
      server.actions[0] = action("a1", {
        title: JSON.parse(options.body).title,
        priority: "P0",
        version: 2
      });
      return { data: clone(server.actions[0]) };
    }
  });
  await fixture.coordinator.runCommand(
    buildUpdateActionCommand("a1", { title: "已更新", priority: "P0" }, 1)
  );
  assert.equal(fixture.calls[0].path, "/api/v1/actions/a1");
  assert.equal(fixture.calls[0].options.method, "PATCH");
  assert.equal(fixture.calls[0].options.headers["if-match"], '"1"');
  assert.deepEqual(JSON.parse(fixture.calls[0].options.body), {
    title: "已更新",
    priority: "P0"
  });
  assert.equal(fixture.coordinator.snapshot().actions[0].title, "已更新");
  assert.equal(fixture.coordinator.snapshot().actions[0]._sync, undefined);
}

// Discovery can create an action through the coordinator while today is unmounted.
{
  const fixture = commandCoordinator({
    server: {
      actions: [],
      habits: [],
      habitCheckins: []
    },
    request({ options, server }) {
      const created = action("from-discovery", {
        ...JSON.parse(options.body),
        version: 1
      });
      server.actions.push(created);
      return { data: clone(created) };
    }
  });
  await fixture.coordinator.runCommand(buildCreateActionCommand({
    title: "回访旧记录",
    priority: "none",
    sourceRef: { type: "thought", id: "thought-1", label: "寻迹" }
  }), { idempotencyKey: "discovery-action-request" });
  assert.equal(fixture.calls[0].path, ACTIONS_ENDPOINT);
  assert.equal(
    fixture.calls[0].options.headers["idempotency-key"],
    "discovery-action-request"
  );
  assert.equal(fixture.coordinator.snapshot().actions[0].title, "回访旧记录");
  assert.deepEqual(fixture.coordinator.snapshot().actions[0].sourceRef, {
    type: "thought",
    id: "thought-1",
    label: "寻迹"
  });
}

for (const status of [409, 412]) {
  const fixture = commandCoordinator({
    server: {
      actions: [action(`conflict-${status}`, { title: "服务器版本", version: 2 })],
      habits: [],
      habitCheckins: []
    },
    request() {
      throw Object.assign(new Error("conflict"), {
        status,
        code: status === 412 ? "PRECONDITION_FAILED" : "STATE_CONFLICT",
        details: { currentVersion: 2 }
      });
    }
  });
  await assert.rejects(
    fixture.coordinator.runCommand(
      buildCompleteActionCommand(`conflict-${status}`, 1)
    ),
    error => {
      assert.equal(error.status, status);
      assert.match(error.message, /同步冲突/);
      assert.match(error.message, /版本 2/);
      return true;
    }
  );
  assert.equal(fixture.coordinator.snapshot().actions[0].version, 2);
}

// Offline pending is retained; ordinary failure rolls back the projection.
{
  const pendingFixture = commandCoordinator({
    server: {
      actions: [action("pending")],
      habits: [],
      habitCheckins: []
    },
    request({ coordination }) {
      coordination.onQueued({
        operationId: "operation-pending",
        status: "sending",
        createdAt: "2026-10-06T09:00:00.000Z"
      });
      throw Object.assign(new Error("offline"), { syncStatus: "pending" });
    }
  });
  await assert.rejects(
    pendingFixture.coordinator.runCommand(
      buildSetActionStatusCommand("pending", "doing", 1)
    ),
    error => error.syncStatus === "pending"
  );
  assert.equal(pendingFixture.coordinator.snapshot().actions[0].status, "doing");
  assert.equal(
    pendingFixture.coordinator.snapshot().actions[0]._sync.status,
    "pending"
  );

  const failureFixture = commandCoordinator({
    server: {
      actions: [action("rollback")],
      habits: [],
      habitCheckins: []
    },
    request({ coordination }) {
      coordination.onQueued({
        operationId: "operation-failure",
        status: "sending"
      });
      throw new Error("write failed");
    }
  });
  await assert.rejects(
    failureFixture.coordinator.runCommand(
      buildSetActionStatusCommand("rollback", "doing", 1)
    ),
    /write failed/
  );
  assert.equal(failureFixture.coordinator.snapshot().actions[0].status, "todo");
  assert.equal(failureFixture.coordinator.snapshot().actions[0]._sync, undefined);
}

// A committed projection stays visible when write-after-refresh fails.
{
  let failRefresh = false;
  const fixture = commandCoordinator({
    server: {
      actions: [action("refresh")],
      habits: [],
      habitCheckins: []
    },
    listFailure: () => failRefresh,
    request({ coordination, server }) {
      coordination.onQueued({
        operationId: "operation-refresh",
        status: "sending"
      });
      server.actions[0] = action("refresh", { status: "doing", version: 2 });
      failRefresh = true;
      return { data: clone(server.actions[0]) };
    }
  });
  await assert.rejects(
    fixture.coordinator.runCommand(
      buildSetActionStatusCommand("refresh", "doing", 1)
    ),
    error => error.saved === true
  );
  assert.equal(fixture.coordinator.snapshot().actions[0].status, "doing");
  assert.equal(fixture.coordinator.snapshot().actions[0]._sync.status, "committed");
  assert.equal(fixture.coordinator.snapshot().loadState, "failure");
}

// Pending restoration and incremental merge work without a mounted page.
{
  const coordinator = coordinatorWith({
    async listAllV1() {
      return [];
    }
  });
  coordinator.applyIncrementalSnapshot({
    actions: [action("headless")],
    habits: [habit("h1")],
    habitCheckins: []
  });
  assert.equal(coordinator.applyPendingRecord({
    operationId: "restored-operation",
    status: "pending",
    projection: {
      kind: "action.command",
      command: buildSetActionStatusCommand("headless", "doing", 1)
    }
  }), true);
  assert.equal(coordinator.snapshot().actions[0].status, "doing");
  coordinator.applyIncrementalSnapshot({
    habits: [habit("h1", { title: "增量习惯" })]
  });
  assert.equal(coordinator.snapshot().habits[0].title, "增量习惯");
  assert.equal(coordinator.snapshot().actions[0].status, "doing");
}

// A late command completion from an old A generation cannot start a refresh.
{
  const session = createSession("account-a");
  const write = deferred();
  let listCalls = 0;
  const coordinator = coordinatorWith({
    session,
    async listAllV1() {
      listCalls += 1;
      return [];
    },
    requestV1(path, options, coordination) {
      coordination.onQueued({
        operationId: "old-operation",
        status: "sending"
      });
      return write.promise;
    }
  });
  coordinator.applyIncrementalSnapshot({
    actions: [action("old-command")],
    habits: [],
    habitCheckins: []
  });
  const result = coordinator.runCommand(
    buildSetActionStatusCommand("old-command", "doing", 1)
  );
  session.activate("account-b");
  coordinator.resetSession();
  session.activate("account-a");
  coordinator.resetSession();
  coordinator.applyIncrementalSnapshot({
    actions: [action("new-command")],
    habits: [],
    habitCheckins: []
  });
  write.resolve({ data: action("old-command", { status: "doing" }) });
  assert.equal(await result, false);
  assert.equal(listCalls, 0);
  assert.equal(coordinator.snapshot().actions[0].id, "new-command");
}

class FakeNode {
  constructor(root) {
    this.root = root;
    this.writes = [];
    this._innerHTML = "";
    this._textContent = "";
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.writes.push(["innerHTML", this._innerHTML]);
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    this.writes.push(["textContent", this._textContent]);
  }
}

class FakeControl {
  constructor(root, form, name, value = "") {
    this.root = root;
    this.form = form;
    this.name = name;
    this.writes = [];
    this._value = value;
    this._disabled = false;
  }

  get value() {
    return this._value;
  }

  set value(value) {
    this._value = String(value);
    this.writes.push(["value", this._value]);
  }

  get disabled() {
    return this._disabled;
  }

  set disabled(value) {
    this._disabled = Boolean(value);
    this.writes.push(["disabled", this._disabled]);
  }

  closest() {
    return null;
  }
}

class FakeForm {
  constructor(root, kind) {
    this.root = root;
    this.kind = kind;
    this.dataset = {};
    this.submitButton = new FakeControl(root, this, "submit");
    this.elements = kind === "action"
      ? {
          title: new FakeControl(root, this, "title"),
          priority: new FakeControl(root, this, "priority", "none")
        }
      : {
          title: new FakeControl(root, this, "title"),
          cadence: new FakeControl(root, this, "cadence", "daily"),
          target: new FakeControl(root, this, "target", "1")
        };
    this.elements.namedItem = name => this.elements[name] || null;
  }

  querySelector(selector) {
    return selector === ACTIONS_SELECTORS.submit ? this.submitButton : null;
  }

  reset() {
    this.elements.title.value = "";
    if (this.kind === "action") this.elements.priority.value = "none";
    else {
      this.elements.cadence.value = "daily";
      this.elements.target.value = "1";
      this.elements.target.disabled = true;
    }
  }

  closest() {
    return null;
  }
}

class FakeButton {
  constructor(root, dataset) {
    this.root = root;
    this.dataset = { ...dataset };
    this.disabled = false;
  }

  closest(selector) {
    return selector === ACTIONS_SELECTORS.command ? this : null;
  }
}

class FakeRoot {
  constructor(name) {
    this.name = name;
    this.listeners = new Map();
    this.summary = new FakeNode(this);
    this.actionStatus = new FakeNode(this);
    this.actionColumns = new FakeNode(this);
    this.habitStatus = new FakeNode(this);
    this.habitList = new FakeNode(this);
    this.actionForm = new FakeForm(this, "action");
    this.habitForm = new FakeForm(this, "habit");
  }

  querySelector(selector) {
    const entries = {
      [ACTIONS_SELECTORS.summary]: this.summary,
      [ACTIONS_SELECTORS.actionForm]: this.actionForm,
      [ACTIONS_SELECTORS.actionStatus]: this.actionStatus,
      [ACTIONS_SELECTORS.actionColumns]: this.actionColumns,
      [ACTIONS_SELECTORS.habitForm]: this.habitForm,
      [ACTIONS_SELECTORS.habitStatus]: this.habitStatus,
      [ACTIONS_SELECTORS.habitList]: this.habitList
    };
    return entries[selector] || null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  contains(element) {
    return element?.root === this;
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }

  dispatch(type, target) {
    let prevented = false;
    const event = {
      target,
      preventDefault() {
        prevented = true;
      }
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return prevented;
  }

  input(kind, name, value) {
    const form = kind === "action" ? this.actionForm : this.habitForm;
    form.elements[name].value = value;
    this.dispatch("input", form.elements[name]);
  }

  changeHabit(name, value) {
    this.habitForm.elements[name].value = value;
    this.dispatch("change", this.habitForm.elements[name]);
  }

  submit(kind) {
    return this.dispatch(
      "submit",
      kind === "action" ? this.actionForm : this.habitForm
    );
  }

  click(dataset, root = this) {
    return this.dispatch("click", new FakeButton(root, dataset));
  }

  writeCount() {
    const controls = [
      ...Object.values(this.actionForm.elements),
      ...Object.values(this.habitForm.elements),
      this.actionForm.submitButton,
      this.habitForm.submitButton
    ].filter(value => value instanceof FakeControl);
    return [
      this.summary,
      this.actionStatus,
      this.actionColumns,
      this.habitStatus,
      this.habitList,
      ...controls
    ].reduce((total, node) => total + node.writes.length, 0);
  }
}

function fakeCoordinator({
  runCommand = async () => ({ data: null }),
  initial = {}
} = {}) {
  let requestSequence = 0;
  let state = {
    actions: [],
    habits: [],
    habitCheckins: [],
    today: "2026-10-06",
    loadState: "ready",
    loadError: "",
    revision: 0,
    ...clone(initial)
  };
  const subscribers = new Set();
  let loads = 0;
  const publish = () => {
    state.revision += 1;
    for (const listener of subscribers) listener(clone(state), { type: "fake" });
  };
  return {
    commands: actionCommandBuilders,
    createRequestId() {
      requestSequence += 1;
      return `controller-request-${requestSequence}`;
    },
    viewModel(value) {
      const source = value || state;
      return createActionsViewModel(source, { today: source.today });
    },
    snapshot: () => clone(state),
    async load() {
      loads += 1;
      return true;
    },
    runCommand,
    applyIncrementalSnapshot(snapshot) {
      state = { ...state, ...clone(snapshot) };
      publish();
      return true;
    },
    resetSession() {
      state = {
        actions: [],
        habits: [],
        habitCheckins: [],
        today: "2026-10-06",
        loadState: "idle",
        loadError: "",
        revision: state.revision
      };
      publish();
    },
    subscribe(listener) {
      subscribers.add(listener);
      listener(clone(state), { type: "subscribe" });
      return () => subscribers.delete(listener);
    },
    emit(snapshot) {
      state = { ...state, ...clone(snapshot) };
      publish();
    },
    loadCount: () => loads
  };
}

function createController(coordinator, overrides = {}) {
  return createActionsFeatureController({
    coordinator,
    prompt: () => "",
    confirm: () => true,
    showToast() {},
    ...overrides
  });
}

// The first state notification retries a mount-time read invalidated by session bootstrap.
{
  const session = createSession("pre-bootstrap");
  const oldActions = deferred();
  const oldHabits = deferred();
  let actionReads = 0;
  let habitReads = 0;
  const coordinator = coordinatorWith({
    session,
    listAllV1(path) {
      if (path === ACTIONS_ENDPOINT) {
        actionReads += 1;
        return actionReads === 1
          ? oldActions.promise
          : Promise.resolve([action("bootstrapped")]);
      }
      if (path === HABITS_ENDPOINT) {
        habitReads += 1;
        return habitReads === 1 ? oldHabits.promise : Promise.resolve([]);
      }
      throw new Error(`unexpected path: ${path}`);
    }
  });
  const root = new FakeRoot("bootstrap-order");
  const controller = createController(coordinator);
  controller.mount({ root, signal: new AbortController().signal });
  assert.equal(actionReads, 1);
  session.activate("account-a");
  coordinator.resetSession();
  assert.equal(controller.render({
    snapshot: { bootstrap: true },
    changedDomains: ["actions"]
  }), true);
  await waitFor(
    () => coordinator.snapshot().actions[0]?.id === "bootstrapped",
    "first state render did not replace the invalidated mount read"
  );
  assert.equal(actionReads, 2);
  assert.equal(coordinator.snapshot().loadState, "ready");
  assert.match(root.actionColumns.innerHTML, /行动-bootstrapped/);
  controller.render({ changedDomains: ["actions"] });
  controller.render({ changedDomains: ["actions"] });
  assert.equal(actionReads, 2, "ordinary state notifications repeated the recovery read");
  oldActions.resolve([action("stale-bootstrap")]);
  oldHabits.resolve([]);
  await flush();
  await flush();
  assert.equal(coordinator.snapshot().actions[0].id, "bootstrapped");
  controller.unmount();
}

// Mount/unmount/remount owns exactly one root listener and subscription.
{
  const coordinator = fakeCoordinator({
    initial: {
      actions: [action("render", { title: "<行动>" })],
      habits: [habit("render-habit")]
    }
  });
  const root = new FakeRoot("lifecycle");
  const controller = createController(coordinator);
  for (let cycle = 0; cycle < 12; cycle += 1) {
    const dispose = controller.mount({
      root,
      route: { view: "today", cycle },
      signal: new AbortController().signal
    });
    for (const type of ["input", "change", "submit", "click"]) {
      assert.equal(root.listenerCount(type), 1);
    }
    assert.match(root.actionColumns.innerHTML, /&lt;行动&gt;/);
    assert.match(root.habitList.innerHTML, /习惯-render-habit/);
    dispose();
    dispose();
    for (const type of ["input", "change", "submit", "click"]) {
      assert.equal(root.listenerCount(type), 0);
    }
  }
  assert.equal(coordinator.loadCount(), 12);
}

// Delegation ignores elements outside the mounted root.
{
  const calls = [];
  const coordinator = fakeCoordinator({
    runCommand(command) {
      calls.push(command);
      return Promise.resolve({ data: null });
    },
    initial: { actions: [action("inside")] }
  });
  const root = new FakeRoot("inside");
  const outside = new FakeRoot("outside");
  const controller = createController(coordinator);
  controller.mount({ root, signal: new AbortController().signal });
  root.click({ actionStart: "inside", version: "1" }, outside);
  await flush();
  assert.equal(calls.length, 0);
  root.click({ actionStart: "inside", version: "1" });
  await waitFor(() => calls.length === 1, "inside action click was not delegated");
  assert.equal(calls[0].type, "actions.setStatus");
  controller.unmount();
}

// All existing buttons map to the same command semantics and messages.
{
  const calls = [];
  const promptAnswers = [
    "新标题",
    "P0",
    "完成得很好",
    "降低频率",
    "weekly",
    "3"
  ];
  const coordinator = fakeCoordinator({
    runCommand(command, options) {
      calls.push({ command, options });
      return Promise.resolve({ data: null });
    },
    initial: {
      actions: [action("a1")],
      habits: [habit("h1", { frequency: { cadence: "daily", target: 1 } })],
      habitCheckins: [{
        id: "c1",
        habitId: "h1",
        occurredOn: "2026-10-06",
        version: 1
      }]
    }
  });
  const root = new FakeRoot("commands");
  const controller = createController(coordinator, {
    prompt: () => promptAnswers.shift(),
    confirm: () => true
  });
  controller.mount({ root, signal: new AbortController().signal });
  const buttons = [
    { actionStart: "a1", version: "1" },
    { actionComplete: "a1", version: "1" },
    { actionReopen: "a1", version: "1" },
    { actionEdit: "a1", version: "1" },
    { actionDelete: "a1", version: "1" },
    { habitCheckin: "h1" },
    { habitUncheck: "c1", version: "1" },
    { habitToggle: "h1", enabled: "true", version: "1" },
    { habitAdjust: "h1", version: "1" },
    { habitDelete: "h1", version: "1" }
  ];
  const expected = [
    "actions.setStatus",
    "actions.complete",
    "actions.undoCompletion",
    "actions.update",
    "actions.delete",
    "habitCheckins.create",
    "habitCheckins.delete",
    "habits.setEnabled",
    "habits.recordAdjustment",
    "habits.delete"
  ];
  for (const dataset of buttons) {
    root.click(dataset);
    await waitFor(
      () => calls.length === expected.indexOf(expected[calls.length - 1]) + 1
        || calls.length === buttons.indexOf(dataset) + 1,
      "button command did not settle"
    );
  }
  assert.deepEqual(calls.map(call => call.command.type), expected);
  assert.deepEqual(calls[3].command.input, { title: "新标题", priority: "P0" });
  assert.equal(calls[5].options.idempotencyKey, "controller-request-1");
  assert.deepEqual(calls[5].command.input, {
    occurredOn: "2026-10-06",
    feeling: "完成得很好"
  });
  assert.deepEqual(calls[8].command.input, {
    note: "降低频率",
    frequency: { cadence: "weekly", target: 3 }
  });
  controller.unmount();
}

// Duplicate submit is blocked, idempotency is stable, and pending edits survive.
{
  const post = deferred();
  const calls = [];
  const coordinator = fakeCoordinator({
    runCommand(command, options) {
      calls.push({ command, options });
      return post.promise;
    }
  });
  const root = new FakeRoot("draft");
  const controller = createController(coordinator);
  controller.mount({ root, signal: new AbortController().signal });
  root.input("action", "title", "提交时行动");
  root.input("action", "priority", "P1");
  assert.equal(root.submit("action"), true);
  assert.equal(root.submit("action"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.idempotencyKey, "controller-request-1");
  assert.equal(root.actionForm.dataset.requestId, "controller-request-1");
  assert.equal(root.actionForm.submitButton.disabled, true);
  root.input("action", "title", "等待期间的新行动");
  post.resolve({ data: action("created") });
  await waitFor(
    () => /等待期间的新输入已保留/.test(root.actionStatus.textContent),
    "pending action draft was not preserved"
  );
  assert.equal(root.actionForm.elements.title.value, "等待期间的新行动");
  assert.equal(root.actionForm.submitButton.disabled, false);
  controller.unmount();
}

// A request may finish after remount: the new root settles, the old root stays retired.
{
  const post = deferred();
  const coordinator = fakeCoordinator({
    runCommand() {
      return post.promise;
    }
  });
  const oldRoot = new FakeRoot("pending-old-root");
  const nextRoot = new FakeRoot("pending-next-root");
  const controller = createController(coordinator);
  controller.mount({ root: oldRoot, signal: new AbortController().signal });
  oldRoot.input("action", "title", "跨挂载行动");
  oldRoot.submit("action");
  controller.unmount();
  const oldWrites = oldRoot.writeCount();
  controller.mount({ root: nextRoot, signal: new AbortController().signal });
  assert.equal(nextRoot.actionForm.elements.title.value, "跨挂载行动");
  assert.equal(nextRoot.actionForm.submitButton.disabled, true);
  post.resolve({ data: action("remounted") });
  await waitFor(
    () => nextRoot.actionForm.submitButton.disabled === false,
    "remounted form did not settle after its headless request completed"
  );
  assert.equal(nextRoot.actionForm.elements.title.value, "");
  assert.equal(oldRoot.writeCount(), oldWrites);
  controller.unmount();
}

// An unchanged failed submission reuses its idempotency key.
{
  const calls = [];
  let attempts = 0;
  const coordinator = fakeCoordinator({
    runCommand(command, options) {
      calls.push({ command, options });
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("提交失败"));
      return Promise.resolve({ data: action("retried") });
    }
  });
  const root = new FakeRoot("retry");
  const controller = createController(coordinator);
  controller.mount({ root, signal: new AbortController().signal });
  root.input("action", "title", "幂等行动");
  root.submit("action");
  await waitFor(() => root.actionStatus.textContent === "提交失败", "failure not shown");
  root.submit("action");
  await waitFor(() => root.actionForm.elements.title.value === "", "retry did not settle");
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].options.idempotencyKey,
    calls[1].options.idempotencyKey
  );
  controller.unmount();
}

// Habit form behavior keeps cadence/target handling and submission idempotency.
{
  const calls = [];
  const coordinator = fakeCoordinator({
    runCommand(command, options) {
      calls.push({ command, options });
      return Promise.resolve({ data: habit("created") });
    }
  });
  const root = new FakeRoot("habit-form");
  const controller = createController(coordinator);
  controller.mount({ root, signal: new AbortController().signal });
  root.input("habit", "title", "每周阅读");
  root.changeHabit("cadence", "weekly");
  root.input("habit", "target", "3");
  root.submit("habit");
  await waitFor(() => root.habitForm.elements.title.value === "", "habit did not reset");
  assert.deepEqual(calls[0].command, {
    type: "habits.create",
    input: {
      title: "每周阅读",
      frequency: { cadence: "weekly", target: 3 }
    }
  });
  assert.equal(calls[0].options.idempotencyKey, "controller-request-1");
  assert.equal(root.habitForm.elements.cadence.value, "daily");
  assert.equal(root.habitForm.elements.target.value, "1");
  assert.equal(root.habitForm.elements.target.disabled, true);
  controller.unmount();
}

// Reset scrubs every private field and blocks late completion writes.
{
  const post = deferred();
  const coordinator = fakeCoordinator({
    runCommand() {
      return post.promise;
    },
    initial: {
      actions: [action("private")],
      habits: [habit("private")]
    }
  });
  const root = new FakeRoot("reset");
  const toasts = [];
  const controller = createController(coordinator, {
    showToast(message) {
      toasts.push(message);
    }
  });
  controller.mount({ root, signal: new AbortController().signal });
  root.input("action", "title", "账户 A 私有草稿");
  root.submit("action");
  assert.ok(root.actionForm.dataset.requestId);
  controller.resetSession();
  const writesAfterReset = root.writeCount();
  assert.equal(root.actionForm.elements.title.value, "");
  assert.equal(root.actionForm.elements.priority.value, "none");
  assert.equal(root.habitForm.elements.title.value, "");
  assert.equal(root.habitForm.elements.cadence.value, "daily");
  assert.equal(root.habitForm.elements.target.value, "1");
  assert.equal(root.actionForm.dataset.requestId, undefined);
  assert.equal(root.actionStatus.textContent, "");
  assert.equal(root.habitStatus.textContent, "");
  assert.equal(root.summary.textContent, "");
  assert.equal(root.actionColumns.innerHTML, "");
  assert.equal(root.habitList.innerHTML, "");
  for (const type of ["input", "change", "submit", "click"]) {
    assert.equal(root.listenerCount(type), 0);
  }
  post.resolve({ data: action("late") });
  await flush();
  await flush();
  assert.equal(root.writeCount(), writesAfterReset);
  assert.deepEqual(toasts, []);
}

// Unmount removes old activation writes while the headless operation may finish.
{
  const post = deferred();
  const coordinator = fakeCoordinator({
    runCommand() {
      return post.promise;
    }
  });
  const oldRoot = new FakeRoot("old-activation");
  const controller = createController(coordinator);
  controller.mount({ root: oldRoot, signal: new AbortController().signal });
  oldRoot.input("action", "title", "离页行动");
  oldRoot.submit("action");
  controller.unmount();
  const writesAfterUnmount = oldRoot.writeCount();
  post.resolve({ data: action("late-unmount") });
  await flush();
  await flush();
  assert.equal(oldRoot.writeCount(), writesAfterUnmount);
}

console.log(
  "Frontend actions feature checks passed: exports/closure budget, load ordering, "
  + "session ABA, command outcomes, headless pending/incremental state, root lifecycle, "
  + "delegation, drafts/idempotency, reset scrub and stale activation isolation."
);
