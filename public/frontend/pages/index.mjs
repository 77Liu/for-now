export const viewSections = Object.freeze({
  today: "today",
  together: "today",
  daily: "today",
  captures: "seen",
  books: "seen",
  quotes: "seen",
  keepsakes: "seen",
  journals: "thought",
  thoughts: "thought",
  discovery: "thought",
  review: "thought",
  mine: "mine",
  "personal-context": "mine",
  statistics: "mine",
  "ai-cost": "mine",
  architecture: "mine",
  commercialization: "mine",
  feedback: "mine",
  export: "mine",
  notifications: "mine",
  trash: "mine",
  permission: "mine",
  account: "mine",
  settings: "mine",
  about: "mine"
});

export const ownerViewCapabilities = Object.freeze({
  "ai-cost": "ai-costs",
  architecture: "architecture",
  commercialization: "commercialization"
});

export const canonicalPagePaths = Object.freeze({
  today: "/today",
  together: "/today/together",
  daily: "/today/daily",
  captures: "/seen/captures",
  books: "/seen/books",
  quotes: "/seen/quotes",
  keepsakes: "/seen/keepsakes",
  journals: "/journals",
  thoughts: "/thoughts",
  discovery: "/thoughts/discovery",
  review: "/review",
  mine: "/mine",
  "personal-context": "/mine/personal-context",
  statistics: "/mine/statistics",
  "ai-cost": "/owner/ai-cost",
  architecture: "/owner/architecture",
  commercialization: "/owner/commercialization",
  feedback: "/mine/feedback",
  export: "/mine/export",
  notifications: "/mine/notifications",
  trash: "/mine/trash",
  permission: "/permission",
  account: "/mine/account",
  settings: "/mine/settings",
  about: "/mine/about"
});

const pageByPath = new Map(Object.entries(canonicalPagePaths).map(([view, pathname]) => [pathname, view]));
const legacyPagePaths = new Map([
  ["/now", "today"],
  ...Object.keys(viewSections).map(view => [`/view/${view}`, view]),
  ...Object.keys(viewSections)
    .filter(view => canonicalPagePaths[view] !== `/${view}`)
    .map(view => [`/${view}`, view])
]);
const HISTORY_STATE_KEY = "__forNowRoute";
const HISTORY_STATE_VERSION = 1;

function normalizedPathname(value) {
  const pathname = `/${String(value || "/").replace(/^\/+|\/+$/g, "")}`;
  return pathname === "/" ? pathname : pathname.replace(/\/+$/, "");
}

function normalizedBasePath(value) {
  const pathname = normalizedPathname(value);
  return pathname === "/" ? "" : pathname;
}

function pathInsideBase(pathname, basePath) {
  const normalized = normalizedPathname(pathname);
  const base = normalizedBasePath(basePath);
  if (!base) return normalized;
  if (normalized === base) return "/";
  return normalized.startsWith(`${base}/`) ? normalized.slice(base.length) || "/" : null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function legacyView(searchParams, hash) {
  const fromQuery = searchParams.get("view");
  if (viewSections[fromQuery]) return fromQuery;
  const fragment = String(hash || "").replace(/^#/, "");
  const fromHash = fragment.startsWith("view=") ? fragment.slice(5) : fragment;
  return viewSections[fromHash] ? fromHash : "";
}

export function normalizeRouteQuery(view, input = {}) {
  if (view !== "thoughts") return {};
  const value = input instanceof URLSearchParams ? input : new URLSearchParams(
    Object.entries(input || {}).filter(([, entry]) => entry != null && entry !== "")
  );
  const tag = String(value.get("tag") || "").normalize("NFKC").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 30);
  const q = String(value.get("q") || "").normalize("NFKC").trim().replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
  const sort = value.get("sort") === "created" ? "created" : "occurred";
  const pageValue = Number.parseInt(value.get("page") || "1", 10);
  const page = Number.isSafeInteger(pageValue) && pageValue > 0 ? Math.min(pageValue, 5) : 1;
  return {
    ...(tag && tag !== "all" ? { tag } : {}),
    ...(q ? { q } : {}),
    ...(sort !== "occurred" ? { sort } : {}),
    ...(page !== 1 ? { page } : {})
  };
}

function queryString(view, query) {
  const normalized = normalizeRouteQuery(view, query);
  const params = new URLSearchParams();
  if (normalized.tag) params.set("tag", normalized.tag);
  if (normalized.q) params.set("q", normalized.q);
  if (normalized.sort) params.set("sort", normalized.sort);
  if (normalized.page) params.set("page", String(normalized.page));
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function pageRoute(view, query = {}) {
  const safeView = viewSections[view] ? view : "today";
  return {
    kind: "page",
    view: safeView,
    resourceType: "",
    resourceId: "",
    query: normalizeRouteQuery(safeView, query)
  };
}

export function detailRoute(resourceType, resourceId, query = {}) {
  const id = String(resourceId || "").trim().slice(0, 200);
  if (resourceType !== "thought-chain" || !id || /[\/\u0000-\u001f\u007f]/.test(id)) {
    return pageRoute("thoughts", query);
  }
  return {
    kind: "detail",
    view: "thoughts",
    resourceType,
    resourceId: id,
    query: normalizeRouteQuery("thoughts", query)
  };
}

export function routePath(route) {
  const value = route?.kind === "detail"
    ? detailRoute(route.resourceType, route.resourceId, route.query)
    : pageRoute(route?.view, route?.query);
  const pathname = value.kind === "detail"
    ? `/thoughts/${encodeURIComponent(value.resourceId)}`
    : canonicalPagePaths[value.view];
  return `${pathname}${queryString(value.view, value.query)}`;
}

export function applicationRouteUrl(route, basePath = "/") {
  const base = normalizedBasePath(basePath);
  return `${base}${routePath(route)}` || "/";
}

export function resolveApplicationRoute(input, { basePath = "/" } = {}) {
  const location = input instanceof URL
    ? input
    : new URL(
      `${input?.pathname || "/"}${input?.search || ""}${input?.hash || ""}`,
      "http://route.local"
    );
  const pathname = pathInsideBase(location.pathname, basePath);
  const fallback = pageRoute("today");
  if (pathname == null) return { ...fallback, matched: false, legacy: false };

  const searchParams = new URLSearchParams(location.search);
  let view = pageByPath.get(pathname);
  let route;
  let legacy = false;
  if (view) {
    route = pageRoute(view, searchParams);
  } else {
    const detail = /^\/thoughts\/([^/]+)$/.exec(pathname);
    if (detail) {
      const id = safeDecode(detail[1]);
      route = detailRoute("thought-chain", id, searchParams);
      if (route.kind !== "detail") return { ...fallback, matched: false, legacy: false };
    } else {
      view = legacyPagePaths.get(pathname);
      if (!view && pathname === "/") view = legacyView(searchParams, location.hash) || "today";
      if (!view) return { ...fallback, matched: false, legacy: false };
      route = pageRoute(view, searchParams);
      legacy = pathname !== canonicalPagePaths[view] || searchParams.has("view") || Boolean(location.hash);
    }
  }
  const canonicalUrl = applicationRouteUrl(route, basePath);
  return {
    ...route,
    matched: true,
    legacy: legacy || `${location.pathname}${location.search}` !== canonicalUrl,
    canonicalUrl
  };
}

export function isApplicationRoutePath(pathname) {
  return resolveApplicationRoute({ pathname }, { basePath: "/" }).matched;
}

export function createUnavailableRouteResult({ resourceType, resourceId, view = "thoughts" }) {
  const safeView = viewSections[view] ? view : "today";
  return {
    data: null,
    error: {
      code: "RESOURCE_UNAVAILABLE",
      message: resourceType === "thought-chain" ? "这条思绪已不可用" : "这个对象已不可用",
      details: {
        resourceType: String(resourceType || "resource"),
        resourceId: String(resourceId || "")
      }
    },
    meta: {
      fallback: {
        view: safeView,
        path: canonicalPagePaths[safeView]
      }
    }
  };
}

function routeSnapshot(route) {
  return {
    kind: route.kind,
    view: route.view,
    resourceType: route.resourceType || "",
    resourceId: route.resourceId || "",
    query: { ...(route.query || {}) }
  };
}
export function createPageRouter({
  query,
  queryAll,
  effects = {},
  canAccessView = () => true,
  onDenied = () => {},
  scrollTo = options => globalThis.scrollTo(options),
  defaultView = "today",
  location = globalThis.location,
  history = globalThis.history,
  eventTarget = globalThis,
  basePath = "/",
  requestFrame = callback => globalThis.requestAnimationFrame(callback),
  setTimer = globalThis.setTimeout,
  readScroll = () => ({ x: Number(globalThis.scrollX) || 0, y: Number(globalThis.scrollY) || 0 }),
  onRoute = () => {}
}) {
  const fallbackView = viewSections[defaultView] ? defaultView : "today";
  const browserHistory = Boolean(location && history?.pushState && history?.replaceState);
  let currentView = fallbackView;
  let currentRoute = pageRoute(fallbackView);
  let scrollFrame = 0;
  let scrollRestoreVersion = 0;

  function applyView(name, { runEffects = false, resetScroll = false } = {}) {
    let viewName = viewSections[name] ? name : fallbackView;
    const requiredCapability = ownerViewCapabilities[viewName];
    if (requiredCapability && !canAccessView(viewName, requiredCapability)) {
      onDenied(viewName, requiredCapability);
      viewName = "permission";
    }
    const section = viewSections[viewName];
    const sectionNav = query("#section-nav");
    queryAll(".view").forEach(view => view.classList.toggle("active", view.id === `view-${viewName}`));
    queryAll(".nav-button").forEach(button => {
      const active = button.dataset.section === section;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    if (sectionNav) sectionNav.hidden = section === "mine";
    queryAll("[data-section-links]").forEach(group => {
      group.hidden = group.dataset.sectionLinks !== section;
    });
    queryAll(".section-nav button").forEach(button => {
      const active = button.dataset.view === viewName;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    if (runEffects) {
      if (currentView === "quotes" && viewName !== "quotes") effects.leaveQuotes?.();
      effects[viewName]?.();
    }
    currentView = viewName;
    if (resetScroll) scrollTo({ top: 0, behavior: "smooth" });
    return viewName;
  }

  function historyEntry(route, { scroll = { x: 0, y: 0 }, result = null, returnRoute = null } = {}) {
    return {
      version: HISTORY_STATE_VERSION,
      route: routeSnapshot(route),
      scroll: {
        x: Math.max(0, Number(scroll.x) || 0),
        y: Math.max(0, Number(scroll.y) || 0)
      },
      result,
      returnRoute: returnRoute ? routeSnapshot(returnRoute) : null
    };
  }

  function storedEntry(state = history?.state) {
    const entry = state?.[HISTORY_STATE_KEY];
    return entry?.version === HISTORY_STATE_VERSION ? entry : null;
  }

  function writeHistory(method, route, options = {}) {
    if (!browserHistory) return;
    const state = {
      ...(history.state && typeof history.state === "object" ? history.state : {}),
      [HISTORY_STATE_KEY]: historyEntry(route, options)
    };
    history[method](state, "", applicationRouteUrl(route, basePath));
  }

  function captureScroll() {
    if (!browserHistory) return;
    const entry = storedEntry();
    writeHistory("replaceState", currentRoute, {
      scroll: readScroll(),
      result: entry?.result || currentRoute.result || null,
      returnRoute: entry?.returnRoute || null
    });
  }

  function applyRoute(route, {
    runEffects = false,
    resetScroll = false,
    result = null,
    source = "restore"
  } = {}) {
    currentRoute = { ...routeSnapshot(route), result };
    const viewName = applyView(currentRoute.view, { runEffects, resetScroll });
    const routed = onRoute({ ...currentRoute, query: { ...currentRoute.query } }, { source });
    return routed ?? viewName;
  }

  function navigate(route, {
    mode = "push",
    runEffects = true,
    resetScroll = mode === "push",
    result = null
  } = {}) {
    scrollRestoreVersion += 1;
    const next = route?.kind === "detail"
      ? detailRoute(route.resourceType, route.resourceId, route.query)
      : pageRoute(route?.view, route?.query);
    if (!browserHistory) return applyRoute(next, { runEffects, resetScroll, result, source: mode });

    const nextUrl = applicationRouteUrl(next, basePath);
    const currentUrl = `${location.pathname}${location.search}`;
    captureScroll();
    const sameUrl = nextUrl === currentUrl;
    const historyMode = mode === "replace" || sameUrl ? "replaceState" : "pushState";
    writeHistory(historyMode, next, {
      scroll: resetScroll ? { x: 0, y: 0 } : readScroll(),
      result,
      returnRoute: next.kind === "detail" && currentRoute.kind === "page"
        ? currentRoute
        : storedEntry()?.returnRoute || null
    });
    return applyRoute(next, { runEffects, resetScroll, result, source: historyMode === "pushState" ? "push" : "replace" });
  }

  function switchView(name) {
    return navigate(pageRoute(name), { mode: "push", runEffects: true, resetScroll: true });
  }

  function restoreView(name) {
    if (name != null) {
      const next = pageRoute(name);
      currentRoute = next;
      return applyView(next.view);
    }
    return applyView(currentRoute.view);
  }

  function replaceQuery(changes = {}, { apply = true } = {}) {
    const next = currentRoute.kind === "detail"
      ? detailRoute(currentRoute.resourceType, currentRoute.resourceId, { ...currentRoute.query, ...changes })
      : pageRoute(currentRoute.view, { ...currentRoute.query, ...changes });
    if (!apply && browserHistory) {
      writeHistory("replaceState", next, {
        scroll: readScroll(),
        result: storedEntry()?.result || currentRoute.result || null,
        returnRoute: storedEntry()?.returnRoute || null
      });
      currentRoute = { ...routeSnapshot(next), result: currentRoute.result || null };
      return currentView;
    }
    return navigate(next, { mode: "replace", runEffects: false, resetScroll: false });
  }

  function openDetail(resourceType, resourceId, options = {}) {
    const route = detailRoute(resourceType, resourceId, options.query || currentRoute.query);
    return navigate(route, { mode: "push", runEffects: currentRoute.view !== route.view, resetScroll: true });
  }

  function showList(view = currentRoute.view, options = {}) {
    const route = pageRoute(view, options.query || currentRoute.query);
    return navigate(route, {
      mode: options.mode === "replace" ? "replace" : "push",
      runEffects: currentRoute.view !== route.view,
      resetScroll: options.resetScroll !== false
    });
  }

  function backToList(view = currentRoute.view, options = {}) {
    const entry = storedEntry();
    const returnRoute = entry?.returnRoute;
    if (
      browserHistory
      && currentRoute.kind === "detail"
      && returnRoute?.kind === "page"
    ) {
      history.back();
      return currentView;
    }
    return showList(view, { ...options, mode: "replace" });
  }

  function showUnavailable(result, { view = "thoughts", query: nextQuery = currentRoute.query } = {}) {
    return navigate(pageRoute(view, nextQuery), {
      mode: "replace",
      runEffects: currentRoute.view !== view,
      resetScroll: false,
      result
    });
  }

  function clearResult() {
    return navigate(currentRoute, { mode: "replace", runEffects: false, resetScroll: false, result: null });
  }

  function activate() {
    return applyRoute(currentRoute, {
      runEffects: true,
      resetScroll: false,
      result: currentRoute.result || storedEntry()?.result || null,
      source: "activate"
    });
  }

  function onPopState(event) {
    const restoreVersion = ++scrollRestoreVersion;
    const resolved = resolveApplicationRoute(location, { basePath });
    const route = resolved.matched ? resolved : pageRoute(fallbackView);
    const entry = event?.state?.[HISTORY_STATE_KEY];
    if (resolved.legacy || !resolved.matched) {
      writeHistory("replaceState", route, {
        scroll: entry?.scroll || { x: 0, y: 0 },
        result: entry?.result || null
      });
    }
    const applied = applyRoute(route, {
      runEffects: true,
      resetScroll: false,
      result: entry?.result || null,
      source: "pop"
    });
    if (applied && typeof applied.finally === "function") {
      applied.finally(() => restoreCurrentScroll(entry?.scroll, restoreVersion));
    } else {
      restoreCurrentScroll(entry?.scroll, restoreVersion);
    }
  }

  function onScroll() {
    if (scrollFrame) return;
    scrollFrame = requestFrame(() => {
      scrollFrame = 0;
      captureScroll();
    });
  }
  function onScrollIntent(event) {
    if (
      event?.type === "keydown"
      && !["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "].includes(event.key)
    ) return;
    scrollRestoreVersion += 1;
  }
  function restoreCurrentScroll(position = null, expectedVersion = ++scrollRestoreVersion) {
    const saved = position || storedEntry()?.scroll || { x: 0, y: 0 };
    const restore = () => {
      if (expectedVersion !== scrollRestoreVersion) return;
      scrollTo({
        left: Math.max(0, Number(saved.x) || 0),
        top: Math.max(0, Number(saved.y) || 0),
        behavior: "auto"
      });
    };
    requestFrame(() => {
      if (expectedVersion !== scrollRestoreVersion) return;
      requestFrame(() => {
        if (expectedVersion !== scrollRestoreVersion) return;
        restore();
        setTimer?.(restore, 100);
      });
    });
  }

  if (browserHistory) {
    const resolved = resolveApplicationRoute(location, { basePath });
    const initial = resolved.matched ? resolved : pageRoute(fallbackView);
    const existing = storedEntry();
    const result = existing?.result || null;
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    writeHistory("replaceState", initial, {
      scroll: existing?.scroll || readScroll(),
      result
    });
    applyRoute(initial, { result, source: "initial" });
    eventTarget?.addEventListener?.("popstate", onPopState);
    eventTarget?.addEventListener?.("scroll", onScroll, { passive: true });
    for (const eventName of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      eventTarget?.addEventListener?.(eventName, onScrollIntent, { passive: eventName !== "keydown" });
    }
    eventTarget?.addEventListener?.("pagehide", captureScroll);
  }

  return {
    switchView,
    restoreView,
    replaceQuery,
    openDetail,
    showList,
    backToList,
    showUnavailable,
    clearResult,
    activate,
    captureScroll,
    restoreCurrentScroll,
    currentView: () => currentView,
    currentRoute: () => ({ ...currentRoute, query: { ...currentRoute.query } })
  };
}
