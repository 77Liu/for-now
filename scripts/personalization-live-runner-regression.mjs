import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "replay-runner-test-"));
const stub = path.join(temporary, "provider-stub.mjs");
const trace = path.join(temporary, "calls.ndjson");
const output = path.join(temporary, "report.json");
const root = path.resolve(import.meta.dirname, "..");
const tree = process.env.REPLAY_VALIDATION_TREE || execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
try {
  await fs.writeFile(stub, `import {appendFileSync} from 'node:fs';
    globalThis.fetch=async(url,options)=>{if(url!=='https://api.deepseek.com/chat/completions')throw new Error('wrong endpoint');
      if(options.headers.authorization!=='Bearer synthetic-api-key')throw new Error('wrong synthetic credential');
      appendFileSync(process.env.REPLAY_TEST_TRACE,JSON.stringify({url,body:JSON.parse(options.body)})+'\\n');
      if(process.env.REPLAY_TEST_FAILURE==='1')return new Response(JSON.stringify({error:{code:'SYNTHETIC_FAILURE'}}),{status:503});
      return new Response(JSON.stringify({id:'synthetic-id',model:process.env.REPLAY_TEST_FAILURE==='model'?'unexpected-model':'deepseek-v4-pro',choices:[{finish_reason:process.env.REPLAY_TEST_FAILURE==='finish'?'unexpected-finish':'stop',message:{content:'合成回答',reasoning_content:'合成审计内容'}}],usage:process.env.REPLAY_TEST_FAILURE==='usage'?null:{prompt_tokens:4,completion_tokens:8,total_tokens:12}}),{status:200});};`, { mode: 0o600 });
  const run = fail => spawnSync(process.execPath, ["--import", stub, "scripts/personalization-live-replay.mjs", "--live",
    "--tree", tree, "--output", output], {
    cwd: root, encoding: "utf8", env: { ...process.env, REPLAY_API_KEY: "synthetic-api-key", REPLAY_TEST_TRACE: trace, REPLAY_TEST_FAILURE: fail === true ? "1" : fail || "0" }
  });
  assert.equal(run(false).status, 0);
  let report = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(report.purpose, "personalization-same-current-task-v2");
  assert.equal(report.requestInputVersion, "current-task-v2");
  assert.equal(report.status, "generation-complete"); assert.equal(report.results.length, 48); assert.equal(report.gateEligible, false);
  assert.ok(report.recordedCostUpperBoundCny <= 30);
  assert.equal((await fs.readFile(trace, "utf8")).trim().split("\n").length, 48);
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  assert.equal((await fs.readFile(output, "utf8")).includes("synthetic-api-key"), false);
  assert.equal(run(false).status, 0, "complete resume makes zero calls");
  assert.equal((await fs.readFile(trace, "utf8")).trim().split("\n").length, 48);
  const savedReport = structuredClone(report);
  report.purpose = "old-input-generation"; delete report.requestInputVersion;
  await fs.writeFile(output, JSON.stringify(report));
  assert.notEqual(run(false).status, 0, "Old generation cannot resume with a corrected input contract");
  assert.equal((await fs.readFile(trace, "utf8")).trim().split("\n").length, 48);
  report = savedReport; await fs.writeFile(output, JSON.stringify(report));
  const calls = (await fs.readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  for (const [index, row] of report.results.entries()) assert.deepEqual(row.auditWireRequest, calls[index].body);
  const packetDirectory = path.join(temporary, "blind-packet");
  const packet = () => spawnSync(process.execPath, ["scripts/personalization-blind-packet.mjs", output, packetDirectory], { cwd: root, encoding: "utf8" });
  assert.equal(packet().status, 0);
  const ownerPacket = JSON.parse(await fs.readFile(path.join(packetDirectory, "owner-packet.json"), "utf8"));
  const mapping = JSON.parse(await fs.readFile(path.join(packetDirectory, "private-unblind-map.json"), "utf8"));
  const review = JSON.parse(await fs.readFile(path.join(packetDirectory, "owner-review-template.json"), "utf8"));
  assert.equal(ownerPacket.purpose, "personalization-same-current-task-v2");
  const temporalTruth = ownerPacket.cases.find(item => item.materials.some(material => material.id === "checkin:temporal-old")).groundTruth;
  assert.equal(temporalTruth.sources.find(source => source.id === "checkin:temporal-old").effectiveOccurredAt, "2026-08-01T08:00:00.000Z");
  assert.equal(temporalTruth.sources.find(source => source.id === "checkin:temporal-old").payload.energy, 1);
  const packetMarkdown = await fs.readFile(path.join(packetDirectory, "owner-packet.md"), "utf8");
  assert.ok(packetMarkdown.includes("2026-08-01T08:00:00.000Z") && packetMarkdown.includes("\"energy\":1"));
  assert.equal(ownerPacket.cases.length, 8); assert.equal(mapping.mapping.length, 24);
  assert.equal(review.status, "not-reviewed"); assert.equal(review.gateEligible, false);
  for (const item of ownerPacket.cases) for (const sample of item.samples) {
    assert.equal(sample.variant, undefined); assert.equal(sample.answers.length, 2);
    const source = mapping.mapping.find(row => row.caseId === item.caseId && row.label === sample.label);
    for (const [index, answer] of sample.answers.entries()) assert.equal(answer.answerSha256, source.rows[index].answerSha256);
  }
  assert.notEqual(packet().status, 0, "Existing blind mapping is never reshuffled or overwritten");
  report.results[0].auditRequest.messages[0].content = "tampered";
  await fs.writeFile(output, JSON.stringify(report));
  assert.notEqual(run(false).status, 0, "saved request drift blocks resume without a provider call");
  await fs.rm(packetDirectory, { recursive: true });
  assert.notEqual(packet().status, 0, "tampered generation is not packaged as blind evidence");
  assert.equal((await fs.readFile(trace, "utf8")).trim().split("\n").length, 48);
  await fs.rm(output); await fs.rm(trace);
  assert.notEqual(run(true).status, 0);
  report = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(report.results.length, 1); assert.equal(report.results[0].errorCode, "SYNTHETIC_FAILURE");
  assert.equal(report.results[0].status, "failed-or-uncertain");
  assert.equal((await fs.readFile(trace, "utf8")).trim().split("\n").length, 1);
  assert.notEqual(run(false).status, 0, "uncertain call is never resubmitted");
  assert.equal((await fs.readFile(trace, "utf8")).trim().split("\n").length, 1);
  for (const failure of ["usage", "model", "finish"]) {
    await fs.rm(output); await fs.rm(trace);
    assert.notEqual(run(failure).status, 0);
    const rejected = JSON.parse(await fs.readFile(output, "utf8"));
    const row = rejected.results[0];
    assert.equal(rejected.results.length, 1); assert.equal(row.status, "failed-or-uncertain");
    assert.equal(row.providerRequestId, "synthetic-id"); assert.equal(row.httpStatus, 200);
    assert.equal(row.partialAnswerText, "合成回答"); assert.equal(row.auditReasoningContent, "合成审计内容");
    assert.equal(row.modelReturned, failure === "model" ? "unexpected-model" : "deepseek-v4-pro");
    assert.equal(row.finishReason, failure === "finish" ? "unexpected-finish" : "stop");
    assert.equal(row.usage?.completion_tokens ?? null, failure === "usage" ? null : 8);
    assert.equal((await fs.readFile(trace, "utf8")).trim().split("\n").length, 1);
    assert.notEqual(run(false).status, 0, "Rejected observation never triggers a retry");
  }
  console.log("Live replay runner passed: private ledger, 48 calls bounded, cost record, no keys, idempotent resume, first failure stops and uncertain calls are not retried. External calls: 0.");
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
