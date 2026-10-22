/**
 * Verifies provider reasoning stays inside the server-owned product visibility contract.
 * Established: 2026-10-19
 * Status: active
 * Boundary: isolated provider and audit ports; no network, credentials, or production state.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const source = (path: string) => pathToFileURL(`${process.cwd()}/${path}`).href;
await import(source("scripts/prompt-test-setup.mjs"));
const {
  createAiGenerator, normalizeLlmSettings, projectProductReasoning,
  businessReasoning, invocationSceneContract, registeredInvocationScenes
} = await import(source("src/modules/ai/index.mjs"));
const audits: Record<string, unknown>[] = [];
const events: Record<string, unknown>[] = [];
const settings = normalizeLlmSettings({ apiKey: "isolated-test-only" });
let providerMode = "success";
let providerCalls = 0;
const generate = createAiGenerator({
  readSettings: async () => settings,
  getContext: () => ({ user: { id: "isolated-account" }, secrets: [] }),
  reserveAttempt: async () => () => {},
  gate: { acquire: async () => () => {} },
  audit: {
    text: (value: unknown) => String(value || ""),
    message: (value: unknown) => value,
    start: async (value: Record<string, unknown>) => value,
    recordDeepSeekAttempt: async (value: Record<string, unknown>) => { audits.push(value); }
  },
  provider: {
    endpointHost: "provider.invalid",
    imageInput: async () => { throw new Error("No image input in this fixture"); },
    complete: async ({ onDelta }: { onDelta?: (event: Record<string, unknown>) => void }) => {
      providerCalls += 1;
      if (providerMode === "failure") {
        throw Object.assign(new Error("isolated provider failure"), {
          partialReasoningContent: "partial private reasoning",
          partialContent: "partial final result"
        });
      }
      if (providerMode === "empty") return { content: "only answer", httpStatus: 200 };
      onDelta?.({ type: "reasoning", delta: "isolated private reasoning" });
      onDelta?.({ type: "content", delta: "allowed final result" });
      return { content: "allowed final result", reasoningContent: "isolated private reasoning", httpStatus: 200 };
    }
  }
});

for (const scene of ["perceptionExtraction", "recordCompression", "importanceScoring", "unregisteredScene"]) {
  events.length = 0;
  const result = await generate("isolated input", {
    scene,
    captureReasoning: true,
    retryWithoutThinking: false,
    onDelta: (event: Record<string, unknown>) => events.push(event)
  });
  assert.equal(events.some(event => event.type === "reasoning"), false,
    `${scene} must not publish private reasoning events`);
  assert.equal(Object.hasOwn(result, "reasoningContent"), false,
    `${scene} must not return private reasoning in its product result`);
  assert.equal(result.content, "allowed final result");
  const audited = audits.at(-1) as { audit: { response: { reasoningContent: string } } };
  assert.equal(audited.audit.response.reasoningContent, "isolated private reasoning",
    "product filtering must not discard complete private audit evidence");
}

events.length = 0;
const visible = await generate("isolated user result", {
  scene: "thoughtAnswer",
  captureReasoning: true,
  retryWithoutThinking: false,
  onDelta: (event: Record<string, unknown>) => events.push(event)
});
assert.equal(events.filter(event => event.type === "reasoning").length, 1);
assert.equal(visible.reasoningContent, "isolated private reasoning");
assert.equal(visible.content, "allowed final result");
assert.equal(visible.reasoningVisibility, "user_viewable");
providerMode = "empty";
const empty = await generate("no reasoning", {
  scene: "thoughtAnswer", captureReasoning: true, retryWithoutThinking: false
});
assert.equal(Object.hasOwn(empty, "reasoningContent"), false);
providerMode = "failure";
await assert.rejects(generate("private failure", {
  scene: "perceptionExtraction", captureReasoning: true, retryWithoutThinking: false
}), (error: Record<string, unknown>) => {
  assert.equal(Object.hasOwn(error, "partialReasoningContent"), false);
  return true;
});
const failedAudit = audits.at(-1) as { audit: { response: { reasoningContent: string } } };
assert.equal(failedAudit.audit.response.reasoningContent, "partial private reasoning");
const beforeInvalidTrigger = providerCalls;
await assert.rejects(generate("invalid trigger", {
  scene: "perceptionExtraction", triggerType: "user_explicit"
}), { code: "AI_INVOCATION_CONTRACT_INVALID" });
assert.equal(providerCalls, beforeInvalidTrigger);
const records = [{
  id: "user-result", reasoningVisibility: "user_viewable", reasoningContent: "visible"
}, {
  id: "internal-result", reasoningVisibility: "privileged_only", reasoningContent: "hidden"
}, {
  id: "legacy-result", reasoningContent: "historical hidden"
}];
const projected = projectProductReasoning(records);
assert.equal(projected[0].reasoningContent, "visible");
assert.equal(Object.hasOwn(projected[1], "reasoningContent"), false);
assert.equal(Object.hasOwn(projected[2], "reasoningContent"), false);
assert.equal(records[1].reasoningContent, "hidden", "projection must preserve source records");
assert.deepEqual(businessReasoning("thoughtDraft", "temporary", 12000), {});
assert.deepEqual(businessReasoning("recordCompression", "internal", 12000), {});
assert.equal(businessReasoning("chat", "abcdef", 3).reasoningContent, "abc");
for (const scene of registeredInvocationScenes()) {
  const contract = invocationSceneContract(scene);
  if (contract.resultAudience === "internal") {
    assert.equal(contract.uiOwner, null);
    assert.equal(contract.dtoOwner, null);
  } else {
    assert.ok(contract.reasoningTextPolicy);
    assert.ok(contract.uiOwner);
    assert.ok(contract.dtoOwner);
    assert.equal(Boolean(contract.persistenceOwner), contract.persistenceMode === "business_result");
  }
}
console.log("AI reasoning visibility checks passed: internal and unknown fail closed, user result available, full private audit retained.");
