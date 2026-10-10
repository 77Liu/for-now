import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/frontend/app/runtime/home-chat-renderer.mjs", import.meta.url), "utf8");

assert.match(
  source,
  /contextReceiptMarkup\(item\.contextReceipt,\s*item\.citations,\s*item\.citationStatus\)/,
  "home chat must pass verified citation data to the existing citation renderer"
);

process.stdout.write("Home chat verified citation wiring regression passed.\n");
