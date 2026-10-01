import crypto from "node:crypto";
import { renderPrompt } from "../../shared/prompts/index.mjs";
import { recordVersion, safeText } from "../../shared/validation/index.mjs";

const clone = value => structuredClone(value);
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const idempotencyConflict = () => Object.assign(new Error("同一幂等键不能用于不同内容"), {
  statusCode: 409,
  code: "IDEMPOTENCY_KEY_REUSED"
});

function readData(value = {}) {
  return {
    analyses: Array.isArray(value.analyses) ? value.analyses : [],
    experiments: Array.isArray(value.experiments) ? value.experiments : [],
    customMetrics: Array.isArray(value.customMetrics) ? value.customMetrics : [],
    trash: Array.isArray(value.trash) ? value.trash : []
  };
}

function priorRequest(data, collection, type, clientRequestId) {
  return data[collection].find(item => item.clientRequestId === clientRequestId)
    || data.trash.find(item => item.type === type && item.payload?.clientRequestId === clientRequestId)?.payload
    || null;
}

function pageOf(items, { afterId = "", limit = 20 } = {}) {
  const start = afterId ? items.findIndex(item => item.id === afterId) + 1 : 0;
  if (afterId && start === 0) return { invalidCursor: true };
  const page = items.slice(start, start + limit);
  return {
    items: page,
    nextId: start + page.length < items.length ? page.at(-1)?.id || "" : ""
  };
}

const versioned = item => item ? { ...item, version: recordVersion(item.version) } : null;

export function reflectionEvidence({
  thoughts = [],
  checkins = [],
  dailyRecords = [],
  captures = [],
  journals = []
} = {}) {
  const thoughtRoots = thoughts.filter(item => item.type === "question");
  const reflectionData = thoughts.slice(0, 80).map(item => ({
    type: item.type,
    content: item.content,
    tags: item.tags,
    disposition: item.disposition,
    modelDraft: item.modelDraft,
    relatedTo: item.relatedTo,
    followUps: (item.followUps || []).map(followUp => ({
      question: followUp.question,
      answer: followUp.answer
    }))
  })).filter(item => item.content);
  return {
    evidenceCount: thoughtRoots.length + checkins.length + dailyRecords.length + captures.length + journals.length,
    evidenceLevel: thoughtRoots.length >= 3 ? "常规样本" : "冷启动低样本",
    reflectionData
  };
}

export function reflectionPrompt({ personalContext, reflectionData, evidenceLevel }) {
  return renderPrompt("analysis.review", {
    personalContext,
    reflectionData: JSON.stringify(reflectionData),
    evidenceLevel
  });
}

export function experimentPayload(input = {}) {
  const hypothesis = safeText(input.hypothesis, 500);
  const factor = safeText(input.factor, 80);
  if (!hypothesis || !factor) return { error: "请填写假设和唯一实验因素" };
  return {
    value: {
      hypothesis,
      factor,
      outcome: ["mood", "energy", "stress", "sleep"].includes(input.outcome) ? input.outcome : "mood",
      duration: [14, 30, 60].includes(Number(input.duration)) ? Number(input.duration) : 30,
      status: "active"
    }
  };
}

export function customMetricPayload(input = {}) {
  const name = safeText(input.name, 40);
  if (!name) return { error: "请填写指标名" };
  return {
    value: {
      name,
      low: safeText(input.low, 60) || "很低",
      high: safeText(input.high, 60) || "很高"
    }
  };
}

export function createReviewRecords({
  repository,
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID()
}) {
  if (!repository || typeof repository.read !== "function" || typeof repository.update !== "function") {
    throw new TypeError("Review records require a repository with read() and update()");
  }

  async function list(collection, options, includeVersion) {
    const page = pageOf(readData(await repository.read())[collection], options);
    if (page.invalidCursor || !includeVersion) return clone(page);
    return { ...page, items: page.items.map(versioned) };
  }

  async function get(collection, id, includeVersion) {
    const item = readData(await repository.read())[collection].find(entry => entry.id === id) || null;
    return clone(includeVersion ? versioned(item) : item);
  }

  async function findRequest(collection, type, clientRequestId, requestHash) {
    if (!clientRequestId) return null;
    const item = priorRequest(readData(await repository.read()), collection, type, clientRequestId);
    if (!item) return null;
    return item.requestHash === requestHash
      ? { value: clone(versioned(item)), duplicate: true }
      : { conflict: true };
  }

  function createRecordInStore(document, collection, type, value, {
    clientRequestId = "",
    requestHash = clientRequestId ? digest(value) : "",
    insert = "unshift"
  } = {}) {
    const data = readData(document);
    if (clientRequestId) {
      const duplicate = priorRequest(data, collection, type, clientRequestId);
      if (duplicate) {
        return duplicate.requestHash === requestHash
          ? { value: clone(versioned(duplicate)), duplicate: true }
          : { conflict: true };
      }
    }
    const entry = {
      id: createId(),
      createdAt: now(),
      ...value,
      ...(clientRequestId ? { version: 1, clientRequestId, requestHash } : {})
    };
    data[collection][insert](entry);
    return { value: clone(entry), duplicate: false };
  }

  function createRecord(collection, type, value, options = {}) {
    return repository.update((document, trash) => {
      return createRecordInStore(
        { ...document, trash: trash ?? document?.trash },
        collection,
        type,
        value,
        options
      );
    });
  }

  const hasPersistentIdempotency = (
    typeof repository.executeIdempotent === "function"
  );

  async function createIdempotentRecord(collection, type, value, {
    clientRequestId,
    requestHash = digest(value),
    insert = "unshift"
  }) {
    const request = { scope: `${collection}.create`, key: clientRequestId, requestHash };
    try {
      let executed = false;
      const response = await repository.executeIdempotent(request, (document, trash) => {
        executed = true;
        const result = createRecordInStore(
          { ...document, trash: trash ?? document?.trash },
          collection,
          type,
          value,
          { clientRequestId, requestHash, insert }
        );
        if (result.conflict) throw idempotencyConflict();
        return result;
      });
      return executed ? response : { ...clone(response), duplicate: true };
    } catch (error) {
      if (error?.code === "IDEMPOTENCY_KEY_REUSED") return { conflict: true };
      throw error;
    }
  }

  return {
    listAnalyses: (options, config = {}) => list("analyses", options, config.includeVersion === true),
    getAnalysis: (id, config = {}) => get("analyses", id, config.includeVersion === true),
    listExperiments: (options, config = {}) => list("experiments", options, config.includeVersion === true),
    getExperiment: (id, config = {}) => get("experiments", id, config.includeVersion === true),
    listCustomMetrics: (options, config = {}) => list("customMetrics", options, config.includeVersion === true),
    getCustomMetric: (id, config = {}) => get("customMetrics", id, config.includeVersion === true),

    findAnalysisRequest(clientRequestId, requestHash) {
      return findRequest("analyses", "analysis", clientRequestId, requestHash);
    },

    saveAnalysis(input, { clientRequestId = "", requestHash = "" } = {}) {
      const value = {
        reason: input.reason,
        content: input.content,
        annotations: [],
        annotationDrift: [],
        ...(input.reasoningContent ? { reasoningContent: input.reasoningContent } : {}),
        ...(input.contextReceipt ? { contextReceipt: clone(input.contextReceipt) } : {})
      };
      if (clientRequestId && hasPersistentIdempotency) {
        return createIdempotentRecord("analyses", "analysis", value, {
          clientRequestId,
          requestHash
        });
      }
      return createRecord("analyses", "analysis", value, { clientRequestId, requestHash });
    },

    saveAnalysisInStore(document, input, { clientRequestId = "", requestHash = "" } = {}) {
      return createRecordInStore(document, "analyses", "analysis", {
        reason: input.reason,
        content: input.content,
        annotations: [],
        annotationDrift: [],
        ...(input.reasoningContent ? { reasoningContent: input.reasoningContent } : {}),
        ...(input.contextReceipt ? { contextReceipt: clone(input.contextReceipt) } : {})
      }, { clientRequestId, requestHash });
    },

    async createExperiment(input, { clientRequestId = "" } = {}) {
      const parsed = experimentPayload(input);
      if (parsed.error) return parsed;
      if (clientRequestId && hasPersistentIdempotency) {
        return createIdempotentRecord("experiments", "experiment", parsed.value, {
          clientRequestId
        });
      }
      return createRecord("experiments", "experiment", parsed.value, { clientRequestId });
    },

    async createCustomMetric(input, { clientRequestId = "" } = {}) {
      const parsed = customMetricPayload(input);
      if (parsed.error) return parsed;
      if (clientRequestId && hasPersistentIdempotency) {
        return createIdempotentRecord("customMetrics", "customMetric", parsed.value, {
          clientRequestId,
          insert: "push"
        });
      }
      return createRecord("customMetrics", "customMetric", parsed.value, {
        clientRequestId,
        insert: "push"
      });
    }
  };
}
