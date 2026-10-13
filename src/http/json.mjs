import crypto from "node:crypto";

export const wantsEventStream = req => String(req.headers.accept || "").includes("text/event-stream");

export function sendStreamEvent(res, value) {
  if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(value)}\n\n`);
}

export function createJsonHttp({ getContext, maxBodyBytes, projectResponse = value => value }) {
  return {
    sendJson(res, status, value) {
      const context = getContext();
      if (context) {
        context.applicationStatus = status;
        if (status >= 400) context.errorCode ||= String(value?.code ?? "").trim().slice(0, 100) || `HTTP_${status}`;
      }
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(projectResponse(value)));
    },
    async bodyJson(req, maxBytes = maxBodyBytes) {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw Object.assign(new Error("内容过长"), { statusCode: 413, code: "BODY_TOO_LARGE" });
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      let value;
      try { value = raw ? JSON.parse(raw) : {}; }
      catch { throw Object.assign(new Error("请求内容不是有效 JSON"), { statusCode: 400, code: "INVALID_JSON" }); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("请求内容必须是对象"), { statusCode: 400, code: "INVALID_BODY" });
      const context = getContext();
      if (context) {
        context.requestBytes = bytes;
        context.requestBodySha256 = crypto.createHash("sha256").update(raw).digest("hex");
        for (const key of ["apiKey", "password", "currentPassword", "newPassword", "invitation"]) if (typeof value[key] === "string" && value[key]) context.secrets.push(value[key]);
      }
      return value;
    }
  };
}
