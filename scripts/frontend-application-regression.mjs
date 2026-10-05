import assert from "node:assert/strict";
import { createBrowserApplication } from "../public/frontend/app/application.mjs";
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}
async function assertSettles(promise, message) {
  let outcome = null;
  promise.then(
    value => {
      outcome = { value };
    },
    error => {
      outcome = { error };
    }
  );
  await waitFor(() => outcome !== null, message);
  if (outcome.error) throw outcome.error;
  return outcome.value;
}
async function settleWithin(promise, message) {
  let timeoutId;
  const settled = Promise.resolve(promise).then(
    value => ({ status: "fulfilled", value }),
    error => ({ status: "rejected", error })
  );
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), 500);
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}
function errorMessages(error) {
  return error instanceof AggregateError
    ? error.errors.map(item => item.message)
    : [error.message];
}
function assertSelfReference(error, label, lifecycle) {
  assert.equal(error.name, "LifecycleSelfReferenceError");
  assert.match(error.message, /lifecycle self-reference/);
  assert.ok(error.message.includes(label));
  assert.ok(error.message.includes(`current ${lifecycle} promise`));
}
function assertPortTimeout(error, label, timeoutMs = 20) {
  assert.equal(error.name, "LifecyclePortTimeoutError");
  assert.ok(error.message.includes(label));
  assert.ok(error.message.includes(`${timeoutMs}ms`));
}
function createFixture({
  failures = {},
  disposerFailures = new Set()
} = {}) {
  const events = [];
  const disposals = [];
  const routeHandlers = [];
  const stateListeners = [];
  let route = { view: "home", id: "route-1" };
  let snapshot = { account: "one" };
  const fail = name => {
    if (failures[name]) throw new Error(failures[name]);
  };
  const disposer = name => () => {
    disposals.push(name);
    if (disposerFailures.has(name)) throw new Error(`${name} dispose failed`);
  };
  const router = {
    start(handlers, signal) {
      assert.equal(arguments.length, 2);
      assert.ok(signal instanceof AbortSignal);
      assert.deepEqual(Object.keys(handlers).sort(), ["enter", "leave"]);
      events.push("router.start");
      routeHandlers.push(handlers);
      fail("router.start");
      return disposer("router");
    },
    currentRoute() {
      return route;
    }
  };
  const featureRegistry = {
    async enter(view, nextRoute) {
      events.push(`feature.enter:${view}:${nextRoute.id}`);
      fail("feature.enter");
    },
    async leave(view) {
      events.push(`feature.leave:${view}`);
      fail("feature.leave");
    },
    notifyState(nextSnapshot, changedDomains) {
      const domains = changedDomains == null ? "*" : [...changedDomains].join(",");
      events.push(`feature.notify:${nextSnapshot.account}:${domains}`);
      fail("feature.notifyState");
    },
    async resetSession() {
      events.push("feature.resetSession");
      fail("feature.resetSession");
    },
    async stop() {
      events.push("feature.stop");
      fail("feature.stop");
    }
  };
  const session = {
    resetSession() {
      events.push("session.resetSession");
      fail("session.resetSession");
    }
  };
  const state = {
    start(initialState, signal) {
      assert.equal(arguments.length, 2);
      assert.ok(signal instanceof AbortSignal);
      snapshot = initialState;
      events.push(`state.start:${initialState.account}`);
      fail("state.start");
      return disposer("state.start");
    },
    subscribe(listener) {
      events.push("state.subscribe");
      stateListeners.push(listener);
      fail("state.subscribe");
      return disposer("state.subscribe");
    },
    snapshot() {
      return snapshot;
    },
    async resetSession() {
      events.push("state.resetSession");
      fail("state.resetSession");
      snapshot = { account: "reset" };
    },
    async stop() {
      events.push("state.stop");
      fail("state.stop");
    }
  };
  const sync = {
    start(initialSync, signal) {
      assert.equal(arguments.length, 2);
      assert.ok(signal instanceof AbortSignal);
      events.push(`sync.start:${initialSync.account}`);
      fail("sync.start");
      return disposer("sync");
    },
    async resetSession() {
      events.push("sync.resetSession");
      fail("sync.resetSession");
    },
    async stop() {
      events.push("sync.stop");
      fail("sync.stop");
    }
  };
  const shell = {
    start(initialShell, signal) {
      assert.equal(arguments.length, 2);
      assert.ok(signal instanceof AbortSignal);
      events.push(`shell.start:${initialShell.account}`);
      fail("shell.start");
      return disposer("shell");
    },
    async resetSession() {
      events.push("shell.resetSession");
      fail("shell.resetSession");
    },
    async stop() {
      events.push("shell.stop");
      fail("shell.stop");
    }
  };
  return {
    ports: { router, featureRegistry, session, state, sync, shell },
    events,
    disposals,
    routeHandlers,
    stateListeners,
    setRoute(nextRoute) {
      route = nextRoute;
    },
    setSnapshot(nextSnapshot) {
      snapshot = nextSnapshot;
    }
  };
}
const initial = account => ({
  state: { account },
  sync: { account },
  shell: { account },
  ignoredUniversalContext: { mustNotReachPorts: true }
});
{
  const fixture = createFixture();
  const application = createBrowserApplication(fixture.ports);
  assert.deepEqual(Object.keys(application).sort(), ["resetSession", "start", "stop"]);
  const firstStart = application.start(initial("one"));
  const repeatedStart = application.start(initial("ignored"));
  assert.equal(firstStart, repeatedStart, "repeated start must share one lifecycle promise");
  await firstStart;
  assert.deepEqual(fixture.events, [
    "router.start",
    "feature.enter:home:route-1",
    "state.start:one",
    "state.subscribe",
    "feature.notify:one:*",
    "sync.start:one",
    "shell.start:one"
  ]);
  await fixture.routeHandlers[0].enter({ view: "settings", id: "route-2" });
  await fixture.routeHandlers[0].leave({ view: "settings", id: "route-2" });
  fixture.setSnapshot({ account: "one-updated" });
  fixture.stateListeners[0]({ account: "one-updated" }, new Set(["captures", "thoughts"]));
  assert.deepEqual(fixture.events.slice(-3), [
    "feature.enter:settings:route-2",
    "feature.leave:settings",
    "feature.notify:one-updated:captures,thoughts"
  ]);
  const oldRouteHandlers = fixture.routeHandlers[0];
  const oldStateListener = fixture.stateListeners[0];
  const firstReset = application.resetSession();
  const repeatedReset = application.resetSession();
  assert.equal(firstReset, repeatedReset, "repeated reset must share one lifecycle promise");
  await firstReset;
  assert.deepEqual(fixture.disposals, [
    "shell",
    "sync",
    "state.subscribe",
    "state.start",
    "router"
  ]);
  assert.deepEqual(fixture.events.slice(-5), [
    "session.resetSession",
    "sync.resetSession",
    "feature.resetSession",
    "state.resetSession",
    "shell.resetSession"
  ]);
  const eventCountAfterReset = fixture.events.length;
  await oldRouteHandlers.enter({ view: "private", id: "old-route" });
  await oldRouteHandlers.leave({ view: "private", id: "old-route" });
  oldStateListener({ account: "old-session" }, new Set(["private"]));
  assert.equal(
    fixture.events.length,
    eventCountAfterReset,
    "callbacks retained by an old port must not reach the next session"
  );
  fixture.setRoute({ view: "books", id: "route-3" });
  await application.start(initial("two"));
  assert.deepEqual(fixture.events.slice(-7), [
    "router.start",
    "feature.enter:books:route-3",
    "state.start:two",
    "state.subscribe",
    "feature.notify:two:*",
    "sync.start:two",
    "shell.start:two"
  ]);
  const firstStop = application.stop();
  const repeatedStop = application.stop();
  assert.equal(firstStop, repeatedStop, "stop must be idempotent");
  await firstStop;
  assert.deepEqual(fixture.events.slice(-5), [
    "session.resetSession",
    "shell.stop",
    "sync.stop",
    "state.stop",
    "feature.stop"
  ]);
  assert.deepEqual(fixture.disposals.slice(-5), [
    "shell",
    "sync",
    "state.subscribe",
    "state.start",
    "router"
  ]);
  assert.equal(application.stop(), firstStop);
  await assert.rejects(application.start(initial("three")), /stopped/);
}
{
  const fixture = createFixture({
    failures: {
      "shell.start": "shell start failed",
      "sync.resetSession": "sync reset failed"
    },
    disposerFailures: new Set(["router"])
  });
  const application = createBrowserApplication(fixture.ports);
  await assert.rejects(
    application.start(initial("failure")),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(errorMessages(error), [
        "shell start failed",
        "router dispose failed",
        "sync reset failed"
      ]);
      assert.equal(error.cause?.message, "shell start failed");
      return true;
    }
  );
  for (const expected of [
    "session.resetSession",
    "feature.resetSession",
    "state.resetSession",
    "shell.resetSession"
  ]) {
    assert.ok(fixture.events.includes(expected), `${expected} must run after start failure`);
  }
  assert.deepEqual(fixture.disposals, [
    "sync",
    "state.subscribe",
    "state.start",
    "router"
  ]);
  await assert.rejects(application.start(initial("blocked-after-start-cleanup")), error => {
    assert.match(error.message, /locked after cleanup failure/);
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(errorMessages(error.cause), [
      "router dispose failed",
      "sync reset failed"
    ]);
    return true;
  });
  const stop = application.stop();
  assert.equal(application.stop(), stop, "locked application stop must remain idempotent");
  await stop;
}
{
  const fixture = createFixture({
    failures: {
      "shell.stop": "shell stop failed",
      "feature.stop": "feature stop failed"
    },
    disposerFailures: new Set(["state.subscribe"])
  });
  const application = createBrowserApplication(fixture.ports);
  await application.start(initial("stop-failure"));
  const stop = application.stop();
  await assert.rejects(stop, error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(errorMessages(error), [
      "state.subscribe dispose failed",
      "shell stop failed",
      "feature stop failed"
    ]);
    return true;
  });
  assert.equal(application.stop(), stop);
  for (const expected of [
    "session.resetSession",
    "sync.stop",
    "state.stop"
  ]) {
    assert.ok(fixture.events.includes(expected), `${expected} must run despite cleanup failures`);
  }
  assert.equal(
    fixture.events.filter(event => event === "shell.stop").length,
    1,
    "idempotent stop must not repeat cleanup after rejection"
  );
}
{
  const fixture = createFixture({
    failures: {
      "sync.resetSession": "sync reset failed",
      "shell.resetSession": "shell reset failed"
    },
    disposerFailures: new Set(["sync"])
  });
  const application = createBrowserApplication(fixture.ports);
  await application.start(initial("reset-failure"));
  const oldRouteHandlers = fixture.routeHandlers[0];
  const oldStateListener = fixture.stateListeners[0];
  const reset = application.resetSession();
  let resetFailure;
  await assert.rejects(reset, error => {
    resetFailure = error;
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(errorMessages(error), [
      "sync dispose failed",
      "sync reset failed",
      "shell reset failed"
    ]);
    return true;
  });
  assert.equal(application.resetSession(), reset);
  for (const expected of [
    "feature.resetSession",
    "state.resetSession"
  ]) {
    assert.ok(fixture.events.includes(expected), `${expected} must run despite reset failures`);
  }
  const eventCountAfterReset = fixture.events.length;
  await oldRouteHandlers.enter({ view: "private", id: "stale-after-failed-reset" });
  oldStateListener({ account: "old-session" }, new Set(["private"]));
  assert.equal(
    fixture.events.length,
    eventCountAfterReset,
    "failed reset must still isolate callbacks from the previous session"
  );
  await assert.rejects(application.start(initial("blocked-after-reset")), error => {
    assert.match(error.message, /locked after cleanup failure/);
    assert.equal(error.cause, resetFailure, "locked start must preserve the cleanup failure");
    return true;
  });
  const stop = application.stop();
  assert.equal(application.stop(), stop, "stop after failed reset must remain idempotent");
  await stop;
  assert.equal(
    fixture.events.filter(event => event === "shell.stop").length,
    1,
    "locked stop must clean each stop port exactly once"
  );
}
for (const scenario of [
  {
    label: "router disposer",
    fixtureOptions: { disposerFailures: new Set(["router"]) },
    expectedFailure: "router dispose failed"
  },
  {
    label: "reset port",
    fixtureOptions: { failures: { "state.resetSession": "state reset failed" } },
    expectedFailure: "state reset failed"
  }
]) {
  const fixture = createFixture(scenario.fixtureOptions);
  const application = createBrowserApplication(fixture.ports);
  await application.start(initial(`lock-${scenario.label}`));
  const reset = application.resetSession();
  let resetFailure;
  await assert.rejects(reset, error => {
    resetFailure = error;
    assert.deepEqual(errorMessages(error), [scenario.expectedFailure]);
    return true;
  });
  assert.equal(application.resetSession(), reset, "failed reset must remain idempotent");
  await assert.rejects(application.start(initial("must-not-restart")), error => {
    assert.match(error.message, /locked after cleanup failure/);
    assert.equal(error.cause, resetFailure);
    return true;
  });
  const stop = application.stop();
  assert.equal(application.stop(), stop, `stop after ${scenario.label} failure must be idempotent`);
  await stop;
  assert.equal(
    fixture.events.filter(event => event === "shell.stop").length,
    1,
    `stop after ${scenario.label} failure must clean stop ports once`
  );
}
{
  const fixture = createFixture({
    failures: { "feature.enter": "route enter failed" }
  });
  const application = createBrowserApplication(fixture.ports);
  await assert.rejects(application.start(initial("enter-failure")), error => {
    assert.equal(error.message, "route enter failed");
    assert.equal(error instanceof AggregateError, false);
    return true;
  });
  assert.deepEqual(fixture.disposals, ["router"]);
  assert.ok(fixture.events.includes("feature.resetSession"));
  assert.equal(fixture.events.includes("state.start:enter-failure"), false);
}
{
  const resetGate = deferred();
  const fixture = createFixture();
  const routerStart = fixture.ports.router.start;
  let application;
  let queuedFromAbort;
  fixture.ports.router.start = function startRouter(handlers, signal) {
    const dispose = routerStart.call(this, handlers, signal);
    signal.addEventListener("abort", () => {
      queuedFromAbort ||= application.start(initial("after-reset"));
    }, { once: true });
    return dispose;
  };
  fixture.ports.sync.resetSession = () => {
    fixture.events.push("sync.resetSession");
    return resetGate.promise;
  };
  application = createBrowserApplication(fixture.ports);
  const firstStart = application.start(initial("before-reset"));
  await firstStart;
  const reset = application.resetSession();
  assert.notEqual(
    queuedFromAbort,
    firstStart,
    "start re-entered from reset abort must not reuse the completed start"
  );
  assert.equal(
    application.start(initial("ignored")),
    queuedFromAbort,
    "starts queued during one reset must share a promise"
  );
  await waitFor(
    () => fixture.events.includes("sync.resetSession"),
    "gated reset did not reach sync.resetSession"
  );
  await flush();
  assert.equal(
    fixture.events.filter(event => event === "router.start").length,
    1,
    "queued start must not create a candidate before reset completes"
  );
  resetGate.resolve();
  await reset;
  await queuedFromAbort;
  const secondRouterStart = fixture.events.lastIndexOf("router.start");
  assert.ok(
    secondRouterStart > fixture.events.lastIndexOf("shell.resetSession"),
    "queued start must begin after every reset port completes"
  );
  assert.equal(
    fixture.events.filter(event => event === "router.start").length,
    2,
    "queued start must create exactly one new candidate"
  );
}
{
  const fixture = createFixture();
  const shellStart = fixture.ports.shell.start;
  const sessionReset = fixture.ports.session.resetSession;
  let shellStarts = 0;
  let application;
  let appendedReset;
  let queuedRestart;
  let repeatedRestart;
  fixture.ports.shell.start = function startShell(initialShell, signal) {
    const dispose = shellStart.call(this, initialShell, signal);
    shellStarts += 1;
    if (shellStarts === 1) throw new Error("first shell start failed");
    return dispose;
  };
  fixture.ports.session.resetSession = function resetSession() {
    sessionReset.call(this);
    if (queuedRestart) return;
    queuedRestart = application.start(initial("queued-after-failed-start"));
    appendedReset = application.resetSession();
    repeatedRestart = application.start(initial("ignored-restart"));
  };
  application = createBrowserApplication(fixture.ports);
  const failedStart = application.start(initial("fails-before-internal-cleanup"));
  await assert.rejects(failedStart, /first shell start failed/);
  assert.equal(
    repeatedRestart,
    queuedRestart,
    "an appended reset must retain the restart queued on internal cleanup"
  );
  await appendedReset;
  await queuedRestart;
  assert.equal(
    fixture.events.filter(event => event === "router.start").length,
    2,
    "old reset completion must not invalidate the queued restart candidate"
  );
  assert.equal(
    application.start(initial("ignored-after-restart")),
    queuedRestart,
    "successful queued restart must remain the published lifecycle promise"
  );
  await application.stop();
}
{
  const resetGate = deferred();
  const fixture = createFixture({
    failures: { "shell.stop": "shell stop failed during reset" }
  });
  fixture.ports.sync.resetSession = () => {
    fixture.events.push("sync.resetSession");
    return resetGate.promise;
  };
  const application = createBrowserApplication(fixture.ports);
  await application.start(initial("reset-then-stop"));
  const reset = application.resetSession();
  await waitFor(
    () => fixture.events.includes("sync.resetSession"),
    "gated reset did not begin"
  );
  const stop = application.stop();
  assert.equal(application.stop(), stop, "stop during reset must remain idempotent");
  await flush();
  assert.equal(
    fixture.events.includes("shell.stop"),
    false,
    "stop ports must wait for the active reset"
  );
  const resetFailure = assert.rejects(reset, error => {
    assert.deepEqual(errorMessages(error), ["sync reset failed during stop"]);
    return true;
  });
  const stopFailure = assert.rejects(stop, error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(errorMessages(error), [
      "sync reset failed during stop",
      "shell stop failed during reset"
    ]);
    return true;
  });
  resetGate.reject(new Error("sync reset failed during stop"));
  await Promise.all([resetFailure, stopFailure]);
  assert.ok(
    fixture.events.indexOf("shell.resetSession") < fixture.events.indexOf("shell.stop"),
    "all reset ports must finish before stop ports begin"
  );
}
{
  const fixture = createFixture();
  const routerStart = fixture.ports.router.start;
  let application;
  let reentrantStart;
  fixture.ports.router.start = function startRouter(handlers, signal) {
    const dispose = routerStart.call(this, handlers, signal);
    reentrantStart = application.start(initial("reentrant-start"));
    return dispose;
  };
  application = createBrowserApplication(fixture.ports);
  const start = application.start(initial("outer-start"));
  assert.equal(
    reentrantStart,
    start,
    "start promise must be published before router.start can re-enter"
  );
  await start;
  assert.equal(
    fixture.events.filter(event => event === "router.start").length,
    1,
    "synchronous start re-entry must not create a second candidate"
  );
}
{
  const fixture = createFixture();
  const routerStart = fixture.ports.router.start;
  let application;
  let resetFromAbort;
  let resetFromSession;
  fixture.ports.router.start = function startRouter(handlers, signal) {
    const dispose = routerStart.call(this, handlers, signal);
    signal.addEventListener("abort", () => {
      resetFromAbort = application.resetSession();
    }, { once: true });
    return dispose;
  };
  fixture.ports.session.resetSession = () => {
    fixture.events.push("session.resetSession");
    resetFromSession = application.resetSession();
  };
  application = createBrowserApplication(fixture.ports);
  await application.start(initial("reentrant-reset"));
  const reset = application.resetSession();
  assert.equal(
    resetFromAbort,
    reset,
    "reset promise must be published before abort listeners can re-enter"
  );
  await waitFor(() => resetFromSession !== undefined, "session reset callback did not run");
  assert.equal(
    resetFromSession,
    reset,
    "reset promise must be published before session.resetSession can re-enter"
  );
  await reset;
  assert.equal(
    fixture.events.filter(event => event === "session.resetSession").length,
    1,
    "synchronous reset re-entry must not repeat cleanup"
  );
}
{
  const fixture = createFixture();
  const routerStart = fixture.ports.router.start;
  let application;
  let stopFromAbort;
  let stopFromSession;
  fixture.ports.router.start = function startRouter(handlers, signal) {
    const dispose = routerStart.call(this, handlers, signal);
    signal.addEventListener("abort", () => {
      stopFromAbort = application.stop();
    }, { once: true });
    return dispose;
  };
  fixture.ports.session.resetSession = () => {
    fixture.events.push("session.resetSession");
    stopFromSession = application.stop();
  };
  application = createBrowserApplication(fixture.ports);
  await application.start(initial("reentrant-stop"));
  const stop = application.stop();
  assert.equal(
    stopFromAbort,
    stop,
    "stop promise must be published before abort listeners can re-enter"
  );
  await waitFor(() => stopFromSession !== undefined, "stop session callback did not run");
  assert.equal(
    stopFromSession,
    stop,
    "stop promise must be published before session.resetSession can re-enter"
  );
  await stop;
  assert.equal(
    fixture.events.filter(event => event === "shell.stop").length,
    1,
    "synchronous stop re-entry must not repeat cleanup"
  );
}
{
  const startGate = deferred();
  const fixture = createFixture();
  const signals = [];
  fixture.ports.state.start = function startState(initialState, signal) {
    assert.equal(arguments.length, 2);
    fixture.events.push(`state.start:${initialState.account}`);
    signals.push(signal);
    return startGate.promise;
  };
  const application = createBrowserApplication(fixture.ports);
  const pendingStart = application.start(initial("pending-state-reset"));
  await waitFor(
    () => fixture.events.includes("state.start:pending-state-reset"),
    "pending state.start did not begin"
  );
  const reset = application.resetSession();
  await assertSettles(reset, "reset must not wait for pending state.start");
  assert.equal(signals[0].aborted, true);
  assert.equal(fixture.disposals.includes("late-state"), false);
  startGate.resolve(() => fixture.disposals.push("late-state"));
  await assert.rejects(pendingStart, error => error?.name === "AbortError");
  await waitFor(
    () => fixture.disposals.includes("late-state"),
    "late state.start disposer was not executed"
  );
  assert.equal(
    fixture.disposals.filter(name => name === "late-state").length,
    1,
    "late state.start disposer must execute exactly once"
  );
  assert.equal(application.resetSession(), reset);
}
{
  const startGate = deferred();
  const fixture = createFixture();
  const signals = [];
  fixture.ports.shell.start = function startShell(initialShell, signal) {
    assert.equal(arguments.length, 2);
    fixture.events.push(`shell.start:${initialShell.account}`);
    signals.push(signal);
    return startGate.promise;
  };
  const application = createBrowserApplication(fixture.ports);
  const pendingStart = application.start(initial("pending-shell-stop"));
  await waitFor(
    () => fixture.events.includes("shell.start:pending-shell-stop"),
    "pending shell.start did not begin"
  );
  const stop = application.stop();
  await assertSettles(stop, "stop must not wait for pending shell.start");
  assert.equal(signals[0].aborted, true);
  assert.equal(fixture.disposals.includes("late-shell"), false);
  startGate.resolve(() => fixture.disposals.push("late-shell"));
  await assert.rejects(pendingStart, error => error?.name === "AbortError");
  await waitFor(
    () => fixture.disposals.includes("late-shell"),
    "late shell.start disposer was not executed"
  );
  assert.equal(
    fixture.disposals.filter(name => name === "late-shell").length,
    1,
    "late shell.start disposer must execute exactly once"
  );
  assert.equal(application.stop(), stop);
  await stop;
}
{
  const enterGate = deferred();
  const fixture = createFixture();
  fixture.ports.featureRegistry.enter = (view, nextRoute) => {
    fixture.events.push(`feature.enter:${view}:${nextRoute.id}`);
    return enterGate.promise;
  };
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const application = createBrowserApplication(fixture.ports);
    application.start(initial("late-rejection"));
    await waitFor(
      () => fixture.events.includes("feature.enter:home:route-1"),
      "pending feature enter did not begin"
    );
    const reset = application.resetSession();
    await assertSettles(reset, "reset must not wait for pending feature enter");
    enterGate.reject(new Error("late feature enter failed"));
    await flush();
    await flush();
    assert.deepEqual(unhandled, []);
    assert.equal(application.resetSession(), reset);
    await reset;
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}
for (const scenario of [
  ["router.start", "router", "start"],
  ["state.start", "state", "start"],
  ["sync.start", "sync", "start"],
  ["shell.start", "shell", "start"]
]) {
  const [label, portName, method] = scenario;
  const gate = deferred();
  const fixture = createFixture();
  fixture.ports[portName][method] = () => {
    fixture.events.push(`${label}:pending`);
    return gate.promise;
  };
  const application = createBrowserApplication({
    ...fixture.ports,
    lifecyclePortTimeoutMs: 20
  });
  const start = application.start(initial(`post-timeout-${portName}`));
  await assert.rejects(start, error => {
    assertPortTimeout(error, label);
    return true;
  });
  const disposal = `post-timeout-${portName}`;
  assert.equal(fixture.disposals.includes(disposal), false);
  gate.resolve(() => fixture.disposals.push(disposal));
  await waitFor(
    () => fixture.disposals.includes(disposal),
    `${label} post-timeout disposer was not executed`
  );
  await flush();
  assert.equal(
    fixture.disposals.filter(name => name === disposal).length,
    1,
    `${label} post-timeout disposer must execute exactly once`
  );
  await application.stop();
}
for (const scenario of [
  ["router.start", "router", "start"],
  ["featureRegistry.enter", "featureRegistry", "enter"]
]) {
  const [label, portName, method] = scenario;
  const gate = deferred();
  const fixture = createFixture();
  const original = fixture.ports[portName][method];
  fixture.ports[portName][method] = () => {
    fixture.events.push(`${label}:pending-rejection`);
    return gate.promise;
  };
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const application = createBrowserApplication({
      ...fixture.ports,
      lifecyclePortTimeoutMs: 20
    });
    await assert.rejects(application.start(initial(`late-rejection-${portName}`)), error => {
      assertPortTimeout(error, label);
      return true;
    });
    fixture.ports[portName][method] = original;
    gate.reject(new Error(`${label} rejected after timeout`));
    await flush();
    await flush();
    assert.deepEqual(unhandled, []);
    await application.start(initial(`retry-${portName}`));
    await application.stop();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}
{
  const gate = deferred();
  const fixture = createFixture();
  fixture.ports.router.start = () => {
    fixture.events.push("router.start:pending-failed-disposer");
    return gate.promise;
  };
  const application = createBrowserApplication({
    ...fixture.ports,
    lifecyclePortTimeoutMs: 20
  });
  await assert.rejects(application.start(initial("late-disposer-failure")), error => {
    assertPortTimeout(error, "router.start");
    return true;
  });
  gate.resolve(() => {
    fixture.disposals.push("post-timeout-failed-router");
    throw new Error("post-timeout router dispose failed");
  });
  await waitFor(
    () => fixture.disposals.includes("post-timeout-failed-router"),
    "failed post-timeout disposer was not executed"
  );
  await assert.rejects(application.start(initial("blocked-by-late-disposer")), error => {
    assert.match(error.message, /locked after cleanup failure/);
    assert.deepEqual(errorMessages(error.cause), ["post-timeout router dispose failed"]);
    return true;
  });
  await application.stop();
}
{
  const fixture = createFixture({
    disposerFailures: new Set(["router"])
  });
  let application;
  fixture.ports.featureRegistry.enter = (view, nextRoute) => {
    fixture.events.push(`feature.enter:${view}:${nextRoute.id}`);
    return application.start(initial("self-referential-feature"));
  };
  application = createBrowserApplication(fixture.ports);
  const start = application.start(initial("self-referential-start"));
  const outcome = await settleWithin(start, "self-referential start did not settle");
  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.error instanceof AggregateError);
  assert.equal(outcome.error.errors.length, 2);
  const [selfReference, cleanupFailure] = outcome.error.errors;
  assertSelfReference(selfReference, "featureRegistry.enter", "start");
  assert.equal(cleanupFailure.message, "router dispose failed");
  assert.equal(outcome.error.cause, selfReference);
  const blockedStart = await settleWithin(
    application.start(initial("blocked-after-self-reference")),
    "start after self-reference cleanup failure did not settle"
  );
  assert.equal(blockedStart.status, "rejected");
  assert.match(blockedStart.error.message, /locked after cleanup failure/);
  assert.deepEqual(errorMessages(blockedStart.error.cause), ["router dispose failed"]);
  const stop = application.stop();
  assert.equal(application.stop(), stop);
  const stopOutcome = await settleWithin(stop, "stop after start self-reference did not settle");
  assert.equal(stopOutcome.status, "fulfilled");
}
{
  const fixture = createFixture();
  let application;
  fixture.ports.state.resetSession = () => {
    fixture.events.push("state.resetSession");
    return application.resetSession();
  };
  application = createBrowserApplication(fixture.ports);
  await application.start(initial("self-referential-reset-port"));
  const reset = application.resetSession();
  const outcome = await settleWithin(reset, "self-referential reset port did not settle");
  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.error instanceof AggregateError);
  assert.equal(outcome.error.errors.length, 1);
  assertSelfReference(outcome.error.errors[0], "state.resetSession", "reset");
  assert.equal(application.resetSession(), reset);
  const blockedStart = await settleWithin(
    application.start(initial("blocked-after-reset-self-reference")),
    "start after reset self-reference did not settle"
  );
  assert.equal(blockedStart.status, "rejected");
  assert.equal(blockedStart.error.cause, outcome.error);
  const stop = application.stop();
  assert.equal(application.stop(), stop);
  const stopOutcome = await settleWithin(stop, "stop after reset self-reference did not settle");
  assert.equal(stopOutcome.status, "fulfilled");
}
{
  const fixture = createFixture();
  let application;
  fixture.ports.shell.stop = () => {
    fixture.events.push("shell.stop");
    return application.stop();
  };
  application = createBrowserApplication(fixture.ports);
  await application.start(initial("self-referential-stop-port"));
  const stop = application.stop();
  const outcome = await settleWithin(stop, "self-referential stop port did not settle");
  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.error instanceof AggregateError);
  assert.equal(outcome.error.errors.length, 1);
  assertSelfReference(outcome.error.errors[0], "shell.stop", "stop");
  assert.equal(application.stop(), stop, "failed self-referential stop must stay idempotent");
  for (const expected of ["sync.stop", "state.stop", "feature.stop"]) {
    assert.ok(fixture.events.includes(expected), `${expected} must run after stop self-reference`);
  }
}
for (const method of ["resetSession", "stop"]) {
  const fixture = createFixture();
  const routerStart = fixture.ports.router.start;
  let application;
  fixture.ports.router.start = function startRouter(handlers, signal) {
    routerStart.call(this, handlers, signal);
    return () => {
      fixture.disposals.push(`router.${method}.self-reference`);
      return application[method]();
    };
  };
  application = createBrowserApplication(fixture.ports);
  await application.start(initial(`self-referential-${method}-disposer`));
  const operation = application[method]();
  const outcome = await settleWithin(
    operation,
    `disposer returning the current ${method} promise did not settle`
  );
  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.error instanceof AggregateError);
  assert.equal(outcome.error.errors.length, 1);
  assertSelfReference(
    outcome.error.errors[0],
    "router.start disposer",
    method === "resetSession" ? "reset" : "stop"
  );
  const stop = application.stop();
  const stopOutcome = await settleWithin(
    stop,
    `stop after ${method} disposer self-reference did not settle`
  );
  if (method === "resetSession") {
    assert.equal(stopOutcome.status, "fulfilled");
  } else {
    assert.equal(stop, operation);
    assert.equal(stopOutcome.status, "rejected");
  }
  for (const expected of ["shell.stop", "sync.stop", "state.stop", "feature.stop"]) {
    assert.ok(fixture.events.includes(expected), `${expected} must remain reachable`);
  }
}
{
  const fixture = createFixture({
    disposerFailures: new Set(["router"])
  });
  let application;
  let innerStart;
  fixture.ports.featureRegistry.enter = async (view, nextRoute) => {
    fixture.events.push(`feature.enter:${view}:${nextRoute.id}`);
    innerStart = application.start(initial("async-wrapper-inner-start"));
    return innerStart;
  };
  application = createBrowserApplication({
    ...fixture.ports,
    lifecyclePortTimeoutMs: 20
  });
  const start = application.start(initial("async-wrapper-start"));
  const outcome = await settleWithin(start, "async start wrapper did not settle");
  assert.equal(innerStart, start, "async start wrapper must adopt the current start promise");
  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.error instanceof AggregateError);
  assert.equal(outcome.error.errors.length, 2);
  assertPortTimeout(outcome.error.errors[0], "featureRegistry.enter");
  assert.equal(outcome.error.errors[1].message, "router dispose failed");
  assert.equal(outcome.error.cause, outcome.error.errors[0]);
  const blockedStart = await settleWithin(
    application.start(initial("blocked-after-async-start-wrapper")),
    "start after async wrapper cleanup failure did not settle"
  );
  assert.equal(blockedStart.status, "rejected");
  assert.match(blockedStart.error.message, /locked after cleanup failure/);
  assert.deepEqual(errorMessages(blockedStart.error.cause), ["router dispose failed"]);
  const stop = application.stop();
  assert.equal(application.stop(), stop);
  const stopOutcome = await settleWithin(stop, "stop after async start wrapper did not settle");
  assert.equal(stopOutcome.status, "fulfilled");
}
{
  const fixture = createFixture();
  let application;
  let innerReset;
  fixture.ports.state.resetSession = async () => {
    fixture.events.push("state.resetSession");
    innerReset = application.resetSession();
    return innerReset;
  };
  application = createBrowserApplication({
    ...fixture.ports,
    lifecyclePortTimeoutMs: 20
  });
  await application.start(initial("async-wrapper-reset"));
  const reset = application.resetSession();
  const outcome = await settleWithin(reset, "async reset wrapper did not settle");
  assert.equal(innerReset, reset, "async reset wrapper must adopt the current reset promise");
  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.error instanceof AggregateError);
  assert.equal(outcome.error.errors.length, 1);
  assertPortTimeout(outcome.error.errors[0], "state.resetSession");
  assert.equal(application.resetSession(), reset);
  const blockedStart = await settleWithin(
    application.start(initial("blocked-after-async-reset-wrapper")),
    "start after async reset wrapper did not settle"
  );
  assert.equal(blockedStart.status, "rejected");
  assert.equal(blockedStart.error.cause, outcome.error);
  const stopOutcome = await settleWithin(
    application.stop(),
    "stop after async reset wrapper did not settle"
  );
  assert.equal(stopOutcome.status, "fulfilled");
}
{
  const fixture = createFixture();
  let application;
  let innerStop;
  fixture.ports.shell.stop = async () => {
    fixture.events.push("shell.stop");
    innerStop = application.stop();
    return innerStop;
  };
  application = createBrowserApplication({
    ...fixture.ports,
    lifecyclePortTimeoutMs: 20
  });
  await application.start(initial("async-wrapper-stop"));
  const stop = application.stop();
  const outcome = await settleWithin(stop, "async stop wrapper did not settle");
  assert.equal(innerStop, stop, "async stop wrapper must adopt the current stop promise");
  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.error instanceof AggregateError);
  assert.equal(outcome.error.errors.length, 1);
  assertPortTimeout(outcome.error.errors[0], "shell.stop");
  assert.equal(application.stop(), stop);
  for (const expected of ["sync.stop", "state.stop", "feature.stop"]) {
    assert.ok(fixture.events.includes(expected), `${expected} must run after async stop wrapper`);
  }
}
{
  const fixture = createFixture();
  const routerStart = fixture.ports.router.start;
  let application;
  let innerReset;
  fixture.ports.router.start = function startRouter(handlers, signal) {
    routerStart.call(this, handlers, signal);
    return async () => {
      fixture.disposals.push("router.async-wrapper");
      innerReset = application.resetSession();
      return innerReset;
    };
  };
  application = createBrowserApplication({
    ...fixture.ports,
    lifecyclePortTimeoutMs: 20
  });
  await application.start(initial("async-wrapper-disposer"));
  const reset = application.resetSession();
  const outcome = await settleWithin(reset, "async disposer wrapper did not settle");
  assert.equal(innerReset, reset, "async disposer must adopt the current reset promise");
  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.error instanceof AggregateError);
  assert.equal(outcome.error.errors.length, 1);
  assertPortTimeout(outcome.error.errors[0], "router.start disposer");
  const blockedStart = await settleWithin(
    application.start(initial("blocked-after-async-disposer-wrapper")),
    "start after async disposer wrapper did not settle"
  );
  assert.equal(blockedStart.status, "rejected");
  assert.equal(blockedStart.error.cause, outcome.error);
  const stopOutcome = await settleWithin(
    application.stop(),
    "stop after async disposer wrapper did not settle"
  );
  assert.equal(stopOutcome.status, "fulfilled");
}
assert.throws(
  () => createBrowserApplication({
    router: {},
    featureRegistry: {},
    session: {},
    state: {},
    sync: {},
    shell: {}
  }),
  /router\.start/
);
console.log("Frontend application checks passed: ordered lifecycle, cleanup locking, direct and async-wrapped self-reference bounds, late cleanup and aggregate errors.");
