import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHomeFeatureController } from "../public/frontend/features/home/index.mjs";
import { analyzeEntrypointSource } from "./lib/entrypoint-source-analysis.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = relativePath => fs.readFile(path.join(root, relativePath), "utf8");
const lines = source => source.trimEnd().split(/\r\n|\r|\n/u).length;

const boundaries = JSON.parse(await read("knowledge/module-boundaries.json"));
const policy = boundaries.entrypointPolicies.find(item => item.kind === "browser");
const runtime = await read(policy.path);
const analysis = analyzeEntrypointSource(runtime, policy.path, policy.forbiddenRules);

assert.ok(lines(runtime) <= policy.lineLimits.hard, "browser entrypoint exceeds the G6 hard limit");
assert.deepEqual(analysis.violations, [], "browser entrypoint contains non-composition behavior");
assert.deepEqual(
  analysis.surface.exports.map(item => item.name).sort(),
  ["startApplication"]
);
assert.equal(boundaries.entrypointMigrationExceptions.length, 0);
assert.equal(policy.pageFeatureDescriptors.length, policy.expectedPages.length);
assert.deepEqual(
  policy.pageFeatureDescriptors.map(item => item.page).sort(),
  [...policy.expectedPages].sort()
);
assert.equal(
  policy.pageFeatureDescriptors.some(item => item.feature.includes("legacy")),
  false
);

const runtimeModules = [
  "public/frontend/app/runtime/collaboration-runtime.mjs",
  "public/frontend/app/runtime/content-media-runtime.mjs",
  "public/frontend/app/runtime/data-runtime.mjs",
  "public/frontend/app/runtime/durable-form-drafts.mjs",
  "public/frontend/app/runtime/global-events.mjs",
  "public/frontend/app/runtime/home-chat-renderer.mjs",
  "public/frontend/app/runtime/home-checkin-renderer.mjs",
  "public/frontend/app/runtime/home-runtime.mjs",
  "public/frontend/app/runtime/home-selection-quote-modal.mjs",
  "public/frontend/app/runtime/kernel.mjs",
  "public/frontend/app/runtime/loaders.mjs",
  "public/frontend/app/runtime/page-descriptors-account.mjs",
  "public/frontend/app/runtime/page-descriptors-insights.mjs",
  "public/frontend/app/runtime/page-descriptors-primary.mjs",
  "public/frontend/app/runtime/page-descriptors.mjs",
  "public/frontend/app/runtime/session-runtime.mjs",
  "public/frontend/app/runtime/startup-timing.mjs",
  "public/frontend/app/runtime/thought-draft-tag-composer.mjs"
];
for (const modulePath of runtimeModules) {
  const source = await read(modulePath);
  assert.ok(lines(source) <= 500, `${modulePath} exceeds the 500-line owner limit`);
  assert.equal(source.includes("legacy-pages"), false, `${modulePath} depends on legacy pages`);
}

const dynamicImports = analysis.surface.imports
  .filter(item => item.dynamic)
  .map(item => item.specifier)
  .sort();
assert.deepEqual(dynamicImports, [
  "../features/account-settings/loader.mjs",
  "../features/actions/controller.mjs",
  "../features/annotations/index.mjs",
  "../features/background-results/index.mjs",
  "../features/capture-journal/index.mjs",
  "../features/export/index.mjs",
  "../features/feedback/index.mjs",
  "../features/health/controller.mjs",
  "../features/keepsakes/index.mjs",
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
  "./runtime/kernel.mjs"
]);

const loaderSource = await read("public/frontend/app/runtime/loaders.mjs");
for (const name of [
  "accountSettings",
  "annotations",
  "backgroundResults",
  "captureJournal",
  "health",
  "keepsakes",
  "library",
  "mineShell",
  "ownerConsole",
  "personalContext",
  "quotes",
  "reviewInsights",
  "thoughts",
  "trash"
]) {
  assert.ok(loaderSource.includes(`${name}: () => retryable("${name}")`));
}
assert.match(loaderSource, /if \(requests\[name\] === pending\) requests\[name\] = null/);

const bootstrap = await read("public/frontend/app/bootstrap.mjs");
const serviceWorker = await read("public/service-worker.js");
assert.equal(bootstrap.includes("LegacyFeature"), false);
assert.equal(serviceWorker.includes("features/legacy-pages"), false);
for (const modulePath of runtimeModules) {
  assert.ok(
    serviceWorker.includes(modulePath.replace(/^public\//u, "")),
    `service worker does not cache ${modulePath}`
  );
}

{
  const summary = { textContent: "" };
  const details = {
    open: true,
    addEventListener() {},
    removeEventListener() {}
  };
  const rootElement = {
    querySelector(selector) {
      if (selector === "#actions-summary") return summary;
      if (selector === ".home-v02-secondary") return details;
      return null;
    }
  };
  const actionSnapshot = {
    actions: [{ id: "a1" }],
    habits: [],
    habitCheckins: [],
    today: "2026-10-06"
  };
  const rendered = [];
  let allowed = false;
  let loads = 0;
  const controller = createHomeFeatureController({
    coordinator: {
      load: async () => {
        loads += 1;
        return true;
      },
      subscribe(listener) {
        listener(actionSnapshot);
        return () => {};
      },
      viewModel(snapshot) {
        return {
          summary: {
            openActions: snapshot.actions.length,
            checkedToday: snapshot.habitCheckins.length,
            activeHabits: snapshot.habits.length
          }
        };
      },
      resetSession() {}
    },
    canLoad: () => allowed,
    loadWorkspace: async () => ({
      createActionsFeatureController: () => ({
        mount() {},
        render(context) {
          rendered.push(context);
          return true;
        },
        unmount() {},
        resetSession() {}
      })
    })
  });
  const activation = new AbortController();
  await controller.mount({ root: rootElement, signal: activation.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.render({
    snapshot: { actions: [], habits: [], habitCheckins: [] },
    changedDomains: ["actions"]
  }), false);
  assert.equal(loads, 0);
  assert.equal(rendered.length, 0);
  await controller.unmount();

  allowed = true;
  await controller.mount({ root: rootElement, signal: activation.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.render({
    snapshot: { actions: [], habits: [], habitCheckins: [] },
    changedDomains: ["actions"]
  });
  assert.equal(summary.textContent, "1 项待推进 · 0/0 个习惯已打卡");
  assert.equal(loads, 1);
  assert.equal(rendered.length, 2);
  assert.equal(rendered.every(context => context?.snapshot === undefined), true);
  await controller.unmount();
}

console.log(
  `Frontend F10 composition checks passed: ${lines(runtime)}-line entrypoint, `
  + `${policy.expectedPages.length} explicit page descriptors, zero G6 exceptions, `
  + `${runtimeModules.length} bounded runtime owners.`
);
