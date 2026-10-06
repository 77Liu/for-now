import { createFeatureRegistry } from "../feature-registry/index.mjs";
import * as checkinsFeature from "../features/checkins/index.mjs";
import { viewSections } from "../pages/index.mjs";
import { createBrowserApplication } from "./application.mjs";

const runtimeModuleRequest = globalThis.__forNowRuntimeKernelRequest || import("./runtime/kernel.mjs");
delete globalThis.__forNowRuntimeKernelRequest;
const featureModules = Object.freeze({
  accountSettings: () => import("../features/account-settings/loader.mjs"),
  actions: () => import("../features/actions/controller.mjs"),
  annotations: () => import("../features/annotations/index.mjs"),
  backgroundResults: () => import("../features/background-results/index.mjs"),
  captureJournal: () => import("../features/capture-journal/index.mjs"),
  checkins: () => Promise.resolve(checkinsFeature),
  discovery: () => import("../features/thought-discovery/index.mjs"),
  export: () => import("../features/export/index.mjs"),
  feedback: () => import("../features/feedback/index.mjs"),
  health: () => import("../features/health/controller.mjs"),
  keepsakes: () => import("../features/keepsakes/index.mjs"),
  library: () => import("../features/library/index.mjs"),
  mineShell: () => import("../features/mine-shell/index.mjs"),
  notifications: () => import("../features/notifications/index.mjs"),
  ownerConsole: () => import("../features/owner-console/loader.mjs"),
  personalContext: () => import("../features/personal-context/loader.mjs"),
  quotes: () => import("../features/quotes/index.mjs"),
  reviewInsights: () => import("../features/review-insights/index.mjs"),
  thoughts: () => import("../features/thoughts/index.mjs"),
  trash: () => import("../features/trash/loader.mjs")
});

export async function startApplication(initial = null, { opening = null } = {}) {
  const { createRuntimeComposition } = await runtimeModuleRequest;
  const composition = await createRuntimeComposition(initial, {
    opening,
    featureModules,
    expectedViews: Object.keys(viewSections)
  });
  const featureRegistry = createFeatureRegistry({
    descriptors: composition.descriptors,
    onFailure: composition.onFeatureFailure
  });
  const application = createBrowserApplication({
    router: composition.router,
    featureRegistry,
    session: composition.sessionPort,
    state: composition.statePort,
    sync: composition.syncPort,
    shell: composition.shellPort
  });
  composition.connect({ application, featureRegistry });
  const startPromise = application.start(composition.startInput);
  return composition.complete(startPromise);
}
