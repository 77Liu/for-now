import { providedReferenceMarkup } from "../public/generated/reference-summary.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/frontend/app/runtime/home-chat-renderer.mjs", import.meta.url), "utf8");

assert.match(
  source,
  /contextReceiptMarkup\(item\.contextReceipt,\s*item\.citations,\s*item\.citationStatus,\s*item\.providedReferences\)/,
  "home chat must pass verified citations and the separate provided-reference catalog to the existing renderer"
);

assert.equal(providedReferenceMarkup(undefined), "", "legacy answers do not get an invented provided catalog");
const metadataOnly = [{ recordType: "<script>标题</script>", version: 2, resourceId: "PRIVATE_ID_NOT_RENDERED" }];
const providedMarkup = providedReferenceMarkup(metadataOnly, { providedCount: 10, coreModelProvided: true,
  evidenceBudgetLevel: "warn", truncatedSources: 3 });
assert.match(providedMarkup, /参考（10）/, "actual sent count survives owner-only catalog filtering");
assert.match(providedMarkup, /不代表|实际引用以逐字核验结果为准/);
assert.match(providedMarkup, /你的专属用户模型已携带/);
assert.match(providedMarkup, /WARN/);
assert.doesNotMatch(providedMarkup, /PRIVATE_ID_NOT_RENDERED|<script>/);
process.stdout.write("Home chat verified citation wiring regression passed.\n");
