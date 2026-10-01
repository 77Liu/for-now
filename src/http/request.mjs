import crypto from "node:crypto";
import { errorMetadata, redact } from "../shared/observability/index.mjs";
import { safeText } from "../shared/validation/index.mjs";

export function createRequestHandler({ requestContext, rootDir, basePath, logEvent, sendJson, sendError = sendJson, isStorageError, handle }) {
  return (req, res) => {
    const suppliedTraceId = safeText(req.headers["x-request-id"], 128);
    const traceId = /^[A-Za-z0-9_.:-]{8,128}$/.test(suppliedTraceId) ? suppliedTraceId : crypto.randomUUID();
    const context = {
      traceId,
      method: req.method,
      route: "",
      resource: "",
      contentType: String(req.headers["content-type"] || "").toLowerCase(),
      ifMatch: String(req.headers["if-match"] || ""),
      requestBodySha256: crypto.createHash("sha256").update("").digest("hex"),
      secrets: []
    };
    const started = Date.now();
    return requestContext.run(context, async () => {
      try {
        res.setHeader("x-request-id", traceId);
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("x-frame-options", "DENY");
        res.setHeader("referrer-policy", "same-origin");
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        if (basePath !== "/" && url.pathname === basePath) {
          res.writeHead(308, { location: `${basePath}/${url.search}` });
          return res.end();
        }
        if (basePath !== "/" && url.pathname.startsWith(`${basePath}/`)) {
          url.pathname = url.pathname.slice(basePath.length) || "/";
        }
        context.route = safeText(url.pathname, 400);
        context.resource = safeText(`${url.pathname}${url.search}`, 500);
        context.apiVersion = url.pathname.startsWith("/api/v1/") ? "v1" : "";
        return await handle(req, res, url, context);
      } catch (error) {
        if (error.code === "ENOENT") return sendError(res, 404, { error: "Not found", code: "NOT_FOUND" }, context);
        context.errorCode = errorMetadata(error).code;
        context.applicationStatus = error.statusCode || 500;
        await logEvent("system", "request.failed", { level: context.applicationStatus >= 500 ? "error" : "warn", error: errorMetadata(error) });
        const databaseError = isStorageError(error);
        if (!res.headersSent && !res.destroyed) sendError(res, context.applicationStatus, {
          error: databaseError ? "数据服务暂时不可用，请稍后重试" : redact(error.message || "服务暂时不可用", context.secrets),
          code: databaseError ? "STORAGE_UNAVAILABLE" : context.errorCode,
          ...(error.details ? { details: error.details } : {})
        }, context);
        else if (!res.writableEnded) res.end();
      } finally {
        if (context.route.startsWith("/api/") || context.errorCode) {
          const status = context.applicationStatus || res.statusCode;
          const fields = {
            level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
            statusCode: status, httpStatus: res.statusCode, durationMs: Date.now() - started,
            result: status >= 400 ? "failed" : res.destroyed && !res.writableFinished ? "disconnected" : "success",
            errorCode: context.errorCode || "", changeCount: context.changeCount || 0,
            clientOperationId: context.clientOperationId || ""
          };
          await logEvent("system", "request.completed", fields);
          if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
            await logEvent("operation", "request.completed", { ...fields, action: `${req.method} ${context.route}`, resourceType: context.route.split("/")[2] || "", resourceId: context.route.split("/")[3] || "" });
          }
        }
      }
    });
  };
}
