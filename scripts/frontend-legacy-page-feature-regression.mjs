import assert from "node:assert/strict";
import {
  LEGACY_PAGE_VIEWS,
  createLegacyPageController
} from "../public/frontend/features/legacy-pages/index.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));

assert.equal(LEGACY_PAGE_VIEWS.length, 16);
assert.equal(new Set(LEGACY_PAGE_VIEWS).size, LEGACY_PAGE_VIEWS.length);
assert.equal(LEGACY_PAGE_VIEWS.includes("export"), false);
assert.equal(LEGACY_PAGE_VIEWS.includes("feedback"), false);
assert.equal(LEGACY_PAGE_VIEWS.includes("discovery"), false);
assert.equal(LEGACY_PAGE_VIEWS.includes("notifications"), false);
assert.equal(LEGACY_PAGE_VIEWS.includes("books"), false);
assert.equal(LEGACY_PAGE_VIEWS.includes("quotes"), false);
assert.equal(LEGACY_PAGE_VIEWS.includes("keepsakes"), false);
assert.equal(LEGACY_PAGE_VIEWS.includes("review"), false);
assert.equal(LEGACY_PAGE_VIEWS.includes("statistics"), false);
assert.throws(
  () => createLegacyPageController({ view: "export" }),
  /Unknown legacy page view/
);

{
  const events = [];
  const controller = createLegacyPageController({
    view: "today",
    onMount: context => events.push(["mount", context.route.id, context.generation]),
    onRender: context => events.push(["render", context.snapshot.value, context.generation]),
    onUnmount: context => events.push(["unmount", context.route.id, context.generation]),
    onResetSession: context => events.push(["reset", context.view])
  });
  const signal = new AbortController();
  const root = {};
  const dispose = await controller.mount({
    root,
    route: { view: "today", id: "first" },
    signal: signal.signal
  });
  assert.equal(await controller.render({ snapshot: { value: "one" } }), 2);
  await dispose();
  await dispose();
  assert.equal(controller.render({ snapshot: { value: "ignored" } }), false);

  const nextSignal = new AbortController();
  await controller.mount({
    root,
    route: { view: "today", id: "second" },
    signal: nextSignal.signal
  });
  nextSignal.abort();
  await flush();
  assert.equal(controller.render({ snapshot: { value: "ignored" } }), false);
  await controller.resetSession();
  assert.deepEqual(events, [
    ["mount", "first", 1],
    ["render", "one", 1],
    ["unmount", "first", 1],
    ["mount", "second", 2],
    ["unmount", "second", 2],
    ["reset", "today"]
  ]);
}

{
  let active = 0;
  let peak = 0;
  let unmounts = 0;
  const controller = createLegacyPageController({
    view: "settings",
    onMount() {
      active += 1;
      peak = Math.max(peak, active);
    },
    onUnmount() {
      active -= 1;
      unmounts += 1;
    }
  });
  for (let index = 0; index < 20; index += 1) {
    const signal = new AbortController();
    const dispose = await controller.mount({
      root: {},
      route: { view: "settings", id: index },
      signal: signal.signal
    });
    await dispose();
  }
  assert.equal(active, 0);
  assert.equal(peak, 1);
  assert.equal(unmounts, 20);
}

{
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const events = [];
  const controller = createLegacyPageController({
    view: "about",
    async onMount() {
      events.push("mount");
      await gate;
    },
    onUnmount() {
      events.push("unmount");
    }
  });
  const signal = new AbortController();
  const pending = controller.mount({
    root: {},
    route: { view: "about" },
    signal: signal.signal
  });
  await flush();
  signal.abort();
  release();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(events, ["mount", "unmount"]);
}

console.log("Legacy page feature regression passed: explicit transitional views, disposable lifecycle and abort-safe mount.");
