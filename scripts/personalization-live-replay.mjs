import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createDeepSeekTransport } from "../src/infrastructure/ai-providers/index.mjs";
import { buildPersonalizationLivePlan, liveFingerprint } from "./lib/personalization-live.mjs";
import { verifyFrozenReplaySource } from "./lib/replay-source.mjs";
const root = path.resolve(import.meta.dirname, "..");
const plan = await buildPersonalizationLivePlan(root);
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (["--output", "--tree"].includes(argument)) {
    assert.ok(process.argv[++index] && !process.argv[index].startsWith("--"), `${argument} requires a value`);
  } else assert.equal(argument, "--live", `Unknown argument: ${argument}`);
}
const live = process.argv.includes("--live");
const outputFlag = process.argv.indexOf("--output");
let output = path.resolve(outputFlag >= 0 ? process.argv[outputFlag + 1] : path.join(root, "reports/personalization-live-v0.5.9.json"));
const treeFlag = process.argv.indexOf("--tree");
const candidateTree = treeFlag >= 0 ? process.argv[treeFlag + 1] : execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
assert.match(candidateTree, /^[a-f0-9]{40}$/);
const sourceIdentity = await verifyFrozenReplaySource(root, candidateTree);
const { requests, ...summary } = plan;
if (!live) {
  console.log(JSON.stringify({ ...summary, candidateTree, sourceIdentity, mode: "plan-only", externalCalls: 0,
    dataScope: "approved synthetic fixtures only; no production content read or writes" }));
} else {
  const apiKey = String(process.env.REPLAY_API_KEY || "").trim();
  assert.ok(apiKey.length >= 8, "REPLAY_API_KEY required in process environment");
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  output = path.join(await fs.realpath(path.dirname(output)), path.basename(output));
  const lockDirectory = `${output}.lock`, workerId = crypto.randomUUID();
  try { await fs.mkdir(lockDirectory, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw Object.assign(new Error("Another replay owns this ledger; stale locks are never stolen automatically"), { code: "LIVE_REPLAY_BUSY" });
    throw error;
  }
  await fs.writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify({ workerId, pid: process.pid,
    candidateTree, planFingerprint: plan.planFingerprint, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  try {
    let report;
    try {
      const metadata = await fs.lstat(output);
      assert.ok(metadata.isFile() && metadata.nlink === 1 && (metadata.mode & 0o777) === 0o600, "Ledger must be a private regular file");
      report = JSON.parse(await fs.readFile(output, "utf8"));
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (report) {
      assert.equal(report.planFingerprint, plan.planFingerprint); assert.equal(report.candidateTree, candidateTree);
      assert.equal(report.maxCostCny, plan.maxCostCny); assert.equal(report.maxCalls, plan.maxCalls);
      assert.ok(report.results.every(row => requests.some(request => request.id === row.id
        && request.requestSha256 === row.requestSha256
        && request.reservedCny === row.reservedCny
        && liveFingerprint(row.auditRequest) === liveFingerprint({ messages: request.messages, parameters: request.parameters })
        && liveFingerprint(row.answerText) === row.answerSha256)), "Saved request or answer drifted");
      assert.equal(new Set(report.results.map(row => row.id)).size, report.results.length);
      assert.ok(report.results.every(row => row.status === "passed"), "An uncertain/failed call is never retried automatically");
    } else report = { ...summary, candidateTree, sourceIdentity, mode: "live", startedAt: new Date().toISOString(), status: "running", results: [] };
    const persist = async () => {
      const serialized = JSON.stringify(report, null, 2) + "\n";
      assert.equal(serialized.includes(apiKey), false, "Provider credential cannot enter the ledger");
      const temporary = `${output}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
        await fs.rename(temporary, output);
      } finally { await fs.rm(temporary, { force: true }); }
    };
    const transport = createDeepSeekTransport({ endpoint: "https://api.deepseek.com/chat/completions" });
    for (const request of requests) {
      if (report.results.some(row => row.id === request.id)) continue;
      assert.ok(report.results.length < plan.maxCalls);
      const row = { id: request.id, fixtureId: request.fixtureId, variant: request.variant, repetition: request.repetition,
        requestSha256: request.requestSha256, promptCatalog: request.promptCatalog, selectedSourceIds: request.selectedSourceIds,
        reservedCny: request.reservedCny, auditRequest: { messages: request.messages, parameters: request.parameters }, status: "in-flight", startedAt: new Date().toISOString() };
      const wireParameters = { model: request.parameters.model, thinking: { type: "enabled" },
        reasoning_effort: request.parameters.reasoningEffort, max_tokens: request.parameters.maxOutputTokens, stream: false };
      row.auditWireRequest = { ...wireParameters, messages: request.messages };
      row.wireRequestSha256 = liveFingerprint(row.auditWireRequest);
      report.results.push(row); await persist(); // A crash leaves an uncertain call, never silently resubmitted.
      const startedAt = Date.now();
      let observedResult;
      try {
        const result = observedResult = await transport.complete({ apiKey, signal: AbortSignal.timeout(plan.timeoutMs), messages: request.messages,
          parameters: wireParameters });
        const usage = result.usage;
        assert.ok(Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0);
        assert.ok(Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0);
        assert.ok(usage.prompt_tokens <= request.inputTokenUpperBound && usage.completion_tokens <= request.parameters.maxOutputTokens);
        assert.equal(result.modelReturned, request.parameters.model, "Returned model differs from frozen model");
        assert.equal(result.finishReason, "stop", "Generation did not complete normally");
        Object.assign(row, { status: "passed", answerText: result.content, answerSha256: liveFingerprint(result.content),
          reasoningSha256: liveFingerprint(result.reasoningContent), reasoningCharacters: result.reasoningContent.length,
          auditReasoningContent: result.reasoningContent,
          usage, actualCostUpperBoundCny: (usage.prompt_tokens * plan.pricing.inputPerMillion
            + usage.completion_tokens * plan.pricing.outputPerMillion) / 1e6,
          providerRequestId: result.providerRequestId, modelReturned: result.modelReturned,
          providerCreatedAt: result.providerCreatedAt, finishReason: result.finishReason, httpStatus: result.httpStatus });
      } catch (error) {
        Object.assign(row, { status: "failed-or-uncertain", errorCode: String(error.code || error.name || "UNKNOWN"),
          httpStatus: Number(error.httpStatus ?? observedResult?.httpStatus ?? 0), finishReason: error.finishReason ?? observedResult?.finishReason ?? "",
          providerRequestId: error.providerRequestId ?? observedResult?.providerRequestId ?? "", modelReturned: error.modelReturned ?? observedResult?.modelReturned ?? "",
          providerCreatedAt: error.providerCreatedAt ?? observedResult?.providerCreatedAt ?? "", systemFingerprint: error.systemFingerprint ?? observedResult?.systemFingerprint ?? "",
          partialAnswerText: error.partialContent ?? observedResult?.content ?? "", partialAnswerSha256: liveFingerprint(error.partialContent ?? observedResult?.content ?? ""),
          auditReasoningContent: error.partialReasoningContent ?? observedResult?.reasoningContent ?? "", reasoningSha256: liveFingerprint(error.partialReasoningContent ?? observedResult?.reasoningContent ?? ""),
          usage: error.usage ?? observedResult?.usage ?? null });
        report.status = "failed";
      }
      row.durationMs = Date.now() - startedAt; row.finishedAt = new Date().toISOString();
      report.completedCalls = report.results.filter(row => row.status === "passed").length;
      report.attemptedCalls = report.results.length;
      report.recordedCostUpperBoundCny = report.results.reduce((sum, row) => sum + (row.actualCostUpperBoundCny ?? row.reservedCny), 0);
      await persist();
      console.log(JSON.stringify({ completed: report.completedCalls, attempted: report.attemptedCalls,
        total: plan.maxCalls, status: row.status, fixtureId: row.fixtureId, variant: row.variant, durationMs: row.durationMs }));
      if (row.status !== "passed") { process.exitCode = 1; break; }
    }
    if (!process.exitCode) { report.status = "generation-complete"; report.finishedAt = new Date().toISOString(); }
    report.gateEligible = false; report.semanticEvaluation = "pending-blind-owner-review";
    await persist();
    console.log(JSON.stringify({ mode: "live", status: report.status, completedCalls: report.completedCalls,
      recordedCostUpperBoundCny: report.recordedCostUpperBoundCny, gateEligible: false, output }));
  } finally {
    const owner = JSON.parse(await fs.readFile(path.join(lockDirectory, "owner.json"), "utf8"));
    assert.equal(owner.workerId, workerId, "Ledger execution ownership changed");
    await fs.unlink(path.join(lockDirectory, "owner.json")); await fs.rmdir(lockDirectory);
  }
}
