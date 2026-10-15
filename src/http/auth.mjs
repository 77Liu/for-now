/**
 * 认证接口的请求解析、结果呈现与会话 Cookie 管理。
 * 建立时间：未知
 * 状态：active
 * 边界：仅在原子提交成功后变更 Cookie；断连请求不得继续写响应。
 */
import { publicUser, SESSION_TTL_MS } from "../modules/auth/index.mjs";

const SESSION_COOKIE = "for_now_session";
const parseCookies = req => Object.fromEntries(String(req.headers.cookie || "").split(";").map(part => part.trim()).filter(Boolean).map(part => {
  const index = part.indexOf("=");
  return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
}));
const remoteAddress = req => {
  const remote = req.socket.remoteAddress || "unknown";
  const forwardedValues = String(req.headers["x-forwarded-for"] || "").split(",").map(value => value.trim()).filter(Boolean);
  const forwarded = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote) ? forwardedValues.at(-1) || "" : "";
  return forwarded || remote;
};

/**
 * 认证 HTTP 边界：传递请求取消，提交成功后才签发或清除 Cookie。
 */
export function createAuthHttp({ service, sendJson, bodyJson, authRequired, basePath, cookieSecure, bindUser }) {
  const sessionCookie = (token, maxAge = Math.floor(SESSION_TTL_MS / 1000)) =>
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=${basePath}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecure ? "; Secure" : ""}`;
  const requestToken = req => authRequired ? parseCookies(req)[SESSION_COOKIE] : undefined;
  const requestAuthentication = async req => {
    const authentication = await service.authenticate(requestToken(req));
    if (authentication.user) bindUser(authentication.user);
    return authentication;
  };
  const requestUser = async req => (await requestAuthentication(req)).user;
  const routes = new Set([
    "GET /api/auth/me", "POST /api/auth/register", "POST /api/auth/login",
    "GET /api/auth/users", "PATCH /api/auth/username", "PATCH /api/auth/password",
    "PATCH /api/auth/timezone",
    "POST /api/auth/logout"
  ]);
  return {
    requestAuthentication,
    requestUser,
    async authApi(req, res, url) {
      const roleRoute = req.method === "PATCH" && /^\/api\/auth\/users\/[^/]+\/role$/.test(url.pathname);
      if (!roleRoute && !routes.has(`${req.method} ${url.pathname}`)) return false;
      const controller = new AbortController();
      const abort = () => controller.abort();
      const close = () => { if (!res.writableEnded) abort(); };
      req.once("aborted", abort);
      res.once("close", close);
      if (req.aborted || res.destroyed) abort();
      try {
        if (req.method === "GET") {
          if (url.pathname === "/api/auth/users") {
            return sendJson(res, 200, { users: await service.listUsers(requestToken(req)) });
          }
          const result = await service.me(requestToken(req));
          return sendJson(res, result.authenticated ? 200 : 401, result);
        }
        if (url.pathname === "/api/auth/logout") {
          await service.logout(requestToken(req));
          res.setHeader("set-cookie", sessionCookie("", 0));
          return sendJson(res, 200, { authenticated: false });
        }
        // Keep local-mode and authentication failures ahead of parsing account edits.
        if (!authRequired) return sendJson(res, 400, { error: url.pathname.endsWith("/register") ? "本机模式无需注册" : url.pathname.endsWith("/login") ? "本机模式无需登录" : "本机模式无需账户管理" });
        const input = await bodyJson(req);
        if (req.method === "POST") {
          const result = url.pathname.endsWith("/register") ? await service.register(input) : await service.login(input, remoteAddress(req), { signal: controller.signal });
          if (controller.signal.aborted || res.destroyed) return true;
          bindUser(result.user);
          // Only issue the cookie after the repository transaction has committed.
          res.setHeader("set-cookie", sessionCookie(result.token));
          return sendJson(res, url.pathname.endsWith("/register") ? 201 : 200, { authenticated: true, user: publicUser(result.user) });
        }
        if (url.pathname === "/api/auth/password") {
          const result = await service.changePassword(requestToken(req), input, {
            source: remoteAddress(req), signal: controller.signal
          });
          if (controller.signal.aborted || res.destroyed) return true;
          res.setHeader("set-cookie", sessionCookie("", 0));
          return sendJson(res, 200, result);
        }
        const user = roleRoute
          ? await service.setRole(requestToken(req), url.pathname.split("/")[4], input.role)
          : url.pathname.endsWith("/username")
            ? await service.rename(requestToken(req), input)
            : await service.setRecordTimezone(requestToken(req), input);
        return sendJson(res, 200, { authenticated: true, user: publicUser(user) });
      } catch (error) {
        if (controller.signal.aborted || res.destroyed) return true;
        if (error.statusCode) {
          if (error.statusCode === 429 && Number.isFinite(error.retryAfterMs)) {
            res.setHeader("retry-after", String(Math.ceil(error.retryAfterMs / 1000)));
          }
          return sendJson(res, error.statusCode, {
            error: error.message,
            ...(error.code ? { code: error.code } : {}),
            ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {})
          });
        }
        throw error;
      } finally {
        req.removeListener("aborted", abort);
        res.removeListener("close", close);
      }
    }
  };
}
