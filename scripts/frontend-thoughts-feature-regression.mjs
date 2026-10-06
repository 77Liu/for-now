import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createThoughtChains,
  currentUserConclusion,
  normalizeThoughtSearch,
  thoughtListPreview,
  thoughtMatchesSearch,
  visibleThoughtChains
} from "../public/frontend/features/thoughts/model.mjs";
import { createThoughtPresentation } from "../public/frontend/features/thoughts/presentation.mjs";

const occurred = (day, hour) => `2026-10-${day}T${hour}:00:00.000Z`;
const records = [
  {
    id: "root-old",
    type: "question",
    content: "如何稳定推进长期项目",
    tags: ["复盘"],
    remarks: [{ id: "remark-1", text: "先缩小范围", createdAt: occurred("04", "10") }],
    followUps: [],
    occurredAt: occurred("04", "09"),
    createdAt: occurred("06", "09"),
    version: 2,
    authorType: "user"
  },
  {
    id: "idea-old",
    type: "idea",
    relatedTo: "root-old",
    content: "每天完成一个闭环",
    authorType: "user",
    occurredAt: occurred("04", "09"),
    createdAt: occurred("04", "09"),
    version: 1
  },
  {
    id: "answer-ai",
    type: "answer",
    relatedTo: "root-old",
    content: "AI 建议",
    authorType: "ai",
    occurredAt: occurred("04", "11"),
    createdAt: occurred("04", "11"),
    version: 1
  },
  {
    id: "answer-user",
    type: "answer",
    relatedTo: "root-old",
    content: "结论：只保留一个当前目标",
    authorType: "user",
    occurredAt: occurred("05", "11"),
    createdAt: occurred("05", "11"),
    version: 1
  },
  {
    id: "root-new",
    type: "question",
    content: "今天先做什么",
    tags: ["行动"],
    remarks: [],
    followUps: [{
      id: "follow-1",
      question: "先完成哪一步",
      answer: "",
      version: 1,
      createdAt: occurred("06", "10")
    }],
    occurredAt: occurred("06", "08"),
    createdAt: occurred("04", "08"),
    version: 1,
    authorType: "user"
  },
  {
    id: "orphan",
    type: "record",
    relatedTo: "missing-root",
    content: "旧记录",
    occurredAt: occurred("03", "08"),
    createdAt: occurred("03", "08"),
    version: 1
  }
];

assert.equal(normalizeThoughtSearch("  长期   项目 "), "长期 项目");
assert.deepEqual(
  createThoughtChains(records, "occurred").map(chain => chain.question.id),
  ["root-new", "root-old", "orphan"]
);
assert.deepEqual(
  createThoughtChains(records, "created").map(chain => chain.question.id),
  ["root-old", "root-new", "orphan"]
);
const oldChain = createThoughtChains(records).find(chain => chain.question.id === "root-old");
assert.equal(currentUserConclusion(oldChain.children).id, "answer-user");
assert.deepEqual(thoughtListPreview(oldChain.children), {
  kind: "conclusion",
  label: "我的结论",
  text: "只保留一个当前目标"
});
assert.equal(thoughtMatchesSearch(oldChain, "长期 一个"), true);
assert.equal(thoughtMatchesSearch(oldChain, "不存在"), false);
assert.deepEqual(
  visibleThoughtChains({
    records,
    tag: "复盘",
    query: "每天",
    complete: true
  }).items.map(chain => chain.question.id),
  ["root-old"]
);
assert.deepEqual(
  visibleThoughtChains({
    records,
    tag: "复盘",
    query: "不存在",
    complete: false
  }).items.map(chain => chain.question.id),
  ["root-old"],
  "server-projected pages must not be filtered a second time"
);

const snapshot = {
  thoughts: records,
  aiTasks: [{
    id: "task-1",
    kind: "followUpAnswer",
    targetId: "root-new",
    subtargetId: "follow-1",
    status: "queued"
  }],
  insights: { aiOnlyThoughtIds: ["root-new"] },
  speech: {
    configured: true,
    voices: [{ id: "voice-1", label: "官方音色" }],
    assets: [{
      id: "asset-1",
      sourceType: "thoughtAnswer",
      sourceId: "answer-ai",
      sourceVersion: 1,
      voice: "voice-1",
      createdAt: occurred("06", "12")
    }]
  }
};
const presentation = createThoughtPresentation({
  getSnapshot: () => snapshot,
  appUrl: value => `/now${value}`,
  contextReceiptMarkup: () => "",
  contentImagesMarkup: () => ""
});
const listMarkup = presentation.cardsMarkup(createThoughtChains(records), "occurred", {
  groupMonths: true
});
assert.match(listMarkup, /data-chain-id="root-new"/);
assert.match(listMarkup, /回答正在后台生成，可继续使用其他功能/);
assert.match(listMarkup, /thought-trace-pending/);
const detailMarkup = presentation.cardsMarkup([oldChain], "occurred", { detail: true });
assert.equal((detailMarkup.match(/thought-detail-title/g) || []).length, 1);
assert.equal((detailMarkup.match(/class="chain-summary"/g) || []).length, 0);
assert.match(detailMarkup, /data-speech-source-version="1"/);
assert.match(detailMarkup, /\/now\/api\/speech\/audio\?id=asset-1/);

const runtime = await readFile(
  new URL("../public/frontend/app/runtime.mjs", import.meta.url),
  "utf8"
);
for (const removed of [
  "function renderThoughts(",
  "function thoughtChains(",
  "function patchThoughtTaskTarget(",
  "function openThoughtBlockEditor(",
  "function loadMoreThoughts("
]) {
  assert.equal(runtime.includes(removed), false, `runtime retains thought implementation: ${removed}`);
}
assert.match(runtime, /import\("\.\.\/features\/thoughts\/index\.mjs"\)/);
assert.match(runtime, /descriptors\.thoughts=.*loadThoughtsPage\("thoughts"\)/);
assert.match(runtime, /descriptors\.together=.*loadThoughtsPage\("together"\)/);

for (const file of [
  "controller.mjs",
  "loader.mjs",
  "model.mjs",
  "operations.mjs",
  "presentation.mjs",
  "speech.mjs",
  "view.mjs"
]) {
  const source = await readFile(
    new URL(`../public/frontend/features/thoughts/${file}`, import.meta.url),
    "utf8"
  );
  assert.ok(source.split(/\r?\n/).length <= 500, `${file} exceeds 500 lines`);
}

console.log(
  "Frontend thoughts feature checks passed: hierarchy, search, route presentation, "
  + "source-versioned speech and legacy runtime removal."
);
