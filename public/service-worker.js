importScripts("./release-info.js");

const CACHE_VERSION = globalThis.CIKE_RELEASE_INFO.cacheVersion;
const SHELL_ASSETS = [
  "./",
  "index.html",
  "release-info.js",
  "drift.css",
  "app.js",
  "manifest.webmanifest",
  "frontend/api/index.mjs",
  "frontend/app/application.mjs",
  "frontend/app/bootstrap.mjs",
  "frontend/app/index.mjs",
  "frontend/app/ports.mjs",
  "frontend/app/runtime.mjs",
  "frontend/app/runtime/auth-events.mjs",
  "frontend/app/runtime/collaboration-runtime.mjs",
  "frontend/app/runtime/content-media-runtime.mjs",
  "frontend/app/runtime/data-runtime.mjs",
  "frontend/app/runtime/durable-form-drafts.mjs",
  "frontend/app/runtime/global-events.mjs",
  "frontend/app/runtime/home-chat-renderer.mjs",
  "frontend/app/runtime/home-checkin-renderer.mjs",
  "frontend/app/runtime/home-runtime.mjs",
  "frontend/app/runtime/home-selection-quote-modal.mjs",
  "frontend/app/runtime/kernel.mjs",
  "frontend/app/runtime/loaders.mjs",
  "frontend/app/runtime/onboarding-events.mjs",
  "frontend/app/runtime/page-descriptors-account.mjs",
  "frontend/app/runtime/page-descriptors-insights.mjs",
  "frontend/app/runtime/page-descriptors-primary.mjs",
  "frontend/app/runtime/page-descriptors.mjs",
  "frontend/app/runtime/session-runtime.mjs",
  "frontend/app/runtime/startup-timing.mjs",
  "frontend/app/runtime/thought-draft-tag-composer.mjs",
  "frontend/components/occurrence-control/index.mjs",
  "frontend/feature-registry/index.mjs",
  "frontend/shared/opening/index.mjs",
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
  "frontend/features/checkins-model/index.mjs",
  "frontend/features/checkins/controller.mjs",
  "frontend/features/checkins/index.mjs",
  "frontend/features/checkins/presentation.mjs",
  "frontend/features/home/controller.mjs",
  "frontend/features/home/index.mjs",
  "frontend/features/index.mjs",
  "frontend/features/keepsakes-media/index.mjs",
  "frontend/features/keepsakes-media/placement.mjs",
  "frontend/features/onboarding-v2/index.mjs",
  "frontend/media/content-image-draft-model.mjs",
  "frontend/media/content-image-drafts.mjs",
  "frontend/media/index.mjs",
  "frontend/media/page-audio.mjs",
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
  "/frontend/features/account-settings/",
  "/frontend/features/export/",
  "/frontend/features/feedback/",
  "/frontend/features/background-results/",
  "/frontend/features/capture-journal/",
  "/frontend/features/health/",
  "/frontend/features/keepsakes/",
  "/frontend/features/library/",
  "/frontend/features/mine-shell/",
  "/frontend/features/notifications/",
  "/frontend/features/owner-console/",
  "/frontend/features/personal-context/",
  "/frontend/features/quotes/",
  "/frontend/features/review-insights/",
  "/frontend/features/thought-discovery/",
  "/frontend/features/thoughts/",
  "/frontend/features/trash/"
];

const isNetworkOnly = url => NETWORK_ONLY_PATHS.some(segment => url.pathname.includes(segment));
const deferredAsset = url => [...DEFERRED_ASSET_SET].find(asset => url.pathname.endsWith(`/${asset}`));
const lazyModule = url => LAZY_MODULE_PATHS.some(segment => url.pathname.includes(segment));
const refreshReleaseInfo = async request => {
  const cached = await caches.match(request);
  try {
    const response = await fetch(request);
    if (!response.ok && cached) return cached;
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
};
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
  if (url.pathname.endsWith("/release-info.js")) {
    event.respondWith(refreshReleaseInfo(request));
    return;
  }
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
