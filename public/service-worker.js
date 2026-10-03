const CACHE_VERSION = "cike-shell-v0.6.0-experience-polish-1";
const SHELL_ASSETS = [
  "./",
  "index.html",
  "drift.css",
  "app.js",
  "manifest.webmanifest",
  "frontend/api/index.mjs",
  "frontend/app/bootstrap.mjs",
  "frontend/app/index.mjs",
  "frontend/app/runtime.mjs",
  "frontend/content/error-presentation.mjs",
  "frontend/content/index.mjs",
  "frontend/features/actions/index.mjs",
  "frontend/features/export/index.mjs",
  "frontend/features/feedback/index.mjs",
  "frontend/features/health/weight-batch.mjs",
  "frontend/features/home/index.mjs",
  "frontend/features/index.mjs",
  "frontend/features/keepsakes-media/index.mjs",
  "frontend/features/keepsakes-media/placement.mjs",
  "frontend/features/notifications/index.mjs",
  "frontend/features/onboarding-v2/index.mjs",
  "frontend/features/thought-discovery/annotation-tools.mjs",
  "frontend/features/thought-discovery/background-results.mjs",
  "frontend/features/thought-discovery/index.mjs",
  "frontend/media/index.mjs",
  "frontend/pages/index.mjs",
  "frontend/session/index.mjs",
  "frontend/state/index.mjs",
  "frontend/sync/index.mjs",
  "frontend/styles/application.css",
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
  "assets/home-v0.2/desktop-background.png",
  "assets/home-v0.2/mobile-background.png",
  "assets/home-v0.2/desktop-background.d55ffa4f0582.webp",
  "assets/home-v0.2/mobile-background.788fb03c2ae3.webp",
  "assets/home-v0.2/desktop-background.1408885ed7d3.avif",
  "assets/home-v0.2/mobile-background.0549e6676ea3.avif"
];
const NETWORK_ONLY_PATHS = ["/api/", "/attachments/", "/auth/", "/ai/"];
const DEFERRED_ASSET_SET = new Set(HOME_BACKGROUND_ASSETS);

const isNetworkOnly = url => NETWORK_ONLY_PATHS.some(segment => url.pathname.includes(segment));
const deferredAsset = url => [...DEFERRED_ASSET_SET].find(asset => url.pathname.endsWith(`/${asset}`));
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
  if (deferred) {
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
