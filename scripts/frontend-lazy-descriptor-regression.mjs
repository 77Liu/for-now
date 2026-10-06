import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { analyzeEntrypointSource } from "./lib/entrypoint-source-analysis.mjs";
import { viewSections } from "../public/frontend/pages/index.mjs";

const runtime = await fs.readFile(
  new URL("../public/frontend/app/runtime.mjs", import.meta.url),
  "utf8"
);
const featuresBarrel = await fs.readFile(
  new URL("../public/frontend/features/index.mjs", import.meta.url),
  "utf8"
);
const discoveryEntry = await fs.readFile(
  new URL("../public/frontend/features/thought-discovery/index.mjs", import.meta.url),
  "utf8"
);
const serviceWorker = await fs.readFile(
  new URL("../public/service-worker.js", import.meta.url),
  "utf8"
);
const boundaries = JSON.parse(await fs.readFile(
  new URL("../knowledge/module-boundaries.json", import.meta.url),
  "utf8"
));

const analysis = analyzeEntrypointSource(runtime, "public/frontend/app/runtime.mjs", []);
const dynamicImports = analysis.surface.imports
  .filter(entry => entry.dynamic)
  .map(entry => entry.specifier);
const dynamicSpecifiers = [...new Set(dynamicImports)].sort();
assert.deepEqual(dynamicSpecifiers, [
  "../features/account-settings/loader.mjs",
  "../features/actions/controller.mjs",
  "../features/annotations/index.mjs",
  "../features/background-results/index.mjs",
  "../features/capture-journal/index.mjs",
  "../features/export/index.mjs",
  "../features/feedback/index.mjs",
  "../features/health/controller.mjs",
  "../features/keepsakes/index.mjs",
  "../features/legacy-pages/index.mjs",
  "../features/library/index.mjs",
  "../features/mine-shell/index.mjs",
  "../features/notifications/index.mjs",
  "../features/owner-console/loader.mjs",
  "../features/personal-context/loader.mjs",
  "../features/quotes/index.mjs",
  "../features/review-insights/index.mjs",
  "../features/thought-discovery/index.mjs",
  "../features/thoughts/index.mjs",
  "../features/trash/loader.mjs",
  "../media/content-image-drafts.mjs",
  "./ports.mjs"
]);
for (const specifier of dynamicSpecifiers) {
  assert.equal(
    dynamicImports.filter(value => value === specifier).length,
    ["./ports.mjs", "../features/actions/controller.mjs", "../features/annotations/index.mjs", "../features/background-results/index.mjs", "../features/health/controller.mjs", "../features/owner-console/loader.mjs", "../media/content-image-drafts.mjs"]
      .includes(specifier) ? 1 : 2,
    `${specifier} must have one route-aware prefetch and one descriptor fallback`
  );
}
assert.match(
  runtime,
  /annotationsFeatureModuleRequest===pending\)annotationsFeatureModuleRequest=null/,
  "annotations loader must clear a rejected import so the next session can retry"
);
assert.match(
  runtime,
  /backgroundResultsFeatureModuleRequest===pending\)backgroundResultsFeatureModuleRequest=null/,
  "background results loader must clear a rejected import so polling can retry"
);
assert.match(
  runtime,
  /backgroundResultsRetryAttempts>0&&backgroundResultsRetryAttempts<BACKGROUND_RESULTS_RETRY_LIMIT/,
  "the final completed task must retain a bounded poll after lazy-load failure"
);
assert.match(
  runtime,
  /controller\.needsRetry\(\)\?Math\.min\(BACKGROUND_RESULTS_RETRY_LIMIT,backgroundResultsRetryAttempts\+1\):0/,
  "transient result reads must retain the same bounded retry path"
);
const shellMountSource = runtime.slice(
  runtime.indexOf("function createRuntimeApplicationPorts"),
  runtime.indexOf("async function restartApplicationForUser")
);
assert.doesNotMatch(
  shellMountSource,
  /await\s+ensureAnnotationsController\(\)/,
  "annotations import failure must not block application startup"
);
assert.match(
  runtime,
  /error=>\{if\(current\(\)\)showToast\(`批注功能加载失败/,
  "stale annotation imports must not report into a later session"
);
assert.match(
  runtime,
  /annotationsController\?\.activeRootKey\(\)\.startsWith\("book:"\)/,
  "state updates must tolerate an unavailable annotations module"
);
assert.deepEqual(analysis.surface.nonLiteralImports, []);

for (const specifier of dynamicSpecifiers) {
  assert.equal(
    analysis.surface.imports.some(entry => !entry.dynamic && entry.specifier === specifier),
    false,
    `${specifier} must not have an eager import`
  );
}
assert.equal(
  analysis.surface.imports.some(entry => !entry.dynamic && entry.specifier === "../features/checkins/index.mjs"),
  true,
  "the default-route checkins controller must stay in the static runtime closure"
);
assert.match(
  runtime,
  /createFile:\(blob,name,options\)=>new File\(\[blob\],name,options\)/,
  "restored keepsake Files must preserve the complete FilePropertyBag"
);
for (const removed of [
  "renderActionsWorkspace",
  "runActionCommand",
  "createDownloadDescriptor",
  "feedbackSubmissionPayload",
  "feedbackViewModel",
  "createThoughtDiscoveryController",
  "DISCOVERY_GENRES",
  "function renderBooks(",
  "function renderQuotes(",
  "function renderQuoteSky(",
  "const bookImageUi=",
  "function renderReview(",
  "function renderStatistics(",
  "function loadStatistics(",
  "analysisRequestSerial",
  "function renderKeepsakes(",
  "function renderKeepsakeDetail(",
  "function segmentCurrentKeepsake(",
  "keepsakeBatchPersistTimer",
  "function renderMine(",
  "function renderPersonalContext(",
  "function loadPersonalContext(",
  "function renderAccountUsers(",
  "function loadAccountUsers(",
  "function renderTrash(",
  "function loadTrash(",
  "aiCostRequestSerial",
  "architectureRequestSerial",
  "commercialRequestSerial"
]) {
  assert.equal(runtime.includes(removed), false, `legacy F2 symbol remains in runtime: ${removed}`);
}

const browserPolicy = boundaries.entrypointPolicies.find(policy => policy.kind === "browser");
const descriptors = new Map(
  browserPolicy.pageFeatureDescriptors.map(descriptor => [descriptor.page, descriptor])
);
assert.deepEqual([...descriptors.keys()].sort(), Object.keys(viewSections).sort());
assert.deepEqual(descriptors.get("export"), {
  page: "export",
  feature: "frontend.feature.export",
  specifier: "../features/export/index.mjs"
});
assert.deepEqual(descriptors.get("feedback"), {
  page: "feedback",
  feature: "frontend.feature.feedback",
  specifier: "../features/feedback/index.mjs"
});
assert.deepEqual(descriptors.get("discovery"), {
  page: "discovery",
  feature: "frontend.feature.discovery",
  specifier: "../features/thought-discovery/index.mjs"
});
assert.deepEqual(descriptors.get("notifications"), {
  page: "notifications",
  feature: "frontend.feature.notifications",
  specifier: "../features/notifications/index.mjs"
});
assert.deepEqual(descriptors.get("quotes"), {
  page: "quotes",
  feature: "frontend.feature.quotes",
  specifier: "../features/quotes/index.mjs"
});
assert.deepEqual(descriptors.get("books"), {
  page: "books",
  feature: "frontend.feature.library",
  specifier: "../features/library/index.mjs"
});
assert.deepEqual(descriptors.get("keepsakes"), {
  page: "keepsakes",
  feature: "frontend.feature.keepsakes",
  specifier: "../features/keepsakes/index.mjs"
});
assert.deepEqual(descriptors.get("daily"), {
  page: "daily",
  feature: "frontend.feature.health",
  specifier: "../features/health/controller.mjs"
});
for (const view of ["thoughts", "together"]) {
  assert.deepEqual(descriptors.get(view), {
    page: view,
    feature: "frontend.feature.thoughts",
    specifier: "../features/thoughts/index.mjs"
  });
}
for (const view of ["captures", "journals"]) {
  assert.deepEqual(descriptors.get(view), {
    page: view,
    feature: "frontend.feature.capture-journal",
    specifier: "../features/capture-journal/index.mjs"
  });
}
assert.deepEqual(descriptors.get("today"), {
  page: "today",
  feature: "frontend.feature.checkins",
  specifier: "../features/checkins/index.mjs"
});
for (const view of ["review", "statistics"]) {
  assert.deepEqual(descriptors.get(view), {
    page: view,
    feature: "frontend.feature.review-insights",
    specifier: "../features/review-insights/index.mjs"
  });
}
for (const view of ["mine", "permission", "about"]) {
  assert.deepEqual(descriptors.get(view), {
    page: view,
    feature: "frontend.feature.mine-shell",
    specifier: "../features/mine-shell/index.mjs"
  });
}
assert.deepEqual(descriptors.get("personal-context"), {
  page: "personal-context",
  feature: "frontend.feature.personal-context-loader",
  specifier: "../features/personal-context/loader.mjs"
});
for (const view of ["ai-cost", "architecture", "commercialization"]) {
  assert.deepEqual(descriptors.get(view), {
    page: view,
    feature: "frontend.feature.owner-console-loader",
    specifier: "../features/owner-console/loader.mjs"
  });
}
for (const view of ["account", "settings"]) {
  assert.deepEqual(descriptors.get(view), {
    page: view,
    feature: "frontend.feature.account-settings-loader",
    specifier: "../features/account-settings/loader.mjs"
  });
}
assert.deepEqual(descriptors.get("trash"), {
  page: "trash",
  feature: "frontend.feature.trash-loader",
  specifier: "../features/trash/loader.mjs"
});
for (const [view, descriptor] of descriptors) {
  if (["today", "review", "statistics", "daily", "captures", "journals", "books", "keepsakes", "quotes", "thoughts", "together", "export", "feedback", "discovery", "notifications", "mine", "permission", "about", "personal-context", "ai-cost", "architecture", "commercialization", "account", "settings", "trash"].includes(view)) continue;
  assert.deepEqual(descriptor, {
    page: view,
    feature: "frontend.feature.legacy-pages",
    specifier: "../features/legacy-pages/index.mjs"
  });
}

for (const eagerEdge of [
  "./actions/controller.mjs",
  "./annotations/index.mjs",
  "./background-results/index.mjs",
  "./capture-journal/index.mjs",
  "./export/index.mjs",
  "./feedback/index.mjs",
  "./keepsakes/index.mjs",
  "./library/index.mjs",
  "./notifications/index.mjs",
  "./quotes/index.mjs",
  "./thought-discovery/index.mjs",
  "./thoughts/index.mjs"
]) {
  assert.equal(featuresBarrel.includes(eagerEdge), false, `features barrel keeps eager edge ${eagerEdge}`);
}
for (const deferredF3Edge of ["./annotation-tools.mjs", "./background-results.mjs"]) {
  assert.equal(discoveryEntry.includes(deferredF3Edge), false, `discovery lazy entry includes ${deferredF3Edge}`);
}
for (const hiddenAsset of [
  "frontend/features/account-settings/loader.mjs",
  "frontend/features/background-results/index.mjs",
  "frontend/features/capture-journal/index.mjs",
  "frontend/features/export/index.mjs",
  "frontend/features/feedback/index.mjs",
  "frontend/features/health/controller.mjs",
  "frontend/features/keepsakes/index.mjs",
  "frontend/features/library/index.mjs",
  "frontend/features/mine-shell/index.mjs",
  "frontend/features/notifications/index.mjs",
  "frontend/features/owner-console/loader.mjs",
  "frontend/features/personal-context/loader.mjs",
  "frontend/features/quotes/index.mjs",
  "frontend/features/review-insights/index.mjs",
  "frontend/features/thought-discovery/index.mjs",
  "frontend/features/thoughts/index.mjs",
  "frontend/features/trash/loader.mjs"
]) {
  const shellSource = serviceWorker.match(/const SHELL_ASSETS\s*=\s*\[([\s\S]*?)\];/)?.[1] || "";
  assert.equal(shellSource.includes(hiddenAsset), false, `service worker eagerly precaches ${hiddenAsset}`);
}

console.log("Frontend lazy descriptor regression passed: direct literal loaders, explicit legacy adapters, no eager barrel edges and no hidden feature precache.");
