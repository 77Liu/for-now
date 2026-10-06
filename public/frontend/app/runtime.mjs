import { createApiClient } from "../api/index.mjs";
import { createFeatureRegistry } from "../feature-registry/index.mjs";
import { createBrowserApplication } from "./application.mjs";
import {
  createTagMultiSelectState,
  handleTagMultiSelectKey,
  reduceTagMultiSelectState
} from "../components/tag-multiselect/index.mjs";
import { createLatexRenderer, escapeHtml, plainPreview, presentError, renderMarkdown } from "../content/index.mjs";
import {
  createActionsCoordinator,
  createHomeMemoryPool,
  selectHomeMemories,
  keepsakePlacementCss,
  keepsakeMediaSources,
  scanKeepsakeAlpha,
  createOnboardingV2Controller
} from "../features/index.mjs";
import {
  BASE_CHECKIN_METRICS,
  checkinMetricValue,
  createCheckinMetricConfig
} from "../features/checkins-model/index.mjs";
import { createCheckinsFeatureController } from "../features/checkins/index.mjs";
import {
  captureRecordPayload,
  createIndexedDbMediaDraftStore,
  imageRecordPayload,
  imageUnderstandingPayload,
  uploadPendingMediaItems,
  uploadOriginalImages,
  normalizeTtsPlaybackRate,
  validatedImageFiles
} from "../media/index.mjs";
import { createPageAudioCoordinator } from "../media/page-audio.mjs";
import { createPageRouter, createUnavailableRouteResult, ownerViewCapabilities, resolveApplicationRoute, viewSections } from "../pages/index.mjs";
import { sessionScope, sessionSerial, rotateSession } from "../session/index.mjs";
import { emptyClientState, state, replaceState, mergeStateSnapshot, resetState, subscribeState, publishDomains, createRefreshCoordinator } from "../state/index.mjs";
import { createIndexedDbSyncStore, createIncrementalSync, createRequestCoordinator } from "../sync/index.mjs";
import { createOccurrenceDraft, entryKeyIntent, eventDate, eventTimestamp, formatDate, formatDateKey, formatTime, localDateKey, localDateTimeForDate, occurrenceSubmission, persistedDateTimeInput, toLocalDateTimeInput } from "../time/index.mjs";

const appEntryUrl=new URL("../../app.js",import.meta.url);
const applicationBasePath=new URL(".",appEntryUrl).pathname.replace(/\/$/,"")||"/";
const initialRuntimeRoute=resolveApplicationRoute(location,{basePath:applicationBasePath});
const initialRuntimeView=initialRuntimeRoute.view;
const portFactoriesRequest=globalThis.__forNowPortsRequest||import("./ports.mjs");
const legacyFeatureModuleRequest=globalThis.__forNowLegacyFeatureRequest||(["export","feedback","discovery","notifications","captures","journals","books","quotes","keepsakes","review","mine","personal-context","statistics","ai-cost","architecture","commercialization","trash","permission","account","settings","about"].includes(initialRuntimeView)?null:import("../features/legacy-pages/index.mjs"));
const exportFeatureModuleRequest=globalThis.__forNowExportFeatureRequest||(initialRuntimeView==="export"?import("../features/export/index.mjs"):null);
const feedbackFeatureModuleRequest=globalThis.__forNowFeedbackFeatureRequest||(initialRuntimeView==="feedback"?import("../features/feedback/index.mjs"):null);
const discoveryFeatureModuleRequest=globalThis.__forNowDiscoveryFeatureRequest||(initialRuntimeView==="discovery"?import("../features/thought-discovery/index.mjs"):null);
const notificationsFeatureModuleRequest=globalThis.__forNowNotificationsFeatureRequest||(initialRuntimeView==="notifications"?import("../features/notifications/index.mjs"):null);
let reviewInsightsFeatureModuleRequest=globalThis.__forNowReviewInsightsFeatureRequest||(["review","statistics"].includes(initialRuntimeView)?import("../features/review-insights/index.mjs"):null);
let keepsakesFeatureModuleRequest=globalThis.__forNowKeepsakesFeatureRequest||(initialRuntimeView==="keepsakes"?import("../features/keepsakes/index.mjs"):null);
let mineShellFeatureModuleRequest=globalThis.__forNowMineShellFeatureRequest||(["mine","permission","about"].includes(initialRuntimeView)?import("../features/mine-shell/index.mjs"):null);
let personalContextFeatureModuleRequest=globalThis.__forNowPersonalContextFeatureRequest||(initialRuntimeView==="personal-context"?import("../features/personal-context/loader.mjs"):null);
let ownerConsoleFeatureModuleRequest=null;
let accountSettingsFeatureModuleRequest=globalThis.__forNowAccountSettingsFeatureRequest||(["account","settings"].includes(initialRuntimeView)?import("../features/account-settings/loader.mjs"):null);
let trashFeatureModuleRequest=globalThis.__forNowTrashFeatureRequest||(initialRuntimeView==="trash"?import("../features/trash/loader.mjs"):null);
let captureJournalFeatureModuleRequest=globalThis.__forNowCaptureJournalFeatureRequest||(["captures","journals"].includes(initialRuntimeView)?import("../features/capture-journal/index.mjs"):null);
let annotationsFeatureModuleRequest=globalThis.__forNowAnnotationsFeatureRequest||null;
let backgroundResultsFeatureModuleRequest=globalThis.__forNowBackgroundResultsFeatureRequest||null;
let healthFeatureModuleRequest=globalThis.__forNowHealthFeatureRequest||null;
let thoughtsFeatureModuleRequest=globalThis.__forNowThoughtsFeatureRequest||(["thoughts","together"].includes(initialRuntimeView)?import("../features/thoughts/index.mjs"):null);
let quotesFeatureModuleRequest=globalThis.__forNowQuotesFeatureRequest||(initialRuntimeView==="quotes"?import("../features/quotes/index.mjs"):null);
let libraryFeatureModuleRequest=globalThis.__forNowLibraryFeatureRequest||(initialRuntimeView==="books"?import("../features/library/index.mjs"):null);
const loadLegacyFeatureModule=()=>legacyFeatureModuleRequest||import("../features/legacy-pages/index.mjs");
const loadActionsFeatureModule=()=>import("../features/actions/controller.mjs");
const loadAnnotationsFeatureModule=()=>{
  const pending=annotationsFeatureModuleRequest||import("../features/annotations/index.mjs");
  annotationsFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(annotationsFeatureModuleRequest===pending)annotationsFeatureModuleRequest=null;throw error})
};
const loadBackgroundResultsFeatureModule=()=>{
  const pending=backgroundResultsFeatureModuleRequest||import("../features/background-results/index.mjs");
  backgroundResultsFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(backgroundResultsFeatureModuleRequest===pending)backgroundResultsFeatureModuleRequest=null;throw error})
};
const loadHealthFeatureModule=()=>{
  const pending=healthFeatureModuleRequest||import("../features/health/controller.mjs");
  healthFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(healthFeatureModuleRequest===pending)healthFeatureModuleRequest=null;throw error})
};
const loadThoughtsFeatureModule=()=>{
  const pending=thoughtsFeatureModuleRequest||import("../features/thoughts/index.mjs");
  thoughtsFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(thoughtsFeatureModuleRequest===pending)thoughtsFeatureModuleRequest=null;throw error})
};
const loadCaptureJournalFeatureModule=()=>{
  const pending=captureJournalFeatureModuleRequest||import("../features/capture-journal/index.mjs");
  captureJournalFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(captureJournalFeatureModuleRequest===pending)captureJournalFeatureModuleRequest=null;throw error})
};
const loadQuotesFeatureModule=()=>{
  const pending=quotesFeatureModuleRequest||import("../features/quotes/index.mjs");
  quotesFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(quotesFeatureModuleRequest===pending)quotesFeatureModuleRequest=null;throw error})
};
const loadLibraryFeatureModule=()=>{
  const pending=libraryFeatureModuleRequest||import("../features/library/index.mjs");
  libraryFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(libraryFeatureModuleRequest===pending)libraryFeatureModuleRequest=null;throw error})
};
const loadReviewInsightsFeatureModule=()=>{
  const pending=reviewInsightsFeatureModuleRequest||import("../features/review-insights/index.mjs");
  reviewInsightsFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(reviewInsightsFeatureModuleRequest===pending)reviewInsightsFeatureModuleRequest=null;throw error})
};
const loadKeepsakesFeatureModule=()=>{
  const pending=keepsakesFeatureModuleRequest||import("../features/keepsakes/index.mjs");
  keepsakesFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(keepsakesFeatureModuleRequest===pending)keepsakesFeatureModuleRequest=null;throw error})
};
const loadMineShellFeatureModule=()=>{
  const pending=mineShellFeatureModuleRequest||import("../features/mine-shell/index.mjs");
  mineShellFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(mineShellFeatureModuleRequest===pending)mineShellFeatureModuleRequest=null;throw error})
};
const loadPersonalContextFeatureModule=()=>{
  const pending=personalContextFeatureModuleRequest||import("../features/personal-context/loader.mjs");
  personalContextFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(personalContextFeatureModuleRequest===pending)personalContextFeatureModuleRequest=null;throw error})
};
const loadOwnerConsoleFeatureModule=()=>{
  const pending=ownerConsoleFeatureModuleRequest||import("../features/owner-console/loader.mjs");
  ownerConsoleFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(ownerConsoleFeatureModuleRequest===pending)ownerConsoleFeatureModuleRequest=null;throw error})
};
const loadAccountSettingsFeatureModule=()=>{
  const pending=accountSettingsFeatureModuleRequest||import("../features/account-settings/loader.mjs");
  accountSettingsFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(accountSettingsFeatureModuleRequest===pending)accountSettingsFeatureModuleRequest=null;throw error})
};
const loadTrashFeatureModule=()=>{
  const pending=trashFeatureModuleRequest||import("../features/trash/loader.mjs");
  trashFeatureModuleRequest=pending;
  return Promise.resolve(pending).catch(error=>{if(trashFeatureModuleRequest===pending)trashFeatureModuleRequest=null;throw error})
};
const startupPerformanceEnabled=new URLSearchParams(location.search).has("native-performance");
const startupMarks={navigationStart:0,moduleLoaded:Number(performance.now().toFixed(1))};
function markStartup(name){startupMarks[name]=Number(performance.now().toFixed(1));return startupMarks[name]}
function adoptStartupMarks(value){for(const[name,mark]of Object.entries(value||{})){if(Number.isFinite(mark))startupMarks[name]=mark}}
function publishStartupTiming(){
  if(!startupPerformanceEnabled&&document.documentElement.dataset.nativePerformance!=="1")return;
  const metric=document.querySelector("#startup-performance-metric");if(!metric)return;
  const ordered=["moduleLoaded","bootstrapStart","authSessionReady","loadStart","coreSnapshotReady","visibleShell","secondaryReady","stableHome"],segments={};let previous=0;
  for(const name of ordered){const value=startupMarks[name];if(!Number.isFinite(value))continue;segments[name]=Number((value-previous).toFixed(1));previous=value}
  metric.textContent=`启动分段 ${JSON.stringify({marks:startupMarks,segments,totalMs:startupMarks.stableHome||previous})}`
}
const apiClient=createApiClient({baseUrl:appEntryUrl,apiOrigin:document.documentElement.dataset.apiOrigin||"",session:sessionScope,onAuthRequired:error=>showAuthGate(error?.code==="AUTH_REAUTH_REQUIRED"?"账户权限已变更，请重新登录。":"")});
const appUrl=apiClient.appUrl;
const syncStore=createIndexedDbSyncStore();
const mediaDraftStore=createIndexedDbMediaDraftStore();
const onboardingDraftStore=createIndexedDbMediaDraftStore({databaseName:"cike-onboarding-v2-drafts"});
const pageAudioCoordinator=createPageAudioCoordinator();
let contentImageDraftManager=null,contentImageDraftManagerRequest=null;
const uncertainMediaSubmission=error=>{const status=Number(error?.status||error?.statusCode||0);return!status||[408,425,429].includes(status)||status>=500};
async function initializeContentImageDraftManager(){
  if(contentImageDraftManager)return contentImageDraftManager;
  const pending=contentImageDraftManagerRequest||import("../media/content-image-drafts.mjs");
  contentImageDraftManagerRequest=pending;
  try{
    const images=await pending;
    contentImageDraftManager||=images.createContentImageDraftManager({
      store:mediaDraftStore,
      validateFiles:(files,maxItems)=>runPublicValidation(()=>validatedImageFiles(files,maxItems)),
      uploadPendingItems:uploadPendingMediaItems,
      uploadItem:async(file,idempotencyKey)=>{
        const [image]=await imageDataUrls([file]);
        return(await uploadOriginalImages({request,images:[image],idempotencyKey}))[0]
      },
      discardItem:(item,fallbackRequestId)=>discardUploadedMediaItem(item,fallbackRequestId)
    });
    return contentImageDraftManager
  }catch(error){if(contentImageDraftManagerRequest===pending)contentImageDraftManagerRequest=null;throw error}
}
const requestCoordinator=createRequestCoordinator({store:syncStore,send:(url,options)=>request(url,options)});
const refreshCoordinator=createRefreshCoordinator({
  session:sessionScope,
  requestState:async()=>{
    const route=pageRouter?.currentRoute(),key=routeDataKey(route),snapshot=await requestRouteState(route);
    return key===routeDataKey(pageRouter?.currentRoute())?{...state,...snapshot}:state
  },
  afterReplace:()=>restorePendingProjections()
});
const BACKGROUND_RESULTS_RETRY_LIMIT=3;
const LOCAL_TEST_VIEW_SCOPES=Object.freeze({today:"today",daily:"daily",captures:"captures",books:"books",quotes:"quotes",keepsakes:"keepsakes",journals:"journals",thoughts:"thoughts",discovery:"discovery",together:"together",review:"review",statistics:"statistics","ai-cost":"statistics",commercialization:"statistics","personal-context":"personal-context",feedback:"feedback",export:"export",trash:"trash"});
const localTestScopeLoads=new Map();
const baseMetrics=BASE_CHECKIN_METRICS;
const defaultLlmProfiles={lite:{model:"deepseek-flash",effort:"none"},mid:{model:"deepseek-flash",effort:"high"},high:{model:"deepseek-v4-pro",effort:"high"},ultra:{model:"deepseek-v4-pro",effort:"max"}};
const defaultLlmScenarios={thoughtPrompt:"lite",thoughtDraft:"high",thoughtAnswer:"ultra",followUpAnswer:"ultra",chat:"high",diaryLead:"lite",diaryStructure:"mid",diaryTopic:"high",diaryReflection:"ultra",annotationShenji:"high",analysis:"ultra",bookRecognition:"mid",healthRecognition:"mid",contentImageUnderstanding:"mid",capturePolish:"mid"};
const defaultSceneEfforts={...Object.fromEntries(Object.entries(defaultLlmScenarios).map(([scene,tier])=>[scene,defaultLlmProfiles[tier].effort])),onboardingClaimExtraction:"high"};
const ownerCapabilities=[...new Set([...Object.values(ownerViewCapabilities),"local-testing","ai-configuration","account-roles"])];
let pageRouter,switchView,restoreView;
let runtimeApplication=null,runtimeFeatureRegistry=null,runtimeStatePort=null,applicationLifecycleReady=false;
let backgroundResultsController=null,backgroundResultsLoadErrorReported=false,backgroundResultsRetryAttempts=0;
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
let activeDate=currentLocalDate,activeDailyType="sleep",answerDraft="",answerReasoningDraft="",toastTimer,notificationTimer,draftTags=[],answerTaskSerial=0,activeAnswerTaskId=0,currentUser=null,notificationUnreadCount=0,chainDraftVersion=0,localTestConfig=null,onboardingSchema=null,onboardingMode="quick",onboardingDraftAnswers={},onboardingHydrated=false,governanceUrl="",authOperationSerial=0,authBusy=false,resetRouteAfterAuthentication=false,appVersion="0.5.7",releaseVersion="0.5.7",featureFlags={incrementalSync:true},syncController=null,syncHealth={status:"idle",pending:0,conflicts:0,failed:0,oldestAgeMs:0,enqueueToAckP95Ms:0,lastPullMs:0,lastError:""};
let notificationsLoadState="idle",routeDataReady=false,routeDataRequestSerial=0,routeLoadFailureKey="",loadedRouteKey="",fullRouteStateLoaded=false,renderedRouteView="";
const quoteTagPickerConfig=Object.freeze({
  selectionQuote:{input:"#selection-quote-tags",selected:"#selection-quote-selected-tags",options:"#selection-quote-tag-options",toggle:"#selection-quote-tag-toggle",status:"#selection-quote-tag-status"}
});
let quoteTagStates={
  selectionQuote:createTagMultiSelectState()
};
let homeMemoryKeys=[],homeMemoryByKey=new Map(),homeKeepsakeId="",homeEditorTrigger=null;
const persistentContentImageKeys=new Set(["capture","thoughtRoot","thoughtBlock","comment"]);
const imageViewer={paths:[],index:0,objectUrl:"",requestSerial:0,trigger:null};
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const ownerSurfaceVault=document.createDocumentFragment();
let ownerSurfaceEntries=null,currentCapabilities=new Set(),deniedAccess={},requestedAuthenticatedView="";
function hasCapability(capability){return currentCapabilities.has(capability)}
function applyCapabilitySurface(capabilities=[]){
  currentCapabilities=new Set(Array.isArray(capabilities)?capabilities:[]);
  if(!ownerSurfaceEntries){
    ownerSurfaceEntries=$$("[data-owner-capability]").map((node,index)=>{
      const marker=document.createComment(`owner-capability-${index}`);
      node.parentNode.insertBefore(marker,node);
      return{node,marker,capability:node.dataset.ownerCapability}
    })
  }
  for(const entry of ownerSurfaceEntries){
    if(hasCapability(entry.capability)){
      if(!entry.node.isConnected&&entry.marker.parentNode)entry.marker.parentNode.insertBefore(entry.node,entry.marker.nextSibling)
    }else if(entry.node.isConnected)ownerSurfaceVault.append(entry.node)
  }
}
function showPermissionPage(view,capability){
  deniedAccess={view,capability};
  if(!currentUser)requestedAuthenticatedView=view;
  const names={"ai-cost":"AI 成本",architecture:"架构设计",commercialization:"商业化"};
  const title=$("#permission-title"),copy=$("#permission-copy");
  if(title)title.textContent=`${names[view]||"此页面"}仅 Owner 可访问`;
  if(copy)copy.textContent=`当前账户没有访问此管理页面的权限（${capability}）。敏感内容未加载，你仍可继续使用个人记录与偏好设置。`
}
const createLatexAsset=(tagName,properties,kind)=>new Promise((resolve,reject)=>{const element=document.createElement(tagName);Object.assign(element,properties);element.dataset.latexAsset=kind;element.onload=resolve;element.onerror=()=>{document.querySelectorAll("[data-latex-asset]").forEach(asset=>asset.remove());reject(new Error(`LATEX_ASSET_LOAD_FAILED:${kind}`))};document.head.append(element)});
const renderLatex=createLatexRenderer({createAsset:createLatexAsset,getKatex:()=>window.katex,resolveAssetUrl:appUrl});
function currentContextSource(source){
  const type=source?.resourceType,id=source?.resourceId,key=source?.location?.targetKey||"";
  if(type==="onboarding"){
    const onboarding=state.onboarding;
    if(!onboarding||onboarding.status!=="completed")return{exists:false,text:""};
    const base={exists:true,version:Number(source.version)||1,occurredAt:onboarding.updatedAt||""};
    if(key==="understanding")return{...base,exists:Boolean(onboarding.understanding),text:onboarding.understanding||""};
    if(key==="viewpoints")return{...base,text:[Object.keys(onboarding.answers||{}).length?`初始问卷 ${Object.keys(onboarding.answers||{}).length} 项`:"",onboarding.material||""].filter(Boolean).join(" · ")};
    return{...base,text:[...Object.values(onboarding.profile||{}),...(onboarding.interests||[])].filter(Boolean).join(" · ")}
  }
  const collections={capture:"captures",journal:"journals",thought:"thoughts",checkin:"checkins",dailyRecord:"dailyRecords"},item=state[collections[type]]?.find(value=>value.id===id);
  if(!item)return{exists:false,text:""};
  const base={exists:true,version:Number(item.version)||1,occurredAt:item.occurredAt||item.createdAt||item.updatedAt||""};
  if(type==="capture")return{...base,text:item.content||"图片或语音捕念"};
  if(type==="journal")return{...base,text:`${item.title?`${item.title}：`:""}${item.content||""}`};
  if(type==="thought")return{...base,text:item.content||item.modelDraft||""};
  if(type==="checkin")return{...base,text:`情绪 ${item.mood} · 精力 ${item.energy} · 压力 ${item.stress} · 睡眠 ${item.sleep}`};
  return{...base,text:item.description||item.exerciseType||`${item.type||"健康"}记录`}
}
function contextSourceButton(source){
  const location=source?.location||{},live=source.excerpt?{exists:true,matches:true,text:source.excerpt}:currentContextSource(source),matches=Boolean(source.excerpt)||live.exists&&live.version===Number(source.version||1)&&(source.resourceType!=="onboarding"||!source.occurredAt||live.occurredAt===source.occurredAt),canOpen=live.exists&&location.view&&location.view!=="personal-context",copy=!live.exists?"来源已删除或当前不可用":matches?live.text:"来源当前版本已变化；旧摘录未保留";
  return `<article class="context-source-item${live.exists&&matches?"":" unavailable"}"><div><b>${escapeHtml(source.recordType||"记录")}</b><small>${escapeHtml(source.occurredOn||"时间未记")} · 版本 ${Number(source.version)||1}</small></div><p>${escapeHtml(plainPreview(copy))}</p>${canOpen?`<button class="subtle-action" type="button" data-context-source data-context-view="${escapeHtml(location.view)}" data-context-target="${escapeHtml(location.targetId||source.resourceId||"")}" data-context-root="${escapeHtml(location.rootId||"")}" data-context-key="${escapeHtml(location.targetKey||"")}" data-context-date="${escapeHtml(location.occurredOn||source.occurredOn||"")}" data-context-daily-type="${escapeHtml(location.dailyType||"")}">查看${matches?"原记录":"当前版本"}</button>`:""}</article>`
}
function contextReceiptMarkup(receipt){
  const sources=Array.isArray(receipt?.sources)?receipt.sources:[],budget=receipt?.tokenBudget;
  if(!sources.length)return"";
  const budgetText=budget?`${Number(budget.estimatedUsed)||0} / ${Number(budget.limit)||0} Token 上界`:"";
  return `<details class="context-audit"><summary><span>本次参考</span><small>${sources.length} 条${budgetText?` · ${budgetText}`:""}</small></summary><div class="context-source-list">${sources.map(contextSourceButton).join("")}</div></details>`
}
function openContextReceiptSource(button){
  const view=button.dataset.contextView,target=button.dataset.contextTarget,root=button.dataset.contextRoot,date=button.dataset.contextDate,dailyType=button.dataset.contextDailyType;
  if(date){activeDate=date;if(dailyType&&dailyTypeMeta[dailyType])activeDailyType=dailyType;renderDate();renderSliders();publishDomains(new Set(["thoughts","activeDate"]));renderStateChart();renderHomeMood();renderChat()}
  if(view==="thoughts")openThoughtDetail(root||target);else switchView(view);
  requestAnimationFrame(()=>{
    const selectors={
      thoughts:`[data-chain-id="${CSS.escape(root||target)}"]`,
      captures:`[data-capture-id="${CSS.escape(target)}"]`,
      journals:`[data-journal-id="${CSS.escape(target)}"]`,
      together:`[data-chat-id="${CSS.escape(target)}"]`,
      daily:`[data-daily-record-id="${CSS.escape(target)}"]`,
      today:`[data-checkin-id="${CSS.escape(target)}"]`
    },element=document.querySelector(selectors[view]||"");
    const chain=element?.closest?.("[data-chain-id]")||element;
    if(chain instanceof HTMLDetailsElement)chain.open=true;
    let destination=element;
    if(view==="thoughts"&&element){
      const key=button.dataset.contextKey||"";
      if(key.startsWith("question:"))destination=element.querySelector(".thought-question-content")||element;
      else if(/^(?:idea|record|answer):/.test(key))destination=element.querySelector(`[data-thought-block-id="${CSS.escape(key.split(":").slice(1).join(":"))}"]`)||element
    }
    destination?.scrollIntoView({behavior:"smooth",block:"center"})
  })
}
function clearThoughtTracePending(rootKey){const {type,id}=parseCommentRootKey(rootKey);if(type!=="thought"||!id)return;state.insights.aiOnlyThoughtIds=(state.insights.aiOnlyThoughtIds||[]).filter(value=>value!==id);document.querySelectorAll(`[data-chain-id="${CSS.escape(id)}"]`).forEach(card=>card.closest(".thought-timeline-entry")?.querySelector(".thought-trace-pending")?.remove())}
let annotationsController=null,annotationRootKey=null,parseAnnotationRootKey=null;
function createRuntimeAnnotationsController(module){return module.createAnnotationsFeatureController({
  data:{
    getSnapshot:()=>state,
    getAccountId:()=>currentUser?.id||"",
    request,
    refreshNotifications:()=>refreshState("notifications"),
    scheduleNotificationPoll,
    clearThoughtTracePending,
    openSelectionQuote:openSelectionQuoteModal
  },
  media:{
    resetDraft:()=>resetContentImageEditor("comment"),
    startDraft:selection=>{void contentImageDraftManager.persist("comment",{selection,text:"",requestId:"",assistantClientRequestId:""})},
    persistDraft:()=>persistContentImageDraft("comment"),
    submitDraft:()=>contentImagePaths("comment"),
    buildPayload:imageRecordPayload,
    clearDraft:()=>clearSubmittedContentImageDraft("comment"),
    discardUploads:paths=>discardContentImageUploads("comment",paths),
    uncertainSubmission:uncertainMediaSubmission,
    contentImagesMarkup
  },
  view:{
    escapeHtml,
    renderMarkdown,
    renderLatex,
    contextReceiptMarkup,
    emptyStateMarkup:text=>empty(text),
    formatDate,
    showToast
  },
  platform:{
    document,
    window,
    storage:sessionStorage,
    createRequestId:()=>crypto.randomUUID(),
    confirm:(...args)=>globalThis.confirm(...args),
    prompt:(...args)=>globalThis.prompt(...args),
    requestFrame:callback=>requestAnimationFrame(callback),
    cancelFrame:frame=>cancelAnimationFrame(frame),
    setTimer:(callback,delay)=>setTimeout(callback,delay),
    clearTimer:timer=>clearTimeout(timer),
    matchesMedia:query=>matchMedia(query).matches,
    escapeSelector:value=>CSS.escape(value),
    writeClipboard:value=>navigator.clipboard.writeText(value)
  }
})}
async function ensureAnnotationsController(){
  if(annotationsController)return annotationsController;
  const module=await loadAnnotationsFeatureModule();
  if(!annotationsController){
    annotationRootKey=module.annotationRootKey;parseAnnotationRootKey=module.parseAnnotationRootKey;
    annotationsController=createRuntimeAnnotationsController(module)
  }
  return annotationsController
}
const commentRootKey=(type,id)=>annotationRootKey?annotationRootKey(type,id):`${type}:${id}`;
const parseCommentRootKey=value=>parseAnnotationRootKey?parseAnnotationRootKey(value):(()=>{const divider=String(value||"").indexOf(":");return divider<1?{type:"",id:""}:{type:value.slice(0,divider),id:value.slice(divider+1)}})();
const commentRoot=value=>annotationsController?.getRoot(value)||null;
const commentRootLabel=value=>annotationsController?.rootLabel(value)||"正文";
const markCommentTarget=(...args)=>annotationsController?.markTarget(...args);
const tagCommentableTargets=(...args)=>annotationsController?.tagThoughtTargets(...args);
const applyCommentAnchors=(...args)=>annotationsController?.applyAnchors(...args);
const scheduleAnnotationLineCounts=()=>annotationsController?.scheduleLayout();
const restoreAnnotationUiDrafts=()=>annotationsController?.restoreDrafts();
const renderCommentPanel=(...args)=>annotationsController?.renderPanel(...args);
const openCommentPanel=(...args)=>annotationsController?.openPanel(...args);
function patchActiveThoughtTarget(target){for(const controller of thoughtsFeatureControllers)if(controller.patchTarget(target))return true;return false}
function reconcileActiveThoughtRoute(){for(const controller of thoughtsFeatureControllers)if(controller.reconcileRoute())return true;return false}
function createRuntimeBackgroundResultsController(module){return module.createBackgroundResultsFeatureController({
  data:{getSnapshot:()=>state,getAccountId:()=>currentUser?.id||"",replaceSnapshot:replaceState,request,refresh:(domains,options)=>refreshState(domains,options),publish:domains=>publishDomains(new Set(domains))},
  navigation:{openThoughtDetail,switchView},
  annotations:{
    openTarget:async(target,isCurrent)=>{const controller=await ensureAnnotationsController();if(!isCurrent())return false;controller.openPanel(commentRootKey(target.resourceType,target.targetId),target.annotationId);return true},
    refreshTarget:target=>{const controller=annotationsController,annotation=controller?.findTaskAnnotation(target);if(annotation&&controller.isActiveRoot(commentRootKey(target.resourceType,target.targetId)))controller.refreshAnnotation(annotation);return true}
  },
  view:{patchThoughtTarget:patchActiveThoughtTarget,scheduleAnnotationLayout:scheduleAnnotationLineCounts,showToast},
  platform:{document,window,requestFrame:callback=>requestAnimationFrame(callback),escapeSelector:value=>CSS.escape(value)}
})}
async function ensureBackgroundResultsController(){
  if(backgroundResultsController)return backgroundResultsController;const module=await loadBackgroundResultsFeatureModule();
  backgroundResultsController||=createRuntimeBackgroundResultsController(module);return backgroundResultsController
}
async function syncBackgroundTaskResults(tasks,owner,session){
  if(!(Array.isArray(tasks)&&tasks.some(task=>task?.status==="succeeded"&&task?.resultId))){backgroundResultsRetryAttempts=0;return false}
  try{const controller=await ensureBackgroundResultsController();if(owner!==currentUser?.id||session!==sessionSerial)return false;backgroundResultsLoadErrorReported=false;const changed=await controller.sync(tasks);backgroundResultsRetryAttempts=controller.needsRetry()?Math.min(BACKGROUND_RESULTS_RETRY_LIMIT,backgroundResultsRetryAttempts+1):0;return changed}catch(error){
    backgroundResultsRetryAttempts=Math.min(BACKGROUND_RESULTS_RETRY_LIMIT,backgroundResultsRetryAttempts+1);
    if(owner===currentUser?.id&&session===sessionSerial&&!backgroundResultsLoadErrorReported){backgroundResultsLoadErrorReported=true;showToast(`后台结果模块加载失败：${error.message}`,"error")}
    return false
  }
}
function formIdentity(form,index){return`form:${index}`}
function formFieldIdentity(field,index){
  if(field instanceof HTMLInputElement&&field.type==="radio"&&field.name)return`name:${field.name}:value:${field.value}`;
  return field.name?`name:${field.name}`:field.id?`id:${field.id}`:`field:${index}`
}
function captureFormsDraft(forms){
  const active=document.activeElement;
  return[...forms].map((form,index)=>({
    key:formIdentity(form,index),hidden:form.hidden,requestId:form.dataset.requestId||"",
    fields:[...form.querySelectorAll("input,textarea,select")].map((field,fieldIndex)=>({
      key:formFieldIdentity(field,fieldIndex),
      value:field.value,checked:field instanceof HTMLInputElement&&["checkbox","radio"].includes(field.type)?field.checked:null,focused:field===active,
      selectionStart:typeof field.selectionStart==="number"?field.selectionStart:null,
      selectionEnd:typeof field.selectionEnd==="number"?field.selectionEnd:null
    }))
  }))
}
function restoreFormsDraft(forms,drafts){
  let focusedField=null,selectionStart=null,selectionEnd=null;
  for(const [index,form]of forms.entries()){
    const draft=drafts.find(item=>item.key===formIdentity(form,index));if(!draft)continue;
    form.hidden=draft.hidden;if(draft.requestId)form.dataset.requestId=draft.requestId;
    const fields=[...form.querySelectorAll("input,textarea,select")];
    for(const [fieldIndex,field]of fields.entries()){
      const key=formFieldIdentity(field,fieldIndex),saved=draft.fields.find(item=>item.key===key);if(!saved)continue;
      if(saved.checked!==null)field.checked=saved.checked;else field.value=saved.value;
      if(saved.focused){focusedField=field;selectionStart=saved.selectionStart;selectionEnd=saved.selectionEnd}
    }
  }
  if(focusedField){focusedField.focus({preventScroll:true});if(selectionStart!==null&&typeof focusedField.setSelectionRange==="function")focusedField.setSelectionRange(selectionStart,selectionEnd)}
  return focusedField
}
const durableDraftForms=["chain-form","checkin-form"];
const durableDraftKey=()=>currentUser?.id?`cike:session-drafts:${currentUser.id}`:"";
function saveDurableDrafts(){
  const key=durableDraftKey();if(!key)return;
  const forms=durableDraftForms.map(id=>document.getElementById(id)).filter(Boolean),drafts=captureFormsDraft(forms);
  let previous=null;try{previous=JSON.parse(sessionStorage.getItem(key)||"null")}catch{}
  const payload={...(previous||{}),forms:drafts,draftTags};
  try{sessionStorage.setItem(key,JSON.stringify(payload))}catch{}
}
function restoreDurableDrafts(){
  const key=durableDraftKey();if(!key)return;
  try{
    const payload=JSON.parse(sessionStorage.getItem(key)||"null");if(!payload)return;
    restoreFormsDraft(durableDraftForms.map(id=>document.getElementById(id)).filter(Boolean),payload.forms||[]);
    draftTags=Array.isArray(payload.draftTags)?payload.draftTags:[];
    renderTagComposer()
  }catch{}
}
function clearDurableDraft(formId=""){
  const key=durableDraftKey();if(!key)return;
  if(!formId){sessionStorage.removeItem(key);return}
  saveDurableDrafts();
  try{const payload=JSON.parse(sessionStorage.getItem(key)||"null");if(!payload)return;payload.forms=(payload.forms||[]).filter(item=>item.key!==`form:${durableDraftForms.indexOf(formId)}`);sessionStorage.setItem(key,JSON.stringify(payload))}catch{}
}
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
const avg=v=>v.length?v.reduce((s,x)=>s+Number(x),0)/v.length:null;
function runPublicValidation(callback){
  try{return callback()}
  catch(error){
    const validationError=new Error(String(error?.message||"输入不符合要求"),{cause:error});
    validationError.publicValidation=true;
    throw validationError
  }
}
const formatBytes=value=>value<1024?`${value} B`:value<1048576?`${(value/1024).toFixed(1)} KB`:`${(value/1048576).toFixed(1)} MB`;
const imageDataUrls=files=>Promise.all(files.map(file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("无法读取图片，请重新选择"));reader.readAsDataURL(file)})));
function contentImageDraft(key){return contentImageDraftManager?.snapshot(key)||{owner:"",key,items:[],uploadRequestId:"",context:null}}
function currentContentImageContext(key){
  if(key==="comment")return annotationsController?.commentDraftContext()||null;
  if(key==="thoughtBlock"){
    const form=$("#thought-block-form"),rootId=$("#thought-block-root-id")?.value||"";
    if(!form||!rootId)return null;
    return{
      rootId,
      blockId:$("#thought-block-id").value,
      type:$("#thought-block-type").value,
      occurredAt:$("#thought-block-datetime").value,
      content:$("#thought-block-content").value,
      version:Number(form.dataset.version)||1,
      requestId:form.dataset.requestId||""
    }
  }
  return null
}
async function persistContentImageDraft(key){
  if(!currentUser?.id||!persistentContentImageKeys.has(key)||(key==="capture"&&$("#capture-id")?.value))return;
  const draft=contentImageDraft(key),context=currentContentImageContext(key)||draft.context||null;
  return contentImageDraftManager.persist(key,context)
}
function contentImageDraftView(key,draft){
  if(key==="capture")return"captures";
  if(key==="thoughtRoot")return"today";
  if(key==="thoughtBlock")return"thoughts";
  if(key!=="comment")return"";
  const type=parseCommentRootKey(draft?.context?.selection?.rootKey).type;
  return({thought:"thoughts",capture:"captures",journal:"journals",chat:"together",analysis:"review",book:"books",quote:"quotes"})[type]||""
}
function activateContentImageDraft(key,owner){
  const draft=contentImageDraft(key),view=contentImageDraftView(key,draft);
  const hasDraft=Boolean(draft&&(draft.items.length||draft.context));
  if(!hasDraft||(view&&pageRouter?.currentRoute()?.view!==view))return false;
  renderContentImageEditor(key);
  const status=document.querySelector(`[data-content-image-editor="${CSS.escape(key)}"]`)?.closest("form")?.querySelector(".status");
  if(status&&!status.textContent){
    const failed=draft.items.filter(item=>item.lastError).length;
    status.textContent=draft.items.length?`已恢复 ${draft.items.length} 张待上传图片${failed?`，其中 ${failed} 张可重试`:""}。`:"已恢复未提交评论。"
  }
  if(key==="comment"){
    if(!annotationsController)return false;
    const restored=annotationsController.restoreCommentDraft(draft.context);
    if(restored==="invalid")return void abandonContentImageDraft(owner,key);
    return restored
  }
  if(key==="thoughtBlock"){
    const context=draft.context;
    if(!context?.rootId)return void abandonContentImageDraft(owner,key);
    const root=state.thoughts.find(item=>item.id===context.rootId&&item.type==="question"),item=context.blockId?state.thoughts.find(value=>value.id===context.blockId&&value.relatedTo===context.rootId):null;
    if(!root||(context.blockId&&!item))return false;
    const form=$("#thought-block-form"),select=$("#thought-block-type");
    $("#thought-block-root-id").value=context.rootId;$("#thought-block-id").value=context.blockId||"";form.dataset.version=String(context.version||item?.version||1);
    if(context.requestId)form.dataset.requestId=context.requestId;
    select.value=context.type||item?.type||"record";select.disabled=Boolean(context.blockId);$("#thought-block-datetime").value=context.occurredAt||toLocalDateTimeInput(eventTimestamp(item||root));$("#thought-block-content").value=context.content||"";
    $("#thought-block-title").textContent=context.blockId?"编辑内容":`新增${select.options[select.selectedIndex].text}`;$("#thought-block-modal").hidden=false
  }
  return true
}
function activateContentImageDraftsForCurrentRoute(owner=currentUser?.id){
  if(!owner)return;
  for(const key of persistentContentImageKeys)activateContentImageDraft(key,owner)
}
async function restoreContentImageDrafts(owner){
  if(!owner)return;
  const manager=await initializeContentImageDraftManager();
  await manager.restore(owner);
  activateContentImageDraftsForCurrentRoute(owner)
}
async function abandonContentImageDraft(owner,key){
  if(owner!==currentUser?.id)return false;
  const changed=await contentImageDraftManager.abandon(key);
  renderContentImageEditor(key);
  return changed
}
function renderContentImageEditor(key){
  const editor=document.querySelector(`[data-content-image-editor="${CSS.escape(key)}"]`),draft=contentImageDraft(key);if(!editor||!draft)return;
  const previews=editor.querySelector("[data-content-image-previews]");
  previews.innerHTML=draft.items.map((item,index)=>`<figure class="content-image-preview"><img src="${escapeHtml(item.preview||appUrl(item.path))}" alt="图片 ${index+1}"><button type="button" data-content-image-remove="${index}" aria-label="移除图片 ${index+1}" title="移除图片">×</button></figure>`).join("");
  const input=editor.querySelector('input[type="file"]');if(input)input.disabled=draft.items.length>=2
}
function resetContentImageEditor(key,paths=[],{forget=true,preserveStored=false}={}){
  const input=document.querySelector(`[data-content-image-editor="${CSS.escape(key)}"] input[type="file"]`);if(input)input.value="";
  const operation=contentImageDraftManager.replaceExisting(key,paths,{compensate:forget,preserveStored:preserveStored||!forget});
  renderContentImageEditor(key);
  void operation.then(()=>renderContentImageEditor(key)).catch(()=>{});
  return operation
}
async function clearSubmittedContentImageDraft(key){
  const changed=await contentImageDraftManager.complete(key);
  renderContentImageEditor(key);
  return changed
}
async function setContentImageFiles(key,files){
  const operation=contentImageDraftManager.select(key,files);
  renderContentImageEditor(key);
  const result=await operation;renderContentImageEditor(key);
  return result
}
async function contentImagePaths(key){
  const result=await contentImageDraftManager.submit(key);
  renderContentImageEditor(key);
  return result
}
async function discardUploadedMediaItem(item,fallbackRequestId=""){
  const attachmentPath=item?.uploadedPath,uploadRequestId=item?.uploadRequestId||fallbackRequestId;
  if(!attachmentPath||!uploadRequestId)return false;
  try{
    const result=await request("/api/images/discard",{method:"POST",body:JSON.stringify({attachmentPaths:[attachmentPath],uploadRequestId})});
    return result.discarded?.includes(attachmentPath)
  }catch{return false}
}
async function discardUploadedImagePath(attachmentPath,uploadRequestId){
  return discardUploadedMediaItem({uploadedPath:attachmentPath,uploadRequestId})
}
async function discardContentImageUploads(key,uploadedPaths){
  if(!uploadedPaths.length)return false;
  const result=await contentImageDraftManager.rollback(key,Object.assign(new Error("submission failed"),{status:400}),{uploadedPaths});
  renderContentImageEditor(key);
  return result
}
function viewerAttachmentPath(value){
  return typeof value==="string"&&/^\/attachments\/[\w.-]+$/.test(value)?value:""
}
function revokeImageViewerUrl(){
  if(imageViewer.objectUrl)URL.revokeObjectURL(imageViewer.objectUrl);
  imageViewer.objectUrl="";
  const image=$("#image-viewer-image");
  image?.removeAttribute("src")
}
function renderImageViewerNavigation(){
  const total=imageViewer.paths.length,index=imageViewer.index;
  $("#image-viewer-counter").textContent=total?`${index+1} / ${total}`:"";
  $("#image-viewer-prev").disabled=index<=0;
  $("#image-viewer-next").disabled=index>=total-1
}
async function loadImageViewerImage(){
  const modal=$("#image-viewer"),path=imageViewer.paths[imageViewer.index];
  if(modal.hidden||!path)return;
  const serial=++imageViewer.requestSerial,image=$("#image-viewer-image"),status=$("#image-viewer-status");
  revokeImageViewerUrl();image.hidden=true;status.classList.remove("error");status.textContent="正在安全读取原图…";renderImageViewerNavigation();
  try{
    const blob=await apiClient.readBlob(path);
    if(serial!==imageViewer.requestSerial||modal.hidden)return;
    imageViewer.objectUrl=URL.createObjectURL(blob);image.src=imageViewer.objectUrl;image.alt=`原图 ${imageViewer.index+1}`;image.hidden=false;status.textContent=""
  }catch(error){
    if(serial!==imageViewer.requestSerial||modal.hidden)return;
    status.classList.add("error");status.textContent=presentError(error,{
      operation:"读取原图",
      object:"这张原图",
      retained:"原记录和其他图片没有变化"
    }).message
  }
}
function openImageViewer(button){
  const path=viewerAttachmentPath(button?.dataset.imageViewerPath);
  if(!path)return;
  const group=button.closest(".content-originals,.daily-attachments"),paths=[...(group?.querySelectorAll("[data-image-viewer-path]")||[button])].map(item=>viewerAttachmentPath(item.dataset.imageViewerPath)).filter(Boolean);
  imageViewer.paths=paths.length?paths:[path];imageViewer.index=Math.max(0,imageViewer.paths.indexOf(path));imageViewer.trigger=button;
  $("#image-viewer").hidden=false;document.body.classList.add("image-viewer-open");renderImageViewerNavigation();$("#image-viewer-close").focus();void loadImageViewerImage()
}
function closeImageViewer({restoreFocus=true}={}){
  const modal=$("#image-viewer");if(!modal||modal.hidden)return;
  imageViewer.requestSerial+=1;revokeImageViewerUrl();modal.hidden=true;document.body.classList.remove("image-viewer-open");$("#image-viewer-status").textContent="";
  const trigger=imageViewer.trigger;imageViewer.paths=[];imageViewer.index=0;imageViewer.trigger=null;
  if(restoreFocus&&trigger?.isConnected)trigger.focus()
}
function moveImageViewer(step){
  if($("#image-viewer").hidden)return;
  const next=Math.max(0,Math.min(imageViewer.paths.length-1,imageViewer.index+step));
  if(next===imageViewer.index)return;
  imageViewer.index=next;void loadImageViewerImage()
}
function pendingContentImageTask(targetType,targetId){
  return(state.aiTasks||[]).find(task=>task.kind==="contentImageUnderstanding"&&task.contentTargetType===targetType&&task.contentTargetId===targetId&&["queued","running","cancelling"].includes(task.status))
}
function contentImagesMarkup(resource,targetType){
  const paths=Array.isArray(resource?.attachmentPaths)?resource.attachmentPaths:[],understandings=Array.isArray(resource?.imageUnderstandings)?resource.imageUnderstandings:[];
  if(!paths.length&&!understandings.length)return"";
  const pending=pendingContentImageTask(targetType,resource.id);
  return `<section class="content-attachments" data-content-attachments="${escapeHtml(targetType)}:${escapeHtml(resource.id)}">${paths.length?`<div class="content-originals">${paths.map((source,index)=>`<button class="content-original-button" type="button" data-image-viewer-path="${escapeHtml(source)}" title="查看原图 ${index+1}" aria-label="查看原图 ${index+1}"><img src="${escapeHtml(appUrl(source))}" alt="图片 ${index+1}" loading="lazy"></button>`).join("")}</div>`:""}${understandings.map(item=>`<div class="content-understanding"><small>AI 图片理解</small><div class="markdown-content">${renderMarkdown(item.content)}</div></div>`).join("")}${paths.length?`<div class="content-image-actions"><button type="button" data-content-image-understand="${escapeHtml(targetType)}" data-content-target-id="${escapeHtml(resource.id)}" data-content-version="${resource.version||1}" ${pending?"disabled":""}>✦ ${understandings.length?"重新理解":"理解图片"}</button><span class="content-image-task-status">${pending?"正在后台理解…":""}</span></div>`:""}</section>`
}
function contentImageResource(targetType,targetId){
  if(targetType==="capture")return(state.captures||[]).find(item=>item.id===targetId)||null;
  if(targetType==="thoughtRoot")return(state.thoughts||[]).find(item=>item.id===targetId&&item.type==="question")||null;
  if(targetType==="thoughtBlock")return(state.thoughts||[]).find(item=>item.id===targetId&&item.type!=="question")||null;
  if(targetType!=="comment")return null;
  for(const collection of["thoughts","captures","journals","chats","analyses","books","quotes"]){
    for(const parent of state[collection]||[]){
      const found=(parent.annotations||[]).find(item=>item.id===targetId);
      if(found)return found
    }
  }
  return null
}
async function queueContentImageUnderstanding(button){
  const targetType=button.dataset.contentImageUnderstand,targetId=button.dataset.contentTargetId,resource=contentImageResource(targetType,targetId),requestId=button.dataset.requestId||crypto.randomUUID();
  if(!resource?.attachmentPaths?.length)return;
  button.dataset.requestId=requestId;
  button.disabled=true;const status=button.parentElement?.querySelector(".content-image-task-status");if(status)status.textContent="正在加入后台队列…";
  try{
    const response=await requestV1("/api/v1/content-attachments/understandings",{
      method:"POST",
      headers:{"idempotency-key":requestId},
      body:JSON.stringify(imageUnderstandingPayload({targetType,targetId,inputVersion:resource.version||1,attachmentPaths:resource.attachmentPaths}))
    }),task=response.data;
    if(task&&!state.aiTasks.some(item=>item.id===task.id))state.aiTasks.unshift(task);
    if(status)status.textContent="正在后台理解…";
    await refreshState("notifications");scheduleNotificationPoll();showToast("图片理解已进入后台队列")
  }catch(error){
    const message=presentError(error,{
      operation:"提交图片理解",
      object:"这次图片理解",
      phase:"图片理解排队",
      retained:"原图和已有记录已经保存"
    }).message;
    if(status)status.textContent=message;button.disabled=false;showToast(message,"error")
  }
}
const formSnapshot=form=>JSON.stringify([...new FormData(form).entries()]);
const occurrenceSelector=[
  "#chain-datetime","#checkin-datetime","#chat-datetime","#capture-date","#journal-date",
  '[data-daily-form] [name="occurredAt"]','[data-book-entry-form] [name="occurredAt"]',
  "#keepsake-datetime","#quote-datetime","#selection-quote-datetime","#thought-block-datetime"
].join(",");
const occurrenceHost=input=>input?.closest("label")||input?.parentElement;
function setOccurrenceMode(input,mode,{refreshValue=false}={}){
  if(!input)return;
  const next=mode==="manual"?"manual":"now";input.dataset.occurrenceMode=next;
  if(refreshValue||!input.value)input.value=createOccurrenceDraft({selectedDate:activeDate,now:new Date()}).manualValue;
  input.disabled=next==="now";input.hidden=next==="now";
  occurrenceHost(input)?.querySelectorAll("[data-occurrence-mode]").forEach(button=>{const active=button.dataset.occurrenceMode===next;button.classList.toggle("active",active);button.setAttribute("aria-pressed",String(active))})
}
function installOccurrenceControl(input,{existing=null}={}){
  if(!input)return;
  const host=occurrenceHost(input);if(!host)return;
  let controls=host.querySelector(".occurrence-mode");
  if(!controls){
    controls=document.createElement("span");controls.className="segmented-control occurrence-mode";controls.setAttribute("role","group");controls.setAttribute("aria-label","发生时间方式");controls.innerHTML='<button type="button" data-occurrence-mode="now">现在</button><button type="button" data-occurrence-mode="manual">手动指定</button>';host.insertBefore(controls,input);
    controls.addEventListener("click",event=>{const button=event.target.closest("[data-occurrence-mode]");if(!button)return;event.preventDefault();setOccurrenceMode(input,button.dataset.occurrenceMode,{refreshValue:button.dataset.occurrenceMode==="manual"&&input.dataset.occurrenceMode!=="manual"});if(button.dataset.occurrenceMode==="manual")input.focus()})
  }
  const draft=createOccurrenceDraft({selectedDate:activeDate,existing,now:new Date()});input.value=draft.manualValue;setOccurrenceMode(input,draft.mode)
}
function installOccurrenceControls(root=document){root.querySelectorAll(occurrenceSelector).forEach(input=>{if(!input.dataset.occurrenceMode)installOccurrenceControl(input)})}
function occurrenceFields(input){return occurrenceSubmission({mode:input?.dataset.occurrenceMode||"manual",manualValue:input?.value||""},{now:new Date()})}
function resetOccurrenceInput(input,existing=null){installOccurrenceControl(input,{existing})}
function occurrenceKeyboardSubmit(event,form,inputKind="multiline"){const intent=entryKeyIntent(event,{inputKind});if(intent!=="submit")return false;event.preventDefault();form.requestSubmit();return true}
const dailyTypeMeta={sleep:{label:"睡眠",save:"保存睡眠"},heartRate:{label:"心率",save:"保存心率"},weight:{label:"体重",save:"保存体重"},exercise:{label:"运动",save:"保存运动"}};

function setAnswerStatus(id,message,kind="working"){document.querySelectorAll(`[data-answer-chain="${CSS.escape(id)}"]`).forEach(button=>{let status=button.closest(".chain-expanded")?.querySelector(".card-action-status");if(!status){status=document.createElement("p");status.className="card-action-status";status.setAttribute("role","status");status.setAttribute("aria-live","polite");button.closest(".chain-expanded")?.append(status)}status.className=`card-action-status ${kind}`;status.textContent=message})}
async function request(url,options={}){const answerId=url.match(/^\/api\/thoughts\/([^/]+)\/answer$/)?.[1];try{const result=await apiClient.request(url,options);if(answerId)setAnswerStatus(answerId,"回答已生成并保存。","success");return result}catch(error){if(answerId&&error.name!=="AbortError")setAnswerStatus(answerId,`未能生成：${error.message}，可重试。`,"error");throw error}}
function syncDomainsFor(url){
  const path=new URL(url,"https://local.invalid").pathname,routes=[
    [/\/captures(?:\/|$)/,["captures"]],[/\/journals?(?:\/|$)/,["journals"]],[/\/checkins(?:\/|$)/,["checkins"]],
    [/\/daily-records(?:\/|$)/,["dailyRecords"]],[/\/thought-chains(?:\/|$)/,["thoughts"]],[/\/books(?:\/|$)/,["books"]],
    [/\/quotes(?:\/|$)/,["quotes"]],[/\/chats(?:\/|$)/,["chats"]],[/\/analyses(?:\/|$)/,["analyses"]],
    [/\/experiments(?:\/|$)/,["experiments"]],[/\/custom-metrics(?:\/|$)/,["customMetrics"]],
    [/\/(?:actions|habits|habit-checkins)(?:\/|$)/,["actions","habits","habitCheckins"]],
    [/\/feedback(?:\/|$)/,["feedback"]],[/\/validation-ledger(?:\/|$)/,["validationLedger"]],
    [/\/content-attachments(?:\/|$)/,["captures","journals","thoughts","books","quotes"]],
    [/\/onboarding-v2(?:\/|$)/,["onboardingV2"]]
  ];
  return routes.find(([pattern])=>pattern.test(path))?.[1]||[]
}
function pendingProjectionSnapshot(projection){
  if(!projection)return null;
  if(["capture.create","record.create"].includes(projection.kind))return{kind:projection.kind,domain:projection.domain||"captures",temporaryId:projection.temporaryId};
  if(projection.kind==="thought.chain.create")return{kind:projection.kind,domain:"thoughts",temporaryId:projection.temporaryId};
  if(["record.update","record.delete"].includes(projection.kind)&&Array.isArray(state[projection.domain])){
    const index=state[projection.domain].findIndex(item=>item.id===projection.id);
    return index<0?null:{kind:projection.kind,domain:projection.domain,index,value:structuredClone(state[projection.domain][index])}
  }
  if(["book.note.update","book.note.delete"].includes(projection.kind)){
    const book=(state.books||[]).find(item=>item.id===projection.bookId),index=book?.notes?.findIndex(item=>item.id===projection.id)??-1;
    return index<0?null:{kind:projection.kind,domain:"books",bookId:projection.bookId,index,value:structuredClone(book.notes[index])}
  }
  if(["thought.chain.update","thought.chain.delete"].includes(projection.kind)){
    const items=(state.thoughts||[]).map((value,index)=>({value,index})).filter(entry=>entry.value.id===projection.id||entry.value.relatedTo===projection.id);
    return items.length?{kind:projection.kind,domain:"thoughts",id:projection.id,items:structuredClone(items)}:null
  }
  return null
}
function restorePendingProjection(snapshot,operationId){
  if(!snapshot)return false;
  if(["capture.create","record.create"].includes(snapshot.kind)){
    const collection=state[snapshot.domain];if(!Array.isArray(collection))return false;
    const previousLength=collection.length;
    state[snapshot.domain]=collection.filter(item=>item.id!==snapshot.temporaryId||item._sync?.operationId!==operationId);
    if(state[snapshot.domain].length===previousLength)return false;
    publishDomains(new Set([snapshot.domain]));return true
  }
  if(snapshot.kind==="thought.chain.create"){
    const prefix=`${snapshot.temporaryId}:`,previousLength=(state.thoughts||[]).length;
    state.thoughts=(state.thoughts||[]).filter(item=>!String(item.id).startsWith(prefix)||item._sync?.operationId!==operationId);
    if(state.thoughts.length===previousLength)return false;
    publishDomains(new Set(["thoughts"]));return true
  }
  if(snapshot.kind==="record.update"){
    const collection=state[snapshot.domain],index=collection?.findIndex(item=>item.id===snapshot.value.id)??-1;
    if(index<0||collection[index]._sync?.operationId!==operationId)return false;
    collection[index]=snapshot.value;publishDomains(new Set([snapshot.domain]));return true
  }
  if(snapshot.kind==="record.delete"){
    const collection=state[snapshot.domain];if(!Array.isArray(collection)||collection.some(item=>item.id===snapshot.value.id))return false;
    collection.splice(Math.min(snapshot.index,collection.length),0,snapshot.value);publishDomains(new Set([snapshot.domain]));return true
  }
  if(snapshot.kind==="book.note.update"){
    const book=(state.books||[]).find(item=>item.id===snapshot.bookId),index=book?.notes?.findIndex(item=>item.id===snapshot.value.id)??-1;
    if(index<0||book.notes[index]._sync?.operationId!==operationId)return false;
    book.notes[index]=snapshot.value;publishDomains(new Set(["books"]));return true
  }
  if(snapshot.kind==="book.note.delete"){
    const book=(state.books||[]).find(item=>item.id===snapshot.bookId);if(!book||book.notes?.some(item=>item.id===snapshot.value.id))return false;
    book.notes||=[];book.notes.splice(Math.min(snapshot.index,book.notes.length),0,snapshot.value);publishDomains(new Set(["books"]));return true
  }
  if(snapshot.kind==="thought.chain.update"){
    const root=snapshot.items.find(entry=>entry.value.id===snapshot.id),index=(state.thoughts||[]).findIndex(item=>item.id===snapshot.id);
    if(!root||index<0||state.thoughts[index]._sync?.operationId!==operationId)return false;
    state.thoughts[index]=root.value;publishDomains(new Set(["thoughts"]));return true
  }
  if(snapshot.kind==="thought.chain.delete"){
    if((state.thoughts||[]).some(item=>item.id===snapshot.id))return false;
    for(const entry of [...snapshot.items].sort((left,right)=>left.index-right.index)){
      if(!state.thoughts.some(item=>item.id===entry.value.id))state.thoughts.splice(Math.min(entry.index,state.thoughts.length),0,entry.value)
    }
    publishDomains(new Set(["thoughts"]));return true
  }
  return false
}
function settlePendingProjection(projection,operationId,data){
  if(!projection||!operationId)return false;
  if(projection.kind==="record.update"){
    const item=state[projection.domain]?.find(value=>value.id===projection.id);
    if(!item||item._sync?.operationId!==operationId)return false;
    if(data&&typeof data==="object")Object.assign(item,data);
    delete item._sync;publishDomains(new Set([projection.domain]));return true
  }
  if(projection.kind==="book.note.update"){
    const note=(state.books||[]).find(item=>item.id===projection.bookId)?.notes?.find(item=>item.id===projection.id);
    if(!note||note._sync?.operationId!==operationId)return false;
    if(data&&typeof data==="object")Object.assign(note,data);
    delete note._sync;publishDomains(new Set(["books"]));return true
  }
  if(projection.kind==="thought.chain.update"){
    const root=(state.thoughts||[]).find(item=>item.id===projection.id&&item.type==="question");
    if(!root||root._sync?.operationId!==operationId)return false;
    if(data&&typeof data==="object")Object.assign(root,data);
    delete root._sync;publishDomains(new Set(["thoughts"]));return true
  }
  return false
}
async function requestV1(url,options={},coordination={}){
  const method=String(options.method||"GET").toUpperCase();
  let result,operationId="";
  if(["GET","HEAD"].includes(method))result=await request(url,options);
  else{
    const snapshot=typeof coordination.captureProjection==="function"
      ?coordination.captureProjection()
      :pendingProjectionSnapshot(coordination.projection),onQueued=coordination.onQueued;
    try{
      result=await requestCoordinator.request({
        owner:currentUser?.id,url,options,domains:syncDomainsFor(url),...coordination,
        onQueued:record=>{operationId=record.operationId;return onQueued?.(record)}
      });
      settlePendingProjection(coordination.projection,operationId,result?.data);
      if(coordination.projection?.kind==="thought.chain.delete"){
        const id=coordination.projection.id,previousLength=(state.thoughts||[]).length;
        state.thoughts=(state.thoughts||[]).filter(item=>item.id!==id&&item.relatedTo!==id);
        if(state.thoughts.length!==previousLength)publishDomains(new Set(["thoughts"]));
        reconcileActiveThoughtRoute()
      }
    }catch(error){
      if(["failed","conflict"].includes(error?.syncStatus)){
        if(typeof coordination.restoreProjection==="function")await coordination.restoreProjection(snapshot,operationId,error);
        else restorePendingProjection(snapshot,operationId)
      }
      throw error
    }
  }
  if(!result||result.error)throw new Error(result?.error?.message||"接口返回异常");
  return{data:result.data,meta:result.meta||{}}
}
function routeDataKey(route={}){
  const query=new URLSearchParams(Object.entries(route.query||{}).sort(([left],[right])=>left.localeCompare(right)));
  return`${route.view||"today"}|${route.resourceId||""}|${query}`
}
function routeStateUrl(route={}){
  const query=new URLSearchParams({view:route.view||"today"});
  if(route.resourceId)query.set("resourceId",route.resourceId);
  for(const[key,value]of Object.entries(route.query||{}))query.set(key,String(value));
  return`/api/v1/route-state?${query}`
}
async function requestRouteState(route={}){
  return(await requestV1(routeStateUrl(route))).data
}
async function loadRouteState(route,requestSerial=++routeDataRequestSerial){
  const key=routeDataKey(route),owner=currentUser?.id,session=sessionSerial,panel=$(`#view-${route.view||"today"}`);
  panel?.setAttribute("aria-busy","true");
  try{
    const snapshot=await requestRouteState(route);
    if(requestSerial!==routeDataRequestSerial||owner!==currentUser?.id||session!==sessionSerial)return false;
    clearRouteLoadFailure(route);mergeStateSnapshot(snapshot);loadedRouteKey=key;fullRouteStateLoaded=Boolean(snapshot?._routeProjection?.complete);routeDataReady=true;renderVisibleRoute();runtimeFeatureRegistry?.notifyState(state,new Set(Object.keys(snapshot||{})));reconcileActiveThoughtRoute();return true
  }catch(error){
    if(requestSerial===routeDataRequestSerial&&owner===currentUser?.id&&session===sessionSerial){routeLoadFailureKey=key;renderRouteLoadFailure(route);showToast("当前页面读取失败，已有记录没有变化。","error")}
    return false
  }finally{
    if(requestSerial===routeDataRequestSerial)panel?.removeAttribute("aria-busy")
  }
}
async function listAllV1(url,options={}){
  const items=[],seen=new Set();let cursor="";
  do{
    const separator=url.includes("?")?"&":"?",result=await requestV1(`${url}${separator}limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`,options);
    items.push(...(Array.isArray(result.data)?result.data:[]));cursor=result.meta.nextCursor||"";
    if(cursor&&seen.has(cursor))throw new Error("列表游标没有前进");if(cursor)seen.add(cursor)
  }while(cursor);
  return items
}
const optionalRequest=url=>apiClient.request(url,{headers:{accept:"application/json"}},{optional:true,authGate:false});
const optionalPublicRequest=async url=>{
  const result=await apiClient.request(url,{headers:{accept:"application/json"}},{optional:true,authGate:false,allowUnauthorized:true});
  return["AUTH_REQUIRED","AUTH_REAUTH_REQUIRED"].includes(result?.code)?null:result
};
async function requestStream(url,options={},onEvent=()=>{}){
  const answerId=url.match(/^\/api\/thoughts\/([^/]+)\/answer$/)?.[1];
  try{const result=await apiClient.requestStream(url,options,onEvent);if(answerId)setAnswerStatus(answerId,"回答已生成并保存。","success");return result}
  catch(error){if(answerId&&error.name!=="AbortError")setAnswerStatus(answerId,`未能生成：${error.message}，可重试。`,"error");throw error}
}
function showToast(message,kind="success"){const t=$("#toast");t.textContent=message;t.className=`toast ${kind}`;t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.hidden=true,3200)}
function applyPendingProjection(record){
  const projection=record?.projection;
  if(!projection)return false;
  const sync={status:record.status==="sending"?"sending":"pending",operationId:record.operationId};
  if(projection.kind==="capture.create"){
    if((state.captures||[]).some(item=>item.clientRequestId===record.operationId||item.id===projection.temporaryId))return false;
    state.captures=[{id:projection.temporaryId,...projection.payload,createdAt:record.createdAt,_sync:sync},...(state.captures||[])];
    publishDomains(new Set(["captures"]));return true
  }
  if(projection.kind==="checkin.create"){
    if((state.checkins||[]).some(item=>item.clientRequestId===record.operationId||item.id===projection.temporaryId))return false;
    const occurredAt=projection.payload.occurredAt||record.createdAt,occurredOn=projection.payload.occurredOn||localDateKey(occurredAt);
    state.checkins=[{id:projection.temporaryId,...projection.payload,occurredAt,occurredOn,createdAt:record.createdAt,_sync:sync},...(state.checkins||[])];
    renderStateChart();renderHomeMood();return true
  }
  if(projection.kind==="record.create"&&Array.isArray(state[projection.domain])){
    if(state[projection.domain].some(item=>item.clientRequestId===record.operationId||item.id===projection.temporaryId))return false;
    state[projection.domain]=[{id:projection.temporaryId,...projection.payload,createdAt:record.createdAt,_sync:sync},...state[projection.domain]];
    publishDomains(new Set([projection.domain]));
    return true
  }
  if(projection.kind==="record.delete"&&Array.isArray(state[projection.domain])){
    const previousLength=state[projection.domain].length;
    state[projection.domain]=state[projection.domain].filter(item=>item.id!==projection.id);
    if(state[projection.domain].length===previousLength)return false;
    publishDomains(new Set([projection.domain]));
    return true
  }
  if(projection.kind==="record.update"&&Array.isArray(state[projection.domain])){
    const item=state[projection.domain].find(value=>value.id===projection.id);
    if(!item)return false;
    Object.assign(item,projection.payload,{_sync:sync});
    publishDomains(new Set([projection.domain]));
    return true
  }
  if(projection.kind==="book.note.create"){
    const book=(state.books||[]).find(item=>item.id===projection.bookId);
    if(!book)return false;
    book.notes||=[];
    if(book.notes.some(item=>item.clientRequestId===record.operationId||item.id===projection.temporaryId))return false;
    book.notes.unshift({id:projection.temporaryId,...projection.payload,createdAt:record.createdAt,version:1,_sync:sync});
    publishDomains(new Set(["books"]));return true
  }
  if(projection.kind==="book.note.delete"){
    const book=(state.books||[]).find(item=>item.id===projection.bookId);
    if(!book)return false;
    const previousLength=(book.notes||[]).length;
    book.notes=(book.notes||[]).filter(item=>item.id!==projection.id);
    if(book.notes.length===previousLength)return false;
    publishDomains(new Set(["books"]));return true
  }
  if(projection.kind==="book.note.update"){
    const book=(state.books||[]).find(item=>item.id===projection.bookId),note=book?.notes?.find(item=>item.id===projection.id);
    if(!note)return false;
    Object.assign(note,projection.payload,{_sync:sync});
    publishDomains(new Set(["books"]));return true
  }
  if(projection.kind==="thought.chain.create"){
    if((state.thoughts||[]).some(item=>item.clientRequestId===record.operationId||String(item.id).startsWith(`${projection.temporaryId}:`)))return false;
    const occurredAt=projection.payload.occurredAt||record.createdAt,rootId=`${projection.temporaryId}:root`,items=[{
      id:rootId,type:"question",content:projection.payload.question||"",attachmentPaths:projection.payload.attachmentPaths||[],
      tags:projection.payload.tags||[],authorType:"user",occurredAt,createdAt:record.createdAt,version:1,_sync:sync,
      ...(projection.payload.sourceRef?{sourceRef:projection.payload.sourceRef}:{})
    }];
    if(projection.payload.idea)items.push({id:`${projection.temporaryId}:idea`,type:"idea",relatedTo:rootId,content:projection.payload.idea,authorType:"user",occurredAt,createdAt:record.createdAt,version:1,_sync:sync});
    if(projection.payload.answer)items.push({id:`${projection.temporaryId}:answer`,type:"answer",relatedTo:rootId,content:projection.payload.answer,authorType:"user",occurredAt,createdAt:record.createdAt,version:1,_sync:sync});
    state.thoughts=[...items,...state.thoughts];publishDomains(new Set(["thoughts"]));return true
  }
  if(projection.kind==="thought.chain.delete"){
    const previousLength=(state.thoughts||[]).length;
    state.thoughts=(state.thoughts||[]).filter(item=>item.id!==projection.id&&item.relatedTo!==projection.id);
    if(state.thoughts.length===previousLength)return false;
    publishDomains(new Set(["thoughts"]));return true
  }
  if(projection.kind==="thought.chain.update"){
    const root=(state.thoughts||[]).find(item=>item.id===projection.id&&item.type==="question");
    if(!root)return false;
    Object.assign(root,{content:projection.payload.question,tags:projection.payload.tags,occurredAt:projection.payload.occurredAt,_sync:sync});
    publishDomains(new Set(["thoughts"]));return true
  }
  if(projection.kind==="action.command")return actionsCoordinator.applyPendingRecord(record);
  return false
}
async function restorePendingProjections(){
  const owner=currentUser?.id,session=sessionSerial;if(!owner)return 0;
  const records=await requestCoordinator.list(owner,["pending","sending"]);
  if(owner!==currentUser?.id||session!==sessionSerial)return 0;
  let restored=0;
  for(const record of records){
    if(owner!==currentUser?.id||session!==sessionSerial)return restored;
    if(applyPendingProjection(record))restored+=1
  }
  const route=pageRouter?.currentRoute();
  if(routeLoadFailureKey&&routeDataKey(route)===routeLoadFailureKey)renderRouteLoadFailure(route);
  return restored
}
async function applyIncrementalSnapshot(snapshot,changes){
  const domains=mergeStateSnapshot(snapshot);
  actionsCoordinator.applyIncrementalSnapshot(snapshot,{sessionTicket:sessionScope.capture()});
  const rendered=new Set([...domains].filter(domain=>!["actions","habits","habitCheckins"].includes(domain)));
  if(domains.has("clusters")||domains.has("insights"))rendered.add("review");
  if(rendered.size)publishDomains(rendered);
  await restorePendingProjections();
  return changes.length
}
async function updateSyncHealth(event){
  if(!currentUser?.id)return;
  if(event.type==="operation")actionsCoordinator.applyOperationStatus(event);
  const metrics=await requestCoordinator.metrics(currentUser.id);
  const oldest=metrics.oldestPendingAt?Math.max(0,Date.now()-new Date(metrics.oldestPendingAt).getTime()):0;
  syncHealth={
    status:event.type==="disabled"?"disabled":metrics.conflicts?"conflict":event.type==="error"||metrics.failed?"error":metrics.pending?"pending":metrics.durable?"synced":"degraded",
    pending:metrics.pending,
    conflicts:metrics.conflicts,
    failed:metrics.failed,
    oldestAgeMs:oldest,
    enqueueToAckP95Ms:metrics.enqueueToAckP95Ms,
    lastPullMs:event.type==="pull"?event.durationMs:syncHealth.lastPullMs,
    lastError:event.type==="error"?(event.code||"SYNC_FAILED"):""
  };
  runtimeFeatureRegistry?.notifyState(state,new Set(["syncHealth"]))
}
syncController=createIncrementalSync({
  coordinator:requestCoordinator,
  request:url=>requestV1(url),
  applySnapshot:applyIncrementalSnapshot,
  resnapshot:async()=>{
    await refreshState(["checkins","dailyRecords","captures","journals","thoughts","chat","review","books","keepsakes","quotes","notifications","onboardingV2","feedback"]);
    await actionsCoordinator.load()
  },
  onStatus:event=>void updateSyncHealth(event)
});
function notificationUnread(snapshot=state){
  const items=snapshot.notifications||[];
  return Number(snapshot.notificationUnread??notificationUnreadCount)||items.filter(item=>!item.readAt&&["succeeded","failed","stale","cancelled"].includes(item.status)).length
}
function renderNotificationSummary(){
  const unread=notificationUnread();
  $("#notification-dot").hidden=!unread;
}
function publishNotificationState(){
  renderNotificationSummary();
  runtimeFeatureRegistry?.notifyState(state,new Set(["notifications","aiTasks","notificationUnread"]))
}
function scheduleNotificationPoll(){
  clearTimeout(notificationTimer);
  const active=(state.aiTasks||[]).some(task=>["queued","running","cancelling"].includes(task.status)),retrying=backgroundResultsRetryAttempts>0&&backgroundResultsRetryAttempts<BACKGROUND_RESULTS_RETRY_LIMIT;
  if(!active&&!retrying)return;
  notificationTimer=setTimeout(async()=>{try{await loadNotifications()}finally{scheduleNotificationPoll()}},1800);
}
async function loadNotifications(){const owner=currentUser?.id,session=sessionSerial;notificationsLoadState="loading";publishNotificationState();try{const [notifications,tasks]=await Promise.all([request("/api/notifications"),request("/api/ai-tasks")]);if(owner!==currentUser?.id||session!==sessionSerial)return false;state.notifications=notifications.items||[];state.aiTasks=tasks.items||[];notificationUnreadCount=Number(notifications.unread)||0;state.notificationUnread=notificationUnreadCount;notificationsLoadState="ready";publishNotificationState();await syncBackgroundTaskResults(state.aiTasks,owner,session);return true}catch(error){if(owner===currentUser?.id&&session===sessionSerial){notificationsLoadState="failure";publishNotificationState()}return false}}
async function openAiTaskTarget(task,notification){
  const owner=currentUser?.id,session=sessionSerial;
  try{
    const controller=await ensureBackgroundResultsController();if(owner!==currentUser?.id||session!==sessionSerial)return false;
    backgroundResultsLoadErrorReported=false;backgroundResultsRetryAttempts=0;return await controller.openTarget(task,notification)
  }catch(error){
    if(owner===currentUser?.id&&session===sessionSerial)showToast(`无法定位后台结果：${error.message}`,"error");
    return false
  }
}
function commitDraftTags(){const input=$("#chain-tags"),values=splitTags(input.value);for(const value of values)if(!draftTags.includes(value))draftTags.push(value);input.value="";renderTagComposer()}
function renderTagComposer(){const list=$("#chain-tag-list");if(!list)return;list.innerHTML=draftTags.map(tag=>`<span class="tag-chip">#${escapeHtml(tag)}<button type="button" data-remove-draft-tag="${escapeHtml(tag)}" aria-label="移除标签 ${escapeHtml(tag)}">×</button></span>`).join("");const known=[...new Set(state.thoughts.flatMap(item=>item.tags||[]))].filter(tag=>!draftTags.includes(tag));$("#tag-suggestions").innerHTML=known.map(tag=>`<option value="${escapeHtml(tag)}"></option>`).join("")}
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
function metricConfig(){return createCheckinMetricConfig(state.customMetrics)}
const metricValue=checkinMetricValue;
function metricReference(key,custom){const eligible=state.checkins.filter(x=>x.occurredOn<=activeDate).sort((a,b)=>b.occurredOn.localeCompare(a.occurredOn)||eventTimestamp(b).localeCompare(eventTimestamp(a)));const previous=eligible.map(x=>metricValue(x,key,custom)).find(x=>Number.isFinite(Number(x)));const history=eligible.slice(0,30).map(x=>Number(metricValue(x,key,custom))).filter(Number.isFinite);return{previous:previous==null?null:Number(previous),average:avg(history)}}
function metricMarker(kind,value,label){if(!Number.isFinite(value))return"";const position=Math.max(0,Math.min(100,(value-1)*25)),thumbOffset=11-position*.22,left=`calc(${position}% + ${thumbOffset.toFixed(3)}px)`;return `<span class="metric-history-marker ${kind}" style="left:${left}" data-position="${position}" role="img" aria-label="${label} ${value.toFixed(2)}" title="${label} ${value.toFixed(2)}"></span>`}
function sliderTemplate(key,cfg){const ref=metricReference(key,cfg.custom),value=ref.previous??(ref.average==null?3:Math.round(ref.average));return `<div class="metric unconfirmed"><div class="metric-top"><span class="metric-label">${escapeHtml(cfg.label)}</span><span class="anchor" id="${key}-anchor">待确认 · ${escapeHtml(cfg.anchors[value-1])}</span><button class="note-toggle" type="button" data-note="${key}" aria-expanded="false">＋备注</button></div><div class="metric-scale">${metricMarker("previous",ref.previous,"上一次")}${metricMarker("average",ref.average,"近30次平均")}<input type="range" id="metric-${key}" data-metric="${key}" data-custom="${cfg.custom?"1":"0"}" data-confirmed="false" min="1" max="5" value="${value}" step="1" aria-label="${escapeHtml(cfg.label)} 1到5，必须确认"></div><div class="range-labels"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div><input class="note-field" id="${key}-note" placeholder="可选：补充一句话" maxlength="800"></div>`}
function renderSliders(){const cfg=metricConfig();$("#sliders").innerHTML=`<div class="metric-history-legend" aria-label="历史参照图例"><span><i class="previous"></i>上一次</span><span><i class="average"></i>近30次平均</span></div>${Object.entries(cfg).map(([k,v])=>sliderTemplate(k,v)).join("")}`;$$('[data-metric]').forEach(input=>{const update=(confirmed=false)=>{if(confirmed){input.dataset.confirmed="true";input.closest(".metric").classList.remove("unconfirmed")}const prefix=input.dataset.confirmed==="true"?"":"待确认 · ";$(`#${CSS.escape(input.dataset.metric)}-anchor`).textContent=`${prefix}${cfg[input.dataset.metric].anchors[Number(input.value)-1]}`};input.addEventListener("input",()=>update(true));input.addEventListener("change",()=>navigator.vibrate?.(8));input.addEventListener("pointerdown",()=>update(true));update()});$$(".note-toggle").forEach(b=>b.addEventListener("click",()=>{const f=$(`#${CSS.escape(b.dataset.note)}-note`);f.classList.toggle("visible");b.setAttribute("aria-expanded",String(f.classList.contains("visible")));if(f.classList.contains("visible"))f.focus()}))}

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
function applyApplicationRoute(route){
  const requestSerial=++routeDataRequestSerial;
  if(routeLoadFailureKey&&routeLoadFailureKey!==routeDataKey(route))routeLoadFailureKey="";
  $$(".view[aria-busy='true']").forEach(view=>view.removeAttribute("aria-busy"));
  stopPageAudio();
  renderVisibleRoute();
  if(applicationLifecycleReady&&!fullRouteStateLoaded&&(!routeDataReady||loadedRouteKey!==routeDataKey(route))&&currentUser)return loadRouteState(route,requestSerial);
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
function renderChat(){const chats=state.chats.filter(x=>eventDate(x)===activeDate);$("#chat-history").innerHTML=chats.length?[...chats].reverse().map(x=>`<div class="chat-message user" data-chat-id="${x.id}" data-chat-part="message"><div class="markdown-content">${renderMarkdown(x.message)}</div></div><div class="chat-message agent" data-chat-id="${x.id}" data-chat-part="answer">${contextReceiptMarkup(x.contextReceipt)}<div class="markdown-content">${renderMarkdown(x.answer)}</div><button class="subtle-action danger chat-delete" type="button" data-chat-delete="${x.id}">删除对话</button></div>`).join(""):contentState({title:"这一天还没有对话",body:"发送问题后，共参会结合你已保存的记录回答。",action:{focus:"chat-input",label:"开始提问"}});chats.forEach(item=>{const rootKey=commentRootKey("chat",item.id);markCommentTarget($(`[data-chat-id="${CSS.escape(item.id)}"][data-chat-part="message"]>.markdown-content`),rootKey,"message");markCommentTarget($(`[data-chat-id="${CSS.escape(item.id)}"][data-chat-part="answer"]>.markdown-content`),rootKey,"answer")});renderLatex($("#chat-history"));applyCommentAnchors($("#chat-history"))}
const dataUrlFromBlob=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("图片读取失败"));reader.readAsDataURL(blob)});
const loadImageSource=source=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error("图片无法打开，请换一张重试"));image.src=source});
function blankCanvas(width,height){const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;return canvas}
function homeKeepsakeImageMarkup(item){
  let imagePath="";
  try{({imagePath}=keepsakeMediaSources(item,"home"))}
  catch{
    const status=item.media?.status||item.derivativeState,label=status==="pending"?"正在生成":status==="failed"?"生成失败":"暂无图片";
    return `<span class="keepsake-image-stack home-v02-keepsake-stack is-unavailable" data-keepsake-media="${escapeHtml(item.id||"")}"><span class="keepsake-media-placeholder">${label}</span></span>`
  }
  const opacity=Math.max(0,Math.min(30,Number(item.backgroundOpacityPct??15)))/100;
  return `<span class="keepsake-image-stack home-v02-keepsake-stack" data-keepsake-media="${escapeHtml(item.id||imagePath)}" style="--keepsake-background-opacity:${opacity}"><img class="keepsake-image-cutout" src="${escapeHtml(appUrl(imagePath))}" alt="${escapeHtml(item.title)}" loading="eager"></span>`;
}
function placeHomeKeepsakeImage(stack){
  if(!stack||stack.dataset.placementState==="ready"||stack.dataset.placementState==="loading")return;
  const image=stack.querySelector(".keepsake-image-cutout");if(!image?.src)return;
  const apply=()=>{
    if(!image.naturalWidth||!image.naturalHeight)return;
    stack.dataset.placementState="loading";
    try{
      const scale=Math.min(1,480/Math.max(image.naturalWidth,image.naturalHeight)),width=Math.max(1,Math.round(image.naturalWidth*scale)),height=Math.max(1,Math.round(image.naturalHeight*scale)),canvas=blankCanvas(width,height),context=canvas.getContext("2d",{willReadFrequently:true});
      context.drawImage(image,0,0,width,height);
      const placement=keepsakePlacementCss(scanKeepsakeAlpha(context.getImageData(0,0,width,height)));
      if(!placement){stack.dataset.placementState="fallback";return}
      stack.style.setProperty("--keepsake-frame-ratio",placement.aspectRatio);
      stack.style.setProperty("--keepsake-image-width",`${placement.widthPct}%`);
      stack.style.setProperty("--keepsake-image-height",`${placement.heightPct}%`);
      stack.style.setProperty("--keepsake-image-left",`${placement.leftPct}%`);
      stack.style.setProperty("--keepsake-image-top",`${placement.topPct}%`);
      stack.dataset.placementState="ready"
    }catch{stack.dataset.placementState="fallback"}
  };
  if(image.complete)apply();else image.addEventListener("load",apply,{once:true})
}
function setupHomeKeepsakePlacement(root=document){
  root.querySelectorAll(".home-v02-keepsake-stack").forEach(placeHomeKeepsakeImage)
}
function quoteTagCandidates(){
  return[...(state.quoteTags||[]),...(state.quotes||[]).flatMap(item=>item.tags||[])]
}
function quoteTagPickerElements(key){
  const config=quoteTagPickerConfig[key];
  return config?{
    root:document.querySelector(`[data-tag-multiselect="${key}"]`),
    input:$(config.input),
    selected:$(config.selected),
    options:$(config.options),
    toggle:$(config.toggle),
    status:$(config.status)
  }:null
}
function renderQuoteTagPicker(key){
  const elements=quoteTagPickerElements(key),model=quoteTagStates[key];
  if(!elements?.root||!model)return;
  const open=elements.root.dataset.open==="true"&&!model.atLimit&&model.options.length>0;
  elements.input.value=model.input;
  elements.input.setAttribute("aria-expanded",String(open));
  elements.input.setAttribute("aria-activedescendant",open&&model.activeIndex>=0?`${key}-tag-option-${model.activeIndex}`:"");
  elements.toggle.setAttribute("aria-expanded",String(open));
  elements.selected.innerHTML=model.selected.map(tag=>`<span>#${escapeHtml(tag)}<button type="button" data-quote-tag-remove="${escapeHtml(tag)}" data-quote-tag-picker="${key}" aria-label="移除标签 ${escapeHtml(tag)}">×</button></span>`).join("");
  elements.options.innerHTML=model.options.map((option,index)=>`<button id="${key}-tag-option-${index}" type="button" role="option" aria-selected="${index===model.activeIndex}" data-quote-tag-option="${escapeHtml(option.value)}" data-quote-tag-picker="${key}">${option.type==="create"?`创建 “${escapeHtml(option.value)}”`:escapeHtml(option.value)}</button>`).join("");
  elements.options.hidden=!open;
  elements.status.textContent=model.overflow.length?`已有 ${model.selected.length} 个标签，请先移除一个再添加。`:model.atLimit?"已达到 8 个标签上限。":""
}
function updateQuoteTagPicker(key,action,{open}={}){
  quoteTagStates[key]=reduceTagMultiSelectState(quoteTagStates[key],action);
  const root=quoteTagPickerElements(key)?.root;
  if(root&&open!==undefined)root.dataset.open=String(open);
  renderQuoteTagPicker(key);
  return quoteTagStates[key]
}
function setQuoteTagPicker(key,selected=[]){
  quoteTagStates[key]=createTagMultiSelectState({candidates:quoteTagCandidates(),selected});
  const root=quoteTagPickerElements(key)?.root;if(root)root.dataset.open="false";
  renderQuoteTagPicker(key)
}
function quoteTagsForSubmission(key){
  const input=quoteTagPickerElements(key)?.input;
  let state=reduceTagMultiSelectState(quoteTagStates[key],{type:"input",value:input?.value||""});
  if(state.query)state=reduceTagMultiSelectState(state,{type:"commit"});
  quoteTagStates[key]=state;
  renderQuoteTagPicker(key);
  return[...(quoteTagStates[key]?.selected||[])]
}
function selectionQuoteSource(rootKey){const root=commentRoot(rootKey),label=commentRootLabel(rootKey),{type}=parseCommentRootKey(rootKey);const title=type==="book"?root?.title:type==="journal"?root?.title||root?.content:type==="quote"?root?.source:type==="chat"?root?.message:root?.content;return `${label}${title?` · ${plainPreview(title).slice(0,60)}`:""}`}
function closeSelectionQuoteModal(){const modal=$("#selection-quote-modal");modal.hidden=true;$("#selection-quote-form").reset();setQuoteTagPicker("selectionQuote");$("#selection-quote-status").textContent=""}
function openSelectionQuoteModal(selection){const label=annotationsController.rootLabel(selection.rootKey);$("#selection-quote-content").value=selection.quote;$("#selection-quote-source").value=selectionQuoteSource(selection.rootKey);setQuoteTagPicker("selectionQuote",[label]);resetOccurrenceInput($("#selection-quote-datetime"));$("#selection-quote-status").textContent="";$("#selection-quote-modal").hidden=false;$("#selection-quote-content").focus()}
function llmProfile(scene="thoughtAnswer"){const tier=llmSettings.scenarios?.[scene]||"high",profile=llmSettings.profiles?.[tier]||defaultLlmProfiles[tier]||defaultLlmProfiles.high;return{tier,...profile,effort:llmSettings.sceneEfforts?.[scene]||profile.effort}}
const shiftLocalDateKey=(dateKey,days)=>{const [year,month,day]=String(dateKey).split("-").map(Number),date=new Date(Date.UTC(year,month-1,day+days));return date.toISOString().slice(0,10)};
const compactNumber=value=>new Intl.NumberFormat("zh-CN",{notation:"compact",maximumFractionDigits:1}).format(Number(value)||0);
const formatCny=value=>{const number=Number(value)||0,absolute=Math.abs(number),digits=absolute===0?2:absolute>=100?0:absolute>=10?1:absolute>=1?2:absolute>=.1?3:absolute>=.01?4:6;return `${number<0?"-":""}¥${absolute.toFixed(digits)}`};
const formatDuration=value=>{const milliseconds=Number(value)||0;return milliseconds>=60000?`${(milliseconds/60000).toFixed(1)} 分钟`:milliseconds>=1000?`${(milliseconds/1000).toFixed(1)} 秒`:`${Math.round(milliseconds)} ms`};
function openCommercialSource(view,id,date){
  if(view==="together"&&date){activeDate=eventDate({occurredAt:date});renderDate();renderChat()}
  if(view==="thoughts")openThoughtDetail(id);else switchView(view);
  requestAnimationFrame(()=>{
    const selectors={thoughts:`[data-chain-id="${CSS.escape(id)}"]`,captures:`[data-capture-id="${CSS.escape(id)}"]`,journals:`[data-journal-id="${CSS.escape(id)}"]`,books:`[data-book-id="${CSS.escape(id)}"]`,together:`[data-chat-id="${CSS.escape(id)}"]`},target=document.querySelector(selectors[view]||"");
    if(target instanceof HTMLDetailsElement)target.open=true;
    target?.scrollIntoView({behavior:"smooth",block:"center"});
  });
}
function collectOnboardingAnswers(){for(const input of $$('#onboarding-questions input[type="radio"]:checked'))onboardingDraftAnswers[input.name.replace(/^onboarding-/,"")]=input.value;return onboardingDraftAnswers}
function renderOnboardingQuestions(){const list=$("#onboarding-questions");if(!list||!onboardingSchema)return;const questions=onboardingSchema.questions.filter(question=>question.tier==="quick"||onboardingMode==="detailed");list.className="onboarding-question-list";list.innerHTML=questions.map((question,index)=>`<section class="onboarding-question"><header><span>${escapeHtml(question.dimension)} · ${String(index+1).padStart(2,"0")}</span><h3>${escapeHtml(question.prompt)}</h3></header><div class="onboarding-options">${question.options.map(option=>`<label><input type="radio" name="onboarding-${escapeHtml(question.id)}" value="${escapeHtml(option.value)}" ${onboardingDraftAnswers[question.id]===option.value?"checked":""} required><span>${escapeHtml(option.label)}</span></label>`).join("")}</div></section>`).join("");$$("[data-onboarding-mode]").forEach(button=>{const active=button.dataset.onboardingMode===onboardingMode;button.classList.toggle("active",active);button.setAttribute("aria-pressed",String(active))})}
function onboardingPayload(){collectOnboardingAnswers();return{status:"completed",questionnaireMode:onboardingMode,answers:onboardingDraftAnswers,profile:{gender:$("#onboarding-gender").value,region:$("#onboarding-region").value,occupation:$("#onboarding-occupation").value,major:$("#onboarding-major").value,school:$("#onboarding-school").value,introduction:$("#onboarding-introduction").value,works:$("#onboarding-works").value},interests:$$('#onboarding-interests input[type="checkbox"]:checked').map(input=>input.value),material:$("#onboarding-material").value,understanding:$("#onboarding-understanding").value}}
function renderLegacyOnboarding(){
  if(!onboardingSchema)return;
  if(!onboardingHydrated){
    const saved=state.onboarding||{};onboardingMode=saved.questionnaireMode==="detailed"?"detailed":"quick";onboardingDraftAnswers={...(saved.answers||{})};
    const profile=saved.profile||{};for(const key of["gender","region","occupation","major","school","introduction","works"]){const field=$(`#onboarding-${key}`);if(field)field.value=profile[key]||""}
    $("#onboarding-interests").innerHTML=(onboardingSchema.interests||[]).map(value=>`<label><input type="checkbox" value="${escapeHtml(value)}" ${(saved.interests||[]).includes(value)?"checked":""}><span>${escapeHtml(value)}</span></label>`).join("");
    $("#onboarding-material").value=saved.material||"";$("#onboarding-understanding").value=saved.understanding||"";$("#onboarding-understanding").closest("label").hidden=!saved.understanding;onboardingHydrated=true
  }
  renderOnboardingQuestions()
}
const onboardingV2Controller=createOnboardingV2Controller({
  requestV1:(...args)=>requestV1(...args),
  draftStore:onboardingDraftStore,
  owner:()=>currentUser?.id||"",
  updateState:value=>{state.onboardingV2=value},
  onLegacy:renderLegacyOnboarding,
  onFirstAction:action=>{
    if(action==="question"){
      switchView("today");
      $("#home-open-thought").click()
    }else{
      void openCaptureFeature("openComposer")
    }
  },
  toast:showToast
});
function renderOnboarding(){onboardingV2Controller.render()}
function renderDate(){$$("[data-active-date]").forEach(input=>input.value=activeDate);installOccurrenceControls();if(!$("#quote-id")?.value)resetOccurrenceInput($("#quote-datetime"));for(const input of[$("#chain-datetime"),$("#checkin-datetime"),$("#chat-datetime")])resetOccurrenceInput(input);$$("[data-daily-form]").forEach(form=>{if(!form.elements.recordId.value)resetOccurrenceInput(form.elements.occurredAt)});const d=new Date(`${activeDate}T12:00:00`),today=activeDate===localDateKey(),label=new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"long",day:"numeric",weekday:"long"}).format(d);$$("[data-active-date-label]").forEach(element=>element.textContent=element.id==="today-date-label"?activeDate.replaceAll("-","/"):label);$$("[data-active-date-heading]").forEach(element=>{const view=element.closest(".view")?.id;element.textContent=!today?"回到这一天":view==="view-daily"?"今天，留下了什么？":view==="view-together"?"今天，一起看看":"今天，你感觉怎么样？"})}
function homeMemorySource(item){
  const date=item.occurredAt?formatDate(item.occurredAt):formatDateKey(item.occurredOn);
  if(item.type==="book")return `书间 · 《${item.sourceTitle||"未命名书目"}》 · ${date}`;
  if(item.type==="quote")return `拾句 · ${item.sourceTitle||"来源未记"} · ${date}`;
  return `思绪 · ${date}`
}
function renderHomeMemories({advance=false}={}){
  const container=$("#home-memory-grid"),status=$("#home-memory-status"),shuffle=$("#home-shuffle");
  if(!container)return;
  const pool=Array.isArray(state.homeMemories)?state.homeMemories:createHomeMemoryPool(state),poolByKey=new Map(pool.map(item=>[item.key,item])),limit=Math.min(3,pool.length);
  homeMemoryByKey=poolByKey;
  let selected=advance?[]:homeMemoryKeys.map(key=>poolByKey.get(key)).filter(Boolean).slice(0,limit);
  if(selected.length<limit){
    const selectedKeys=new Set(selected.map(item=>item.key));
    selected.push(...selectHomeMemories(pool.filter(item=>!selectedKeys.has(item.key)),{
      previousKeys:advance?homeMemoryKeys:[],
      limit:limit-selected.length
    }))
  }
  if(advance&&limit)selected=selectHomeMemories(pool,{previousKeys:homeMemoryKeys,limit});
  homeMemoryKeys=selected.map(item=>item.key);
  container.replaceChildren();
  if(!selected.length){
    const emptyState=document.createElement("p");
    emptyState.className="home-v02-empty";
    emptyState.textContent="留下第一条思考，往后在这里重逢。";
    container.append(emptyState);
    shuffle.hidden=true;
    if(advance)status.textContent="当前还没有可回看的用户内容。";
    return
  }
  for(const item of selected){
    const article=document.createElement("article");
    article.className=`home-v02-memory ${item.type==="quote"?"quote":""}`;
    article.dataset.homeMemoryKey=item.key;
    article.dataset.homeMemoryType=item.type;
    article.dataset.homeMemoryId=item.id;
    const source=document.createElement("p");
    source.className="home-v02-provenance";
    source.textContent=homeMemorySource(item);
    article.append(source);
    if(item.title){
      const title=document.createElement("h2");
      title.textContent=plainPreview(item.title);
      article.append(title)
    }
    const excerpt=document.createElement("p");
    excerpt.className="home-v02-excerpt";
    excerpt.textContent=plainPreview(item.text);
    article.append(excerpt);
    const open=document.createElement("button");
    open.className="home-v02-text-action";
    open.type="button";
    open.dataset.homeMemoryOpen=item.key;
    open.textContent="查看原文 →";
    open.setAttribute("aria-label",`查看原文：${plainPreview(item.title||item.text).slice(0,80)}`);
    article.append(open);
    container.append(article)
  }
  shuffle.hidden=pool.length<=selected.length;
  if(advance)status.textContent=`已更换 ${selected.length} 条内容。`
}
function renderHomeKeepsake(){
  const container=$("#home-keepsake");
  if(!container)return;
  const items=state.keepsakes||[];
  let item=items.find(value=>value.id===homeKeepsakeId);
  if(!item&&items.length){item=items[Math.floor(Math.random()*items.length)];homeKeepsakeId=item.id}
  const button=document.createElement("button");
  button.className="home-v02-keepsake-entry";
  button.type="button";
  button.dataset.homeKeepsake=item?.id||"";
  const preview=document.createElement("span");
  preview.className=`home-v02-keepsake-preview${item?"":" empty"}`;
  if(item){
    const template=document.createElement("template");template.innerHTML=homeKeepsakeImageMarkup(item);preview.append(template.content)
  }else{
    preview.textContent="物";
    preview.setAttribute("aria-hidden","true")
  }
  const copy=document.createElement("span");
  copy.className="home-v02-keepsake-copy";
  const label=document.createElement("small");
  label.textContent=item?`小物 · ${formatDate(eventTimestamp(item))}`:"留存一件小物";
  const title=document.createElement("strong");
  title.textContent=item?.title||"小物";
  const note=document.createElement("span");
  note.className="home-v02-keepsake-note";
  note.textContent=item?.note||item?.description||"";
  const arrow=document.createElement("span");
  arrow.className="home-v02-keepsake-arrow";
  arrow.textContent="→";
  arrow.setAttribute("aria-hidden","true");
  copy.append(label,title);
  if(note.textContent)copy.append(note);
  button.append(preview,copy,arrow);
  button.setAttribute("aria-label",item?`打开小物：${item.title}`:"打开小物");
  container.replaceChildren(button);
  if(item)requestAnimationFrame(()=>setupHomeKeepsakePlacement(container))
}
function renderHomeMood(){renderCheckinSurfaces(["checkins"])}
function renderHome(){
  renderHomeMemories();
  renderHomeKeepsake();
  renderHomeMood()
}
function closeHomeEditors({restoreFocus=true}={}){
  const opened=$$(".home-v02-editor-backdrop").filter(editor=>!editor.hidden),trigger=homeEditorTrigger;
  opened.forEach(editor=>editor.hidden=true);
  document.body.classList.remove("home-v02-editor-open");
  if(opened.length)homeEditorTrigger=null;
  if(restoreFocus&&opened.length&&trigger?.isConnected)trigger.focus({preventScroll:true})
}
function openHomeEditor(kind,trigger=null){
  const editor=$(`#home-${kind}-editor`);
  if(!editor)return;
  closeHomeEditors({restoreFocus:false});
  const fallback=kind==="thought"?$("#home-open-thought"):$("#home-record-state");
  homeEditorTrigger=trigger instanceof HTMLElement
    ?trigger
    :document.activeElement instanceof HTMLElement&&document.activeElement!==document.body
      ?document.activeElement
      :fallback;
  editor.hidden=false;
  document.body.classList.add("home-v02-editor-open");
  requestAnimationFrame(()=>{
    const focusTarget=kind==="thought"?$("#chain-question"):editor.querySelector("[data-metric]");
    focusTarget?.focus()
  })
}
function trapHomeEditorFocus(event,editor){
  const focusable=[...editor.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')]
    .filter(element=>!element.hidden&&getComputedStyle(element).display!=="none"&&getComputedStyle(element).visibility!=="hidden");
  if(!focusable.length)return;
  const first=focusable[0],last=focusable.at(-1);
  if(event.shiftKey&&(document.activeElement===first||!editor.contains(document.activeElement))){event.preventDefault();last.focus()}
  else if(!event.shiftKey&&(document.activeElement===last||!editor.contains(document.activeElement))){event.preventDefault();first.focus()}
}
function openHomeMemory(item){
  if(!item)return;
  if(item.type==="thought"){
    openThoughtDetail(item.id);
    return
  }
  if(item.type==="book"){
    void openLibraryFeature(item.bookId,{noteId:item.noteId});return
  }
  void openQuoteFeature(item.id)
}
function onboardingBlocksPrivateShell(snapshot){
  return!["completed","skipped"].includes(snapshot?.session?.status)
}
function completeOnboardingSnapshot(snapshot){
  return Number(snapshot?.schemaVersion)===2
    &&snapshot?.session
    &&Object.hasOwn(snapshot.session,"answers")
    &&Object.hasOwn(snapshot.session,"collaboration")
}
function renderVisibleRoute(){
  const view=pageRouter?.currentRoute()?.view||"today";
  if(renderedRouteView&&renderedRouteView!==view)unmountRouteContent(renderedRouteView);
  renderedRouteView=view;
  renderDate();
  $("#notification-dot").hidden=!Number(state.notificationUnread??notificationUnreadCount);
  if(view==="today"){renderSliders();renderHome()}
  else if(view==="daily")void healthFeatureController?.render().catch(error=>showToast(`日录显示失败：${error.message}`,"error"));
  activateContentImageDraftsForCurrentRoute()
}
function afterVisibleShellPaint(){
  if(document.visibilityState==="hidden")return new Promise(resolve=>setTimeout(resolve,0));
  return new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)))
}
function releaseSeries(value){const match=/^v?(\d+)\.(\d+)/.exec(String(value||""));return match?Number(match[1])*1000+Number(match[2]):null}
function assertNativeServerCompatibility(meta){
  if(!document.documentElement.dataset.apiOrigin)return;
  const client=releaseSeries(releaseVersion),server=releaseSeries(meta?.releaseVersion);
  if(server!=null&&client!=null&&server>=client)return;
  const serverLabel=meta?.releaseVersion||"旧版本";
  throw Object.assign(new Error(`当前 App ${releaseVersion} 与服务端 ${serverLabel} 不兼容，请使用匹配版本或等待服务端升级。`),{code:"CLIENT_SERVER_VERSION_MISMATCH"})
}
async function load({visibleShell=false,initialSnapshot=null,opening=null}={}){
  if(!Number.isFinite(startupMarks.loadStart))markStartup("loadStart");
  const owner=currentUser?.id,session=sessionSerial,route=initialSnapshot?.route||pageRouter?.currentRoute()||{view:"today",query:{}};
  const [nextState,meta]=initialSnapshot
    ?[initialSnapshot.state,initialSnapshot.meta]
    :await Promise.all([
      requestRouteState(route),
      requestV1("/api/v1/startup").then(result=>result.data)
    ]);
  if(owner!==currentUser?.id||session!==sessionSerial)return false;
  if(!Number.isFinite(startupMarks.coreSnapshotReady))markStartup("coreSnapshotReady");assertNativeServerCompatibility(meta);
  currentUser={...currentUser,...(meta.user||{})};applyCapabilitySurface(meta.capabilities||[]);
  Object.keys(routeContentSelectors).forEach(unmountRouteContent);
  replaceState({...structuredClone(emptyClientState),...nextState,onboardingV2:meta.onboardingV2,notificationUnread:meta.notificationUnread,quoteTags:meta.quoteTags||[]});
  loadedRouteKey=routeDataKey(route);fullRouteStateLoaded=Boolean(nextState?._routeProjection?.complete);appVersion=meta.version||"development";releaseVersion=meta.releaseVersion||releaseVersion;featureFlags={...featureFlags,...meta.features};governanceUrl=typeof meta.governanceUrl==="string"?meta.governanceUrl:"";notificationUnreadCount=Number(state.notificationUnread)||0;routeDataReady=true;
  if(["thoughts","together"].includes(route.view))runtimeFeatureRegistry?.notifyState(state,new Set(Object.keys(nextState||{})));
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
    if(owner!==currentUser?.id||session!==sessionSerial)return false;
    secondaryRequest=requestSecondary();
  }
  secondaryRequest||=requestSecondary();
  const secondaryResult=await secondaryRequest;
  if(secondaryResult.error)throw secondaryResult.error;
  if(opening&&!onboardingPending){openingCompletion=opening.ready();if(openingCompletion)await openingCompletion}
  const [nextSettings,nextOnboardingSchema,nextOnboardingV2Schema,nextOnboardingV2State,nextLocalTestConfig]=secondaryResult.value;
  if(owner!==currentUser?.id||session!==sessionSerial)return false;
  markStartup("secondaryReady");
  state.onboardingV2=nextOnboardingV2State.data;llmSettings=nextSettings;onboardingSchema=nextOnboardingSchema;localTestConfig=nextLocalTestConfig;onboardingHydrated=false;
  await onboardingV2Controller.hydrate({schema:nextOnboardingV2Schema.data,state:nextOnboardingV2State.data});
  if(owner!==currentUser?.id||session!==sessionSerial)return false;
  for(;;){
    const activeRoute=pageRouter?.currentRoute()||route,activeKey=routeDataKey(activeRoute);
    if(activeKey!==loadedRouteKey)await loadRouteState(activeRoute);
    if(owner!==currentUser?.id||session!==sessionSerial)return false;
    if(activeKey!==routeDataKey(pageRouter?.currentRoute()))continue;
    if(activeKey!==loadedRouteKey&&routeLoadFailureKey!==activeKey)continue;
    await runtimeFeatureRegistry?.enter(activeRoute.view,activeRoute);
    if(activeKey===routeDataKey(pageRouter?.currentRoute()))break
  }
  renderOnboarding();renderVisibleRoute();if(!reconcileActiveThoughtRoute())pageRouter?.activate();restoreDurableDrafts();syncChainRecordKind();scheduleNotificationPoll();
  if(visibleShell&&onboardingPending){revealUserSession();if(!Number.isFinite(startupMarks.visibleShell))markStartup("visibleShell")}
  if(opening&&onboardingPending){await afterVisibleShellPaint();if(owner!==currentUser?.id||session!==sessionSerial)return false;await opening.ready()}
  markStartup("stableHome");publishStartupTiming();return true
}
function setAuthTab(tab){
  if(authBusy)return;
  $$("[data-auth-tab]").forEach(button=>{const active=button.dataset.authTab===tab;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1});
  $("#login-form").hidden=tab!=="login";$("#register-form").hidden=tab!=="register";$("#auth-status").textContent="";
  if(matchMedia?.("(pointer:fine)").matches)(tab==="login"?$("#login-form"):$("#register-form")).elements.username.focus();
}
function setAuthBusy(value){authBusy=value;$$(".auth-form input,.auth-form button,[data-auth-tab]").forEach(control=>control.disabled=value)}
function invalidatePageLoads(){
  activeAnswerTaskId=++answerTaskSerial;healthFeatureController?.invalidateSession();clearTimeout(notificationTimer);
  backgroundResultsController?.resetSession();backgroundResultsLoadErrorReported=false;backgroundResultsRetryAttempts=0;refreshCoordinator.reset();
}
function clearPrivateSessionState(){
  closeImageViewer({restoreFocus:false});
  onboardingV2Controller.reset();
  resetState();routeDataReady=false;routeDataRequestSerial+=1;routeLoadFailureKey="";loadedRouteKey="";fullRouteStateLoaded=false;quoteTagStates={selectionQuote:createTagMultiSelectState()};llmSettings={provider:"deepseek",profiles:structuredClone(defaultLlmProfiles),scenarios:{...defaultLlmScenarios},sceneEfforts:{...defaultSceneEfforts},automaticAnswers:{thoughtAnswer:false},speech:{defaultVoice:"",generationRate:-10},hasApiKey:false,keyHint:""};
  activeAnswerTaskId=++answerTaskSerial;clearTimeout(notificationTimer);answerDraft="";answerReasoningDraft="";localTestConfig=null;localTestScopeLoads.clear();onboardingSchema=null;onboardingMode="quick";onboardingDraftAnswers={};onboardingHydrated=false;notificationUnreadCount=0;notificationsLoadState="idle";actionsCoordinator.resetSession();annotationsController?.resetSession();governanceUrl="";appVersion="0.5.7";homeMemoryKeys=[];homeMemoryByKey=new Map();homeKeepsakeId="";closeHomeEditors({restoreFocus:false});$("#capture-editor").hidden=true;document.body.classList.remove("capture-editor-open");invalidatePageLoads();draftTags=[];capturesFeatureController=null;quotesFeatureController=null;libraryFeatureController=null;keepsakesFeatureController=null;
  contentImageDraftManager?.resetSession();for(const key of persistentContentImageKeys)renderContentImageEditor(key);
  pageAudioCoordinator.resetSession();stopPageAudio();
  $$("main form").forEach(form=>{form.reset();delete form.dataset.requestId});$$(".modal-backdrop").forEach(modal=>modal.hidden=true);$("#comment-panel").hidden=true;$("#comment-panel-reopen").hidden=true;$("#selection-tools").hidden=true;$("#annotation-line-counts").hidden=true;document.body.classList.remove("comment-panel-open");
}
function showAuthGate(message=""){
  const localTestEnabled=Boolean(localTestConfig?.enabled),resetApplication=applicationLifecycleReady;applicationLifecycleReady=false;resetRouteAfterAuthentication||=Boolean(currentUser);syncController?.stop();syncHealth={status:"idle",pending:0,conflicts:0,failed:0,oldestAgeMs:0,enqueueToAckP95Ms:0,lastPullMs:0,lastError:""};rotateSession();clearPrivateSessionState();if(resetApplication){void runtimeFeatureRegistry?.resetSession().catch(()=>{});runtimeStatePort?.resetSession()}currentUser=null;applyCapabilitySurface([]);try{sessionStorage.removeItem("cike:authenticated-shell")}catch{}delete document.documentElement.dataset.bootstrapVisible;document.body.classList.add("auth-locked");$("#auth-gate").hidden=false;$("#account-control").hidden=true;$("#account-authenticated").hidden=true;const registerTab=$('[data-auth-tab="register"]');if(registerTab)registerTab.hidden=localTestEnabled;if(message)$("#auth-status").textContent=message;
}
function renderAccountIdentity(){
  const username=currentUser?.username||"";
  $("#account-name").textContent=username;
  runtimeFeatureRegistry?.notifyState(state,new Set(["account"]))
}
function prepareUserSession(user,authRequired,{keepVisible=false}={}){
  applyCapabilitySurface(user?.role==="owner"?ownerCapabilities:[]);if(!keepVisible)document.body.classList.add("auth-locked");restoreView?.(resetRouteAfterAuthentication?"today":requestedAuthenticatedView||undefined);currentUser=user;resetRouteAfterAuthentication=false;requestedAuthenticatedView="";$("#account-control").hidden=!authRequired;$("#account-authenticated").hidden=!authRequired;$("#account-local-mode").hidden=authRequired;renderAccountIdentity();
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
  catch(error){if(currentUser?.id===user?.id)showAuthGate();throw error}
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
  if(!session.authenticated){showAuthGate(session.code==="AUTH_REAUTH_REQUIRED"?"账户权限已变更，请重新登录。":"");localTestConfig=testConfig;const registerTab=$('[data-auth-tab="register"]');if(registerTab)registerTab.hidden=Boolean(testConfig?.enabled);setAuthTab(testConfig?.enabled||session.userCount?"login":"register");if(session.code==="AUTH_REAUTH_REQUIRED")$("#auth-status").textContent="账户权限已变更，请重新登录。";await afterVisibleShellPaint();await opening?.ready();return}
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
      start:owner=>owner?syncController.start(owner,{incremental:featureFlags.incrementalSync}):false,
      stop:()=>syncController.stop()
    },
    onError:error=>showToast(`同步恢复失败：${error.message}`,"error")
  });
  const shellPort=createShellPort({
    mount:(_,context)=>{
      let active=true,disposeAnnotations=()=>false;const owner=currentUser?.id||"",session=sessionSerial,current=()=>active&&!context.signal.aborted&&owner===(currentUser?.id||"")&&session===sessionSerial;
      const attach=controller=>{
        if(!current())return;
        disposeAnnotations=controller.mount({root:document,signal:context.signal});
        if(currentUser?.id){restoreAnnotationUiDrafts();renderVisibleRoute();runtimeFeatureRegistry?.notifyState(state);activateContentImageDraftsForCurrentRoute()}
      };
      if(annotationsController)attach(annotationsController);
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
  const testConfig=localTestConfig;
  applicationLifecycleReady=false;
  await runtimeApplication.resetSession();
  currentUser=user;
  applyCapabilitySurface(user?.role==="owner"?ownerCapabilities:[]);
  await runtimeApplication.start(applicationStartInput({
    session:{authenticated:true,authRequired:true,user,userCount:1},
    testConfig
  }));
  applicationLifecycleReady=true
}
const refreshState=(domains,options={})=>refreshCoordinator.refresh(domains,{...options,patchOnly:options.patchOnly===true});
subscribeState((next,wanted)=>{notificationUnreadCount=Number(next.notificationUnread)||notificationUnreadCount;if(wanted.has("onboardingV2"))onboardingV2Controller.reconcile(next.onboardingV2);if(wanted.has("dailyRecords"))void healthFeatureController?.render({snapshot:next,changedDomains:wanted}).catch(()=>{});if(wanted.has("thoughts")){renderTagComposer();renderHomeMemories()}if(wanted.has("checkins")){renderStateChart();renderSliders();renderHomeMood()}if(wanted.has("chat")||wanted.has("chats"))renderChat();if(wanted.has("books")){renderHomeMemories();if(annotationsController?.activeRootKey().startsWith("book:"))renderCommentPanel()}if(wanted.has("keepsakes"))renderHomeKeepsake();if(wanted.has("quotes"))renderHomeMemories();if(wanted.has("comments"))renderCommentPanel();renderNotificationSummary()});
function setAnswerModalStep(step){const order=["context","thinking","answer","done"],current=order.indexOf(step);$$("#ai-answer-progress li").forEach((item,index)=>{item.classList.toggle("active",index===current);item.classList.toggle("done",index<current||(step==="done"&&index===current))})}
function closeAnswerModal(){const modal=$("#ai-answer-modal"),busy=modal.dataset.busy==="true";modal.hidden=true;if(busy)showToast("回答继续在后台生成，完成后会提醒。")}
async function runAnswerInModal({title,scene="thoughtAnswer",requestCall,onDone,isCurrent=()=>true}){
  const taskId=++answerTaskSerial,modal=$("#ai-answer-modal"),result=$("#ai-answer-result"),output=$("#ai-answer-output"),status=$("#ai-answer-status");
  activeAnswerTaskId=taskId;modal.hidden=false;modal.dataset.busy="true";$("#ai-answer-title").textContent=title;output.hidden=true;result.innerHTML="";status.className="status answer-modal-status";status.textContent="正在整理个人语境与完整问答链…";setAnswerModalStep("context");
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(activeAnswerTaskId===taskId){setAnswerModalStep("thinking");status.textContent="正在整理回答…"}
  let answer="",renderFrame=0,answerStarted=false;
  const renderAnswer=()=>{renderFrame=0;if(activeAnswerTaskId!==taskId)return;result.innerHTML=renderMarkdown(answer);renderLatex(result);result.scrollIntoView({block:"nearest"})};
  const scheduleAnswerRender=()=>{if(!renderFrame)renderFrame=requestAnimationFrame(renderAnswer)};
  const onEvent=event=>{
    if(activeAnswerTaskId!==taskId)return;
    if(event.type==="reasoning"){setAnswerModalStep("thinking");status.textContent="正在整理回答…";return}
    if(event.type==="content"){answer+=event.delta||"";if(!answerStarted){answerStarted=true;output.hidden=false;setAnswerModalStep("answer");status.textContent="正在生成回答…"}scheduleAnswerRender()}
  };
  try{
    const response=await requestCall(onEvent),finalAnswer=response.draft||response.content||response.answer||answer;
    answer=finalAnswer;if(renderFrame)cancelAnimationFrame(renderFrame);
    if(activeAnswerTaskId===taskId){renderAnswer();output.hidden=!answer;if(isCurrent()&&onDone)await onDone(response);setAnswerModalStep("done");status.textContent=isCurrent()?"回答已生成并保存。":"回答已生成，但目标输入已经变化，未自动写入。";modal.dataset.busy="false"}
    return response;
  }catch(error){
    if(activeAnswerTaskId===taskId){status.className="status answer-modal-status error";status.textContent=`未能生成：${error.message}`;modal.dataset.busy="false"}
    throw error;
  }
}
async function startBackgroundChainAnswer(question,existingTask=null){
  try{
    const task=existingTask||await request("/api/ai-tasks",{method:"POST",body:JSON.stringify({kind:"thoughtAnswer",targetId:question.id,inputVersion:question.version||1,clientRequestId:crypto.randomUUID()})});
    if(!state.aiTasks.some(item=>item.id===task.id))state.aiTasks.unshift(task);
    setAnswerStatus(question.id,"回答已进入后台队列。","working");showToast("回答已在后台排队");await refreshState("notifications");scheduleNotificationPoll();return task
  }catch(error){setAnswerStatus(question.id,`回答未能排队：${error.message}`,"error");showToast("回答未能进入后台队列","error");throw error}
}
async function ensureLocalTestViewScope(view){
  const scope=LOCAL_TEST_VIEW_SCOPES[view];
  if(!scope||localTestConfig?.mode!=="simulation"||localTestConfig.loadedScopes?.includes(scope))return true;
  if(localTestScopeLoads.has(scope))return localTestScopeLoads.get(scope);
  const owner=currentUser?.id,session=sessionSerial,panel=$(`#view-${view}`);
  panel?.setAttribute("aria-busy","true");
  const pending=(async()=>{
    try{
      const result=await request("/api/local-test-mode/hydrate",{method:"POST",body:JSON.stringify({scope})});
      if(owner!==currentUser?.id||session!==sessionSerial||localTestConfig?.mode!=="simulation")return false;
      localTestConfig=result.control;replaceState(result.state);runtimeStatePort?.replace(state,Object.keys(result.state||{}),{source:"local-test-hydrate"});notificationUnreadCount=Number(state.notificationUnread)||0;loadedRouteKey=routeDataKey(pageRouter?.currentRoute());renderOnboarding();renderVisibleRoute();return true
    }catch(error){
      if(owner===currentUser?.id&&session===sessionSerial)showToast(`当前页面记录读取失败：${error.message}`,"error");
      return false
    }finally{
      panel?.removeAttribute("aria-busy");localTestScopeLoads.delete(scope)
    }
  })();
  localTestScopeLoads.set(scope,pending);
  return pending
}
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
function createPageFeatureDescriptors(){
  const descriptors=Object.fromEntries(Object.keys(viewSections).map(view=>[view,{
    root:()=>$(`#view-${view}`),
    load:()=>loadLegacyFeatureModule().then(module=>module.createLegacyPageController({view}))
  }]));
  const withCheckins=delegate=>{
    const controller=createCheckinsFeatureController({delegate,getSnapshot:()=>state,getActiveDate:()=>activeDate,document,emptyStateMarkup:contentState});
    checkinsFeatureControllers.add(controller);return controller
  };
  descriptors.today={
    root:()=>$("#view-today"),
    load:()=>loadLegacyFeatureModule().then(module=>{
      let workspaceController,workspaceModuleRequest,bridge;
      const renderSummary=(root,snapshot)=>{const summary=root.querySelector("#actions-summary"),view=actionsCoordinator.viewModel(snapshot);if(summary)summary.textContent=`${view.summary.openActions} 项待推进 · ${view.summary.checkedToday}/${view.summary.activeHabits} 个习惯已打卡`};
      const loadWorkspace=async()=>{
        const current=bridge;
        if(!current?.details?.open||current.signal?.aborted||current.mounted||current.loading)return false;
        current.loading=true;
        try{
          const feature=await(workspaceModuleRequest||=loadActionsFeatureModule());
          if(bridge!==current||current.signal?.aborted)return false;
          workspaceController||=feature.createActionsFeatureController({coordinator:actionsCoordinator,showToast,prompt:(...args)=>globalThis.prompt(...args),confirm:(...args)=>globalThis.confirm(...args)});
          workspaceController.mount(current.context);current.mounted=true;workspaceController.render({snapshot:state});return true
        }catch(error){workspaceModuleRequest=null;if(bridge===current&&!current.signal?.aborted)showToast(`行动与习惯加载失败：${error.message}`,"error");return false}
        finally{if(bridge===current)current.loading=false}
      };
      const delegate=module.createLegacyPageController({
        view:"today",
        onMount:context=>{
          const details=context.root.querySelector(".home-v02-secondary"),toggle=()=>void loadWorkspace();
          bridge={context,details,signal:context.signal,toggle,mounted:false,loading:false};
          details?.addEventListener("toggle",toggle);bridge.unsubscribe=actionsCoordinator.subscribe(snapshot=>renderSummary(context.root,snapshot));if(details?.open)toggle()
        },
        onRender:context=>{void actionsCoordinator.load({ensure:true});return bridge?.mounted?workspaceController?.render(context):false},
        onUnmount:()=>{
          const current=bridge;bridge=null;current?.details?.removeEventListener("toggle",current.toggle);current?.unsubscribe?.();if(current?.mounted)workspaceController?.unmount()
        },
        onResetSession:()=>{workspaceController?.resetSession();workspaceController=null;actionsCoordinator.resetSession()}
      });
      return withCheckins(delegate)
    })
  };
  descriptors.daily={
    root:()=>$("#view-daily"),
    load:()=>Promise.all([loadLegacyFeatureModule(),loadHealthFeatureModule()]).then(([legacy,health])=>{
      const controller=health.createHealthFeatureController({
        delegate:legacy.createLegacyPageController({view:"daily"}),
        request,
        requestV1:(url,options,coordination)=>featureRequestV1("daily",url,options,coordination),
        draftStore:mediaDraftStore,
        listOperations:owner=>requestCoordinator.list(owner),
        subscribeOperations:listener=>requestCoordinator.subscribe(listener),
        getAccountId:()=>currentUser?.id||"",
        getActiveDate:()=>activeDate,
        getActiveType:()=>activeDailyType,
        setActiveType:type=>{activeDailyType=type},
        getRecords:()=>state.dailyRecords||[],
        replaceRecord:(id,record)=>{
          state.dailyRecords=(state.dailyRecords||[]).map(item=>item.id===id?record:item)
        },
        applyPendingRecord:applyPendingProjection,
        refreshRecords:()=>refreshState("dailyRecords"),
        resetOccurrenceInput,
        occurrenceFields,
        imageDataUrls,
        escapeMarkup:escapeHtml,
        viewerAttachmentPath,
        localDateTimeForDate,
        toLocalDateTimeInput,
        showToast,
        confirmDelete:message=>confirm(message),
        typeMeta:dailyTypeMeta,
        createId:()=>crypto.randomUUID()
      });
      healthFeatureController=controller;
      return controller
    })
  };
  const loadCaptureJournalPage=viewName=>loadCaptureJournalFeatureModule().then(module=>{
    const controller=module.createCaptureJournalFeatureController({
      page:viewName,
      data:{
        getSnapshot:()=>state,
        getAccountId:()=>currentUser?.id||"",
        getSessionSerial:()=>sessionSerial,
        request,
        requestV1:(url,options,coordination)=>featureRequestV1(viewName,url,options,coordination),
        requestStream,
        requestBlob:(url,options,config)=>apiClient.requestBlob(url,options,config),
        refresh:(domains,options)=>refreshState(domains,options),
        applyPendingProjection,
        publish:domains=>publishDomains(new Set(domains))
      },
      navigation:{openThoughtDetail},
      media:{
        snapshot:contentImageDraft,
        activateDraft:key=>activateContentImageDraft(key,currentUser?.id),
        renderEditor:renderContentImageEditor,
        resetEditor:resetContentImageEditor,
        replaceTransient:(key,snapshot)=>contentImageDraftManager.replaceTransient(key,snapshot),
        persistDraft:persistContentImageDraft,
        submitDraft:contentImagePaths,
        completeDraft:clearSubmittedContentImageDraft,
        rollbackDraft:discardContentImageUploads,
        selectFiles:setContentImageFiles,
        removeItem:(key,index)=>contentImageDraftManager.remove(key,index),
        contentImagesMarkup
      },
      drafts:{storage:sessionStorage,getAccountId:()=>currentUser?.id||""},
      annotations:{
        markTarget:markCommentTarget,
        applyAnchors:applyCommentAnchors,
        scheduleLayout:scheduleAnnotationLineCounts,
        rootKey:commentRootKey
      },
      crossDomain:{promoteToThought:promoteCaptureToThought,scheduleNotificationPoll},
      assistant:{runAnswer:runAnswerInModal},
      view:{
        appUrl,
        contentState,
        contextReceiptMarkup,
        renderLatex,
        showToast,
        presentError,
        resetOccurrenceInput,
        occurrenceFields,
        trapFocus:trapHomeEditorFocus,
        escapeMarkup:escapeHtml,
        entryKeyIntent
      },
      platform:{
        document,
        window,
        audio:pageAudioCoordinator,
        draftStore:mediaDraftStore,
        createRequestId:()=>crypto.randomUUID(),
        requestFrame:callback=>requestAnimationFrame(callback),
        setTimer:(callback,delay)=>setTimeout(callback,delay),
        clearTimer:timer=>clearTimeout(timer),
        repeat:(callback,delay)=>globalThis.setInterval(callback,delay),
        cancelRepeat:timer=>clearInterval(timer),
        getComputedStyle:element=>getComputedStyle(element),
        confirm:(...args)=>globalThis.confirm(...args),
        encodeAudio:encodeAudioDraft,
        readAudioDuration:readAudioDraftDuration,
        mediaDevices:navigator.mediaDevices,
        MediaRecorder:globalThis.MediaRecorder,
        Blob:globalThis.Blob,
        objectUrls:URL,
        location,
        now:()=>Date.now(),
        performance,
        performanceEnabled:()=>document.documentElement.dataset.nativePerformance==="1"||startupPerformanceEnabled,
        escapeSelector:value=>CSS.escape(value)
      }
    });
    if(viewName==="captures")capturesFeatureController=controller;
    return controller
  });
  descriptors.captures={root:()=>$("#view-captures"),load:()=>loadCaptureJournalPage("captures")};
  descriptors.journals={root:()=>$("#view-journals"),load:()=>loadCaptureJournalPage("journals")};
  descriptors.books={
    root:()=>$("#view-books"),
    load:()=>loadLibraryFeatureModule().then(module=>{
      const controller=module.createLibraryFeatureController({
        data:{
          getSnapshot:()=>state,
          getAccountId:()=>currentUser?.id||"",
          getSessionSerial:()=>sessionSerial,
          request:(url,options)=>withFeatureScope("books",()=>request(url,options)),
          requestV1:(url,options,coordination)=>featureRequestV1("books",url,options,coordination),
          refresh:(domains,options)=>refreshState(domains,options),
          applyPendingProjection,
          publish:domains=>publishDomains(new Set(domains))
        },
        navigation:{scrollTo:options=>window.scrollTo(options)},
        media:{
          validateImages:(files,maxItems)=>runPublicValidation(()=>validatedImageFiles(files,maxItems)),
          imageDataUrls,
          uploadOriginalImages:(images,idempotencyKey)=>uploadOriginalImages({request,images,idempotencyKey}),
          discardUploadedImagePath,
          readBlob:path=>apiClient.readBlob(path)
        },
        annotations:{
          rootKey:commentRootKey,
          markTarget:markCommentTarget,
          applyAnchors:applyCommentAnchors
        },
        view:{
          appUrl,
          contentState,
          escapeMarkup:escapeHtml,
          plainPreview,
          renderMarkdown,
          renderLatex,
          eventDate,
          eventTimestamp,
          formatDate,
          formatDateKey,
          formatTime,
          localDateKey,
          resetOccurrenceInput,
          occurrenceFields,
          showToast,
          entryKeyIntent
        },
        platform:{
          document,
          window,
          objectUrls:URL,
          createFile:(blob,name,type)=>new File([blob],name,{type}),
          createRequestId:()=>crypto.randomUUID(),
          requestFrame:callback=>requestAnimationFrame(callback),
          cancelFrame:frame=>cancelAnimationFrame(frame),
          getComputedStyle:element=>getComputedStyle(element),
          createRange:()=>document.createRange(),
          random:()=>Math.random(),
          confirm:(...args)=>globalThis.confirm(...args),
          escapeSelector:value=>CSS.escape(value),
          now:()=>new Date().toISOString()
        }
      });
      libraryFeatureController=controller;
      return controller
    })
  };
  descriptors.keepsakes={
    root:()=>$("#view-keepsakes"),
    load:()=>loadKeepsakesFeatureModule().then(module=>{
      const controller=module.createKeepsakeFeatureController({
        data:{
          getSnapshot:()=>state,
          getAccountId:()=>currentUser?.id||"",
          getSessionSerial:()=>sessionSerial,
          getActiveDate:()=>activeDate,
          request:(url,options)=>withFeatureScope("keepsakes",()=>request(url,options)),
          refresh:(domains,options)=>refreshState(domains,options)
        },
        media:{
          validateImages:(files,maxItems)=>runPublicValidation(()=>validatedImageFiles(files,maxItems)),
          imageDataUrls,
          readBlob:path=>apiClient.readBlob(path),
          dataUrlFromBlob
        },
        drafts:mediaDraftStore,
        navigation:{scrollTo:options=>window.scrollTo(options)},
        view:{
          appUrl,
          contentState,
          escapeMarkup:escapeHtml,
          eventTimestamp,
          eventDate,
          formatDate,
          formatDateKey,
          formatTime,
          resetOccurrenceInput,
          occurrenceFields,
          splitTags,
          formatBytes,
          feedCountLabel:(_,visible,total,unit)=>normalizedFeedSearch($("#keepsake-search")?.value)?`${visible} / ${total} ${unit}`:`${total} ${unit}`,
          feedSearchEmpty,
          localDateTimeForDate,
          setOccurrenceMode,
          showToast,
          uncertainSubmission:uncertainMediaSubmission
        },
        platform:{
          document,
          window,
          objectUrls:URL,
          IntersectionObserver:globalThis.IntersectionObserver,
          createFile:(blob,name,options)=>new File([blob],name,options),
          createRequestId:()=>crypto.randomUUID(),
          createCanvas:(width,height)=>blankCanvas(width,height),
          createImageData:(width,height,data)=>data?new ImageData(data,width,height):new ImageData(width,height),
          loadImage:loadImageSource,
          requestFrame:callback=>requestAnimationFrame(callback),
          cancelFrame:frame=>cancelAnimationFrame(frame),
          setTimer:(callback,delay)=>setTimeout(callback,delay),
          clearTimer:timer=>clearTimeout(timer),
          now:()=>Date.now(),
          confirm:(...args)=>globalThis.confirm(...args)
        }
      });
      keepsakesFeatureController=controller;
      return controller
    })
  };
  descriptors.quotes={
    root:()=>$("#view-quotes"),
    load:()=>loadQuotesFeatureModule().then(module=>{
      const controller=module.createQuotesFeatureController({
        data:{
          getSnapshot:()=>state,
          getAccountId:()=>currentUser?.id||"",
          getSessionSerial:()=>sessionSerial,
          requestV1:(url,options,coordination)=>featureRequestV1("quotes",url,options,coordination),
          refresh:(domains,options)=>refreshState(domains,options),
          applyPendingProjection,
          publish:domains=>publishDomains(new Set(domains))
        },
        annotations:{
          markTarget:markCommentTarget,
          applyAnchors:applyCommentAnchors,
          scheduleLayout:scheduleAnnotationLineCounts,
          rootKey:commentRootKey
        },
        view:{
          contentState,
          resetOccurrenceInput,
          occurrenceFields,
          showToast,
          escapeMarkup:escapeHtml
        },
        platform:{
          document,
          window,
          createRequestId:()=>crypto.randomUUID(),
          requestFrame:callback=>requestAnimationFrame(callback),
          cancelFrame:frame=>cancelAnimationFrame(frame),
          repeat:(callback,delay)=>setInterval(callback,delay),
          cancelRepeat:timer=>clearInterval(timer),
          getComputedStyle:element=>getComputedStyle(element),
          matchesMedia:query=>matchMedia(query).matches,
          confirm:(...args)=>globalThis.confirm(...args),
          performanceNow:()=>performance.now(),
          random:()=>Math.random(),
          escapeSelector:value=>CSS.escape(value)
        }
      });
      quotesFeatureController=controller;
      return controller
    })
  };
  const loadThoughtsPage=view=>Promise.all([loadLegacyFeatureModule(),loadThoughtsFeatureModule()]).then(([legacy,thoughts])=>{
    const delegate=legacy.createLegacyPageController({
      view,
      onRender:()=>view==="together"?renderChat():renderTagComposer()
    });
    const controller=thoughts.createThoughtsFeatureController({
      delegate,
      data:{
        getSnapshot:()=>state,
        getAccountId:()=>currentUser?.id||"",
        getSessionSerial:()=>sessionSerial,
        isRouteDataReady:()=>routeDataReady,
        isFullRouteStateLoaded:()=>fullRouteStateLoaded,
        request,
        requestV1:(url,options,coordination)=>featureRequestV1(view,url,options,coordination),
        requestBlob:(url,options,config)=>apiClient.requestBlob(url,options,config),
        refresh:(domains,options)=>refreshState(domains,options),
        applyPendingProjection
      },
      navigation:{
        currentRoute:()=>pageRouter.currentRoute(),
        openDetail:id=>pageRouter.openDetail("thought-chain",id),
        backToList:(nextView,options)=>pageRouter.backToList(nextView,options),
        replaceQuery:(query,options)=>pageRouter.replaceQuery(query,options),
        showUnavailable:(target,options)=>pageRouter.showUnavailable(createUnavailableRouteResult(target),options),
        clearResult:()=>pageRouter.clearResult()
      },
      media:{
        resetEditor:resetContentImageEditor,
        persistDraft:persistContentImageDraft,
        submitDraft:contentImagePaths,
        completeDraft:clearSubmittedContentImageDraft,
        rollbackDraft:discardContentImageUploads,
        uncertainSubmission:uncertainMediaSubmission,
        contentImagesMarkup,
        hasDraftItems:key=>contentImageDraft(key).items.length>0
      },
      annotations:{
        tagTargets:tagCommentableTargets,
        applyAnchors:applyCommentAnchors,
        scheduleLayout:scheduleAnnotationLineCounts,
        openPanel:openCommentPanel,
        rootKey:commentRootKey
      },
      crossDomain:{
        getActiveDate:()=>activeDate,
        openComposer:button=>openHomeEditor("thought",button),
        scheduleNotificationPoll
      },
      view:{
        appUrl,
        contextReceiptMarkup,
        contentState,
        renderLatex,
        showToast,
        resetOccurrenceInput,
        occurrenceFields,
        presentError
      },
      platform:{
        document,
        window,
        audio:pageAudioCoordinator,
        createRequestId:()=>crypto.randomUUID(),
        confirm:(...args)=>globalThis.confirm(...args),
        prompt:(...args)=>globalThis.prompt(...args),
        requestFrame:callback=>requestAnimationFrame(callback),
        setTimer:(callback,delay)=>setTimeout(callback,delay),
        clearTimer:timer=>clearTimeout(timer),
        getComputedStyle:element=>getComputedStyle(element),
        matchesMedia:query=>matchMedia(query).matches,
        escapeSelector:value=>CSS.escape(value)
      }
    });
    thoughtsFeatureControllers.add(controller);
    return controller
  });
  descriptors.together={root:()=>$("#view-together"),load:()=>loadThoughtsPage("together")};
  descriptors.thoughts={root:()=>$("#view-thoughts"),load:()=>loadThoughtsPage("thoughts")};
  descriptors.review={
    root:()=>$("#view-review"),
    load:()=>loadReviewInsightsFeatureModule().then(async module=>{
      const review=await module.loadReviewFeatureController({
        data:{
          getSnapshot:()=>state,
          getAccountId:()=>currentUser?.id||"",
          getSessionSerial:()=>sessionSerial,
          requestV1:(url,options,coordination)=>featureRequestV1("review",url,options,coordination),
          refresh:(domains,options)=>refreshState(domains,options),
          applyPendingProjection
        },
        navigation:{
          currentRouteKey:()=>routeDataKey(pageRouter?.currentRoute()),
          isView:view=>pageRouter?.currentRoute()?.view===view
        },
        annotations:{
          rootKey:commentRootKey,
          markTarget:markCommentTarget,
          applyAnchors:applyCommentAnchors
        },
        view:{
          associationModal:()=>$("#association-flow-modal"),
          contentState,
          contextReceiptMarkup,
          escapeMarkup:escapeHtml,
          escapeSelector:value=>CSS.escape(value),
          plainPreview,
          renderMarkdown,
          renderLatex,
          formatDate,
          metricLabel:key=>baseMetrics[key]?.label||key,
          showToast
        },
        platform:{
          document,
          createRequestId:()=>crypto.randomUUID(),
          confirm:(...args)=>globalThis.confirm(...args),
          now:()=>Date.now()
        }
      });
      const delegate={
        async mount(context){const dispose=await review.mount(context);activateContentImageDraftsForCurrentRoute();return dispose},
        render(context){const rendered=review.render(context);if(rendered)activateContentImageDraftsForCurrentRoute();return rendered},
        unmount:()=>review.unmount(),
        resetSession:()=>review.resetSession()
      };
      return withCheckins(delegate)
    })
  };
  descriptors.statistics={
    root:()=>$("#view-statistics"),
    load:()=>loadReviewInsightsFeatureModule().then(module=>module.loadStatisticsFeatureController({
      data:{
        request:(url,options)=>withFeatureScope("statistics",()=>request(url,options)),
        getAccountId:()=>currentUser?.id||"",
        getSessionSerial:()=>sessionSerial,
        hasCapability
      },
      navigation:{
        currentRouteKey:()=>routeDataKey(pageRouter?.currentRoute()),
        isView:view=>pageRouter?.currentRoute()?.view===view
      },
      view:{
        escapeMarkup:escapeHtml,
        formatTrackingStart:value=>new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(value))
      },
      platform:{getCurrentDate:()=>currentLocalDate}
    }))
  };
  descriptors.export={
    root:()=>$("#view-export"),
    load:()=>(exportFeatureModuleRequest||import("../features/export/index.mjs")).then(module=>module.createExportFeatureController({
      requestV1:(url,options,coordination)=>featureRequestV1("export",url,options,coordination)
    }))
  };
  descriptors.feedback={
    root:()=>$("#view-feedback"),
    load:()=>(feedbackFeatureModuleRequest||import("../features/feedback/index.mjs")).then(module=>module.createFeedbackFeatureController({
      requestV1:(url,options,coordination)=>featureRequestV1("feedback",url,options,coordination),
      listAllV1:(url,options)=>featureListAllV1("feedback",url,options),
      getAppVersion:()=>appVersion,
      createRequestId:()=>crypto.randomUUID(),
      formatDate,
      showToast
    }))
  };
  descriptors.discovery={
    root:()=>$("#view-discovery"),
    load:()=>(discoveryFeatureModuleRequest||import("../features/thought-discovery/index.mjs")).then(module=>module.createDiscoveryFeatureController({
      requestV1:(url,options,coordination)=>featureRequestV1("discovery",url,options,coordination),
      createAction:(input,options)=>actionsCoordinator.runCommand(actionsCoordinator.commands.createAction(input),options),
      navigate:openDiscoveryItem,
      showToast,
      formatDate,
      plainPreview,
      createRequestId:()=>crypto.randomUUID(),
      now:()=>Date.now(),
      restorePendingStatuses:pendingDiscoveryStatuses
    }))
  };
  descriptors.notifications={
    root:()=>$("#view-notifications"),
    load:()=>(notificationsFeatureModuleRequest||import("../features/notifications/index.mjs")).then(module=>module.createNotificationsFeatureController({
      request,
      loadNotifications:()=>withFeatureScope("notifications",loadNotifications),
      scheduleNotificationPoll,
      openTarget:openAiTaskTarget,
      getSnapshot:()=>state,
      getLoadState:()=>notificationsLoadState,
      getUnreadCount:()=>notificationUnreadCount,
      isSessionReady:()=>Boolean(currentUser?.id),
      formatDate,
      showToast
    }))
  };
  const loadMineShellPage=view=>loadMineShellFeatureModule().then(module=>module.createMineShellFeatureController({
    view,
    getUser:()=>currentUser,
    getSnapshot:()=>state,
    getNotificationUnreadCount:()=>notificationUnreadCount,
    getSyncHealth:()=>syncHealth,
    getGovernanceUrl:()=>governanceUrl,
    getReleaseVersion:()=>releaseVersion,
    setShellVersion:value=>{const version=$("#sidebar-app-version");if(version)version.textContent=value},
    getDeniedAccess:()=>deniedAccess
  }));
  descriptors.mine={root:()=>$("#view-mine"),load:()=>loadMineShellPage("mine")};
  descriptors.permission={root:()=>$("#view-permission"),load:()=>loadMineShellPage("permission")};
  descriptors.about={root:()=>$("#view-about"),load:()=>loadMineShellPage("about")};
  descriptors["personal-context"]={
    root:()=>$("#view-personal-context"),
    load:()=>loadPersonalContextFeatureModule().then(module=>module.createPersonalContextFeatureController({
      data:{
        getSnapshot:()=>state,
        getAccountId:()=>currentUser?.id||"",
        getSessionSerial:()=>sessionSerial,
        requestV1:(url,options)=>featureRequestV1("personal-context",url,options)
      },
      navigation:{
        activateDate:(date,dailyType)=>{
          activeDate=date;
          if(dailyType&&dailyTypeMeta[dailyType])activeDailyType=dailyType;
          renderDate();renderSliders();publishDomains(new Set(["thoughts","activeDate"]));renderStateChart();renderHomeMood();renderChat()
        },
        switchView,
        openThoughtDetail
      },
      view:{contentState,escapeMarkup:escapeHtml,plainPreview,formatDate},
      platform:{
        requestFrame:callback=>requestAnimationFrame(callback),
        queryDestination:selector=>document.querySelector(selector),
        escapeSelector:value=>CSS.escape(value),
        isDetailsElement:value=>value instanceof HTMLDetailsElement
      }
    }))
  };
  const loadOwnerConsolePage=view=>loadOwnerConsoleFeatureModule().then(module=>{
    const controller=module.createOwnerConsoleFeatureController({
      view,
      request:(url,options)=>withFeatureScope(view,()=>request(url,options)),
      requestWithMetadata:(url,options)=>withFeatureScope(view,()=>apiClient.requestWithMetadata(url,options)),
      settings:{snapshot:()=>llmSettings,currentDate:()=>currentLocalDate},
      capability:{has:hasCapability,accountId:()=>currentUser?.id||"",sessionGeneration:()=>sessionSerial},
      format:{
        escapeMarkup:escapeHtml,
        escapeSelector:value=>CSS.escape(value),
        cny:formatCny,
        compactNumber,
        date:formatDate,
        shiftDateKey:shiftLocalDateKey
      },
      navigation:{openView:viewName=>switchView(viewName),openSource:source=>openCommercialSource(source.view,source.id,source.date)},
      toast:showToast,
      confirm:message=>globalThis.confirm(message),
      timer:{schedule:(callback,delay)=>setTimeout(callback,delay),cancel:timer=>clearTimeout(timer)}
    });
    ownerConsoleFeatureControllers.add(controller);
    return controller
  });
  for(const view of["ai-cost","architecture","commercialization"]){
    descriptors[view]={root:()=>$(`#view-${view}`),load:()=>loadOwnerConsolePage(view)}
  }
  const loadAccountSettingsPage=view=>loadAccountSettingsFeatureModule().then(module=>{
    const controller=module.createAccountSettingsFeatureController({
      view,
      auth:{request:authRequest,reset:showAuthGate,logout},
      request:{
        json:(url,options)=>request(url,options),
        blob:(url,options,config)=>apiClient.requestBlob(url,options,config)
      },
      currentUser:{
        get:()=>currentUser,
        set:user=>{currentUser=user;renderAccountIdentity()}
      },
      settings:{get:()=>llmSettings,set:value=>{llmSettings=value}},
      speech:{get:()=>state.speech||{}},
      localTest:{
        get:()=>localTestConfig,
        set:value=>{localTestConfig=value},
        clearScopes:()=>localTestScopeLoads.clear(),
        reload:()=>load(),
        navigate:viewName=>switchView(viewName),
        setSummary:value=>{const summary=$("#mine-settings-summary");if(summary)summary.textContent=value}
      },
      session:{reset:()=>{
        rotateSession();
        invalidatePageLoads();
        for(const ownerController of ownerConsoleFeatureControllers)ownerController.resetSession()
      }},
      pageAudio:pageAudioCoordinator,
      hasCapability,
      showToast,
      confirmAction:message=>globalThis.confirm(message)
    });
    accountSettingsFeatureControllers.add(controller);
    return controller
  });
  descriptors.account={root:()=>$("#view-account"),load:()=>loadAccountSettingsPage("account")};
  descriptors.settings={root:()=>$("#view-settings"),load:()=>loadAccountSettingsPage("settings")};
  descriptors.trash={
    root:()=>$("#view-trash"),
    load:()=>loadTrashFeatureModule().then(module=>module.createTrashFeatureController({
      data:{
        getAccountId:()=>currentUser?.id||"",
        getSessionSerial:()=>sessionSerial,
        request:(url,options)=>withFeatureScope("trash",()=>request(url,options)),
        refresh:(domains,options)=>refreshState(domains,options)
      },
      view:{
        formatDate,
        contentState,
        escapeMarkup:escapeHtml,
        plainPreview,
        renderMarkdown,
        renderLatex,
        showToast
      },
      platform:{
        confirm:message=>globalThis.confirm(message),
        prompt:message=>globalThis.prompt(message)
      }
    }))
  };
  return descriptors
}
const pageEffects={today:()=>{if(applicationLifecycleReady&&currentUser?.id)void actionsCoordinator.load()}};
const lazyPageEffects=new Proxy(pageEffects,{get(target,view){const effect=target[view];if(typeof view!=="string"||!LOCAL_TEST_VIEW_SCOPES[view])return effect;return()=>{void ensureLocalTestViewScope(view).then(async ready=>{if(!ready)return;if(typeof effect==="function")await effect();await restorePendingProjections()})}}});
pageRouter=createPageRouter({query:$,queryAll:$$,effects:lazyPageEffects,basePath:applicationBasePath,onRouteStart:applyApplicationRoute,canAccessView:(_,capability)=>hasCapability(capability),onDenied:showPermissionPage});
({switchView,restoreView}=pageRouter);
async function openCaptureFeature(action,trigger=null){
  await Promise.resolve(switchView("captures"));
  return capturesFeatureController?.[action]?.(trigger)||false
}
async function openLibraryFeature(id,options={}){
  await Promise.resolve(switchView("books"));
  return libraryFeatureController?.openBook(id,options)||false
}
async function openQuoteFeature(id){
  await Promise.resolve(switchView("quotes"));
  return quotesFeatureController?.openItem(id)||false
}
async function openKeepsakeFeature(id){
  await Promise.resolve(switchView("keepsakes"));
  return id?keepsakesFeatureController?.openItem(id)||false:true
}
$("#home-open-thought").addEventListener("click",event=>openHomeEditor("thought",event.currentTarget));
$("#home-record-voice").addEventListener("click",event=>void openCaptureFeature("openQuickVoice",event.currentTarget));
$("#home-record-state").addEventListener("click",event=>openHomeEditor("state",event.currentTarget));
$("#home-shuffle").addEventListener("click",()=>renderHomeMemories({advance:true}));
$("#home-memory-grid").addEventListener("click",event=>{
  const button=event.target.closest("[data-home-memory-open]");
  if(button)openHomeMemory(homeMemoryByKey.get(button.dataset.homeMemoryOpen))
});
$("#home-keepsake").addEventListener("click",event=>{
  const button=event.target.closest("[data-home-keepsake]");
  if(!button)return;
  void openKeepsakeFeature(button.dataset.homeKeepsake)
});
$$("[data-home-editor-close]").forEach(button=>button.addEventListener("click",()=>closeHomeEditors()));
$$(".home-v02-editor-backdrop").forEach(editor=>editor.addEventListener("click",event=>{if(event.target===editor)closeHomeEditors()}));
function openDiscoveryItem(item){
  const route=item?.route||{view:"thoughts",resourceType:"thought",resourceId:item?.id||""},id=route.resourceId;
  if(route.view==="books"){void openLibraryFeature(id,{noteId:String(route.targetKey||"").replace(/^note:/,"")});return}
  if(route.view==="quotes"){void openQuoteFeature(id);return}
  if(route.resourceType==="thought")openThoughtDetail(id);else switchView(route.view||"thoughts");
  const selector={thought:`[data-chain-id="${CSS.escape(id)}"]`,capture:`[data-capture-id="${CSS.escape(id)}"]`,journal:`[data-journal-id="${CSS.escape(id)}"]`}[route.resourceType];
  requestAnimationFrame(()=>{const target=document.querySelector(selector||"");if(target instanceof HTMLDetailsElement)target.open=true;target?.scrollIntoView({behavior:"smooth",block:"center"})})
}
function openCheckinEditor(id){
  const item=state.checkins.find(value=>value.id===id);if(!item)return;
  $("#edit-checkin-id").value=id;$("#edit-checkin-datetime").value=persistedDateTimeInput(item);$("#edit-checkin-factors").value=(item.factors||[]).join(" ");$("#edit-checkin-status").textContent="";
  $("#edit-checkin-metrics").innerHTML=Object.entries(metricConfig()).map(([key,cfg])=>{const value=Number(metricValue(item,key,cfg.custom))||3,note=item.notes?.[key]||"",options=cfg.anchors.map((anchor,index)=>`<option value="${index+1}" ${value===index+1?"selected":""}>${index+1} · ${escapeHtml(anchor)}</option>`).join("");return `<label class="edit-checkin-metric"><span>${escapeHtml(cfg.label)}</span><select data-edit-checkin-metric="${escapeHtml(key)}" data-custom="${cfg.custom?"1":"0"}">${options}</select><input data-edit-checkin-note="${escapeHtml(key)}" value="${escapeHtml(note)}" maxlength="800" placeholder="备注（可空）"></label>`}).join("");
  $("#edit-checkin-modal").hidden=false;$("#edit-checkin-factors").focus();
}

document.addEventListener("play",event=>{const audio=event.target;if(!(audio instanceof HTMLAudioElement))return;const controls=audio.closest(".speech-asset-controls"),rate=controls?.querySelector("[data-speech-playback-rate]");if(rate)audio.playbackRate=normalizeTtsPlaybackRate(rate.value);claimPageAudio(audio)},true);
document.addEventListener("click",async e=>{
  const button=e.target.closest("[data-delete-checkin],[data-chat-delete]");if(!button)return;
  const target=button.dataset.deleteCheckin?{id:button.dataset.deleteCheckin,domain:"checkins",url:`/api/v1/checkins/${encodeURIComponent(button.dataset.deleteCheckin)}`,domains:["checkins","review"],label:"状态"}:{id:button.dataset.chatDelete,domain:"chats",url:`/api/v1/chats/${encodeURIComponent(button.dataset.chatDelete)}`,domains:["chats"],label:"对话"};
  if(!confirm(`将这条${target.label}移入回收站？`))return;
  const item=(state[target.domain]||[]).find(value=>value.id===target.id);if(!item)return;const requestId=button.dataset.requestId||crypto.randomUUID();button.dataset.requestId=requestId;button.disabled=true;
  try{await requestV1(target.url,{method:"DELETE",headers:{"if-match":`"${item.version||1}"`,"idempotency-key":requestId}},{domains:target.domains,resource:target.url,recoverCommitted:true,projection:{kind:"record.delete",domain:target.domain,id:target.id},onQueued:record=>applyPendingProjection(record)});void refreshState(target.domains).catch(error=>showToast(`${target.label}已移除，但列表刷新失败：${error.message}`,"error"));showToast(`${target.label}已移入回收站`)}
  catch(error){if(error.syncStatus==="pending")showToast(`${target.label}将在网络恢复后移入回收站`);else{await refreshState(target.domains).catch(()=>{});showToast(error.message,"error")}}
});
document.addEventListener("click",event=>{
  const button=event.target.closest("[data-context-source]");
  if(button&&!button.closest("#view-personal-context"))openContextReceiptSource(button)
});
document.addEventListener("click",event=>{
  const button=event.target.closest("[data-content-focus],[data-content-action]");if(!button)return;
  if(button.closest("#view-captures,#view-journals"))return;
  if(button.dataset.contentFocus){
    const target=document.getElementById(button.dataset.contentFocus);
    target?.scrollIntoView({behavior:"smooth",block:"center"});target?.focus();return
  }
  const command=button.dataset.contentAction;
  if(command==="new-state"){switchView("today");openHomeEditor("state",button);return}
  if(command==="retry-route-state"){button.disabled=true;void loadRouteState(pageRouter?.currentRoute()).finally(()=>{if(button.isConnected)button.disabled=false});return}
});

document.addEventListener("click",e=>{const b=e.target.closest("button");if(!b||b.closest("#view-ai-cost,#view-architecture,#view-commercialization"))return;if(b.dataset.view){closeHomeEditors({restoreFocus:false});return switchView(b.dataset.view)}if(b.dataset.go){closeHomeEditors({restoreFocus:false});return switchView(b.dataset.go)}if(b.dataset.removeDraftTag!=null){draftTags=draftTags.filter(tag=>tag!==b.dataset.removeDraftTag);return renderTagComposer()}});
document.addEventListener("click",async e=>{
  const button=e.target.closest("button");if(!button)return;
  if(button.dataset.editCheckin)return openCheckinEditor(button.dataset.editCheckin);
});
$$("[data-active-date]").forEach(input=>input.addEventListener("change",async e=>{chainDraftVersion+=1;activeDate=e.target.value||activeDate;renderDate();renderSliders();publishDomains(new Set(["thoughts","activeDate"]));renderStateChart();renderHomeMood();renderChat();await healthFeatureController?.changeDate(activeDate).catch(error=>showToast(`健康截图恢复失败：${error.message}`,"error"))}));
$$("[data-content-image-editor] input[type='file']").forEach(input=>input.addEventListener("change",async event=>{
  const fileInput=event.currentTarget,editor=fileInput.closest("[data-content-image-editor]"),status=editor?.closest("form")?.querySelector(".status");
  if(editor?.dataset.contentImageEditor==="capture")return;
  try{delete editor.closest("form")?.dataset.requestId;await setContentImageFiles(editor.dataset.contentImageEditor,fileInput.files);fileInput.value="";if(status)status.textContent=""}
  catch(error){
    fileInput.value="";
    const message=presentError(error,{
      operation:"添加图片",
      object:"这些图片",
      retained:error?.publicValidation?"已经选择的图片没有变化":"当前页面中的图片仍然保留",
      publicValidation:error?.publicValidation===true
    }).message;
    if(status)status.textContent=message;else showToast(message,"error")
  }
}));
document.addEventListener("click",async event=>{
  const remove=event.target.closest("[data-content-image-remove]");if(!remove)return;
  const editor=remove.closest("[data-content-image-editor]");if(editor?.dataset.contentImageEditor==="capture")return;const draft=contentImageDraft(editor?.dataset.contentImageEditor),index=Number(remove.dataset.contentImageRemove);
  if(!draft||!Number.isSafeInteger(index)||!draft.items[index])return;
  await contentImageDraftManager.remove(editor.dataset.contentImageEditor,index)
    .then(()=>renderContentImageEditor(editor.dataset.contentImageEditor))
    .catch(error=>showToast(`图片暂存失败：${error.message}`,"error"))
});
document.addEventListener("click",event=>{const button=event.target.closest("[data-content-image-understand]");if(button)void queueContentImageUnderstanding(button)});
$("#checkin-confirm-all").addEventListener("click",()=>{$$("[data-metric]").forEach(input=>{input.dataset.confirmed="true";input.closest(".metric").classList.remove("unconfirmed");const label=metricConfig()[input.dataset.metric];$(`#${CSS.escape(input.dataset.metric)}-anchor`).textContent=label.anchors[Number(input.value)-1]});navigator.vibrate?.(12);$("#checkin-status").textContent="已确认当前四项，可以直接保存。"});
$("#chain-tags").addEventListener("keydown",e=>{if(entryKeyIntent(e,{inputKind:"tag"})==="commit-tag"){e.preventDefault();commitDraftTags()}});
$("#chain-form").elements.recordKind.forEach(input=>input.addEventListener("change",()=>{chainDraftVersion+=1;delete $("#chain-form").dataset.requestId;syncChainRecordKind()}));
$("#thought-source-cancel").addEventListener("click",()=>{const form=$("#chain-form");form.reset();clearDurableDraft("chain-form");resetOccurrenceInput($("#chain-datetime"));draftTags=[];renderTagComposer();answerDraft="";answerReasoningDraft="";$("#chain-status").textContent="已取消从念起展开，可以重新记录。";$("#chain-question").focus()});
for(const selector of["#chain-question","#chain-idea","#chain-answer"])$(selector).addEventListener("input",()=>{chainDraftVersion+=1;if(selector!=="#chain-answer"){answerDraft="";answerReasoningDraft=""}delete $("#chain-form").dataset.requestId});
$("#chain-form").addEventListener("reset",event=>{chainDraftVersion+=1;resetContentImageEditor("thoughtRoot");delete event.currentTarget.dataset.draftId;event.currentTarget.elements.sourceCaptureId.value="";event.currentTarget.elements.sourceCaptureVersion.value="";queueMicrotask(syncChainRecordKind)});
for(const id of durableDraftForms)for(const eventName of["input","change"])document.getElementById(id)?.addEventListener(eventName,saveDurableDrafts);
document.addEventListener("keydown",event=>{
  const field=event.target.closest?.("input,textarea"),form=field?.closest?.("#chain-form,#checkin-form,#chat-form,[data-daily-form],[data-book-entry-form],#quote-form,#selection-quote-form,#thought-block-form");
  if(!field||!form||field===document.activeElement&&["chain-tags","quote-tags","selection-quote-tags"].includes(field.id))return;
  const intent=entryKeyIntent(event,{inputKind:field.tagName==="TEXTAREA"?"multiline":"field"});
  if(intent==="submit")return void occurrenceKeyboardSubmit(event,form,field.tagName==="TEXTAREA"?"multiline":"field");
  if(intent==="block-submit")event.preventDefault()
});
$("#checkin-form").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget,b=form.querySelector('[type="submit"]'),missing=$$('[data-metric]').filter(x=>x.dataset.confirmed!=="true");
  if(missing.length){$("#checkin-status").textContent=`请先确认：${missing.map(x=>metricConfig()[x.dataset.metric].label).join("、")}`;missing[0].focus();return}
  const requestId=form.dataset.requestId||crypto.randomUUID(),temporaryId=`pending:${requestId}`,payload={...occurrenceFields($("#checkin-datetime")),notes:{},custom:{},factors:splitTags($("#checkin-factors").value)};let projected=false;
  form.dataset.requestId=requestId;b.disabled=true;b.textContent="正在保存…";
  $$('[data-metric]').forEach(x=>{const k=x.dataset.metric;if(x.dataset.custom==="1")payload.custom[k]=Number(x.value);else payload[k]=Number(x.value);payload.notes[k]=$(`#${CSS.escape(k)}-note`)?.value||""});
  try{
    const result=await requestV1("/api/v1/checkins",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{
      domains:["checkins"],
      projection:{kind:"checkin.create",temporaryId,payload:{...payload,occurredAt:payload.occurredAt,occurredOn:payload.occurredOn||localDateKey(payload.occurredAt||new Date())}},
      onQueued:record=>{
        const occurredAt=payload.occurredAt||record.createdAt,occurredOn=localDateKey(occurredAt);
        state.checkins=[{id:temporaryId,...payload,occurredAt,occurredOn,createdAt:record.createdAt,_sync:{status:"sending",operationId:record.operationId}},...(state.checkins||[]).filter(item=>item.id!==temporaryId)];
        projected=true;renderStateChart();renderHomeMood();$("#checkin-status").textContent="已记下，正在同步…";
      }
    });
    state.checkins=(state.checkins||[]).map(item=>item.id===temporaryId?result.data:item);renderStateChart();renderHomeMood();
    clearDurableDraft("checkin-form");form.reset();delete form.dataset.requestId;renderSliders();resetOccurrenceInput($("#checkin-datetime"));$("#checkin-status").textContent="此刻状态已保存。";closeHomeEditors();showToast("此刻状态已保存");void refreshState(["checkins","review"]).catch(error=>showToast(`状态已保存，但列表刷新失败：${error.message}`,"error"))
  }catch(err){
    if(projected&&err.syncStatus==="pending"){
      const pending=(state.checkins||[]).find(item=>item.id===temporaryId);if(pending)pending._sync.status="pending";renderStateChart();renderHomeMood();
      clearDurableDraft("checkin-form");form.reset();delete form.dataset.requestId;renderSliders();resetOccurrenceInput($("#checkin-datetime"));$("#checkin-status").textContent="已记下，网络恢复后自动同步。";closeHomeEditors();showToast("此刻状态已进入待同步队列")
    }else if(projected&&err.syncStatus==="conflict"){
      state.checkins=(state.checkins||[]).filter(item=>item.id!==temporaryId);renderStateChart();renderHomeMood();$("#checkin-status").textContent=`同步冲突：${err.message}。本地内容已保留，请刷新后重试。`;showToast("此刻状态同步发生冲突","error")
    }else{
      if(projected){state.checkins=(state.checkins||[]).filter(item=>item.id!==temporaryId);renderStateChart();renderHomeMood()}
      $("#checkin-status").textContent=err.message
    }
  }finally{b.disabled=false;b.textContent="记下此刻"}
});
$("#thought-prompt-button").addEventListener("click",async e=>{
  const button=e.currentTarget,question=$("#chain-question"),status=$("#thought-prompt-status"),selectedDate=activeDate,owner=currentUser?.id,requestId=crypto.randomUUID(),targetId=$("#chain-form").dataset.draftId||crypto.randomUUID(),inputVersion=chainDraftVersion;$("#chain-form").dataset.draftId=targetId;
  if(question.value.trim()){status.textContent="问题框已有内容，清空后再生成新的引子。";question.focus();return}
  let changed=false;const markChanged=()=>{changed=true};question.addEventListener("input",markChanged);$("#chain-form").addEventListener("reset",markChanged);
  button.disabled=true;button.textContent="正在想…";status.textContent="正在找一个可以接住的开头…";
  try{
    const result=await request("/api/thought-prompts",{method:"POST",body:JSON.stringify({requestId,targetId,inputVersion,...occurrenceFields($("#chain-datetime"))})});
    if(changed||question.value.trim()||activeDate!==selectedDate||currentUser?.id!==owner||(result.requestId&&result.requestId!==requestId)){status.textContent="引子已生成；当前输入已变化，请继续你的思考。";return}
    question.value=result.prompt||"";question.focus();question.setSelectionRange(question.value.length,question.value.length);
    status.textContent=result.hasHistory?"从之前的记录接了一步；它只是引子，可以随手改。":"先抛来一个轻巧的问题；它只是引子，可以随手改。";
  }catch(err){status.textContent=`生成失败：${err.message}`}
  finally{question.removeEventListener("input",markChanged);$("#chain-form").removeEventListener("reset",markChanged);button.disabled=false;button.textContent="✦ 给个引子"}
});
$("#draft-answer-button").addEventListener("click",async e=>{
  const button=e.currentTarget,form=$("#chain-form"),question=$("#chain-question"),idea=$("#chain-idea"),q=question.value.trim();if(!q){$("#chain-status").textContent="先写下问题，我才能结合你的记录回答。";question.focus();return}
  const targetId=form.dataset.draftId||crypto.randomUUID(),requestId=crypto.randomUUID(),inputVersion=chainDraftVersion,owner=currentUser?.id,session=sessionSerial,ideaSnapshot=idea.value;form.dataset.draftId=targetId;let applied=false;
  const isCurrent=()=>chainDraftVersion===inputVersion&&currentUser?.id===owner&&sessionSerial===session&&question.value.trim()===q&&idea.value===ideaSnapshot;
  button.disabled=true;
  try{await runAnswerInModal({title:"生成可编辑回答草稿",scene:"thoughtDraft",isCurrent,requestCall:onEvent=>requestStream("/api/answer-drafts",{method:"POST",body:JSON.stringify({requestId,targetId,inputVersion,question:q,idea:ideaSnapshot})},onEvent),onDone:r=>{if(r.requestId!==requestId||r.targetId!==targetId||Number(r.inputVersion)!==inputVersion)return;applied=true;answerDraft=r.draft;answerReasoningDraft=r.reasoningContent||"";$("#chain-answer").value=r.draft;$("#chain-status").textContent="草稿已填入回答框。请按你的判断修改，再提交整套思考。"}});showToast(applied?"回答草稿已生成，可直接修改":"旧草稿已完成，但没有覆盖当前输入",applied?"success":"error")}
  catch(err){$("#chain-status").textContent=err.message}
  finally{button.disabled=false}
});
$("#chain-form").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget,b=form.querySelector('[type="submit"]');if(b.disabled)return;if($("#chain-tags").value.trim())commitDraftTags();const recordKind=chainRecordKind(),requestId=form.dataset.requestId||crypto.randomUUID(),temporaryId=`pending:${requestId}`,answer=$("#chain-answer").value,sourceCaptureId=form.elements.sourceCaptureId.value,sourceCaptureVersion=Number(form.elements.sourceCaptureVersion.value)||0;let uploadedPaths=[];form.dataset.requestId=requestId;b.disabled=true;b.textContent="正在保存…";$("#chain-status").textContent=recordKind==="capture"?"正在收进念起…":"正在保存整套思考…";
  try{
    const submission=await contentImagePaths("thoughtRoot");uploadedPaths=submission.uploadedPaths;
    const eventTime=occurrenceFields($("#chain-datetime")),original=imageRecordPayload({content:$("#chain-question").value,attachmentPaths:submission.attachmentPaths});
    if(recordKind==="capture"){
      const payload={...eventTime,...captureRecordPayload(original),tags:draftTags},result=(await requestV1("/api/v1/captures",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{domains:["captures"],projection:{kind:"capture.create",temporaryId,payload},onQueued:record=>applyPendingProjection(record)})).data;
      state.captures=(state.captures||[]).map(item=>item.id===temporaryId?result:item);publishDomains(new Set(["captures"]));await clearSubmittedContentImageDraft("thoughtRoot");chainDraftVersion+=1;form.reset();clearDurableDraft("chain-form");resetOccurrenceInput($("#chain-datetime"));draftTags=[];renderTagComposer();answerDraft="";answerReasoningDraft="";delete form.dataset.requestId;delete form.dataset.draftId;$("#chain-status").textContent="已收进念起。";closeHomeEditors();void refreshState("captures").catch(error=>showToast(`念起已保存，但页面刷新失败：${error.message}`,"error"));showToast("已收进念起");return
    }
    const needsAnswer=Boolean(original.content.trim()||original.attachmentPaths.length)&&!answer.trim()&&llmSettings.automaticAnswers?.thoughtAnswer===true,payload={...eventTime,question:original.content,attachmentPaths:original.attachmentPaths,idea:$("#chain-idea").value,answer,modelDraft:answerDraft,modelReasoning:answerReasoningDraft,tags:draftTags,generateAnswer:needsAnswer,...(sourceCaptureId?{sourceRef:{type:"capture",id:sourceCaptureId,version:sourceCaptureVersion}}:{})},result=(await requestV1("/api/v1/thought-chains",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{domains:["thoughts","aiTasks","notifications"],projection:{kind:"thought.chain.create",temporaryId,payload},onQueued:record=>applyPendingProjection(record)})).data,question=result.items.find(item=>item.type==="question");
    state.thoughts=[...result.items,...(state.thoughts||[]).filter(item=>!String(item.id).startsWith(`${temporaryId}:`))];publishDomains(new Set(["thoughts"]));await clearSubmittedContentImageDraft("thoughtRoot");chainDraftVersion+=1;form.reset();clearDurableDraft("chain-form");resetOccurrenceInput($("#chain-datetime"));draftTags=[];renderTagComposer();answerDraft="";answerReasoningDraft="";delete form.dataset.requestId;delete form.dataset.draftId;$("#chain-status").textContent=needsAnswer?"思考已保存，后台生成一条图文合并回答。":answer.trim()?"已保存为一套完整思考。":"思考已保存，未自动调用 AI。";closeHomeEditors();void refreshState(["thoughts","review","notifications"],{chainId:question?.id}).catch(error=>showToast(`记录已保存，但页面刷新失败：${error.message}`,"error"));if(needsAnswer&&question){void startBackgroundChainAnswer(question,result.task)}showToast(needsAnswer?"思考已保存，可继续记录":"整套思考已保存，不会重复记录")
  }catch(err){
    if(err.syncStatus==="pending"){await clearSubmittedContentImageDraft("thoughtRoot");chainDraftVersion+=1;form.reset();clearDurableDraft("chain-form");resetOccurrenceInput($("#chain-datetime"));draftTags=[];renderTagComposer();answerDraft="";answerReasoningDraft="";delete form.dataset.requestId;delete form.dataset.draftId;$("#chain-status").textContent=recordKind==="capture"?"念起已留存，网络恢复后自动同步。":"思考已留存，网络恢复后自动同步。";closeHomeEditors();showToast(recordKind==="capture"?"念起已进入待同步队列":"思考已进入待同步队列")}
    else{await discardContentImageUploads("thoughtRoot",uploadedPaths);$("#chain-status").textContent=err.message}
  }finally{b.disabled=false;syncChainRecordKind()}
});
$("#chat-form").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget,b=form.querySelector("button"),requestId=form.dataset.requestId||crypto.randomUUID(),payload={...occurrenceFields($("#chat-datetime")),message:$("#chat-input").value};form.dataset.requestId=requestId;b.disabled=true;$("#chat-status").textContent="正在结合你已保存的记录…";
  try{await requestV1("/api/v1/chats",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{domains:["chats"]});delete form.dataset.requestId;$("#chat-input").value="";resetOccurrenceInput($("#chat-datetime"));void refreshState("chat").catch(error=>showToast(`回答已保存，但页面刷新失败：${error.message}`,"error"));$("#chat-status").textContent=""}
  catch(err){$("#chat-status").textContent=err.syncStatus==="pending"?"问题已留存，网络恢复后自动处理。":err.message}
  finally{b.disabled=false}
});
$("#edit-checkin-form").addEventListener("submit",async e=>{e.preventDefault();const button=e.currentTarget.querySelector('[type="submit"]'),id=$("#edit-checkin-id").value,item=(state.checkins||[]).find(value=>value.id===id),payload={occurredAt:$("#edit-checkin-datetime").value,factors:splitTags($("#edit-checkin-factors").value),custom:{},notes:{}};$$("[data-edit-checkin-metric]").forEach(input=>{const key=input.dataset.editCheckinMetric;if(input.dataset.custom==="1")payload.custom[key]=Number(input.value);else payload[key]=Number(input.value);payload.notes[key]=$(`[data-edit-checkin-note="${CSS.escape(key)}"]`)?.value||""});button.disabled=true;$("#edit-checkin-status").textContent="正在保存修改…";try{await requestV1(`/api/v1/checkins/${encodeURIComponent(id)}`,{method:"PATCH",headers:{"if-match":`"${item?.version||1}"`},body:JSON.stringify(payload)},{domains:["checkins"],recoverCommitted:true,projection:{kind:"record.update",domain:"checkins",id,payload},onQueued:record=>applyPendingProjection(record)});$("#edit-checkin-modal").hidden=true;void refreshState(["checkins","review"]).catch(error=>showToast(`状态已更新，但列表刷新失败：${error.message}`,"error"));showToast("此刻状态已更新")}catch(err){if(err.syncStatus==="pending"){$("#edit-checkin-modal").hidden=true;showToast("状态修改将在网络恢复后同步")}else{await refreshState(["checkins","review"]).catch(()=>{});$("#edit-checkin-status").textContent=err.message}}finally{button.disabled=false}});
$("#edit-checkin-modal .modal-close").addEventListener("click",()=>$("#edit-checkin-modal").hidden=true);$("#edit-checkin-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)e.currentTarget.hidden=true});
$("#ai-answer-close").addEventListener("click",closeAnswerModal);$("#ai-answer-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)closeAnswerModal()});
document.addEventListener("click",e=>{const button=e.target.closest("[data-image-viewer-path]");if(button)openImageViewer(button)});
$("#image-viewer-close").addEventListener("click",()=>closeImageViewer());
$("#image-viewer-prev").addEventListener("click",()=>moveImageViewer(-1));
$("#image-viewer-next").addEventListener("click",()=>moveImageViewer(1));
$("#image-viewer").addEventListener("click",e=>{if(e.target===e.currentTarget)closeImageViewer()});
document.addEventListener("keydown",e=>{
  const viewer=$("#image-viewer"),homeEditor=$$(".home-v02-editor-backdrop").find(editor=>!editor.hidden),answerModal=$("#ai-answer-modal");
  if(!viewer.hidden){
    if(e.key==="Tab")return trapHomeEditorFocus(e,viewer);
    if(e.key==="Escape"){e.preventDefault();return closeImageViewer()}
    if(e.key==="ArrowLeft"){e.preventDefault();return moveImageViewer(-1)}
    if(e.key==="ArrowRight"){e.preventDefault();return moveImageViewer(1)}
    return
  }
  if(homeEditor&&answerModal.hidden&&e.key==="Tab")return trapHomeEditorFocus(e,homeEditor);
  if(e.key!=="Escape")return;
  if(!answerModal.hidden)return closeAnswerModal();
  if(!$("#thought-block-modal").hidden)return $("#thought-block-modal").hidden=true;
  if(!$("#edit-checkin-modal").hidden)return $("#edit-checkin-modal").hidden=true;
  if(homeEditor)closeHomeEditors()
});
for(const key of Object.keys(quoteTagPickerConfig)){
  const elements=quoteTagPickerElements(key);
  elements.input.addEventListener("input",event=>updateQuoteTagPicker(key,{type:"input",value:event.currentTarget.value},{open:true}));
  elements.input.addEventListener("focus",()=>updateQuoteTagPicker(key,{type:"set-candidates",values:quoteTagCandidates()},{open:true}));
  elements.input.addEventListener("keydown",event=>{
    const result=handleTagMultiSelectKey(quoteTagStates[key],{
      key:event.key,
      isComposing:event.isComposing,
      selectionStart:event.currentTarget.selectionStart,
      selectionEnd:event.currentTarget.selectionEnd
    });
    if(!result.handled||event.key==="Enter"&&result.intent==="none")return;
    event.preventDefault();quoteTagStates[key]=result.state;
    elements.root.dataset.open=String(result.intent==="move");
    renderQuoteTagPicker(key);
    if(["create","select","remove"].includes(result.intent))elements.status.textContent=result.intent==="remove"?"已移除标签。":"已添加标签。"
  });
  elements.toggle.addEventListener("click",()=>{
    const open=elements.root.dataset.open!=="true";
    updateQuoteTagPicker(key,{type:"set-candidates",values:quoteTagCandidates()},{open});
    if(open)elements.input.focus()
  });
  elements.root.addEventListener("click",event=>{
    const option=event.target.closest("[data-quote-tag-option]"),remove=event.target.closest("[data-quote-tag-remove]");
    if(option){updateQuoteTagPicker(key,{type:"select",value:option.dataset.quoteTagOption},{open:false});elements.input.focus();elements.status.textContent="已添加标签。"}
    else if(remove){updateQuoteTagPicker(key,{type:"remove",value:remove.dataset.quoteTagRemove},{open:false});elements.input.focus();elements.status.textContent="已移除标签。"}
  })
}
document.addEventListener("click",event=>{
  for(const key of Object.keys(quoteTagPickerConfig)){
    const elements=quoteTagPickerElements(key);
    if(elements?.root&&!elements.root.contains(event.target)&&elements.root.dataset.open==="true"){
      elements.root.dataset.open="false";renderQuoteTagPicker(key)
    }
  }
});
$("#selection-quote-close").addEventListener("click",closeSelectionQuoteModal);
$("#selection-quote-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)closeSelectionQuoteModal()});
$("#selection-quote-form").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#selection-quote-status"),payload={...occurrenceFields($("#selection-quote-datetime")),source:$("#selection-quote-source").value,content:$("#selection-quote-content").value,tags:quoteTagsForSubmission("selectionQuote")},requestId=form.dataset.requestId||crypto.randomUUID(),temporaryId=`pending:${requestId}`;form.dataset.requestId=requestId;button.disabled=true;status.textContent="正在收藏…";
  try{
    const result=await requestV1("/api/v1/quotes",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{domains:["quotes"],projection:{kind:"record.create",domain:"quotes",temporaryId,payload},onQueued:record=>applyPendingProjection(record)});
    state.quotes=(state.quotes||[]).map(item=>item.id===temporaryId?result.data:item);delete form.dataset.requestId;closeSelectionQuoteModal();void refreshState("quotes").catch(error=>showToast(`善言已保存，但列表刷新失败：${error.message}`,"error"));showToast("选中文字已收为善言")
  }catch(err){if(err.syncStatus==="pending"){closeSelectionQuoteModal();showToast("善言已进入待同步队列")}else status.textContent=err.message}finally{button.disabled=false}
});
$$("[data-onboarding-mode]").forEach(button=>button.addEventListener("click",()=>{collectOnboardingAnswers();onboardingMode=button.dataset.onboardingMode==="detailed"?"detailed":"quick";$("#onboarding-understanding").closest("label").hidden=true;$("#onboarding-status").textContent=onboardingMode==="detailed"?"详细版共 18 题，全部作答后才能完成。":"快速版共 8 题，全部作答后才能完成。";renderOnboardingQuestions()}));
$$("[data-onboarding-sample]").forEach(button=>button.addEventListener("click",()=>{$("#onboarding-material").value=button.dataset.onboardingSample;$("#onboarding-understanding").closest("label").hidden=true}));
$("#onboarding-file").addEventListener("change",async event=>{const file=event.currentTarget.files?.[0];if(!file)return;if(file.size>1024*1024){$("#onboarding-status").textContent="导入文件不能超过 1 MB。";event.currentTarget.value="";return}try{$("#onboarding-material").value=await file.text();$("#onboarding-status").textContent=`已读取 ${file.name}，确认前仍可修改。`}catch{$("#onboarding-status").textContent="文件读取失败，请重试。"}});
$("#onboarding-preview").addEventListener("click",async()=>{const form=$("#onboarding-form"),status=$("#onboarding-status");if(!form.reportValidity()){status.textContent="请先完成当前版本的全部题目。";return}status.textContent="正在整理初始认知…";try{const result=await request("/api/onboarding/preview",{method:"POST",body:JSON.stringify(onboardingPayload())}),understanding=$("#onboarding-understanding");understanding.value=result.understanding;understanding.closest("label").hidden=false;understanding.focus();status.textContent="这是可修改的初步理解，后续真实记录优先。"}catch(error){status.textContent=error.message}});
$("#onboarding-skip").addEventListener("click",()=>{for(const key of["gender","region","occupation","major","school","introduction","works"]){const field=$(`#onboarding-${key}`);if(field)field.value=""}$$('#onboarding-interests input[type="checkbox"]').forEach(input=>input.checked=false);$("#onboarding-material").value="";$("#onboarding-file").value="";$("#onboarding-understanding").value="";$("#onboarding-understanding").closest("label").hidden=true;$("#onboarding-optional").open=false;$("#onboarding-status").textContent="已略过可选资料；完成全部题目后即可开始。"});
$("#onboarding-legacy-back").addEventListener("click",()=>onboardingV2Controller.backFromLegacy());
$("#onboarding-form").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#onboarding-status");if(!form.reportValidity()){status.textContent="请完成当前版本的全部题目。";return}button.disabled=true;try{state.onboarding=await request("/api/onboarding",{method:"PATCH",body:JSON.stringify(onboardingPayload())});await load();showToast("旧版问卷已保存，原始选择继续保留")}catch(error){status.textContent=error.message}finally{button.disabled=false}});
$("#onboarding-v2-reopen").addEventListener("click",()=>{switchView("today");requestAnimationFrame(()=>onboardingV2Controller.reopen())});
function syncLocalDate(){const next=localDateKey();if(next===currentLocalDate)return;const followedToday=activeDate===currentLocalDate;currentLocalDate=next;if(followedToday){activeDate=next;renderDate();renderSliders();publishDomains(new Set(["thoughts","activeDate"]));renderStateChart();renderHomeMood();renderChat()}}
function markApplicationForeground(){apiClient.markForeground();syncLocalDate();restoreView?.()}
setInterval(syncLocalDate,30000);
document.addEventListener("visibilitychange",()=>{if(document.hidden){saveDurableDrafts();stopPageAudio()}else markApplicationForeground()});
window.addEventListener("pagehide",()=>{saveDurableDrafts();stopPageAudio()});
window.addEventListener("pageshow",markApplicationForeground);
$$("[data-auth-tab]").forEach(button=>{
  button.addEventListener("click",()=>setAuthTab(button.dataset.authTab));
  button.addEventListener("keydown",event=>{
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    const tabs=$$("[data-auth-tab]").filter(item=>!item.hidden&&!item.disabled);
    if(tabs.length<2)return;
    event.preventDefault();
    const current=Math.max(0,tabs.indexOf(button));
    const next=event.key==="Home"?tabs[0]:event.key==="End"?tabs.at(-1):tabs[(current+(event.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length];
    setAuthTab(next.dataset.authTab);next.focus()
  })
});
for(const [formId,endpoint]of[["login-form","/api/auth/login"],["register-form","/api/auth/register"]]){
  $(`#${formId}`).addEventListener("submit",async event=>{
    event.preventDefault();const form=event.currentTarget,fields=new FormData(form),status=$("#auth-status"),operation=++authOperationSerial;setAuthBusy(true);status.textContent=formId==="login-form"?"正在登录…":"正在创建账户…";
    try{const result=await authRequest(endpoint,Object.fromEntries(fields));if(operation!==authOperationSerial)return;form.reset();await restartApplicationForUser(result.user)}
    catch(error){if(operation===authOperationSerial)status.textContent=error.message}
    finally{if(operation===authOperationSerial)setAuthBusy(false)}
  });
}
const logout=async()=>{
  if(onboardingV2Controller.hasUnsynced()&&!confirm("当前有尚未同步的五问草稿。退出会从此设备清除这份草稿，仍要退出？"))return;
  const operation=++authOperationSerial,owner=currentUser?.id;clearDurableDraft();const clearing=owner?Promise.all([mediaDraftStore.clear(owner),onboardingV2Controller.clearOwner(owner)]):Promise.resolve();showAuthGate();setAuthTab("login");setAuthBusy(true);$("#auth-status").textContent="正在退出…";
  try{await Promise.all([clearing,authRequest("/api/auth/logout",{})])}
  catch(error){if(operation===authOperationSerial)$("#auth-status").textContent=`本地内容已锁定；服务端退出失败：${error.message}`}
  finally{if(operation===authOperationSerial){setAuthBusy(false);if($("#auth-status").textContent==="正在退出…")$("#auth-status").textContent=""}}
};
$("#logout-button").addEventListener("click",logout);
export async function startApplication(initial = null, { opening = null } = {}) {
  if(initial?.session?.authenticated)currentUser=initial.session.user||initial.meta?.user||null;
  if(initial?.state&&initial?.route){routeDataReady=true;loadedRouteKey=routeDataKey(initial.route)}
  applyCapabilitySurface(initial?.meta?.capabilities||[]);
  const mediaReady=initializeContentImageDraftManager();
  const portFactories=await portFactoriesRequest;
  const featureRegistry=createFeatureRegistry({
    descriptors:createPageFeatureDescriptors(),
    onFailure:(error,{view,phase})=>showToast(`${view} 页面${phase==="import"?"加载":"运行"}失败：${error.message}`,"error")
  });
  const {statePort,syncPort,shellPort,sessionPort}=createRuntimeApplicationPorts(portFactories);
  const application=createBrowserApplication({router:pageRouter,featureRegistry,session:sessionPort,state:statePort,sync:syncPort,shell:shellPort});
  runtimeApplication=application;runtimeFeatureRegistry=featureRegistry;runtimeStatePort=statePort;
  const startPromise=application.start(applicationStartInput(initial,opening));
  try {
    await Promise.all([startPromise,mediaReady]);
    applicationLifecycleReady=true
  } catch (error) {
    showAuthGate();
    $("#auth-status").textContent = error.message;
    await opening?.fail(error);
  } finally {
    document.documentElement.dataset.runtimeReady = "1";
  }
}
