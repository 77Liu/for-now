import assert from "node:assert/strict";
import { routeStateProjection, startupProjection } from "../src/app/index.mjs";
import { createStartupHttp } from "../src/http/index.mjs";

const large = "x".repeat(20_000);
const thoughts = Array.from({ length: 30 }, (_, index) => {
  const id = `root-${index}`;
  return [
    {
      id,
      type: "question",
      content: `${index === 0 ? "today" : "earlier"}-${large}`,
      occurredAt: index === 0 ? "2026-10-04T08:00:00.000Z" : `2026-09-${String(30 - index).padStart(2, "0")}T08:00:00.000Z`,
      occurredOn: index === 0 ? "2026-10-04" : `2026-09-${String(30 - index).padStart(2, "0")}`,
      tags: ["test"],
      annotations: [{ text: large }],
      followUps: [{ question: large }],
      version: 1
    },
    {
      id: `idea-${index}`,
      type: "idea",
      relatedTo: id,
      content: large,
      occurredAt: index === 0 ? "2026-10-04T08:01:00.000Z" : `2026-09-${String(30 - index).padStart(2, "0")}T08:01:00.000Z`,
      authorType: "user",
      reasoningContent: large,
      modelDraft: large,
      version: 1
    }
  ];
}).flat();
const store = {
  _persistence: { sync: { cursor: 42 } },
  onboardingV2: { session: { status: "completed" }, privateDraft: large },
  notifications: [{ id: "notice", status: "succeeded", readAt: "" }]
};
const publicState = {
  checkins: [{ id: "checkin", occurredAt: "2026-10-04T09:00:00.000Z", mood: 4 }],
  thoughts,
  books: [{ id: "book", title: "Book", notes: [{ id: "note", content: "Note", occurredAt: "2026-10-03T09:00:00.000Z" }] }],
  quotes: [{ id: "quote", source: "Source", content: "Quote", occurredAt: "2026-10-02T09:00:00.000Z" }],
  keepsakes: [{ id: "keepsake", title: "Keepsake", thumbPath: "/attachments/thumb.webp", occurredAt: "2026-10-04T07:00:00.000Z" }],
  clusters: [{ theme: "Oversized", items: thoughts }],
  insights: { weekly: {} },
  speech: { assets: [] },
  notificationUnread: 1
};

const startup = startupProjection({
  store,
  user: { id: "account", username: "owner", role: "owner" },
  version: "test",
  releaseVersion: "0.5.7",
  capabilities: ["ai-costs"],
  features: { incrementalSync: true },
  governanceUrl: "/platform/",
  unread: 1
});
const startupText = JSON.stringify(startup);
assert.equal(startup.accountCursor, 42);
assert.equal(startup.onboardingV2.session.status, "completed");
assert.equal(startup.notificationUnread, 1);
for (const forbidden of ["thoughts", "clusters", "keepsakes", "attachmentPath", large]) {
  assert.equal(startupText.includes(forbidden), false);
}
assert.ok(Buffer.byteLength(startupText) <= 25 * 1024);

const today = routeStateProjection(publicState, { view: "today", currentDate: "2026-10-04" });
assert.equal(Object.hasOwn(today, "clusters"), false);
assert.equal(Object.hasOwn(today, "books"), false);
assert.equal(Object.hasOwn(today, "quotes"), false);
assert.equal(Object.hasOwn(today, "thoughts"), false);
assert.ok(today.homeMemories.length <= 30);
assert.equal(JSON.stringify(today).includes("reasoningContent"), false);
assert.ok(Buffer.byteLength(JSON.stringify(today)) <= 200 * 1024);

const together = routeStateProjection(publicState, { view: "together", currentDate: "2026-10-04" });
assert.equal(together.thoughts.filter(item => item.type === "question").length, 1);
assert.equal(JSON.stringify(together).includes("reasoningContent"), false);

const captures = routeStateProjection({
  ...publicState,
  captures: [{ id: "capture", content: "Capture" }],
  thoughts: [{ id: "linked", type: "question", sourceRef: { type: "capture", id: "capture" }, content: "Linked" }]
}, { view: "captures" });
assert.equal(captures.captures.length, 1);
assert.equal(captures.thoughts.length, 1);
assert.equal(Object.hasOwn(captures, "clusters"), false);

const responses = [];
const v1 = {
  success(_res, status, data) {
    responses.push({ status, data });
    return true;
  },
  error(_res, status, message, code) {
    responses.push({ status, message, code });
    return true;
  }
};
const http = createStartupHttp({
  readStartup: async () => startup,
  readRouteState: async route => ({ route })
});
assert.equal(await http.handleV1({ method: "GET" }, {}, new URL("http://local/api/v1/startup"), v1), true);
assert.equal(responses.at(-1).data.protocolVersion, 1);
assert.equal(await http.handleV1({ method: "GET" }, {}, new URL("http://local/api/v1/route-state?view=today"), v1), true);
assert.equal(responses.at(-1).data.route.view, "today");
assert.equal(await http.handleV1({ method: "GET" }, {}, new URL("http://local/api/v1/route-state?view=unknown"), v1), true);
assert.deepEqual(responses.at(-1), { status: 400, message: "页面标识无效", code: "INVALID_ROUTE_VIEW" });
assert.equal(await http.handleV1({ method: "POST" }, {}, new URL("http://local/api/v1/startup"), v1), false);

console.log("Startup projection checks passed: bounded startup/current-route data, hidden-domain exclusion and route validation.");
