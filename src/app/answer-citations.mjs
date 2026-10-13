import { compileReferenceRequest, decodeReferenceAnswer } from "../../.build/typescript/backend/shared/ai-context/index.mjs";
import { safeText } from "../shared/validation/index.mjs";

const objectValue = value => value && typeof value === "object" && !Array.isArray(value);

export function answerCitationSources(coreUserModel, additionalSources = []) {
  const sourcesById = new Map();
  const addSource = (citationId, text, metadata = {}) => {
    if (typeof citationId !== "string" || !citationId || typeof text !== "string" || !text) return;
    const existing = sourcesById.get(citationId);
    if (existing) {
      if (!existing.text.includes(text)) {
        existing.textSpans ||= [existing.text];
        existing.textSpans.push(text);
      }
      return;
    }
    sourcesById.set(citationId, {
      citationId,
      text,
      source: {
        id: citationId,
        resourceType: metadata.resourceType || "onboardingV2",
        resourceId: metadata.resourceId || metadata.sourceId || "",
        recordType: metadata.recordType || "核心用户模型证据",
        origin: metadata.origin || "user",
        informationType: metadata.informationType || "user_viewpoint",
        version: metadata.version || 0,
        contentSha256: metadata.contentSha256 || metadata.sourceHash || "",
        location: metadata.location && objectValue(metadata.location) ? structuredClone(metadata.location) : {
          view: "personal-context",
          targetId: metadata.sourceId || "",
          rootId: "",
          targetKey: metadata.targetKey || `answer:${metadata.sourceId || ""}`,
          occurredOn: ""
        }
      }
    });
  };
  for (const answer of Array.isArray(coreUserModel?.answers) ? coreUserModel.answers : []) {
    addSource(answer.citationId, answer.text, {
      sourceId: answer.sourceId,
      recordType: answer.title,
      informationType: answer.informationType,
      version: answer.sourceVersion
    });
  }
  for (const claim of Array.isArray(coreUserModel?.claims) ? coreUserModel.claims : []) {
    for (const evidence of Array.isArray(claim?.evidence) ? claim.evidence : []) {
      addSource(evidence.citationId, evidence.exactQuote, {
        sourceId: evidence.sourceId,
        recordType: "核心用户模型证据",
        version: evidence.sourceVersion
      });
    }
  }
  for (const source of Array.isArray(additionalSources) ? additionalSources : []) {
    addSource(source?.citationId, source?.text, source?.source || {});
  }
  return [...sourcesById.values()];
}

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
    if (!source || !exactQuote || exactQuote.length > 1000
      || !(source.textSpans || [source.text]).some(span => span.includes(exactQuote))) return [];
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

/**
 * 按当前 work/账户绑定编译模型引用；服务端仍保留真实来源与已发送原文目录。
 * @since unreleased
 */
export function prepareReferenceRequest(prompt, sources, binding) {
  return compileReferenceRequest(prompt, sources, binding);
}

/**
 * 解码本请求引用后复用逐字核验；未知别名不使合法回答整链失败。
 * 提供的参考只保存身份和标签，不在公开结果重复用户模型或原文详情。
 * @since unreleased
 */
export function verifyReferenceAnswer(raw, request) {
  const decoded = decodeReferenceAnswer(raw, request);
  const verified = parseVerifiedAnswer(decoded.raw, request.sources);
  return {
    ...verified,
    rejectedReferences: decoded.rejected,
    referenceReceipt: structuredClone(request.receipt),
    providedReferences: request.sources.map(item => ({
      citationId: item.citationId,
      resourceType: item.source?.resourceType || "",
      resourceId: item.source?.resourceId || "",
      version: item.source?.version || 0,
      recordType: item.source?.recordType || ""
    }))
  };
}
