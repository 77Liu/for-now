import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPromptCatalog } from "../src/infrastructure/prompt-catalog/index.mjs";
import { installPromptCatalog, promptCatalogMetadata, promptText, renderPrompt } from "../src/shared/prompts/index.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const current = installPromptCatalog(await loadPromptCatalog({ rootDir: root }));
assert.equal(current.version, "2026.10.01.1");
assert.equal(current.sha256, "330f1e3614f3f0ee25f152b4bf7c2cfe75760606b9e2a40569fc3d3874ac7646");
assert.ok(Object.keys(current.prompts).length >= 40);
assert.match(promptText("ai.system.core"), /结论先行/);
assert.equal(renderPrompt("ai.identity.named", { assistantName: "照见" }), "你的称呼是“照见”。仅在自然需要时使用，不要反复自称。");
assert.throws(() => renderPrompt("ai.identity.named"), /variable is missing/);
assert.throws(() => promptText("missing.prompt"), /Prompt is missing/);
assert.deepEqual(promptCatalogMetadata(), { version: current.version, sha256: current.sha256 });

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "growth-prompts-"));
try {
  const versions = path.join(fixture, "prompts", "versions");
  await fs.mkdir(versions, { recursive: true });
  const documents = [
    { schemaVersion: 1, version: "old", prompts: { "test.prompt": "old {{value}}" } },
    { schemaVersion: 1, version: "new", prompts: { "test.prompt": "new {{value}}" } }
  ];
  const entries = [];
  for (const document of documents) {
    const raw = `${JSON.stringify(document)}\n`, file = `${document.version}.json`;
    await fs.writeFile(path.join(versions, file), raw);
    entries.push({ version: document.version, file, sha256: crypto.createHash("sha256").update(raw).digest("hex") });
  }
  const manifestFile = path.join(fixture, "prompts", "manifest.json");
  const manifest = {
    schemaVersion: 1, activeVersion: "new", versions: entries,
    promptVariables: { "test.prompt": ["value"] }, requiredPromptIds: ["test.prompt"]
  };
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  assert.equal((await loadPromptCatalog({ rootDir: fixture })).version, "new");
  assert.equal((await loadPromptCatalog({ rootDir: fixture, requestedVersion: "old" })).prompts["test.prompt"], "old {{value}}");
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, promptVariables: { "test.prompt": ["wrong"] } }));
  await assert.rejects(loadPromptCatalog({ rootDir: fixture }), /variables do not match/);
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await fs.writeFile(path.join(versions, "new.json"), "{}\n");
  await assert.rejects(loadPromptCatalog({ rootDir: fixture }), /hash mismatch/);
  await assert.rejects(loadPromptCatalog({ rootDir: fixture, requestedVersion: "unknown" }), /unavailable/);
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}

for (const file of [
  "src/modules/ai/prompts.mjs", "src/modules/thoughts/prompts.mjs",
  "src/modules/journals/index.mjs", "src/modules/annotations/prompts.mjs",
  "src/modules/health/index.mjs", "server.mjs"
]) {
  const source = await fs.readFile(path.join(root, file), "utf8");
  for (const fragment of ["本场景输出契约", "你是这个本地个人成长项目", "你是“神鸡”", "只输出 JSON：", "请做一份认知复盘"]) {
    assert.equal(source.includes(fragment), false, `${file} still embeds prompt text: ${fragment}`);
  }
}

console.log(`Prompt catalog checks passed: ${Object.keys(current.prompts).length} prompts, hash validation, explicit version selection, placeholders and source separation.`);
