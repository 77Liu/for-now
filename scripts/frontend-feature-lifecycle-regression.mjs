import assert from "node:assert/strict";
import { createFeatureRegistry } from "../public/frontend/feature-registry/index.mjs";

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

async function pendingMountFixture() {
  const mountGate = deferred();
  const signals = [];
  const disposals = [];
  let loads = 0;
  let resets = 0;
  const registry = createFeatureRegistry({
    descriptors: {
      pending: {
        root: {},
        async load() {
          const instance = loads;
          loads += 1;
          return {
            mount({ signal }) {
              signals.push(signal);
              if (instance === 0) {
                return mountGate.promise.then(() => () => disposals.push(instance));
              }
              return () => disposals.push(instance);
            },
            resetSession() {
              resets += 1;
            }
          };
        }
      }
    }
  });
  const entry = registry.enter("pending", { id: "blocked" });
  await waitFor(() => signals.length === 1, "pending mount did not start");
  return {
    registry,
    entry,
    mountGate,
    signals,
    disposals,
    loads: () => loads,
    resets: () => resets
  };
}

{
  assert.throws(
    () => createFeatureRegistry({
      descriptors: new Map([
        [1, { load: async () => ({ mount() {} }) }],
        ["1", { load: async () => ({ mount() {} }) }]
      ])
    }),
    /Duplicate feature view after normalization: 1/
  );
}

{
  const loadGate = deferred();
  const renders = [];
  const registry = createFeatureRegistry({
    descriptors: {
      delayed: {
        root: {},
        async load() {
          await loadGate.promise;
          return {
            mount() {},
            render(context) {
              renders.push(context);
            }
          };
        }
      }
    }
  });
  const entry = registry.enter("delayed", { id: "loading" });
  registry.notifyState({ version: 1 }, ["records"]);
  registry.notifyState({ version: 2 }, ["notifications"]);
  loadGate.resolve();
  await entry;
  await waitFor(() => renders.length === 1, "state received during import was not rendered after mount");
  assert.deepEqual(renders[0].snapshot, { version: 2 });
  assert.deepEqual(renders[0].changedDomains, ["records", "notifications"]);
  await registry.stop();
}

{
  const calls = [];
  let loads = 0;
  let mounts = 0;
  let activeSignal;
  const root = {};
  const registry = createFeatureRegistry({
    descriptors: {
      home: {
        root,
        async load() {
          loads += 1;
          return {
            mount(context) {
              mounts += 1;
              activeSignal = context.signal;
              assert.equal(context.root, root);
              assert.deepEqual(Object.keys(context).sort(), ["root", "route", "signal"]);
              calls.push(`mount:${context.route.id}`);
            },
            unmount() {
              assert.equal(activeSignal.aborted, true);
              calls.push("unmount");
            }
          };
        }
      }
    }
  });
  assert.deepEqual(
    Object.keys(registry).sort(),
    ["enter", "leave", "notifyState", "resetSession", "stop"]
  );
  const first = registry.enter("home", { query: { page: 1 }, id: "same" });
  const repeated = registry.enter("home", { id: "same", query: { page: 1 } });
  assert.equal(first, repeated);
  await Promise.all([first, repeated]);
  assert.equal(loads, 1);
  assert.equal(mounts, 1);
  await registry.leave("home");
  assert.deepEqual(calls, ["mount:same", "unmount"]);
}

{
  const lateImport = deferred();
  const calls = [];
  const registry = createFeatureRegistry({
    descriptors: {
      old: {
        root: {},
        load: () => lateImport.promise
      },
      next: {
        root: {},
        load: async () => ({
          mount({ route }) {
            calls.push(`mount:${route.id}`);
          }
        })
      }
    }
  });
  const oldEntry = registry.enter("old", { id: "old" });
  await flush();
  const nextEntry = registry.enter("next", { id: "next" });
  await nextEntry;
  assert.deepEqual(calls, ["mount:next"], "late import must not block the next route");
  lateImport.resolve({
    mount() {
      calls.push("mount:old");
    }
  });
  await oldEntry;
  await flush();
  assert.deepEqual(calls, ["mount:next"], "late import must not mount into the new route");
  await registry.stop();
}

{
  const failures = [];
  let attempts = 0;
  let unmounts = 0;
  const registry = createFeatureRegistry({
    descriptors: {
      retry: {
        root: {},
        async load() {
          attempts += 1;
          if (attempts === 1) throw new Error("lazy import failed");
          const mountMustFail = attempts === 2;
          return {
            mount() {
              if (mountMustFail) throw new Error("mount failed");
            },
            unmount() {
              unmounts += 1;
            }
          };
        }
      }
    },
    onFailure(error, context) {
      failures.push([error.message, context.phase, context.view, context.generation]);
    }
  });
  await assert.rejects(registry.enter("retry", { id: 1 }), /lazy import failed/);
  assert.deepEqual(failures, [["lazy import failed", "import", "retry", 1]]);
  await assert.rejects(registry.enter("retry", { id: 1 }), /mount failed/);
  assert.deepEqual(failures.slice(-1), [["mount failed", "mount", "retry", 2]]);
  await registry.enter("retry", { id: 1 });
  assert.equal(attempts, 3);
  await registry.leave("retry");
  assert.equal(unmounts, 2);
}

{
  let loads = 0;
  let mounts = 0;
  const registry = createFeatureRegistry({
    descriptors: {
      cleanup: {
        root: {},
        async load() {
          loads += 1;
          const failCleanup = loads === 1;
          return {
            mount() {
              mounts += 1;
            },
            unmount() {
              if (failCleanup) throw new Error("unmount failed");
            }
          };
        }
      }
    }
  });
  await registry.enter("cleanup", { id: 1 });
  await assert.rejects(registry.leave("cleanup"), /unmount failed/);
  await registry.enter("cleanup", { id: 2 });
  assert.equal(loads, 2, "cleanup failure must discard the uncertain controller");
  assert.equal(mounts, 2);
  await registry.stop();
}

{
  const renderGate = deferred();
  const writes = [];
  const renders = [];
  const signals = [];
  const disposed = [];
  const feature = {
    mount({ route, signal }) {
      signals.push([route.id, signal]);
      return () => {
        assert.equal(signal.aborted, true);
        disposed.push(route.id);
      };
    },
    async render({ snapshot, changedDomains, signal, generation, route }) {
      renders.push({ snapshot, changedDomains, signal, generation, route });
      if (snapshot.wait) await renderGate.promise;
      if (!signal.aborted) writes.push(snapshot.value);
    }
  };
  const registry = createFeatureRegistry({
    descriptors: {
      detail: { root: {}, load: async () => feature }
    }
  });
  await registry.enter("detail", { id: "old" });
  registry.notifyState({ value: "old", wait: true }, ["items"]);
  await waitFor(() => renders.length === 1, "old activation did not start rendering");
  registry.notifyState({ value: "must-not-run", wait: false }, ["queued"]);
  await registry.enter("detail", { id: "new" });
  assert.equal(signals[0][1].aborted, true);
  assert.equal(signals[1][1].aborted, false);
  assert.equal(renders[0].signal, signals[0][1]);
  assert.equal(renders[0].generation, 1);
  assert.deepEqual(renders[0].route, { id: "old" });
  assert.deepEqual(renders[0].changedDomains, ["items"]);
  assert.deepEqual(disposed, ["old"]);
  renderGate.resolve();
  await flush();
  assert.deepEqual(writes, [], "late render must observe the aborted old activation");
  assert.equal(renders.length, 1, "registry must not reschedule queued work for a retired activation");
  registry.notifyState({ value: "new", wait: false }, ["items"]);
  await waitFor(() => writes.length === 1, "new activation did not render");
  assert.deepEqual(writes, ["new"]);
  assert.equal(renders[1].signal, signals[1][1]);
  assert.equal(renders[1].generation, 2);
  assert.deepEqual(renders[1].route, { id: "new" });
  await registry.stop();
  assert.deepEqual(disposed, ["old", "new"]);
}

{
  const failures = [];
  let loads = 0;
  let disposals = 0;
  const registry = createFeatureRegistry({
    descriptors: {
      unstable: {
        root: {},
        async load() {
          loads += 1;
          const shouldFail = loads === 1;
          return {
            mount() {
              return () => {
                disposals += 1;
              };
            },
            render() {
              if (shouldFail) throw new Error("render failed");
            }
          };
        }
      }
    },
    onFailure(error, context) {
      failures.push([error.message, context.phase]);
    }
  });
  await registry.enter("unstable", { id: 1 });
  registry.notifyState({ version: 1 }, ["items"]);
  await waitFor(() => failures.length === 1, "render failure was not reported");
  assert.deepEqual(failures, [["render failed", "render"]]);
  assert.equal(disposals, 1);
  await registry.enter("unstable", { id: 1 });
  assert.equal(loads, 2, "render failure must allow a fresh retry");
  await registry.stop();
}

for (const retirement of ["reset", "stop"]) {
  const renderGate = deferred();
  const renders = [];
  let signal;
  const registry = createFeatureRegistry({
    descriptors: {
      late: {
        root: {},
        async load() {
          return {
            mount(context) {
              signal = context.signal;
            },
            async render(context) {
              renders.push(context);
              await renderGate.promise;
            }
          };
        }
      }
    }
  });
  await registry.enter("late", { id: retirement });
  registry.notifyState({ value: "started" }, ["items"]);
  await waitFor(() => renders.length === 1, `${retirement} render did not start`);
  registry.notifyState({ value: "queued" }, ["queued"]);
  const lifecycle = retirement === "reset"
    ? registry.resetSession()
    : registry.stop();
  await assertSettles(lifecycle, `${retirement} must not wait for a pending render`);
  assert.equal(signal.aborted, true, `${retirement} must abort the render activation`);
  renderGate.resolve();
  await flush();
  assert.equal(renders.length, 1, `${retirement} must not reschedule a late render`);
  if (retirement === "reset") await registry.stop();
}

{
  let activeResources = 0;
  let peakResources = 0;
  let mounts = 0;
  let disposals = 0;
  let loads = 0;
  const registry = createFeatureRegistry({
    descriptors: {
      cycle: {
        root: {},
        async load() {
          loads += 1;
          return {
            mount() {
              mounts += 1;
              activeResources += 1;
              peakResources = Math.max(peakResources, activeResources);
              return () => {
                disposals += 1;
                activeResources -= 1;
              };
            }
          };
        }
      }
    }
  });
  for (let cycle = 0; cycle < 20; cycle += 1) {
    await registry.enter("cycle", { id: cycle });
    await registry.leave("cycle");
  }
  assert.equal(loads, 1);
  assert.equal(mounts, 20);
  assert.equal(disposals, 20);
  assert.equal(activeResources, 0);
  assert.equal(peakResources, 1);
  await registry.stop();
}

{
  const fixture = await pendingMountFixture();
  await assertSettles(
    fixture.registry.leave("pending"),
    "leave must not wait for an aborted mount"
  );
  await assertSettles(fixture.entry, "retired entry must settle without its mount");
  assert.equal(fixture.signals[0].aborted, true);
  fixture.mountGate.resolve();
  await waitFor(() => fixture.disposals.length === 1, "late mount disposer was not called after leave");
  await fixture.registry.stop();
}

{
  const fixture = await pendingMountFixture();
  await assertSettles(
    fixture.registry.resetSession(),
    "reset must not wait for an aborted mount"
  );
  await assertSettles(fixture.entry, "reset must settle the retired entry");
  assert.equal(fixture.signals[0].aborted, true);
  assert.equal(fixture.resets(), 1);
  fixture.mountGate.resolve();
  await waitFor(() => fixture.disposals.length === 1, "late mount disposer was not called after reset");
  await fixture.registry.stop();
}

{
  const fixture = await pendingMountFixture();
  await assertSettles(
    fixture.registry.stop(),
    "stop must not wait for an aborted mount"
  );
  await assertSettles(fixture.entry, "stop must settle the retired entry");
  assert.equal(fixture.signals[0].aborted, true);
  fixture.mountGate.resolve();
  await waitFor(() => fixture.disposals.length === 1, "late mount disposer was not called after stop");
}

{
  const fixture = await pendingMountFixture();
  const nextEntry = fixture.registry.enter("pending", { id: "next" });
  await assertSettles(nextEntry, "next enter must not wait for an aborted mount");
  await assertSettles(fixture.entry, "next enter must settle the retired entry");
  assert.equal(fixture.loads(), 2, "an abandoned mount must not reuse its controller");
  assert.equal(fixture.signals[0].aborted, true);
  assert.equal(fixture.signals[1].aborted, false);
  fixture.mountGate.resolve();
  await waitFor(() => fixture.disposals.includes(0), "late mount disposer was not called after next enter");
  await fixture.registry.stop();
  assert.deepEqual(fixture.disposals, [0, 1]);
}

{
  const resetGate = deferred();
  let loads = 0;
  const registry = createFeatureRegistry({
    descriptors: {
      locked: {
        root: {},
        async load() {
          loads += 1;
          return {
            mount() {},
            async resetSession() {
              await resetGate.promise;
              throw new Error("reset failed");
            }
          };
        }
      }
    }
  });
  await registry.enter("locked", { id: 1 });
  const reset = registry.resetSession();
  const queuedEntry = registry.enter("locked", { id: 2 });
  const queuedReset = registry.resetSession();
  const resetCheck = assert.rejects(reset, /reset failed/);
  const queuedCheck = assert.rejects(
    queuedEntry,
    error => error.message.includes("locked") && error.cause?.message === "reset failed"
  );
  const queuedResetCheck = assert.rejects(
    queuedReset,
    error => error.message.includes("locked") && error.cause?.message === "reset failed"
  );
  resetGate.resolve();
  await Promise.all([resetCheck, queuedCheck, queuedResetCheck]);
  await assert.rejects(registry.enter("locked", { id: 3 }), /locked after session reset failure/);
  await assert.rejects(registry.resetSession(), /locked after session reset failure/);
  assert.equal(loads, 1, "failed reset must prevent loading a controller for the next session");
  await registry.stop();
}

{
  const moduleObject = Object.freeze({
    createController(session, events, instances) {
      const controller = {
        mount({ signal }) {
          events.push(`mount:${session}`);
          instances.push(controller);
          return () => {
            assert.equal(signal.aborted, true);
            events.push(`unmount:${session}`);
          };
        },
        resetSession() {
          events.push(`reset:${session}`);
        }
      };
      return controller;
    }
  });
  const events = [];
  const signals = [];
  const instances = [];
  let loads = 0;
  const registry = createFeatureRegistry({
    descriptors: {
      session: {
        root: {},
        async load() {
          loads += 1;
          const controller = moduleObject.createController(loads, events, instances);
          const mount = controller.mount;
          controller.mount = context => {
            signals.push(context.signal);
            return mount(context);
          };
          return controller;
        }
      }
    }
  });
  await registry.enter("session", { id: 1 });
  const firstReset = registry.resetSession();
  assert.equal(signals[0].aborted, true, "reset must abort before awaiting cleanup");
  const repeatedReset = registry.resetSession();
  assert.equal(firstReset, repeatedReset);
  await Promise.all([firstReset, repeatedReset]);
  assert.deepEqual(events, ["mount:1", "unmount:1", "reset:1"]);
  assert.equal(registry.resetSession(), firstReset);
  await registry.enter("session", { id: 2 });
  assert.equal(loads, 2, "a new session must not reuse the old feature instance cache");
  assert.notEqual(instances[0], instances[1], "the same module must create a new controller per session");
  const firstStop = registry.stop();
  assert.equal(signals[1].aborted, true, "stop must abort before awaiting cleanup");
  const repeatedStop = registry.stop();
  assert.equal(firstStop, repeatedStop);
  await Promise.all([firstStop, repeatedStop]);
  assert.deepEqual(events, ["mount:1", "unmount:1", "reset:1", "mount:2", "unmount:2"]);
  await assert.rejects(registry.enter("session", { id: 3 }), /stopped/);
}

{
  const sharedController = {
    mount() {},
    resetSession() {}
  };
  const registry = createFeatureRegistry({
    descriptors: {
      reused: {
        root: {},
        async load() {
          return sharedController;
        }
      }
    }
  });
  await registry.enter("reused", { id: 1 });
  await registry.resetSession();
  await assert.rejects(
    registry.enter("reused", { id: 2 }),
    /fresh controller instance/
  );
  await registry.stop();
}

{
  const sharedController = { mount() {} };
  const registry = createFeatureRegistry({
    descriptors: {
      invalid: {
        root: {},
        async load() {
          return { default: sharedController };
        }
      }
    }
  });
  await assert.rejects(
    registry.enter("invalid", {}),
    /resolve directly to a controller instance/
  );
  await registry.stop();
}

console.log("Frontend feature lifecycle checks passed: isolation, stale work, retries, non-blocking cleanup, reset and stop.");
