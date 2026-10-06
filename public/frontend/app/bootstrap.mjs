import { createApiClient } from "../api/index.mjs";
import { ownerViewCapabilities, resolveApplicationRoute, viewSections } from "../page-catalog/index.mjs";
import { sessionScope } from "../session/index.mjs";

const appEntryUrl = new URL("../../app.js", import.meta.url);
const basePath = new URL(".", appEntryUrl).pathname.replace(/\/$/, "");
const apiOrigin = String(document.documentElement.dataset.apiOrigin || "").replace(/\/+$/, "");
const apiClient = createApiClient({ baseUrl: appEntryUrl, apiOrigin, session: sessionScope });
const bootstrapRoute = resolveApplicationRoute(location, { basePath });
globalThis.__forNowPortsRequest ||= import("./ports.mjs");
if (bootstrapRoute.view === "export") {
  globalThis.__forNowExportFeatureRequest ||= import("../features/export/index.mjs");
} else if (bootstrapRoute.view === "feedback") {
  globalThis.__forNowFeedbackFeatureRequest ||= import("../features/feedback/index.mjs");
} else if (bootstrapRoute.view === "discovery") {
  globalThis.__forNowDiscoveryFeatureRequest ||= import("../features/thought-discovery/index.mjs");
} else if (bootstrapRoute.view === "keepsakes") {
  globalThis.__forNowKeepsakesFeatureRequest ||= import("../features/keepsakes/index.mjs");
} else if (["review", "statistics"].includes(bootstrapRoute.view)) {
  globalThis.__forNowReviewInsightsFeatureRequest ||= import("../features/review-insights/index.mjs");
} else if (["mine", "permission", "about"].includes(bootstrapRoute.view)) {
  globalThis.__forNowMineShellFeatureRequest ||= import("../features/mine-shell/index.mjs");
} else if (bootstrapRoute.view === "personal-context") {
  globalThis.__forNowPersonalContextFeatureRequest ||= import("../features/personal-context/loader.mjs");
} else if (["account", "settings"].includes(bootstrapRoute.view)) {
  globalThis.__forNowAccountSettingsFeatureRequest ||= import("../features/account-settings/loader.mjs");
} else if (bootstrapRoute.view === "trash") {
  globalThis.__forNowTrashFeatureRequest ||= import("../features/trash/loader.mjs");
} else if (["ai-cost", "architecture", "commercialization"].includes(bootstrapRoute.view)) {
  // Owner feature code is loaded only after capability routing accepts the page.
}
const startupMarks = {
  navigationStart: 0,
  moduleLoaded: Number(performance.now().toFixed(1))
};

function markStartup(name) {
  startupMarks[name] = Number(performance.now().toFixed(1));
}

function loadApplicationStyles() {
  const stylesReady = globalThis.__forNowStylesReady;
  delete globalThis.__forNowStylesReady;
  return Promise.resolve(stylesReady).then(results => {
    const failure = Array.isArray(results)
      ? results.find(result => result.status === "rejected")
      : null;
    if (failure) throw failure.reason;
  });
}

function loadR8Styles() {
  const existing = document.querySelector('link[data-r8-styles]');
  if (existing) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    let timeout = 0;
    const cleanup = () => {
      clearTimeout(timeout);
      link.removeEventListener("load", loaded);
      link.removeEventListener("error", failed);
    };
    const loaded = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      link.remove();
      reject(new Error("R8 stylesheet failed"));
    };
    timeout = setTimeout(failed, 1500);
    link.rel = "stylesheet";
    link.href = new URL("../styles/r8.css", import.meta.url).href;
    link.dataset.r8Styles = "";
    link.addEventListener("load", loaded, { once: true });
    link.addEventListener("error", failed, { once: true });
    document.head.append(link);
  });
}

async function requestJson(url, { optional = false, allowUnauthorized = false } = {}) {
  return apiClient.request(
    url,
    { headers: { accept: "application/json" } },
    { optional, allowUnauthorized, authGate: false, fallback: "启动请求失败" }
  );
}

function activateRouteShell(user) {
  const route = resolveApplicationRoute(location, { basePath });
  const capability = ownerViewCapabilities[route.view];
  const view = capability && user?.role !== "owner" ? "permission" : route.view;
  const section = viewSections[view] || "today";
  document.querySelectorAll(".view").forEach(node => node.classList.toggle("active", node.id === `view-${view}`));
  document.querySelectorAll(".nav-button").forEach(node => {
    const active = node.dataset.section === section;
    node.classList.toggle("active", active);
    node.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelectorAll("[data-section-links]").forEach(node => {
    node.hidden = node.dataset.sectionLinks !== section;
  });
  const sectionNav = document.querySelector("#section-nav");
  if (sectionNav) sectionNav.hidden = section === "mine";
}

function revealAuthenticatedShell(session, state) {
  if (!["completed", "skipped"].includes(state?.onboardingV2?.session?.status)) return false;
  activateRouteShell(session.user);
  document.querySelector("#auth-gate")?.setAttribute("hidden", "");
  document.body.classList.remove("auth-locked");
  document.documentElement.dataset.bootstrapVisible = "1";
  try {
    sessionStorage.setItem("cike:authenticated-shell", "1");
  } catch {}
  markStartup("visibleShell");
  return true;
}

function revealAuthGate() {
  try {
    sessionStorage.removeItem("cike:authenticated-shell");
  } catch {}
  delete document.documentElement.dataset.bootstrapVisible;
  document.body.classList.add("auth-locked");
  const gate = document.querySelector("#auth-gate");
  if (gate) gate.hidden = false;
}

function routeStateUrl(route) {
  const query = new URLSearchParams({ view: route.view });
  if (route.resourceId) query.set("resourceId", route.resourceId);
  for (const [key, value] of Object.entries(route.query || {})) query.set(key, String(value));
  return `/api/v1/route-state?${query}`;
}

const requestSession = () => requestJson("/api/auth/me", { allowUnauthorized: true });
const requestLocalTestConfig = () => requestJson("/api/local-test-mode", { optional: true, allowUnauthorized: true });

function envelopeData(value) {
  if (!value || value.error || !value.data) throw new Error(value?.error?.message || "启动请求失败");
  return value.data;
}

async function initialSnapshot({ stylesReady = Promise.resolve(), onShellReady = () => {} } = {}) {
  markStartup("bootstrapStart");
  try {
    const route = bootstrapRoute;
    const startupRequest = globalThis.__forNowStartupRequest;
    delete globalThis.__forNowStartupRequest;
    const prefetchedStartup = startupRequest ? await startupRequest : null;
    const startupResult = prefetchedStartup || await requestJson("/api/v1/startup", { allowUnauthorized: true });
    if (!startupResult?.data) {
      const [session, testConfigResult] = await Promise.all([
        requestSession(),
        requestLocalTestConfig()
      ]);
      const testConfig = ["AUTH_REQUIRED", "AUTH_REAUTH_REQUIRED"].includes(testConfigResult?.code) ? null : testConfigResult;
      markStartup("authSessionReady");
      if (!session.authenticated) {
        revealAuthGate();
        return { session, testConfig, startupMarks: { ...startupMarks }, visibleShell: false };
      }
      return envelopeData(startupResult);
    }
    const meta = envelopeData(startupResult);
    markStartup("authSessionReady");
    markStartup("loadStart");
    markStartup("coreSnapshotReady");
    const sessionRequest = requestSession();
    const testConfigRequest = requestLocalTestConfig();
    const prefetchedRouteRequest = globalThis.__forNowRouteRequest;
    delete globalThis.__forNowRouteRequest;
    const routeRequest = Promise.resolve(prefetchedRouteRequest)
      .then(value => value || requestJson(routeStateUrl(route), { allowUnauthorized: true }))
      .then(
      value => ({ value }),
      error => ({ error })
    );
    await stylesReady;
    const visibleShell = revealAuthenticatedShell({ user: meta.user }, { onboardingV2: meta.onboardingV2 });
    onShellReady();
    const [session, testConfigResult, routeResult] = await Promise.all([
      sessionRequest,
      testConfigRequest,
      routeRequest
    ]);
    if (!session.authenticated) throw Object.assign(new Error("请先登录"), { code: "AUTH_REQUIRED" });
    const testConfig = ["AUTH_REQUIRED", "AUTH_REAUTH_REQUIRED"].includes(testConfigResult?.code) ? null : testConfigResult;
    if (routeResult.error) throw routeResult.error;
    const state = {
      ...envelopeData(routeResult.value),
      onboardingV2: meta.onboardingV2,
      notificationUnread: meta.notificationUnread,
      quoteTags: meta.quoteTags
    };
    return { session, testConfig, state, meta, route, startupMarks: { ...startupMarks }, visibleShell };
  } catch (error) {
    return { error, startupMarks: { ...startupMarks }, visibleShell: false };
  }
}

export async function startApplication({ opening } = {}) {
  let runtimeRequest;
  const loadRuntime = () => {
    const prefetchedRuntime = globalThis.__forNowRuntimeRequest;
    delete globalThis.__forNowRuntimeRequest;
    return runtimeRequest ||= prefetchedRuntime || import("./runtime.mjs");
  };
  const stylesReady = Promise.all([loadApplicationStyles(), loadR8Styles()]);
  void stylesReady.catch(() => {});
  const initial = await initialSnapshot({ stylesReady, onShellReady: loadRuntime });
  const runtimeModule = loadRuntime();
  if (!initial?.error) await stylesReady;
  const runtime = await runtimeModule;
  return runtime.startApplication(initial, { opening });
}
