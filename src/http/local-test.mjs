import crypto from "node:crypto";
import { safeText } from "../shared/validation/index.mjs";

const fail = (statusCode, message, code) => {
  throw Object.assign(new Error(message), { statusCode, code });
};

const requestCookie = (request, name) => String(request.headers.cookie || "")
  .split(";")
  .map(part => part.trim())
  .find(part => part.startsWith(`${name}=`))
  ?.slice(name.length + 1) || "";

export function createLocalTestSessionVault({
  enabled,
  cookieName = "for_now_local_test_session",
  maxAgeSeconds = 30 * 60,
  maxSessions = 128,
  currentTime = Date.now,
  createToken = () => crypto.randomBytes(32).toString("base64url")
} = {}) {
  const sessions = new Map();
  const get = request => {
    if (!enabled) return null;
    let token = "";
    try {
      token = decodeURIComponent(requestCookie(request, cookieName));
    } catch {
      return null;
    }
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= currentTime()) {
      sessions.delete(token);
      return null;
    }
    return { token, ...session };
  };
  const store = (token, cookie, user = null) => {
    const time = currentTime();
    for (const [key, session] of sessions) {
      if (session.expiresAt <= time) sessions.delete(key);
    }
    while (sessions.size >= maxSessions) {
      sessions.delete(sessions.keys().next().value);
    }
    const key = token || createToken();
    sessions.set(key, {
      cookie,
      user: user && typeof user === "object" ? {
        id: safeText(user.id, 100),
        username: safeText(user.username, 100),
        role: user.role === "owner" ? "owner" : "user"
      } : null,
      expiresAt: time + maxAgeSeconds * 1000
    });
    return key;
  };
  const remove = token => sessions.delete(token);

  return Object.freeze({
    enabled: Boolean(enabled),
    cookieName,
    maxAgeSeconds,
    get,
    store,
    remove,
    upstreamCookie: request => enabled
      ? get(request)?.cookie || ""
      : String(request.headers.cookie || "")
  });
}

export function createReadOnlyUpstream({
  origin,
  sessions,
  requestStorage,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  randomId = () => crypto.randomUUID()
}) {
  const json = async (request, pathname) => {
    if (!origin) {
      fail(503, "尚未配置线上只读数据源", "LOCAL_TEST_UPSTREAM_MISSING");
    }
    const headers = {
      accept: "application/json",
      "x-request-id": requestStorage.getStore()?.traceId || randomId()
    };
    if (request.headers["user-agent"]) headers["user-agent"] = request.headers["user-agent"];
    const cookie = sessions.upstreamCookie(request);
    if (cookie) headers.cookie = cookie;
    let response;
    try {
      response = await fetchImpl(`${origin}${pathname}`, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (["AbortError", "TimeoutError"].includes(error?.name)) {
        fail(
          504,
          `线上数据读取超过 ${Math.round(timeoutMs / 1000)} 秒，请检查网络后重试`,
          "LOCAL_TEST_UPSTREAM_TIMEOUT"
        );
      }
      throw error;
    }
    let value = {};
    try {
      value = await response.json();
    } catch {}
    if (!response.ok) {
      fail(
        response.status,
        response.status === 401
          ? "请先登录线上主账户"
          : safeText(value.error, 300) || "线上数据读取失败",
        response.status === 401 ? "AUTH_REQUIRED" : "LOCAL_TEST_UPSTREAM_FAILED"
      );
    }
    return value;
  };

  const list = async (request, pathname) => {
    const items = [];
    const seen = new Set();
    let cursor = "";
    do {
      const separator = pathname.includes("?") ? "&" : "?";
      const result = await json(
        request,
        `${pathname}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      );
      if (result?.error) {
        fail(
          502,
          result.error.message || "线上记录读取失败",
          result.error.code || "LOCAL_TEST_UPSTREAM_FAILED"
        );
      }
      items.push(...(Array.isArray(result?.data) ? result.data : []));
      cursor = safeText(result?.meta?.nextCursor, 100);
      if (cursor && seen.has(cursor)) {
        fail(502, "线上记录游标没有前进", "LOCAL_TEST_UPSTREAM_CURSOR_STALLED");
      }
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  };

  return Object.freeze({ json, list });
}

export function createLocalTestHttp({
  runtime,
  sessions,
  basePath,
  sendJson,
  bodyJson,
  bindUser,
  proxyToUpstream
}) {
  const cookiePath = basePath === "/" ? "/" : basePath;
  const authentication = request => ({
    user: sessions.get(request)?.user || null,
    reauthRequired: false
  });
  const handle = async (request, response, url) => {
    if (!runtime.enabled) return false;
    if (url.pathname === "/api/local-test-mode/hydrate" && request.method === "POST") {
      bindUser(runtime.requireOwner(request).user);
      const input = await bodyJson(request);
      const result = await runtime.hydrateScope(request, safeText(input.scope, 40));
      sendJson(response, 200, {
        control: runtime.publicControl(result.control),
        state: result.state,
        hydrated: result.hydrated
      });
      return true;
    }
    if (url.pathname === "/api/local-test-mode") {
      bindUser(runtime.requireOwner(request).user);
      if (request.method === "GET") {
        sendJson(response, 200, runtime.publicControl(await runtime.readControl()));
        return true;
      }
      if (request.method === "POST") {
        const input = await bodyJson(request);
        const control = await runtime.switchMode(request, safeText(input.mode, 40));
        sendJson(response, 200, runtime.publicControl(control));
        return true;
      }
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    if (runtime.upstreamConfigured && url.pathname.startsWith("/api/auth/")) {
      const allowed = (
        request.method === "GET"
        && url.pathname === "/api/auth/me"
      ) || (
        request.method === "POST"
        && ["/api/auth/login", "/api/auth/logout"].includes(url.pathname)
      );
      if (allowed) await proxyToUpstream(request, response, url);
      else {
        sendJson(response, 403, {
          error: "本地测试版禁止修改线上账户",
          code: "LOCAL_TEST_READ_ONLY"
        });
      }
      return true;
    }
    return false;
  };

  const rewriteProxyResponse = async ({
    request,
    pathname,
    upstreamResponse,
    cookies,
    responseHeaders
  }) => {
    if (!runtime.enabled) return false;
    const localSession = sessions.get(request);
    let upstreamUser = localSession?.user || null;
    if (
      upstreamResponse.ok
      && ["/api/auth/login", "/api/auth/me"].includes(pathname)
    ) {
      try {
        const payload = await upstreamResponse.clone().json();
        if (payload?.user?.id) upstreamUser = payload.user;
      } catch {}
    }
    if (pathname === "/api/auth/logout") {
      if (localSession) sessions.remove(localSession.token);
      responseHeaders["set-cookie"] = [
        `${sessions.cookieName}=`,
        `Path=${cookiePath}`,
        "HttpOnly",
        "SameSite=Strict",
        "Max-Age=0"
      ].join("; ");
      return true;
    }
    const upstreamCookie = cookies
      .map(cookie => cookie.split(";", 1)[0])
      .filter(Boolean)
      .join("; ");
    if (upstreamResponse.ok && upstreamCookie) {
      const token = sessions.store(localSession?.token, upstreamCookie, upstreamUser);
      responseHeaders["set-cookie"] = [
        `${sessions.cookieName}=${encodeURIComponent(token)}`,
        `Path=${cookiePath}`,
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${sessions.maxAgeSeconds}`
      ].join("; ");
    } else if (upstreamResponse.ok && localSession && upstreamUser) {
      sessions.store(localSession.token, localSession.cookie, upstreamUser);
    }
    return true;
  };

  return Object.freeze({
    prepareRequestContext: runtime.prepareRequestContext,
    authentication,
    handle,
    upstreamCookie: sessions.upstreamCookie,
    rewriteProxyResponse,
    canProxyAttachment: runtime.canProxyAttachment
  });
}
