import { ownerViewCapabilities, resolveApplicationRoute, viewSections } from "../pages/index.mjs";

const appEntryUrl = new URL("../../app.js", import.meta.url);
const basePath = new URL(".", appEntryUrl).pathname.replace(/\/$/, "");
const apiOrigin = String(document.documentElement.dataset.apiOrigin || "").replace(/\/+$/, "");
const startupMarks = {
  navigationStart: 0,
  moduleLoaded: Number(performance.now().toFixed(1))
};

function markStartup(name) {
  startupMarks[name] = Number(performance.now().toFixed(1));
}

function appUrl(value) {
  if (apiOrigin) return `${apiOrigin}${value}`;
  return `${basePath}${value}` || value;
}

async function requestJson(url, { optional = false, allowUnauthorized = false } = {}) {
  const response = await fetch(appUrl(url), {
    headers: { accept: "application/json", "content-type": "application/json" }
  });
  if (optional && response.status === 404) return null;
  const result = await response.json();
  if (allowUnauthorized && response.status === 401) return result;
  if (!response.ok) {
    throw Object.assign(new Error(result?.error?.message || result?.error || "启动请求失败"), {
      code: result?.error?.code || result?.code || "",
      status: response.status
    });
  }
  return result;
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

async function initialSnapshot() {
  markStartup("bootstrapStart");
  try {
    const [session, testConfigResult] = await Promise.all([
      requestJson("/api/auth/me"),
      requestJson("/api/local-test-mode", { optional: true, allowUnauthorized: true })
    ]);
    const testConfig = ["AUTH_REQUIRED", "AUTH_REAUTH_REQUIRED"].includes(testConfigResult?.code) ? null : testConfigResult;
    markStartup("authSessionReady");
    if (!session.authenticated) {
      revealAuthGate();
      return { session, testConfig, startupMarks: { ...startupMarks }, visibleShell: false };
    }
    markStartup("loadStart");
    const [state, meta] = await Promise.all([
      requestJson("/api/state"),
      requestJson("/api/meta")
    ]);
    markStartup("coreSnapshotReady");
    const visibleShell = revealAuthenticatedShell(session, state);
    return { session, testConfig, state, meta, startupMarks: { ...startupMarks }, visibleShell };
  } catch (error) {
    revealAuthGate();
    return { error, startupMarks: { ...startupMarks }, visibleShell: false };
  }
}

export async function startApplication() {
  const initial = await initialSnapshot();
  const runtime = await import("./runtime.mjs");
  return runtime.startApplication(initial);
}
