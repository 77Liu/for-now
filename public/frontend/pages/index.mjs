import { applicationRouteUrl, detailRoute, ownerViewCapabilities, pageRoute, resolveApplicationRoute, routePath, viewSections } from "../page-catalog/index.mjs";

export { applicationRouteUrl, detailRoute, ownerViewCapabilities, pageRoute, resolveApplicationRoute, routePath, viewSections };
export { canonicalPagePaths, createUnavailableRouteResult, isApplicationRoutePath, normalizeRouteQuery } from "../page-catalog/index.mjs";

const HISTORY_STATE_KEY="__forNowRoute",HISTORY_STATE_VERSION=1;
const INTENT_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"];

function routeSnapshot(route) { return { kind:route.kind,view:route.view,resourceType:route.resourceType||"",resourceId:route.resourceId||"",query:{...(route.query||{})} }; }
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
  cancelFrame = frame => globalThis.cancelAnimationFrame(frame),
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  readScroll = () => ({ x: Number(globalThis.scrollX) || 0, y: Number(globalThis.scrollY) || 0 }),
  onRoute = () => {}
}) {
  const fallbackView = viewSections[defaultView] ? defaultView : "today";
  const browserHistory = Boolean(location && history?.pushState && history?.replaceState);
  let currentView = fallbackView;
  let currentRoute = pageRoute(fallbackView);
  let committedRoute = currentRoute;
  let scrollFrame = 0;
  let restoreVer = 0;
  let routeVer = 0;
  let startDisposer = null, hooks = null, savedScroll;
  let abortSignal = null, aborter = null;
  const frames = new Set(), timers = new Set();

  function scheduleFrame(callback) { let frame;frame=requestFrame(()=>{frames.delete(frame);callback()});frames.add(frame);return frame }
  function scheduleTimer(callback,delay) { let timer;timer=setTimer?.(()=>{timers.delete(timer);callback()},delay);if(timer!=null)timers.add(timer);return timer }
  function cancelScheduledWork() { for(const frame of frames)cancelFrame?.(frame);for(const timer of timers)clearTimer?.(timer);frames.clear();timers.clear();scrollFrame=0 }

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
    return {version:HISTORY_STATE_VERSION,route:routeSnapshot(route),scroll:{x:Math.max(0,Number(scroll.x)||0),y:Math.max(0,Number(scroll.y)||0)},result,returnRoute:returnRoute?routeSnapshot(returnRoute):null};
  }

  function storedEntry(state=history?.state) { const entry=state?.[HISTORY_STATE_KEY];return entry?.version===HISTORY_STATE_VERSION?entry:null }

  function writeHistory(method, route, options = {}) {
    if (!browserHistory) return;
    const state={...history.state&&typeof history.state==="object"?history.state:{},[HISTORY_STATE_KEY]:historyEntry(route,options)};
    history[method](state,"",applicationRouteUrl(route,basePath));
  }

  function captureScroll() {
    if (!startDisposer || !browserHistory) return;
    const entry=storedEntry();writeHistory("replaceState",committedRoute,{scroll:readScroll(),result:entry?.result||committedRoute.result||null,returnRoute:entry?.returnRoute||null});
  }

  function applyEffective(view,result=currentRoute.result||null) { if(view!==currentRoute.view)currentRoute={...pageRoute(view),result} }

  function applyRoute(route, {
    runEffects = false,
    resetScroll = false,
    result = null,
    source = "restore",
    onTransition = () => {}
  } = {}) {
    const previous = committedRoute;
    currentRoute = { ...routeSnapshot(route), result };
    const viewName = applyView(currentRoute.view, { runEffects, resetScroll });
    applyEffective(viewName, result);
    const target = { ...routeSnapshot(currentRoute), result: currentRoute.result || null }, routeHooks = hooks, cycle = startDisposer, version = ++routeVer;
    const active = () => startDisposer === cycle && version === routeVer;
    const dispatch=()=>active()?onRoute({...target,query:{...target.query}},{source})??viewName:false;
    const fail = error => {
      if (active()) {
        currentRoute={...routeSnapshot(committedRoute),result:committedRoute.result||null};applyView(currentRoute.view,{runEffects:true});
        onRoute({...currentRoute,query:{...currentRoute.query}},{source:"rollback",transitionError:error});
      }
      throw error;
    };
    let transition;
    try {
      if(routeHooks&&!["initial","activate"].includes(source)&&routePath(previous)!==routePath(target)){
        const enter=()=>active()?routeHooks.enter(target):false,left=routeHooks.leave(routeSnapshot(previous));
        transition=left?.then?left.then(enter):enter();
      }
    }catch(error){return fail(error)}
    const complete=()=>{if(!active())return false;committedRoute=target;onTransition(target);return dispatch()};
    return transition?.then?transition.then(complete,fail):complete();
  }

  function navigate(route, {
    mode = "push",
    runEffects = true,
    resetScroll = mode === "push",
    result = null
  } = {}) {
    if (!startDisposer) return false;
    restoreVer += 1;
    const next = route?.kind === "detail"
      ? detailRoute(route.resourceType, route.resourceId, route.query)
      : pageRoute(route?.view, route?.query);
    if (!browserHistory) return applyRoute(next, { runEffects, resetScroll, result, source: mode });

    const nextUrl = applicationRouteUrl(next, basePath);
    const currentUrl = `${location.pathname}${location.search}`;
    captureScroll();
    const sameUrl = nextUrl === currentUrl;
    const historyMode = mode === "replace" || sameUrl ? "replaceState" : "pushState";
    const historyOptions={scroll:resetScroll?{x:0,y:0}:readScroll(),result,returnRoute:next.kind==="detail"&&currentRoute.kind==="page"?currentRoute:storedEntry()?.returnRoute||null};
    const commit=target=>writeHistory(historyMode,target,{...historyOptions,result:target.result||null});
    return applyRoute(next,{runEffects,resetScroll,result,source:historyMode==="pushState"?"push":"replace",onTransition:commit});
  }

  function switchView(name) {
    return navigate(pageRoute(name), { mode: "push", runEffects: true, resetScroll: true });
  }

  function restoreView(name) {
    const previousPath = routePath(currentRoute);
    if (name != null) currentRoute = pageRoute(name);
    const viewName = applyView(currentRoute.view);
    applyEffective(viewName);
    committedRoute=currentRoute;
    if(browserHistory&&previousPath!==routePath(currentRoute))writeHistory("replaceState",currentRoute,{scroll:readScroll(),result:currentRoute.result||null});
    return viewName;
  }

  function replaceQuery(changes = {}, { apply = true } = {}) {
    if (!startDisposer) return false;
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
      committedRoute=currentRoute;
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
    if (!startDisposer) return;
    const ver=++restoreVer,found=resolveApplicationRoute(location,{basePath}),route=found.matched?found:pageRoute(fallbackView),entry=event?.state?.[HISTORY_STATE_KEY],token=routeVer+1;
    if(found.legacy||!found.matched)writeHistory("replaceState",route,{scroll:entry?.scroll||{x:0,y:0},result:entry?.result||null});
    const finish = () => {
      if(token!==routeVer)return;
      if(`${location.pathname}${location.search}`!==applicationRouteUrl(committedRoute,basePath))writeHistory("replaceState",committedRoute,{scroll:entry?.scroll||{x:0,y:0},result:committedRoute.result||null});
      restoreCurrentScroll(entry?.scroll,ver);
    };
    let applied;
    try{applied=applyRoute(route,{runEffects:true,resetScroll:false,result:entry?.result||null,source:"pop"})}catch{finish();return}
    if(applied&&typeof applied.finally==="function")void Promise.resolve(applied).then(finish,finish);else finish();
  }

  function onScroll(){if(!startDisposer||scrollFrame)return;scrollFrame=scheduleFrame(()=>{scrollFrame=0;captureScroll()})}
  function onScrollIntent(event) {
    if (
      event?.type === "keydown"
      && !["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "].includes(event.key)
    ) return;
    restoreVer += 1;
  }
  function restoreCurrentScroll(position = null, expectedVersion = ++restoreVer) {
    if (!startDisposer) return false;
    const saved=position||storedEntry()?.scroll||{x:0,y:0};
    const restore = () => {
      if (expectedVersion !== restoreVer) return;
      scrollTo({left:Math.max(0,Number(saved.x)||0),top:Math.max(0,Number(saved.y)||0),behavior:"auto"});
    };
    scheduleFrame(() => {
      if (expectedVersion !== restoreVer) return;
      scheduleFrame(() => {
        if (expectedVersion !== restoreVer) return;
        restore();scheduleTimer(restore,100);
      });
    });
    return true;
  }

  function start(handlers = {}, signal) {
    if (typeof handlers.enter !== "function" || typeof handlers.leave !== "function") throw new TypeError("requires enter and leave handlers");
    if (startDisposer) return startDisposer;
    if (signal?.aborted) throw new DOMException("", "AbortError");
    hooks = handlers;

    const resolved = browserHistory ? resolveApplicationRoute(location, { basePath }) : pageRoute(fallbackView);
    const initial = resolved.matched ? resolved : pageRoute(fallbackView);
    const existing = storedEntry();
    const result = existing?.result || null;
    if (browserHistory) {
      if ("scrollRestoration" in history) {
        savedScroll = history.scrollRestoration; history.scrollRestoration = "manual";
      }
      writeHistory("replaceState", initial, { scroll: existing?.scroll || readScroll(), result });
    }
    const dispose = () => {
      if (startDisposer !== dispose) return;
      restoreVer += 1; routeVer += 1;
      cancelScheduledWork();
      eventTarget?.removeEventListener?.("popstate", onPopState);
      eventTarget?.removeEventListener?.("scroll", onScroll);
      for (const eventName of INTENT_EVENTS) eventTarget?.removeEventListener?.(eventName, onScrollIntent);
      eventTarget?.removeEventListener?.("pagehide", captureScroll);
      if (browserHistory && "scrollRestoration" in history && savedScroll != null) {
        history.scrollRestoration = savedScroll;
      }
      abortSignal?.removeEventListener("abort", aborter);
      abortSignal = null; aborter = null; hooks = null; startDisposer = null;
    };
    startDisposer = dispose;
    if (browserHistory) {
      eventTarget?.addEventListener?.("popstate", onPopState);
      eventTarget?.addEventListener?.("scroll", onScroll, { passive: true });
      for (const eventName of INTENT_EVENTS) eventTarget?.addEventListener?.(eventName, onScrollIntent, { passive: eventName !== "keydown" });
      eventTarget?.addEventListener?.("pagehide", captureScroll);
    }
    if (signal) { abortSignal = signal; aborter = () => startDisposer?.(); signal.addEventListener("abort", aborter, { once: true }); }
    const initialResult = applyRoute(initial, { result, source: "initial" });
    if (browserHistory && routePath(initial) !== routePath(currentRoute)) writeHistory("replaceState", currentRoute, { scroll: existing?.scroll || readScroll(), result: currentRoute.result || null });
    if (initialResult && typeof initialResult.catch === "function") void initialResult.catch(() => {});
    return startDisposer;
  }

  return {
    start, switchView, restoreView, replaceQuery, openDetail, showList, backToList,
    showUnavailable, clearResult, activate, captureScroll, restoreCurrentScroll,
    currentView: () => currentView,
    currentRoute: () => ({ ...currentRoute, query: { ...currentRoute.query } })
  };
}
