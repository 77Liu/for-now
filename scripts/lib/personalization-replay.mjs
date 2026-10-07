import crypto from "node:crypto";
import { personalContextProjection } from "../../src/app/index.mjs";
import {
  defaultLlmSettings,
  llmSettingsForScene,
  systemPrompt,
  systemPromptForScene,
  userPrompt
} from "../../src/modules/ai/index.mjs";
import { thoughtTask } from "../../src/modules/thoughts/index.mjs";
import { promptCatalogMetadata } from "../../src/shared/prompts/index.mjs";

export const REPLAY_OUTPUT_SCHEMA_VERSION = 1;
export const REPLAY_VARIANTS = Object.freeze(["general", "legacy", "new"]);

const list = value => Array.isArray(value) ? value : [];
const sortUnique = values => [...new Set(values)].sort();
const ratio = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(6)) : null;
const itemId = material => material.id.split(":").slice(1).join(":");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function textFingerprint(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function legacyReceiptFingerprint(receipt) {
  return JSON.stringify({
    version: receipt?.version || "",
    tokenLimit: receipt?.tokenBudget?.limit || 0,
    promptSha256: receipt?.promptSha256 || "",
    sources: list(receipt?.sources).map(source => ({
      id: source.id,
      contentSha256: String(source.contentSha256 || "").slice(0, 64)
    }))
  });
}

function requestEvidence(fixture, contextPrompt) {
  const scene = "thoughtAnswer";
  const settings = llmSettingsForScene(defaultLlmSettings, scene);
  const effectiveSystemPrompt = systemPromptForScene(systemPrompt(), scene, settings);
  const effectiveUserPrompt = userPrompt({
    context: contextPrompt,
    chain: fixture.task,
    task: thoughtTask("answer")
  });
  const parameters = {
    provider: settings.provider,
    model: settings.model,
    reasoningEffort: settings.effort,
    maxOutputTokens: 16000,
    stream: false,
    responseFormat: "text",
    responseStyle: settings.responseStyle
  };
  return {
    promptCatalog: promptCatalogMetadata(),
    scene,
    parameters,
    systemPromptSha256: textFingerprint(effectiveSystemPrompt),
    userPromptSha256: textFingerprint(effectiveUserPrompt),
    fullRequestSha256: fingerprint({
      messages: [
        { role: "system", content: effectiveSystemPrompt },
        { role: "user", content: effectiveUserPrompt }
      ],
      parameters
    })
  };
}

function executeConcurrencyCase(testCase) {
  let activeVersion = 0;
  const taskVersions = new Set();
  const acceptedResultVersions = [];
  const rejectedResultVersions = [];
  for (const step of list(testCase.steps)) {
    if (step.type === "source-saved") {
      activeVersion = Math.max(activeVersion, Number(step.version) || 0);
    } else if (step.type === "task-created") {
      taskVersions.add(Number(step.version) || 0);
    } else if (step.type === "result-arrived") {
      const version = Number(step.version) || 0;
      if (taskVersions.has(version) && version === activeVersion) acceptedResultVersions.push(version);
      else rejectedResultVersions.push(version);
    } else {
      throw new Error(`Unsupported concurrency replay step: ${step.type}`);
    }
  }
  return { activeVersion, acceptedResultVersions, rejectedResultVersions };
}

function executePermissionCase(testCase) {
  if (testCase.accountId !== testCase.sourceAccountId) return "account-mismatch";
  if (testCase.selectedPermissionRevision !== testCase.currentPermissionRevision) return "permission-stale";
  if (testCase.contextAllowed !== true) return "permission-denied";
  return "allowed";
}

function executeFixtureCases(fixture) {
  return list(fixture.executableCases).map(testCase => {
    const actual = fixture.dimension === "concurrency"
      ? executeConcurrencyCase(testCase)
      : fixture.dimension === "permission-isolation"
        ? executePermissionCase(testCase)
        : null;
    if (JSON.stringify(actual) !== JSON.stringify(testCase.expected)) {
      throw new Error(`Replay executable case failed: ${fixture.id}/${testCase.id}`);
    }
    return { id: testCase.id, status: "passed", result: actual };
  });
}

function sourceRecord(material, fixtureIndex, materialIndex) {
  const occurredOn = material.occurredOn || `2026-09-${String((fixtureIndex + materialIndex) % 27 + 1).padStart(2, "0")}`;
  return {
    id: itemId(material),
    occurredOn,
    occurredAt: `${occurredOn}T08:00:00.000Z`,
    createdAt: `${occurredOn}T08:00:00.000Z`,
    updatedAt: `${occurredOn}T08:00:00.000Z`,
    version: material.version || 1,
    contextAllowed: material.contextAllowed !== false,
    ...(material.disposition ? { disposition: material.disposition } : {})
  };
}

function legacyStore(fixture, fixtureIndex) {
  const store = {
    onboarding: {},
    onboardingV2: {},
    userClaims: [],
    checkins: [],
    dailyRecords: [],
    captures: [],
    journals: [],
    thoughts: []
  };
  list(fixture.materials).forEach((material, materialIndex) => {
    if (!material.storeKind || material.account === "other") return;
    const record = sourceRecord(material, fixtureIndex, materialIndex);
    if (material.storeKind === "capture") {
      store.captures.push({ ...record, content: material.text, tags: [] });
    } else if (material.storeKind === "journal") {
      store.journals.push({ ...record, title: "", content: material.text, tags: [] });
    } else if (material.storeKind === "checkin") {
      store.checkins.push({
        ...record,
        mood: 3,
        energy: 3,
        stress: 3,
        sleep: 3,
        factors: [],
        ...material.payload
      });
    } else if (material.storeKind === "dailyRecord") {
      store.dailyRecords.push({
        ...record,
        type: "weight",
        ...material.payload,
        description: material.payload?.description || material.text
      });
    } else if (material.storeKind === "thoughtAi") {
      store.thoughts.push({
        ...record,
        type: "question",
        authorType: "ai",
        content: material.text
      });
    } else {
      throw new Error(`Unsupported replay storeKind: ${material.storeKind}`);
    }
  });
  return store;
}

function currentSourceIds(fixture) {
  return list(fixture.materials)
    .filter(material => material.channel === "current"
      && material.contextAllowed !== false
      && material.account !== "other")
    .map(material => material.id);
}

function stubAssertions(fixture, variant, selectedSourceIds) {
  return list(fixture.stubAssertions?.[variant]).map(assertion => ({
    id: assertion.id,
    sourceIds: sortUnique(list(assertion.sourceIds)).filter(id => selectedSourceIds.includes(id))
  }));
}

function replayOutput(fixture, variant, selectedSourceIds, adapterEvidence) {
  const selected = sortUnique(selectedSourceIds);
  return {
    schemaVersion: REPLAY_OUTPUT_SCHEMA_VERSION,
    variant,
    executionMode: "deterministic-stub",
    fixtureId: fixture.id,
    selectedSourceIds: selected,
    assertions: stubAssertions(fixture, variant, selected),
    adapterEvidence
  };
}

export function createGeneralReplayAdapter() {
  return {
    id: "general",
    executionMode: "deterministic-stub",
    run(fixture) {
      return replayOutput(fixture, "general", currentSourceIds(fixture), {
        selectionPolicy: "current-material-only-v1",
        ...requestEvidence(fixture, "")
      });
    }
  };
}

export function createLegacyReplayAdapter({
  project = personalContextProjection
} = {}) {
  return {
    id: "legacy",
    executionMode: "deterministic-stub",
    run(fixture, { fixtureIndex = 0 } = {}) {
      const projection = project(legacyStore(fixture, fixtureIndex), {
        generatedAt: "2026-10-07T00:00:00.000Z"
      });
      return replayOutput(fixture, "legacy", [
        ...currentSourceIds(fixture),
        ...list(projection.receipt?.sources).map(source => source.id)
      ], {
        selectionPolicy: "personal-context-projection",
        projectionVersion: projection.receipt?.version || "",
        promptSha256: projection.receipt?.promptSha256 || "",
        receiptFingerprintSha256: fingerprint(
          legacyReceiptFingerprint(projection.receipt)
        ),
        sourceFingerprintSha256: fingerprint(list(projection.receipt?.sources).map(source => ({
          id: source.id,
          version: source.version,
          contentSha256: source.contentSha256
        }))),
        ...requestEvidence(fixture, projection.prompt)
      });
    }
  };
}

function dimensionCoverageSatisfied(fixture) {
  const materials = list(fixture.materials);
  const oracle = list(fixture.assertionOracle);
  const hasMaterial = predicate => materials.some(predicate);
  const hasOracle = predicate => oracle.some(predicate);
  if (fixture.dimension === "extraction") {
    return hasMaterial(item => item.forbiddenReason === "third-party-as-user")
      && hasMaterial(item => item.forbiddenReason === "ai-as-user")
      && hasOracle(item => item.supportedBySourceIds?.length === 0);
  }
  if (fixture.dimension === "temporal-reasoning") {
    return materials.filter(item => item.timeSensitive).length >= 2
      && hasOracle(item => item.timeSensitive && item.freshnessMisstatement);
  }
  if (fixture.dimension === "knowledge-update") {
    return hasMaterial(item => item.forbiddenReason === "superseded" && item.contextAllowed === false)
      && hasMaterial(item => item.channel === "history" && item.required);
  }
  if (fixture.dimension === "restraint") {
    return hasMaterial(item => item.forbiddenReason === "unsupported-inference" && item.contextAllowed === false);
  }
  if (fixture.dimension === "new-data-visibility") {
    return hasMaterial(item => item.channel === "current" && item.required && item.storeKind);
  }
  if (fixture.dimension === "concurrency") {
    return hasMaterial(item => item.forbiddenReason === "stale-result" && item.version >= 1)
      && hasMaterial(item => item.required && item.version > 1)
      && list(fixture.executableCases).length >= 2;
  }
  if (fixture.dimension === "deduplication") {
    const groups = new Map();
    for (const item of materials.filter(material => material.deduplicate && material.eventId)) {
      groups.set(item.eventId, (groups.get(item.eventId) || 0) + 1);
    }
    return [...groups.values()].some(count => count > 1);
  }
  if (fixture.dimension === "scale-semantics") {
    return hasMaterial(item => item.storeKind === "checkin" && item.payload?.stress === 5)
      && hasOracle(item => item.semanticallyCorrect === false);
  }
  if (fixture.dimension === "task-relevance") {
    return hasMaterial(item => item.channel === "history" && item.required && item.relevant)
      && hasMaterial(item => item.channel === "history" && item.relevant === false);
  }
  if (fixture.dimension === "complete-chain") {
    return materials.filter(item => item.channel === "current" && item.required).length >= 3;
  }
  if (fixture.dimension === "permission-isolation") {
    return hasMaterial(item => item.forbiddenReason === "context-denied" && item.contextAllowed === false)
      && hasMaterial(item => item.forbiddenReason === "cross-account" && item.account === "other")
      && list(fixture.executableCases).length >= 4;
  }
  if (fixture.dimension === "evidence-invalidation") {
    return hasMaterial(item => item.forbiddenReason === "deleted-root" && item.contextAllowed === false)
      && hasMaterial(item => item.forbiddenReason === "invalidated-derived");
  }
  if (fixture.dimension === "source-fidelity") {
    return hasMaterial(item => item.storeKind === "dailyRecord" && item.payload?.description)
      && hasOracle(item => item.supportedBySourceIds?.length === 0);
  }
  if (fixture.dimension === "feedback-learning") {
    return hasMaterial(item => item.channel === "history" && item.required && /failed because/i.test(item.text));
  }
  if (fixture.dimension === "generalization-boundary") {
    return hasMaterial(item => item.channel === "current" && /this design review/i.test(item.text))
      && hasOracle(item => item.semanticallyCorrect === false);
  }
  if (fixture.dimension === "personalization-benefit") {
    return fixture.requiresRealModel === true
      && materials.filter(item => item.channel === "history" && item.required).length >= 2
      && materials.filter(item => item.channel === "history" && item.relevant === false).length >= 2;
  }
  return false;
}

export function validateReplayFixtureSet(fixtureSet) {
  if (fixtureSet?.schemaVersion !== 1) throw new Error("Replay fixture schemaVersion must be 1");
  if (fixtureSet?.dataPolicy !== "synthetic-only") throw new Error("Replay fixtures must use synthetic-only data");
  const dimensions = list(fixtureSet.dimensions);
  const fixtures = list(fixtureSet.fixtures);
  if (dimensions.length !== 16 || new Set(dimensions).size !== 16) {
    throw new Error("Replay fixture set must freeze exactly 16 unique dimensions");
  }
  if (fixtures.length !== 16) throw new Error("Replay fixture set must contain exactly 16 fixtures");
  const fixtureIds = new Set();
  const seenDimensions = new Set();
  for (const fixture of fixtures) {
    if (!fixture.id || fixtureIds.has(fixture.id)) throw new Error(`Duplicate or missing replay fixture id: ${fixture.id}`);
    fixtureIds.add(fixture.id);
    if (typeof fixture.task !== "string" || !fixture.task.trim()) {
      throw new Error(`Replay fixture ${fixture.id} must have a non-empty task`);
    }
    if (!dimensions.includes(fixture.dimension) || seenDimensions.has(fixture.dimension)) {
      throw new Error(`Replay dimension must appear exactly once: ${fixture.dimension}`);
    }
    seenDimensions.add(fixture.dimension);
    const materials = list(fixture.materials);
    const materialIds = new Set(materials.map(material => material.id));
    if (!materials.length || materialIds.size !== materials.length) {
      throw new Error(`Replay fixture ${fixture.id} has missing or duplicate material ids`);
    }
    if (!materials.some(material => material.channel === "current" && material.required)) {
      throw new Error(`Replay fixture ${fixture.id} must have required current material`);
    }
    if (!dimensionCoverageSatisfied(fixture)) {
      throw new Error(`Replay fixture ${fixture.id} does not exercise ${fixture.dimension}`);
    }
    const assertionOracle = new Map();
    for (const assertion of list(fixture.assertionOracle)) {
      if (!assertion.id || assertionOracle.has(assertion.id)) {
        throw new Error(`Replay fixture ${fixture.id} has duplicate or missing assertion oracle id`);
      }
      assertionOracle.set(assertion.id, assertion);
      for (const sourceId of list(assertion.supportedBySourceIds)) {
        if (!materialIds.has(sourceId)) {
          throw new Error(`Replay assertion oracle ${fixture.id}/${assertion.id} references unknown source ${sourceId}`);
        }
      }
    }
    for (const variant of ["general", "legacy"]) {
      if (!Array.isArray(fixture.expectedFailureCodes?.[variant])) {
        throw new Error(`Replay fixture ${fixture.id} is missing ${variant} baseline expectations`);
      }
      for (const assertion of list(fixture.stubAssertions?.[variant])) {
        if (!assertionOracle.has(assertion.id)) {
          throw new Error(`Replay stub ${fixture.id}/${assertion.id} has no assertion oracle`);
        }
        for (const sourceId of list(assertion.sourceIds)) {
          if (!materialIds.has(sourceId)) {
            throw new Error(`Replay assertion ${fixture.id}/${assertion.id} references unknown source ${sourceId}`);
          }
        }
      }
    }
  }
  if (fixtures.filter(fixture => fixture.requiresRealModel).length !== 8) {
    throw new Error("Replay fixture set must freeze exactly 8 representative real-model tasks");
  }
  return fixtureSet;
}

export function validateReplayManifest(fixtureSet, manifest) {
  if (manifest?.schemaVersion !== 1) throw new Error("Replay manifest schemaVersion must be 1");
  if (manifest.fixtureSetVersion !== fixtureSet.fixtureSetVersion) {
    throw new Error("Replay manifest fixture version does not match");
  }
  if (manifest.fixtureSetFingerprint !== fingerprint(fixtureSet)) {
    throw new Error("Replay manifest fixture fingerprint does not match");
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.baseline?.commit || "")
    || !/^[a-f0-9]{40}$/.test(manifest.baseline?.tree || "")) {
    throw new Error("Replay manifest baseline commit and tree are required");
  }
  if (manifest.candidate?.status !== "not-frozen"
    || manifest.candidate?.commit != null
    || manifest.candidate?.tree != null) {
    throw new Error("Replay candidate must remain explicitly not-frozen during 10a");
  }
  for (const variant of ["general", "legacy"]) {
    if (!/^[a-f0-9]{64}$/.test(manifest.baselineResultFingerprints?.[variant] || "")) {
      throw new Error(`Replay manifest ${variant} baseline fingerprint is required`);
    }
  }
  const catalog = promptCatalogMetadata();
  if (manifest.promptCatalog?.version !== catalog.version
    || manifest.promptCatalog?.sha256 !== catalog.sha256) {
    throw new Error("Replay prompt catalog does not match the active catalog");
  }
  const settings = llmSettingsForScene(defaultLlmSettings, "thoughtAnswer");
  const actualContract = {
    scene: "thoughtAnswer",
    responseStyle: settings.responseStyle,
    provider: settings.provider,
    model: settings.model,
    reasoningEffort: settings.effort,
    maxOutputTokens: 16000,
    stream: false,
    responseFormat: "text",
    repetitionsPerVariant: 2
  };
  for (const [key, value] of Object.entries(actualContract)) {
    if (manifest.requestContract?.[key] !== value) {
      throw new Error(`Replay request contract mismatch: ${key}`);
    }
  }
  const requiredPromptIds = [
    "ai.system.core",
    "ai.scene.thoughtAnswer",
    "ai.style.standard",
    "ai.identity.named",
    "ai.user.wrapper",
    "thought.task.answer",
    "context.personal"
  ];
  if (JSON.stringify(manifest.requestContract?.promptIds) !== JSON.stringify(requiredPromptIds)) {
    throw new Error("Replay request prompt ids do not match");
  }
  return manifest;
}

function assertDeterministicStubOutput(fixture, variant, output) {
  if (output.executionMode !== "deterministic-stub") return;
  const expected = list(fixture.stubAssertions?.[variant]).map(assertion => ({
    id: assertion.id,
    sourceIds: sortUnique(list(assertion.sourceIds).filter(id => output.selectedSourceIds.includes(id)))
  }));
  const actual = list(output.assertions).map(assertion => ({
    id: assertion.id,
    sourceIds: sortUnique(list(assertion.sourceIds))
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Replay deterministic assertions drift for ${fixture.id}/${variant}`);
  }
}

function evaluateFixture(fixture, output, thresholds) {
  if (output?.schemaVersion !== REPLAY_OUTPUT_SCHEMA_VERSION) {
    throw new Error(`Replay output schema mismatch for ${fixture.id}/${output?.variant || "unknown"}`);
  }
  const materials = new Map(list(fixture.materials).map(material => [material.id, material]));
  const selectedSourceIds = sortUnique(list(output.selectedSourceIds));
  for (const sourceId of selectedSourceIds) {
    if (!materials.has(sourceId)) throw new Error(`Replay output selected unknown source ${sourceId}`);
  }
  const assertionOracle = new Map(list(fixture.assertionOracle).map(assertion => [assertion.id, assertion]));
  const gradedAssertions = list(output.assertions).map(assertion => {
    const oracle = assertionOracle.get(assertion.id);
    if (!oracle) throw new Error(`Replay output ${fixture.id}/${assertion.id} has no assertion oracle`);
    for (const sourceId of list(assertion.sourceIds)) {
      if (!selectedSourceIds.includes(sourceId)) {
        throw new Error(`Replay assertion ${fixture.id}/${assertion.id} cites unselected source ${sourceId}`);
      }
    }
    const cited = new Set(list(assertion.sourceIds));
    const expectedSupport = list(oracle.supportedBySourceIds);
    return {
      id: assertion.id,
      supported: expectedSupport.length > 0 && expectedSupport.every(sourceId => cited.has(sourceId)),
      semanticallyCorrect: oracle.semanticallyCorrect === true,
      timeSensitive: oracle.timeSensitive === true,
      freshnessMisstatement: oracle.freshnessMisstatement === true
    };
  });

  const selected = selectedSourceIds.map(id => materials.get(id));
  const candidateSelected = selected.filter(material => material.channel !== "current");
  const required = [...materials.values()].filter(material => (
    material.channel !== "current" && material.required
  ));
  const missingRequired = required.filter(material => !selectedSourceIds.includes(material.id));
  const missingCurrent = [...materials.values()].filter(material => (
    material.channel === "current"
    && material.contextAllowed !== false
    && material.account !== "other"
    && !selectedSourceIds.includes(material.id)
  ));
  const forbidden = selected.filter(material => material.forbiddenReason);
  const relevantCount = candidateSelected.filter(material => material.relevant).length;
  const assertions = gradedAssertions;
  const supportedCount = assertions.filter(assertion => assertion.supported).length;
  const timeSensitive = assertions.filter(assertion => assertion.timeSensitive);
  const freshnessMisstatements = timeSensitive.filter(assertion => assertion.freshnessMisstatement);
  const semanticMismatches = assertions.filter(assertion => !assertion.semanticallyCorrect);
  const duplicateEvents = new Set();
  const eventCounts = new Map();
  for (const material of selected.filter(item => item.deduplicate && item.eventId)) {
    eventCounts.set(material.eventId, (eventCounts.get(material.eventId) || 0) + 1);
  }
  for (const [eventId, count] of eventCounts) {
    if (count > 1) duplicateEvents.add(eventId);
  }

  const metrics = {
    selectedMaterialCount: candidateSelected.length,
    selectedCurrentMaterialCount: selected.length - candidateSelected.length,
    relevantSelectedCount: relevantCount,
    materialRelevanceRate: ratio(relevantCount, candidateSelected.length),
    requiredEvidenceCount: required.length,
    missedCriticalEvidenceCount: missingRequired.length,
    criticalEvidenceMissRate: ratio(missingRequired.length, required.length),
    assertionCount: assertions.length,
    supportedAssertionCount: supportedCount,
    evidenceSupportRate: ratio(supportedCount, assertions.length),
    timeSensitiveAssertionCount: timeSensitive.length,
    freshnessMisstatementCount: freshnessMisstatements.length,
    freshnessMisstatementRate: ratio(freshnessMisstatements.length, timeSensitive.length),
    forbiddenSourceUseCount: forbidden.length,
    duplicateEventUseCount: duplicateEvents.size,
    currentMaterialLossCount: missingCurrent.length
  };
  const failureCodes = [];
  if (metrics.materialRelevanceRate != null
    && metrics.materialRelevanceRate < thresholds.materialRelevanceRate) {
    failureCodes.push("material-relevance-below-85");
  }
  if (metrics.criticalEvidenceMissRate > thresholds.criticalEvidenceMissRate) {
    failureCodes.push("critical-evidence-missed");
  }
  if (metrics.evidenceSupportRate != null
    && metrics.evidenceSupportRate < thresholds.evidenceSupportRate) {
    failureCodes.push("evidence-support-below-100");
  }
  if (metrics.freshnessMisstatementRate != null
    && metrics.freshnessMisstatementRate > thresholds.freshnessMisstatementRate) {
    failureCodes.push("freshness-misstatement");
  }
  if (forbidden.length) failureCodes.push("forbidden-source-used");
  if (duplicateEvents.size) failureCodes.push("duplicate-event-used");
  if (missingCurrent.length) failureCodes.push("current-material-lost");
  if (semanticMismatches.length) failureCodes.push("semantic-assertion-mismatch");

  return {
    fixtureId: fixture.id,
    dimension: fixture.dimension,
    metrics,
    selectedSourceIds,
    missingRequiredSourceIds: missingRequired.map(material => material.id).sort(),
    forbiddenSourceIds: forbidden.map(material => material.id).sort(),
    duplicateEventIds: [...duplicateEvents].sort(),
    failureCodes: sortUnique(failureCodes),
    requiresRealModel: fixture.requiresRealModel === true,
    adapterEvidence: structuredClone(output.adapterEvidence || {}),
    executableCases: executeFixtureCases(fixture)
  };
}

function aggregateFixtureResults(results) {
  const sums = results.reduce((total, result) => {
    const metrics = result.metrics;
    total.selected += metrics.selectedMaterialCount;
    total.relevant += metrics.relevantSelectedCount;
    total.required += metrics.requiredEvidenceCount;
    total.missed += metrics.missedCriticalEvidenceCount;
    total.assertions += metrics.assertionCount;
    total.supported += metrics.supportedAssertionCount;
    total.timeSensitive += metrics.timeSensitiveAssertionCount;
    total.freshness += metrics.freshnessMisstatementCount;
    total.forbidden += metrics.forbiddenSourceUseCount;
    total.duplicates += metrics.duplicateEventUseCount;
    total.currentLoss += metrics.currentMaterialLossCount;
    return total;
  }, {
    selected: 0,
    relevant: 0,
    required: 0,
    missed: 0,
    assertions: 0,
    supported: 0,
    timeSensitive: 0,
    freshness: 0,
    forbidden: 0,
    duplicates: 0,
    currentLoss: 0
  });
  return {
    fixtureCount: results.length,
    failingFixtureCount: results.filter(result => result.failureCodes.length).length,
    materialRelevanceRate: ratio(sums.relevant, sums.selected),
    criticalEvidenceMissRate: ratio(sums.missed, sums.required),
    evidenceSupportRate: ratio(sums.supported, sums.assertions),
    freshnessMisstatementRate: ratio(sums.freshness, sums.timeSensitive),
    forbiddenSourceUseCount: sums.forbidden,
    duplicateEventUseCount: sums.duplicates,
    currentMaterialLossCount: sums.currentLoss
  };
}

export function runReplaySuite(fixtureSet, {
  manifest,
  adapters = [createGeneralReplayAdapter(), createLegacyReplayAdapter()]
} = {}) {
  validateReplayFixtureSet(fixtureSet);
  validateReplayManifest(fixtureSet, manifest);
  const adapterMap = new Map(adapters.map(adapter => [adapter.id, adapter]));
  const variants = {};
  for (const variant of REPLAY_VARIANTS) {
    const adapter = adapterMap.get(variant);
    if (!adapter) {
      variants[variant] = {
        status: "not-run",
        reason: variant === "new" ? "new-orchestrator-not-implemented" : "adapter-not-provided"
      };
      continue;
    }
    if (variant === "new" || adapter.executionMode !== "deterministic-stub") {
      throw new Error(
        `Replay ${variant} adapter requires the trusted 10b answer grader before execution`
      );
    }
    const fixtures = fixtureSet.fixtures.map((fixture, fixtureIndex) => {
      const output = adapter.run(fixture, { fixtureIndex });
      if (output?.variant !== variant
        || output?.fixtureId !== fixture.id
        || output?.executionMode !== adapter.executionMode) {
        throw new Error(`Replay adapter identity mismatch for ${fixture.id}/${variant}`);
      }
      assertDeterministicStubOutput(fixture, variant, output);
      const result = evaluateFixture(
        fixture,
        output,
        fixtureSet.thresholds
      );
      const expected = fixture.expectedFailureCodes?.[variant];
      if (Array.isArray(expected)
        && JSON.stringify(result.failureCodes) !== JSON.stringify(sortUnique(expected))) {
        throw new Error(
          `Replay baseline drift for ${fixture.id}/${variant}: `
          + `expected ${JSON.stringify(sortUnique(expected))}, got ${JSON.stringify(result.failureCodes)}`
        );
      }
      return result;
    });
    const aggregate = aggregateFixtureResults(fixtures);
    variants[variant] = {
      status: "baseline-observed",
      executionMode: adapter.executionMode,
      gateEligible: false,
      baselineExpectationsMatched: true,
      qualityStatus: [
        "materialRelevanceRate",
        "criticalEvidenceMissRate",
        "evidenceSupportRate",
        "freshnessMisstatementRate"
      ].some(metric => aggregate[metric] == null)
        ? "not-evaluable"
        : fixtures.some(result => result.failureCodes.length)
          ? "known-baseline-gaps"
          : "meets-deterministic-gates",
      aggregate,
      fixtures,
      fingerprint: fingerprint(fixtures)
    };
    const expectedFingerprint = manifest.baselineResultFingerprints?.[variant];
    if (expectedFingerprint && variants[variant].fingerprint !== expectedFingerprint) {
      throw new Error(`Replay ${variant} result fingerprint drift`);
    }
  }
  return {
    schemaVersion: REPLAY_OUTPUT_SCHEMA_VERSION,
    fixtureSetVersion: fixtureSet.fixtureSetVersion,
    fixtureSetFingerprint: fingerprint(fixtureSet),
    replayManifestFingerprint: fingerprint(manifest),
    dataPolicy: fixtureSet.dataPolicy,
    thresholds: structuredClone(fixtureSet.thresholds),
    variants,
    realModelEvaluation: {
      status: "not-run",
      reason: "owner-and-cost-authorization-required",
      fixtureIds: fixtureSet.fixtures.filter(fixture => fixture.requiresRealModel).map(fixture => fixture.id)
    },
    coverage: {
      fixtureLayer: "executable",
      productionBehavior: "not-run",
      reason: "10a-freezes-replay-inputs-and-baselines-before-05-10-implementation"
    }
  };
}
