import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPersonalizationLivePlan } from "./lib/personalization-live.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
let externalCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { externalCalls += 1; throw new Error("External calls forbidden"); };
try {
  const original = await buildPersonalizationLivePlan(root);
  const selectedOld = await buildPersonalizationLivePlan(root, { manifestVersion: "v2" });
  assert.deepEqual(selectedOld, original);
  assert.equal(original.planFingerprint, "eb52137e7933831b1cd24051b855247c6fc12ddebd26b14920293cb2093214ed");
  const repaired = await buildPersonalizationLivePlan(root, { manifestVersion: "v3" });
  assert.equal(repaired.purpose, "personalization-source-time-boundaries-v3");
  assert.equal(repaired.requestInputVersion, "source-time-boundaries-v3");
  assert.equal(repaired.requests.length, 48);
  assert.notEqual(repaired.planFingerprint, original.planFingerprint);
  assert.notEqual(repaired.manifestFingerprint, original.manifestFingerprint);
  for (const field of ["fixtureSha256", "fixtureSetFingerprint", "fixtureCount", "maxCalls", "maxCostCny", "concurrency", "retries", "timeoutMs", "pricing", "semanticEvaluation", "gateEligible"]) {
    assert.deepEqual(repaired[field], original[field]);
  }
  for (const request of repaired.requests) {
    const previous = original.requests.find(row => row.id === request.id);
    assert.ok(previous);
    if (request.variant !== "new") { assert.deepEqual(request, previous); continue; }
    assert.deepEqual(request.parameters, previous.parameters);
    assert.deepEqual(request.selectedSourceIds, previous.selectedSourceIds);
    assert.equal(request.promptCatalog.version, "2026.10.09.1");
    assert.equal(request.promptCatalog.sha256, "222de519c0530e4cea6c4bc25592bbc838c37faff478fd6c115adde36e75afc8");
    assert.notEqual(request.requestSha256, previous.requestSha256);
    assert.deepEqual(request.messages[0], previous.messages[0]);
    const user = request.messages[1].content;
    const parse = text => JSON.parse(/<working_context_data format="application\/json">(.+)<\/working_context_data>/s.exec(text)[1]);
    const current = parse(user), old = parse(previous.messages[1].content);
    assert.equal(current.asOf, "2026-10-07T12:30:00.000Z");
    delete current.asOf;
    assert.deepEqual(current, old);
    assert.ok(user.includes("asOf"));
    assert.equal(request.repetition, previous.repetition);
  }
  for (const manifestVersion of ["v1", "v4", "../v3", "", null, 3, {}, true]) {
    await assert.rejects(buildPersonalizationLivePlan("/unread-root", { manifestVersion }), /Unknown replay manifest selector/);
  }
  assert.equal(externalCalls, 0);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "quality-plan-wire-"));
  try {
    const stub = path.join(temporary, "stub.mjs"), trace = path.join(temporary, "trace.ndjson"), output = path.join(temporary, "ledger.json");
    await fs.writeFile(stub, `import {appendFileSync} from 'node:fs';
      globalThis.fetch=async(url,options)=>{if(url!=='https://api.deepseek.com/chat/completions'||options.headers.authorization!=='Bearer synthetic-api-key')throw new Error('unexpected synthetic wire');
        appendFileSync(process.env.REPLAY_TEST_TRACE,JSON.stringify(JSON.parse(options.body))+'\\n');
        return new Response(JSON.stringify({id:'synthetic-id',model:'deepseek-v4-pro',choices:[{finish_reason:'stop',message:{content:'SYNTHETIC ONLY',reasoning_content:'SYNTHETIC ONLY'}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}),{status:200});};`, { mode: 0o600 });
    const tree = process.env.REPLAY_VALIDATION_TREE || execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
    const run = () => spawnSync(process.execPath, ["--import", stub, "scripts/personalization-live-replay.mjs", "--manifest", "v3", "--live", "--tree", tree, "--output", output], {
      cwd: root, encoding: "utf8", timeout: 90000, env: { ...process.env, REPLAY_API_KEY: "synthetic-api-key", REPLAY_TEST_TRACE: trace }
    });
    const first = run(); assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(await fs.readFile(output, "utf8"));
    assert.equal(report.planFingerprint, repaired.planFingerprint); assert.equal(report.status, "generation-complete");
    assert.equal(report.purpose, repaired.purpose); assert.equal(report.requestInputVersion, repaired.requestInputVersion);
    assert.equal(report.results.length, 48); assert.equal(report.gateEligible, false);
    const calls = (await fs.readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 48);
    for (const [index, row] of report.results.entries()) assert.deepEqual(row.auditWireRequest, calls[index]);
    const before = await fs.readFile(output);
    const second = run(); assert.notEqual(second.status, 0); assert.ok(second.stderr.includes("cannot resume"));
    assert.deepEqual(await fs.readFile(output), before); assert.equal((await fs.readFile(trace, "utf8")).trim().split("\n").length, 48);
    const packetRoot = path.join(temporary, "blind");
    const packet = spawnSync(process.execPath, ["scripts/personalization-blind-packet.mjs", output, packetRoot, "--manifest", "v3"], { cwd: root, encoding: "utf8", timeout: 30000 });
    assert.equal(packet.status, 0, packet.stderr);
    const owner = JSON.parse(await fs.readFile(path.join(packetRoot, "owner-packet.json"), "utf8"));
    assert.equal(owner.purpose, repaired.purpose); assert.equal(owner.requestInputVersion, repaired.requestInputVersion);
    assert.equal(owner.planFingerprint, repaired.planFingerprint); assert.equal(owner.gateEligible, false);
    assert.equal(owner.cases.length, 8); assert.ok(owner.cases.every(item => item.groundTruth.asOf === "2026-10-07T12:30:00.000Z"));
    assert.ok(owner.cases.every(item => item.samples.every(sample => !Object.hasOwn(sample, "variant"))));
    const mutations = {
      variant: row => { row.variant = row.variant === "general" ? "new" : "general"; },
      fixtureId: row => { row.fixtureId = "other-fixture"; },
      repetition: row => { row.repetition = 3; },
      promptCatalog: row => { row.promptCatalog = { ...row.promptCatalog, version: "other-version" }; },
      selectedSourceIds: row => { row.selectedSourceIds = ["foreign-source"]; }
    };
    for (const [field, mutate] of Object.entries(mutations)) {
      const changed = structuredClone(report); mutate(changed.results[0]);
      const input = path.join(temporary, `${field}.json`), destination = path.join(temporary, `${field}-packet`);
      await fs.writeFile(input, JSON.stringify(changed), { mode: 0o600 });
      const refused = spawnSync(process.execPath, ["scripts/personalization-blind-packet.mjs", input, destination, "--manifest", "v3"], { cwd: root, encoding: "utf8", timeout: 30000 });
      assert.notEqual(refused.status, 0); assert.ok(refused.stderr.includes(`Replay row identity mismatch: ${field}`));
      await assert.rejects(fs.stat(destination), { code: "ENOENT" });
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  console.log("Quality boundaries plan passed: explicit v3, old 48 identity, 32 baseline requests unchanged, 16 bounded candidate deltas; externalCalls=0");
} finally { globalThis.fetch = originalFetch; }
