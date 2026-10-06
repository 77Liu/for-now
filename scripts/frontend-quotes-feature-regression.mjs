import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  quoteSkyMarkup,
  quoteTimelineMarkup,
  selectRotatingQuotes
} from "../public/frontend/features/quotes/presentation.mjs";

const quotes = [
  {
    id: "quote-1",
    source: "甲",
    content: "第一句",
    tags: ["阅读"],
    occurredAt: "2026-10-06T08:00:00.000Z"
  },
  {
    id: "quote-2",
    source: "乙",
    content: "第二句",
    tags: ["行动"],
    occurredAt: "2026-10-05T08:00:00.000Z"
  },
  {
    id: "quote-3",
    source: "丙",
    content: "第三句",
    tags: ["阅读"],
    occurredAt: "2026-10-04T08:00:00.000Z"
  },
  {
    id: "quote-4",
    source: "丁",
    content: "第四句",
    tags: [],
    occurredAt: "2026-10-03T08:00:00.000Z"
  }
];

const rotated = selectRotatingQuotes(quotes, 0);
assert.equal(rotated.length, 3);
assert.equal(new Set(rotated.map(item => item.id)).size, 3);
assert.ok(rotated.some(item => item.tags.includes("阅读")));
assert.ok(rotated.some(item => item.tags.includes("行动")));

const escapeMarkup = value => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
const sky = quoteSkyMarkup({
  quotes,
  index: 0,
  escapeMarkup,
  emptyState: () => "empty"
});
assert.equal(sky.items.length, 3);
assert.match(sky.markup, /data-quote-id="quote-1"/);
assert.match(sky.markup, /data-visible-lines="[3-5]"/);
assert.doesNotMatch(sky.markup, /<script/i);

const timeline = quoteTimelineMarkup({
  items: [
    quotes[0],
    { ...quotes[1], _sync: { status: "pending" } }
  ],
  allItems: quotes,
  escapeMarkup,
  emptySearchState: label => `empty:${label}`
});
assert.match(timeline, /data-quote-edit="quote-1"/);
assert.match(timeline, /data-quote-delete="quote-1"/);
assert.match(timeline, /待同步/);
assert.doesNotMatch(timeline, /data-quote-edit="quote-2"/);

const controller = await readFile(
  new URL("../public/frontend/features/quotes/controller.mjs", import.meta.url),
  "utf8"
);
for (const contract of [
  "createQuotesFeatureController",
  "resetSession",
  "stopBubbleScroll",
  "submissionPromise"
]) {
  assert.ok(controller.includes(contract), `quotes controller missing ${contract}`);
}
assert.doesNotMatch(controller, /from\s+["'][^"']*app\/runtime\.mjs["']/);

console.log(
  "Frontend quotes feature checks passed: rotation, escaped markup, pending actions "
  + "and lifecycle ownership."
);
