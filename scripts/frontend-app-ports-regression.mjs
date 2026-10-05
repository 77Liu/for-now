import assert from "node:assert/strict";
import {
  createSessionPort,
  createShellPort,
  createStatePort,
  createSyncPort
} from "../public/frontend/app/ports.mjs";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

{
  const session = createSessionPort();
  const anonymous = session.capture();
  assert.equal(anonymous.accountId, "");
  assert.equal(session.isCurrent(anonymous), true);
  const accountA = session.activate("account-a");
  assert.equal(anonymous.signal.aborted, true);
  assert.equal(accountA.accountId, "account-a");
  assert.equal(session.isCurrent(accountA), true);
  const capturedA = session.capture();
  session.resetSession();
  assert.equal(capturedA.signal.aborted, true);
  assert.equal(session.isCurrent(capturedA), false);
  assert.throws(() => session.assertCurrent(capturedA), { name: "AbortError" });
  const accountB = session.activate("account-b");
  assert.equal(accountB.accountId, "account-b");
  assert.ok(accountB.serial > accountA.serial);
}

{
  const firstLoad = deferred();
  const seenSignals = [];
  const state = createStatePort({
    emptyState: { records: [], account: "" },
    async load(initial, { signal }) {
      seenSignals.push(signal);
      if (initial?.wait) return firstLoad.promise;
      return initial;
    }
  });
  assert.deepEqual(state.snapshot(), { records: [], account: "" });
  const updates = [];
  const unsubscribe = state.subscribe((snapshot, domains, options) => {
    updates.push({
      snapshot: structuredClone(snapshot),
      domains: [...domains],
      options
    });
  });
  const startA = state.start({ wait: true, account: "a" }, new AbortController().signal);
  await flush();
  assert.equal(seenSignals.length, 1);
  state.resetSession();
  assert.equal(seenSignals[0].aborted, true);
  firstLoad.resolve({ records: ["private-a"], account: "a" });
  await assert.rejects(startA, { name: "AbortError" });
  assert.deepEqual(state.snapshot(), { records: [], account: "" });

  const startController = new AbortController();
  const disposeState = await state.start(
    { records: ["b"], account: "b" },
    startController.signal
  );
  assert.deepEqual(state.snapshot(), { records: ["b"], account: "b" });
  state.merge({ records: ["b", "next"] }, ["records"], { source: "sync" });
  assert.deepEqual(updates.at(-1), {
    snapshot: { records: ["b", "next"], account: "b" },
    domains: ["records"],
    options: { source: "sync" }
  });
  disposeState();
  disposeState();
  assert.equal(startController.signal.aborted, false);
  unsubscribe();
  unsubscribe();
  state.replace({ records: ["quiet"], account: "b" }, ["records"]);
  assert.equal(updates.length, 1);
  await state.stop();
  assert.deepEqual(state.snapshot(), { records: [], account: "" });
  await assert.rejects(
    state.start({ records: [], account: "c" }),
    /State port has stopped/
  );
}

{
  const events = [];
  const starts = [];
  let closed = 0;
  const controller = {
    start(owner, options) {
      events.push(`start:${owner}:${options.incremental}`);
      const pending = deferred();
      starts.push(pending);
      return pending.promise;
    },
    stop() {
      events.push("stop");
    }
  };
  const errors = [];
  const sync = createSyncPort({
    controller,
    close() {
      closed += 1;
    },
    onError(error) {
      errors.push(error.message);
    }
  });
  const signalA = new AbortController();
  const disposeA = sync.start(
    { owner: "a", incremental: true },
    signalA.signal
  );
  assert.equal(typeof disposeA, "function");
  await flush();
  assert.deepEqual(events, ["start:a:true"]);
  await disposeA();
  await disposeA();
  assert.deepEqual(events, ["start:a:true", "stop"]);
  starts[0].reject(new Error("late-a"));
  await flush();
  assert.deepEqual(errors, [], "late errors from disposed owners must be ignored");

  const signalB = new AbortController();
  sync.start({ owner: "b", incremental: false }, signalB.signal);
  await flush();
  assert.equal(events.at(-1), "start:b:false");
  signalB.abort();
  await flush();
  assert.equal(events.at(-1), "stop");
  await sync.resetSession();
  assert.equal(events.at(-1), "stop");
  await sync.stop();
  await sync.stop();
  assert.equal(closed, 1);
  assert.throws(
    () => sync.start({ owner: "c", incremental: true }),
    /Sync port has stopped/
  );
}

{
  const stopGate = deferred();
  const starts = [];
  let stopCalls = 0;
  const sync = createSyncPort({
    controller: {
      start(owner) {
        starts.push(owner);
      },
      stop() {
        stopCalls += 1;
        return stopCalls === 1 ? stopGate.promise : undefined;
      }
    }
  });
  sync.start({ owner: "a" });
  sync.start({ owner: "b" });
  await flush();
  assert.deepEqual(starts, [], "next owner must wait for the prior stop");
  stopGate.resolve();
  await flush();
  await flush();
  assert.deepEqual(starts, ["b"]);
  await sync.stop();

  const immediateStarts = [];
  const immediate = createSyncPort({
    controller: {
      start(owner) {
        immediateStarts.push(owner);
      },
      stop() {}
    }
  });
  immediate.start({ owner: "stale" });
  await immediate.resetSession();
  await flush();
  assert.deepEqual(
    immediateStarts,
    [],
    "reset in the start tick must prevent the stale owner from starting"
  );

  const disposeGate = deferred();
  const disposedStarts = [];
  let disposeStops = 0;
  const disposed = createSyncPort({
    controller: {
      start(owner) {
        disposedStarts.push(owner);
      },
      stop() {
        disposeStops += 1;
        return disposeStops === 1 ? disposeGate.promise : undefined;
      }
    }
  });
  const disposeOld = disposed.start({ owner: "old" });
  await flush();
  assert.deepEqual(disposedStarts, ["old"]);
  disposeOld();
  disposed.start({ owner: "new" });
  await flush();
  assert.deepEqual(disposedStarts, ["old"]);
  disposeGate.resolve();
  await flush();
  await flush();
  assert.deepEqual(disposedStarts, ["old", "new"]);
}

{
  let mountGate = deferred();
  const events = [];
  const shell = createShellPort({
    async mount(initial, { signal }) {
      events.push(`mount:${initial.account}:${signal.aborted}`);
      await mountGate.promise;
      return () => events.push(`dispose:${initial.account}`);
    },
    async reset() {
      events.push("reset");
    },
    async stop() {
      events.push("stop");
    }
  });
  const controller = new AbortController();
  const pendingStart = shell.start({ account: "a" }, controller.signal);
  await flush();
  controller.abort();
  mountGate.resolve();
  await assert.rejects(pendingStart, { name: "AbortError" });
  await flush();
  assert.deepEqual(events.slice(0, 2), ["mount:a:false", "dispose:a"]);
  await shell.resetSession();
  assert.equal(events.at(-1), "reset");

  mountGate = deferred();
  const resetDuringStart = shell.start({ account: "reset-pending" });
  await flush();
  const resetPending = shell.resetSession();
  mountGate.resolve();
  await resetPending;
  await assert.rejects(resetDuringStart, { name: "AbortError" });
  assert.equal(
    events.filter(event => event === "dispose:reset-pending").length,
    1,
    "reset during mount must dispose a late resource exactly once"
  );

  const disposeB = await shell.start({ account: "b" });
  await disposeB();
  await disposeB();
  assert.equal(events.filter(event => event === "dispose:b").length, 1);
  await shell.stop();
  await shell.stop();
  assert.deepEqual(events.slice(-2), ["reset", "stop"]);
  await assert.rejects(shell.start({ account: "c" }), /Shell port has stopped/);
}

{
  const gate = deferred();
  const events = [];
  const shell = createShellPort({
    async mount() {
      events.push("mount");
      await gate.promise;
      return () => events.push("dispose");
    },
    async reset() {
      events.push("reset");
    },
    async stop() {
      events.push("stop");
    }
  });
  const start = shell.start({});
  await flush();
  let stopped = false;
  const stopping = shell.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false, "stop must wait for a pending mount cleanup");
  gate.resolve();
  await stopping;
  await assert.rejects(start, { name: "AbortError" });
  assert.deepEqual(events, ["mount", "dispose", "reset", "stop"]);
}

console.log("Frontend app ports regression passed.");
