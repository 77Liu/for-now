import { errorMetadata, redact } from "../shared/observability/index.mjs";
import { wantsEventStream, sendStreamEvent } from "./json.mjs";

export function createModelResponseHttp({ getContext, logEvent, sendJson }) {
  return async function respond(req, res, {
    run,
    status = 200,
    formatResult = value => value,
    formatError = error => ({
      type: "error",
      error: error.message,
      code: error.code || "MODEL_RESPONSE_FAILED"
    })
  }) {
    if (!wantsEventStream(req)) return sendJson(res, status, formatResult(await run()));
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    sendStreamEvent(res, { type: "phase", phase: "context" });
    try {
      sendStreamEvent(res, { type: "done", result: formatResult(await run(event => sendStreamEvent(res, event))) });
    } catch (error) {
      const context = getContext();
      if (context) {
        context.applicationStatus = error.statusCode || 500;
        context.errorCode = error.code || "MODEL_RESPONSE_FAILED";
      }
      await logEvent("system", "response.stream_failed", { level: "error", error: errorMetadata(error) });
      sendStreamEvent(res, formatError({
        message: redact(error.message || "模型回答失败", context?.secrets || []),
        code: error.code || "MODEL_RESPONSE_FAILED",
        details: error.details
      }, context));
    } finally {
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  };
}
