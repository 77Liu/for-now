import { rotateSession, sessionSerial } from "../../session/index.mjs";
import {
  emptyClientState,
  replaceState,
  resetState,
  state,
  subscribeState
} from "../../state/index.mjs";

export function createSessionRuntime({
  runtime,$,$$,createTagMultiSelectState,defaultLlmProfiles,defaultLlmScenarios,
  defaultSceneEfforts,ownerCapabilities,localTestScopeLoads,
  ownerConsoleFeatureControllers,accountSettingsFeatureControllers,
  checkinsFeatureControllers,thoughtsFeatureControllers,persistentContentImageKeys,
  startupMarks,markStartup,adoptStartupMarks,publishStartupTiming,requestRouteState,requestV1,
  request,optionalRequest,optionalPublicRequest,routeDataKey,loadRouteState,
  restorePendingProjections,refreshCoordinator,actionsCoordinator,
  onboardingV2Controller,completeOnboardingSnapshot,onboardingBlocksPrivateShell,
  afterVisibleShellPaint,assertNativeServerCompatibility,applyCapabilitySurface,
  renderVisibleRoute,reconcileActiveThoughtRoute,renderOnboarding,hasCapability,
  routeContentSelectors,unmountRouteContent,restoreView,
  restoreDurableDrafts,syncChainRecordKind,scheduleNotificationPoll,
  restoreContentImageDrafts,restoreAnnotationUiDrafts,ensureAnnotationsController,
  activateContentImageDraftsForCurrentRoute,
  renderContentImageEditor,pageAudioCoordinator,
  stopPageAudio,closeImageViewer,closeHomeEditors,showToast,apiClient
} = {}) {
async function load({visibleShell=false,initialSnapshot=null,opening=null}={}){
  if(!Number.isFinite(startupMarks.loadStart))markStartup("loadStart");
  const owner=runtime.currentUser?.id,session=runtime.sessionSerial,route=initialSnapshot?.route||runtime.pageRouter?.currentRoute()||{view:"today",query:{}};
  const [nextState,meta]=initialSnapshot
    ?[initialSnapshot.state,initialSnapshot.meta]
    :await Promise.all([
      requestRouteState(route),
      requestV1("/api/v1/startup").then(result=>result.data)
    ]);
  if(owner!==runtime.currentUser?.id||session!==runtime.sessionSerial)return false;
  if(!Number.isFinite(startupMarks.coreSnapshotReady))markStartup("coreSnapshotReady");assertNativeServerCompatibility(meta);
  runtime.currentUser={...runtime.currentUser,...(meta.user||{})};applyCapabilitySurface(meta.capabilities||[]);
  opening?.applyPreferences?.(runtime.currentUser?.role === "owner" ? meta.openingPreferences : undefined);
  Object.keys(routeContentSelectors).forEach(unmountRouteContent);
  replaceState({...structuredClone(emptyClientState),...nextState,onboardingV2:meta.onboardingV2,notificationUnread:meta.notificationUnread,quoteTags:meta.quoteTags||[]});
  runtime.loadedRouteKey=routeDataKey(route);runtime.fullRouteStateLoaded=Boolean(nextState?._routeProjection?.complete);runtime.appVersion=meta.version||"development";runtime.releaseVersion=meta.releaseVersion||runtime.releaseVersion;runtime.featureFlags={...runtime.featureFlags,...meta.features};runtime.governanceUrl=typeof meta.governanceUrl==="string"?meta.governanceUrl:"";runtime.notificationUnreadCount=Number(state.notificationUnread)||0;runtime.routeDataReady=true;
  if(["thoughts","together"].includes(route.view)){
    runtime.runtimeFeatureRegistry?.notifyState(state,new Set(Object.keys(nextState||{})));
    await Promise.resolve()
  }
  const onboardingPending=onboardingBlocksPrivateShell(meta.onboardingV2);
  const requestSecondary=()=>Promise.all([
    request(hasCapability("ai-configuration")?"/api/settings":"/api/preferences"),
    optionalRequest("/api/onboarding/schema"),
    requestV1("/api/v1/onboarding-v2/schema"),
    completeOnboardingSnapshot(meta.onboardingV2)
      ?Promise.resolve({data:meta.onboardingV2})
      :requestV1("/api/v1/onboarding-v2/session"),
    hasCapability("local-testing")?(initialSnapshot?Promise.resolve(initialSnapshot.testConfig):optionalRequest("/api/local-test-mode")):Promise.resolve(null)
  ]).then(value=>({value}),error=>({error}));
  let openingCompletion=null;
  let secondaryRequest=null;
  if(visibleShell&&!onboardingPending){
    restoreView?.();renderVisibleRoute();reconcileActiveThoughtRoute();revealUserSession();if(!Number.isFinite(startupMarks.visibleShell))markStartup("visibleShell");
    await afterVisibleShellPaint();
    if(owner!==runtime.currentUser?.id||session!==runtime.sessionSerial)return false;
    secondaryRequest=requestSecondary();
  }
  secondaryRequest||=requestSecondary();
  const secondaryResult=await secondaryRequest;
  if(secondaryResult.error)throw secondaryResult.error;
  if(opening&&!onboardingPending){openingCompletion=opening.ready();if(openingCompletion)await openingCompletion}
  const [nextSettings,nextOnboardingSchema,nextOnboardingV2Schema,nextOnboardingV2State,nextLocalTestConfig]=secondaryResult.value;
  if(owner!==runtime.currentUser?.id||session!==runtime.sessionSerial)return false;
  markStartup("secondaryReady");
  state.onboardingV2=nextOnboardingV2State.data;runtime.llmSettings=nextSettings;runtime.onboardingSchema=nextOnboardingSchema;runtime.localTestConfig=nextLocalTestConfig;runtime.onboardingHydrated=false;
  await onboardingV2Controller.hydrate({schema:nextOnboardingV2Schema.data,state:nextOnboardingV2State.data});
  if(owner!==runtime.currentUser?.id||session!==runtime.sessionSerial)return false;
  for(;;){
    const activeRoute=runtime.pageRouter?.currentRoute()||route,activeKey=routeDataKey(activeRoute);
    if(activeKey!==runtime.loadedRouteKey)await loadRouteState(activeRoute);
    if(owner!==runtime.currentUser?.id||session!==runtime.sessionSerial)return false;
    if(activeKey!==routeDataKey(runtime.pageRouter?.currentRoute()))continue;
    if(activeKey!==runtime.loadedRouteKey&&runtime.routeLoadFailureKey!==activeKey)continue;
    await runtime.runtimeFeatureRegistry?.enter(activeRoute.view,activeRoute);
    if(activeKey===routeDataKey(runtime.pageRouter?.currentRoute()))break
  }
  renderOnboarding();renderVisibleRoute();if(!reconcileActiveThoughtRoute())runtime.pageRouter?.activate();restoreDurableDrafts();syncChainRecordKind();scheduleNotificationPoll();
  if(visibleShell&&onboardingPending){revealUserSession();if(!Number.isFinite(startupMarks.visibleShell))markStartup("visibleShell")}
  if(opening&&onboardingPending){await afterVisibleShellPaint();if(owner!==runtime.currentUser?.id||session!==runtime.sessionSerial)return false;await opening.ready()}
  // 设置页切换工作区只重载数据，application sync port不会再次start；在新配置接入后恢复。
  if(runtime.applicationLifecycleReady){
    await runtime.syncController?.start(owner,{incremental:runtime.featureFlags.incrementalSync});
    if(owner!==runtime.currentUser?.id||session!==runtime.sessionSerial)return false;
  }
  markStartup("stableHome");publishStartupTiming();return true
}
function setAuthTab(tab){
  if(runtime.authBusy)return;
  $$("[data-auth-tab]").forEach(button=>{const active=button.dataset.authTab===tab;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1});
  $("#login-form").hidden=tab!=="login";$("#register-form").hidden=tab!=="register";$("#auth-status").textContent="";
  if(matchMedia?.("(pointer:fine)").matches)(tab==="login"?$("#login-form"):$("#register-form")).elements.username.focus();
}
function setAuthBusy(value){runtime.authBusy=value;$$(".auth-form input,.auth-form button,[data-auth-tab]").forEach(control=>control.disabled=value)}
function invalidatePageLoads(){
  runtime.syncController?.stop();
  runtime.activeAnswerTaskId=++runtime.answerTaskSerial;runtime.healthFeatureController?.invalidateSession();clearTimeout(runtime.notificationTimer);
  runtime.backgroundResultsController?.resetSession();runtime.backgroundResultsLoadErrorReported=false;runtime.backgroundResultsRetryAttempts=0;refreshCoordinator.reset();
}
function clearPrivateSessionState(){
  closeImageViewer({restoreFocus:false});
  onboardingV2Controller.reset();
  resetState();
  runtime.routeDataReady=false;
  runtime.routeDataRequestSerial+=1;
  runtime.routeLoadFailureKey="";
  runtime.loadedRouteKey="";
  runtime.fullRouteStateLoaded=false;
  runtime.quoteTagStates={selectionQuote:createTagMultiSelectState()};
  runtime.llmSettings={
    provider:"deepseek",
    profiles:structuredClone(defaultLlmProfiles),
    scenarios:{...defaultLlmScenarios},
    sceneEfforts:{...defaultSceneEfforts},
    automaticAnswers:{thoughtAnswer:false},
    speech:{defaultVoice:"",generationRate:-10},
    hasApiKey:false,
    keyHint:""
  };

  runtime.activeAnswerTaskId=++runtime.answerTaskSerial;
  clearTimeout(runtime.notificationTimer);
  runtime.answerDraft="";
  runtime.answerReasoningDraft="";
  runtime.localTestConfig=null;
  localTestScopeLoads.clear();
  runtime.onboardingSchema=null;
  runtime.onboardingMode="quick";
  runtime.onboardingDraftAnswers={};
  runtime.onboardingHydrated=false;
  runtime.notificationUnreadCount=0;
  runtime.notificationsLoadState="idle";
  actionsCoordinator.resetSession();
  runtime.annotationsController?.resetSession();
  runtime.governanceUrl="";
  runtime.appVersion=runtime.releaseVersion.split(/[+-]/,1)[0]||"development";
  runtime.homeMemoryKeys=[];
  runtime.homeMemoryByKey=new Map();
  runtime.homeKeepsakeId="";
  closeHomeEditors({restoreFocus:false});
  $("#capture-editor").hidden=true;
  document.body.classList.remove("capture-editor-open");
  invalidatePageLoads();
  runtime.draftTags=[];
  runtime.capturesFeatureController=null;
  runtime.quotesFeatureController=null;
  runtime.libraryFeatureController=null;
  runtime.keepsakeFeatureController=null;

  runtime.contentImageDraftManager?.resetSession();
  for(const key of persistentContentImageKeys)renderContentImageEditor(key);
  pageAudioCoordinator.resetSession();
  stopPageAudio();
  $$("main form").forEach(form=>{
    form.reset();
    delete form.dataset.requestId;
  });
  $$(".modal-backdrop").forEach(modal=>modal.hidden=true);
  $("#comment-panel").hidden=true;
  $("#comment-panel-reopen").hidden=true;
  $("#selection-tools").hidden=true;
  $("#annotation-line-counts").hidden=true;
  document.body.classList.remove("comment-panel-open");
}
function showAuthGate(message=""){
  const localTestEnabled=Boolean(runtime.localTestConfig?.enabled);
  const resetApplication=runtime.applicationLifecycleReady;
  runtime.applicationLifecycleReady=false;
  runtime.resetRouteAfterAuthentication||=Boolean(runtime.currentUser);
  runtime.syncController?.stop();
  runtime.syncHealth={status:"idle",pending:0,conflicts:0,failed:0,oldestAgeMs:0,enqueueToAckP95Ms:0,lastPullMs:0,lastError:""};
  rotateSession();
  clearPrivateSessionState();
  if(resetApplication){
    void runtime.runtimeFeatureRegistry?.resetSession().catch(()=>{});
    runtime.runtimeStatePort?.resetSession();
  }
  runtime.currentUser=null;
  applyCapabilitySurface([]);
  try{
    sessionStorage.removeItem("cike:authenticated-shell");
  }catch{}
  delete document.documentElement.dataset.bootstrapVisible;
  document.body.classList.add("auth-locked");
  $("#auth-gate").hidden=false;
  $("#account-control").hidden=true;
  $("#account-authenticated").hidden=true;
  const registerTab=$('[data-auth-tab="register"]');
  if(registerTab)registerTab.hidden=localTestEnabled;
  if(message)$("#auth-status").textContent=message;
}
function renderAccountIdentity(){
  const username=runtime.currentUser?.username||"";
  $("#account-name").textContent=username;
  runtime.runtimeFeatureRegistry?.notifyState(state,new Set(["account"]))
}
function prepareUserSession(user,authRequired,{keepVisible=false}={}){
  applyCapabilitySurface(user?.role==="owner"?ownerCapabilities:[]);if(!keepVisible)document.body.classList.add("auth-locked");restoreView?.(runtime.resetRouteAfterAuthentication?"today":runtime.requestedAuthenticatedView||undefined);runtime.currentUser=user;runtime.resetRouteAfterAuthentication=false;runtime.requestedAuthenticatedView="";$("#account-control").hidden=!authRequired;$("#account-authenticated").hidden=!authRequired;$("#account-local-mode").hidden=authRequired;renderAccountIdentity();
}
function revealUserSession(){try{sessionStorage.setItem("cike:authenticated-shell","1")}catch{}document.documentElement.dataset.bootstrapVisible="1";document.body.classList.remove("auth-locked");$("#auth-gate").hidden=true}
async function activateUserSession(user,authRequired,initialSnapshot=null,opening=null){
  prepareUserSession(user,authRequired,{keepVisible:Boolean(initialSnapshot?.visibleShell)});
  try{
    if(!await load({visibleShell:true,initialSnapshot,opening}))return false;
    await restoreContentImageDrafts(user?.id).catch(error=>showToast(`待上传图片恢复失败：${error.message}`,"error"));
    await restorePendingProjections();
    revealUserSession();
    return true
  }
  catch(error){if(runtime.currentUser?.id===user?.id)showAuthGate();throw error}
}
async function authRequest(endpoint,payload,method="POST"){
  return apiClient.request(endpoint,{method,body:JSON.stringify(payload||{})},{authGate:false,fallback:"账户操作失败"});
}
async function bootstrap(initial=null,{opening=null}={}){
  adoptStartupMarks(initial?.startupMarks);
  if(!Number.isFinite(startupMarks.bootstrapStart))markStartup("bootstrapStart");
  if(initial?.error){if(opening)await opening.fail(initial.error);else{showAuthGate();$("#auth-status").textContent=initial.error.message}return}
  let session,testConfig=null;
  try{
    if(initial?.session){session=initial.session;testConfig=initial.testConfig}
    else[session,testConfig]=await Promise.all([apiClient.request("/api/auth/me",{headers:{accept:"application/json"}},{authGate:false,allowUnauthorized:true}),optionalPublicRequest("/api/local-test-mode")])
  }catch(error){if(opening)await opening.fail(error);else{showAuthGate();$("#auth-status").textContent="无法连接服务，请检查网络后重试。"}return}
  if(!Number.isFinite(startupMarks.authSessionReady))markStartup("authSessionReady");
  if(!session.authenticated){showAuthGate(session.code==="AUTH_REAUTH_REQUIRED"?"账户权限已变更，请重新登录。":"");runtime.localTestConfig=testConfig;const registerTab=$('[data-auth-tab="register"]');if(registerTab)registerTab.hidden=Boolean(testConfig?.enabled);setAuthTab(testConfig?.enabled||session.userCount?"login":"register");if(session.code==="AUTH_REAUTH_REQUIRED")$("#auth-status").textContent="账户权限已变更，请重新登录。";await afterVisibleShellPaint();await opening?.ready();return}
  const initialSnapshot=initial?.state&&initial?.meta?{state:initial.state,meta:initial.meta,route:initial.route,testConfig:initial.testConfig,visibleShell:Boolean(initial.visibleShell)}:null;
  await activateUserSession(session.user,session.authRequired,initialSnapshot,opening);
}
function applicationStartInput(initial,opening=null){
  const owner=initial?.session?.user?.id||initial?.meta?.user?.id||"";
  return{state:{initial,opening},sync:{owner},shell:{owner}}
}
function createRuntimeApplicationPorts({createShellPort,createStatePort,createSyncPort}){
  const statePort=createStatePort({
    emptyState:emptyClientState,
    cloneValue:value=>value,
    load:async input=>{await bootstrap(input?.initial??null,{opening:input?.opening??null});return state}
  });
  const syncPort=createSyncPort({
    controller:{
      start:owner=>owner?runtime.syncController.start(owner,{incremental:runtime.featureFlags.incrementalSync}):false,
      stop:()=>runtime.syncController.stop()
    },
    onError:error=>showToast(`同步恢复失败：${error.message}`,"error")
  });
  const shellPort=createShellPort({
    mount:(_,context)=>{
      let active=true,disposeAnnotations=()=>false;const owner=runtime.currentUser?.id||"",session=runtime.sessionSerial,current=()=>active&&!context.signal.aborted&&owner===(runtime.currentUser?.id||"")&&session===runtime.sessionSerial;
      const attach=controller=>{
        if(!current())return;
        disposeAnnotations=controller.mount({root:document,signal:context.signal});
        if(runtime.currentUser?.id){restoreAnnotationUiDrafts();renderVisibleRoute();runtime.runtimeFeatureRegistry?.notifyState(state);activateContentImageDraftsForCurrentRoute()}
      };
      if(runtime.annotationsController)attach(runtime.annotationsController);
      else void ensureAnnotationsController().then(attach,error=>{if(current())showToast(`批注功能加载失败：${error.message}`,"error")});
      const unsubscribe=subscribeState((next,domains,options)=>statePort.replace(next,domains,options));
      return()=>{active=false;unsubscribe();disposeAnnotations()}
    },
    reset:()=>clearPrivateSessionState(),
    stop:()=>{}
  });
  return{statePort,syncPort,shellPort,sessionPort:{resetSession:rotateSession}}
}
async function restartApplicationForUser(user){
  const testConfig=runtime.localTestConfig;
  runtime.applicationLifecycleReady=false;
  await runtime.runtimeApplication.resetSession();
  runtime.currentUser=user;
  applyCapabilitySurface(user?.role==="owner"?ownerCapabilities:[]);
  await runtime.runtimeApplication.start(applicationStartInput({
    session:{authenticated:true,authRequired:true,user,userCount:1},
    testConfig
  }));
  runtime.applicationLifecycleReady=true
}
return Object.freeze({
  load,
  setAuthTab,
  setAuthBusy,
  invalidatePageLoads,
  clearPrivateSessionState,
  showAuthGate,
  renderAccountIdentity,
  prepareUserSession,
  revealUserSession,
  activateUserSession,
  authRequest,
  bootstrap,
  applicationStartInput,
  createRuntimeApplicationPorts,
  restartApplicationForUser
})
}
