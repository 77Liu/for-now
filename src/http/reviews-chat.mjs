import { CORE_MODEL_NOT_READY_CODE } from "../shared/core-model-gate.mjs";
import { safeText } from "../shared/validation/index.mjs";
import {
  sendPersonalizedTaskLegacy,
  sendPersonalizedTaskV1
} from "./ai-task-responses.mjs";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

export function createReviewsChatHttp({
  chatRecords,
  reviewRecords,
  workflows,
  statistics,
  remove,
  eventTimeFields,
  bodyJson,
  sendJson,
  sendTrashResult,
  canAccessOwner = () => true
}) {
  const rangeInput = url => ({
    ...(url.searchParams.has("from") ? { from: url.searchParams.get("from") } : {}),
    ...(url.searchParams.has("to") ? { to: url.searchParams.get("to") } : {})
  });
  const eventTimeHash = (input, eventTime) => hasOwn(input, "occurredAt")
    ? eventTime.occurredAt
    : hasOwn(input, "occurredOn") ? `date:${input.occurredOn}` : "";

  async function listV1(res, url, v1, load) {
    const page = await load(v1.pagination(url), { includeVersion: true });
    if (page.invalidCursor) return v1.error(res, 400, "游标无效或已过期", "INVALID_CURSOR");
    return v1.success(res, 200, page.items, {
      meta: { nextCursor: v1.nextCursor(page.nextId) }
    });
  }

  async function getV1(res, v1, id, load, missingMessage, missingCode) {
    const item = await load(id, { includeVersion: true });
    return item
      ? v1.success(res, 200, item, { etag: v1.versionEtag(item.version) })
      : v1.error(res, 404, missingMessage, missingCode);
  }

  function mutationV1(res, v1, result) {
    if (result?.missing) {
      return v1.error(res, 404, "这次复盘不存在", "ANALYSIS_NOT_FOUND");
    }
    if (result?.versionConflict) {
      return v1.error(
        res,
        412,
        "复盘状态已变化，请重新读取后再提交",
        "PRECONDITION_FAILED",
        { currentVersion: result.currentVersion }
      );
    }
    if (result?.invalidState) {
      return v1.error(res, 409, "这份复盘已经处理", "ANALYSIS_STATE_CONFLICT", {
        currentStatus: result.currentStatus
      });
    }
    if (result?.error) return v1.error(res, 422, result.error, "ANALYSIS_REVIEW_INVALID");
    return v1.success(res, 200, result.value, {
      etag: v1.versionEtag(result.value.version)
    });
  }

  async function removeV1(res, v1, {
    collection,
    type,
    id,
    expectedVersion,
    missingMessage,
    missingCode
  }) {
    const result = await remove(collection, type, id, expectedVersion);
    if (result?.versionConflict) {
      return v1.error(
        res,
        412,
        "资源版本已变化，请重新读取后再提交",
        "PRECONDITION_FAILED",
        { currentVersion: result.currentVersion }
      );
    }
    if (!result || result.missing) return v1.error(res, 404, missingMessage, missingCode);
    const entry = result.value || result;
    return v1.success(res, 200, { trashId: entry.id || entry.trashId });
  }

  async function handleV1(req, res, url, v1) {
    if (req.method === "GET" && url.pathname === "/api/v1/statistics") {
      const result = await statistics.dashboard(rangeInput(url), { includeOwner: canAccessOwner() });
      return result.error
        ? v1.error(res, 400, result.error, result.code)
        : v1.success(res, 200, result.value);
    }

    if (req.method === "GET" && url.pathname === "/api/v1/chats") {
      return listV1(res, url, v1, chatRecords.list);
    }
    if (req.method === "POST" && url.pathname === "/api/v1/chats") {
      const input = await bodyJson(req);
      const eventTime = eventTimeFields(input);
      const waiting = await workflows.queueChatIfCold({
        message: input.message,
        eventTime,
        eventTimeHash: eventTime ? eventTimeHash(input, eventTime) : "",
        clientRequestId: v1.idempotencyKey(req)
      });
      if (waiting) return sendPersonalizedTaskV1(res, v1, waiting);
      let result;
      try {
        result = await workflows.answerChat({
          message: input.message,
          eventTime,
          eventTimeHash: eventTime ? eventTimeHash(input, eventTime) : "",
          clientRequestId: v1.idempotencyKey(req)
        });
      } catch (error) {
        if (error?.code === CORE_MODEL_NOT_READY_CODE) {
          return v1.error(res, error.statusCode, error.message, error.code, error.details);
        }
        throw error;
      }
      if (result.error) return v1.error(res, 400, result.error, "VALIDATION_ERROR");
      if (result.conflict) return v1.error(res, 409, "同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED");
      return v1.success(res, result.duplicate ? 200 : 201, result.value, {
        etag: v1.versionEtag(result.value.version)
      });
    }
    if (req.method === "GET" && /^\/api\/v1\/chats\/[^/]+$/.test(url.pathname)) {
      return getV1(
        res,
        v1,
        url.pathname.split("/")[4],
        chatRecords.get,
        "这段对话不存在",
        "CHAT_NOT_FOUND"
      );
    }
    if (req.method === "DELETE" && /^\/api\/v1\/chats\/[^/]+$/.test(url.pathname)) {
      return removeV1(res, v1, {
        collection: "chats",
        type: "chat",
        id: url.pathname.split("/")[4],
        expectedVersion: v1.expectedVersion(req),
        missingMessage: "这段对话不存在",
        missingCode: "CHAT_NOT_FOUND"
      });
    }

    if (req.method === "GET" && url.pathname === "/api/v1/analyses") {
      return listV1(res, url, v1, reviewRecords.listAnalyses);
    }
    if (req.method === "POST" && url.pathname === "/api/v1/analyses") {
      try {
        await bodyJson(req);
        const waiting = await workflows.queueAnalysisIfCold({
          reason: "manual",
          clientRequestId: v1.idempotencyKey(req)
        });
        if (waiting) return sendPersonalizedTaskV1(res, v1, waiting);
        const result = await workflows.runAnalysis({
          reason: "manual",
          clientRequestId: v1.idempotencyKey(req)
        });
        if (result.conflict) return v1.error(res, 409, "同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED");
        return v1.success(res, result.duplicate ? 200 : 201, result.value, {
          etag: v1.versionEtag(result.value.version)
        });
      } catch (error) {
        if (error?.code === CORE_MODEL_NOT_READY_CODE) {
          return v1.error(res, error.statusCode, error.message, error.code, error.details);
        }
        if (error.message === "先留下一条状态、健康、捕念、日记或思绪记录，再开始认知复盘") {
          return v1.error(res, 400, error.message, "REVIEW_EVIDENCE_REQUIRED");
        }
        throw error;
      }
    }
    if (req.method === "GET" && /^\/api\/v1\/analyses\/[^/]+$/.test(url.pathname)) {
      return getV1(
        res,
        v1,
        url.pathname.split("/")[4],
        reviewRecords.getAnalysis,
        "这次复盘不存在",
        "ANALYSIS_NOT_FOUND"
      );
    }
    if (req.method === "PATCH" && /^\/api\/v1\/analyses\/[^/]+$/.test(url.pathname)) {
      const result = await reviewRecords.reviewAnalysis(
        url.pathname.split("/")[4],
        await bodyJson(req),
        { expectedVersion: v1.expectedVersion(req) }
      );
      return mutationV1(res, v1, result);
    }
    if (req.method === "DELETE" && /^\/api\/v1\/analyses\/[^/]+$/.test(url.pathname)) {
      return removeV1(res, v1, {
        collection: "analyses",
        type: "analysis",
        id: url.pathname.split("/")[4],
        expectedVersion: v1.expectedVersion(req),
        missingMessage: "这次复盘不存在",
        missingCode: "ANALYSIS_NOT_FOUND"
      });
    }

    if (req.method === "GET" && url.pathname === "/api/v1/experiments") {
      return listV1(res, url, v1, reviewRecords.listExperiments);
    }
    if (req.method === "POST" && url.pathname === "/api/v1/experiments") {
      const result = await reviewRecords.createExperiment(await bodyJson(req), {
        clientRequestId: v1.idempotencyKey(req)
      });
      if (result.error) return v1.error(res, 400, result.error, "VALIDATION_ERROR");
      if (result.conflict) return v1.error(res, 409, "同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED");
      return v1.success(res, result.duplicate ? 200 : 201, result.value, {
        etag: v1.versionEtag(result.value.version)
      });
    }
    if (req.method === "GET" && /^\/api\/v1\/experiments\/[^/]+$/.test(url.pathname)) {
      return getV1(
        res,
        v1,
        url.pathname.split("/")[4],
        reviewRecords.getExperiment,
        "这个实验不存在",
        "EXPERIMENT_NOT_FOUND"
      );
    }
    if (req.method === "DELETE" && /^\/api\/v1\/experiments\/[^/]+$/.test(url.pathname)) {
      return removeV1(res, v1, {
        collection: "experiments",
        type: "experiment",
        id: url.pathname.split("/")[4],
        expectedVersion: v1.expectedVersion(req),
        missingMessage: "这个实验不存在",
        missingCode: "EXPERIMENT_NOT_FOUND"
      });
    }

    if (req.method === "GET" && url.pathname === "/api/v1/custom-metrics") {
      return listV1(res, url, v1, reviewRecords.listCustomMetrics);
    }
    if (req.method === "POST" && url.pathname === "/api/v1/custom-metrics") {
      const result = await reviewRecords.createCustomMetric(await bodyJson(req), {
        clientRequestId: v1.idempotencyKey(req)
      });
      if (result.error) return v1.error(res, 400, result.error, "VALIDATION_ERROR");
      if (result.conflict) return v1.error(res, 409, "同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED");
      return v1.success(res, result.duplicate ? 200 : 201, result.value, {
        etag: v1.versionEtag(result.value.version)
      });
    }
    if (req.method === "GET" && /^\/api\/v1\/custom-metrics\/[^/]+$/.test(url.pathname)) {
      return getV1(
        res,
        v1,
        url.pathname.split("/")[4],
        reviewRecords.getCustomMetric,
        "这个自定义指标不存在",
        "CUSTOM_METRIC_NOT_FOUND"
      );
    }
    if (req.method === "DELETE" && /^\/api\/v1\/custom-metrics\/[^/]+$/.test(url.pathname)) {
      return removeV1(res, v1, {
        collection: "customMetrics",
        type: "customMetric",
        id: url.pathname.split("/")[4],
        expectedVersion: v1.expectedVersion(req),
        missingMessage: "这个自定义指标不存在",
        missingCode: "CUSTOM_METRIC_NOT_FOUND"
      });
    }
    return false;
  }

  async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/statistics") {
      const result = await statistics.dashboard(rangeInput(url), { includeOwner: canAccessOwner() });
      if (result.error) sendJson(res, 400, { error: result.error });
      else sendJson(res, 200, result.value);
    } else if (req.method === "POST" && url.pathname === "/api/chat") {
      const input = await bodyJson(req);
      const eventTime = eventTimeFields(input);
      const clientRequestId = safeText(input.clientRequestId, 100)
        || safeText(req.headers?.["idempotency-key"] ?? req.headers?.get?.("idempotency-key"), 100);
      const waiting = await workflows.queueChatIfCold({
        message: input.message,
        eventTime,
        eventTimeHash: eventTime ? eventTimeHash(input, eventTime) : "",
        clientRequestId
      });
      if (waiting) return sendPersonalizedTaskLegacy(res, sendJson, waiting);
      const result = await workflows.answerChat({
        message: input.message,
        eventTime,
        eventTimeHash: eventTime ? eventTimeHash(input, eventTime) : "",
        clientRequestId
      });
      if (result.error) sendJson(res, 400, { error: result.error });
      else sendJson(res, 200, result.value);
    } else if (req.method === "DELETE" && /^\/api\/chats\/[^/]+$/.test(url.pathname)) {
      await sendTrashResult(
        res,
        await remove("chats", "chat", url.pathname.split("/")[3]),
        "这段对话不存在"
      );
    } else if (req.method === "POST" && url.pathname === "/api/analysis/run") {
      const input = await bodyJson(req);
      const clientRequestId = safeText(input.clientRequestId, 100)
        || safeText(req.headers?.["idempotency-key"] ?? req.headers?.get?.("idempotency-key"), 100);
      const waiting = await workflows.queueAnalysisIfCold({ reason: "manual", clientRequestId });
      if (waiting) return sendPersonalizedTaskLegacy(res, sendJson, waiting);
      sendJson(res, 201, (await workflows.runAnalysis({ reason: "manual", clientRequestId })).value);
    } else if (req.method === "DELETE" && /^\/api\/analyses\/[^/]+$/.test(url.pathname)) {
      await sendTrashResult(
        res,
        await remove("analyses", "analysis", url.pathname.split("/")[3]),
        "这次复盘不存在"
      );
    } else if (req.method === "POST" && url.pathname === "/api/custom-metrics") {
      const result = await reviewRecords.createCustomMetric(await bodyJson(req));
      if (result.error) sendJson(res, 400, { error: result.error });
      else sendJson(res, 201, result.value);
    } else if (req.method === "POST" && url.pathname === "/api/experiments") {
      const result = await reviewRecords.createExperiment(await bodyJson(req));
      if (result.error) sendJson(res, 400, { error: result.error });
      else sendJson(res, 201, result.value);
    } else if (req.method === "DELETE" && /^\/api\/experiments\/[^/]+$/.test(url.pathname)) {
      await sendTrashResult(
        res,
        await remove("experiments", "experiment", url.pathname.split("/")[3]),
        "这个实验不存在"
      );
    } else if (req.method === "DELETE" && /^\/api\/custom-metrics\/[^/]+$/.test(url.pathname)) {
      await sendTrashResult(
        res,
        await remove("customMetrics", "customMetric", url.pathname.split("/")[3]),
        "这个自定义指标不存在"
      );
    } else return false;
    return true;
  }

  return { handle, handleV1 };
}
