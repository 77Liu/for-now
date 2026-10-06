import { createRequestHandler } from "./request.mjs";
import { createStaticHttp } from "./static.mjs";

export const SERVER_ROUTE_IDS = Object.freeze([
  "health-readiness",
  "local-test-proxy",
  "admin",
  "auth",
  "owner",
  "v1",
  "legacy",
  "attachment",
  "static"
]);

export function createHttpApplication({
  requestStorage,
  dataDir,
  publicDir,
  basePath,
  version,
  upstreamOrigin,
  localTestMode,
  postgresRuntime,
  logEvent,
  sendJson,
  apiV1,
  localTestRuntime,
  localTestHttp,
  adminHttp,
  proxyToUpstream,
  requestAuthentication,
  authApi,
  bindAuthenticatedUser,
  isOwner,
  ownerHttp,
  legacyApi,
  attachmentHttp,
  isApplicationRoutePath
}) {
  const staticHttp = createStaticHttp({
    publicDir,
    basePath,
    isApplicationRoutePath,
    sendJson
  });
  const handle = createRequestHandler({
    requestContext: requestStorage,
    rootDir: dataDir,
    basePath,
    logEvent,
    sendJson,
    sendError: (res, status, value, context) => context.apiVersion === "v1"
      ? apiV1.error(res, status, value.error, value.code, value.details)
      : sendJson(res, status, value),
    isStorageError: error => Boolean(
      postgresRuntime
      && (
        /^[0-9A-Z]{5}$/.test(error.code || "")
        || error.code === "STORAGE_CONFIGURATION_INVALID"
      )
    ),
    async handle(req, res, url, context) {
      const sendRequestError = (status, message, code) => (
        context.apiVersion === "v1"
          ? apiV1.error(res, status, message, code)
          : sendJson(res, status, {
              error: message,
              ...(code ? { code } : {})
            })
      );
      if (url.pathname === "/readyz" && postgresRuntime) {
        try {
          await postgresRuntime.ready();
        } catch {
          return sendJson(res, 503, {
            ok: false,
            code: "STORAGE_UNAVAILABLE"
          });
        }
      }
      if (url.pathname === "/healthz" || url.pathname === "/readyz") {
        return sendJson(res, 200, { ok: true, version });
      }
      if (basePath === "/"
        && ["/now", "/now/"].includes(url.pathname)
        && ["GET", "HEAD"].includes(req.method || "GET")) {
        res.writeHead(308, { location: `/today${url.search}` });
        return res.end();
      }
      const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method || "GET");
      if (unsafe && String(req.headers["sec-fetch-site"] || "") === "cross-site") {
        return sendRequestError(
          403,
          "跨站请求已拒绝",
          "CROSS_SITE_REQUEST_REJECTED"
        );
      }

      await localTestHttp.prepareRequestContext(context);
      if (await localTestHttp.handle(req, res, url)) return;
      if (url.pathname.startsWith("/api/admin/")) {
        const handled = await adminHttp.handle(req, res, url);
        return handled === false
          ? sendJson(res, 404, { error: "Not found" })
          : handled;
      }
      if (upstreamOrigin
        && !localTestMode
        && (
          url.pathname.startsWith("/api/")
          || url.pathname.startsWith("/attachments/")
        )) {
        return await proxyToUpstream(req, res, url);
      }

      const authentication = localTestRuntime.enabled
        ? localTestHttp.authentication(req)
        : await requestAuthentication(req);
      const user = authentication.user;
      if (localTestRuntime.enabled && user) bindAuthenticatedUser(user);
      if (url.pathname.startsWith("/api/auth/")) {
        const handled = await authApi(req, res, url);
        return handled === false
          ? sendJson(res, 404, { error: "Not found" })
          : handled;
      }
      if ((
        url.pathname.startsWith("/api/")
        || url.pathname.startsWith("/attachments/")
      ) && authentication.reauthRequired) {
        return sendRequestError(
          401,
          "账户权限已变更，请重新登录",
          "AUTH_REAUTH_REQUIRED"
        );
      }
      if (url.pathname.startsWith("/api/") && !user) {
        return sendRequestError(401, "请先登录", "AUTH_REQUIRED");
      }
      if (url.pathname.startsWith("/attachments/") && !user) {
        return sendJson(res, 401, {
          error: "请先登录",
          code: "AUTH_REQUIRED"
        });
      }

      const requiredCapability = ownerHttp.capabilityFor(url);
      if (requiredCapability && !isOwner(user)) {
        return sendRequestError(
          403,
          "当前账户没有 Owner 权限",
          "OWNER_REQUIRED"
        );
      }
      if (await ownerHttp.handle(req, res, url)) return;
      if (url.pathname.startsWith("/api/v1/")) {
        const handled = await apiV1.handle(req, res, url);
        return handled === false
          ? apiV1.error(res, 404, "Not found", "NOT_FOUND")
          : handled;
      }
      if (url.pathname.startsWith("/api/")) {
        return await legacyApi.handle(req, res, url);
      }
      if (await attachmentHttp.handle(req, res, url)) return;
      return staticHttp.handle(req, res, url, context);
    }
  });

  return {
    handle,
    routeIds: SERVER_ROUTE_IDS
  };
}
