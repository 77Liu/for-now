const CACHE_VERSION = "cike-shell-v0.5.8-7";
const SHELL_ASSETS = [
  "./",
  "index.html",
  "drift.css",
  "app.js",
  "manifest.webmanifest",
  "frontend/api/index.mjs",
  "frontend/app/application.mjs",
  "frontend/app/bootstrap.mjs",
  "frontend/app/index.mjs",
  "frontend/app/ports.mjs",
  "frontend/app/runtime.mjs",
  "frontend/feature-registry/index.mjs",
  "frontend/opening/config.mjs",
  "frontend/opening/controller.mjs",
  "frontend/opening/index.mjs",
  "frontend/opening/rain-engine.mjs",
  "frontend/content/index.mjs",
  "frontend/components/tag-multiselect/index.mjs",
  "frontend/features/actions/controller.mjs",
  "frontend/features/actions/index.mjs",
  "frontend/features/annotations/controller.mjs",
  "frontend/features/annotations/index.mjs",
  "frontend/features/annotations/model.mjs",
  "frontend/features/annotations/operations.mjs",
  "frontend/features/annotations/presentation.mjs",
  "frontend/features/annotations/view.mjs",
  "frontend/features/health/weight-batch.mjs",
  "frontend/features/home/index.mjs",
  "frontend/features/index.mjs",
  "frontend/features/legacy-pages/index.mjs",
  "frontend/features/keepsakes-media/index.mjs",
  "frontend/features/keepsakes-media/placement.mjs",
  "frontend/features/onboarding-v2/index.mjs",
  "frontend/features/thought-discovery/background-results.mjs",
  "frontend/media/index.mjs",
  "frontend/page-catalog/index.mjs",
  "frontend/pages/index.mjs",
  "frontend/session/index.mjs",
  "frontend/state/index.mjs",
  "frontend/sync/index.mjs",
  "frontend/styles/application.css",
  "frontend/styles/r8.css",
  "frontend/time/index.mjs",
  "assets/icons/apple-touch-icon.png",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png"
];
const KATEX_ASSETS = [
  "vendor/katex/katex.min.css",
  "vendor/katex/katex.min.js",
  "vendor/katex/fonts/KaTeX_AMS-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2",
  "vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2",
  "vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Main-Bold.woff2",
  "vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2",
  "vendor/katex/fonts/KaTeX_Main-Italic.woff2",
  "vendor/katex/fonts/KaTeX_Main-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2",
  "vendor/katex/fonts/KaTeX_Math-Italic.woff2",
  "vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2",
  "vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2",
  "vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Script-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Size1-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Size2-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Size3-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Size4-Regular.woff2",
  "vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2"
];
const HOME_BACKGROUND_ASSETS = [
  "assets/r8/app-background-desktop.png",
  "assets/r8/app-background-mobile.png",
  "assets/r8/bamboo-edge.png",
  "assets/r8/app-background-desktop.b96820a3fb80.webp",
  "assets/r8/app-background-mobile.22cba13ff0d1.webp",
  "assets/r8/bamboo-edge.5b2206eba5b8.webp",
  "assets/r8/app-background-desktop.f7a62027edd6.avif",
  "assets/r8/app-background-mobile.e8ad4d7f0f47.avif",
  "assets/r8/bamboo-edge.65e8fade3a25.avif"
];
const NETWORK_ONLY_PATHS = ["/api/", "/attachments/", "/auth/", "/ai/"];
const DEFERRED_ASSET_SET = new Set(HOME_BACKGROUND_ASSETS);
const LAZY_MODULE_PATHS = [
  "/frontend/features/export/",
  "/frontend/features/feedback/",
  "/frontend/features/notifications/",
  "/frontend/features/thought-discovery/"
];

const isNetworkOnly = url => NETWORK_ONLY_PATHS.some(segment => url.pathname.includes(segment));
const deferredAsset = url => [...DEFERRED_ASSET_SET].find(asset => url.pathname.endsWith(`/${asset}`));
const lazyModule = url => LAZY_MODULE_PATHS.some(segment => url.pathname.includes(segment));
const cacheOnUse = async request => {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
};

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll([...SHELL_ASSETS, ...KATEX_ASSETS])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isNetworkOnly(url)) return;
  const deferred = deferredAsset(url);
  if (deferred || lazyModule(url)) {
    event.respondWith(cacheOnUse(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_VERSION);
        return cache.match("./");
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
