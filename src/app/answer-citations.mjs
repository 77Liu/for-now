import { safeText } from "../shared/validation/index.mjs";

const objectValue = value => value && typeof value === "object" && !Array.isArray(value);

export function parseVerifiedAnswer(raw, availableSources = []) {
  let document;
  try {
    document = JSON.parse(String(raw ?? ""));
  } catch {
    throw Object.assign(new Error("回答没有遵守 JSON 与引用契约"), {
      code: "ANSWER_CITATION_FORMAT_INVALID"
    });
  }
  if (!objectValue(document)
    || typeof document.answer !== "string"
    || !document.answer.trim()
    || !Array.isArray(document.citations)
    || document.citations.length > 8) {
    throw Object.assign(new Error("回答没有遵守 JSON 与引用契约"), {
      code: "ANSWER_CITATION_FORMAT_INVALID"
    });
  }
  const byId = new Map((Array.isArray(availableSources) ? availableSources : [])
    .filter(source => typeof source?.citationId === "string" && source.citationId && typeof source.text === "string")
    .map(source => [source.citationId, source]));
  const seen = new Set();
  const citations = document.citations.flatMap(candidate => {
    if (!objectValue(candidate)
      || Object.keys(candidate).length !== 2
      || typeof candidate.citationId !== "string"
      || typeof candidate.exactQuote !== "string") return [];
    const source = byId.get(candidate.citationId);
    const exactQuote = candidate.exactQuote;
    if (!source || !exactQuote || exactQuote.length > 1000 || !source.text.includes(exactQuote)) return [];
    const key = `${candidate.citationId}\u0000${exactQuote}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const metadata = source.source || {};
    return [{
      citationId: candidate.citationId,
      exactQuote,
      recordType: safeText(metadata.recordType, 100),
      resourceType: safeText(metadata.resourceType, 40),
      resourceId: safeText(metadata.resourceId, 100),
      version: Math.max(0, Math.round(Number(metadata.version) || 0)),
      location: objectValue(metadata.location) ? structuredClone(metadata.location) : null
    }];
  });
  return {
    content: safeText(document.answer, 120_000),
    citations,
    citationStatus: citations.length ? "matched" : "none"
  };
}
