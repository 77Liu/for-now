import { createApiClient } from "../api/index.mjs";
import { ownerViewCapabilities, resolveApplicationRoute, viewSections } from "../pages/index.mjs";
import { sessionScope } from "../session/index.mjs";

const appEntryUrl = new URL("../../app.js", import.meta.url);
const basePath = new URL(".", appEntryUrl).pathname.replace(/\/$/, "");
const apiOrigin = String(document.documentElement.dataset.apiOrigin || "").replace(/\/+$/, "");
const apiClient = createApiClient({ baseUrl: appEntryUrl, apiOrigin, session: sessionScope });
const startupMarks = {
  navigationStart: 0,
  moduleLoaded: Number(performance.now().toFixed(1))
};

function markStartup(name) {
  startupMarks[name] = Number(performance.now().toFixed(1));
}

function loadR8Styles() {
  const existing = document.querySelector('link[data-r8-styles]');
  if (existing) return Promise.resolve();
  return new Promise(resolve => {
    const link = document.createElement("link");
    let timeout = 0;
    const finish = () => {
      clearTimeout(timeout);
      link.removeEventListener("load", finish);
      link.removeEventListener("error", finish);
      resolve();
    };
    timeout = setTimeout(finish, 1500);
    link.rel = "stylesheet";
    link.href = new URL("../styles/r8.css", import.meta.url).href;
    link.dataset.r8Styles = "";
    link.addEventListener("load", finish, { once: true });
    link.addEventListener("error", finish, { once: true });
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
  markStartup("visibleShell");
  return true;
}

function revealAuthGate() {
  const gate = document.querySelector("#auth-gate");
  if (gate) gate.hidden = false;
}

function routeStateUrl(route) {
  const query = new URLSearchParams({ view: route.view });
  if (route.resourceId) query.set("resourceId", route.resourceId);
  for (const [key, value] of Object.entries(route.query || {})) query.set(key, String(value));
  return `/api/v1/route-state?${query}`;
}

function envelopeData(value) {
  if (!value || value.error || !value.data) throw new Error(value?.error?.message || "启动请求失败");
  return value.data;
}

async function initialSnapshot({ stylesReady = Promise.resolve() } = {}) {
  markStartup("bootstrapStart");
  try {
    const [session, testConfigResult] = await Promise.all([
      requestJson("/api/auth/me", { allowUnauthorized: true }),
      requestJson("/api/local-test-mode", { optional: true, allowUnauthorized: true })
    ]);
    const testConfig = ["AUTH_REQUIRED", "AUTH_REAUTH_REQUIRED"].includes(testConfigResult?.code) ? null : testConfigResult;
    markStartup("authSessionReady");
    if (!session.authenticated) {
      revealAuthGate();
      return { session, testConfig, startupMarks: { ...startupMarks }, visibleShell: false };
    }
    markStartup("loadStart");
    const route = resolveApplicationRoute(location, { basePath });
    const routeRequest = requestJson(routeStateUrl(route)).then(
      value => ({ value }),
      error => ({ error })
    );
    const startupResult = await requestJson("/api/v1/startup");
    const meta = envelopeData(startupResult);
    markStartup("coreSnapshotReady");
    await stylesReady;
    const visibleShell = revealAuthenticatedShell(session, { onboardingV2: meta.onboardingV2 });
    const routeResult = await routeRequest;
    if (routeResult.error) throw routeResult.error;
    const state = {
      ...envelopeData(routeResult.value),
      onboardingV2: meta.onboardingV2,
      notificationUnread: meta.notificationUnread,
      quoteTags: meta.quoteTags
    };
    return { session, testConfig, state, meta, route, startupMarks: { ...startupMarks }, visibleShell };
  } catch (error) {
    revealAuthGate();
    return { error, startupMarks: { ...startupMarks }, visibleShell: false };
  }
}

export async function startApplication() {
  const stylesReady = loadR8Styles();
  const initial = await initialSnapshot({ stylesReady });
  const runtime = await import("./runtime.mjs");
  return runtime.startApplication(initial);
}
