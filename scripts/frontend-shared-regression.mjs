import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  escapeHtml,
  inlineMarkdown,
  plainPreview,
  renderMarkdown
} from "../public/frontend/content/index.mjs";
import {
  createOccurrenceDraft,
  entryKeyIntent,
  eventDate,
  eventTimestamp,
  formatDate,
  formatDateKey,
  formatTime,
  localDateKey,
  localDateTimeForDate,
  occurrenceSubmission,
  persistedDateTimeInput,
  toLocalDateTimeInput
} from "../public/frontend/time/index.mjs";
import {
  imageRecordPayload,
  imageUnderstandingPayload,
  uploadOriginalImages,
  validatedImageFiles
} from "../public/frontend/media/index.mjs";

function verifyTimeZoneCase() {
  if (process.env.TZ === "Asia/Shanghai") {
    const beforeMidnight = "2026-09-28T15:59:59.999Z";
    const atMidnight = "2026-09-28T16:00:00.000Z";
    assert.equal(localDateKey(beforeMidnight), "2026-09-28");
    assert.equal(localDateKey(atMidnight), "2026-09-29");
    assert.equal(toLocalDateTimeInput(beforeMidnight), "2026-09-28T23:59:59");
    assert.equal(toLocalDateTimeInput(atMidnight), "2026-09-29T00:00:00");
    assert.equal(formatDate(atMidnight), "9月29日 00:00");
    assert.equal(formatTime(atMidnight), "00:00:00");
    assert.equal(localDateTimeForDate("2026-09-30", "2026-09-28T16:00:01.000Z"), "2026-09-30T00:00:01");
    assert.equal(eventDate({ createdAt: atMidnight }), "2026-09-29");
    assert.equal(eventDate({ occurredOn: "2026-09-27", occurredAt: atMidnight }), "2026-09-27");
    assert.equal(eventTimestamp({ occurredAt: atMidnight, createdAt: beforeMidnight }), atMidnight);
    assert.equal(persistedDateTimeInput({ createdAt: atMidnight }), "2026-09-29T00:00:00");
    assert.equal(persistedDateTimeInput({ occurredAt: "invalid" }), "");
    return;
  }
  if (process.env.TZ === "America/Los_Angeles") {
    const utcMidnight = "2026-09-29T00:00:00.000Z";
    assert.equal(localDateKey(utcMidnight), "2026-09-28");
    assert.equal(toLocalDateTimeInput(utcMidnight), "2026-09-28T17:00:00");
    assert.equal(formatDate(utcMidnight), "9月28日 17:00");
    assert.equal(formatTime(utcMidnight), "17:00:00");
    return;
  }
  assert.fail(`Unexpected timezone case: ${process.env.TZ}`);
}

if (process.argv.includes("--timezone-case")) {
  verifyTimeZoneCase();
} else {
  const moduleUrls = [
    new URL("../public/frontend/content/index.mjs", import.meta.url),
    new URL("../public/frontend/time/index.mjs", import.meta.url),
    new URL("../public/frontend/media/index.mjs", import.meta.url)
  ];
  for (const url of moduleUrls) {
    const source = await fs.readFile(url, "utf8");
    assert.doesNotMatch(source, /\b(?:document|window|fetch|XMLHttpRequest|FileReader)\b/, `${url.pathname} must stay independent of DOM globals and network I/O`);
  }

  assert.equal(
    escapeHtml('<script>alert("x")</script>&'),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;"
  );
  const unsafe = renderMarkdown([
    '<img src=x onerror="alert(1)">',
    "",
    "[脚本](javascript:alert(1)) [数据](data:text/html,x)",
    "",
    "[站内](/safe?q=1&x=2) [站外](https://example.com/path)"
  ].join("\n"));
  assert.doesNotMatch(unsafe, /<(?:img|script)\b/i);
  assert.doesNotMatch(unsafe, /href="(?:javascript|data):/i);
  assert.match(unsafe, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(unsafe, /<a href="\/safe\?q=1&amp;x=2">站内<\/a>/);
  assert.match(unsafe, /<a href="https:\/\/example\.com\/path" target="_blank" rel="noopener noreferrer">站外<\/a>/);

  const markdown = [
    "# 标题",
    "",
    "第一行",
    "第二行",
    "",
    "- **粗体**",
    "- *斜体*",
    "",
    "> 引用",
    "",
    "| A | B |",
    "| --- | --- |",
    "| `x` | ~~y~~ |",
    "",
    "\\(E=mc^2\\) 与 $a_b$",
    "",
    "$$\\int_0^1 x^2 dx$$",
    "",
    "```html",
    '<strong title="literal">代码</strong>',
    "```"
  ].join("\n");
  const rendered = renderMarkdown(markdown);
  assert.match(rendered, /^<h1>标题<\/h1>/);
  assert.match(rendered, /<p>第一行<br>第二行<\/p>/);
  assert.match(rendered, /<ul><li><strong>粗体<\/strong><\/li><li><em>斜体<\/em><\/li><\/ul>/);
  assert.match(rendered, /<blockquote><p>引用<\/p><\/blockquote>/);
  assert.match(rendered, /<table>[\s\S]*<code>x<\/code>[\s\S]*<del>y<\/del>[\s\S]*<\/table>/);
  assert.match(rendered, /<pre><code class="language-html">&lt;strong title=&quot;literal&quot;&gt;代码&lt;\/strong&gt;<\/code><\/pre>$/);
  assert.doesNotMatch(rendered, /\u0000/);
  const latex = [...rendered.matchAll(/class="latex-(?:inline|display)" data-tex="([^"]*)"/g)]
    .map(match => decodeURIComponent(match[1]));
  assert.deepEqual(latex, ["E=mc^2", "a_b", "\\int_0^1 x^2 dx"]);
  assert.equal(
    inlineMarkdown("**粗体**、`<b>代码</b>`、\\(E=mc^2\\)"),
    '<strong>粗体</strong>、<code>&lt;b&gt;代码&lt;/b&gt;</code>、<span class="latex-inline" data-tex="E%3Dmc%5E2"></span>'
  );
  assert.equal(
    plainPreview("![封面](cover.png) [链接](https://example.com) **粗体** \\[x+y\\]"),
    "封面 链接 粗体 x+y"
  );

  assert.equal(formatDateKey("2026-09-29"), "2026年9月29日");
  assert.equal(formatDateKey(""), "");
  const openedAt = new Date(2026, 8, 29, 23, 58, 20);
  const afterMinute = new Date(2026, 8, 29, 23, 59, 40);
  const afterMidnight = new Date(2026, 8, 30, 0, 3, 5);
  const currentDraft = createOccurrenceDraft({ now: openedAt });
  assert.equal(currentDraft.mode, "now");
  assert.deepEqual(occurrenceSubmission(currentDraft, { now: afterMinute }), { timeMode: "now" });
  assert.deepEqual(occurrenceSubmission(currentDraft, { now: afterMidnight }), { timeMode: "now" });
  assert.deepEqual(occurrenceSubmission(currentDraft, { now: new Date(2026, 9, 2, 8, 30, 0) }), { timeMode: "now" });
  const historicalDraft = createOccurrenceDraft({ selectedDate: "2026-09-20", now: openedAt });
  assert.deepEqual(historicalDraft, { mode: "manual", manualValue: "2026-09-20T23:58:20" });
  const editDraft = createOccurrenceDraft({ existing: { occurredAt: "2026-09-28T16:04:03.000Z" }, now: openedAt });
  assert.deepEqual(editDraft, { mode: "manual", manualValue: toLocalDateTimeInput("2026-09-28T16:04:03.000Z") });
  const manualDraft = { mode: "manual", manualValue: "2026-09-15T07:06:05" };
  assert.deepEqual(occurrenceSubmission(manualDraft, { now: afterMidnight }), {
    timeMode: "manual",
    occurredAt: "2026-09-15T07:06:05"
  });
  assert.throws(() => occurrenceSubmission({ mode: "manual", manualValue: "" }), /手动指定发生时间/);
  assert.throws(() => occurrenceSubmission({ mode: "manual", manualValue: "2026-02-31T07:06:05" }), /手动指定发生时间/);
  assert.equal(entryKeyIntent({ key: "Enter" }, { inputKind: "tag" }), "commit-tag");
  assert.equal(entryKeyIntent({ key: "," }, { inputKind: "tag" }), "commit-tag");
  assert.equal(entryKeyIntent({ key: "Enter", metaKey: true }, { inputKind: "multiline" }), "submit");
  assert.equal(entryKeyIntent({ key: "Enter", ctrlKey: true }, { inputKind: "field" }), "submit");
  assert.equal(entryKeyIntent({ key: "Enter" }, { inputKind: "multiline" }), "newline");
  assert.equal(entryKeyIntent({ key: "Enter" }, { inputKind: "field" }), "block-submit");
  assert.equal(entryKeyIntent({ key: "Enter", metaKey: true, isComposing: true }, { inputKind: "field" }), "none");
  const script = fileURLToPath(import.meta.url);
  for (const timezone of ["Asia/Shanghai", "America/Los_Angeles"]) {
    execFileSync(process.execPath, [script, "--timezone-case"], {
      env: { ...process.env, TZ: timezone },
      stdio: "pipe"
    });
  }

  const image = (type, size, name = "image") => ({ type, size, name });
  for (const type of ["image/png", "image/jpeg", "image/webp"]) {
    const file = image(type, 1);
    assert.deepEqual(validatedImageFiles([file]), [file]);
  }
  assert.throws(() => validatedImageFiles([]), { message: "没有找到可用图片" });
  assert.throws(
    () => validatedImageFiles([image("text/plain", 1), image("image/png", 1)], 1),
    { message: "最多选择 1 张图片" }
  );
  assert.throws(() => validatedImageFiles([image("image/gif", 1)]), {
    message: "只支持 PNG、JPEG 或 WebP 图片"
  });
  assert.equal(validatedImageFiles([image("image/png", 8 * 1024 * 1024)]).length, 1);
  assert.throws(() => validatedImageFiles([image("image/png", 8 * 1024 * 1024 + 1)]), {
    message: "单张及本次图片总大小均不得超过 8 MB"
  });
  assert.equal(validatedImageFiles([
    image("image/png", 4 * 1024 * 1024),
    image("image/webp", 4 * 1024 * 1024)
  ], 2).length, 2);
  assert.throws(() => validatedImageFiles([
    image("image/png", 4 * 1024 * 1024),
    image("image/webp", 4 * 1024 * 1024 + 1)
  ], 2), {
    message: "单张及本次图片总大小均不得超过 8 MB"
  });
  assert.deepEqual(imageRecordPayload({
    content: "",
    attachmentPaths: ["/attachments/a.png", "/attachments/b.webp"]
  }), {
    content: "",
    attachmentPaths: ["/attachments/a.png", "/attachments/b.webp"]
  });
  assert.throws(() => imageRecordPayload({ content: "", attachmentPaths: [] }), {
    message: "请填写文字或插入图片"
  });
  assert.deepEqual(imageUnderstandingPayload({
    targetType: "capture",
    targetId: "capture-1",
    inputVersion: 2,
    attachmentPaths: ["/attachments/a.png"]
  }), {
    targetType: "capture",
    targetId: "capture-1",
    inputVersion: 2,
    attachmentPaths: ["/attachments/a.png"]
  });
  const uploadCalls = [];
  assert.deepEqual(await uploadOriginalImages({
    request: async (url, options) => {
      uploadCalls.push({ url, options });
      return { attachmentPaths: ["/attachments/a.png", "/attachments/b.webp"] };
    },
    images: ["data:image/png;base64,AA==", "data:image/webp;base64,AA=="],
    idempotencyKey: "upload-originals-1"
  }), ["/attachments/a.png", "/attachments/b.webp"]);
  assert.equal(uploadCalls[0].url, "/api/images/upload");
  assert.equal(uploadCalls[0].options.headers["idempotency-key"], "upload-originals-1");
  assert.deepEqual(JSON.parse(uploadCalls[0].options.body), {
    purpose: "original",
    images: ["data:image/png;base64,AA==", "data:image/webp;base64,AA=="]
  });

  console.log("Frontend shared regression passed: HTML safety, Markdown/LaTeX fidelity, local timezone midnight handling, and image count/MIME/size validation.");
}
