import crypto from "node:crypto";

export const API_V1_PREFIX = "/api/v1";

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const operationFingerprint = context => sha256(JSON.stringify({
  method: String(context?.method || "").toUpperCase(),
  resource: String(context?.resource || ""),
  contentType: String(context?.contentType || "").toLowerCase(),
  ifMatch: String(context?.ifMatch || ""),
  requestBodySha256: String(context?.requestBodySha256 || sha256(""))
}));
const operationFingerprintDetails = (reason, context = {}) => {
  const suppliedVersion = String(context.clientContractVersion || "");
  return {
    reason,
    clientContractVersion: /^[A-Za-z0-9_.:-]{1,32}$/.test(suppliedVersion)
      ? suppliedVersion
      : "legacy"
  };
};
const problem = (message, code, statusCode, details) => Object.assign(new Error(message), {
  code,
  statusCode,
  ...(details ? { details } : {})
});

export const versionEtag = version => `"${Math.max(1, Math.round(Number(version) || 1))}"`;

export function encodeCursor(afterId) {
  return Buffer.from(JSON.stringify({ v: 1, after: afterId }), "utf8").toString("base64url");
}

export function decodeCursor(value, { maxLength = 100 } = {}) {
  if (!value) return "";
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (decoded?.v !== 1 || typeof decoded.after !== "string" || !decoded.after || decoded.after.length > maxLength) throw new Error();
    return decoded.after;
  } catch {
    throw problem("游标无效或已过期", "INVALID_CURSOR", 400);
  }
}

export function createApiV1Http({ sendJson, getContext, openApi }) {
  const handlers = new Map();
  const metadata = extra => ({ traceId: getContext()?.traceId || "", ...extra });
  const envelope = (data, meta = {}) => ({ data, error: null, meta: metadata(meta) });
  const errorEnvelope = (message, code, details) => ({
    data: null,
    error: { code: code || "INTERNAL_ERROR", message, ...(details ? { details } : {}) },
    meta: metadata()
  });
  const fingerprintProblem = (message, reason) => problem(
    message,
    "INVALID_OPERATION_FINGERPRINT",
    400,
    operationFingerprintDetails(reason, getContext())
  );

  const api = {
    versionEtag,

    register(id, handler) {
      if (!id || typeof handler !== "function" || handlers.has(id)) throw new Error(`Invalid or duplicate v1 handler: ${id}`);
      handlers.set(id, handler);
    },

    success(res, status, data, { etag = "", meta = {} } = {}) {
      const context = getContext();
      const operationId = context?.clientOperationId || "";
      const operation = operationId && !["GET", "HEAD"].includes(context?.method)
        ? { operation: { id: operationId, status: "committed" } }
        : {};
      if (etag) res.setHeader("etag", etag);
      if (operationId && operation.operation) res.setHeader("x-client-operation-id", operationId);
      return sendJson(res, status, envelope(data, { ...meta, ...operation }));
    },

    error(res, status, message, code, details) {
      const context = getContext();
      if (context) context.errorCode ||= code || `HTTP_${status}`;
      return sendJson(res, status, errorEnvelope(message, code, details));
    },

    envelope,
    errorEnvelope: error => errorEnvelope(error.message || "服务暂时不可用", error.code, error.details),

    operationFingerprintErrorDetails(reason) {
      return operationFingerprintDetails(reason, getContext());
    },

    validateOperationFingerprint() {
      const context = getContext();
      const supplied = String(context?.clientOperationFingerprint || "");
      if (supplied && supplied !== operationFingerprint(context)) {
        throw fingerprintProblem("客户端操作指纹与请求不一致", "canonical-mismatch");
      }
    },

    idempotencyKey(req) {
      const key = String(req.headers["idempotency-key"] || "").trim();
      if (!key) throw problem("写请求缺少 Idempotency-Key", "IDEMPOTENCY_KEY_REQUIRED", 400);
      if (key.length > 100) throw problem("Idempotency-Key 最长 100 个字符", "INVALID_IDEMPOTENCY_KEY", 400);
      if (Number.isSafeInteger(getContext()?.requestBytes)) api.validateOperationFingerprint();
      return key;
    },

    expectedVersion(req) {
      const value = String(req.headers["if-match"] || "").trim();
      if (!value) throw problem("更新请求缺少 If-Match", "PRECONDITION_REQUIRED", 428);
      const match = value.match(/^(?:W\/)?"([1-9]\d*)"$/);
      if (!match) throw problem("If-Match 必须使用响应中的 ETag", "INVALID_IF_MATCH", 400);
      const version = Number(match[1]);
      if (!Number.isSafeInteger(version)) throw problem("If-Match 版本超出支持范围", "INVALID_IF_MATCH", 400);
      return version;
    },

    pagination(url, { defaultLimit = 20, maxLimit = 100, maxCursorLength = 100 } = {}) {
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit == null || rawLimit === "" ? defaultLimit : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
        throw problem(`limit 必须是 1 到 ${maxLimit} 的整数`, "INVALID_PAGINATION", 400);
      }
      return { limit, afterId: decodeCursor(url.searchParams.get("cursor") || "", { maxLength: maxCursorLength }) };
    },

    nextCursor(afterId) {
      return afterId ? encodeCursor(afterId) : null;
    },

    async handle(req, res, url) {
      if (req.method === "GET" && url.pathname === `${API_V1_PREFIX}/openapi.json`) {
        sendJson(res, 200, openApi);
        return true;
      }
      const operationId = String(req.headers["x-client-operation-id"] || "").trim();
      const operationFingerprint = String(req.headers["x-client-operation-fingerprint"] || "").trim();
      const context = getContext();
      if (context) {
        context.clientContractVersion = String(req.headers["x-client-contract-version"] || "").trim();
      }
      if (operationId) {
        if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(operationId)) {
          throw problem("X-Client-Operation-Id 格式无效", "INVALID_CLIENT_OPERATION_ID", 400);
        }
        if (operationFingerprint && !/^[a-f0-9]{64}$/.test(operationFingerprint)) {
          throw fingerprintProblem("X-Client-Operation-Fingerprint 格式无效", "format");
        }
        if (context) {
          context.clientOperationId = operationId;
          context.clientOperationFingerprint = operationFingerprint;
        }
      } else if (operationFingerprint) {
        throw fingerprintProblem("操作指纹缺少 X-Client-Operation-Id", "missing-id");
      }
      for (const handler of handlers.values()) {
        if (await handler(req, res, url, api) || res.headersSent || res.writableEnded) return true;
      }
      return false;
    }
  };
  return api;
}
