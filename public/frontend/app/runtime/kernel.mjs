import { createApiClient } from "../../api/index.mjs";
import { createTagMultiSelectState, handleTagMultiSelectKey, reduceTagMultiSelectState } from "../../components/tag-multiselect/index.mjs";
import { createLatexRenderer, escapeHtml, plainPreview, presentError, renderMarkdown } from "../../content/index.mjs";
import { createActionsCoordinator, createHomeMemoryPool, selectHomeMemories, keepsakePlacementCss, keepsakeMediaSources, scanKeepsakeAlpha, createOnboardingV2Controller } from "../../features/index.mjs";
import { BASE_CHECKIN_METRICS } from "../../features/checkins-model/index.mjs";
import { captureRecordPayload, createIndexedDbMediaDraftStore, imageRecordPayload, imageUnderstandingPayload, uploadPendingMediaItems, uploadOriginalImages, normalizeTtsPlaybackRate, validatedImageFiles } from "../../media/index.mjs";
import { createPageAudioCoordinator } from "../../media/page-audio.mjs";
import { createPageRouter, createUnavailableRouteResult, ownerViewCapabilities, viewSections } from "../../pages/index.mjs";
import { sessionScope, sessionSerial, rotateSession } from "../../session/index.mjs";
import { emptyClientState, state, replaceState, mergeStateSnapshot, resetState, subscribeState, publishDomains, createRefreshCoordinator, applyRecordBatch, rebaseRecordScopes } from "../../state/index.mjs";
import { createIndexedDbSyncStore, createIncrementalSync, createRecordSyncLoop, createRequestCoordinator } from "../../sync/index.mjs";
import { entryKeyIntent, eventDate, eventTimestamp, formatDate, formatDateKey, formatTime, localDateKey, localDateTimeForDate, persistedDateTimeInput, toLocalDateTimeInput } from "../../time/index.mjs";
import { createOccurrenceControls } from "../../components/occurrence-control/index.mjs";
import { createRuntimeFeatureLoaders } from "./loaders.mjs";
import { createPageFeatureDescriptors } from "./page-descriptors.mjs";
import { createStartupTiming } from "./startup-timing.mjs";
import { createDurableFormDrafts } from "./durable-form-drafts.mjs";
import { createDataRuntime } from "./data-runtime.mjs";
import { createAnswerModalRuntime } from "./answer-modal-runtime.mjs";
import { createHomeRuntime } from "./home-runtime.mjs";
import { createThoughtDraftTagComposer } from "./thought-draft-tag-composer.mjs";
import { createSessionRuntime } from "./session-runtime.mjs";
import { installGlobalEvents } from "./global-events.mjs";
import { createContentMediaRuntime } from "./content-media-runtime.mjs";
import { createCollaborationRuntime } from "./collaboration-runtime.mjs";
import { createBackgroundThoughtAnswerRuntime } from "./personalized-task-runtime.mjs";

const appEntryUrl=new URL("../../../app.js",import.meta.url);
const applicationBasePath=new URL(".",appEntryUrl).pathname.replace(/\/$/,"")||"/";
const portFactoriesRequest=globalThis.__forNowPortsRequest||import("../ports.mjs");
let runtimeFeatureLoaders=null;
const loadActionsFeatureModule=()=>runtimeFeatureLoaders.actions();
const loadAnnotationsFeatureModule=()=>runtimeFeatureLoaders.annotations();
const loadBackgroundResultsFeatureModule=()=>runtimeFeatureLoaders.backgroundResults();
const loadHealthFeatureModule=()=>runtimeFeatureLoaders.health();
const loadThoughtsFeatureModule=()=>runtimeFeatureLoaders.thoughts();
const loadCaptureJournalFeatureModule=()=>runtimeFeatureLoaders.captureJournal();
const loadQuotesFeatureModule=()=>runtimeFeatureLoaders.quotes();
const loadLibraryFeatureModule=()=>runtimeFeatureLoaders.library();
const loadReviewInsightsFeatureModule=()=>runtimeFeatureLoaders.reviewInsights();
const loadKeepsakesFeatureModule=()=>runtimeFeatureLoaders.keepsakes();
const loadMineShellFeatureModule=()=>runtimeFeatureLoaders.mineShell();
const loadPersonalContextFeatureModule=()=>runtimeFeatureLoaders.personalContext();
const loadOwnerConsoleFeatureModule=()=>runtimeFeatureLoaders.ownerConsole();
const loadAccountSettingsFeatureModule=()=>runtimeFeatureLoaders.accountSettings();
const loadTrashFeatureModule=()=>runtimeFeatureLoaders.trash();
const startupTiming=createStartupTiming();
const startupPerformanceEnabled=startupTiming.enabled;
const startupMarks=startupTiming.marks;
const markStartup=startupTiming.mark;
const adoptStartupMarks=startupTiming.adopt;
const publishStartupTiming=startupTiming.publish;
const apiClient=createApiClient({baseUrl:appEntryUrl,apiOrigin:document.documentElement.dataset.apiOrigin||"",session:sessionScope,onAuthRequired:error=>showAuthGate(error?.code==="AUTH_REAUTH_REQUIRED"?"账户权限已变更，请重新登录。":"")});
const appUrl=apiClient.appUrl;
const syncStore=createIndexedDbSyncStore();
const mediaDraftStore=createIndexedDbMediaDraftStore();
const onboardingDraftStore=createIndexedDbMediaDraftStore({databaseName:"cike-onboarding-v2-drafts"});
const pageAudioCoordinator=createPageAudioCoordinator();
const BACKGROUND_RESULTS_RETRY_LIMIT=3;
let injectedTestSupport=null;
const testSupport={ensureView:view=>injectedTestSupport?.ensureView(view)||Promise.resolve(true)};
const localTestScopeLoads={clear:()=>injectedTestSupport?.reset()};
const baseMetrics=BASE_CHECKIN_METRICS;
const defaultLlmProfiles={lite:{model:"deepseek-flash",effort:"none"},mid:{model:"deepseek-flash",effort:"high"},high:{model:"deepseek-v4-pro",effort:"high"},ultra:{model:"deepseek-v4-pro",effort:"max"}};
const defaultLlmScenarios={thoughtPrompt:"lite",thoughtDraft:"high",thoughtAnswer:"ultra",followUpAnswer:"ultra",chat:"high",diaryLead:"lite",diaryStructure:"mid",diaryTopic:"high",diaryReflection:"ultra",annotationShenji:"high",analysis:"ultra",bookRecognition:"mid",healthRecognition:"mid",contentImageUnderstanding:"mid",capturePolish:"mid",recordCompression:"lite"};
const defaultSceneEfforts={...Object.fromEntries(Object.entries(defaultLlmScenarios).map(([scene,tier])=>[scene,defaultLlmProfiles[tier].effort])),onboardingClaimExtraction:"high"};
const ownerCapabilities=[...new Set([...Object.values(ownerViewCapabilities),"local-testing","ai-configuration","account-roles"])];
const defaultReleaseVersion=globalThis.CIKE_RELEASE_INFO?.releaseVersion||"development";
const defaultAppVersion=globalThis.CIKE_RELEASE_INFO?.appVersion||"development";
let pageRouter,switchView,restoreView;
let runtimeApplication=null,runtimeFeatureRegistry=null,runtimeStatePort=null,applicationLifecycleReady=false;
let backgroundResultsController=null,backgroundResultsLoadErrorReported=false,backgroundResultsRetryAttempts=0;
let annotationsController=null,annotationRootKey=null,parseAnnotationRootKey=null;
let healthFeatureController=null;
let capturesFeatureController=null;
let quotesFeatureController=null;
let libraryFeatureController=null;
let keepsakesFeatureController=null;
const ownerConsoleFeatureControllers=new Set();
const accountSettingsFeatureControllers=new Set();
const checkinsFeatureControllers=new Set();
const thoughtsFeatureControllers=new Set();
let currentLocalDate=localDateKey();
let llmSettings={provider:"deepseek",profiles:structuredClone(defaultLlmProfiles),scenarios:{...defaultLlmScenarios},sceneEfforts:{...defaultSceneEfforts},automaticAnswers:{thoughtAnswer:false},speech:{defaultVoice:"",generationRate:-10},hasApiKey:false,keyHint:""};
let activeDate=currentLocalDate,activeDailyType="sleep",answerDraft="",answerReasoningDraft="",toastTimer,notificationTimer,draftTags=[],currentUser=null,notificationUnreadCount=0,chainDraftVersion=0,localTestConfig=null,onboardingSchema=null,onboardingMode="quick",onboardingDraftAnswers={},onboardingHydrated=false,governanceUrl="",authOperationSerial=0,authBusy=false,resetRouteAfterAuthentication=false,appVersion=defaultAppVersion,releaseVersion=defaultReleaseVersion,featureFlags={incrementalSync:true},syncController=null,syncHealth={status:"idle",pending:0,conflicts:0,failed:0,oldestAgeMs:0,enqueueToAckP95Ms:0,lastPullMs:0,lastError:""};
let notificationsLoadState="idle",routeDataReady=false,routeDataRequestSerial=0,routeLoadFailureKey="",loadedRouteKey="",fullRouteStateLoaded=false,renderedRouteView="";
const runtimeState={
  get pageRouter(){return pageRouter},set pageRouter(value){pageRouter=value},
  get runtimeFeatureRegistry(){return runtimeFeatureRegistry},set runtimeFeatureRegistry(value){runtimeFeatureRegistry=value},
  get currentUser(){return currentUser},set currentUser(value){currentUser=value},
  get sessionSerial(){return sessionSerial},
  get authBusy(){return authBusy},set authBusy(value){authBusy=value},
  get applicationLifecycleReady(){return applicationLifecycleReady},set applicationLifecycleReady(value){applicationLifecycleReady=value},
  get resetRouteAfterAuthentication(){return resetRouteAfterAuthentication},set resetRouteAfterAuthentication(value){resetRouteAfterAuthentication=value},
  get requestedAuthenticatedView(){return requestedAuthenticatedView},set requestedAuthenticatedView(value){requestedAuthenticatedView=value},
  get chainDraftVersion(){return chainDraftVersion},set chainDraftVersion(value){chainDraftVersion=value},
  get authOperationSerial(){return authOperationSerial},set authOperationSerial(value){authOperationSerial=value},
  get answerDraft(){return answerDraft},set answerDraft(value){answerDraft=value},
  get answerReasoningDraft(){return answerReasoningDraft},set answerReasoningDraft(value){answerReasoningDraft=value},
  get draftTags(){return draftTags},set draftTags(value){draftTags=value},
  get activeDate(){return activeDate},set activeDate(value){activeDate=value},
  get activeDailyType(){return activeDailyType},set activeDailyType(value){activeDailyType=value},
  get healthFeatureController(){return healthFeatureController},set healthFeatureController(value){healthFeatureController=value},
  get capturesFeatureController(){return capturesFeatureController},set capturesFeatureController(value){capturesFeatureController=value},
  get quotesFeatureController(){return quotesFeatureController},set quotesFeatureController(value){quotesFeatureController=value},
  get libraryFeatureController(){return libraryFeatureController},set libraryFeatureController(value){libraryFeatureController=value},
  get keepsakesFeatureController(){return keepsakesFeatureController},set keepsakesFeatureController(value){keepsakesFeatureController=value},
  get notificationUnreadCount(){return notificationUnreadCount},set notificationUnreadCount(value){notificationUnreadCount=value},
  get notificationsLoadState(){return notificationsLoadState},set notificationsLoadState(value){notificationsLoadState=value},
  get notificationTimer(){return notificationTimer},set notificationTimer(value){notificationTimer=value},
  get backgroundResultsRetryAttempts(){return backgroundResultsRetryAttempts},set backgroundResultsRetryAttempts(value){backgroundResultsRetryAttempts=value},
  get backgroundResultsController(){return backgroundResultsController},set backgroundResultsController(value){backgroundResultsController=value},
  get backgroundResultsLoadErrorReported(){return backgroundResultsLoadErrorReported},set backgroundResultsLoadErrorReported(value){backgroundResultsLoadErrorReported=value},
  get routeDataReady(){return routeDataReady},set routeDataReady(value){routeDataReady=value},
  get routeDataRequestSerial(){return routeDataRequestSerial},set routeDataRequestSerial(value){routeDataRequestSerial=value},
  get routeLoadFailureKey(){return routeLoadFailureKey},set routeLoadFailureKey(value){routeLoadFailureKey=value},
  get loadedRouteKey(){return loadedRouteKey},set loadedRouteKey(value){loadedRouteKey=value},
  get fullRouteStateLoaded(){return fullRouteStateLoaded},set fullRouteStateLoaded(value){fullRouteStateLoaded=value},
  get toastTimer(){return toastTimer},set toastTimer(value){toastTimer=value},
  get syncController(){return syncController},set syncController(value){syncController=value},
  get syncHealth(){return syncHealth},set syncHealth(value){syncHealth=value},
  get runtimeApplication(){return runtimeApplication},set runtimeApplication(value){runtimeApplication=value},
  get runtimeStatePort(){return runtimeStatePort},set runtimeStatePort(value){runtimeStatePort=value},
  get featureFlags(){return featureFlags},set featureFlags(value){featureFlags=value},
  get governanceUrl(){return governanceUrl},set governanceUrl(value){governanceUrl=value},
  get releaseVersion(){return releaseVersion},
  set releaseVersion(value){releaseVersion=value},
  get appVersion(){return appVersion},set appVersion(value){appVersion=value},
  get llmSettings(){return llmSettings},set llmSettings(value){llmSettings=value},
  get localTestConfig(){return localTestConfig},set localTestConfig(value){localTestConfig=value},
  get contentImageDraftManager(){return mediaRuntime?.manager||null},
  get currentLocalDate(){return currentLocalDate},set currentLocalDate(value){currentLocalDate=value},
  get quoteTagStates(){return quoteTagStates},set quoteTagStates(value){quoteTagStates=value},
  get onboardingSchema(){return onboardingSchema},set onboardingSchema(value){onboardingSchema=value},
  get onboardingMode(){return onboardingMode},set onboardingMode(value){onboardingMode=value},
  get onboardingDraftAnswers(){return onboardingDraftAnswers},set onboardingDraftAnswers(value){onboardingDraftAnswers=value},
  get onboardingHydrated(){return onboardingHydrated},set onboardingHydrated(value){onboardingHydrated=value},
  get homeMemoryKeys(){return homeMemoryKeys},set homeMemoryKeys(value){homeMemoryKeys=value},
  get homeMemoryByKey(){return homeMemoryByKey},set homeMemoryByKey(value){homeMemoryByKey=value},
  get homeKeepsakeId(){return homeKeepsakeId},set homeKeepsakeId(value){homeKeepsakeId=value},
  get homeEditorTrigger(){return homeEditorTrigger},set homeEditorTrigger(value){homeEditorTrigger=value},
  get renderedRouteView(){return renderedRouteView},set renderedRouteView(value){renderedRouteView=value},
  get annotationsController(){return annotationsController},set annotationsController(value){annotationsController=value},
  get annotationRootKey(){return annotationRootKey},set annotationRootKey(value){annotationRootKey=value},
  get parseAnnotationRootKey(){return parseAnnotationRootKey},set parseAnnotationRootKey(value){parseAnnotationRootKey=value},
  get currentCapabilities(){return currentCapabilities},set currentCapabilities(value){currentCapabilities=value},
  get ownerSurfaceEntries(){return ownerSurfaceEntries},set ownerSurfaceEntries(value){ownerSurfaceEntries=value},
  get deniedAccess(){return deniedAccess},set deniedAccess(value){deniedAccess=value}
};
const quoteTagPickerConfig=Object.freeze({
  selectionQuote:{input:"#selection-quote-tags",selected:"#selection-quote-selected-tags",options:"#selection-quote-tag-options",toggle:"#selection-quote-tag-toggle",status:"#selection-quote-tag-status"}
});
let quoteTagStates={
  selectionQuote:createTagMultiSelectState()
};
let homeMemoryKeys=[],homeMemoryByKey=new Map(),homeKeepsakeId="",homeEditorTrigger=null;
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const ownerSurfaceVault=document.createDocumentFragment();
let ownerSurfaceEntries=null,currentCapabilities=new Set(),deniedAccess={},requestedAuthenticatedView="";
const dailyTypeMeta={sleep:{label:"睡眠",save:"保存睡眠"},heartRate:{label:"心率",save:"保存心率"},weight:{label:"体重",save:"保存体重"},exercise:{label:"运动",save:"保存运动"}};
const collaborationRuntime=createCollaborationRuntime({runtime:runtimeState,$,$$,ownerSurfaceVault,escapeHtml,plainPreview,renderMarkdown,createLatexRenderer,appUrl,state,dailyTypeMeta,renderDate:(...args)=>renderDate(...args),renderSliders:(...args)=>renderSliders(...args),publishDomains,renderStateChart:(...args)=>renderStateChart(...args),renderHomeMood:(...args)=>renderHomeMood(...args),renderChat:(...args)=>renderChat(...args),openThoughtDetail:(...args)=>openThoughtDetail(...args),switchView:(...args)=>switchView(...args),loadAnnotationsFeatureModule,request:(...args)=>request(...args),refreshState:(...args)=>refreshState(...args),scheduleNotificationPoll:(...args)=>scheduleNotificationPoll(...args),openSelectionQuoteModal:(...args)=>openSelectionQuoteModal(...args),resetContentImageEditor:(...args)=>resetContentImageEditor(...args),persistContentImageDraft:(...args)=>persistContentImageDraft(...args),contentImagePaths:(...args)=>contentImagePaths(...args),imageRecordPayload,clearSubmittedContentImageDraft:(...args)=>clearSubmittedContentImageDraft(...args),discardContentImageUploads:(...args)=>discardContentImageUploads(...args),uncertainMediaSubmission:(...args)=>uncertainMediaSubmission(...args),contentImagesMarkup:(...args)=>contentImagesMarkup(...args),formatDate,showToast:(...args)=>showToast(...args),empty:(...args)=>empty(...args),thoughtsFeatureControllers,loadBackgroundResultsFeatureModule,replaceState,sessionSerial,backgroundResultsRetryLimit:BACKGROUND_RESULTS_RETRY_LIMIT});
const {hasCapability,applyCapabilitySurface,showPermissionPage,renderLatex,currentContextSource,contextSourceButton,contextReceiptMarkup,openContextReceiptSource,clearThoughtTracePending,createRuntimeAnnotationsController,ensureAnnotationsController,commentRootKey,parseCommentRootKey,commentRoot,commentRootLabel,markCommentTarget,tagCommentableTargets,applyCommentAnchors,scheduleAnnotationLineCounts,restoreAnnotationUiDrafts,renderCommentPanel,openCommentPanel,patchActiveThoughtTarget,reconcileActiveThoughtRoute,createRuntimeBackgroundResultsController,ensureBackgroundResultsController,syncBackgroundTaskResults}=collaborationRuntime;
const durableDraftForms=["chain-form","checkin-form"];
const durableDrafts=createDurableFormDrafts({
  formIds:durableDraftForms,
  getOwner:()=>currentUser?.id||"",
  getDraftTags:()=>draftTags,
  setDraftTags:value=>{draftTags=value},
  onRestore: () => {
    renderTagComposer();
    const occurrenceInputs = $$("#chain-form input[data-occurrence-mode], #checkin-form input[data-occurrence-mode]");
    occurrenceInputs.forEach(input => {
      const mode = input.dataset.occurrenceMode;
      if (!mode) return;
      const value = input.value;
      setOccurrenceMode(input, mode);
      input.value = value;
    });
  }
});
const saveDurableDrafts=durableDrafts.save;
const restoreDurableDrafts=durableDrafts.restore;
const clearDurableDraft=durableDrafts.clear;
const splitTags=v=>String(v||"").split(/[,，#\s]+/).map(x=>x.trim()).filter(Boolean);
const empty=t=>`<div class="empty">${escapeHtml(t)}</div>`;
function contentState({kind="empty",title,body,action=null,className=""}){
  const stateKind=["empty","loading","failure"].includes(kind)?kind:"empty";
  const extraClass=String(className).split(/\s+/).filter(value=>/^[a-z0-9-]+$/i.test(value)).join(" ");
  let actionMarkup="";
  if(action?.label){
    const attribute=action.view
      ?`data-view="${escapeHtml(action.view)}"`
      :action.focus
        ?`data-content-focus="${escapeHtml(action.focus)}"`
        :action.command
          ?`data-content-action="${escapeHtml(action.command)}"`
          :"";
    if(attribute)actionMarkup=`<button class="quiet-button content-state-action" type="button" ${attribute}>${escapeHtml(action.label)}</button>`
  }
  const role=stateKind==="failure"?' role="alert"':stateKind==="loading"?' role="status"':"";
  return `<section class="empty content-state ${stateKind}${extraClass?` ${extraClass}`:""}"${role}><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p>${actionMarkup}</section>`
}
function runPublicValidation(callback){
  try{return callback()}
  catch(error){
    const validationError=new Error(String(error?.message||"输入不符合要求"),{cause:error});
    validationError.publicValidation=true;
    throw validationError
  }
}
const formatBytes=value=>value<1024?`${value} B`:value<1048576?`${(value/1024).toFixed(1)} KB`:`${(value/1048576).toFixed(1)} MB`;
const mediaRuntime=createContentMediaRuntime({runtime:runtimeState,$,state,mediaDraftStore,runPublicValidation,validatedImageFiles,uploadPendingMediaItems,uploadOriginalImages,request:(...args)=>request(...args),imageRecordPayload,parseCommentRootKey,toLocalDateTimeInput,eventTimestamp,apiClient,showToast:(...args)=>showToast(...args),presentError,requestV1:(...args)=>requestV1(...args),imageUnderstandingPayload,refreshState:(...args)=>refreshState(...args),scheduleNotificationPoll:(...args)=>scheduleNotificationPoll(...args),appUrl,escapeHtml,renderMarkdown});
const {persistentContentImageKeys,initializeContentImageDraftManager,uncertainMediaSubmission,imageDataUrls,contentImageDraft,persistContentImageDraft,activateContentImageDraft,activateContentImageDraftsForCurrentRoute,restoreContentImageDrafts,abandonContentImageDraft,renderContentImageEditor,resetContentImageEditor,clearSubmittedContentImageDraft,setContentImageFiles,contentImagePaths,discardUploadedMediaItem,discardUploadedImagePath,discardContentImageUploads,viewerAttachmentPath,openImageViewer,closeImageViewer,moveImageViewer,contentImagesMarkup,queueContentImageUnderstanding}=mediaRuntime;
const formSnapshot=form=>JSON.stringify([...new FormData(form).entries()]);
const occurrenceControls=createOccurrenceControls({getActiveDate:()=>activeDate});
const setOccurrenceMode=occurrenceControls.setMode;
const installOccurrenceControls=occurrenceControls.installAll;
const occurrenceFields=occurrenceControls.fields;
const resetOccurrenceInput=occurrenceControls.reset;
const occurrenceKeyboardSubmit=occurrenceControls.keyboardSubmit;

const dataRuntime=createDataRuntime({
  runtime:runtimeState,apiClient,syncStore,createRequestCoordinator,
  createRefreshCoordinator,createIncrementalSync,createRecordSyncLoop,
  applyRecordBatch,rebaseRecordScopes,$,
  getActionsCoordinator:()=>actionsCoordinator,
  renderStateChart:(...args)=>renderStateChart(...args),
  renderHomeMood:(...args)=>renderHomeMood(...args),
  reconcileActiveThoughtRoute,
  clearRouteLoadFailure:(...args)=>clearRouteLoadFailure(...args),
  renderVisibleRoute:(...args)=>renderVisibleRoute(...args),
  renderRouteLoadFailure:(...args)=>renderRouteLoadFailure(...args),
  syncBackgroundTaskResults,ensureBackgroundResultsController,
  backgroundResultsRetryLimit:BACKGROUND_RESULTS_RETRY_LIMIT
});
const {requestCoordinator,refreshCoordinator,setAnswerStatus,request,requestV1,resolvePersonalizedTask,routeDataKey,routeStateUrl,requestRouteState,loadRouteState,listAllV1,optionalRequest,optionalPublicRequest,requestStream,showToast,applyPendingProjection,restorePendingProjection,restorePendingProjections,applyIncrementalSnapshot,updateSyncHealth,notificationUnread,renderNotificationSummary,publishNotificationState,scheduleNotificationPoll,loadNotifications,openAiTaskTarget,refreshState}=dataRuntime;
const draftTagComposer=createThoughtDraftTagComposer({
  $,getState:()=>state,escapeHtml,splitTags,
  getDraftTags:()=>draftTags,
  addDraftTag:tag=>{
    if(!draftTags.includes(tag))draftTags.push(tag);
  }
});
const {commitDraftTags,renderTagComposer}=draftTagComposer;
function chainRecordKind(){return $("#chain-form").elements.recordKind?.value==="capture"?"capture":"thought"}
function syncChainRecordKind(){
  const form=$("#chain-form"),sourceMode=Boolean(form.elements.sourceCaptureId.value),captureMode=!sourceMode&&chainRecordKind()==="capture";
  if(sourceMode)form.elements.recordKind.value="thought";
  form.querySelector(".thought-record-kind").hidden=sourceMode;
  $("#thought-source-notice").hidden=!sourceMode;
  $$("[data-chain-thought-only]").forEach(element=>element.hidden=captureMode);
  $("#home-thought-title").textContent=sourceMode?"展开为思绪":captureMode?"记录念起":"记录思考";
  $("#chain-primary-label").innerHTML=captureMode?'内容 <i>文字或图片至少一项 · 支持 Markdown</i>':'问题 <i>文字或图片至少一项 · 支持 Markdown</i>';
  $("#chain-question").placeholder=captureMode?"先记下，不必立刻想完整。":"你真正想问的是什么？";
  $("#chain-submit").textContent=captureMode?"收进念起":"收进思绪箱"
}
function normalizedFeedSearch(value){return String(value||"").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g," ").trim()}
function feedSearchEmpty(label){return contentState({title:`没有匹配的${label}`,body:"换一个关键词，原有记录不会受到影响。"})}
const routeContentSelectors=Object.freeze({
  today:["#home-memory-grid","#home-keepsake","#action-columns","#habit-list"],
  together:["#chat-history","#today-thoughts"],
  daily:["#daily-list"],
  captures:["#capture-list"],
  journals:["#journal-list"],
  thoughts:[],
  review:["#cluster-grid","#analysis-list"],
  books:["#book-memory-sky","#book-grid","#book-detail"],
  keepsakes:["#keepsake-grid","#keepsake-detail"],
  quotes:["#quote-sky-content","#quote-timeline"]
});
const routeFailureTargetSelectors=Object.freeze({
  today:"#home-memory-grid",
  together:"#chat-history",
  daily:"#daily-list",
  captures:"#capture-list",
  journals:"#journal-list",
  thoughts:"#all-thoughts",
  review:"#analysis-list",
  books:"#book-grid",
  keepsakes:"#keepsake-grid",
  quotes:"#quote-timeline"
});
function unmountRouteContent(view){
  for(const selector of routeContentSelectors[view]||[])$(selector)?.replaceChildren()
}
function clearRouteLoadFailure(route){
  $(`#view-${route?.view||"today"}`)?.querySelector("[data-route-load-failure]")?.remove();
  if(routeLoadFailureKey===routeDataKey(route))routeLoadFailureKey="";
  const toast=$("#toast");
  if(toast&&!toast.hidden&&toast.classList.contains("error")&&toast.textContent==="当前页面读取失败，已有记录没有变化。"){
    clearTimeout(toastTimer);toast.hidden=true
  }
}
function renderRouteLoadFailure(route){
  const view=route?.view||"today",panel=$(`#view-${view}`);
  if(!panel)return;
  unmountRouteContent(view);
  const target=$(routeFailureTargetSelectors[view])||panel;
  target.innerHTML=contentState({kind:"failure",title:"暂时无法读取这个页面",body:"已有记录没有变化。请检查网络后重试。",action:{command:"retry-route-state",label:"重新读取"},className:"route-load-failure"});
  target.querySelector(".route-load-failure")?.setAttribute("data-route-load-failure","")
}
function applyApplicationRoute(route,{source=""}={}){
  const requestSerial=++routeDataRequestSerial;
  if(routeLoadFailureKey&&routeLoadFailureKey!==routeDataKey(route))routeLoadFailureKey="";
  $$(".view[aria-busy='true']").forEach(view=>view.removeAttribute("aria-busy"));
  stopPageAudio();
  renderVisibleRoute();
  if(!["initial","activate"].includes(source)&&!fullRouteStateLoaded&&(!routeDataReady||loadedRouteKey!==routeDataKey(route))&&currentUser)return loadRouteState(route,requestSerial);
  return null
}
function openThoughtDetail(id){return pageRouter?.openDetail("thought-chain",id)}
function claimPageAudio(audio){
  if(!audio)return false;
  for(const controller of accountSettingsFeatureControllers)controller.stopAudio?.();
  return pageAudioCoordinator.claim(audio)
}
function stopPageAudio(){
  for(const controller of accountSettingsFeatureControllers)controller.stopAudio?.();
  pageAudioCoordinator.stopAll()
}

function renderCheckinSurfaces(domains){for(const controller of checkinsFeatureControllers)controller.renderPresentation({snapshot:state,changedDomains:domains})}
function renderStateChart(){renderCheckinSurfaces(["checkins","review"])}
const homeRuntime=createHomeRuntime({runtime:runtimeState,$,$$,state,eventDate,eventTimestamp,formatDate,formatDateKey,localDateKey,plainPreview,escapeHtml,renderMarkdown,contextReceiptMarkup,contentState,commentRootKey,markCommentTarget,renderLatex,applyCommentAnchors,appUrl,keepsakeMediaSources,keepsakePlacementCss,scanKeepsakeAlpha,createHomeMemoryPool,selectHomeMemories,quoteTagPickerConfig,createTagMultiSelectState,reduceTagMultiSelectState,commentRoot,commentRootLabel,parseCommentRootKey,resetOccurrenceInput,defaultLlmProfiles,createOnboardingV2Controller,requestV1,onboardingDraftStore,switchView:(...args)=>switchView(...args),openThoughtDetail:(...args)=>openThoughtDetail(...args),openCaptureFeature:(...args)=>openCaptureFeature(...args),showToast,installOccurrenceControls,publishDomains,renderStateChart,renderCheckinSurfaces,unmountRouteContent,activateContentImageDraftsForCurrentRoute});
const {renderChat,metricConfig,metricValue,renderSliders,dataUrlFromBlob,loadImageSource,blankCanvas,renderHomeMemories,renderHomeKeepsake,renderHomeMood,renderHome,quoteTagCandidates,quoteTagPickerElements,renderQuoteTagPicker,updateQuoteTagPicker,setQuoteTagPicker,quoteTagsForSubmission,closeSelectionQuoteModal,openSelectionQuoteModal,llmProfile,shiftLocalDateKey,compactNumber,formatCny,formatDuration,openCommercialSource,collectOnboardingAnswers,renderOnboardingQuestions,onboardingPayload,renderLegacyOnboarding,onboardingV2Controller,renderOnboarding,renderDate,closeHomeEditors,openHomeEditor,trapHomeEditorFocus,openHomeMemory,onboardingBlocksPrivateShell,completeOnboardingSnapshot,renderVisibleRoute,afterVisibleShellPaint,assertNativeServerCompatibility}=homeRuntime;
const sessionRuntime=createSessionRuntime({runtime:runtimeState,$,$$,state,sessionSerial,rotateSession,emptyClientState,replaceState,resetState,createTagMultiSelectState,defaultLlmProfiles,defaultLlmScenarios,defaultSceneEfforts,ownerCapabilities,localTestScopeLoads,ownerConsoleFeatureControllers,accountSettingsFeatureControllers,checkinsFeatureControllers,thoughtsFeatureControllers,persistentContentImageKeys,startupMarks,markStartup,adoptStartupMarks,publishStartupTiming,requestRouteState,requestV1,request,optionalRequest,optionalPublicRequest,routeDataKey,loadRouteState,restorePendingProjections,refreshCoordinator,actionsCoordinator:{resetSession:()=>actionsCoordinator.resetSession()},onboardingV2Controller,completeOnboardingSnapshot,onboardingBlocksPrivateShell,afterVisibleShellPaint,assertNativeServerCompatibility,applyCapabilitySurface,renderVisibleRoute,reconcileActiveThoughtRoute,renderOnboarding,hasCapability,routeContentSelectors,unmountRouteContent,restoreView:(...args)=>restoreView?.(...args),restoreDurableDrafts,syncChainRecordKind,scheduleNotificationPoll,restoreContentImageDrafts,restoreAnnotationUiDrafts,ensureAnnotationsController,subscribeState,activateContentImageDraftsForCurrentRoute,renderContentImageEditor,pageAudioCoordinator,stopPageAudio,closeImageViewer,closeHomeEditors,showToast,apiClient});
const {load,setAuthTab,setAuthBusy,invalidatePageLoads,clearPrivateSessionState,showAuthGate,renderAccountIdentity,prepareUserSession,revealUserSession,activateUserSession,authRequest,bootstrap,applicationStartInput,createRuntimeApplicationPorts,restartApplicationForUser}=sessionRuntime;
subscribeState((next,wanted)=>{
  notificationUnreadCount=Number(next.notificationUnread)||notificationUnreadCount;
  if(wanted.has("onboardingV2"))onboardingV2Controller.reconcile(next.onboardingV2);
  if(wanted.has("dailyRecords")){
    void healthFeatureController?.render({snapshot:next,changedDomains:wanted}).catch(()=>{});
  }
  if(wanted.has("thoughts")){
    renderTagComposer();
  }
  if(wanted.has("checkins")){
    renderStateChart();
    renderSliders();
    renderHomeMood();
  }
  if(wanted.has("chat")||wanted.has("chats"))renderChat();
  if(wanted.has("books")){
    if(annotationsController?.activeRootKey().startsWith("book:"))renderCommentPanel();
  }
  if(wanted.has("keepsakes"))renderHomeKeepsake();
  if(wanted.has("thoughts")||wanted.has("books")||wanted.has("quotes"))renderHomeMemories();
  if(wanted.has("comments"))renderCommentPanel();
  renderNotificationSummary();
});
const answerModalRuntime=createAnswerModalRuntime({
  $,
  $$,
  renderMarkdown,
  renderLatex,
  showToast,
  resolvePersonalizedTask
});
const {close:closeAnswerModal,run:runAnswerInModal}=answerModalRuntime;
const startBackgroundChainAnswer=createBackgroundThoughtAnswerRuntime({
  runtime:runtimeState,getSessionSerial:()=>sessionSerial,getTasks:()=>state.aiTasks,
  request,refreshState,scheduleNotificationPoll,setAnswerStatus,showToast
});
const ensureLocalTestViewScope=view=>testSupport.ensureView(view);
async function withFeatureScope(view,operation){
  if(!await ensureLocalTestViewScope(view))throw new Error("当前页面记录读取失败，请稍后重试");
  return operation()
}
const featureRequestV1=(view,url,options,coordination)=>withFeatureScope(view,()=>requestV1(url,options,coordination));
const featureListAllV1=(view,url,options)=>withFeatureScope(view,()=>listAllV1(url,options));
const actionsCoordinator=createActionsCoordinator({listAllV1:(url,options)=>featureListAllV1("today",url,options),requestV1:(url,options,coordination)=>featureRequestV1("today",url,options,coordination),session:sessionScope,date:()=>currentLocalDate,id:()=>crypto.randomUUID(),clone:value=>structuredClone(value)});
async function pendingDiscoveryStatuses(){
  const owner=currentUser?.id,session=sessionSerial;
  if(!owner)return[];
  const records=await requestCoordinator.list(owner,["pending","sending"]);
  if(owner!==currentUser?.id||session!==sessionSerial)return[];
  return records.filter(record=>record?.projection?.kind==="discovery.status")
}
function promoteCaptureToThought(item,button){
  const form=$("#chain-form");form.reset();form.elements.sourceCaptureId.value=item.id;form.elements.sourceCaptureVersion.value=String(item.version||1);form.elements.recordKind.value="thought";activeDate=eventDate(item)||activeDate;renderDate();renderSliders();publishDomains(new Set(["thoughts","activeDate"]));renderStateChart();renderHomeMood();renderChat();$("#chain-question").value="";$("#chain-idea").value=item.content;draftTags=[...(item.tags||[])];renderTagComposer();syncChainRecordKind();$("#chain-status").textContent="这条念起将保留为来源。补上一个明确问题，再形成完整思考。";switchView("today");openHomeEditor("thought",button);$("#chain-question").focus();return true
}
const encodeAudioDraft=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("无法读取音频，请重新录制或导入"));reader.readAsDataURL(blob)});
const readAudioDraftDuration=blob=>new Promise((resolve,reject)=>{
  const source=URL.createObjectURL(blob),audio=document.createElement("audio");
  const done=value=>{URL.revokeObjectURL(source);audio.removeAttribute("src");audio.load();value instanceof Error?reject(value):resolve(value)};
  audio.preload="metadata";audio.addEventListener("loadedmetadata",()=>Number.isFinite(audio.duration)&&audio.duration>0?done(Math.round(audio.duration*1000)):done(new Error("无法读取音频时长")),{once:true});audio.addEventListener("error",()=>done(new Error("无法读取音频时长")),{once:true});audio.src=source
});
const globalEvents=installGlobalEvents({runtime:runtimeState,$,$$,actionsCoordinator,testSupport,restorePendingProjections,createPageRouter,applicationBasePath,applyApplicationRoute,hasCapability,showPermissionPage,renderHomeMemories,openHomeMemory,openHomeEditor,closeHomeEditors,renderDate,renderSliders,publishDomains,renderStateChart,renderHomeMood,renderChat,showToast,pageAudioCoordinator,claimPageAudio,stopPageAudio,normalizeTtsPlaybackRate,requestV1,refreshState,applyPendingProjection,contentImageDraft,renderContentImageEditor,setContentImageFiles,queueContentImageUnderstanding,metricConfig,metricValue,splitTags,clearDurableDraft,saveDurableDrafts,durableDraftForms,resetOccurrenceInput,occurrenceFields,occurrenceKeyboardSubmit,entryKeyIntent,imageRecordPayload,captureRecordPayload,contentImagePaths,clearSubmittedContentImageDraft,discardContentImageUploads,llmProfile,runAnswerInModal,requestStream,startBackgroundChainAnswer,request,resolvePersonalizedTask,quoteTagPickerConfig,quoteTagPickerElements,updateQuoteTagPicker,renderQuoteTagPicker,quoteTagsForSubmission,quoteTagCandidates,closeSelectionQuoteModal,collectOnboardingAnswers,renderOnboardingQuestions,onboardingPayload,onboardingV2Controller,load,localDateKey,apiClient,setAuthTab,setAuthBusy,authRequest,restartApplicationForUser,showAuthGate,mediaDraftStore,state,sessionSerial,persistedDateTimeInput,escapeHtml,presentError,openThoughtDetail,openContextReceiptSource,loadRouteState,renderTagComposer,commitDraftTags,chainRecordKind,syncChainRecordKind,resetContentImageEditor,closeAnswerModal,openImageViewer,closeImageViewer,moveImageViewer,trapHomeEditorFocus,handleTagMultiSelectKey});
({pageRouter,switchView,restoreView}=globalEvents);
const {openCaptureFeature,openLibraryFeature,openQuoteFeature,openKeepsakeFeature,openDiscoveryItem,openCheckinEditor,logout}=globalEvents;
export async function createRuntimeComposition(initial = null, {
  opening = null,
  createTestSupport = null,
  featureModules,
  expectedViews = []
} = {}) {
  const requiredLoaders=[
    "accountSettings","actions","annotations","backgroundResults","captureJournal",
    "checkins","discovery","export","feedback","health","keepsakes","library",
    "mineShell","notifications","ownerConsole","personalContext","quotes",
    "reviewInsights","thoughts","trash"
  ];
  for(const name of requiredLoaders){
    if(typeof featureModules?.[name]!=="function")throw new TypeError(`Runtime composition requires feature loader ${name}`)
  }
  runtimeFeatureLoaders=createRuntimeFeatureLoaders({featureModules});
  if(initial?.session?.authenticated)currentUser=initial.session.user||initial.meta?.user||null;
  if(initial?.state&&initial?.route){routeDataReady=true;loadedRouteKey=routeDataKey(initial.route)}
  applyCapabilitySurface(initial?.meta?.capabilities||[]);
  const mediaReady=initializeContentImageDraftManager();
  const portFactories=await portFactoriesRequest;
  const {statePort,syncPort,shellPort,sessionPort}=createRuntimeApplicationPorts(portFactories);
  injectedTestSupport=createTestSupport?.({
    getControl:()=>runtimeState.localTestConfig,getOwner:()=>currentUser?.id,getSession:()=>sessionSerial,
    getPanel:view=>$(`#view-${view}`),request,
    setControl:value=>{localTestConfig=value},replaceSnapshot:replaceState,
    publishSnapshot:(snapshot,source)=>runtimeStatePort?.replace(state,Object.keys(snapshot),{source}),
    setUnreadCount:value=>{notificationUnreadCount=value},
    markRouteLoaded:()=>{loadedRouteKey=routeDataKey(pageRouter?.currentRoute())},
    render:()=>{renderOnboarding();renderVisibleRoute()},
    fail:error=>showToast(`当前页面记录读取失败：${error.message}`,"error")
  })||null;
  const descriptors=createPageFeatureDescriptors({
    runtime:runtimeState,runtimeFeatureLoaders,$,actionsCoordinator,showToast,
    request,resolvePersonalizedTask,featureRequestV1,featureListAllV1,mediaDraftStore,requestCoordinator,
    refreshState,applyPendingProjection,resetOccurrenceInput,occurrenceFields,
    imageDataUrls,viewerAttachmentPath,requestStream,resolvePersonalizedTask,apiClient,contentImageDraft,
    activateContentImageDraft,renderContentImageEditor,resetContentImageEditor,
    persistContentImageDraft,contentImagePaths,
    clearSubmittedContentImageDraft,discardContentImageUploads,setContentImageFiles,
    contentImagesMarkup,markCommentTarget,applyCommentAnchors,
    scheduleAnnotationLineCounts,commentRootKey,openThoughtDetail,
    promoteCaptureToThought,scheduleNotificationPoll,runAnswerInModal,appUrl,
    contentState,contextReceiptMarkup,renderLatex,renderTagComposer,renderChat,
    renderDate,renderSliders,renderStateChart,renderHomeMood,trapHomeEditorFocus,
    pageAudioCoordinator,startupPerformanceEnabled,encodeAudioDraft,
    readAudioDraftDuration,withFeatureScope,runPublicValidation,
    discardUploadedImagePath,dataUrlFromBlob,normalizedFeedSearch,feedSearchEmpty,
    splitTags,formatBytes,dailyTypeMeta,setOccurrenceMode,uncertainMediaSubmission,blankCanvas,
    loadImageSource,routeDataKey,tagCommentableTargets,openCommentPanel,
    openHomeEditor,openDiscoveryItem,pendingDiscoveryStatuses,loadNotifications,
    openAiTaskTarget,activateContentImageDraftsForCurrentRoute,baseMetrics,
    hasCapability,shiftLocalDateKey,formatCny,compactNumber,openCommercialSource,
    authRequest,showAuthGate,logout,renderAccountIdentity,load,invalidatePageLoads,
    ownerConsoleFeatureControllers,accountSettingsFeatureControllers,
    checkinsFeatureControllers,thoughtsFeatureControllers,localTestScopeLoads,
    switchView,pageRouter
  });
  const descriptorViews=Object.keys(descriptors).sort();
  if(expectedViews.length&&(
    expectedViews.length!==descriptorViews.length
    ||expectedViews.some((view,index)=>[...expectedViews].sort()[index]!==descriptorViews[index])
  ))throw new Error("Runtime feature descriptors do not match the page catalog");
  return {
    descriptors,
    onFeatureFailure:(error,{view,phase})=>showToast(`${view} 页面${phase==="import"?"加载":"运行"}失败：${error.message}`,"error"),
    router:pageRouter,
    sessionPort,
    statePort,
    syncPort,
    shellPort,
    startInput:applicationStartInput(initial,opening),
    connect({application,featureRegistry}){
      runtimeApplication=application;
      runtimeFeatureRegistry=featureRegistry;
      runtimeStatePort=statePort
    },
    async complete(startPromise){
      try {
        await Promise.all([startPromise,mediaReady]);
        applicationLifecycleReady=true
      } catch (error) {
        showAuthGate();
        $("#auth-status").textContent=error.message;
        await opening?.fail(error)
      } finally {
        document.documentElement.dataset.runtimeReady="1"
      }
    }
  }
}
