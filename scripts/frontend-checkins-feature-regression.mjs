import assert from "node:assert/strict";
import {
  buildCheckinTrend,
  buildHomeMoodSeries,
  createCheckinsFeatureController,
  renderHomeMood,
  renderStateTrend
} from "../public/frontend/features/checkins/index.mjs";

const snapshot = {
  checkins: [
    {
      id: "checkin-3",
      occurredOn: "2026-10-06",
      occurredAt: "2026-10-06T09:00:00.000Z",
      mood: 4,
      energy: 3,
      stress: 2,
      sleep: 5,
      custom: { focus: 4 }
    },
    {
      id: "checkin-2",
      occurredOn: "2026-10-06",
      occurredAt: "2026-10-06T08:00:00.000Z",
      mood: 2,
      energy: 5,
      stress: 4,
      sleep: 3,
      custom: { focus: 2 }
    },
    {
      id: "checkin-1",
      occurredOn: "2026-10-04",
      occurredAt: "2026-10-04T08:00:00.000Z",
      mood: 5,
      energy: 5,
      stress: 5,
      sleep: 5
    }
  ],
  customMetrics: [{ id: "focus", name: "专注", low: "散乱", high: "专注" }]
};

assert.deepEqual(
  buildHomeMoodSeries(snapshot.checkins, "2026-10-06", 3),
  [
    { date: "2026-10-04", count: 1, value: 5 },
    { date: "2026-10-05", count: 0, value: null },
    { date: "2026-10-06", count: 2, value: 3 }
  ]
);
const trend = buildCheckinTrend(snapshot.checkins, snapshot.customMetrics, {
  endDate: "2026-10-06",
  days: 3
});
assert.deepEqual(trend.daily.map(day => ({
  date: day.date,
  entries: day.entries,
  mood: day.mood,
  focus: day.custom.focus,
  score: day.score
})), [
  { date: "2026-10-04", entries: 1, mood: 5, focus: null, score: 100 },
  { date: "2026-10-06", entries: 2, mood: 3, focus: 3, score: 64 }
]);
assert.equal(trend.eligible.length, 3);
assert.equal(buildCheckinTrend(snapshot.checkins, [], { endDate: "bad" }).daily.length, 0);
assert.equal(buildCheckinTrend(snapshot.checkins, [], {
  endDate: "2026-10-06",
  days: Number.NaN
}).daily.length, 2);

class FakeSvgNode {
  constructor(name) {
    this.name = name;
    this.attributes = new Map();
    this.children = [];
    this.textContent = "";
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
}

const fakeDocument = {
  createElementNS(_namespace, name) {
    return new FakeSvgNode(name);
  }
};
const moodSvg = new FakeSvgNode("svg");
renderHomeMood({
  root: { querySelector: selector => selector === "#home-mood-sparkline" ? moodSvg : null },
  snapshot,
  activeDate: "2026-10-06",
  document: fakeDocument
});
assert.equal(moodSvg.children.filter(node => node.name === "polyline").length, 0);
assert.equal(moodSvg.children.filter(node => node.name === "circle").length, 2);
assert.match(moodSvg.attributes.get("aria-label"), /2 个情绪记录日/);

const stateChart = { innerHTML: "" };
const history = { innerHTML: "" };
const range = { value: "3" };
const reviewRoot = {
  querySelector(selector) {
    return {
      "#state-chart": stateChart,
      "#checkin-history": history,
      "#chart-range": range
    }[selector] || null;
  }
};
assert.equal(renderStateTrend({
  root: reviewRoot,
  snapshot,
  activeDate: "2026-10-06",
  emptyStateMarkup: ({ title }) => `<p>${title}</p>`
}), true);
assert.match(stateChart.innerHTML, /<b>2<\/b> 个记录日/);
assert.match(stateChart.innerHTML, /<b>3<\/b> 次提交/);
assert.match(stateChart.innerHTML, /专注/);
assert.match(history.innerHTML, /checkin-3/);

class FakeRoot {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const values = this.listeners.get(type) || new Set();
    values.add(listener);
    this.listeners.set(type, values);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
  change(selector) {
    for (const listener of this.listeners.get("change") || []) {
      listener({ target: { closest: value => value === selector ? {} : null } });
    }
  }
}

function createDelegate() {
  let mounted = false;
  const calls = { mounts: 0, renders: 0, unmounts: 0, resets: 0 };
  return {
    calls,
    async mount() {
      mounted = true;
      calls.mounts += 1;
      let active = true;
      return () => {
        if (!active) return false;
        active = false;
        mounted = false;
        calls.unmounts += 1;
        return true;
      };
    },
    render() {
      if (!mounted) return false;
      calls.renders += 1;
      return true;
    },
    async unmount() {
      if (!mounted) return false;
      mounted = false;
      calls.unmounts += 1;
      return true;
    },
    async resetSession() {
      calls.resets += 1;
    }
  };
}

for (const missing of ["getSnapshot", "getActiveDate", "emptyStateMarkup", "present"]) {
  const options = {
    delegate: createDelegate(),
    getSnapshot: () => snapshot,
    getActiveDate: () => "2026-10-06",
    document: fakeDocument,
    emptyStateMarkup: () => "",
    present: () => true
  };
  options[missing] = null;
  assert.throws(() => createCheckinsFeatureController(options), new RegExp(missing));
}

const delegate = createDelegate();
const presentations = [];
const controller = createCheckinsFeatureController({
  delegate,
  getSnapshot: () => snapshot,
  getActiveDate: () => "2026-10-06",
  document: fakeDocument,
  emptyStateMarkup: () => "",
  present: options => {
    presentations.push(options);
    return true;
  }
});
const root = new FakeRoot();
for (let cycle = 0; cycle < 10; cycle += 1) {
  const dispose = await controller.mount({
    root,
    route: { view: cycle % 2 ? "review" : "today" },
    signal: new AbortController().signal
  });
  assert.equal(root.listenerCount("change"), 1);
  const before = presentations.length;
  assert.equal(controller.render({ snapshot, changedDomains: ["thoughts"] }), true);
  assert.equal(presentations.length, before);
  assert.equal(controller.render({ snapshot, changedDomains: ["checkins"] }), true);
  assert.equal(presentations.length, before + 1);
  root.change("#chart-range");
  assert.equal(presentations.length, before + 2);
  assert.equal(await dispose(), true);
  assert.equal(await dispose(), false);
  assert.equal(root.listenerCount("change"), 0);
}
assert.deepEqual(delegate.calls.mounts, 10);
assert.deepEqual(delegate.calls.unmounts, 10);

const inactiveDispose = await controller.mount({ root, signal: new AbortController().signal });
await inactiveDispose();
const presentationsBeforeInactiveReset = presentations.length;
await controller.resetSession();
assert.deepEqual(presentations.at(-1).snapshot, { checkins: [], customMetrics: [] });
assert.equal(presentations.length, presentationsBeforeInactiveReset + 1);
assert.equal(root.listenerCount("change"), 0);
assert.equal(delegate.calls.resets, 1);

console.log(
  "Frontend checkins feature checks passed: same-day aggregation, missing-day gaps, "
  + "state trend projection, root lifecycle, range delegation and reset scrub."
);
