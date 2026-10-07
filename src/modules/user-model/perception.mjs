import crypto from "node:crypto";
import { safeIso, safeText } from "../../shared/validation/index.mjs";
import { normalizeEvidenceSource } from "./evidence.mjs";

export const PERCEPTION_VERSION = "2026.10.07.1";
export const PERCEPTION_MAX_SOURCE_CHARS = 12_000;
export const PERCEPTION_MAX_EVIDENCE = 20;

const ORIGIN_INFORMATION_TYPES = Object.freeze({
  user: new Set(["user_fact", "user_viewpoint"]),
  third_party: new Set(["user_fact", "user_viewpoint"]),
  device: new Set(["measured_fact", "device_guidance"])
});
const objectValue = value => value && typeof value === "object" && !Array.isArray(value);
const keysMatch = (value, allowed, required = allowed) => {
  if (!objectValue(value)) return false;
  const keys = Object.keys(value);
  return keys.every(key => allowed.includes(key)) && required.every(key => keys.includes(key));
};
const fail = message => {
  throw Object.assign(new Error(message), { code: "PERCEPTION_EXTRACTION_INVALID" });
};

export function perceptionExtractionSchema() {
  return JSON.stringify({
    evidence: [{
      origin: "user|third_party|device",
      informationType: "user_fact|user_viewpoint|measured_fact|device_guidance",
      span: [0, 1]
    }]
  });
}

export function parsePerceptionExtractionOutput(raw, {
  accountId,
  source,
  sourceTaskId,
  createId = () => crypto.randomUUID(),
  now = () => new Date().toISOString()
} = {}) {
  let document;
  try {
    document = typeof raw === "string" ? JSON.parse(raw) : structuredClone(raw);
  } catch {
    fail("感知结果不是有效 JSON");
  }
  if (!keysMatch(document, ["evidence"])
    || !Array.isArray(document.evidence)
    || document.evidence.length > PERCEPTION_MAX_EVIDENCE
    || !objectValue(source)
    || !source.sourceRef
    || typeof source.text !== "string"
    || source.text.length > PERCEPTION_MAX_SOURCE_CHARS
    || !source.eventId
    || !Number.isSafeInteger(source.permissionRevision)
    || source.permissionRevision < 1) {
    fail("感知结果或来源上下文无效");
  }
  const recordedAt = safeIso(now());
  const normalizedAccountId = safeText(accountId, 100);
  const normalizedTaskId = safeText(sourceTaskId, 100);
  if (!recordedAt || !normalizedAccountId || !normalizedTaskId) {
    fail("感知结果缺少账户、任务或时间");
  }
  const seen = new Set();
  return document.evidence.map(candidate => {
    if (!keysMatch(candidate, ["origin", "informationType", "span"])
      || !ORIGIN_INFORMATION_TYPES[candidate.origin]?.has(candidate.informationType)
      || !Array.isArray(candidate.span)
      || candidate.span.length !== 2
      || !candidate.span.every(Number.isSafeInteger)) {
      fail("感知证据字段无效");
    }
    const [start, end] = candidate.span;
    if (start < 0 || end <= start || end > source.text.length
      || !source.text.slice(start, end).trim()) {
      fail("感知证据无法定位到当前原文");
    }
    const identity = JSON.stringify([candidate.origin, candidate.informationType, start, end]);
    if (seen.has(identity)) fail("感知证据重复");
    seen.add(identity);
    const evidence = normalizeEvidenceSource({
      schemaVersion: 1,
      id: safeText(createId(), 100),
      accountId: normalizedAccountId,
      sourceRef: source.sourceRef,
      eventId: source.eventId,
      origin: candidate.origin,
      informationType: candidate.informationType,
      contentSha256: source.contentSha256,
      contentLength: source.text.length,
      span: [start, end],
      occurredAt: source.occurredAt,
      recordedAt,
      permissionRevision: source.permissionRevision,
      derivedFrom: []
    });
    if (!evidence) fail("感知证据无法通过领域校验");
    return { ...evidence, sourceTaskId: normalizedTaskId };
  });
}
