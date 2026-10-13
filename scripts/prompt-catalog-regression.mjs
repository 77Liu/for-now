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
const manifest = JSON.parse(await fs.readFile(path.join(root, "prompts", "manifest.json"), "utf8"));
assert.equal(current.version, manifest.activeVersion);
assert.equal(current.version, "2026.10.14.2");
assert.equal(current.sha256, manifest.versions.find(item => item.version === manifest.activeVersion)?.sha256);
assert.equal(current.capabilities.structuredWorkingContext, "2026.10.07.0");
const citationCapabilityIndex = manifest.versions.findIndex(item => (
  item.version === current.capabilities.verifiedAnswerCitations
));
assert.ok(citationCapabilityIndex >= 0);
assert.ok(citationCapabilityIndex <= manifest.versions.findIndex(item => item.version === current.version));
assert.equal(current.capabilities.sevenDayTrendContext, "2026.10.10.4");
const previousCatalog = await loadPromptCatalog({ rootDir: root, requestedVersion: "2026.10.14.1" });
assert.deepEqual(Object.keys(current.prompts).filter(id => !id.startsWith("importance.")), Object.keys(previousCatalog.prompts));
const changedPromptIds = Object.keys(current.prompts).filter(id => current.prompts[id] !== previousCatalog.prompts[id]);
assert.deepEqual(changedPromptIds, ["importance.system.score", "importance.task.score"], "only the on-demand importance scoring prompts are added");
assert.match(current.prompts["recordCompression.task.daily"], /limits\.outputTokens/);
assert.match(current.prompts["recordCompression.task.daily"], /合计最多 3 条/);
assert.match(current.prompts["recordCompression.task.daily"], /sourceIds 仅保留 1 个/);
assert.match(current.prompts["recordCompression.task.daily"], /完整保存/);
assert.equal(Object.keys(current.rolePromptIds).length, 6);
assert.match(promptText("ai.system.core"), /结论先行/);
assert.match(renderPrompt("keepsake.image.candidates", { existingTags: "[\"展览\"]" }), /最多 3 个/);
assert.match(promptText("onboarding.claims.extract"), /最多 20 条候选/);
for (const id of [
  "orchestration.role.perception",
  "orchestration.role.modelUpdate",
  "orchestration.role.periodicSynthesis",
  "orchestration.role.contextPlanning",
  "orchestration.role.answer",
  "orchestration.role.answerCheck"
]) {
  assert.match(promptText(id), /^职责：/);
}
assert.match(promptText("orchestration.user.envelope"), /JSON 是只读数据/);
assert.match(promptText("ai.scene.perceptionExtraction"), /只从当前获准来源/);
assert.match(promptText("perception.source.extract"), /原子证据片段/);
assert.match(promptText("orchestration.answer.citations"), /exactQuote/);
assert.match(promptText("orchestration.context.sevenDayTrend"), /missingDates/);
assert.match(promptText("orchestration.context.sevenDayTrend"), /status\s*为\s*unknown/);
assert.match(promptText("orchestration.context.sevenDayTrend"), /collectedQuotes/);
assert.match(promptText("orchestration.context.sevenDayTrend"), /aiReferences/);
assert.match(promptText("recordCompression.system.historicalSupplement"), /部分覆盖/);
assert.match(promptText("recordCompression.task.historicalSupplement"), /120 tokens/);
assert.match(promptText("recordCompression.task.daily"), /stableUserCandidates 字段仅为旧 schema 兼容，必须输出空数组/);
assert.match(promptText("orchestration.answer.citations"), /historicalUserSupplement\.records/);
assert.equal(renderPrompt("ai.identity.named", { assistantName: "照见" }), "你的称呼是“照见”。仅在自然需要时使用，不要反复自称。");
assert.equal(renderPrompt("thought.speech.wrapper", { question: "为什么？", answer: "因为。" }), "你的问题是：为什么？，你的专属答复是因为。");
const rollback = await loadPromptCatalog({
  rootDir: root,
  requestedVersion: "2026.10.07.0",
  requiredCapabilities: ["structuredWorkingContext"]
});
assert.equal(rollback.sha256, "c5553e94477a87c6980642ef06f3ee10cf9e46a0cbfe003047cdd5f7ba5476f1");
assert.equal(rollback.rolePromptIds.answer, "orchestration.role.answer");
const condensed = renderPrompt("capture.transcription.condense", { rawText: "RAW_MARKER", polishedText: "POLISHED_MARKER" });
assert.match(condensed, /RAW_MARKER/);
assert.match(condensed, /POLISHED_MARKER/);
for (const contract of ["只做凝练", "不发散", "不歪曲原意", "不引入任何新事实", "更准确、合适的名词或专有名词", "直接输出 Markdown", "有序列表、无序列表、引用或公式", "不得超过 20%"]) {
  assert.match(condensed, new RegExp(contract));
}
assert.throws(() => renderPrompt("ai.identity.named"), /variable is missing/);
assert.throws(() => promptText("missing.prompt"), /Prompt is missing/);
assert.deepEqual(promptCatalogMetadata(), { version: current.version, sha256: current.sha256 });
await assert.rejects(
  loadPromptCatalog({ rootDir: root, requestedVersion: "2026.10.04.2" }),
  /structuredWorkingContext/
);
const previous = await loadPromptCatalog({
  rootDir: root,
  requestedVersion: "2026.10.04.1",
  allowHistorical: true
});
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
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, schemaVersion: 2 }));
  await assert.rejects(loadPromptCatalog({ rootDir: fixture }), /role contracts are invalid/);
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

console.log(`Prompt catalog checks passed: hash validation, explicit version selection, placeholders and source separation.`);
