export function createApiClient({ baseUrl, session, apiOrigin = "", onAuthRequired = () => {}, fetchImpl = globalThis.fetch }) {
  const basePath = new URL(".", baseUrl).pathname.replace(/\/$/, "");
  const origin = String(apiOrigin || "").replace(/\/+$/, "");
  let foregroundAt = 0;
  const retryAfterMs = response => {
    const value = response.headers.get("retry-after");
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
  };
  const appUrl = value => {
    if (typeof value !== "string" || !value.startsWith("/")) return value;
    if (origin) return `${origin}${value}`;
    return basePath ? `${basePath}${value}` : value;
  };
  const errorFor = (response, result, fallback) => Object.assign(new Error(result?.error?.message || result?.error || fallback), {
    status: response.status,
    code: result?.error?.code || result?.code,
    details: result?.error?.details || result?.details || null,
    requestId: response.headers.get("x-request-id"),
    retryAfterMs: retryAfterMs(response)
  });
  const networkError = message => Object.assign(new Error(message), { code: "NETWORK_ERROR", status: 0 });
  async function start(url, options, ticket, networkMessage = "无法连接服务，请确认网络连接后重试") {
    const signal = options.signal ? AbortSignal.any([ticket.signal, options.signal]) : ticket.signal;
    let response;
    const requestOptions = { ...options, signal };
    try { response = await fetchImpl(appUrl(url), requestOptions); }
    catch (error) {
      session.assertCurrent(ticket);
      if (signal.aborted) throw error;
      const method = String(options.method || "GET").toUpperCase();
      if (!["GET", "HEAD"].includes(method) || Date.now() - foregroundAt > 5000) throw networkError(networkMessage);
      await new Promise(resolve => setTimeout(resolve, 120));
      session.assertCurrent(ticket);
      try { response = await fetchImpl(appUrl(url), requestOptions); }
      catch (retryError) {
        session.assertCurrent(ticket);
        if (signal.aborted) throw retryError;
        throw networkError(networkMessage);
      }
    }
    session.assertCurrent(ticket);
    return response;
  }
  const check = (response, result, authGate, fallback) => {
    if (response.ok) return;
    const error = errorFor(response, result, fallback);
    if (authGate && error.status === 401 && ["AUTH_REQUIRED", "AUTH_REAUTH_REQUIRED"].includes(error.code)) onAuthRequired(error);
    throw error;
  };
  return {
    appUrl,
    markForeground() { foregroundAt = Date.now(); },
    async request(url, options = {}, { optional = false, authGate = true, allowUnauthorized = false, fallback = "操作失败" } = {}) {
      const ticket = session.capture();
      const response = await start(url, { ...options, headers: { "content-type": "application/json", ...options.headers } }, ticket);
      if (optional && response.status === 404) return null;
      const result = await response.json();
      session.assertCurrent(ticket);
      if (!(allowUnauthorized && response.status === 401)) check(response, result, authGate, fallback);
      return result;
    },
    async requestWithMetadata(url, options = {}, { authGate = true, fallback = "操作失败" } = {}) {
      const ticket = session.capture();
      const response = await start(url, { ...options, headers: { "content-type": "application/json", ...options.headers } }, ticket);
      const result = await response.json();
      session.assertCurrent(ticket);
      check(response, result, authGate, fallback);
      return {
        data: result,
        etag: response.headers.get("etag") || "",
        requestId: response.headers.get("x-request-id") || ""
      };
    },
    async readBlob(url) {
      const ticket = session.capture(), response = await start(url, {}, ticket);
      if (!response.ok) {
        let parsed = {};
        try { parsed = await response.json(); } catch {}
        session.assertCurrent(ticket);
        check(response, parsed, true, "图片读取失败");
      }
      const blob = await response.blob();
      session.assertCurrent(ticket);
      return blob;
    },
    async requestBlob(url, options = {}, { fallback = "媒体请求失败" } = {}) {
      const ticket = session.capture();
      const response = await start(url, options, ticket);
      if (!response.ok) {
        let parsed = {};
        try { parsed = await response.json(); } catch {}
        session.assertCurrent(ticket);
        check(response, parsed, true, fallback);
      }
      const blob = await response.blob();
      session.assertCurrent(ticket);
      return blob;
    },
    async requestStream(url, options = {}, onEvent = () => {}) {
      const ticket = session.capture();
      const response = await start(url, { ...options, headers: { "content-type": "application/json", accept: "text/event-stream", ...options.headers } }, ticket, "无法连接本地服务，请确认页面服务仍在运行后重试");
      if (!response.ok) {
        let parsed = {};
        const raw = await response.text();
        session.assertCurrent(ticket);
        try { parsed = JSON.parse(raw); } catch {}
        check(response, parsed, true, "操作失败");
      }
      if (!String(response.headers.get("content-type") || "").includes("text/event-stream")) {
        const result = await response.json();
        session.assertCurrent(ticket);
        return result;
      }
      if (!response.body) throw new Error("本地服务未返回可读取的回答流");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "", result, receivedDone = false;
      const consume = block => {
        session.assertCurrent(ticket);
        const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) return;
        const event = JSON.parse(data);
        if (event.type === "error") throw new Error(event.error?.message || event.error || "模型回答失败");
        onEvent(event);
        if (event.type === "done") { result = event.result; receivedDone = true; }
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          session.assertCurrent(ticket);
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.match(/\r?\n\r?\n/);
          while (boundary) {
            consume(buffer.slice(0, boundary.index));
            buffer = buffer.slice(boundary.index + boundary[0].length);
            boundary = buffer.match(/\r?\n\r?\n/);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) consume(buffer);
        if (!receivedDone) throw new Error("回答流意外中断，请重试");
        session.assertCurrent(ticket);
        return result;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  };
}
