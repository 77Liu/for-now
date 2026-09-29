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

export function createAuthHttp({ service, sendJson, bodyJson, authRequired, basePath, cookieSecure, bindUser }) {
  const sessionCookie = (token, maxAge = Math.floor(SESSION_TTL_MS / 1000)) =>
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=${basePath}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecure ? "; Secure" : ""}`;
  const requestToken = req => authRequired ? parseCookies(req)[SESSION_COOKIE] : undefined;
  const requestUser = async req => {
    const user = await service.resolveUser(requestToken(req));
    if (user) bindUser(user);
    return user;
  };
  const routes = new Set([
    "GET /api/auth/me", "POST /api/auth/register", "POST /api/auth/login",
    "PATCH /api/auth/username", "PATCH /api/auth/password", "POST /api/auth/logout"
  ]);
  return {
    requestUser,
    async authApi(req, res, url) {
      if (!routes.has(`${req.method} ${url.pathname}`)) return false;
      try {
        if (req.method === "GET") {
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
        if (req.method === "PATCH" && !await requestUser(req)) return sendJson(res, 401, { error: "请先登录", code: "AUTH_REQUIRED" });
        const input = await bodyJson(req);
        if (req.method === "POST") {
          const result = url.pathname.endsWith("/register") ? await service.register(input) : await service.login(input, remoteAddress(req));
          bindUser(result.user);
          // Only issue the cookie after the repository transaction has committed.
          res.setHeader("set-cookie", sessionCookie(result.token));
          return sendJson(res, url.pathname.endsWith("/register") ? 201 : 200, { authenticated: true, user: publicUser(result.user) });
        }
        const user = url.pathname.endsWith("/username") ? await service.rename(requestToken(req), input) : await service.changePassword(requestToken(req), input);
        return sendJson(res, 200, { authenticated: true, user: publicUser(user) });
      } catch (error) {
        if (error.statusCode) return sendJson(res, error.statusCode, { error: error.message, ...(error.code ? { code: error.code } : {}) });
        throw error;
      }
    }
  };
}
