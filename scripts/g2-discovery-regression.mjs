import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import {
  createThoughtDiscoveryService,
  normalizeThoughtDiscoveryFilters
} from "../src/modules/discovery/index.mjs";
import {
  createThoughtDiscoveryController
} from "../public/frontend/features/thought-discovery/index.mjs";

const root = (id, occurredAt, content, extra = {}) => ({
  id,
  type: "question",
  content,
  authorType: "user",
  origin: "manual",
  relatedTo: null,
  occurredAt,
  occurredOn: occurredAt.slice(0, 10),
  createdAt: occurredAt,
  version: 1,
  tags: [],
  remarks: [],
  followUps: [],
  annotations: [],
  annotationDrift: [],
  ...extra
});
const block = (id, rootId, type, occurredAt, content, extra = {}) => ({
  id,
  type,
  content,
  authorType: "user",
  origin: "manual",
  relatedTo: rootId,
  occurredAt,
  occurredOn: occurredAt.slice(0, 10),
  createdAt: occurredAt,
  version: 1,
  tags: [],
  ...extra
});
const aiAnswer = (id, rootId, occurredAt, content, extra = {}) => block(
  id,
  rootId,
  "answer",
  occurredAt,
  content,
  {
    authorType: "ai",
    origin: "deepseek",
    modelDraft: content,
    editedFromModel: false,
    ...extra
  }
);

const accountAThoughts = [
  root("q-search", "2026-09-29T09:00:00.000Z", "如何建立检索系统", { tags: ["工具"] }),
  block("idea-search", "q-search", "idea", "2026-09-29T09:01:00.000Z", "先从用户想法开始"),
  aiAnswer("answer-search-ai", "q-search", "2026-09-29T09:02:00.000Z", "AI 给出的检索建议"),
  block("answer-search-user", "q-search", "answer", "2026-09-29T09:03:00.000Z", "这是我自己的答案"),
  block("record-search", "q-search", "record", "2026-09-29T09:04:00.000Z", "检索复盘记录", { tags: ["专题检索"] }),
  root("q-fresh", "2026-09-28T09:00:00.000Z", "职业选择"),
  aiAnswer("answer-fresh", "q-fresh", "2026-09-28T09:01:00.000Z", "尚未回应的职业建议"),
  root("q-knowledge", "2026-09-27T09:00:00.000Z", "如何整理知识"),
  aiAnswer("answer-knowledge", "q-knowledge", "2026-09-27T09:01:00.000Z", "尚未回应的知识建议"),
  root("q-snooze", "2026-09-26T09:00:00.000Z", "需要晚点回看的问题"),
  aiAnswer("answer-snooze", "q-snooze", "2026-09-26T09:01:00.000Z", "尚未回应的晚点建议"),
  root("q-manual", "2026-09-25T09:00:00.000Z", "只有用户内容"),
  block("record-manual", "q-manual", "record", "2026-09-25T09:01:00.000Z", "另一个用户记录")
];
const accountBThoughts = [
  root("q-fresh", "2026-09-20T09:00:00.000Z", "另一个账户的同 ID 问题"),
  aiAnswer("answer-fresh-b", "q-fresh", "2026-09-20T09:01:00.000Z", "另一个账户的 AI 回答")
];

const context = new AsyncLocalStorage();
const accounts = new Map([
  ["account-a", structuredClone(accountAThoughts)],
  ["account-b", structuredClone(accountBThoughts)]
]);
const failedCommits = new Set();
const updateAttempts = new Map();
const repository = {
  async read() {
    const accountId = context.getStore();
    assert.ok(accounts.has(accountId), "repository requires an account context");
    return structuredClone(accounts.get(accountId));
  },
  async update(mutator) {
    const accountId = context.getStore();
    assert.ok(accounts.has(accountId), "repository requires an account context");
    const candidate = structuredClone(accounts.get(accountId));
    const result = await mutator(candidate);
    updateAttempts.set(accountId, (updateAttempts.get(accountId) || 0) + 1);
    if (failedCommits.has(accountId)) throw new Error("commit unavailable");
    accounts.set(accountId, candidate);
    return result;
  }
};
const run = (accountId, operation) => context.run(accountId, operation);
let clock = "2026-09-29T10:00:00.000Z";
const discovery = createThoughtDiscoveryService({
  repository,
  now: () => clock,
  random: () => 0
});

assert.deepEqual(normalizeThoughtDiscoveryFilters({
  query: "  检索 ",
  types: "answer,question",
  fresh: "fresh",
  limit: 999
}), {
  query: "检索",
  types: ["question", "answer"],
  genres: ["thought"],
  freshOnly: true,
  cursor: "",
  limit: 100
});
assert.equal(normalizeThoughtDiscoveryFilters({ types: ["unknown"] }).code, "INVALID_DISCOVERY_TYPES");

const combined = await run("account-a", () => discovery.search({
  query: "检索",
  types: ["question", "record"]
}));
assert.equal(combined.items.length, 1);
assert.deepEqual(combined.items[0].matches.map(item => item.type), ["question", "record"]);
assert.ok(combined.items[0].matches.every(item => item.source === "user"));
assert.ok(combined.items[0].matches.every(item => item.sourceLabel === "用户原文"));

const aiSearch = await run("account-a", () => discovery.search({
  query: "AI 给出",
  types: ["answer"]
}));
assert.equal(aiSearch.items[0].matches[0].source, "ai");
assert.equal(aiSearch.items[0].matches[0].sourceLabel, "AI 派生");
const userAnswerSearch = await run("account-a", () => discovery.search({
  query: "自己的答案",
  types: ["answer"]
}));
assert.equal(userAnswerSearch.items[0].matches[0].source, "user");
const tagSearch = await run("account-a", () => discovery.search({
  query: "专题",
  types: ["record"]
}));
assert.deepEqual(tagSearch.items[0].matches[0].match, {
  content: false,
  tags: ["专题检索"]
});
assert.equal((await run("account-a", () => discovery.search({ types: [] }))).total, 0);
assert.equal((await run("account-a", () => discovery.search({ types: ["bad"] }))).code, "INVALID_DISCOVERY_TYPES");

const firstPage = await run("account-a", () => discovery.search({ limit: 2 }));
assert.deepEqual(firstPage.items.map(item => item.id), ["q-search", "q-fresh"]);
assert.ok(firstPage.nextCursor);
accounts.get("account-a").unshift(
  root("q-inserted", "2026-09-30T09:00:00.000Z", "分页后新插入的思绪")
);
const secondPage = await run("account-a", () => discovery.search({
  limit: 2,
  cursor: firstPage.nextCursor
}));
assert.deepEqual(secondPage.items.map(item => item.id), ["q-knowledge", "q-snooze"]);
assert.ok(!secondPage.items.some(item => firstPage.items.some(first => first.id === item.id)));
assert.deepEqual(await run("account-a", () => discovery.search({
  types: ["answer"],
  cursor: firstPage.nextCursor
})), { invalidCursor: true });
assert.deepEqual(await run("account-a", () => discovery.search({ cursor: "not-a-cursor" })), {
  invalidCursor: true
});

assert.equal(await run("account-a", () => discovery.countUntraced()), 3);
const fresh = await run("account-a", () => discovery.search({ freshOnly: true }));
assert.deepEqual(fresh.items.map(item => item.id), ["q-fresh", "q-knowledge", "q-snooze"]);
assert.equal(fresh.untracedCount, 3);
assert.equal(fresh.totalUntracedCount, 3);
assert.equal(combined.items[0].untraced, false, "a user idea/record/answer is a trace");

const marked = await run("account-a", () => discovery.markRead("q-fresh"));
assert.equal(marked.value.status.read, true);
assert.equal(marked.value.fresh, false);
assert.equal(await run("account-a", () => discovery.countUntraced()), 2);
assert.ok(accounts.get("account-a").find(item => item.id === "q-fresh").discovery.seenRevision);
assert.equal(accounts.get("account-b").find(item => item.id === "q-fresh").discovery, undefined);
assert.equal((await run("account-b", () => discovery.search({ freshOnly: true }))).items[0].id, "q-fresh");

accounts.get("account-a").push(
  aiAnswer("answer-fresh-new", "q-fresh", "2026-09-29T10:01:00.000Z", "刚生成的新回答")
);
assert.equal((await run("account-a", () => discovery.search({
  query: "职业选择",
  types: ["question"],
  freshOnly: true
}))).items[0].id, "q-fresh", "new AI content must become fresh after a prior read");

const snoozed = await run("account-a", () => discovery.snooze(
  "q-snooze",
  "2026-09-29T12:00:00.000Z"
));
assert.equal(snoozed.value.status.snoozed, true);
assert.equal(snoozed.value.fresh, false);
const beforeInvalidSnooze = structuredClone(accounts.get("account-a"));
const attemptsBeforeInvalidSnooze = updateAttempts.get("account-a");
assert.equal((await run("account-a", () => discovery.snooze(
  "q-snooze",
  "not-a-time"
))).code, "INVALID_SNOOZE_UNTIL");
assert.deepEqual(accounts.get("account-a"), beforeInvalidSnooze);
assert.equal(updateAttempts.get("account-a"), attemptsBeforeInvalidSnooze);
clock = "2026-09-29T13:00:00.000Z";
assert.equal((await run("account-a", () => discovery.search({
  query: "晚点回看",
  types: ["question"],
  freshOnly: true
}))).items[0].id, "q-snooze", "snoozed entries must return after expiry");
assert.equal((await run("account-a", () => discovery.clearSnooze("q-snooze"))).value.status.snoozed, false);
assert.deepEqual(await run("account-a", () => discovery.markRead("missing")), { missing: true });

const recordFilters = { types: ["record"], limit: 1 };
const allRecordResults = await run("account-a", () => discovery.search({ ...recordFilters, limit: 100 }));
const firstDoor = await run("account-a", () => discovery.openRandomDoor(recordFilters));
assert.equal(firstDoor.value.id, allRecordResults.items[0].id);
const lastDoor = await run("account-a", () => discovery.openRandomDoor(
  recordFilters,
  { random: () => 1 }
));
assert.equal(lastDoor.total, allRecordResults.total);
assert.equal(lastDoor.value.id, allRecordResults.items.at(-1).id);
assert.ok(lastDoor.value.matches.every(item => item.type === "record"));
assert.deepEqual(await run("account-a", () => discovery.openRandomDoor({
  query: "没有命中",
  types: ["question"]
})), { value: null, total: 0 });

const beforeFailedCommit = structuredClone(accounts.get("account-a"));
failedCommits.add("account-a");
await assert.rejects(
  run("account-a", () => discovery.markRead("q-knowledge")),
  /commit unavailable/
);
failedCommits.delete("account-a");
assert.deepEqual(accounts.get("account-a"), beforeFailedCommit);

const frontendSource = await fs.readFile(
  new URL("../public/frontend/features/thought-discovery/index.mjs", import.meta.url),
  "utf8"
);
assert.doesNotMatch(frontendSource, /\b(?:fetch|XMLHttpRequest|document|window)\b/);

const frontendCalls = [];
const navigated = [];
const frontItem = (id, source = "user") => ({
  id,
  rootId: id,
  matches: [{ id: `${id}-match`, rootId: id, type: "answer", source, sourceLabel: source === "ai" ? "AI 派生" : "用户原文" }],
  status: { fresh: true, untraced: true, read: false, snoozed: false },
  fresh: true,
  untraced: true
});
const frontendTransport = {
  async search(input) {
    frontendCalls.push(["search", structuredClone(input)]);
    if (input.cursor === "front-next") return {
      items: [frontItem("front-b")],
      nextCursor: "",
      total: 2,
      untracedCount: 2,
      totalUntracedCount: 2
    };
    return {
      items: [frontItem("front-a", "ai")],
      nextCursor: "front-next",
      total: 2,
      untracedCount: 2,
      totalUntracedCount: 2
    };
  },
  async markRead(id) {
    frontendCalls.push(["markRead", id]);
    return {
      value: {
        id,
        status: { fresh: false, untraced: true, read: true, snoozed: false },
        fresh: false,
        untraced: true
      }
    };
  },
  async snooze(id, until) {
    frontendCalls.push(["snooze", id, until]);
    return {
      value: {
        id,
        status: { fresh: false, untraced: true, read: false, snoozed: true, snoozedUntil: until },
        fresh: false,
        untraced: true
      }
    };
  },
  async openRandomDoor(filters) {
    frontendCalls.push(["door", structuredClone(filters)]);
    return { value: frontItem("front-b"), total: 2 };
  }
};
const controller = createThoughtDiscoveryController({
  transport: frontendTransport,
  onNavigate: item => navigated.push(item.id)
});
let publications = 0;
const unsubscribe = controller.subscribe(() => {
  publications += 1;
});
await controller.setFilters({
  query: "知识",
  types: ["question", "answer"],
  freshOnly: true
});
assert.deepEqual(frontendCalls[0], ["search", {
  query: "知识",
  types: ["question", "answer"],
  genres: ["thought"],
  freshOnly: true,
  cursor: ""
}]);
assert.equal(controller.getState().items[0].matches[0].source, "ai");
assert.equal(await controller.loadMore(), true);
assert.deepEqual(controller.getState().items.map(item => item.id), ["front-a", "front-b"]);
assert.equal(controller.getState().nextCursor, "");
assert.equal(await controller.markRead("front-a"), true);
assert.deepEqual(controller.getState().items.map(item => item.id), ["front-b"]);
assert.equal(controller.getState().total, 1);
assert.equal(controller.getState().untracedCount, 1);
assert.equal(controller.getState().totalUntracedCount, 2);
assert.equal(await controller.snooze("front-b", "2026-09-30T00:00:00.000Z"), true);
assert.deepEqual(controller.getState().items, []);
assert.equal(controller.getState().total, 0);
assert.equal(controller.getState().untracedCount, 0);
assert.equal(controller.getState().totalUntracedCount, 2);
assert.equal((await controller.openRandomDoor()).id, "front-b");
assert.deepEqual(navigated, ["front-b"]);
assert.deepEqual(frontendCalls.at(-1), ["door", {
  query: "知识",
  types: ["question", "answer"],
  genres: ["thought"],
  freshOnly: true
}]);
assert.ok(publications >= 7);
unsubscribe();
assert.throws(() => controller.setTypes(["unknown"], { reload: false }), /Unknown thought discovery type/);

let resolveOld;
const oldResponse = new Promise(resolve => {
  resolveOld = resolve;
});
const raceTransport = {
  search: input => input.query === "旧请求"
    ? oldResponse
    : Promise.resolve({
        items: [frontItem("new-result")],
        nextCursor: "",
        total: 1,
        untracedCount: 1,
        totalUntracedCount: 1
      }),
  markRead: async () => ({ missing: true }),
  snooze: async () => ({ missing: true }),
  openRandomDoor: async () => ({ value: null, total: 0 })
};
const raceController = createThoughtDiscoveryController({ transport: raceTransport });
const oldRequest = raceController.setQuery("旧请求");
await raceController.setQuery("新请求");
resolveOld({
  items: [frontItem("old-result")],
  nextCursor: "",
  total: 1,
  untracedCount: 1,
  totalUntracedCount: 1
});
assert.equal(await oldRequest, false);
assert.deepEqual(raceController.getState().items.map(item => item.id), ["new-result"]);

let rejectStale;
const staleTransport = {
  search: () => new Promise((resolve, reject) => {
    rejectStale = reject;
  }),
  markRead: async () => ({ missing: true }),
  snooze: async () => ({ missing: true }),
  openRandomDoor: async () => ({ value: null, total: 0 })
};
const staleController = createThoughtDiscoveryController({ transport: staleTransport });
const staleRequest = staleController.refresh();
staleController.reset();
rejectStale(new Error("stale failure"));
assert.equal(await staleRequest, false);
assert.equal(staleController.getState().error, null);

console.log("G2 discovery regression passed: filters, source identity, stable cursors, freshness, read/snooze, random door, account isolation, atomic failures, and headless controller races.");
