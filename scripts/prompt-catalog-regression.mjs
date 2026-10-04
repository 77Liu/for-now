import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPromptCatalog } from "../src/infrastructure/prompt-catalog/index.mjs";
import { installPromptCatalog, optionalPromptText, promptCatalogMetadata, promptText, renderPrompt } from "../src/shared/prompts/index.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const current = installPromptCatalog(await loadPromptCatalog({ rootDir: root }));
assert.equal(current.version, "2026.10.04.2");
assert.equal(current.sha256, "cc8d8235d3134a0779653abbb76515a93f138cde496bb8356a8acdf26ef60295");
assert.equal(Object.keys(current.prompts).length, 62);
assert.match(promptText("ai.system.core"), /结论先行/);
assert.match(renderPrompt("keepsake.image.candidates", { existingTags: "[\"展览\"]" }), /最多 3 个/);
assert.match(promptText("onboarding.claims.extract"), /最多 20 条候选/);
assert.equal(renderPrompt("ai.identity.named", { assistantName: "照见" }), "你的称呼是“照见”。仅在自然需要时使用，不要反复自称。");
assert.equal(renderPrompt("thought.speech.wrapper", { question: "为什么？", answer: "因为。" }), "你的问题是：为什么？，你的专属答复是因为。");
const condensed = renderPrompt("capture.transcription.condense", { rawText: "RAW_MARKER", polishedText: "POLISHED_MARKER" });
assert.match(condensed, /RAW_MARKER/);
assert.match(condensed, /POLISHED_MARKER/);
for (const contract of ["只做凝练", "不发散", "不歪曲原意", "不引入任何新事实", "更准确、合适的名词或专有名词", "直接输出 Markdown", "有序列表、无序列表、引用或公式", "不得超过 20%"]) {
  assert.match(condensed, new RegExp(contract));
}
assert.throws(() => renderPrompt("ai.identity.named"), /variable is missing/);
assert.throws(() => promptText("missing.prompt"), /Prompt is missing/);
assert.deepEqual(promptCatalogMetadata(), { version: current.version, sha256: current.sha256 });
const previous = await loadPromptCatalog({ rootDir: root, requestedVersion: "2026.10.04.1" });
assert.equal(previous.sha256, "24d2a34c8f6a72ee735ccd4b48e91ce8ddad6e57da37fdf6d095e8aa3be87e90");
assert.equal(previous.prompts["capture.transcription.condense"], undefined);
assert.equal(previous.prompts["thought.speech.wrapper"], undefined);
installPromptCatalog(previous);
assert.equal(optionalPromptText("thought.speech.wrapper"), "");
assert.throws(() => promptText("thought.speech.wrapper"), /Prompt is missing/);
installPromptCatalog(current);

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
