const RETRYABLE_LOADERS = Object.freeze({
  accountSettings: "__forNowAccountSettingsFeatureRequest",
  annotations: "__forNowAnnotationsFeatureRequest",
  backgroundResults: "__forNowBackgroundResultsFeatureRequest",
  captureJournal: "__forNowCaptureJournalFeatureRequest",
  health: "__forNowHealthFeatureRequest",
  keepsakes: "__forNowKeepsakesFeatureRequest",
  library: "__forNowLibraryFeatureRequest",
  mineShell: "__forNowMineShellFeatureRequest",
  ownerConsole: "__forNowOwnerConsoleFeatureRequest",
  personalContext: "__forNowPersonalContextFeatureRequest",
  quotes: "__forNowQuotesFeatureRequest",
  reviewInsights: "__forNowReviewInsightsFeatureRequest",
  thoughts: "__forNowThoughtsFeatureRequest",
  trash: "__forNowTrashFeatureRequest"
});

const DIRECT_LOADERS = Object.freeze({
  discovery: "__forNowDiscoveryFeatureRequest",
  export: "__forNowExportFeatureRequest",
  feedback: "__forNowFeedbackFeatureRequest",
  notifications: "__forNowNotificationsFeatureRequest"
});

export function createRuntimeFeatureLoaders({
  featureModules,
  prefetched = globalThis
} = {}) {
  if (!featureModules || typeof featureModules !== "object") {
    throw new TypeError("Runtime feature modules are required");
  }
  const requests = {};
  for (const [name, globalName] of Object.entries(RETRYABLE_LOADERS)) {
    requests[name] = prefetched[globalName] || null;
  }
  for (const [name, globalName] of Object.entries(DIRECT_LOADERS)) {
    requests[name] = prefetched[globalName] || null;
  }

  const retryable = name => {
    const pending = requests[name] || featureModules[name]();
    requests[name] = pending;
    return Promise.resolve(pending).catch(error => {
      if (requests[name] === pending) requests[name] = null;
      throw error;
    });
  };
  const direct = name => requests[name] || featureModules[name]();

  return Object.freeze({
    actions: () => featureModules.actions(),
    accountSettings: () => retryable("accountSettings"),
    annotations: () => retryable("annotations"),
    backgroundResults: () => retryable("backgroundResults"),
    captureJournal: () => retryable("captureJournal"),
    checkins: () => featureModules.checkins(),
    discovery: () => direct("discovery"),
    export: () => direct("export"),
    feedback: () => direct("feedback"),
    health: () => retryable("health"),
    keepsakes: () => retryable("keepsakes"),
    library: () => retryable("library"),
    mineShell: () => retryable("mineShell"),
    notifications: () => direct("notifications"),
    ownerConsole: () => retryable("ownerConsole"),
    personalContext: () => retryable("personalContext"),
    quotes: () => retryable("quotes"),
    reviewInsights: () => retryable("reviewInsights"),
    thoughts: () => retryable("thoughts"),
    trash: () => retryable("trash")
  });
}

// 仅模拟配置下加载测试适配器；正常运行只连接无副作用的接口。
/** 条件连接独立测试适配器；非模拟模式不加载，旧会话的迟到加载不发起请求。 @since unreleased */
export function createTestSupportBridge(ports) {
  let adapter=null, loading=null, epoch=0;
  return {
    async ensureView(view) {
      if(ports.getControl()?.mode!=="simulation")return true;
      const owner=ports.getOwner(), session=ports.getSession(), generation=epoch;
      const current=()=>owner===ports.getOwner()&&session===ports.getSession()
        &&generation===epoch&&ports.getControl()?.mode==="simulation";
      try {
        if(!adapter){
          loading||=import("../../../generated/test-support/view-scope.mjs")
            .then(module=>adapter=module.createViewScopeSupport(ports)).finally(()=>{loading=null});
          await loading
        }
        if(!current())return false;
        return adapter.ensureView(view)
      } catch(error) {
        if(current())ports.fail(error);
        return false
      }
    },
    reset(){epoch+=1;adapter?.reset()}
  }
}
