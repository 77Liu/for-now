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
  "../features/export/index.mjs",
  "../features/feedback/index.mjs",
  "../features/legacy-pages/index.mjs",
  "../features/thought-discovery/index.mjs",
  "./ports.mjs"
]);
for (const specifier of dynamicSpecifiers) {
  assert.equal(
    dynamicImports.filter(value => value === specifier).length,
    specifier === "./ports.mjs" ? 1 : 2,
    `${specifier} must have one route-aware prefetch and one descriptor fallback`
  );
}
assert.deepEqual(analysis.surface.nonLiteralImports, []);

for (const specifier of dynamicSpecifiers) {
  assert.equal(
    analysis.surface.imports.some(entry => !entry.dynamic && entry.specifier === specifier),
    false,
    `${specifier} must not have an eager import`
  );
}
for (const removed of [
  "createDownloadDescriptor",
  "feedbackSubmissionPayload",
  "feedbackViewModel",
  "createThoughtDiscoveryController",
  "DISCOVERY_GENRES"
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
for (const [view, descriptor] of descriptors) {
  if (["export", "feedback", "discovery"].includes(view)) continue;
  assert.deepEqual(descriptor, {
    page: view,
    feature: "frontend.feature.legacy-pages",
    specifier: "../features/legacy-pages/index.mjs"
  });
}

for (const eagerEdge of [
  "./export/index.mjs",
  "./feedback/index.mjs",
  "./thought-discovery/index.mjs"
]) {
  assert.equal(featuresBarrel.includes(eagerEdge), false, `features barrel keeps eager edge ${eagerEdge}`);
}
for (const deferredF3Edge of ["./annotation-tools.mjs", "./background-results.mjs"]) {
  assert.equal(discoveryEntry.includes(deferredF3Edge), false, `discovery lazy entry includes ${deferredF3Edge}`);
}
for (const hiddenAsset of [
  "frontend/features/export/index.mjs",
  "frontend/features/feedback/index.mjs",
  "frontend/features/thought-discovery/index.mjs"
]) {
  const shellSource = serviceWorker.match(/const SHELL_ASSETS\s*=\s*\[([\s\S]*?)\];/)?.[1] || "";
  assert.equal(shellSource.includes(hiddenAsset), false, `service worker eagerly precaches ${hiddenAsset}`);
}

console.log("Frontend lazy descriptor regression passed: direct literal loaders, explicit legacy adapters, no eager barrel edges and no hidden feature precache.");
