import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import "./prompt-test-setup.mjs";
import {
  personalContextProjection,
  userModelEvidenceCurrent,
  userModelProjection
} from "../src/app/index.mjs";
import {
  createUserModelService,
  normalizeModelUnknown,
  normalizeUserClaim
} from "../src/modules/user-model/index.mjs";
import { normalizeOnboardingV2 } from "../src/modules/onboarding/index.mjs";
import {
  canonicalJson,
  mapStoreObjects,
  rebuildStoreObjects
} from "../src/shared/persistence/index.mjs";

const clone = value => structuredClone(value);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const onboarding = (text, version = 1) => normalizeOnboardingV2({
  session: {
    status: "completed",
    step: "firstAction",
    revision: version,
    answers: {
      currentContext: {
        questionId: "currentContext",
        rawText: text,
        occurredAt: "2026-10-02T01:00:00.000Z",
        updatedAt: "2026-10-02T01:00:00.000Z",
        version,
        contextAllowed: true
      }
    },
    startedAt: "2026-10-02T01:00:00.000Z",
    completedAt: "2026-10-02T01:00:00.000Z",
    updatedAt: "2026-10-02T01:00:00.000Z"
  },
  migration: { selectedFlow: "v2" }
});
const statement = "最近在推进一个重要项目";
const evidence = text => ({
  sourceType: "onboardingV2Answer",
  sourceId: "currentContext",
  sourceVersion: 1,
  contentSha256: hash(text),
  span: [0, text.length]
});
const claim = (id, text, extra = {}) => normalizeUserClaim({
  id,
  domain: "context",
  statement,
  scope: "最近",
  epistemic: "known",
  lifecycle: "candidate",
  confidence: 0.99,
  evidenceStrength: "self_report",
  evidence: [evidence(text)],
  contextAllowed: true,
  createdAt: "2026-10-02T01:01:00.000Z",
  updatedAt: "2026-10-02T01:01:00.000Z",
  version: 1,
  ...extra
});

assert.equal(normalizeUserClaim({ id: "bad", domain: "context", statement: "x" }), null);
assert.equal(claim("claim-1", statement).confidence, null);
assert.equal(normalizeModelUnknown({
  id: "unknown-1",
  question: "当前最需要哪种支持？",
  domain: "collaboration",
  relatedEvidence: ["claim-1", "claim-1"],
  version: 1
}).relatedEvidence.length, 1);

const context = new AsyncLocalStorage();
const accounts = new Map([
  ["account-a", {
    onboardingV2: onboarding(statement),
    userClaims: [claim("claim-1", statement)],
    modelUnknowns: []
  }],
  ["account-b", {
    onboardingV2: onboarding("另一个账户的原文"),
    userClaims: [],
    modelUnknowns: []
  }]
]);
const repository = {
  async read() {
    return clone(accounts.get(context.getStore()));
  },
  async update(mutate) {
    const account = context.getStore();
    const draft = clone(accounts.get(account));
    const result = await mutate(draft);
    accounts.set(account, draft);
    return result;
  }
};
const run = (account, operation) => context.run(account, operation);
let nextId = 1;
let nextSecond = 0;
const service = createUserModelService({
  repository,
  isEvidenceCurrent: userModelEvidenceCurrent,
  createId: () => `claim-revision-${nextId++}`,
  now: () => new Date(Date.UTC(2026, 9, 2, 2, 0, nextSecond++)).toISOString()
});

assert.equal((await run("account-a", () => service.get())).candidateCount, 1);
assert.equal((await run("account-b", () => service.get())).claims.length, 0);
assert.equal(personalContextProjection(accounts.get("account-a")).prompt.includes(statement), true);
assert.equal(
  personalContextProjection(accounts.get("account-a")).overview.conclusions
    .some(item => item.id === "user-claim-claim-1"),
  false
);

const confirmed = await run("account-a", () => service.patchClaim("claim-1", {
  action: "confirm",
  epistemic: "known",
  contextAllowed: true
}, { expectedVersion: 1 }));
assert.equal(confirmed.value.lifecycle, "active");
assert.equal(confirmed.value.version, 2);
const confirmedProjection = personalContextProjection(accounts.get("account-a"));
assert.equal(confirmedProjection.prompt.includes("用户逐项确认的理解"), true);
const claimSource = confirmedProjection.overview.sources.find(item => item.resourceType === "userClaim");
assert.equal(claimSource.evidence[0].contentSha256, hash(statement));
assert.equal(
  confirmedProjection.overview.conclusions.some(item => item.id === "user-claim-claim-1"),
  true
);
const changedConfirmedSource = clone(accounts.get("account-a"));
changedConfirmedSource.onboardingV2 = onboarding("已修改的当前处境", 2);
const disputedProjection = userModelProjection(changedConfirmedSource);
assert.equal(
  disputedProjection.claims.find(item => item.id === "claim-1").lifecycle,
  "disputed",
  "an active claim must become disputed when its source changes"
);
assert.equal(disputedProjection.activeClaimCount, 0);
assert.equal(disputedProjection.disputedClaimCount, 1);
assert.equal(
  personalContextProjection(changedConfirmedSource).overview.conclusions
    .some(item => item.id === "user-claim-claim-1"),
  false,
  "a disputed claim must not remain in the answer context"
);
const withdrawnConfirmedSource = clone(accounts.get("account-a"));
withdrawnConfirmedSource.onboardingV2.session.answers.currentContext.contextAllowed = false;
assert.equal(
  userModelProjection(withdrawnConfirmedSource).claims
    .find(item => item.id === "claim-1").lifecycle,
  "disputed",
  "withdrawing the source permission must dispute an active claim"
);

assert.deepEqual(await run("account-a", () => service.patchClaim(
  "claim-1",
  { action: "confirm" },
  { expectedVersion: 1 }
)), { versionConflict: true, currentVersion: 2 });

const revised = await run("account-a", () => service.patchClaim("claim-1", {
  action: "revise",
  statement: "最近在推进一个重要且需要协作的项目",
  epistemic: "hypothesis"
}, { expectedVersion: 2 }));
assert.equal(revised.previous.lifecycle, "superseded");
assert.equal(revised.value.supersedes, "claim-1");
assert.equal(revised.value.lifecycle, "active");
assert.equal(revised.value.confidence, null);

const retracted = await run("account-a", () => service.patchClaim(revised.value.id, {
  action: "retract",
  reason: "不再适用"
}, { expectedVersion: 1 }));
assert.equal(retracted.value.lifecycle, "retracted");
assert.equal(
  personalContextProjection(accounts.get("account-a")).overview.conclusions
    .some(item => item.id === `user-claim-${revised.value.id}`),
  false
);

accounts.get("account-a").userClaims.unshift(claim("claim-stale", statement));
accounts.get("account-a").onboardingV2 = onboarding("原文已经修改", 2);
const staleProjection = await run("account-a", () => service.get());
assert.equal(staleProjection.claims.find(item => item.id === "claim-stale").lifecycle, "stale");
const stale = await run("account-a", () => service.patchClaim(
  "claim-stale",
  { action: "confirm" },
  { expectedVersion: 1 }
));
assert.equal(stale.stale, true);
assert.equal(accounts.get("account-a").userClaims.find(item => item.id === "claim-stale").lifecycle, "stale");

const freshText = "准备恢复规律作息";
const candidateToReject = claim("claim-reject", freshText, {
  statement: freshText,
  evidence: [evidence(freshText)]
});
accounts.get("account-a").onboardingV2 = onboarding(freshText);
accounts.get("account-a").userClaims.unshift(candidateToReject);
const rejected = await run("account-a", () => service.patchClaim(
  "claim-reject",
  { action: "reject" },
  { expectedVersion: 1 }
));
assert.equal(rejected.value.lifecycle, "retracted");
assert.equal(rejected.value.disposition, "user_rejected");

const active = claim("claim-mapped", freshText, {
  statement: freshText,
  lifecycle: "active",
  confirmedAt: "2026-10-02T02:30:00.000Z"
});
const unknown = normalizeModelUnknown({
  id: "unknown-mapped",
  question: "最小的下一步是什么？",
  domain: "goals",
  relatedEvidence: [active.id],
  resolvedBy: active.id,
  createdAt: "2026-10-02T02:31:00.000Z",
  updatedAt: "2026-10-02T02:31:00.000Z",
  version: 1
});
const mappedStore = {
  version: 15,
  onboardingV2: onboarding(freshText),
  userClaims: [active],
  modelUnknowns: [unknown]
};
const mapping = mapStoreObjects("account-a", mappedStore);
assert.equal(mapping.objects.some(item => item.kind === "userClaim"), true);
assert.equal(mapping.objects.some(item => item.kind === "modelUnknown"), true);
assert.equal(mapping.relations.some(item => item.relation === "evidence:0"), true);
assert.equal(mapping.relations.some(item => item.relation === "relatedEvidence:0"), true);
assert.equal(canonicalJson(rebuildStoreObjects(mapping)), canonicalJson(mappedStore));
assert.equal(userModelProjection(mappedStore).activeClaimCount, 1);

console.log("User model claim checks passed: normalization, isolation, confirmation, correction, rejection, retraction, stale sources, personal-context projection and relational persistence.");
