const sections = Object.freeze({
  today: "today", together: "today", daily: "today", captures: "seen", books: "seen", quotes: "seen", keepsakes: "seen", journals: "thought", thoughts: "thought", discovery: "thought", review: "thought", mine: "mine", "personal-context": "mine", statistics: "mine", "ai-cost": "mine", architecture: "mine", commercialization: "mine", feedback: "mine", export: "mine", notifications: "mine", trash: "mine", permission: "mine", account: "mine", settings: "mine",
  about: "mine"
});
export { sections as viewSections };

export const ownerViewCapabilities = Object.freeze({
  "ai-cost": "ai-costs", architecture: "architecture", commercialization: "commercialization"
});

const paths = Object.freeze({
  today: "/today", together: "/today/together", daily: "/today/daily", captures: "/seen/captures", books: "/seen/books", quotes: "/seen/quotes", keepsakes: "/seen/keepsakes", journals: "/journals", thoughts: "/thoughts", discovery: "/thoughts/discovery", review: "/review", mine: "/mine", "personal-context": "/mine/personal-context", statistics: "/mine/statistics", "ai-cost": "/owner/ai-cost", architecture: "/owner/architecture", commercialization: "/owner/commercialization", feedback: "/mine/feedback", export: "/mine/export", notifications: "/mine/notifications", trash: "/mine/trash", permission: "/permission", account: "/mine/account", settings: "/mine/settings",
  about: "/mine/about"
});
export { paths as canonicalPagePaths };

const routes=new Map(Object.entries(paths).map(([view, pathname]) => [pathname, view]));
const oldRoutes = new Map([["/now", "today"], ...Object.keys(sections).map(view => [`/view/${view}`, view]), ...Object.keys(sections).filter(view => paths[view] !== `/${view}`).map(view => [`/${view}`, view])]);

function normalizedPathname(value) { const path=`/${String(value||"/").replace(/^\/+|\/+$/g,"")}`;return path==="/"?path:path.replace(/\/+$/,""); }
function normalizedBasePath(value) { const path=normalizedPathname(value);return path==="/"?"":path; }
function pathInsideBase(pathname,basePath) { const path=normalizedPathname(pathname),base=normalizedBasePath(basePath);return !base?path:path===base?"/":path.startsWith(`${base}/`)?path.slice(base.length)||"/":null; }
function safeDecode(value) { try{return decodeURIComponent(value)}catch{return""} }
function legacyView(params,hash) { const query=params.get("view");if(sections[query])return query;const fragment=String(hash||"").replace(/^#/,""),view=fragment.startsWith("view=")?fragment.slice(5):fragment;return sections[view]?view:""; }

export function normalizeRouteQuery(view, input = {}) {
  if (view !== "thoughts") return {};
  const params=input instanceof URLSearchParams?input:new URLSearchParams(Object.entries(input||{}).filter(([,entry])=>entry!=null&&entry!==""));
  const tag=String(params.get("tag")||"").normalize("NFKC").trim().replace(/[\u0000-\u001f\u007f]/g,"").slice(0,30),q=String(params.get("q")||"").normalize("NFKC").trim().replace(/\s+/g," ").replace(/[\u0000-\u001f\u007f]/g,"").slice(0,200),sort=params.get("sort")==="created"?"created":"occurred",pageValue=params.get("page"),page=pageValue==null?1:(Number.isInteger(Number(pageValue))?Number(pageValue):pageValue);
  return {...tag&&tag!=="all"?{tag}:{},...q?{q}:{},...sort!=="occurred"?{sort}:{},...(page!==1||(params.has("page")&&(params.has("cursor")||params.has("direction"))))?{page}:{},...params.has("cursor")?{cursor:params.get("cursor")}:{},...params.has("direction")?{direction:params.get("direction")}:{}};
}

function queryString(view, query) {
  const value=normalizeRouteQuery(view,query),params=new URLSearchParams();
  if(value.tag)params.set("tag",value.tag);if(value.q)params.set("q",value.q);if(value.sort)params.set("sort",value.sort);if(value.page)params.set("page",String(value.page));if(value.cursor!=null)params.set("cursor",value.cursor);if(value.direction)params.set("direction",value.direction);
  const queryValue=params.toString();return queryValue?`?${queryValue}`:"";
}

export function pageRoute(view, query = {}) {
  const safeView = sections[view] ? view : "today";
  return { kind: "page", view: safeView, resourceType: "", resourceId: "", query: normalizeRouteQuery(safeView, query) };
}

export function detailRoute(resourceType, resourceId, query = {}) {
  const id = String(resourceId || "").trim().slice(0, 200);
  if (resourceType !== "thought-chain" || !id || /[\/\u0000-\u001f\u007f]/.test(id)) return pageRoute("thoughts", query);
  return { kind: "detail", view: "thoughts", resourceType, resourceId: id, query: normalizeRouteQuery("thoughts", query) };
}

export function routePath(route) {
  const value = route?.kind === "detail"
    ? detailRoute(route.resourceType, route.resourceId, route.query)
    : pageRoute(route?.view, route?.query);
  const pathname = value.kind === "detail" ? `/thoughts/${encodeURIComponent(value.resourceId)}` : paths[value.view];
  return `${pathname}${queryString(value.view, value.query)}`;
}

export function applicationRouteUrl(route, basePath = "/") {
  const base = normalizedBasePath(basePath); return `${base}${routePath(route)}` || "/";
}

export function resolveApplicationRoute(input, { basePath = "/" } = {}) {
  const location = input instanceof URL ? input : new URL(`${input?.pathname || "/"}${input?.search || ""}${input?.hash || ""}`, "http://route.local");
  const pathname = pathInsideBase(location.pathname, basePath);
  const fallback = pageRoute("today");
  if (pathname == null) return { ...fallback, matched: false, legacy: false };

  const searchParams = new URLSearchParams(location.search);
  let view = routes.get(pathname);
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
      view = oldRoutes.get(pathname);
      if (!view && pathname === "/") view = legacyView(searchParams, location.hash) || "today";
      if (!view) return { ...fallback, matched: false, legacy: false };
      route = pageRoute(view, searchParams);
      legacy = pathname !== paths[view] || searchParams.has("view") || Boolean(location.hash);
    }
  }
  const url = applicationRouteUrl(route, basePath);
  return { ...route, matched: true, legacy: legacy || `${location.pathname}${location.search}` !== url, canonicalUrl: url };
}

export function isApplicationRoutePath(pathname) { return resolveApplicationRoute({ pathname }, { basePath: "/" }).matched; }

export function createUnavailableRouteResult({ resourceType, resourceId, view = "thoughts" }) {
  const safeView = sections[view] ? view : "today";
  return { data: null, error: { code: "RESOURCE_UNAVAILABLE", message: resourceType === "thought-chain" ? "这条思绪已不可用" : "这个对象已不可用", details: { resourceType: String(resourceType || "resource"), resourceId: String(resourceId || "") } }, meta: { fallback: { view: safeView, path: paths[safeView] } } };
}
