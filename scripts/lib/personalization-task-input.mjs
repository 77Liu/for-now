import assert from "node:assert/strict";

export const REPLAY_INPUT_VERSION = "current-task-v2";
export const REPLAY_PURPOSE = "personalization-same-current-task-v2";
export const REPLAY_ACCOUNT_ID = "replay-account";
export const REPLAY_GENERATED_AT = "2026-10-07T12:30:00.000Z";

export function replayCurrentMaterials(fixture) {
  const allCurrent = (fixture.materials || []).filter(material => material.channel === "current");
  assert.equal(new Set(allCurrent.map(material => material.id)).size, allCurrent.length, "Duplicate current material");
  const current = allCurrent.filter(material => material.channel === "current"
    && material.contextAllowed !== false && !material.forbiddenReason
    && (!material.account || material.account === "self")
    && (!material.accountId || material.accountId === REPLAY_ACCOUNT_ID));
  assert.ok(current.length, "Replay requires an allowed current task material");
  for (const material of current) {
    assert.ok(typeof material.id === "string" && material.id.trim(), "Current material requires an id");
    assert.ok(typeof material.text === "string" && material.text.trim(), "Current material requires original text");
  }
  return current;
}

export function replayCurrentTask(fixture) {
  return `${fixture.task}\n\n当前用户提交的原文材料：\n${JSON.stringify(replayCurrentMaterials(fixture)
    .map(({ id, text }) => ({ id, text })))}`;
}

export function assertReplayCurrentCoverage(fixture, messages, selectedSourceIds) {
  const current = replayCurrentMaterials(fixture);
  const userText = messages.filter(message => message.role === "user").map(message => message.content).join("\n");
  for (const material of current) {
    assert.ok(userText.includes(material.id)
      && (userText.includes(material.text) || userText.includes(JSON.stringify(material.text))),
    `Actual request omits current material: ${material.id}`);
  }
  const currentIds = new Set((fixture.materials || []).filter(material => material.channel === "current").map(material => material.id));
  assert.deepEqual(selectedSourceIds.filter(id => currentIds.has(id)).sort(), current.map(material => material.id).sort(),
    "Selected current sources differ from actual allowed task materials");
}

export function replaySourceRecord(material, fixtureIndex, materialIndex) {
  const occurredOn = material.occurredOn || `2026-09-${String((fixtureIndex + materialIndex) % 27 + 1).padStart(2, "0")}`;
  return {
    id: material.id.split(":").slice(1).join(":"),
    occurredOn,
    occurredAt: `${occurredOn}T08:00:00.000Z`,
    createdAt: `${occurredOn}T08:00:00.000Z`,
    updatedAt: `${occurredOn}T08:00:00.000Z`,
    version: material.version || 1,
    contextAllowed: material.contextAllowed !== false,
    ...(material.disposition ? { disposition: material.disposition } : {})
  };
}

export function replayMaterialOrigin(material) {
  return material.forbiddenReason === "third-party-as-user" ? "third_party"
    : material.storeKind === "thoughtAi" ? "ai"
      : material.storeKind === "dailyRecord" ? "device" : "user";
}

export function replayGroundTruth(fixture, fixtureIndex) {
  return {
    dataPolicy: "synthetic-only", asOf: REPLAY_GENERATED_AT,
    currentTask: replayCurrentMaterials(fixture).map(({ id, text }) => ({ id, text })),
    sources: fixture.materials.map((material, materialIndex) => {
      const current = material.channel === "current";
      const record = current ? null : replaySourceRecord(material, fixtureIndex, materialIndex);
      return {
        ...structuredClone(material), origin: replayMaterialOrigin(material),
        effectiveOccurredAt: current ? REPLAY_GENERATED_AT : record.occurredAt,
        dateProvenance: current ? "fixed-synthetic-current-time"
          : material.occurredOn ? "explicit-synthetic-occurredOn" : "derived-synthetic-fixture-index-date",
        effectiveVersion: current ? material.version || 1 : record.version,
        account: material.account || "self",
        contextAllowed: material.contextAllowed !== false,
        ...(current ? {} : { learningAllowed: false })
      };
    })
  };
}
