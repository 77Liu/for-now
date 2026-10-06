const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
  "location",
  "x-accel-buffering",
  "x-request-id"
];

export function createUpstreamProxy({
  origin,
  maxBodyBytes,
  uploadMaxBodyBytes,
  sendJson,
  getTraceId,
  upstreamCookie,
  rewriteResponse,
  fetchImpl = globalThis.fetch
}) {
  for (const [name, dependency] of Object.entries({
    sendJson,
    getTraceId,
    upstreamCookie,
    rewriteResponse,
    fetchImpl
  })) {
    if (typeof dependency !== "function") throw new TypeError(`Upstream proxy requires ${name}()`);
  }
  return async function proxyToUpstream(req, res, url) {
    const chunks = [];
    const bodyLimit = ["/api/images/upload", "/api/audio/upload"].includes(url.pathname)
      ? uploadMaxBodyBytes
      : maxBodyBytes;
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > bodyLimit) {
        return sendJson(res, 413, { error: "内容过长", code: "BODY_TOO_LARGE" });
      }
      chunks.push(chunk);
    }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = {};
    for (const name of ["accept", "content-type", "user-agent", "range", "if-range"]) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    const cookie = upstreamCookie(req);
    if (cookie) headers.cookie = cookie;
    headers["x-request-id"] = getTraceId();
    const response = await fetchImpl(`${origin}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body,
      redirect: "manual"
    });
    const responseHeaders = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    const cookies = response.headers.getSetCookie?.()
      || (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);
    const rewritten = await rewriteResponse({
      request: req,
      pathname: url.pathname,
      upstreamResponse: response,
      cookies,
      responseHeaders
    });
    if (!rewritten && cookies.length) responseHeaders["set-cookie"] = cookies;
    res.writeHead(response.status, responseHeaders);
    if (!response.body) return res.end();
    for await (const chunk of response.body) {
      if (!res.write(Buffer.from(chunk))) {
        await new Promise(resolve => res.once("drain", resolve));
      }
    }
    res.end();
  };
}
