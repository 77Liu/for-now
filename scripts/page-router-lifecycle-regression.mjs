import assert from "node:assert/strict";
import { createPageRouter, pageRoute } from "../public/frontend/pages/index.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

class EventTargetFixture {
  listeners = new Map();

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name, event = {}) {
    for (const listener of [...(this.listeners.get(name) || [])]) {
      listener({ type: name, ...event });
    }
  }

  count() {
    return [...this.listeners.values()].reduce((sum, values) => sum + values.size, 0);
  }
}

const eventTarget = new EventTargetFixture();
const location = {
  pathname: "/now/",
  search: "?view=thoughts&tag=focus",
  hash: ""
};
const entries = [{ url: "/now/?view=thoughts&tag=focus", state: null }];
let entryIndex = 0;
let historyWrites = 0;
const updateLocation = value => {
  const url = new URL(value, "https://router.test");
  location.pathname = url.pathname;
  location.search = url.search;
  location.hash = url.hash;
};
const history = {
  state: null,
  scrollRestoration: "auto",
  replaceState(state, _title, url) {
    historyWrites += 1;
    this.state = state;
    entries[entryIndex] = { state, url };
    updateLocation(url);
  },
  pushState(state, _title, url) {
    historyWrites += 1;
    entries.splice(entryIndex + 1);
    entries.push({ state, url });
    entryIndex += 1;
    this.state = state;
    updateLocation(url);
  }
};
let nextTaskId = 1;
const frames = new Map();
const timers = new Map();
const cancelledFrames = [];
const clearedTimers = [];
const requestFrame = callback => {
  const id = nextTaskId++;
  frames.set(id, callback);
  return id;
};
const cancelFrame = id => {
  cancelledFrames.push(id);
  frames.delete(id);
};
const setTimer = callback => {
  const id = nextTaskId++;
  timers.set(id, callback);
  return id;
};
const clearTimer = id => {
  clearedTimers.push(id);
  timers.delete(id);
};
const runFrames = () => {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [, callback] of pending) callback();
};
const runTimers = () => {
  const pending = [...timers.entries()];
  timers.clear();
  for (const [, callback] of pending) callback();
};
let scroll = { x: 0, y: 0 };
const scrollWrites = [];
const routeEvents = [];

const router = createPageRouter({
  query: () => null,
  queryAll: () => [],
  location,
  history,
  eventTarget,
  basePath: "/now",
  requestFrame,
  cancelFrame,
  setTimer,
  clearTimer,
  readScroll: () => scroll,
  scrollTo: value => {
    scrollWrites.push(value);
    scroll = {
      x: Number(value.left) || 0,
      y: Number(value.top) || 0
    };
  },
  onRoute: (route, context) => {
    routeEvents.push([route.view, context.source]);
  }
});

assert.equal(historyWrites, 0, "router construction must not write history");
assert.equal(eventTarget.count(), 0, "router construction must not bind global listeners");
assert.throws(() => router.start(), /requires enter and leave handlers/);
assert.equal(router.switchView("books"), false, "inactive router must not navigate");

const firstTransitions = [];
const firstController = new AbortController();
const firstDisposer = router.start({
  async leave(route) {
    firstTransitions.push(`leave:${route.view}`);
  },
  async enter(route) {
    firstTransitions.push(`enter:${route.view}`);
  }
}, firstController.signal);
assert.equal(typeof firstDisposer, "function");
assert.equal(eventTarget.count(), 7);
assert.equal(history.scrollRestoration, "manual");
assert.equal(`${location.pathname}${location.search}`, "/now/thoughts?tag=focus");
assert.equal(routeEvents[0][1], "initial");

const repeatedDisposer = router.start({
  async leave() {},
  async enter() {}
});
assert.equal(repeatedDisposer, firstDisposer);
assert.equal(eventTarget.count(), 7, "repeated start must not duplicate listeners");

await router.switchView("books");
assert.deepEqual(firstTransitions, ["leave:thoughts", "enter:books"]);
assert.equal(router.currentRoute().view, "books");
assert.equal(routeEvents.at(-1)[0], "books");

scroll = { x: 0, y: 420 };
const writesBeforeScroll = historyWrites;
eventTarget.dispatch("scroll");
eventTarget.dispatch("scroll");
assert.equal(frames.size, 1, "scroll capture must be frame-coalesced");
runFrames();
assert.equal(historyWrites, writesBeforeScroll + 1);

router.restoreCurrentScroll({ x: 5, y: 300 });
assert.equal(frames.size, 1);
runFrames();
assert.equal(frames.size, 1);
runFrames();
assert.equal(timers.size, 1);
assert.deepEqual(scrollWrites.at(-1), { left: 5, top: 300, behavior: "auto" });
eventTarget.dispatch("pointerdown");
runTimers();
assert.equal(
  scrollWrites.filter(value => value.top === 300).length,
  1,
  "user intent must invalidate delayed restore"
);

eventTarget.dispatch("scroll");
router.restoreCurrentScroll({ x: 0, y: 200 });
assert.ok(frames.size >= 1);
runFrames();
runFrames();
assert.equal(timers.size, 1);
eventTarget.dispatch("scroll");
firstDisposer();
firstDisposer();
assert.equal(eventTarget.count(), 0);
assert.equal(frames.size, 0);
assert.equal(timers.size, 0);
assert.ok(cancelledFrames.length >= 1);
assert.ok(clearedTimers.length >= 1);
assert.equal(history.scrollRestoration, "auto");
const writesAfterDispose = historyWrites;
eventTarget.dispatch("scroll");
assert.equal(router.switchView("today"), false);
assert.equal(historyWrites, writesAfterDispose);

const secondController = new AbortController();
const secondDisposer = router.start({
  async leave() {},
  async enter() {}
}, secondController.signal);
assert.notEqual(secondDisposer, firstDisposer);
assert.equal(eventTarget.count(), 7);
firstDisposer();
assert.equal(eventTarget.count(), 7, "an old disposer must not stop a new cycle");
assert.deepEqual(router.currentRoute(), {
  ...pageRoute("books"),
  result: null
});
secondController.abort();
assert.equal(eventTarget.count(), 0);
assert.equal(history.scrollRestoration, "auto");
const preAborted = new AbortController();
preAborted.abort();
assert.throws(
  () => router.start({ enter() {}, leave() {} }, preAborted.signal),
  { name: "AbortError" }
);
assert.equal(eventTarget.count(), 0);

const deniedLocation = { pathname: "/now/today", search: "", hash: "" };
const deniedHistory = {
  state: null,
  scrollRestoration: "auto",
  replaceState(state, _title, value) {
    this.state = state;
    const url = new URL(value, "https://router.test");
    deniedLocation.pathname = url.pathname;
    deniedLocation.search = url.search;
  },
  pushState(state, _title, value) {
    this.replaceState(state, _title, value);
  }
};
const deniedRoutes = [];
const deniedRouter = createPageRouter({
  query: () => null,
  queryAll: () => [],
  location: deniedLocation,
  history: deniedHistory,
  eventTarget: new EventTargetFixture(),
  basePath: "/now",
  canAccessView: () => false,
  onDenied: view => deniedRoutes.push(view),
  requestFrame,
  cancelFrame,
  setTimer,
  clearTimer,
  readScroll: () => ({ x: 0, y: 0 }),
  scrollTo: () => {}
});
deniedRouter.start({ async leave() {}, async enter() {} });
await deniedRouter.switchView("architecture");
assert.deepEqual(deniedRoutes, ["architecture"]);
assert.equal(deniedRouter.currentRoute().view, "permission");
assert.equal(deniedLocation.pathname, "/now/permission");

const transitionGate = deferred();
const transitionEvents = [];
let leaveCount = 0;
const transitionRouter = createPageRouter({
  query: () => null,
  queryAll: () => [],
  scrollTo: () => {},
  onRoute: (route, context) => transitionEvents.push(
    `route:${route.view}:${context.transitionError?.message || "ok"}`
  )
});
transitionRouter.start({
  leave() {
    leaveCount += 1;
    return leaveCount === 1 ? transitionGate.promise : undefined;
  },
  enter(route) {
    transitionEvents.push(`enter:${route.view}`);
  }
});
const staleBooks = transitionRouter.switchView("books");
await flush();
const staleQuotes = transitionRouter.switchView("quotes");
const latestBooks = transitionRouter.switchView("books");
transitionGate.resolve();
await Promise.all([staleBooks, staleQuotes, latestBooks]);
assert.equal(transitionEvents.filter(event => event === "enter:books").length, 1);
assert.equal(transitionEvents.filter(event => event === "route:books:ok").length, 1);
assert.equal(transitionEvents.includes("enter:quotes"), false);
assert.equal(transitionEvents.includes("route:quotes:ok"), false);

{
  const leaveGate = deferred();
  const events = ["mount:today"];
  const router = createPageRouter({
    query: () => null,
    queryAll: () => [],
    scrollTo: () => {}
  });
  router.start({
    async leave(route) {
      events.push(`unmount:${route.view}`);
      await leaveGate.promise;
    },
    enter(route) {
      events.push(`mount:${route.view}`);
    }
  });
  const leaving = router.switchView("books");
  await flush();
  assert.deepEqual(events, ["mount:today", "unmount:today"]);
  const returning = router.switchView("today");
  leaveGate.resolve();
  await Promise.all([leaving, returning]);
  assert.equal(router.currentRoute().view, "today");
  assert.deepEqual(events, ["mount:today", "unmount:today", "mount:today"]);
}

{
  const events = ["mount:today"];
  const routes = [];
  const router = createPageRouter({
    query: () => null,
    queryAll: () => [],
    scrollTo: () => {},
    onRoute: (route, context) => routes.push([
      route.view,
      context.transitionError?.message || ""
    ])
  });
  router.start({
    leave(route) {
      events.push(`unmount:${route.view}`);
    },
    enter(route) {
      if (route.view === "books") throw new Error("books import failed");
      events.push(`mount:${route.view}`);
    }
  });
  await assert.rejects(router.switchView("books"), /books import failed/);
  assert.equal(router.currentRoute().view, "today");
  assert.deepEqual(events, ["mount:today", "unmount:today", "mount:today"]);
  assert.deepEqual(routes.at(-1), ["today", "books import failed"]);
}

{
  const rollbackStarted = deferred();
  const rollbackGate = deferred();
  const events = [];
  const router = createPageRouter({
    query: () => null,
    queryAll: () => [],
    scrollTo: () => {},
    onRoute: (route, context) => events.push(
      `route:${route.view}:${context.transitionError?.message || "ok"}`
    )
  });
  router.start({
    leave(route) {
      events.push(`leave:${route.view}`);
    },
    enter(route) {
      events.push(`enter:${route.view}`);
      if (route.view === "books") throw new Error("broken import");
      if (route.view === "today") {
        rollbackStarted.resolve();
        return rollbackGate.promise;
      }
    }
  });
  const broken = router.switchView("books");
  await rollbackStarted.promise;
  const latest = router.switchView("quotes");
  rollbackGate.resolve();
  await assert.rejects(broken, /broken import/);
  await latest;
  assert.equal(router.currentRoute().view, "quotes");
  assert.ok(events.includes("enter:today"));
  assert.ok(events.includes("enter:quotes"));
  assert.equal(events.includes("route:quotes:broken import"), false);
  assert.equal(events.at(-1), "route:quotes:ok");
}

const historyGate = deferred();
const historyLocation = { pathname: "/now/today", search: "", hash: "" };
const historyWritesForTransitions = [];
const transitionHistory = {
  state: null,
  scrollRestoration: "auto",
  replaceState(state, _title, value) {
    this.state = state;
    historyWritesForTransitions.push(["replace", value]);
    const url = new URL(value, "https://router.test");
    historyLocation.pathname = url.pathname;
    historyLocation.search = url.search;
  },
  pushState(state, _title, value) {
    this.state = state;
    historyWritesForTransitions.push(["push", value]);
    const url = new URL(value, "https://router.test");
    historyLocation.pathname = url.pathname;
    historyLocation.search = url.search;
  }
};
let historyLeaves = 0;
const historyRouter = createPageRouter({
  query: () => null,
  queryAll: () => [],
  location: historyLocation,
  history: transitionHistory,
  eventTarget: new EventTargetFixture(),
  basePath: "/now",
  readScroll: () => ({ x: 0, y: 50 }),
  scrollTo: () => {}
});
historyRouter.start({
  leave() {
    historyLeaves += 1;
    return historyLeaves === 1 ? historyGate.promise : undefined;
  },
  enter() {}
});
const pendingHistoryBooks = historyRouter.switchView("books");
historyRouter.captureScroll();
assert.deepEqual(historyWritesForTransitions.at(-1), ["replace", "/now/today"]);
await flush();
const pendingHistoryQuotes = historyRouter.switchView("quotes");
const latestHistoryBooks = historyRouter.switchView("books");
historyGate.resolve();
await Promise.all([pendingHistoryBooks, pendingHistoryQuotes, latestHistoryBooks]);
assert.equal(
  historyWritesForTransitions.filter(([method, url]) => method === "push" && url === "/now/seen/quotes").length,
  0
);
assert.equal(
  historyWritesForTransitions.filter(([method, url]) => method === "push" && url === "/now/seen/books").length,
  1
);

const oldPopGate = deferred();
const popTarget = new EventTargetFixture();
const popLocation = { pathname: "/now/today", search: "", hash: "" };
const popWrites = [];
const popScrolls = [];
const popHistory = {
  state: null,
  scrollRestoration: "auto",
  replaceState(state, _title, value) {
    this.state = state;
    popWrites.push(value);
    const url = new URL(value, "https://router.test");
    popLocation.pathname = url.pathname;
    popLocation.search = url.search;
  },
  pushState(state, title, value) {
    this.replaceState(state, title, value);
  }
};
let popLeaves = 0;
let failPop = false;
const popRouter = createPageRouter({
  query: () => null,
  queryAll: () => [],
  location: popLocation,
  history: popHistory,
  eventTarget: popTarget,
  basePath: "/now",
  requestFrame,
  cancelFrame,
  setTimer,
  clearTimer,
  readScroll: () => ({ x: 0, y: 0 }),
  scrollTo: value => popScrolls.push(value)
});
popRouter.start({
  leave() {
    if (failPop) throw new Error("pop failed");
    popLeaves += 1;
    if (popLeaves === 1) return oldPopGate.promise;
  },
  enter() {}
});
popLocation.pathname = "/now/seen/books";
popTarget.dispatch("popstate", { state: null });
await flush();
const pendingQuotes = popRouter.switchView("quotes");
const writesBeforeOldPop = popWrites.length;
const scrollsBeforeOldPop = popScrolls.length;
const framesBeforeOldPop = frames.size;
oldPopGate.resolve();
await pendingQuotes;
assert.equal(popWrites.length, writesBeforeOldPop + 1);
assert.equal(popWrites.at(-1), "/now/seen/quotes");
assert.equal(popScrolls.length, scrollsBeforeOldPop);
assert.equal(frames.size, framesBeforeOldPop);
assert.equal(popLocation.pathname, "/now/seen/quotes");
failPop = true;
popLocation.pathname = "/now/seen/books";
popTarget.dispatch("popstate", { state: null });
await flush();
assert.equal(popLocation.pathname, "/now/seen/quotes");
assert.equal(popRouter.currentRoute().view, "quotes");

const failureEvents = [];
let failureMode = "sync";
const failureRouter = createPageRouter({
  query: () => null,
  queryAll: () => [],
  scrollTo: () => {},
  onRoute: (route, context) => failureEvents.push([
    route.view,
    context.transitionError?.message || ""
  ])
});
failureRouter.start({
  leave() {
    if (failureMode === "sync") throw new Error("leave failed");
    return Promise.reject(new Error("leave failed"));
  },
  enter() {}
});
await assert.rejects(failureRouter.switchView("books"), /leave failed/);
assert.deepEqual(failureEvents.at(-1), ["today", "leave failed"]);
assert.equal(failureRouter.currentRoute().view, "today");
failureMode = "async";
await assert.rejects(failureRouter.switchView("books"), /leave failed/);
assert.deepEqual(failureEvents.at(-1), ["today", "leave failed"]);
assert.equal(failureRouter.currentRoute().view, "today");

console.log("Page router lifecycle regression passed.");

// F4：位置写入不能抢占尚在enter中的详情提交；锚点接管后旧绝对恢复失效。
{
  const target = new EventTargetFixture(), gate = deferred();
  const localLocation = { pathname: "/now/thoughts", search: "", hash: "" }, writes = [], positions = [];
  const write = (state, _title, url) => { const next = new URL(url, "https://test"); localLocation.pathname = next.pathname; localLocation.search = next.search; localHistory.state = state; writes.push(url); };
  const localHistory = { state: null, pushState: write, replaceState: write };
  const r = createPageRouter({ query: () => null, queryAll: () => [], location: localLocation, history: localHistory, eventTarget: target, basePath: "/now", requestFrame, cancelFrame, setTimer, clearTimer, scrollTo: value => positions.push(value) });
  const dispose = r.start({ leave() {}, enter: route => route.kind === "detail" ? gate.promise : undefined });
  const navigation = r.openDetail("thought-chain", "chain"); await flush();
  const before = writes.length;
  target.dispatch("scroll"); runFrames();
  assert.equal(r.replaceQuery({ cursor: "stale-position" }, { apply: false, onlyCommitted: true }), false);
  assert.equal(writes.length, before);
  gate.resolve(); await navigation;
  assert.equal(localLocation.pathname, "/now/thoughts/chain");
  r.restoreCurrentScroll({ x: 0, y: 999 }); r.cancelScrollRestoration();
  runFrames(); runFrames(); runTimers();
  assert.equal(positions.some(value => value.top === 999), false);
  dispose();
}
