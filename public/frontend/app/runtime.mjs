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
  createPageEffects,
  createActionsCoordinator,
  createHomeMemoryPool,
  selectHomeMemories,
  applyKeepsakeImageCandidates,
  createKeepsakeBatchItems,
  discardKeepsakeMedia,
  KEEPSAKE_BATCH_MAX_ITEMS,
  keepsakePlacementCss,
  keepsakeMediaSources,
  nextKeepsakeBatchIndex,
  scanKeepsakeAlpha,
  uploadKeepsakeMedia,
  createOnboardingV2Controller
} from "../features/index.mjs";
import {
  BASE_CHECKIN_METRICS,
  checkinMetricValue,
  createCheckinMetricConfig
} from "../features/checkins-model/index.mjs";
import { createCheckinsFeatureController } from "../features/checkins/index.mjs";
import {
  AUDIO_MAX_DURATION_MS,
  captureAudioIdentity,
  captureAudioPresentation,
  captureRecordPayload,
  createIndexedDbMediaDraftStore,
  imageRecordPayload,
  imageUnderstandingPayload,
  normalizeTtsGenerationRate,
  preferredRecorderMime,
  speechAssetForSource,
  speechAudioPath,
  speechPreviewPayload,
  speechSourceIdentity,
  speechSynthesisPayload,
  uploadPendingMediaItems,
  uploadOriginalAudio,
  uploadOriginalImages,
  TTS_PLAYBACK_RATES,
  normalizeTtsPlaybackRate,
  validatedAudioBlob,
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
const initialRuntimeView=resolveApplicationRoute(location,{basePath:applicationBasePath}).view;
const portFactoriesRequest=globalThis.__forNowPortsRequest||import("./ports.mjs");
const legacyFeatureModuleRequest=globalThis.__forNowLegacyFeatureRequest||(["export","feedback","discovery","notifications"].includes(initialRuntimeView)?null:import("../features/legacy-pages/index.mjs"));
const exportFeatureModuleRequest=globalThis.__forNowExportFeatureRequest||(initialRuntimeView==="export"?import("../features/export/index.mjs"):null);
const feedbackFeatureModuleRequest=globalThis.__forNowFeedbackFeatureRequest||(initialRuntimeView==="feedback"?import("../features/feedback/index.mjs"):null);
const discoveryFeatureModuleRequest=globalThis.__forNowDiscoveryFeatureRequest||(initialRuntimeView==="discovery"?import("../features/thought-discovery/index.mjs"):null);
const notificationsFeatureModuleRequest=globalThis.__forNowNotificationsFeatureRequest||(initialRuntimeView==="notifications"?import("../features/notifications/index.mjs"):null);
let annotationsFeatureModuleRequest=globalThis.__forNowAnnotationsFeatureRequest||null;
let backgroundResultsFeatureModuleRequest=globalThis.__forNowBackgroundResultsFeatureRequest||null;
let healthFeatureModuleRequest=globalThis.__forNowHealthFeatureRequest||null;
let thoughtsFeatureModuleRequest=globalThis.__forNowThoughtsFeatureRequest||(["thoughts","together"].includes(initialRuntimeView)?import("../features/thoughts/index.mjs"):null);
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
const KEEPSAKE_PAGE_SIZE=12,KEEPSAKE_PREFETCH_MARGIN_PX=160,BACKGROUND_RESULTS_RETRY_LIMIT=3;
const LOCAL_TEST_VIEW_SCOPES=Object.freeze({today:"today",daily:"daily",captures:"captures",books:"books",quotes:"quotes",keepsakes:"keepsakes",journals:"journals",thoughts:"thoughts",discovery:"discovery",together:"together",review:"review",statistics:"statistics","ai-cost":"statistics",commercialization:"statistics","personal-context":"personal-context",feedback:"feedback",export:"export",trash:"trash"});
const localTestScopeLoads=new Map();
const baseMetrics=BASE_CHECKIN_METRICS;
const trendLabels=Object.fromEntries(Object.entries(baseMetrics).map(([k,v])=>[k,v.label]));
const llmTiers=["lite","mid","high","ultra"];
const llmEfforts=["none","high","max"];
const defaultLlmProfiles={lite:{model:"deepseek-flash",effort:"none"},mid:{model:"deepseek-flash",effort:"high"},high:{model:"deepseek-v4-pro",effort:"high"},ultra:{model:"deepseek-v4-pro",effort:"max"}};
const defaultLlmScenarios={thoughtPrompt:"lite",thoughtDraft:"high",thoughtAnswer:"ultra",followUpAnswer:"ultra",chat:"high",diaryLead:"lite",diaryStructure:"mid",diaryTopic:"high",diaryReflection:"ultra",annotationShenji:"high",analysis:"ultra",bookRecognition:"mid",healthRecognition:"mid",contentImageUnderstanding:"mid",capturePolish:"mid"};
const defaultSceneEfforts={...Object.fromEntries(Object.entries(defaultLlmScenarios).map(([scene,tier])=>[scene,defaultLlmProfiles[tier].effort])),onboardingClaimExtraction:"high"};
const ownerCapabilities=[...new Set([...Object.values(ownerViewCapabilities),"local-testing","ai-configuration","account-roles"])];
const responseStyleOptions=[["concise","简短"],["standard","标准"],["deep","深入"],["structured","结构化"],["exploratory","开放探索"]];
const responseStyleScenes=["thoughtDraft","thoughtAnswer","followUpAnswer","chat","diaryReflection","annotationShenji","analysis"];
let pageRouter,switchView,restoreView;
let runtimeApplication=null,runtimeFeatureRegistry=null,runtimeStatePort=null,applicationLifecycleReady=false;
let backgroundResultsController=null,backgroundResultsLoadErrorReported=false,backgroundResultsRetryAttempts=0;
let healthFeatureController=null;
const checkinsFeatureControllers=new Set();
const thoughtsFeatureControllers=new Set();
let currentLocalDate=localDateKey();
let llmSettings={provider:"deepseek",profiles:structuredClone(defaultLlmProfiles),scenarios:{...defaultLlmScenarios},sceneEfforts:{...defaultSceneEfforts},automaticAnswers:{thoughtAnswer:false},speech:{defaultVoice:"",generationRate:-10},hasApiKey:false,keyHint:""};
let activeDate=currentLocalDate,activeDailyType="sleep",quoteTimer,quoteScrollFrame=0,quoteSkyIndex=0,answerDraft="",answerReasoningDraft="",toastTimer,notificationTimer,draftTags=[],captureDraftTags=[],answerTaskSerial=0,activeAnswerTaskId=0,pendingBookImages={cover:null,recognition:null},bookPreviewUrls={cover:"",recognition:""},bookImagePasteTarget="recognition",editingBookId="",activeBookId="",bookCreatorOpen=false,captureComposerOpen=false,journalDraftRestored=false,pendingBookNoteId="",activeBookFeatureNoteId="",bookDetailCondensed=false,activeKeepsakeId="",activeKeepsakeView="presentation",activeKeepsakeOriginalPath="",currentUser=null,statisticsData=null,statisticsRequestSerial=0,aiCostPlan=null,aiCostStatistics=null,aiBudgetStatus=null,aiBudgetEtag="",aiCostRequestSerial=0,architectureSurface=null,architectureStage=0,architectureTerm="",architectureRequestSerial=0,commercializationSurface=null,commercialMode="",commercialRequestSerial=0,commercialPreviewTimer=0,trashItems=[],notificationUnreadCount=0,chainDraftVersion=0,bookParseSerial=0,localTestConfig=null,localTestStatusOverride="",onboardingSchema=null,onboardingMode="quick",onboardingDraftAnswers={},onboardingHydrated=false,personalContext=null,personalContextRequestSerial=0,governanceUrl="",authOperationSerial=0,authBusy=false,resetRouteAfterAuthentication=false,appVersion="0.5.7",releaseVersion="0.5.7",featureFlags={incrementalSync:true},syncController=null,syncHealth={status:"idle",pending:0,conflicts:0,failed:0,oldestAgeMs:0,enqueueToAckP95Ms:0,lastPullMs:0,lastError:""};
let notificationsLoadState="idle",personalContextLoadState="idle",accountUsersLoadState="idle",accountUsers=[],accountUsersRequestSerial=0,routeDataReady=false,routeDataRequestSerial=0,routeLoadFailureKey="",loadedRouteKey="",fullRouteStateLoaded=false,renderedRouteView="",analysisRequestSerial=0;
let captureEditorTrigger=null,suspendedCaptureCreateDraft=null,captureEditorSerial=0;
const feedSearchQueries={captures:"",journals:"",books:"",keepsakes:"",quotes:""};
const quoteTagPickerConfig=Object.freeze({
  quote:{input:"#quote-tags",selected:"#quote-selected-tags",options:"#quote-tag-options",toggle:"#quote-tag-toggle",status:"#quote-tag-status"},
  selectionQuote:{input:"#selection-quote-tags",selected:"#selection-quote-selected-tags",options:"#selection-quote-tag-options",toggle:"#selection-quote-tag-toggle",status:"#selection-quote-tag-status"}
});
let quoteTagStates={
  quote:createTagMultiSelectState(),
  selectionQuote:createTagMultiSelectState()
};
let keepsakeDraftTags=[];
const expandedLongContentKeys=new Set();
let homeMemoryKeys=[],homeMemoryByKey=new Map(),homeKeepsakeId="",homeEditorTrigger=null,voicePreviewAudio=null,voicePreviewPending=false,voicePreviewPlaying=false,voicePreviewVoice="";
const keepsakeEditor={file:null,sourceDataUrl:"",sourceImage:null,sourceCanvas:null,maskCanvas:null,autoBase:null,history:[],mode:"keep",drawing:false,lastPoint:null,source:"manual",originalPath:"",cutoutPath:"",mediaDirty:false,renderFrame:0,segmentSerial:0,understandingSerial:0};
const keepsakeBatch={items:[],activeIndex:0,loading:false};
let keepsakeBatchPreviewUrls=[],keepsakeBatchPersistTimer=0,keepsakeDerivativeRefreshTimer=0;
let keepsakeVisibleCount=KEEPSAKE_PAGE_SIZE,keepsakePaginationOwner="",keepsakeLoadObserver=null;
const persistentContentImageKeys=new Set(["capture","thoughtRoot","thoughtBlock","comment"]);
const captureAudioDraft={blob:null,preview:"",path:"",mimeType:"",bytes:0,durationMs:0,uploadRequestId:"",uploadedPath:"",lastError:null,recorder:null,stream:null,chunks:[],startedAt:0,pausedAt:0,pausedTotal:0,timer:0,serial:0,stopPromise:null};
const imageViewer={paths:[],index:0,objectUrl:"",requestSerial:0,trigger:null};
const quoteScrollStates=new WeakMap();
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const ownerSurfaceVault=document.createDocumentFragment();
let ownerSurfaceEntries=null,currentCapabilities=new Set();
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
  data:{getSnapshot:()=>state,getAccountId:()=>currentUser?.id||"",replaceSnapshot:replaceState,request,refresh:(domains,options)=>refreshState(domains,options)},
  navigation:{openThoughtDetail,switchView},
  annotations:{
    openTarget:async(target,isCurrent)=>{const controller=await ensureAnnotationsController();if(!isCurrent())return false;controller.openPanel(commentRootKey(target.resourceType,target.targetId),target.annotationId);return true},
    refreshTarget:target=>{const controller=annotationsController,annotation=controller?.findTaskAnnotation(target);if(annotation&&controller.isActiveRoot(commentRootKey(target.resourceType,target.targetId)))controller.refreshAnnotation(annotation);return true}
  },
  view:{renderCaptures,patchThoughtTarget:patchActiveThoughtTarget,scheduleAnnotationLayout:scheduleAnnotationLineCounts,showToast},
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
function captureFormDrafts(root){
  const active=document.activeElement;
  return[...root.querySelectorAll("form")].map((form,index)=>({
    key:formIdentity(form,index),hidden:form.hidden,requestId:form.dataset.requestId||"",
    fields:[...form.querySelectorAll("input,textarea,select")].map((field,fieldIndex)=>({
      key:formFieldIdentity(field,fieldIndex),
      value:field.value,checked:field instanceof HTMLInputElement&&["checkbox","radio"].includes(field.type)?field.checked:null,focused:field===active,
      selectionStart:typeof field.selectionStart==="number"?field.selectionStart:null,
      selectionEnd:typeof field.selectionEnd==="number"?field.selectionEnd:null
    }))
  }))
}
function restoreFormDrafts(root,drafts){
  const forms=[...root.querySelectorAll("form")];
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
const durableDraftForms=["chain-form","checkin-form","capture-form"];
const durableDraftKey=()=>currentUser?.id?`cike:session-drafts:${currentUser.id}`:"";
function saveDurableDrafts(){
  const key=durableDraftKey();if(!key)return;
  const editingCapture=Boolean($("#capture-id")?.value),forms=durableDraftForms.map(id=>document.getElementById(id)).filter(Boolean),drafts=captureFormDrafts({querySelectorAll:()=>forms});
  let previous=null;
  if(editingCapture){
    try{previous=JSON.parse(sessionStorage.getItem(key)||"null")}catch{}
    const captureKey=`form:${durableDraftForms.indexOf("capture-form")}`,savedCapture=previous?.forms?.find(item=>item.key===captureKey);
    const index=drafts.findIndex(item=>item.key===captureKey);
    if(savedCapture&&index>=0)drafts[index]=savedCapture;
    else if(!savedCapture&&index>=0)drafts.splice(index,1)
  }
  const payload={forms:drafts,draftTags,captureDraftTags:editingCapture?(previous?.captureDraftTags||[]):captureDraftTags};
  try{sessionStorage.setItem(key,JSON.stringify(payload))}catch{}
}
function restoreDurableDrafts(){
  const key=durableDraftKey();if(!key)return;
  try{
    const payload=JSON.parse(sessionStorage.getItem(key)||"null");if(!payload)return;
    restoreFormDrafts({querySelectorAll:()=>durableDraftForms.map(id=>document.getElementById(id)).filter(Boolean)},payload.forms||[]);
    draftTags=Array.isArray(payload.draftTags)?payload.draftTags:[];captureDraftTags=Array.isArray(payload.captureDraftTags)?payload.captureDraftTags:[];
    renderTagComposer();renderCaptureTagComposer()
  }catch{}
}
function clearDurableDraft(formId=""){
  const key=durableDraftKey();if(!key)return;
  if(!formId){sessionStorage.removeItem(key);return}
  saveDurableDrafts();
  try{const payload=JSON.parse(sessionStorage.getItem(key)||"null");if(!payload)return;payload.forms=(payload.forms||[]).filter(item=>item.key!==`form:${durableDraftForms.indexOf(formId)}`);sessionStorage.setItem(key,JSON.stringify(payload))}catch{}
}
const splitTags=v=>String(v||"").split(/[,，#\s]+/).map(x=>x.trim()).filter(Boolean);
const bookReadingRange=book=>book.readingStartedOn?`${formatDateKey(book.readingStartedOn)} — ${book.readingFinishedOn?formatDateKey(book.readingFinishedOn):"至今"}`:"阅读日期未记录";
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
const audioDataUrl=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("无法读取音频，请重新录制或导入"));reader.readAsDataURL(blob)});
const formatAudioDuration=value=>{const seconds=Math.max(0,Math.round(Number(value)||0)/1000),minutes=Math.floor(seconds/60);return`${minutes}:${String(Math.floor(seconds%60)).padStart(2,"0")}`};
const audioDraftKey="capture-audio";
let captureAudioStartPending=false;
function captureAudioInputError(error){
  return presentError(error,{
    operation:"添加录音",
    object:"这段录音",
    retained:"当前捕念正文和已有录音仍保留在页面",
    publicValidation:error?.publicValidation===true
  }).message
}
function captureRecordingError(error){
  const name=String(error?.name||"");
  if(["NotAllowedError","SecurityError"].includes(name))return"麦克风权限未开启。当前捕念正文和原有录音没有变化。请开启权限，或改为上传音频。";
  if(name==="NotFoundError")return"没有找到可用的麦克风。当前捕念正文和原有录音没有变化。请连接设备，或改为上传音频。";
  return presentError(error,{
    operation:"开始录音",
    object:"这次录音",
    retained:"当前捕念正文和原有录音没有变化"
  }).message
}
function renderCaptureAudioDraft(){
  const preview=$("#capture-audio-preview"),player=$("#capture-audio-player"),meta=$("#capture-audio-meta"),status=$("#capture-audio-status"),record=$("#capture-audio-record"),pause=$("#capture-audio-pause"),stop=$("#capture-audio-stop"),remove=$("#capture-audio-remove"),file=$("#capture-audio-file"),recorder=$("#capture-audio-recorder");
  if(!preview||!player)return;
  const recorderState=captureAudioDraft.recorder?.state||"",active=["recording","paused"].includes(recorderState),paused=recorderState==="paused",source=captureAudioDraft.preview||(captureAudioDraft.path?appUrl(captureAudioDraft.path):"")||(captureAudioDraft.uploadedPath?appUrl(captureAudioDraft.uploadedPath):"");
  if((active||captureAudioStartPending)&&recorder)recorder.open=true;record.hidden=active;record.disabled=captureAudioStartPending;pause.hidden=!active;pause.textContent=paused?"▶":"Ⅱ";pause.title=paused?"继续录音":"暂停录音";pause.setAttribute("aria-label",pause.title);stop.hidden=!active;file.disabled=active||captureAudioStartPending;remove.hidden=!active&&!source;remove.disabled=captureAudioStartPending;remove.title=active?"取消录音":"移除语音";remove.setAttribute("aria-label",remove.title);
  preview.hidden=!source;if(source&&player.src!==new URL(source,location.href).href)player.src=source;if(!source){player.pause();player.removeAttribute("src");player.load()}
  meta.textContent=source?`${formatAudioDuration(captureAudioDraft.durationMs)} · ${formatBytes(captureAudioDraft.bytes)}`:"";
  const elapsed=Date.now()-captureAudioDraft.startedAt-captureAudioDraft.pausedTotal-(paused?Date.now()-captureAudioDraft.pausedAt:0);
  if(captureAudioStartPending)status.textContent="正在请求麦克风权限…";
  else if(active)status.textContent=`${paused?"录音已暂停":"正在录音"} ${formatAudioDuration(elapsed)} / 10:00`;
  else if(captureAudioDraft.lastError)status.textContent=captureAudioDraft.lastError;
  else if(source)status.textContent=state.speech?.configured?"录音已保留；提交后可在后台转成文字。":"录音已保留；暂时不能转成文字。";
  else status.textContent=typeof MediaRecorder==="undefined"?"当前浏览器不支持直接录音，可导入音频文件。":""
}
async function persistCaptureAudioDraft(){
  if(!currentUser?.id||$("#capture-id")?.value)return;
  const hasAudio=captureAudioDraft.blob||captureAudioDraft.path||captureAudioDraft.uploadedPath;
  if(!hasAudio){await mediaDraftStore.delete(currentUser.id,audioDraftKey);return}
  await mediaDraftStore.put({
    owner:currentUser.id,id:audioDraftKey,updatedAt:new Date().toISOString(),
    audio:captureAudioDraft.path?{
      path:captureAudioDraft.path,mimeType:captureAudioDraft.mimeType,bytes:captureAudioDraft.bytes,durationMs:captureAudioDraft.durationMs
    }:{
      blob:captureAudioDraft.blob,mimeType:captureAudioDraft.mimeType,bytes:captureAudioDraft.bytes,durationMs:captureAudioDraft.durationMs,
      uploadRequestId:captureAudioDraft.uploadRequestId,uploadedPath:captureAudioDraft.uploadedPath,lastError:captureAudioDraft.lastError
    }
  })
}
async function discardCaptureAudioUpload(attachmentPath=captureAudioDraft.uploadedPath,uploadRequestId=captureAudioDraft.uploadRequestId){
  if(!attachmentPath||!uploadRequestId)return false;
  try{
    const result=await request("/api/audio/discard",{method:"POST",body:JSON.stringify({attachmentPath,uploadRequestId})});
    return result.discarded?.includes(attachmentPath)
  }catch{return false}
}
function stopCaptureAudioTracks(){captureAudioDraft.stream?.getTracks?.().forEach(track=>track.stop());captureAudioDraft.stream=null}
function clearCaptureAudioDraft({forget=true,preserveStored=false}={}){
  captureAudioDraft.serial+=1;clearInterval(captureAudioDraft.timer);captureAudioDraft.timer=0;
  if(["recording","paused"].includes(captureAudioDraft.recorder?.state))captureAudioDraft.recorder.stop();
  stopCaptureAudioTracks();if(captureAudioDraft.preview)URL.revokeObjectURL(captureAudioDraft.preview);
  const stalePath=forget?captureAudioDraft.uploadedPath:"",staleRequestId=captureAudioDraft.uploadRequestId;
  const resolveStop=captureAudioDraft.resolveStop;
  Object.assign(captureAudioDraft,{blob:null,preview:"",path:"",mimeType:"",bytes:0,durationMs:0,uploadRequestId:"",uploadedPath:"",lastError:null,recorder:null,chunks:[],startedAt:0,pausedAt:0,pausedTotal:0,stopPromise:null,resolveStop:null});
  resolveStop?.();
  const input=$("#capture-audio-file");if(input)input.value="";renderCaptureAudioDraft();
  if(forget)void Promise.all([
    stalePath?discardCaptureAudioUpload(stalePath,staleRequestId):Promise.resolve(),
    currentUser?.id&&!preserveStored?mediaDraftStore.delete(currentUser.id,audioDraftKey):Promise.resolve()
  ]).catch(()=>{})
}
function setExistingCaptureAudio(audio,{preserveStored=false}={}){
  clearCaptureAudioDraft({preserveStored});
  if(audio)Object.assign(captureAudioDraft,{path:audio.attachmentPath||"",mimeType:audio.mimeType||"",bytes:Number(audio.bytes)||0,durationMs:Number(audio.durationMs)||0});
  renderCaptureAudioDraft()
}
async function setCaptureAudioBlob(blob,durationMs){
  const audio=runPublicValidation(()=>validatedAudioBlob(blob,durationMs)),stalePath=captureAudioDraft.uploadedPath,staleRequestId=captureAudioDraft.uploadRequestId;
  if(captureAudioDraft.preview)URL.revokeObjectURL(captureAudioDraft.preview);
  Object.assign(captureAudioDraft,{blob:audio.blob,preview:URL.createObjectURL(audio.blob),path:"",mimeType:audio.mimeType,bytes:audio.bytes,durationMs:audio.durationMs,uploadRequestId:"",uploadedPath:"",lastError:null,recorder:null,chunks:[]});
  renderCaptureAudioDraft();await persistCaptureAudioDraft();
  if(stalePath)await discardCaptureAudioUpload(stalePath,staleRequestId)
}
const importedAudioDuration=blob=>new Promise((resolve,reject)=>{
  const source=URL.createObjectURL(blob),audio=document.createElement("audio");
  const done=value=>{URL.revokeObjectURL(source);audio.removeAttribute("src");audio.load();value instanceof Error?reject(value):resolve(value)};
  audio.preload="metadata";audio.addEventListener("loadedmetadata",()=>Number.isFinite(audio.duration)&&audio.duration>0?done(Math.round(audio.duration*1000)):done(new Error("无法读取音频时长")),{once:true});audio.addEventListener("error",()=>done(new Error("无法读取音频时长")),{once:true});audio.src=source
});
async function restoreCaptureAudioDraft(owner){
  if(!owner||captureAudioDraft.blob||captureAudioDraft.path)return;
  const stored=await mediaDraftStore.get(owner,audioDraftKey),audio=stored?.audio;if(!audio)return;
  if(audio.path)Object.assign(captureAudioDraft,{path:audio.path,mimeType:audio.mimeType||"",bytes:Number(audio.bytes)||0,durationMs:Number(audio.durationMs)||0});
  else if(audio.blob){
    const normalized=validatedAudioBlob(audio.blob,audio.durationMs),lastError=audio.lastError?"上次处理录音未完成。原音草稿仍保存在本机，请重试。":null;
    Object.assign(captureAudioDraft,{blob:normalized.blob,preview:URL.createObjectURL(normalized.blob),mimeType:normalized.mimeType,bytes:normalized.bytes,durationMs:normalized.durationMs,uploadRequestId:audio.uploadRequestId||"",uploadedPath:audio.uploadedPath||"",lastError})
  }
  renderCaptureAudioDraft();$("#capture-audio-status").textContent=`已恢复 ${formatAudioDuration(captureAudioDraft.durationMs)} 的待提交语音。`
}
async function startCaptureAudioRecording(){
  if(typeof MediaRecorder==="undefined"||!navigator.mediaDevices?.getUserMedia)throw new Error("当前浏览器不支持直接录音，可改为导入音频");
  if(captureAudioStartPending||["recording","paused"].includes(captureAudioDraft.recorder?.state))return false;
  if((captureAudioDraft.blob||captureAudioDraft.path||captureAudioDraft.uploadedPath)&&!confirm("用新录音替换当前语音？"))return false;
  $("#capture-audio-recorder").open=true;
  const owner=currentUser?.id,serial=++captureAudioDraft.serial;
  let stream=null;
  captureAudioStartPending=true;captureAudioDraft.lastError=null;renderCaptureAudioDraft();
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:true});
    if(owner!==currentUser?.id||serial!==captureAudioDraft.serial){stream.getTracks().forEach(track=>track.stop());return false}
    const mimeType=preferredRecorderMime(),recorder=mimeType?new MediaRecorder(stream,{mimeType}):new MediaRecorder(stream);
    let resolveStop;
    const stopPromise=new Promise(resolve=>{resolveStop=resolve});
    captureAudioDraft.stream=stream;captureAudioDraft.recorder=recorder;captureAudioDraft.chunks=[];captureAudioDraft.startedAt=Date.now();captureAudioDraft.pausedAt=0;captureAudioDraft.pausedTotal=0;captureAudioDraft.lastError=null;captureAudioDraft.stopPromise=stopPromise;captureAudioDraft.resolveStop=resolveStop;
    recorder.addEventListener("dataavailable",event=>{if(serial===captureAudioDraft.serial&&event.data?.size)captureAudioDraft.chunks.push(event.data)});
    recorder.addEventListener("stop",async()=>{
      try{
        clearInterval(captureAudioDraft.timer);captureAudioDraft.timer=0;stopCaptureAudioTracks();
        if(serial!==captureAudioDraft.serial)return;
        const durationMs=Math.min(AUDIO_MAX_DURATION_MS,Date.now()-captureAudioDraft.startedAt-captureAudioDraft.pausedTotal),blob=new Blob(captureAudioDraft.chunks,{type:recorder.mimeType||mimeType});
        captureAudioDraft.recorder=null;
        try{await setCaptureAudioBlob(blob,durationMs);$("#capture-audio-status").textContent="录音已保存在本机，提交后同步。"}
        catch(error){captureAudioDraft.lastError=captureAudioInputError(error);renderCaptureAudioDraft()}
      }finally{
        if(captureAudioDraft.stopPromise===stopPromise){captureAudioDraft.stopPromise=null;captureAudioDraft.resolveStop=null}
        resolveStop()
      }
    },{once:true});
    recorder.start(1000);renderCaptureAudioDraft();
    captureAudioDraft.timer=setInterval(()=>{const paused=captureAudioDraft.recorder?.state==="paused",elapsed=Date.now()-captureAudioDraft.startedAt-captureAudioDraft.pausedTotal-(paused?Date.now()-captureAudioDraft.pausedAt:0);if(elapsed>=AUDIO_MAX_DURATION_MS)stopCaptureAudioRecording();else renderCaptureAudioDraft()},250);
    return true
  }catch(error){
    if(stream){
      if(captureAudioDraft.stream===stream){captureAudioDraft.recorder=null;stopCaptureAudioTracks()}
      else stream.getTracks().forEach(track=>track.stop())
    }
    throw error
  }finally{
    captureAudioStartPending=false;renderCaptureAudioDraft()
  }
}
async function requestCaptureAudioRecording(){
  try{return await startCaptureAudioRecording()}
  catch(error){captureAudioDraft.lastError=captureRecordingError(error);renderCaptureAudioDraft();return false}
}
function toggleCaptureAudioPause(){
  const recorder=captureAudioDraft.recorder;if(!recorder)return;
  if(recorder.state==="recording"){recorder.pause();captureAudioDraft.pausedAt=Date.now()}
  else if(recorder.state==="paused"){captureAudioDraft.pausedTotal+=Date.now()-captureAudioDraft.pausedAt;captureAudioDraft.pausedAt=0;recorder.resume()}
  renderCaptureAudioDraft()
}
function stopCaptureAudioRecording(){
  const recorder=captureAudioDraft.recorder;
  if(recorder?.state==="paused"){captureAudioDraft.pausedTotal+=Date.now()-captureAudioDraft.pausedAt;captureAudioDraft.pausedAt=0}
  if(recorder&&["recording","paused"].includes(recorder.state))recorder.stop();
  return captureAudioDraft.stopPromise||Promise.resolve()
}
function cancelCaptureAudioRecording(){
  const recorder=captureAudioDraft.recorder;if(!recorder||!["recording","paused"].includes(recorder.state))return clearCaptureAudioDraft();
  captureAudioDraft.serial+=1;clearInterval(captureAudioDraft.timer);captureAudioDraft.timer=0;recorder.stop();stopCaptureAudioTracks();
  const resolveStop=captureAudioDraft.resolveStop;
  Object.assign(captureAudioDraft,{recorder:null,chunks:[],startedAt:0,pausedAt:0,pausedTotal:0,lastError:null,stopPromise:null,resolveStop:null});resolveStop?.();renderCaptureAudioDraft()
}
async function captureAudioForSubmission(){
  if(captureAudioDraft.path)return{attachmentPath:captureAudioDraft.path,mimeType:captureAudioDraft.mimeType,bytes:captureAudioDraft.bytes,durationMs:captureAudioDraft.durationMs};
  if(!captureAudioDraft.blob)return null;
  const valid=runPublicValidation(()=>validatedAudioBlob(captureAudioDraft.blob,captureAudioDraft.durationMs));
  if(captureAudioDraft.uploadedPath)return{attachmentPath:captureAudioDraft.uploadedPath,mimeType:captureAudioDraft.mimeType,bytes:captureAudioDraft.bytes,durationMs:captureAudioDraft.durationMs};
  captureAudioDraft.uploadRequestId||=crypto.randomUUID();captureAudioDraft.lastError=null;await persistCaptureAudioDraft();
  try{
    const result=await uploadOriginalAudio({request,audio:await audioDataUrl(valid.blob),durationMs:valid.durationMs,idempotencyKey:captureAudioDraft.uploadRequestId});
    Object.assign(captureAudioDraft,{uploadedPath:result.attachmentPath,mimeType:result.mimeType,bytes:result.bytes,durationMs:result.durationMs,lastError:null});await persistCaptureAudioDraft();renderCaptureAudioDraft();return result
  }catch(error){
    captureAudioDraft.lastError=presentError(error,{
      operation:"上传捕念语音",
      object:"这段语音",
      phase:"捕念语音上传",
      retained:"原音草稿仍保存在本机"
    }).message;
    await persistCaptureAudioDraft();renderCaptureAudioDraft();throw error
  }
}
async function rollbackCaptureAudioUpload(attachmentPath){
  if(!attachmentPath||attachmentPath!==captureAudioDraft.uploadedPath)return;
  if(await discardCaptureAudioUpload()){
    captureAudioDraft.uploadedPath="";captureAudioDraft.uploadRequestId="";await persistCaptureAudioDraft();renderCaptureAudioDraft()
  }
}
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
const bookImageUi={
  cover:{input:"#book-cover-image",preview:"#book-cover-preview",box:"#book-cover-upload-box",title:"#book-cover-upload-title",hint:"#book-cover-upload-hint",remove:"#book-cover-remove",emptyTitle:"选择、粘贴或拖入封面",emptyHint:"PNG / JPEG / WebP · 不超过 8 MB"},
  recognition:{input:"#book-recognition-image",preview:"#book-recognition-preview",box:"#book-recognition-upload-box",title:"#book-recognition-upload-title",hint:"#book-recognition-upload-hint",remove:"#book-recognition-remove",emptyTitle:"选择、粘贴或拖入识别图",emptyHint:"PNG / JPEG / WebP · 不超过 8 MB"}
};
function updateBookImageSwapButton(){
  const button=$("#book-image-swap");
  if(button)button.disabled=$("#book-cover-preview").hidden||$("#book-recognition-preview").hidden;
}
function resetBookImage(role,{existingPath=""}={}){
  bookParseSerial+=1;
  const ui=bookImageUi[role];
  if(bookPreviewUrls[role])URL.revokeObjectURL(bookPreviewUrls[role]);
  bookPreviewUrls[role]="";pendingBookImages[role]=null;$(ui.input).value="";$(ui.box).classList.remove("has-image","dragging");
  const preview=$(ui.preview);
  if(existingPath){preview.src=existingPath;preview.hidden=false;$(ui.title).textContent="当前封面";$(ui.hint).textContent="选择新图片即可替换";$(ui.box).classList.add("has-image");$(ui.remove).hidden=false}
  else{preview.hidden=true;preview.removeAttribute("src");$(ui.title).textContent=ui.emptyTitle;$(ui.hint).textContent=ui.emptyHint;$(ui.remove).hidden=true}
  if(role==="recognition")$("#parse-book").disabled=true;
  updateBookImageSwapButton();
}
function setBookImage(role,file,source="已选择"){
  bookParseSerial+=1;
  const ui=bookImageUi[role],status=$("#book-parse-status");try{[file]=validatedImageFiles([file])}catch(error){status.textContent=error.message;return false}
  if(bookPreviewUrls[role])URL.revokeObjectURL(bookPreviewUrls[role]);
  pendingBookImages[role]=file;bookPreviewUrls[role]=URL.createObjectURL(file);$(ui.preview).src=bookPreviewUrls[role];$(ui.preview).hidden=false;$(ui.title).textContent=file.name||"剪贴板图片";$(ui.hint).textContent=`${source} · ${formatBytes(file.size)} · 点击可重新选择`;$(ui.box).classList.add("has-image");$(ui.remove).hidden=false;
  if(role==="recognition"){$("#parse-book").disabled=false;status.textContent="识别图已就绪，可以回填书目信息。"}else status.textContent="新封面已就绪，将在保存书目时上传。";
  updateBookImageSwapButton();
  return true;
}
async function currentBookCoverFile(){
  if(pendingBookImages.cover)return pendingBookImages.cover;
  const imagePath=$("#book-image-path").value;
  if(!imagePath)return null;
  const blob=await apiClient.readBlob(imagePath),name=decodeURIComponent(imagePath.split("/").pop()||"current-cover");
  return new File([blob],name,{type:blob.type||"image/jpeg"});
}
function syncBookReadingDates(){
  const start=$("#book-reading-start"),end=$("#book-reading-end");
  end.min=start.value;
  end.setCustomValidity(start.value&&end.value&&end.value<start.value?"结束日期不能早于开始日期":"");
}
function resetBookForm(){
  editingBookId="";delete $("#book-form").dataset.requestId;$("#book-form").reset();$("#book-reading-start").value=localDateKey();syncBookReadingDates();$("#book-image-path").value="";resetBookImage("cover");resetBookImage("recognition");$("#book-form-title").textContent="创建书目";$("#book-submit").textContent="创建书目";$("#book-edit-cancel").hidden=true;$("#book-parse-status").textContent="";
}
function openBookEditor(book){
  editingBookId=book.id;activeBookId="";activeBookFeatureNoteId="";bookDetailCondensed=false;bookCreatorOpen=true;
  for(const key of["title","author","publisher","isbn","description"])$(`#book-${key}`).value=book[key]||"";
  $("#book-reading-start").value=book.readingStartedOn||"";
  $("#book-reading-end").value=book.readingFinishedOn||"";
  syncBookReadingDates();
  $("#book-image-path").value=book.imagePath||"";resetBookImage("cover",{existingPath:book.imagePath||""});resetBookImage("recognition");
  $("#book-form-title").textContent="编辑书目";$("#book-submit").textContent="保存修改";$("#book-edit-cancel").hidden=false;$("#book-parse-status").textContent="可修改资料或替换封面。";renderBooks();
  requestAnimationFrame(()=>{$("#book-create-panel").scrollIntoView({behavior:"smooth",block:"start"});$("#book-title").focus()});
}

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
    book.notes[index]=snapshot.value;renderBooks();return true
  }
  if(snapshot.kind==="book.note.delete"){
    const book=(state.books||[]).find(item=>item.id===snapshot.bookId);if(!book||book.notes?.some(item=>item.id===snapshot.value.id))return false;
    book.notes||=[];book.notes.splice(Math.min(snapshot.index,book.notes.length),0,snapshot.value);renderBooks();return true
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
    delete note._sync;renderBooks();return true
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
    renderCaptures();return true
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
    pendingBookNoteId=projection.temporaryId;renderBooks();return true
  }
  if(projection.kind==="book.note.delete"){
    const book=(state.books||[]).find(item=>item.id===projection.bookId);
    if(!book)return false;
    const previousLength=(book.notes||[]).length;
    book.notes=(book.notes||[]).filter(item=>item.id!==projection.id);
    if(book.notes.length===previousLength)return false;
    renderBooks();return true
  }
  if(projection.kind==="book.note.update"){
    const book=(state.books||[]).find(item=>item.id===projection.bookId),note=book?.notes?.find(item=>item.id===projection.id);
    if(!note)return false;
    Object.assign(note,projection.payload,{_sync:sync});
    renderBooks();return true
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
  if(domains.has("trashCount")&&!$("#view-trash")?.hidden)void loadTrash();
  const rendered=new Set([...domains].filter(domain=>!["actions","habits","habitCheckins","trashCount"].includes(domain)));
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
  renderMine()
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
const trashTypeLabels={checkin:"状态",dailyRecord:"健康日录",capture:"捕念",captureAudio:"捕念语音",journal:"日记",journalReflection:"日记回望",thoughtChain:"思绪",thoughtBlock:"思绪内容",thoughtRemark:"思绪备注",thoughtFollowUp:"追问",annotation:"批注",annotationDrift:"漂流批注",chat:"对话",book:"书目",bookNote:"读书记录",keepsake:"小物",quote:"善言",experiment:"实验",analysis:"复盘",customMetric:"自定义指标",action:"行动",habit:"习惯",habitCheckin:"习惯打卡"};
const trashDetailLabels={content:"内容",question:"问题",idea:"初步想法",answer:"我的结论",title:"标题",message:"内容",text:"内容",note:"备注",description:"说明",summary:"摘要",source:"来源",author:"作者",publisher:"出版社",category:"类别",hypothesis:"假设",factor:"观察因素",outcome:"观察结果",duration:"周期",feeling:"感受",quote:"原文",tags:"标签",occurredOn:"发生日期",disposition:"处理状态",type:"内容类型",origin:"记录方式",authorType:"内容来源"};
const trashDetailValues={disposition:{kept:"已保留",discarded:"已舍弃"},type:{question:"问题",idea:"初步想法",record:"经历",answer:"回答"},origin:{manual:"手动记录",model:"AI 生成"},authorType:{user:"本人",ai:"AI"}};
function trashPayload(entry){if(entry.type==="thoughtChain"){const records=entry.payload?.items||[];return records.map(record=>record.item).filter(Boolean)}return[entry.payload]}
function trashTitle(entry){
  const items=trashPayload(entry),item=items.find(value=>value.type==="question")||items[0]||{};
  return plainPreview(item.content||item.question||item.title||item.message||item.source||item.hypothesis||item.name||item.text||"无标题记录").slice(0,120)||"无标题记录"
}
function trashDetail(entry){
  const ignored=new Set(["id","clientRequestId","requestHash","originalPath","cutoutPath","imagePath","attachmentPaths"]);
  const rows=[];
  const addRow=(label,value)=>rows.push(`<div><b>${escapeHtml(label)}</b><div class="markdown-content">${renderMarkdown(value)}</div></div>`);
  const visit=(value,key="",label=trashDetailLabels[key]||"")=>{
    if(value==null||rows.length>=80)return;
    if(Array.isArray(value)){
      if(key==="tags"){const tags=value.map(item=>String(item||"").trim()).filter(Boolean);if(tags.length)addRow(label,tags.map(tag=>`#${tag}`).join(" "))}
      else value.forEach(item=>visit(item,key,label));
      return
    }
    if(typeof value==="object"){for(const[childKey,item]of Object.entries(value)){if(!ignored.has(childKey))visit(item,childKey,trashDetailLabels[childKey]||"")}return}
    const text=typeof value==="string"?value.trim():"";
    if(!label||!text||/^(?:[0-9a-f-]{24,}|\d{4}-\d{2}-\d{2}T)/i.test(text))return;
    addRow(label,trashDetailValues[key]?.[text]||text)
  };
  trashPayload(entry).forEach(item=>visit(item));
  return rows.join("")||"<p>这条记录没有可预览的文字内容。</p>"
}
function renderTrash(){
  const list=$("#trash-list"),selected=new Set($$("[data-trash-select]:checked").map(input=>input.value));
  $("#trash-retention").textContent="默认保留 30 天";
  list.innerHTML=trashItems.length?trashItems.map(entry=>`<article class="trash-entry" data-trash-id="${escapeHtml(entry.id)}"><label class="trash-select"><input type="checkbox" data-trash-select value="${escapeHtml(entry.id)}" ${selected.has(entry.id)?"checked":""}><span>选择</span></label><div class="trash-copy"><header><span>${escapeHtml(trashTypeLabels[entry.type]||entry.type)}</span><time>${formatDate(entry.deletedAt)}</time></header><h2>${escapeHtml(trashTitle(entry))}</h2><p>保留期标记至 ${escapeHtml(formatDate(entry.purgeAfter))}；永久清理始终由你确认。</p><details><summary>查看完整内容</summary><div class="trash-detail">${trashDetail(entry)}</div></details></div><button class="quiet-button" type="button" data-trash-restore="${escapeHtml(entry.id)}">恢复</button></article>`).join(""):contentState({title:"回收站是空的",body:"没有待恢复的记录。删除后的内容会在保留期内出现在这里。",action:{view:"mine",label:"返回我的"}});
  renderLatex(list);$("#trash-purge-selected").disabled=!selected.size;
}
async function loadTrash(){
  const status=$("#trash-status"),owner=currentUser?.id,session=sessionSerial;status.textContent="正在读取回收站…";
  try{const result=await request("/api/trash");if(owner!==currentUser?.id||session!==sessionSerial)return false;trashItems=result.items||[];renderTrash();status.textContent="";return true}
  catch(error){if(owner===currentUser?.id&&session===sessionSerial){status.textContent="";$("#trash-list").innerHTML=contentState({kind:"failure",title:"暂时无法读取回收站",body:"已删除的记录仍按原保留期保存。请检查网络后重试。",action:{command:"retry-trash",label:"重新读取"}})}return false}
}
function notificationUnread(snapshot=state){
  const items=snapshot.notifications||[];
  return Number(snapshot.notificationUnread??notificationUnreadCount)||items.filter(item=>!item.readAt&&["succeeded","failed","stale","cancelled"].includes(item.status)).length
}
function renderNotificationSummary(){
  const unread=notificationUnread();
  $("#notification-dot").hidden=!unread;
  renderMine();
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
function commitCaptureTags(){const input=$("#capture-tags"),values=splitTags(input.value);for(const value of values)if(!captureDraftTags.includes(value))captureDraftTags.push(value);input.value="";renderCaptureTagComposer()}
function renderCaptureTagComposer(){const list=$("#capture-tag-list");if(!list)return;list.innerHTML=captureDraftTags.map(tag=>`<span class="tag-chip">#${escapeHtml(tag)}<button type="button" data-remove-capture-tag="${escapeHtml(tag)}" aria-label="移除关键词 ${escapeHtml(tag)}">×</button></span>`).join("");const known=[...new Set([...(state.captures||[]),...(state.thoughts||[])].flatMap(item=>item.tags||[]))].filter(tag=>!captureDraftTags.includes(tag));$("#capture-tag-suggestions").innerHTML=known.map(tag=>`<option value="${escapeHtml(tag)}"></option>`).join("")}
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
function feedSearchText(...values){
  const parts=[];
  const append=value=>{
    if(value==null)return;
    if(Array.isArray(value)){value.forEach(append);return}
    if(typeof value==="object"){Object.values(value).forEach(append);return}
    parts.push(String(value))
  };
  values.forEach(append);
  return normalizedFeedSearch(parts.join(" "))
}
function matchesFeedSearch(scope,...values){
  const query=normalizedFeedSearch(feedSearchQueries[scope]);
  if(!query)return true;
  return query.split(" ").every(term=>feedSearchText(...values).includes(term))
}
function feedCountLabel(scope,visible,total,unit){
  return normalizedFeedSearch(feedSearchQueries[scope])
    ?`${visible} / ${total} ${unit}`
    :`${total} ${unit}`
}
function feedSearchEmpty(label){return contentState({title:`没有匹配的${label}`,body:"换一个关键词，原有记录不会受到影响。"})}
function metricConfig(){return createCheckinMetricConfig(state.customMetrics)}
const metricValue=checkinMetricValue;
function metricReference(key,custom){const eligible=state.checkins.filter(x=>x.occurredOn<=activeDate).sort((a,b)=>b.occurredOn.localeCompare(a.occurredOn)||eventTimestamp(b).localeCompare(eventTimestamp(a)));const previous=eligible.map(x=>metricValue(x,key,custom)).find(x=>Number.isFinite(Number(x)));const history=eligible.slice(0,30).map(x=>Number(metricValue(x,key,custom))).filter(Number.isFinite);return{previous:previous==null?null:Number(previous),average:avg(history)}}
function metricMarker(kind,value,label){if(!Number.isFinite(value))return"";const position=Math.max(0,Math.min(100,(value-1)*25)),thumbOffset=11-position*.22,left=`calc(${position}% + ${thumbOffset.toFixed(3)}px)`;return `<span class="metric-history-marker ${kind}" style="left:${left}" data-position="${position}" role="img" aria-label="${label} ${value.toFixed(2)}" title="${label} ${value.toFixed(2)}"></span>`}
function sliderTemplate(key,cfg){const ref=metricReference(key,cfg.custom),value=ref.previous??(ref.average==null?3:Math.round(ref.average));return `<div class="metric unconfirmed"><div class="metric-top"><span class="metric-label">${escapeHtml(cfg.label)}</span><span class="anchor" id="${key}-anchor">待确认 · ${escapeHtml(cfg.anchors[value-1])}</span><button class="note-toggle" type="button" data-note="${key}" aria-expanded="false">＋备注</button></div><div class="metric-scale">${metricMarker("previous",ref.previous,"上一次")}${metricMarker("average",ref.average,"近30次平均")}<input type="range" id="metric-${key}" data-metric="${key}" data-custom="${cfg.custom?"1":"0"}" data-confirmed="false" min="1" max="5" value="${value}" step="1" aria-label="${escapeHtml(cfg.label)} 1到5，必须确认"></div><div class="range-labels"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div><input class="note-field" id="${key}-note" placeholder="可选：补充一句话" maxlength="800"></div>`}
function renderSliders(){const cfg=metricConfig();$("#sliders").innerHTML=`<div class="metric-history-legend" aria-label="历史参照图例"><span><i class="previous"></i>上一次</span><span><i class="average"></i>近30次平均</span></div>${Object.entries(cfg).map(([k,v])=>sliderTemplate(k,v)).join("")}`;$$('[data-metric]').forEach(input=>{const update=(confirmed=false)=>{if(confirmed){input.dataset.confirmed="true";input.closest(".metric").classList.remove("unconfirmed")}const prefix=input.dataset.confirmed==="true"?"":"待确认 · ";$(`#${CSS.escape(input.dataset.metric)}-anchor`).textContent=`${prefix}${cfg[input.dataset.metric].anchors[Number(input.value)-1]}`};input.addEventListener("input",()=>update(true));input.addEventListener("change",()=>navigator.vibrate?.(8));input.addEventListener("pointerdown",()=>update(true));update()});$$(".note-toggle").forEach(b=>b.addEventListener("click",()=>{const f=$(`#${CSS.escape(b.dataset.note)}-note`);f.classList.toggle("visible");b.setAttribute("aria-expanded",String(f.classList.contains("visible")));if(f.classList.contains("visible"))f.focus()}))}

function setLongContentExpanded(key,expanded){if(!key)return;if(expanded)expandedLongContentKeys.add(key);else expandedLongContentKeys.delete(key)}
function speechAssetControlsMarkup({sourceType,sourceId,sourceVersion,label}){
  if(!state.speech?.configured||!speechSourceIdentity(sourceType,sourceId,sourceVersion))return"";
  const asset=speechAssetForSource(state.speech.assets,{sourceType,sourceId,sourceVersion}),path=speechAudioPath(asset),sourceLabel=String(label||"文字朗读"),voiceLabel=(state.speech.voices||[]).find(item=>item.id===asset?.voice)?.label||"",rateOptions=TTS_PLAYBACK_RATES.map(rate=>`<option value="${rate}" ${rate===1?"selected":""}>${rate.toFixed(1)}×</option>`).join("");
  const player=asset&&path?`<div class="capture-speech-player speech-asset-player"><audio controls preload="none" src="${escapeHtml(appUrl(path))}" data-speech-player="${escapeHtml(asset.id)}" aria-label="${escapeHtml(`${sourceLabel}播放器`)}"></audio><span>${escapeHtml(voiceLabel?`${sourceLabel} · ${voiceLabel}`:sourceLabel)}</span></div>`:"";
  return `<section class="speech-asset-controls" data-speech-source-type="${escapeHtml(sourceType)}" data-speech-source-id="${escapeHtml(sourceId)}" data-speech-source-version="${Number(sourceVersion)||1}">${player}<div class="capture-speech-actions speech-asset-actions"><button type="button" data-speech-synthesize data-speech-regenerate="${asset?"true":"false"}" aria-label="${escapeHtml(`${asset?"重新生成":"生成"}${sourceLabel}`)}">${asset?"重新生成":"生成"}</button><label><span>播放倍速</span><select data-speech-playback-rate aria-label="${escapeHtml(`${sourceLabel}播放倍速`)}">${rateOptions}</select></label></div><p class="speech-asset-status" role="status" aria-live="polite"></p></section>`
}
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
  if(renderedRouteView==="captures"&&route.view!=="captures")closeCaptureEditor({restoreFocus:false});
  renderVisibleRoute();
  if(!fullRouteStateLoaded&&(!routeDataReady||loadedRouteKey!==routeDataKey(route))&&currentUser)return loadRouteState(route,requestSerial);
  return null
}
function openThoughtDetail(id){return pageRouter?.openDetail("thought-chain",id)}

function captureDerivedTranscription(label,text,lines,kind){
  if(!text)return"";
  return `<section class="capture-transcription ${escapeHtml(kind)} speech-text-layer" data-speech-text-lines="${lines}" data-speech-text-label="${escapeHtml(label)}" style="--speech-text-lines:${lines}"><small>${escapeHtml(label)}</small><div class="speech-text-frame"><div class="markdown-content">${renderMarkdown(text)}</div></div><button type="button" class="speech-text-expand" data-speech-text-expand aria-expanded="false" aria-label="${escapeHtml(`展开${label}`)}" hidden>展开</button></section>`
}
function captureAudioMarkup(item){
  const audio=item.audio,transcription=item.transcription||null,speech=transcription?.condensedText||transcription?.polishedText||transcription?.rawText||plainPreview(item.content||"");
  if(!audio&&!speech)return"";
  const presentation=captureAudioPresentation(item,state.speech,state.aiTasks);
  const layers=[
    transcription?.rawText?`<details class="capture-transcription capture-transcription-raw"><summary>原始转写</summary><div class="markdown-content">${escapeHtml(transcription.rawText).replace(/\r\n?|\n/g,"<br>")}</div></details>`:"",
    captureDerivedTranscription("AI 整理稿",transcription?.polishedText,2,"polished"),
    captureDerivedTranscription("AI 凝练压缩总结稿",transcription?.condensedText,6,"condensed")
  ].join("");
  let transcriptionState="";
  if(presentation.transcriptionMessage){
    const action=presentation.canTranscribe&&["failed","unconfigured"].includes(presentation.transcriptionStatus)
      ?`<button type="button" class="subtle-action" data-capture-transcribe="${escapeHtml(item.id)}" data-capture-audio-key="${escapeHtml(presentation.audioKey)}">${presentation.transcriptionStatus==="failed"?"重试":"开始转写"}</button>`
      :"";
    transcriptionState=`<p class="capture-transcription-state ${presentation.transcriptionStatus==="failed"?"error":""}" data-transcription-task-id="${escapeHtml(presentation.transcriptionTaskId)}">${escapeHtml(presentation.transcriptionMessage)}${action}</p>`;
  }
  const speechControls=speech?speechAssetControlsMarkup({sourceType:"capture",sourceId:item.id,sourceVersion:item.version||1,label:"捕念文字朗读"}):"";
  return `<section class="capture-audio-record" data-capture-audio-key="${escapeHtml(presentation.audioKey)}" data-transcription-task-id="${escapeHtml(presentation.transcriptionTaskId)}">${audio?`<div class="capture-audio-source" data-capture-audio-key="${escapeHtml(presentation.audioKey)}"><audio controls preload="none" src="${escapeHtml(appUrl(audio.attachmentPath))}" aria-label="捕念原始录音播放器"></audio><span>${formatAudioDuration(audio.durationMs)} · <b class="capture-audio-playback-state">${escapeHtml(presentation.audioStatus)}</b></span></div>`:""}${layers}${transcriptionState}${speechControls}</section>`
}
function syncVoicePreviewButton(){
  const button=$("#tts-voice-preview");if(!button)return;
  const voice=$("#tts-default-voice")?.value,selected=(state.speech?.voices||[]).find(item=>item.id===voice);
  button.disabled=voicePreviewPending||!Boolean(selected?.samplePath||state.speech?.configured);
  button.setAttribute("aria-label",voicePreviewPlaying?"停止官方音色试音":"播放所选官方音色试音");
  button.title=button.getAttribute("aria-label");
  const icon=button.querySelector("[aria-hidden]");if(icon)icon.textContent=voicePreviewPlaying?"■":"▶"
}
function stopVoicePreview({clearStatus=false}={}){
  if(voicePreviewPending)pageAudioCoordinator.stopAll();
  else if(voicePreviewAudio)pageAudioCoordinator.stop(voicePreviewAudio);
  voicePreviewAudio=null;voicePreviewPending=false;voicePreviewPlaying=false;voicePreviewVoice="";
  if(clearStatus&&$("#tts-voice-preview-status"))$("#tts-voice-preview-status").textContent="";
  syncVoicePreviewButton()
}
function claimPageAudio(audio){
  if(!audio)return false;
  if(voicePreviewAudio&&audio!==voicePreviewAudio){voicePreviewAudio=null;voicePreviewPending=false;voicePreviewPlaying=false;voicePreviewVoice="";syncVoicePreviewButton()}
  return pageAudioCoordinator.claim(audio)
}
function stopPageAudio(){
  pageAudioCoordinator.stopAll();voicePreviewAudio=null;voicePreviewPending=false;voicePreviewPlaying=false;voicePreviewVoice="";
  if($("#tts-voice-preview-status"))$("#tts-voice-preview-status").textContent="";
  syncVoicePreviewButton()
}
function syncSpeechTextOverflow(root=document){
  root.querySelectorAll("[data-speech-text-lines]").forEach(layer=>{
    const frame=layer.querySelector(".speech-text-frame"),content=frame?.firstElementChild,button=layer.querySelector("[data-speech-text-expand]");if(!frame||!content||!button)return;
    const expanded=layer.classList.contains("is-expanded"),lines=Math.max(1,Number(layer.dataset.speechTextLines)||1),lineHeight=parseFloat(getComputedStyle(content).lineHeight)||20,limit=lines*lineHeight,overflows=frame.scrollHeight>limit+1;
    layer.classList.toggle("is-collapsible",overflows);layer.classList.toggle("is-expanded",overflows&&expanded);button.hidden=!overflows;button.textContent=overflows&&expanded?"收起":"展开";button.setAttribute("aria-expanded",String(overflows&&expanded));button.setAttribute("aria-label",`${overflows&&expanded?"收起":"展开"}${layer.dataset.speechTextLabel||"文稿"}`)
  })
}
function captureCard(item,showDate=true){
  const tags=item.tags?.length?`#${item.tags.map(escapeHtml).join(" #")}`:"未标记";
  const promotedRoot=(state.thoughts||[]).find(value=>value.type==="question"&&value.sourceRef?.type==="capture"&&value.sourceRef.id===item.id);
  const syncing=item._sync?.status,actions=syncing
    ?`<span class="capture-sync-state ${escapeHtml(syncing)}">${syncing==="pending"?"待同步":"正在同步"}</span>`
    :`${promotedRoot?`<button type="button" class="capture-promoted-link" data-capture-thought="${escapeHtml(promotedRoot.id)}">已展为思考</button>`:`<button type="button" data-capture-promote="${item.id}">展开成思考</button>`}<div class="capture-actions-row"><button type="button" data-capture-edit="${item.id}">编辑</button><button type="button" class="danger" data-capture-delete="${item.id}" aria-label="删除这条捕念">删除</button></div>`;
  return `<article class="capture-timeline-entry${syncing?" is-syncing":""}" data-capture-id="${item.id}"><div class="timeline-date capture-date">${showDate?escapeHtml(eventDate(item)):""}</div><header class="capture-meta"><span class="capture-top-tags">${tags}</span><time class="capture-entry-time">${formatTime(eventTimestamp(item))}</time></header><div class="capture-item" data-expand-key="capture:${escapeHtml(item.id)}"><div class="capture-copy"><div class="capture-content-viewport"><div class="record-actions capture-actions">${actions}</div>${item.content?`<div class="markdown-content">${renderMarkdown(item.content)}</div>`:""}${contentImagesMarkup(item,"capture")}${captureAudioMarkup(item)}</div></div><button class="capture-expand" type="button" data-capture-expand aria-expanded="false" aria-label="展开捕念" hidden>⌄</button></div></article>`;
}
function syncCaptureOverflow(){
  $$(".capture-item").forEach(card=>{
    const viewport=card.querySelector(".capture-content-viewport"),button=card.querySelector("[data-capture-expand]");if(!viewport||!button)return;
    const wasExpanded=expandedLongContentKeys.has(card.dataset.expandKey);viewport.classList.remove("expanded");
    const overflows=viewport.scrollHeight>viewport.clientHeight+1;
    const expanded=wasExpanded&&overflows;
    viewport.classList.toggle("expanded",expanded);card.classList.toggle("is-expandable",overflows);card.classList.toggle("is-expanded",expanded);button.hidden=!overflows;button.setAttribute("aria-expanded",String(expanded));button.setAttribute("aria-label",expanded?"收起捕念":"展开捕念");
  });
  scheduleAnnotationLineCounts()
}
function toggleCaptureCard(card){
  if(!card?.classList.contains("is-expandable"))return;
  const viewport=card.querySelector(".capture-content-viewport"),button=card.querySelector("[data-capture-expand]"),expanded=!viewport.classList.contains("expanded");
  setLongContentExpanded(card.dataset.expandKey,expanded);viewport.classList.toggle("expanded",expanded);card.classList.toggle("is-expanded",expanded);button.setAttribute("aria-expanded",String(expanded));button.setAttribute("aria-label",expanded?"收起捕念":"展开捕念");scheduleAnnotationLineCounts();
}
function renderCaptures(){
  const allItems=[...(state.captures||[])].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a)));
  const items=allItems.filter(item=>matchesFeedSearch("captures",item.content,item.tags,item.transcription?.rawText,item.transcription?.polishedText,item.transcription?.condensedText));
  const form=$("#capture-form"),editor=$("#capture-editor"),toggle=$("#capture-create-toggle"),open=captureComposerOpen,editing=Boolean($("#capture-id").value);
  form.hidden=!open;editor.hidden=!open;$("#capture-editor-title").textContent=editing?"编辑念起":"记录念起";toggle.setAttribute("aria-expanded",String(open));toggle.textContent=open?"收起":"＋ 捕念";
  $("#capture-count").textContent=feedCountLabel("captures",items.length,allItems.length,"条");
  $("#capture-list").innerHTML=items.length
    ?items.map((item,index)=>captureCard(item,index===0||eventDate(item)!==eventDate(items[index-1]))).join("")
    :allItems.length
      ?feedSearchEmpty("念起")
      :contentState({title:"还没有捕念",body:"刚开始为空很正常。文字、图片或录音都可以单独留下。",action:{command:"new-capture",label:"留下第一条"}});
  items.filter(item=>!item._sync).forEach(item=>markCommentTarget($(`[data-capture-id="${CSS.escape(item.id)}"] .capture-copy .markdown-content`),commentRootKey("capture",item.id),"content"));
  renderLatex($("#capture-list"));applyCommentAnchors($("#capture-list"));requestAnimationFrame(()=>{syncSpeechTextOverflow($("#capture-list"));syncCaptureOverflow()});
}
function captureEditorFocusTarget(trigger=captureEditorTrigger){
  if(trigger?.element?.isConnected)return trigger.element;
  if(trigger?.captureId)return document.querySelector(`[data-capture-id="${CSS.escape(trigger.captureId)}"] [data-capture-edit]`);
  return $("#capture-create-toggle")
}
function snapshotCaptureCreateDraft(){
  const imageDraft=contentImageDraft("capture");
  return{
    form:captureFormDrafts({querySelectorAll:()=>[$("#capture-form")]})[0],
    tags:[...captureDraftTags],
    images:{
      uploadRequestId:imageDraft.uploadRequestId,
      context:imageDraft.context,
      items:imageDraft.items.map(item=>({...item,preview:""}))
    },
    audio:Object.fromEntries(["blob","path","mimeType","bytes","durationMs","uploadRequestId","uploadedPath","lastError"].map(key=>[key,captureAudioDraft[key]]))
  }
}
function restoreSuspendedCaptureCreateDraft(){
  const snapshot=suspendedCaptureCreateDraft;if(!snapshot)return false;
  contentImageDraftManager.replaceTransient("capture",snapshot.images);
  if(captureAudioDraft.preview)URL.revokeObjectURL(captureAudioDraft.preview);
  Object.assign(captureAudioDraft,{blob:null,preview:"",path:"",mimeType:"",bytes:0,durationMs:0,uploadRequestId:"",uploadedPath:"",lastError:null,recorder:null,stream:null,chunks:[],startedAt:0,pausedAt:0,pausedTotal:0,timer:0,stopPromise:null,resolveStop:null,...snapshot.audio});
  captureDraftTags=[...snapshot.tags];restoreFormDrafts({querySelectorAll:()=>[$("#capture-form")]},[snapshot.form]);renderContentImageEditor("capture");renderCaptureAudioDraft();renderCaptureTagComposer();suspendedCaptureCreateDraft=null;return true
}
async function closeCaptureEditor({restoreFocus=true}={}){
  if(!captureComposerOpen)return;
  const serial=++captureEditorSerial,editingId=$("#capture-id").value,trigger=captureEditorTrigger;
  if(captureAudioStartPending)captureAudioDraft.serial+=1;
  captureComposerOpen=false;$("#capture-editor").hidden=true;$("#capture-form").hidden=true;document.body.classList.remove("capture-editor-open");renderCaptures();
  if(captureAudioDraft.recorder&&captureAudioDraft.recorder.state!=="inactive")await stopCaptureAudioRecording();
  saveDurableDrafts();await Promise.all([persistContentImageDraft("capture"),persistCaptureAudioDraft()]).catch(()=>{});
  if(serial!==captureEditorSerial)return false;
  if(!captureAudioDraft.blob&&!captureAudioDraft.path&&!captureAudioDraft.uploadedPath)$("#capture-audio-recorder").open=false;
  if(editingId)resetCaptureForm({restoreFocus:false});else captureEditorTrigger=null;
  const target=captureEditorFocusTarget(trigger);if(restoreFocus&&target?.isConnected)target.focus({preventScroll:true})
  return true
}
function openCaptureEditor(trigger=null){
  if($("#capture-id").value)resetCaptureForm({restoreFocus:false});
  captureEditorSerial+=1;
  captureEditorTrigger={element:trigger instanceof HTMLElement?trigger:$("#capture-create-toggle"),captureId:""};
  captureComposerOpen=true;renderCaptures();document.body.classList.add("capture-editor-open");
  requestAnimationFrame(()=>$("#capture-content")?.focus())
}
function openQuickVoiceCapture(){
  switchView("captures");
  openCaptureEditor($("#capture-create-toggle"));
  $("#capture-audio-recorder").open=true;
  void requestCaptureAudioRecording()
}
function resetCaptureForm({preserveUploads=false,restoreFocus=true}={}){
  captureEditorSerial+=1;
  const editingId=$("#capture-id").value,trigger=captureEditorTrigger;
  captureComposerOpen=false;$("#capture-form").reset();delete $("#capture-form").dataset.requestId;$("#capture-id").value="";
  resetContentImageEditor("capture",[],{forget:!preserveUploads,preserveStored:Boolean(editingId)});
  clearCaptureAudioDraft({forget:!preserveUploads,preserveStored:Boolean(editingId)});
  captureDraftTags=[];renderCaptureTagComposer();resetOccurrenceInput($("#capture-date"));$("#capture-submit").textContent="收下";$("#capture-cancel").hidden=true;$("#capture-status").textContent="";$("#capture-editor").hidden=true;document.body.classList.remove("capture-editor-open");
  if(editingId)restoreSuspendedCaptureCreateDraft();else clearDurableDraft("capture-form");
  captureEditorTrigger=null;renderCaptures();
  if(preserveUploads&&currentUser?.id&&!editingId)void Promise.all([mediaDraftStore.delete(currentUser.id,"capture"),mediaDraftStore.delete(currentUser.id,audioDraftKey)]).catch(()=>{});
  const target=captureEditorFocusTarget(trigger);if(restoreFocus&&target?.isConnected)requestAnimationFrame(()=>target.focus({preventScroll:true}))
}
function editCapture(id,trigger=null){
  const item=state.captures.find(value=>value.id===id);if(!item)return;
  if($("#capture-id").value===item.id)return openCaptureEditor(trigger);
  if($("#capture-id").value)resetCaptureForm({restoreFocus:false});
  captureEditorSerial+=1;
  saveDurableDrafts();void Promise.all([persistContentImageDraft("capture"),persistCaptureAudioDraft()]).catch(()=>{});
  suspendedCaptureCreateDraft=snapshotCaptureCreateDraft();
  captureEditorTrigger={element:trigger instanceof HTMLElement?trigger:document.activeElement,captureId:item.id};captureComposerOpen=true;$("#capture-id").value=item.id;$("#capture-content").value=item.content;resetContentImageEditor("capture",item.attachmentPaths||[],{forget:false});setExistingCaptureAudio(item.audio,{preserveStored:true});captureDraftTags=[...(item.tags||[])];$("#capture-tags").value="";renderCaptureTagComposer();resetOccurrenceInput($("#capture-date"),item);$("#capture-submit").textContent="保存修改";$("#capture-cancel").hidden=false;$("#capture-status").textContent="正在编辑已有捕念";renderCaptures();document.body.classList.add("capture-editor-open");$("#capture-content").focus();
}
function reflectionMarkup(item,reflection,index){
  const stale=reflection.sourceUpdatedAt&&(reflection.sourceUpdatedAt!==(item.updatedAt||item.createdAt));
  return `<details class="journal-reflection" data-reflection-id="${reflection.id}" ${index===0?"open":""}><summary><span>助手回望${index?" "+(item.reflections.length-index):""}</span><small>${stale?"基于修改前版本 · ":""}${formatDate(reflection.createdAt)}</small></summary><div class="model-answer-content">${contextReceiptMarkup(reflection.contextReceipt)}<div class="markdown-content">${renderMarkdown(reflection.content)}</div></div></details>`;
}
function journalCard(item){
  const title=item.title||`${eventDate(item)} 日记`,reflections=item.reflections||[],tags=item.tags?.length?`<div class="record-tags">${item.tags.map(tag=>`<span>#${escapeHtml(tag)}</span>`).join("")}</div>`:"",syncing=item._sync?.status,actions=syncing?`<span class="checkin-sync-state ${escapeHtml(syncing)}">${syncing==="pending"?"待同步":"正在同步"}</span>`:`<button type="button" class="reflect-action" data-journal-reflect="${item.id}">✦ ${reflections.length?"再次回望":"请助手回望"}</button><button type="button" data-journal-edit="${item.id}">编辑</button><button type="button" class="danger" data-journal-delete="${item.id}">删除</button>`;
  return `<details class="card journal-entry${syncing?" is-syncing":""}" data-journal-id="${item.id}"><summary><div><time>${escapeHtml(eventDate(item))}</time><strong>${escapeHtml(title)}</strong><p>${escapeHtml(plainPreview(item.content))}</p></div><span class="expand-mark" aria-hidden="true">⌄</span></summary><div class="journal-entry-body"><div class="markdown-content journal-original">${renderMarkdown(item.content)}</div>${tags}<div class="record-actions">${actions}</div>${reflections.length?`<section class="journal-reflections"><h3>回望记录</h3>${reflections.map((reflection,index)=>reflectionMarkup(item,reflection,index)).join("")}</section>`:""}</div></details>`;
}
function renderJournals(){
  if(!journalDraftRestored){journalDraftRestored=true;restoreJournalDraft(state.journalDraft)}
  const open=new Set($$(".journal-entry[open]").map(item=>item.dataset.journalId)),allItems=[...(state.journals||[])].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a)));
  const items=allItems.filter(item=>matchesFeedSearch("journals",item.title,item.content,item.tags,item.reflections?.map(value=>value.content)));
  $("#journal-count").textContent=feedCountLabel("journals",items.length,allItems.length,"篇");
  $("#journal-list").innerHTML=items.length?items.map(journalCard).join(""):allItems.length?feedSearchEmpty("日记"):contentState({title:"还没有日记",body:"不需要写完整，一句真实的话也可以成为记录。",action:{focus:"journal-content",label:"写第一篇"}});
  $$(".journal-entry").forEach(card=>{const item=items.find(value=>value.id===card.dataset.journalId);if(!item)return;if(open.has(item.id))card.open=true;if(item._sync)return;const rootKey=commentRootKey("journal",item.id);markCommentTarget(card.querySelector(".journal-original"),rootKey,"content");(item.reflections||[]).forEach(reflection=>markCommentTarget(card.querySelector(`[data-reflection-id="${CSS.escape(reflection.id)}"] .model-answer-content>.markdown-content`),rootKey,`reflection:${reflection.id}`))});renderLatex($("#journal-list"));applyCommentAnchors($("#journal-list"));
}
function resetJournalForm(){
  $("#journal-form").reset();$("#journal-id").value="";resetOccurrenceInput($("#journal-date"));$("#journal-submit").textContent="保存日记";$("#journal-cancel").hidden=true;$("#journal-status").textContent="";$("#journal-assist-status").textContent="";
}
function restoreJournalDraft(draft){
  if(!draft)return false;
  const item=state.journals.find(value=>value.id===draft.journalId);
  $("#journal-form").reset();$("#journal-id").value=item?.id||"";$("#journal-title").value=draft.title||"";$("#journal-content").value=draft.content||"";
  resetOccurrenceInput($("#journal-date"),item||null);
  $("#journal-tags").value=item?(item.tags||[]).map(tag=>`#${tag}`).join(" "):"";
  $("#journal-submit").textContent=item?"保存修改":"保存日记";$("#journal-cancel").hidden=!item;$("#journal-assist-status").textContent="";
  $("#journal-status").textContent=`已恢复 ${formatTime(draft.updatedAt)} 保存的草稿。`;
  return true;
}
function editJournal(id){
  const item=state.journals.find(value=>value.id===id);if(!item)return;
  $("#journal-id").value=item.id;$("#journal-title").value=item.title||"";resetOccurrenceInput($("#journal-date"),item);$("#journal-content").value=item.content;$("#journal-tags").value=(item.tags||[]).map(tag=>`#${tag}`).join(" ");$("#journal-submit").textContent="保存修改";$("#journal-cancel").hidden=false;$("#journal-status").textContent=item.reflections?.length?"修改原文后，已有回望仍会保留并标记为旧版本。":"正在编辑已有日记";$("#journal-form").scrollIntoView({behavior:"smooth",block:"start"});$("#journal-content").focus();
}

function renderCheckinSurfaces(domains){for(const controller of checkinsFeatureControllers)controller.renderPresentation({snapshot:state,changedDomains:domains})}
function renderStateChart(){renderCheckinSurfaces(["checkins","review"])}
function renderChat(){const chats=state.chats.filter(x=>eventDate(x)===activeDate);$("#chat-history").innerHTML=chats.length?[...chats].reverse().map(x=>`<div class="chat-message user" data-chat-id="${x.id}" data-chat-part="message"><div class="markdown-content">${renderMarkdown(x.message)}</div></div><div class="chat-message agent" data-chat-id="${x.id}" data-chat-part="answer">${contextReceiptMarkup(x.contextReceipt)}<div class="markdown-content">${renderMarkdown(x.answer)}</div><button class="subtle-action danger chat-delete" type="button" data-chat-delete="${x.id}">删除对话</button></div>`).join(""):contentState({title:"这一天还没有对话",body:"发送问题后，共参会结合你已保存的记录回答。",action:{focus:"chat-input",label:"开始提问"}});chats.forEach(item=>{const rootKey=commentRootKey("chat",item.id);markCommentTarget($(`[data-chat-id="${CSS.escape(item.id)}"][data-chat-part="message"]>.markdown-content`),rootKey,"message");markCommentTarget($(`[data-chat-id="${CSS.escape(item.id)}"][data-chat-part="answer"]>.markdown-content`),rootKey,"answer")});renderLatex($("#chat-history"));applyCommentAnchors($("#chat-history"))}
function experimentCard(item){const start=new Date(item.createdAt),elapsed=Math.max(1,Math.floor((Date.now()-start.getTime())/86400000)+1),relevant=state.checkins.filter(x=>new Date(eventTimestamp(x))>=start),withFactor=relevant.filter(x=>(x.factors||[]).includes(item.factor)),withoutFactor=relevant.filter(x=>!(x.factors||[]).includes(item.factor)),metric=baseMetrics[item.outcome]?item.outcome:"mood",withAvg=avg(withFactor.map(x=>x[metric]).filter(Number.isFinite)),withoutAvg=avg(withoutFactor.map(x=>x[metric]).filter(Number.isFinite)),enough=withFactor.length>=3&&withoutFactor.length>=3,result=enough?`有因素 ${withAvg.toFixed(1)} / 无因素 ${withoutAvg.toFixed(1)}，差值 ${(withAvg-withoutAvg).toFixed(1)}`:`有因素 ${withFactor.length} 次 / 无因素 ${withoutFactor.length} 次；两边各满 3 次后开始显示线索`;return `<article class="experiment-card"><div class="section-title"><b>${escapeHtml(item.hypothesis)}</b><span>${Math.min(elapsed,item.duration)} / ${item.duration} 天</span></div><div class="experiment-progress"><i style="width:${Math.min(100,elapsed/item.duration*100)}%"></i></div><p>每天若做了“<b>${escapeHtml(item.factor)}</b>”，请在今日因素中填入完全相同的词；观察 ${trendLabels[metric]}。</p><footer><small>${escapeHtml(result)}。相关不等于因果。</small><button class="subtle-action danger" type="button" data-experiment-delete="${item.id}">删除</button></footer></article>`}

function renderAssociationFlow(){const dates=new Set(state.checkins.map(x=>x.occurredOn)).size,factors=new Set(state.checkins.flatMap(x=>x.factors||[])).size;$("#association-flow").innerHTML=`<div class="association-flow" role="img" aria-label="延迟相关线索计算流程：记录状态和因素，按日期聚合，按因素分组，对照当天与自然次日情绪，通过样本门槛，最后输出非因果线索"><div class="flow-node"><b>状态记录</b><span>${state.checkins.length} 次状态 · ${factors} 个因素</span></div><i>↓</i><div class="flow-node"><b>按自然日聚合</b><span>${dates} 天；同日多次取平均</span></div><i>↓</i><div class="flow-node"><b>逐个因素分组</b><span>出现该因素的天 vs 未出现的天</span></div><i>↓</i><div class="flow-node"><b>三个对照</b><span>当天情绪 · 自然次日情绪 · 无因素基线</span></div><i>↓</i><div class="flow-node"><b>样本分层</b><span>首次出现即展示；样本增加后再升级为初步线索或可观察</span></div><i>↓</i><div class="flow-node final"><b>延迟关联线索</b><span>只显示均值差异，不推断因果</span></div></div>`}
function setAssociationFlowOpen(open){const modal=$("#association-flow-modal"),button=$("#association-flow-toggle");modal.hidden=!open;button.setAttribute("aria-expanded",String(open));button.setAttribute("aria-label",open?"关闭计算流程":"查看计算流程");button.title=open?"关闭计算流程":"查看计算流程";if(open)$("#association-flow-close").focus();else button.focus()}
function trendInsightsMarkup(){
  const trends=state.insights.trends||[],available=trends.filter(item=>item.current!=null);
  if(!available.length)return empty("记录一次状态后即可形成当前均值；有第二组数据后再比较变化。");
  const waiting=available.every(item=>item.previous==null),sampleCount=Math.max(...available.map(item=>item.currentCount||0),state.insights.weekly?.checkins||0);
  const note=waiting?`<p class="review-observation"><b>当前观察</b><span>先展示已有 ${sampleCount||"少量"} 个记录日的均值；样本增加后自动补充前后变化。</span></p>`:"";
  return `${note}${trends.map(item=>{const delta=item.previous==null?"当前均值":`${item.current>=item.previous?"+":""}${(item.current-item.previous).toFixed(1)}`,count=item.currentCount?` · ${item.currentCount}天`:"";return `<div class="trend-row trend-${item.metric}"><b>${trendLabels[item.metric]}</b><div class="trend-bar"><span style="width:${(item.current||0)*20}%;--trend-value:${item.current||0}"></span></div><span class="delta">${item.current??"—"} / ${delta}${count}</span></div>`}).join("")}`;
}
function associationInsightsMarkup(){
  const associations=(state.insights.associations||[]).slice(0,3);
  if(associations.length)return associations.map(item=>{const next=item.nextDay==null?"次日暂无":`次日 ${item.nextDay}（${item.nextDayCount}天）`,baseline=item.baseline==null?"暂无无因素日":`无因素 ${item.baseline}（${item.withoutCount}天）`;return `<div class="association-row"><b>${escapeHtml(item.factor)}</b><span>当天 ${item.sameDay??"—"}（${item.withCount}天） · ${next} · ${baseline}</span><span class="delta">${item.confidence}</span></div>`}).join("");
  const groups=new Map();for(const item of state.checkins){const value=Number(item.mood);if(!Number.isFinite(value))continue;const key=item.occurredOn;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(value)}
  const moods=[...groups.values()].map(avg),days=groups.size;
  if(!moods.length)return empty("记录一次状态后即可形成当前观察；补充当天因素后再寻找关联线索。");
  return `<p class="review-observation"><b>当前观察</b><span>${days} 个记录日的情绪均值为 ${avg(moods).toFixed(1)}。尚未记录可对照因素，暂时只描述现状。</span></p>`;
}
function safeAnalysisRecord(value){
  const item=structuredClone(value||{});delete item.reasoningContent;delete item.contentTruncated;
  for(const annotation of[...(item.annotations||[]),...(item.annotationDrift||[])])for(const exchange of annotation.shenji||[])delete exchange.reasoningContent;
  return item
}
async function loadAnalysisDetail(id){
  const item=(state.analyses||[]).find(value=>value.id===id);
  if(!item?.contentTruncated)return true;
  const serial=++analysisRequestSerial,owner=currentUser?.id,session=sessionSerial,routeKey=routeDataKey(pageRouter?.currentRoute());
  const status=document.querySelector(`[data-analysis-id="${CSS.escape(id)}"] [data-analysis-load-status]`);
  if(status)status.textContent="正在载入完整复盘…";
  try{
    const result=await requestV1(`/api/v1/analyses/${encodeURIComponent(id)}`);
    if(serial!==analysisRequestSerial||owner!==currentUser?.id||session!==sessionSerial||routeKey!==routeDataKey(pageRouter?.currentRoute()))return false;
    state.analyses=(state.analyses||[]).map(value=>value.id===id?safeAnalysisRecord(result.data):value);renderAnalysisHistory();return true
  }catch(error){
    if(serial===analysisRequestSerial&&status?.isConnected)status.textContent=`完整复盘载入失败：${error.message}`;
    return false
  }
}
async function loadMoreAnalyses(){
  const button=$("#analysis-load-more"),cursor=state.analysisPage?.nextCursor,route=pageRouter?.currentRoute();
  if(!button||!cursor||route?.view!=="review")return false;
  const serial=++analysisRequestSerial,owner=currentUser?.id,session=sessionSerial,routeKey=routeDataKey(route);
  button.disabled=true;$("#analysis-pagination-status").textContent="正在加载…";
  try{
    const result=await requestV1(`/api/v1/route-state?view=review&cursor=${encodeURIComponent(cursor)}`),snapshot=result.data||{};
    if(serial!==analysisRequestSerial||owner!==currentUser?.id||session!==sessionSerial||routeKey!==routeDataKey(pageRouter?.currentRoute()))return false;
    const known=new Set((state.analyses||[]).map(item=>item.id));
    state.analyses=[...(state.analyses||[]),...(snapshot.analyses||[]).filter(item=>!known.has(item.id))];
    state.analysisPage={...(state.analysisPage||{}),...(snapshot.analysisPage||{})};
    renderAnalysisHistory();return true
  }catch(error){
    if(serial===analysisRequestSerial)$("#analysis-pagination-status").textContent=`继续加载失败：${error.message}`;
    return false
  }finally{
    if(button.isConnected)button.disabled=false
  }
}
function renderAnalysisHistory(){
  const list=$("#analysis-list"),known=new Set([...list.querySelectorAll("[data-analysis-id]")].map(item=>item.dataset.analysisId)),opened=new Set([...list.querySelectorAll("[data-analysis-id][open]")].map(item=>item.dataset.analysisId)),items=[...(state.analyses||[])].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const total=Math.max(items.length,Number(state.analysisPage?.total)||0),pagination=$("#analysis-pagination");
  $("#analysis-count").textContent=`${total} 份`;
  const hasSource=Number(state.reviewSourceCount)>0||[state.checkins,state.dailyRecords,state.captures,state.journals,state.thoughts].some(collection=>collection?.length);
  list.innerHTML=items.length?items.map((item,index)=>{const label=item.reason==="weekly-background"?"后台周复盘":"主动复盘",isNew=!known.has(item.id),open=opened.has(item.id)||(index===0&&(!known.size||isNew));return `<details class="analysis-entry" data-analysis-id="${item.id}" ${open?"open":""}><summary><div><div class="analysis-summary-meta"><time>${formatDate(item.createdAt)}</time><span>${label}</span>${index===0?'<b>最新</b>':""}</div><p>${escapeHtml(plainPreview(item.content))}</p></div><span class="expand-mark" aria-hidden="true">⌄</span></summary><div class="analysis-entry-body">${contextReceiptMarkup(item.contextReceipt)}<div class="analysis-content markdown-content">${renderMarkdown(item.content)}</div>${item.contentTruncated?'<p class="status" data-analysis-load-status>展开后载入完整复盘。</p>':""}<button class="subtle-action danger" type="button" data-analysis-delete="${item.id}">删除复盘</button></div></details>`}).join(""):contentState({title:"还没有认知复盘",body:hasSource?"现有记录已经可以作为起点，复盘结果只是一条可修正的线索。":"先留下任意一条记录，再回到这里形成第一份复盘。",action:hasSource?{command:"run-analysis",label:"开始一次复盘"}:{view:"captures",label:"先留一条记录"}});
  if(pagination){pagination.hidden=!state.analysisPage?.nextCursor;$("#analysis-pagination-status").textContent=state.analysisPage?.nextCursor?`已加载 ${items.length} / ${total} 份`:""}
  items.forEach(item=>markCommentTarget(list.querySelector(`[data-analysis-id="${CSS.escape(item.id)}"] .analysis-content`),commentRootKey("analysis",item.id),"content"));
  list.querySelectorAll("[data-analysis-id]").forEach(entry=>{entry.addEventListener("toggle",()=>{if(entry.open)void loadAnalysisDetail(entry.dataset.analysisId)});if(entry.open)void loadAnalysisDetail(entry.dataset.analysisId)});
  renderLatex(list);applyCommentAnchors(list);
}
function renderReview(){
  const w=state.insights.weekly||{},reviewValue=w.reviewAgeDays==null?"未开始":w.reviewAgeDays===0?"今天":String(w.reviewAgeDays),reviewUnit=w.reviewAgeDays>0?"天":"";
  const signals=[
    {key:"coverage",label:"近 7 日记录覆盖",value:w.activeDays7??0,unit:"/ 7 天",detail:"有任一主动记录的自然日"},
    {key:"paired",label:"近 30 日身心同日",value:w.pairedDays30??0,unit:"天",detail:"状态与健康记录出现在同一天"},
    {key:"trace",label:"近 30 日思考留痕率",value:w.traceRate30??"—",unit:w.traceRate30==null?"":"%",detail:w.rootCount30?`${w.tracedRoots30??0} / ${w.rootCount30} 个问题留有你的痕迹`:"近 30 日还没有问题"},
    {key:"correction",label:"近 30 日主动校正",value:w.correctionActions30??0,unit:"次",detail:"编辑、追问、批注与回望"},
    {key:"review",label:"距上次认知复盘",value:reviewValue,unit:reviewUnit,detail:w.analysisCount?`累计 ${w.analysisCount} 份认知复盘`:"还没有认知复盘"}
  ];
  $("#weekly-summary").innerHTML=signals.map(item=>`<article class="summary-signal" data-signal="${item.key}"><span class="summary-signal-label">${item.label}</span><div class="summary-signal-value"><strong>${item.value}</strong>${item.unit?`<span>${item.unit}</span>`:""}</div><p>${item.detail}</p></article>`).join("");
  $("#trend-list").innerHTML=trendInsightsMarkup();renderStateChart();$("#association-list").innerHTML=associationInsightsMarkup();renderAssociationFlow();$("#cluster-grid").innerHTML=state.clusters.length?state.clusters.map(g=>`<article class="cluster-card"><div class="section-title"><h2>${escapeHtml(g.theme)}</h2><b>${g.count}</b></div><div class="cluster-stats"><span>保留 ${g.kept}</span><span>舍弃 ${g.discarded}</span><span>未处理 ${g.unreviewed}</span></div><ul>${g.items.slice(0,3).map(x=>`<li>${escapeHtml(x.content.slice(0,54))}${x.content.length>54?"…":""}</li>`).join("")}</ul></article>`).join(""):empty("累积几条思绪后，这里会出现反复主题。");$("#experiment-list").innerHTML=state.experiments.length?state.experiments.map(experimentCard).join(""):`<p class="time-hint">建议从 14 天、一个因素、一个结果开始。</p>`;$("#metric-list").innerHTML=state.customMetrics.length?`<div class="pill-list">${state.customMetrics.map(x=>`<span class="pill">${escapeHtml(x.name)}：${escapeHtml(x.low)} ↔ ${escapeHtml(x.high)}</span>`).join("")}</div>`:`<p class="time-hint">新指标会出现在“此刻状态”中。</p>`;renderAnalysisHistory()
}
const bookFavoriteMeta={none:{icon:"☆",label:"无收藏",next:"star"},star:{icon:"🌟",label:"星标",next:"sprout"},sprout:{icon:"🌱",label:"萌芽",next:"none"}};
function sortedBookNotes(book){return [...(book.notes||[])].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a)))}
function bookCoverMarkup(book,className="book-cover"){return book.imagePath?`<img class="${className}" src="${escapeHtml(appUrl(book.imagePath))}" alt="${escapeHtml(book.title)}" loading="lazy">`:`<div class="${className} placeholder" aria-hidden="true">书</div>`}
function featuredBookNote(book){
  const notes=sortedBookNotes(book);
  let note=notes.find(item=>item.id===activeBookFeatureNoteId);
  if(!note&&notes.length){note=notes[Math.floor(Math.random()*notes.length)];activeBookFeatureNoteId=note.id}
  return note;
}
function bookFeatureMarkup(note){
  if(!note)return `<article class="book-feature-note is-empty"><p class="eyebrow">随机精选</p><h3>第一条笔记会出现在这里</h3><p>正文时间线已经就位。写下一条真实的理解，再回来与它偶遇。</p></article>`;
  const type=note.type==="thought"?"附加思考":"读书记录",preview=plainPreview(note.content);
  return `<article class="book-feature-note"><p class="eyebrow">随机精选</p><blockquote>${escapeHtml(preview.slice(0,220))}${preview.length>220?"…":""}</blockquote><footer><span>${type} · ${formatDate(eventTimestamp(note))}</span><button class="text-button" type="button" data-book-feature-note="${note.id}">在时间线中查看 →</button></footer></article>`;
}
function bookEntryForm(book){
  return `<form class="book-entry-form card" data-book-entry-form="${book.id}">
    <div class="book-entry-form-heading"><div><p class="eyebrow">写进这本书</p><h2 data-book-entry-heading>新增记录</h2></div><button class="text-button" type="button" data-book-entry-cancel hidden>取消编辑</button></div>
    <input type="hidden" name="noteId">
    <div class="book-entry-controls">
      <fieldset class="book-segmented"><legend>类型</legend><label><input type="radio" name="type" value="record" checked><span>记录</span></label><label><input type="radio" name="type" value="thought"><span>附加思考</span></label></fieldset>
      <label class="book-entry-time"><span>发生时间</span><input type="datetime-local" step="1" name="occurredAt" required></label>
      <fieldset class="book-segmented favorite-segmented"><legend>收藏</legend><label><input type="radio" name="favorite" value="none" checked><span>无</span></label><label><input type="radio" name="favorite" value="star"><span>🌟</span></label><label><input type="radio" name="favorite" value="sprout"><span>🌱</span></label></fieldset>
    </div>
    <textarea name="content" rows="5" placeholder="记下原文、理解、疑问，或读完后仍在生长的想法…" required></textarea>
    <div class="book-entry-submit"><span>支持 Markdown 与 LaTeX</span><button class="primary-button" type="submit">保存记录</button></div>
    <p class="status" role="status"></p>
  </form>`
}
function bookTimelineMarkup(book){
  const notes=sortedBookNotes(book);
  if(!notes.length)return `<div class="book-timeline-empty">${empty("还没有记录。先留下一句真实的理解，之后再慢慢补充。")}</div>`;
  return `<div class="book-timeline">${notes.map((note,index)=>{
    const date=eventDate(note),previous=index?eventDate(notes[index-1]):"",favorite=bookFavoriteMeta[note.favorite]||bookFavoriteMeta.none,type=note.type==="thought"?"附加思考":"记录";
      const syncing=note._sync?.status,actions=syncing
        ?`<span class="checkin-sync-state ${escapeHtml(syncing)}">${syncing==="pending"?"待同步":"正在同步"}</span>`
        :`<button class="book-favorite ${note.favorite||"none"}" type="button" data-book-note-favorite="${note.id}" data-next-favorite="${favorite.next}" title="${favorite.label}，点击切换" aria-label="${favorite.label}，点击切换">${favorite.icon}</button><div><button class="subtle-action" type="button" data-book-note-edit="${note.id}">编辑</button><button class="subtle-action danger" type="button" data-book-note-delete="${note.id}">删除</button></div>`;
      return `<article class="book-timeline-entry${syncing?" is-syncing":""}" id="book-note-${note.id}" data-note-id="${note.id}">
      ${date!==previous?`<time class="book-entry-date">${escapeHtml(date)}</time>`:""}
      <div class="book-entry-card card">
        <header><span class="book-entry-type ${note.type==="thought"?"thought":""}">${type}</span><time>${formatTime(eventTimestamp(note))}</time></header>
        <div class="book-note markdown-content">${renderMarkdown(note.content)}</div>
        <footer>${actions}</footer>
      </div>
    </article>`
  }).join("")}</div>`
}
function renderBookDetail(book){
  const detail=$("#book-detail"),notes=sortedBookNotes(book),latest=notes[0],featured=featuredBookNote(book);
  detail.innerHTML=`<div class="book-detail-nav"><button class="book-back" type="button" data-book-back>← 返回书架</button><div><button class="quiet-button" type="button" data-book-edit="${book.id}">编辑书目</button><button class="subtle-action danger" type="button" data-book-delete="${book.id}">删除书目</button></div></div>
    <section class="book-detail-overview">
      <div class="book-feature-wrap">${bookFeatureMarkup(featured)}</div>
      <section class="book-detail-hero">
        ${bookCoverMarkup(book,"book-detail-cover")}
        <div class="book-detail-copy"><h2>${escapeHtml(book.title)}</h2><p class="book-meta">${escapeHtml(book.author||"作者未填")}${book.publisher?` · ${escapeHtml(book.publisher)}`:""}${book.isbn?` · ${escapeHtml(book.isbn)}`:""}</p><p class="book-reading-range">${escapeHtml(bookReadingRange(book))}</p><div class="book-description markdown-content">${renderMarkdown(book.description||"暂无简介")}</div><div class="book-detail-stats"><span><b>${notes.length}</b> 条记录</span><span>${latest?`最近记录 ${formatDate(eventTimestamp(latest))}`:"等待第一条记录"}</span></div></div>
      </section>
    </section>
    <section class="book-timeline-section"><div class="book-timeline-heading"><div><p class="eyebrow">阅读时间线</p><h2>我的笔记与思考</h2></div><div><span>${notes.length} 条</span><button class="quiet-button" type="button" data-book-add-note>＋ 新增记录</button></div></div>${bookTimelineMarkup(book)}</section>
    ${bookEntryForm(book)}`;
  const rootKey=commentRootKey("book",book.id);
  markCommentTarget(detail.querySelector(".book-description"),rootKey,"description");
  notes.filter(note=>!note._sync).forEach(note=>markCommentTarget(detail.querySelector(`[data-note-id="${CSS.escape(note.id)}"] .book-note`),rootKey,`note:${note.id}`));
  renderLatex(detail);applyCommentAnchors(detail);installOccurrenceControls(detail);
  if(pendingBookNoteId){
    const target=detail.querySelector(`#book-note-${CSS.escape(pendingBookNoteId)}`);
    pendingBookNoteId="";
    requestAnimationFrame(()=>target?.scrollIntoView({behavior:"smooth",block:"center"}));
  }
}
function setBookDetailCondensed(value){
  bookDetailCondensed=Boolean(value&&activeBookId);
  $("#view-books").classList.toggle("book-detail-condensed",bookDetailCondensed);
  $("#book-detail").classList.toggle("is-condensed",bookDetailCondensed);
}
function syncBookDetailCondensed(){
  if(activeBookId&&!bookDetailCondensed&&window.scrollY>48)setBookDetailCondensed(true);
}
function renderBookMemories(){
  const sky=$("#book-memory-sky"),memories=state.books.flatMap(book=>(book.notes||[]).map(note=>({book,note}))).sort(()=>Math.random()-.5).slice(0,5);
  sky.innerHTML=memories.length?`<div class="book-memory-title"><p class="eyebrow">偶遇旧笔记</p><span>点击回到原处</span></div>${memories.map(({book,note},index)=>`<button class="book-memory-bubble tone-${index%5} position-${index%5}" type="button" data-book-memory="${book.id}" data-book-note="${note.id}" aria-label="打开《${escapeHtml(book.title)}》中的这条笔记"><span>${escapeHtml(plainPreview(note.content).slice(0,76))}${plainPreview(note.content).length>76?"…":""}</span><small>《${escapeHtml(book.title)}》</small></button>`).join("")}`:`<div class="book-memory-placeholder"><b>旧笔记会在这里浮现</b><span>在任一本书中留下记录后，这里会随机回顾。</span></div>`;
}
function setupBookTitlePans(){
  $$(".book-title-frame").forEach(frame=>{
    const title=frame.dataset.title||"",text=frame.querySelector(".book-title");
    if(!text)return;
    text.textContent=title;frame.classList.remove("is-overflowing");frame.style.removeProperty("--book-title-travel");frame.style.removeProperty("--book-title-duration");
    const lineHeight=parseFloat(getComputedStyle(text).lineHeight);
    if(!lineHeight||text.scrollHeight<=lineHeight*2+.5)return;
    const node=text.firstChild,range=document.createRange(),firstTop=text.getBoundingClientRect().top;
    let secondLineStart=title.length;
    for(let offset=0;offset<title.length;offset++){
      range.setStart(node,offset);range.setEnd(node,offset+1);
      if(range.getBoundingClientRect().top>firstTop+lineHeight*.5){secondLineStart=offset;break}
    }
    const firstLine=title.slice(0,secondLineStart).trimEnd(),remainder=title.slice(secondLineStart).trimStart();
    if(!remainder)return;
    const viewport=document.createElement("span"),track=document.createElement("span"),first=document.createElement("span"),second=document.createElement("span");
    viewport.className="book-title-scroll";track.className="book-title-scroll-track";first.className="book-title-scroll-line";second.className="book-title-scroll-line";first.textContent=firstLine;second.textContent=remainder;track.append(first,second);viewport.append(track);text.replaceChildren(viewport);
    const travel=Math.max(0,Math.ceil(track.scrollWidth-viewport.clientWidth));
    if(!travel)return;
    frame.style.setProperty("--book-title-travel",`${-travel}px`);
    frame.style.setProperty("--book-title-duration",`${Math.min(9,Math.max(4,3.5+travel/40)).toFixed(1)}s`);
    frame.classList.add("is-overflowing");
  });
}
function renderBooks(){
  const hasBooks=state.books.length>0,book=state.books.find(item=>item.id===activeBookId);
  const visibleBooks=state.books.filter(item=>matchesFeedSearch("books",item.title,item.author,item.publisher,item.isbn,item.description,item.notes?.map(note=>note.content)));
  if(!editingBookId&&!$("#book-reading-start").value)$("#book-reading-start").value=localDateKey();
  if(activeBookId&&!book){activeBookId="";activeBookFeatureNoteId="";bookDetailCondensed=false}
  const detailBook=state.books.find(item=>item.id===activeBookId),inDetail=Boolean(detailBook),creator=$("#book-create-panel"),library=$("#book-library"),detail=$("#book-detail"),toggle=$("#book-create-toggle");
  $("#view-books").classList.toggle("book-detail-mode",inDetail);
  $("#view-books").classList.toggle("book-detail-condensed",inDetail&&bookDetailCondensed);
  detail.classList.toggle("is-condensed",inDetail&&bookDetailCondensed);
  $("#book-search-control").hidden=inDetail;
  $("#book-count").textContent=hasBooks?feedCountLabel("books",visibleBooks.length,state.books.length,"本"):"";
  $("#book-note-count").textContent=`${state.books.reduce((sum,item)=>sum+(item.notes||[]).length,0)} 条笔记`;
  toggle.hidden=!hasBooks||inDetail;toggle.textContent=bookCreatorOpen?"收起创建":"＋ 添加书目";
  creator.hidden=inDetail||(hasBooks&&!bookCreatorOpen);creator.classList.toggle("cold-start",!hasBooks);
  library.hidden=inDetail||!hasBooks;detail.hidden=!inDetail;
  if(inDetail){renderBookDetail(detailBook);return}
  detail.innerHTML="";
  if(!hasBooks){$("#book-grid").innerHTML="";return}
  renderBookMemories();
  $("#book-grid").innerHTML=visibleBooks.length?visibleBooks.map(book=>{
    const notes=sortedBookNotes(book),latest=notes[0];
    const syncing=book._sync?.status;
    return `<article class="book-card card${syncing?" is-syncing":""}" data-book-id="${book.id}"><button class="book-card-open" type="button" data-open-book="${book.id}" ${syncing?"disabled":""}>${bookCoverMarkup(book,"book-gallery-cover")}<span class="book-card-copy"><span class="book-title-frame" data-title="${escapeHtml(book.title)}" title="${escapeHtml(book.title)}"><strong class="book-title">${escapeHtml(book.title)}</strong></span><span>${escapeHtml(book.author||"作者未填")}</span><small class="book-card-reading">${escapeHtml(bookReadingRange(book))}</small><small>${syncing?(syncing==="pending"?"待同步":"正在同步"):`${notes.length} 条记录${latest?` · ${formatDate(eventTimestamp(latest))}`:""}`}</small></span><span class="book-card-arrow" aria-hidden="true">→</span></button></article>`
  }).join(""):feedSearchEmpty("书目");
  requestAnimationFrame(setupBookTitlePans);
}
const dataUrlFromBlob=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("图片读取失败"));reader.readAsDataURL(blob)});
const loadImageSource=source=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error("图片无法打开，请换一张重试"));image.src=source});
function blankCanvas(width,height){const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;return canvas}
function clearKeepsakeHistory(){keepsakeEditor.history=[];$("#keepsake-undo").disabled=true}
function pushKeepsakeHistory(){
  if(!keepsakeEditor.maskCanvas)return;
  const canvas=keepsakeEditor.maskCanvas,ctx=canvas.getContext("2d",{willReadFrequently:true});
  keepsakeEditor.history.push(ctx.getImageData(0,0,canvas.width,canvas.height));
  if(keepsakeEditor.history.length>12)keepsakeEditor.history.shift();
  $("#keepsake-undo").disabled=false;
}
function paintMaskOverlay(target,mask,color="#55b98a"){
  const overlay=blankCanvas(mask.width,mask.height),ctx=overlay.getContext("2d");
  ctx.fillStyle=color;ctx.fillRect(0,0,overlay.width,overlay.height);ctx.globalCompositeOperation="destination-in";ctx.drawImage(mask,0,0);
  target.drawImage(overlay,0,0);
}
function keepsakeCutoutCanvas(){
  const source=keepsakeEditor.sourceCanvas,mask=keepsakeEditor.maskCanvas;if(!source||!mask)return null;
  const cutout=blankCanvas(source.width,source.height),ctx=cutout.getContext("2d");
  ctx.drawImage(source,0,0);ctx.globalCompositeOperation="destination-in";ctx.drawImage(mask,0,0);ctx.globalCompositeOperation="source-over";
  return cutout;
}
function renderKeepsakeCanvases(){
  if(!keepsakeEditor.sourceCanvas||!keepsakeEditor.maskCanvas)return;
  const source=keepsakeEditor.sourceCanvas,mask=keepsakeEditor.maskCanvas,editor=$("#keepsake-mask-canvas"),preview=$("#keepsake-preview-canvas");
  for(const canvas of[editor,preview]){if(canvas.width!==source.width||canvas.height!==source.height){canvas.width=source.width;canvas.height=source.height}}
  const editCtx=editor.getContext("2d"),previewCtx=preview.getContext("2d");
  editCtx.clearRect(0,0,editor.width,editor.height);editCtx.drawImage(source,0,0);editCtx.save();editCtx.globalAlpha=.48;paintMaskOverlay(editCtx,mask);editCtx.restore();
  const backgroundOpacity=Math.max(0,Math.min(30,Number($("#keepsake-background-opacity").value)||0))/100;
  previewCtx.clearRect(0,0,preview.width,preview.height);previewCtx.save();previewCtx.globalAlpha=backgroundOpacity;previewCtx.drawImage(source,0,0);previewCtx.restore();previewCtx.drawImage(keepsakeCutoutCanvas(),0,0);
}
function scheduleKeepsakeRender(){if(!keepsakeEditor.renderFrame)keepsakeEditor.renderFrame=requestAnimationFrame(()=>{keepsakeEditor.renderFrame=0;renderKeepsakeCanvases()})}
function maskImageDataFromCanvas(canvas){return canvas.getContext("2d",{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height)}
function dilatedMask(imageData,radius){
  const {width,height,data}=imageData,r=Math.max(0,Math.round(radius));if(!r)return new ImageData(new Uint8ClampedArray(data),width,height);
  const stride=width+1,integral=new Uint32Array((height+1)*stride);
  for(let y=0;y<height;y++){let row=0;for(let x=0;x<width;x++){row+=data[(y*width+x)*4+3]>20?1:0;integral[(y+1)*stride+x+1]=integral[y*stride+x+1]+row}}
  const output=new ImageData(width,height),pixels=output.data;
  for(let y=0;y<height;y++){const top=Math.max(0,y-r),bottom=Math.min(height-1,y+r);for(let x=0;x<width;x++){const left=Math.max(0,x-r),right=Math.min(width-1,x+r),count=integral[(bottom+1)*stride+right+1]-integral[top*stride+right+1]-integral[(bottom+1)*stride+left]+integral[top*stride+left];if(count){const i=(y*width+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=pixels[i+3]=255}}}
  return output;
}
function softenedMask(imageData,radius=1){
  const {width,height,data}=imageData,r=Math.max(1,Math.round(radius)),stride=width+1,integral=new Uint32Array((height+1)*stride);
  for(let y=0;y<height;y++){let row=0;for(let x=0;x<width;x++){row+=data[(y*width+x)*4+3];integral[(y+1)*stride+x+1]=integral[y*stride+x+1]+row}}
  const output=new ImageData(width,height),pixels=output.data;
  for(let y=0;y<height;y++){const top=Math.max(0,y-r),bottom=Math.min(height-1,y+r);for(let x=0;x<width;x++){const left=Math.max(0,x-r),right=Math.min(width-1,x+r),count=(bottom-top+1)*(right-left+1),alpha=Math.round((integral[(bottom+1)*stride+right+1]-integral[top*stride+right+1]-integral[(bottom+1)*stride+left]+integral[top*stride+left])/count),i=(y*width+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=255;pixels[i+3]=alpha}}
  return output;
}
function applyKeepsakeExpansion({history=false}={}){
  if(!keepsakeEditor.autoBase||!keepsakeEditor.maskCanvas)return;
  if(history)pushKeepsakeHistory();
  const value=Number($("#keepsake-edge-expansion").value),radius=Math.round(Math.max(keepsakeEditor.maskCanvas.width,keepsakeEditor.maskCanvas.height)*value/1000);
  keepsakeEditor.maskCanvas.getContext("2d").putImageData(softenedMask(dilatedMask(keepsakeEditor.autoBase,radius),Math.max(1,Math.round(Math.max(keepsakeEditor.maskCanvas.width,keepsakeEditor.maskCanvas.height)/800))),0,0);
  keepsakeEditor.mediaDirty=true;
  scheduleKeepsakeRender();
}
function keepsakeWorkingImage(maxSide){
  const source=keepsakeEditor.sourceCanvas,scale=Math.min(1,maxSide/Math.max(source.width,source.height)),width=Math.max(1,Math.round(source.width*scale)),height=Math.max(1,Math.round(source.height*scale)),canvas=blankCanvas(width,height);
  canvas.getContext("2d").drawImage(source,0,0,width,height);
  return canvas;
}
async function applySegmentedKeepsakeMask(cutoutUrl,serial){
  const target=keepsakeEditor.maskCanvas,cutout=await loadImageSource(cutoutUrl);
  if(serial!==keepsakeEditor.segmentSerial||target!==keepsakeEditor.maskCanvas)return false;
  const temp=blankCanvas(target.width,target.height),tempCtx=temp.getContext("2d",{willReadFrequently:true});
  tempCtx.drawImage(cutout,0,0,temp.width,temp.height);
  const cutoutData=tempCtx.getImageData(0,0,temp.width,temp.height),maskData=new ImageData(temp.width,temp.height);
  for(let i=0;i<cutoutData.data.length;i+=4)maskData.data[i]=maskData.data[i+1]=maskData.data[i+2]=maskData.data[i+3]=cutoutData.data[i+3];
  target.getContext("2d").putImageData(maskData,0,0);
  keepsakeEditor.autoBase=maskImageDataFromCanvas(target);keepsakeEditor.source="auto";keepsakeEditor.mediaDirty=true;applyKeepsakeExpansion();
  return true;
}
function keepsakeSegmentationDataUrl(){
  return keepsakeWorkingImage(1600).toDataURL("image/jpeg",.9);
}
function keepsakeUnderstandingDataUrl(){
  return keepsakeWorkingImage(1200).toDataURL("image/jpeg",.88)
}
function keepsakeCandidateFields(){
  return{title:$("#keepsake-title").value,tags:keepsakeTagsFromInput().join(" "),note:$("#keepsake-note").value}
}
async function understandCurrentKeepsake(){
  const button=$("#keepsake-understand"),status=$("#keepsake-understanding-status"),form=$("#keepsake-form");if(!keepsakeEditor.sourceCanvas){status.textContent="请先放入一张照片。";return false}
  const serial=++keepsakeEditor.understandingSerial,owner=currentUser?.id,session=sessionSerial,requestId=crypto.randomUUID(),batchItem=activeKeepsakeBatchItem(),targetId=$("#keepsake-id").value||batchItem?.itemId||(form.dataset.candidateTargetId||=crypto.randomUUID()),baseline=keepsakeCandidateFields();
  if(batchItem){batchItem.understandingState="pending";batchItem.candidateRequestId=requestId;renderKeepsakeBatch();void persistKeepsakeBatch({capture:false})}
  button.disabled=true;status.textContent="正在识别名称、备注与已有标签…";
  try{
    const existingTags=uniqueKeepsakeTags((state.keepsakes||[]).flatMap(item=>item.tags||[]));
    const result=await request("/api/keepsakes/understand",{method:"POST",body:JSON.stringify({requestId,targetId,inputVersion:serial,image:keepsakeUnderstandingDataUrl(),existingTags})});
    if(serial!==keepsakeEditor.understandingSerial||owner!==currentUser?.id||session!==sessionSerial||result.requestId!==requestId||result.targetId!==targetId||Number(result.inputVersion)!==serial)return false;
    const merged=applyKeepsakeImageCandidates(keepsakeCandidateFields(),baseline,result,{existingTags});
    $("#keepsake-title").value=merged.value.title;setKeepsakeTags(splitTags(merged.value.tags));$("#keepsake-note").value=merged.value.note;
    if(batchItem===activeKeepsakeBatchItem()){batchItem.understandingState="ready";captureActiveKeepsakeBatchItem({captureMask:false});await persistKeepsakeBatch({capture:false});renderKeepsakeBatch()}
    const labels={title:"名称",tags:"标签",note:"备注"};
    status.textContent=merged.applied.length?`已填入${merged.applied.map(key=>labels[key]).join("、")}候选，可继续修改。`:"候选已生成；现有手动内容保持不变。";
    return true
  }catch(error){
    if(serial!==keepsakeEditor.understandingSerial)return false;
    status.textContent=`字段候选未完成：${error.message}`;
    if(batchItem===activeKeepsakeBatchItem()){batchItem.understandingState="failed";await persistKeepsakeBatch({capture:false});renderKeepsakeBatch()}
    return false
  }finally{if(serial===keepsakeEditor.understandingSerial)button.disabled=false}
}
const keepsakeBatchDraftKey="keepsake-batch";
function activeKeepsakeBatchItem(){
  return keepsakeBatch.items[keepsakeBatch.activeIndex]||null
}
function keepsakeBatchStatus(item,index){
  if(item.status==="saving")return"正在保存";
  if(item.status==="uploading")return"正在上传";
  if(item.status==="failed")return item.lastError?.message||"失败，可重试";
  if(item.alphaMask)return"已编辑，待保存";
  return index===keepsakeBatch.activeIndex?"正在编辑":"待编辑"
}
function revokeKeepsakeBatchPreviews(){
  keepsakeBatchPreviewUrls.forEach(url=>URL.revokeObjectURL(url));keepsakeBatchPreviewUrls=[]
}
function renderKeepsakeBatch(){
  const section=$("#keepsake-batch"),list=$("#keepsake-batch-list");if(!section||!list)return;
  const items=keepsakeBatch.items;section.hidden=!items.length;$("#keepsake-batch-count").textContent=items.length?`${items.length} 件`:"";
  revokeKeepsakeBatchPreviews();keepsakeBatchPreviewUrls=items.map(item=>URL.createObjectURL(item.file));
  list.innerHTML=items.map((item,index)=>`<article class="keepsake-batch-item${index===keepsakeBatch.activeIndex?" active":""}${item.status==="failed"?" failed":""}">
    <button class="keepsake-batch-select" type="button" data-keepsake-batch-select="${index}" aria-pressed="${index===keepsakeBatch.activeIndex}">
      <img src="${keepsakeBatchPreviewUrls[index]}" alt=""><span><b>${escapeHtml(item.title||item.file?.name||`小物 ${index+1}`)}</b><small>${escapeHtml(keepsakeBatchStatus(item,index))}</small></span>
    </button>
    <button class="keepsake-batch-remove" type="button" data-keepsake-batch-remove="${index}" aria-label="取消第 ${index+1} 件小物" ${item.status==="saving"?"disabled":""}>×</button>
  </article>`).join("");
  $("#keepsake-upload-box").hidden=Boolean(items.length);
  $("#keepsake-editor").hidden=!items.length&&!$("#keepsake-id").value
}
function keepsakeMaskHasSubject(){
  const data=keepsakeEditor.maskCanvas?maskImageDataFromCanvas(keepsakeEditor.maskCanvas).data:null;
  if(!data)return false;
  for(let index=3;index<data.length;index+=4)if(data[index]>20)return true;
  return false
}
function captureActiveKeepsakeBatchItem({captureMask=true}={}){
  const item=activeKeepsakeBatchItem(),form=$("#keepsake-form");
  if(!item||form.dataset.batchItemId!==item.itemId||!keepsakeEditor.sourceCanvas)return;
  const hasMask=captureMask&&keepsakeMaskHasSubject();
  Object.assign(item,{
    title:$("#keepsake-title").value,
    occurredAt:$("#keepsake-datetime").value,
    tags:keepsakeTagsFromInput().join(" "),
    note:$("#keepsake-note").value,
    edgeExpansion:Number($("#keepsake-edge-expansion").value)||0,
    backgroundOpacityPct:Number($("#keepsake-background-opacity").value)||0,
    source:keepsakeEditor.source,
    alphaMask:hasMask?keepsakeEditor.maskCanvas.toDataURL("image/png"):item.alphaMask,
    status:["uploading","saving","failed"].includes(item.status)?item.status:hasMask||item.alphaMask?"ready":"editing"
  })
}
async function persistKeepsakeBatch({capture=true}={}){
  const owner=currentUser?.id;if(!owner)return;
  if(capture)captureActiveKeepsakeBatchItem();
  if(!keepsakeBatch.items.length){await mediaDraftStore.delete(owner,keepsakeBatchDraftKey);return}
  await mediaDraftStore.put({
    owner,id:keepsakeBatchDraftKey,activeIndex:keepsakeBatch.activeIndex,updatedAt:new Date().toISOString(),
    items:keepsakeBatch.items.map(item=>({
      ...item,
      blob:item.file,
      name:item.file?.name||"keepsake",
      type:item.file?.type||"application/octet-stream",
      lastModified:Number(item.file?.lastModified)||Date.now(),
      file:undefined
    }))
  })
}
async function loadKeepsakeBatchItem(index,{capture=true}={}){
  if(keepsakeBatch.loading||!keepsakeBatch.items[index])return false;
  if(capture){const previous=activeKeepsakeBatchItem();if(previous?.understandingState==="pending")previous.understandingState="waiting";await persistKeepsakeBatch()}
  keepsakeBatch.loading=true;resetKeepsakeEditor();keepsakeBatch.activeIndex=index;const item=keepsakeBatch.items[index],serial=keepsakeEditor.segmentSerial;
  $("#keepsake-workspace").hidden=false;$("#keepsake-form").dataset.batchItemId=item.itemId;$("#keepsake-editor-eyebrow").textContent=`批次 ${index+1} / ${keepsakeBatch.items.length}`;$("#keepsake-editor-title").textContent=item.title||`第 ${index+1} 件小物`;
  renderKeepsakeBatch();
  try{
    const[dataUrl]=await imageDataUrls([item.file]);
    if(serial!==keepsakeEditor.segmentSerial||item!==activeKeepsakeBatchItem())return false;
    if(!await prepareKeepsakeImage({dataUrl,file:item.file,cutoutUrl:item.alphaMask||"",auto:false,serial}))return false;
    $("#keepsake-title").value=item.title;setOccurrenceMode($("#keepsake-datetime"),"manual");$("#keepsake-datetime").value=item.occurredAt||localDateTimeForDate(activeDate);setKeepsakeTags(splitTags(item.tags));$("#keepsake-note").value=item.note;$("#keepsake-edge-expansion").value=String(item.edgeExpansion);$("#keepsake-edge-output").value=String(item.edgeExpansion);$("#keepsake-background-opacity").value=String(item.backgroundOpacityPct??15);$("#keepsake-background-output").value=`${item.backgroundOpacityPct??15}%`;
    $("#keepsake-save").textContent=keepsakeBatch.items.length>1?`保存第 ${index+1} 件`:"保存小物";$("#keepsake-save-status").textContent=item.lastError?.message||"";
    item.status=item.alphaMask?"ready":"editing";renderKeepsakeBatch();
    if(!item.alphaMask)void segmentCurrentKeepsake();
    return true
  }catch(error){item.status="failed";item.lastError={message:error.message};$("#keepsake-segment-status").textContent=error.message;renderKeepsakeBatch();return false}
  finally{keepsakeBatch.loading=false;void persistKeepsakeBatch({capture:false})}
}
async function setKeepsakeBatchFiles(files,source="本地文件"){
  const current=keepsakeBatch.items,nextFiles=[...current.map(item=>item.file),...files],validated=validatedImageFiles(nextFiles,KEEPSAKE_BATCH_MAX_ITEMS),created=createKeepsakeBatchItems(validated.slice(current.length),{occurredAt:localDateTimeForDate(activeDate)});
  keepsakeBatch.items=[...current,...created];if(!current.length)keepsakeBatch.activeIndex=0;
  $("#keepsake-workspace").hidden=false;renderKeepsakeBatch();await persistKeepsakeBatch();
  if(!current.length)await loadKeepsakeBatchItem(0,{capture:false});
  $("#keepsake-segment-status").textContent=`${source} · 已加入 ${created.length} 张，批次共 ${keepsakeBatch.items.length} 件。`;
  return true
}
async function restoreKeepsakeBatch(owner){
  if(!owner||keepsakeBatch.items.length)return false;
  const stored=await mediaDraftStore.get(owner,keepsakeBatchDraftKey);if(!stored?.items?.length)return false;
  keepsakeBatch.items=stored.items.slice(0,KEEPSAKE_BATCH_MAX_ITEMS).map(item=>{
    const{category:legacyCategory,...draft}=item;void legacyCategory;
    return{
      ...draft,
      understandingState:item.understandingState==="ready"?"ready":"waiting",
      candidateRequestId:"",
      file:typeof File==="function"?new File([item.blob],item.name||"keepsake",{type:item.type||item.blob?.type||"",lastModified:Number(item.lastModified)||Date.now()}):item.blob,
      blob:undefined
    }
  });
  keepsakeBatch.activeIndex=Math.max(0,Math.min(Number(stored.activeIndex)||0,keepsakeBatch.items.length-1));renderKeepsakeBatch();
  return true
}
async function removeKeepsakeBatchItem(index,{discard=true}={}){
  captureActiveKeepsakeBatchItem();const previousIndex=keepsakeBatch.activeIndex,wasActive=index===previousIndex,[item]=keepsakeBatch.items.splice(index,1);if(!item)return;
  if(discard&&item.mediaPaths&&item.uploadRequestId)await discardKeepsakeMedia({request,attachmentPaths:item.mediaPaths.attachmentPaths||Object.values(item.mediaPaths),uploadRequestId:item.uploadRequestId}).catch(()=>{});
  keepsakeBatch.activeIndex=wasActive?nextKeepsakeBatchIndex(keepsakeBatch.items,index):Math.max(0,previousIndex-(index<previousIndex?1:0));
  if(keepsakeBatch.items.length){await persistKeepsakeBatch();renderKeepsakeBatch();if(wasActive)await loadKeepsakeBatchItem(keepsakeBatch.activeIndex,{capture:false})}
  else{await mediaDraftStore.delete(currentUser?.id,keepsakeBatchDraftKey);resetKeepsakeEditor();renderKeepsakeBatch()}
}
function clearKeepsakeBatchState(){
  clearTimeout(keepsakeBatchPersistTimer);keepsakeBatchPersistTimer=0;revokeKeepsakeBatchPreviews();keepsakeBatch.items=[];keepsakeBatch.activeIndex=0;keepsakeBatch.loading=false;renderKeepsakeBatch()
}
function scheduleKeepsakeBatchPersist(){
  captureActiveKeepsakeBatchItem({captureMask:false});const item=activeKeepsakeBatchItem(),card=item&&document.querySelector(`[data-keepsake-batch-select="${keepsakeBatch.activeIndex}"]`);
  if(card){card.querySelector("b").textContent=item.title||item.file?.name||`小物 ${keepsakeBatch.activeIndex+1}`;card.querySelector("small").textContent=keepsakeBatchStatus(item,keepsakeBatch.activeIndex)}
  clearTimeout(keepsakeBatchPersistTimer);keepsakeBatchPersistTimer=setTimeout(()=>void persistKeepsakeBatch({capture:false}),250)
}
function resetKeepsakeEditor({close=false}={}){
  const pendingCandidate=activeKeepsakeBatchItem();if(pendingCandidate?.understandingState==="pending")pendingCandidate.understandingState="waiting";
  keepsakeEditor.segmentSerial+=1;keepsakeEditor.understandingSerial+=1;keepsakeEditor.file=null;keepsakeEditor.sourceDataUrl="";keepsakeEditor.sourceImage=null;keepsakeEditor.sourceCanvas=null;keepsakeEditor.maskCanvas=null;keepsakeEditor.autoBase=null;keepsakeEditor.source="manual";keepsakeEditor.originalPath="";keepsakeEditor.cutoutPath="";keepsakeEditor.mediaDirty=false;keepsakeEditor.drawing=false;keepsakeEditor.lastPoint=null;
  keepsakeEditor.mode="keep";$("#keepsake-brush-keep").classList.add("active");$("#keepsake-brush-erase").classList.remove("active");$("#keepsake-brush-keep").setAttribute("aria-pressed","true");$("#keepsake-brush-erase").setAttribute("aria-pressed","false");
  $("#keepsake-auto-segment").disabled=false;
  clearKeepsakeHistory();$("#keepsake-form").reset();delete $("#keepsake-form").dataset.batchItemId;delete $("#keepsake-form").dataset.requestId;delete $("#keepsake-form").dataset.uploadRequestId;delete $("#keepsake-form").dataset.candidateTargetId;$("#keepsake-id").value="";resetOccurrenceInput($("#keepsake-datetime"));$("#keepsake-edge-expansion").value="8";$("#keepsake-edge-output").value="8";$("#keepsake-background-opacity").value="15";$("#keepsake-background-output").value="15%";$("#keepsake-image").value="";$("#keepsake-tag-toggle").setAttribute("aria-expanded","false");setKeepsakeTags([]);$("#keepsake-editor").hidden=true;$("#keepsake-editor").removeAttribute("aria-busy");$("#keepsake-upload-box").hidden=false;$("#keepsake-upload-box").classList.remove("dragging","has-image");$("#keepsake-upload-title").textContent="选择、粘贴或拖入 1–8 张小物照片";$("#keepsake-upload-hint").textContent="每张逐项编辑与保存 · PNG / JPEG / WebP · 单张 8 MB · 批次合计 48 MB";$("#keepsake-segment-status").textContent="";$("#keepsake-understanding-status").textContent="";$("#keepsake-understand").disabled=true;$("#keepsake-save-status").textContent="";$("#keepsake-save").textContent="保存小物";$("#keepsake-save").disabled=false;$("#keepsake-cancel-edit").hidden=true;$("#keepsake-editor-eyebrow").textContent="新建留存";$("#keepsake-editor-title").textContent="拍下或放入一张照片";
  if(close)$("#keepsake-workspace").hidden=true;
}
function invalidateKeepsakeSegmentation(){keepsakeEditor.segmentSerial+=1;$("#keepsake-auto-segment").disabled=false}
async function prepareKeepsakeImage({dataUrl,file=null,cutoutUrl="",auto=true,mediaDirty=true,serial=++keepsakeEditor.segmentSerial}){
  const image=await loadImageSource(dataUrl),maxSide=1600,scale=Math.min(1,maxSide/Math.max(image.naturalWidth,image.naturalHeight)),width=Math.max(1,Math.round(image.naturalWidth*scale)),height=Math.max(1,Math.round(image.naturalHeight*scale)),sourceCanvas=blankCanvas(width,height),maskCanvas=blankCanvas(width,height);
  if(serial!==keepsakeEditor.segmentSerial)return false;
  sourceCanvas.getContext("2d").drawImage(image,0,0,width,height);
  if(cutoutUrl){const cutout=await loadImageSource(cutoutUrl),temp=blankCanvas(width,height),tempCtx=temp.getContext("2d",{willReadFrequently:true});tempCtx.drawImage(cutout,0,0,width,height);const sourceData=tempCtx.getImageData(0,0,width,height),maskData=new ImageData(width,height);for(let i=0;i<sourceData.data.length;i+=4)maskData.data[i]=maskData.data[i+1]=maskData.data[i+2]=maskData.data[i+3]=sourceData.data[i+3];maskCanvas.getContext("2d").putImageData(maskData,0,0)}
  if(serial!==keepsakeEditor.segmentSerial)return false;
  keepsakeEditor.file=file;keepsakeEditor.sourceDataUrl=dataUrl;keepsakeEditor.sourceImage=image;keepsakeEditor.sourceCanvas=sourceCanvas;keepsakeEditor.maskCanvas=maskCanvas;keepsakeEditor.autoBase=null;keepsakeEditor.source="manual";keepsakeEditor.mediaDirty=mediaDirty;clearKeepsakeHistory();
  $("#keepsake-upload-box").hidden=true;$("#keepsake-editor").hidden=false;$("#keepsake-understand").disabled=false;renderKeepsakeCanvases();
  if(auto)await segmentCurrentKeepsake();
  return true;
}
async function setKeepsakeFile(file,source="本地文件"){
  const status=$("#keepsake-segment-status");try{[file]=validatedImageFiles([file])}catch(error){status.textContent=error.message;return false}
  const serial=++keepsakeEditor.segmentSerial;$("#keepsake-auto-segment").disabled=false;
  $("#keepsake-workspace").hidden=false;status.textContent="正在读取照片…";
  try{const [dataUrl]=await imageDataUrls([file]);if(serial!==keepsakeEditor.segmentSerial)return false;if(!await prepareKeepsakeImage({dataUrl,file,auto:false,serial}))return false;keepsakeEditor.originalPath="";keepsakeEditor.cutoutPath="";status.textContent=`${source} · ${formatBytes(file.size)} · 正在识别主体…`;void segmentCurrentKeepsake();return true}catch(error){if(serial===keepsakeEditor.segmentSerial)status.textContent=error.message;return false}
}
async function segmentCurrentKeepsake(){
  const button=$("#keepsake-auto-segment"),status=$("#keepsake-segment-status");if(!keepsakeEditor.sourceDataUrl)return status.textContent="请先放入一张照片。";
  const serial=++keepsakeEditor.segmentSerial,owner=currentUser?.id,session=sessionSerial,requestId=crypto.randomUUID(),targetId=$("#keepsake-id").value||$("#keepsake-form").dataset.batchItemId||"keepsake-draft";button.disabled=true;status.textContent="正在识别主体，通常需要数秒…";pushKeepsakeHistory();
  try{
    const result=await request("/api/keepsakes/segment",{method:"POST",body:JSON.stringify({requestId,targetId,inputVersion:serial,image:keepsakeSegmentationDataUrl()})});
    if(serial!==keepsakeEditor.segmentSerial||owner!==currentUser?.id||session!==sessionSerial||(result.requestId&&result.requestId!==requestId))return;
    if(!result.cutout)throw new Error("服务未返回透明轮廓");
    if(!await applySegmentedKeepsakeMask(result.cutout,serial))return;
    status.textContent="自动轮廓已生成，可继续涂抹修正。";
    if(activeKeepsakeBatchItem()){captureActiveKeepsakeBatchItem();await persistKeepsakeBatch();renderKeepsakeBatch()}
  }catch(error){if(serial===keepsakeEditor.segmentSerial)status.textContent=`自动提取未完成：${error.message}。仍可手动涂抹。`}
  finally{if(serial===keepsakeEditor.segmentSerial)button.disabled=false}
}
function keepsakeCanvasPoint(event){
  const canvas=$("#keepsake-mask-canvas"),rect=canvas.getBoundingClientRect();
  return{x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height};
}
function paintKeepsakeStroke(from,to){
  const canvas=keepsakeEditor.maskCanvas;if(!canvas)return;const ctx=canvas.getContext("2d"),display=$("#keepsake-mask-canvas"),scale=canvas.width/display.getBoundingClientRect().width,size=Number($("#keepsake-brush-size").value)*scale;
  ctx.save();ctx.globalCompositeOperation=keepsakeEditor.mode==="erase"?"destination-out":"source-over";ctx.strokeStyle="#fff";ctx.fillStyle="#fff";ctx.lineWidth=size;ctx.lineCap="round";ctx.lineJoin="round";ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);ctx.stroke();ctx.beginPath();ctx.arc(to.x,to.y,size/2,0,Math.PI*2);ctx.fill();ctx.restore();keepsakeEditor.source="manual";keepsakeEditor.mediaDirty=true;scheduleKeepsakeRender();
}
function keepsakeImageMarkup(item,className="",loading="lazy",mode="list"){
  let imagePath="",backgroundPath="";
  try{({imagePath,backgroundPath=""}=keepsakeMediaSources(item,mode))}
  catch{
    const status=item.media?.status||item.derivativeState,label=status==="pending"?"正在生成":status==="failed"?"生成失败":"暂无图片";
    return `<span class="keepsake-image-stack ${className} is-unavailable" data-keepsake-media="${escapeHtml(item.id||"")}"><span class="keepsake-media-placeholder">${label}</span></span>`
  }
  if(mode==="home")backgroundPath="";
  const opacity=Math.max(0,Math.min(30,Number(item.backgroundOpacityPct??15)))/100;
  return `<span class="keepsake-image-stack ${className}" data-keepsake-media="${escapeHtml(item.id||imagePath)}" style="--keepsake-background-opacity:${opacity}">${backgroundPath?`<img class="keepsake-image-background" src="${escapeHtml(appUrl(backgroundPath))}" alt="" loading="${loading}">`:""}<img class="keepsake-image-cutout" src="${escapeHtml(appUrl(imagePath))}" alt="${escapeHtml(item.title)}" loading="${loading}"></span>`;
}
function placeKeepsakeImage(stack){
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
function setupKeepsakePlacements(root=document){
  root.querySelectorAll(".keepsake-card-image,.home-v02-keepsake-stack").forEach(placeKeepsakeImage)
}
function uniqueKeepsakeTags(values){
  const tags=[],seen=new Set();for(const value of values||[]){const tag=String(value||"").trim(),key=tag.toLocaleLowerCase("zh-CN");if(!tag||seen.has(key))continue;seen.add(key);tags.push(tag);if(tags.length===8)break}return tags
}
function keepsakeTagsFromInput(){return uniqueKeepsakeTags([...keepsakeDraftTags,...splitTags($("#keepsake-tags").value)])}
function setKeepsakeTags(values){
  keepsakeDraftTags=uniqueKeepsakeTags(values);$("#keepsake-tags").value="";renderKeepsakeTagSuggestions()
}
function commitKeepsakeTagInput(){
  const values=splitTags($("#keepsake-tags").value);if(!values.length)return false;
  keepsakeDraftTags=uniqueKeepsakeTags([...keepsakeDraftTags,...values]);$("#keepsake-tags").value="";renderKeepsakeTagSuggestions();scheduleKeepsakeBatchPersist();return true
}
function renderKeepsakeTagSuggestions(){
  const root=$("#keepsake-tag-suggestions"),selected=$("#keepsake-selected-tags"),toggle=$("#keepsake-tag-toggle");if(!root||!selected||!toggle)return;
  selected.innerHTML=keepsakeDraftTags.map(tag=>`<span>${escapeHtml(tag)}<button type="button" data-keepsake-tag-remove="${escapeHtml(tag)}" aria-label="移除标签 ${escapeHtml(tag)}">×</button></span>`).join("");
  const selectedKeys=new Set(keepsakeDraftTags.map(tag=>tag.toLocaleLowerCase("zh-CN"))),query=normalizedFeedSearch($("#keepsake-tags").value);
  const tags=uniqueKeepsakeTags((state.keepsakes||[]).flatMap(item=>item.tags||[])).filter(tag=>!selectedKeys.has(tag.toLocaleLowerCase("zh-CN"))&&(!query||normalizedFeedSearch(tag).includes(query)));
  root.innerHTML=tags.length?tags.map(tag=>`<button type="button" role="option" aria-selected="false" data-keepsake-tag-suggestion="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join(""):`<span class="keepsake-tag-empty">${query?"没有匹配项，按回车创建":"还没有可选标签"}</span>`;
  root.hidden=toggle.getAttribute("aria-expanded")!=="true"
}
function keepsakeTagsMarkup(tags){
  return (tags||[]).length?`<span class="keepsake-tags">${tags.map(tag=>`<span>#${escapeHtml(tag)}</span>`).join("")}</span>`:"";
}
function keepsakeDerivativeLabel(item){
  return item.derivativeState==="pending"?"正在生成清晰图":item.derivativeState==="failed"?"清晰图待重试":""
}
function keepsakeCardMarkup(item,loading="lazy"){
  const derivativeLabel=keepsakeDerivativeLabel(item);
  return `<article class="keepsake-card" data-keepsake-id="${escapeHtml(item.id)}"><button class="keepsake-card-open" type="button" data-keepsake-open="${escapeHtml(item.id)}" aria-label="查看 ${escapeHtml(item.title)} 详情">${keepsakeImageMarkup(item,"keepsake-card-image",loading)}<span class="keepsake-card-copy"><span class="keepsake-card-meta"><time>${formatDate(eventTimestamp(item))}</time></span><strong>${escapeHtml(item.title)}</strong>${derivativeLabel?`<span class="keepsake-derivative-state">${derivativeLabel}</span>`:""}${item.note?`<span class="keepsake-card-note">${escapeHtml(item.note)}</span>`:""}${keepsakeTagsMarkup(item.tags)}</span></button><div class="keepsake-card-actions">${item.derivativeState==="failed"?`<button type="button" data-keepsake-derive="${escapeHtml(item.id)}">重试清晰图</button>`:""}<button type="button" data-keepsake-edit="${escapeHtml(item.id)}">编辑</button><button type="button" class="danger" data-keepsake-delete="${escapeHtml(item.id)}">删除</button></div></article>`
}
function loadNextKeepsakePage(){
  const total=(state.keepsakes||[]).length,next=Math.min(total,keepsakeVisibleCount+KEEPSAKE_PAGE_SIZE);
  if(next===keepsakeVisibleCount)return;
  keepsakeVisibleCount=next;renderKeepsakes()
}
function observeNextKeepsakePage(){
  keepsakeLoadObserver?.disconnect();keepsakeLoadObserver=null;
  const sentinel=$("#keepsake-pagination");
  if(!sentinel||sentinel.hidden||typeof IntersectionObserver==="undefined")return;
  keepsakeLoadObserver=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))loadNextKeepsakePage()},{root:null,rootMargin:`${KEEPSAKE_PREFETCH_MARGIN_PX}px 0px`});
  keepsakeLoadObserver.observe(sentinel)
}
function scheduleKeepsakeDerivativeRefresh(){
  if(keepsakeDerivativeRefreshTimer||(state.keepsakes||[]).every(item=>item.derivativeState!=="pending"))return;
  const owner=currentUser?.id,session=sessionSerial;
  keepsakeDerivativeRefreshTimer=setTimeout(async()=>{
    keepsakeDerivativeRefreshTimer=0;if(owner!==currentUser?.id||session!==sessionSerial)return;
    try{await refreshState("keepsakes")}catch{}
    if(owner===currentUser?.id&&session===sessionSerial)scheduleKeepsakeDerivativeRefresh()
  },750)
}
function renderKeepsakeDetail(item){
  const original=activeKeepsakeView==="original",detail=$("#keepsake-detail");
  const derivativeLabel=keepsakeDerivativeLabel(item);
  detail.dataset.keepsakeId=item.id;
  detail.innerHTML=`<nav class="keepsake-detail-nav"><button class="book-back" type="button" data-keepsake-back>← 返回陈列</button><div class="keepsake-detail-actions">${item.derivativeState==="failed"?`<button class="text-button" type="button" data-keepsake-derive="${escapeHtml(item.id)}">重试清晰图</button>`:""}<button class="text-button" type="button" data-keepsake-edit="${escapeHtml(item.id)}">编辑</button><button class="text-button danger" type="button" data-keepsake-delete="${escapeHtml(item.id)}">删除</button></div></nav>
    <div class="keepsake-detail-layout">
      <section class="keepsake-detail-media">
        <div class="keepsake-detail-viewbar"><span>${original?"原始照片":derivativeLabel||`主体清晰 · 环境 ${Math.max(0,Math.min(30,Number(item.backgroundOpacityPct??15)))}%`}</span><div class="segmented-control" aria-label="图片显示方式"><button type="button" data-keepsake-view="presentation" aria-pressed="${String(!original)}" class="${original?"":"active"}">呈现</button><button type="button" data-keepsake-view="original" aria-pressed="${String(original)}" class="${original?"active":""}">原图</button></div></div>
        <div class="keepsake-detail-image-wrap">${keepsakeImageMarkup(original?{...item,originalPath:activeKeepsakeOriginalPath}:item,"keepsake-detail-image","eager",original?"original":"detail")}</div>
      </section>
      <section class="keepsake-detail-copy">
        <p class="eyebrow">小物留存</p>
        <h2>${escapeHtml(item.title)}</h2>
        <time datetime="${escapeHtml(eventTimestamp(item))}">${escapeHtml(formatDateKey(eventDate(item)))} · ${formatTime(eventTimestamp(item))}</time>
        ${keepsakeTagsMarkup(item.tags)}
        <p class="keepsake-detail-note">${item.note?escapeHtml(item.note):"没有留下文字备注。"}</p>
      </section>
    </div>`;
}
function renderKeepsakes(){
  const allItems=[...(state.keepsakes||[])].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a)));
  const items=allItems.filter(item=>matchesFeedSearch("keepsakes",item.title,item.tags,item.note));
  const owner=currentUser?.id||"";if(owner!==keepsakePaginationOwner){keepsakePaginationOwner=owner;keepsakeVisibleCount=KEEPSAKE_PAGE_SIZE}
  keepsakeVisibleCount=Math.max(KEEPSAKE_PAGE_SIZE,Math.min(keepsakeVisibleCount,Math.max(items.length,KEEPSAKE_PAGE_SIZE)));
  let detailItem=allItems.find(item=>item.id===activeKeepsakeId);if(activeKeepsakeId&&!detailItem){activeKeepsakeId="";activeKeepsakeView="presentation"}
  detailItem=allItems.find(item=>item.id===activeKeepsakeId);const inDetail=Boolean(detailItem),library=$(".keepsake-library"),detail=$("#keepsake-detail"),pagination=$("#keepsake-pagination");
  scheduleKeepsakeDerivativeRefresh();
  $("#view-keepsakes").classList.toggle("keepsake-detail-mode",inDetail);$("#keepsake-search-control").hidden=inDetail;$("#keepsake-count").textContent=allItems.length?feedCountLabel("keepsakes",items.length,allItems.length,"件"):"";$("#keepsake-library-count").textContent=feedCountLabel("keepsakes",items.length,allItems.length,"件");$("#keepsake-create-toggle").hidden=inDetail;library.hidden=inDetail;detail.hidden=!inDetail;renderKeepsakeTagSuggestions();
  if(inDetail){keepsakeLoadObserver?.disconnect();if(pagination)pagination.hidden=true;renderKeepsakeDetail(detailItem);return}
  detail.innerHTML="";
  const visibleItems=items.slice(0,keepsakeVisibleCount);
  $("#keepsake-grid").innerHTML=items.length?visibleItems.map((item,index)=>keepsakeCardMarkup(item,index<4?"eager":"lazy")).join(""):allItems.length?feedSearchEmpty("小物"):contentState({title:"还没有小物",body:"从一张照片开始，名称和轮廓之后都可以修改。",action:{command:"new-keepsake",label:"收第一件小物"}});
  if(pagination){pagination.hidden=!items.length||visibleItems.length>=items.length;$("#keepsake-pagination-status").textContent=`已显示 ${visibleItems.length} / ${items.length} 件`;$("#keepsake-load-more").hidden=pagination.hidden}
  requestAnimationFrame(()=>{setupKeepsakePlacements($("#keepsake-grid"));observeNextKeepsakePage()})
}
async function editKeepsake(id){
  const item=(state.keepsakes||[]).find(value=>value.id===id);if(!item)return;
  resetKeepsakeEditor();const serial=keepsakeEditor.segmentSerial;
  activeKeepsakeId="";activeKeepsakeView="presentation";renderKeepsakes();$("#keepsake-workspace").hidden=false;$("#keepsake-upload-box").hidden=true;$("#keepsake-editor").hidden=false;$("#keepsake-editor").setAttribute("aria-busy","true");$("#keepsake-editor-eyebrow").textContent="编辑留存";$("#keepsake-editor-title").textContent=item.title;$("#keepsake-id").value=item.id;$("#keepsake-title").value=item.title;resetOccurrenceInput($("#keepsake-datetime"),item);setKeepsakeTags(item.tags||[]);$("#keepsake-note").value=item.note||"";$("#keepsake-edge-expansion").value=String(item.edgeExpansion??8);$("#keepsake-edge-output").value=String(item.edgeExpansion??8);$("#keepsake-background-opacity").value=String(item.backgroundOpacityPct??15);$("#keepsake-background-output").value=`${item.backgroundOpacityPct??15}%`;$("#keepsake-save").textContent="保存修改";$("#keepsake-save").disabled=true;$("#keepsake-cancel-edit").hidden=false;$("#keepsake-segment-status").textContent="正在载入编辑图与蒙版…";$("#keepsake-workspace").scrollIntoView({behavior:"smooth",block:"start"});
  try{const original=await request(`/api/keepsakes/${encodeURIComponent(id)}/original`),media=keepsakeMediaSources(item,"edit"),[editImage,alphaMask]=await Promise.all([apiClient.readBlob(media.imagePath),apiClient.readBlob(media.alphaMaskPath)]),[dataUrl,cutoutUrl]=await Promise.all([dataUrlFromBlob(editImage),dataUrlFromBlob(alphaMask)]);if(serial!==keepsakeEditor.segmentSerial)return;if(!await prepareKeepsakeImage({dataUrl,cutoutUrl,auto:false,mediaDirty:false,serial}))return;keepsakeEditor.originalPath=original.originalPath;keepsakeEditor.cutoutPath=media.alphaMaskPath;keepsakeEditor.source=item.source||"manual";$("#keepsake-segment-status").textContent="编辑图与蒙版已载入，可涂抹修正或重新识别。"}catch(error){if(serial===keepsakeEditor.segmentSerial)$("#keepsake-segment-status").textContent=`编辑资源未能载入：${error.message}。可取消后重试。`}finally{if(serial===keepsakeEditor.segmentSerial){$("#keepsake-editor").removeAttribute("aria-busy");$("#keepsake-save").disabled=!keepsakeEditor.sourceCanvas}}
}
function openKeepsakeDetail(id){
  if(!(state.keepsakes||[]).some(item=>item.id===id))return;activeKeepsakeId=id;activeKeepsakeView="presentation";activeKeepsakeOriginalPath="";resetKeepsakeEditor({close:true});renderKeepsakes();window.scrollTo({top:0,behavior:"smooth"});
}
async function setKeepsakeDetailView(view){
  if(!activeKeepsakeId)return;
  const targetId=activeKeepsakeId;
  if(view==="original"&&!activeKeepsakeOriginalPath){
    const result=await request(`/api/keepsakes/${encodeURIComponent(targetId)}/original`);
    if(targetId!==activeKeepsakeId)return;
    activeKeepsakeOriginalPath=result.originalPath||"";
    if(!activeKeepsakeOriginalPath)throw new Error("原图不可用");
  }
  activeKeepsakeView=view==="original"?"original":"presentation";const item=(state.keepsakes||[]).find(value=>value.id===activeKeepsakeId);if(item)renderKeepsakeDetail(item);
}
function rotatingQuotes(){
  const quotes=[...(state.quotes||[])],tagNames=[...new Set(quotes.flatMap(item=>item.tags||[]))],selected=[],selectedIds=new Set();
  if(tagNames.length){for(let offset=0;offset<tagNames.length&&selected.length<3;offset++){const tag=tagNames[(quoteSkyIndex+offset)%tagNames.length],bucket=quotes.filter(item=>(item.tags||[]).includes(tag)&&!selectedIds.has(item.id));if(!bucket.length)continue;const item=bucket[(quoteSkyIndex+offset)%bucket.length];selected.push(item);selectedIds.add(item.id)}}
  for(let offset=0;offset<quotes.length&&selected.length<3;offset++){const item=quotes[(quoteSkyIndex+offset)%quotes.length];if(!selectedIds.has(item.id)){selected.push(item);selectedIds.add(item.id)}}
  return selected;
}
const quoteTagsMarkup=tags=>(tags||[]).length?`<div class="quote-tags">${tags.map(tag=>`<span>#${escapeHtml(tag)}</span>`).join("")}</div>`:"";
function stopQuoteBubbleScroll(){if(quoteScrollFrame)cancelAnimationFrame(quoteScrollFrame);quoteScrollFrame=0}
function runQuoteBubbleScroll(now){
  if(document.hidden||!$("#view-quotes").classList.contains("active")){quoteScrollFrame=0;return}
  let active=false;
  $$(".quote-bubble p.is-auto-scrolling").forEach(viewport=>{
    const scrollState=quoteScrollStates.get(viewport),maximum=viewport.scrollHeight-viewport.clientHeight;if(!scrollState||maximum<=1)return;
    active=true;const elapsed=Math.min(64,now-scrollState.lastTime)/1000;scrollState.lastTime=now;
    if(now<scrollState.resumeAt){scrollState.position=viewport.scrollTop;scrollState.velocity=0;viewport.classList.toggle("is-user-scrolling",scrollState.userPaused);return}
    scrollState.userPaused=false;viewport.classList.remove("is-user-scrolling");
    if(now<scrollState.holdUntil){scrollState.velocity=0;return}
    const remaining=scrollState.direction>0?maximum-scrollState.position:scrollState.position;
    if(remaining<=.25){scrollState.position=scrollState.direction>0?maximum:0;viewport.scrollTop=scrollState.position;scrollState.direction*=-1;scrollState.velocity=0;scrollState.holdUntil=now+800;return}
    const cruiseSpeed=14,acceleration=18,targetSpeed=Math.min(cruiseSpeed,Math.sqrt(2*acceleration*remaining)),currentSpeed=Math.abs(scrollState.velocity),speedStep=acceleration*elapsed;
    const speed=currentSpeed<targetSpeed?Math.min(targetSpeed,currentSpeed+speedStep):Math.max(targetSpeed,currentSpeed-speedStep);
    scrollState.velocity=scrollState.direction*speed;
    const next=scrollState.position+scrollState.velocity*elapsed;
    if(next>=maximum||next<=0){scrollState.position=scrollState.direction>0?maximum:0;viewport.scrollTop=scrollState.position;scrollState.direction*=-1;scrollState.velocity=0;scrollState.holdUntil=now+800}
    else{scrollState.position=next;viewport.scrollTop=next}
  });
  quoteScrollFrame=active?requestAnimationFrame(runQuoteBubbleScroll):0;
}
function setupQuoteBubbleScroll(){
  stopQuoteBubbleScroll();const now=performance.now(),reduceMotion=matchMedia("(prefers-reduced-motion: reduce)").matches;
  $$(".quote-bubble p").forEach(viewport=>{
    viewport.classList.remove("is-auto-scrolling");viewport.removeAttribute("tabindex");viewport.scrollTop=0;
    if(viewport.scrollHeight-viewport.clientHeight<=1)return;
    viewport.classList.add("is-auto-scrolling");viewport.tabIndex=0;
    quoteScrollStates.set(viewport,{direction:1,position:0,velocity:0,lastTime:now,resumeAt:now+1200,holdUntil:0,userPaused:false});
  });
  if(!reduceMotion&&$("#view-quotes").classList.contains("active")&&$$(".quote-bubble p.is-auto-scrolling").length)quoteScrollFrame=requestAnimationFrame(runQuoteBubbleScroll);
}
function deferQuoteBubbleScroll(viewport){const scrollState=quoteScrollStates.get(viewport);if(!scrollState)return;const now=performance.now();scrollState.direction=1;scrollState.position=viewport.scrollTop;scrollState.velocity=0;scrollState.lastTime=now;scrollState.resumeAt=now+5000;scrollState.holdUntil=0;scrollState.userPaused=true;viewport.classList.add("is-user-scrolling")}
function renderQuoteSky(advance=false){const sky=$("#quote-sky-content"),previousIds=new Set([...sky.querySelectorAll(".quote-bubble")].map(item=>item.dataset.quoteId));if(advance)quoteSkyIndex+=1;const items=rotatingQuotes();if(advance&&state.quotes.length>items.length&&items.every(item=>previousIds.has(item.id))){const alternate=state.quotes.find(item=>!previousIds.has(item.id));if(alternate)items[items.length-1]=alternate}sky.innerHTML=items.length?items.map(x=>{const visibleLines=3+Math.floor(Math.random()*3);return `<article class="quote-bubble" data-quote-id="${x.id}" data-visible-lines="${visibleLines}" style="--quote-content-max-height:${(visibleLines*1.72).toFixed(2)}em"><p><span class="quote-scroll-track">“<span class="quote-content">${escapeHtml(x.content)}</span>”</span></p>${quoteTagsMarkup(x.tags)}<small>— ${escapeHtml(x.source)}</small></article>`}).join(""):contentState({title:"还没有收藏的句子",body:"先留下原句和来源，它之后会在这里再次出现。",action:{focus:"quote-content",label:"收藏第一句"},className:"quote-sky-empty"});items.forEach(item=>markCommentTarget(sky.querySelector(`[data-quote-id="${CSS.escape(item.id)}"] .quote-content`),commentRootKey("quote",item.id),"content"));applyCommentAnchors(sky);requestAnimationFrame(setupQuoteBubbleScroll)}
function syncQuoteOverflow(){
  $$(".quote-entry").forEach(entry=>{
    const viewport=entry.querySelector(".quote-content-viewport"),button=entry.querySelector("[data-quote-expand]");if(!viewport||!button)return;
    const wasExpanded=expandedLongContentKeys.has(viewport.dataset.expandKey);viewport.classList.remove("expanded");
    const overflows=viewport.scrollHeight>viewport.clientHeight+1;
    viewport.classList.toggle("expanded",wasExpanded&&overflows);button.hidden=!overflows;button.textContent=wasExpanded&&overflows?"收起":"展开";button.setAttribute("aria-expanded",String(wasExpanded&&overflows));
  });
  scheduleAnnotationLineCounts()
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
function refreshQuoteTagCandidates(){
  for(const key of Object.keys(quoteTagPickerConfig)){
    quoteTagStates[key]=reduceTagMultiSelectState(quoteTagStates[key],{type:"set-candidates",values:quoteTagCandidates()});
    renderQuoteTagPicker(key)
  }
}
function renderQuotes(){
  const dateOf=eventDate,allItems=[...state.quotes].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a))),items=allItems.filter(item=>matchesFeedSearch("quotes",item.source,item.content,item.tags)),timeline=$("#quote-timeline");
  renderQuoteSky();
  timeline.innerHTML=items.length?items.map((item,index)=>{const syncing=item._sync?.status,actions=syncing?`<span class="checkin-sync-state ${escapeHtml(syncing)}">${syncing==="pending"?"待同步":"正在同步"}</span>`:`<button class="subtle-action" type="button" data-quote-edit="${item.id}">编辑</button><button class="subtle-action danger" type="button" data-quote-delete="${item.id}">删除</button>`;return`<article class="quote-entry${syncing?" is-syncing":""}" data-quote-id="${item.id}">${index===0||dateOf(item)!==dateOf(items[index-1])?`<div class="quote-date">${escapeHtml(dateOf(item))}</div>`:""}<header class="quote-entry-meta"><cite title="${escapeHtml(item.source)}">${escapeHtml(item.source)}</cite><span class="quote-entry-tools"><time>${formatTime(eventTimestamp(item))}</time>${actions}</span></header><div class="quote-entry-card card"><blockquote class="quote-content-viewport" data-expand-key="quote:${escapeHtml(item.id)}">${escapeHtml(item.content)}</blockquote><button class="quote-expand" type="button" data-quote-expand aria-expanded="false" hidden>展开</button>${quoteTagsMarkup(item.tags)}</div></article>`}).join(""):allItems.length?feedSearchEmpty("拾句"):"";
  items.filter(item=>!item._sync).forEach(item=>markCommentTarget(timeline.querySelector(`[data-quote-id="${CSS.escape(item.id)}"] blockquote`),commentRootKey("quote",item.id),"content"));
  applyCommentAnchors(timeline);refreshQuoteTagCandidates();requestAnimationFrame(syncQuoteOverflow);clearInterval(quoteTimer);
  if(state.quotes.length>3)quoteTimer=setInterval(()=>{if($("#view-quotes").classList.contains("active")&&!document.hidden&&!$("#quote-sky").matches(":hover"))renderQuoteSky(true)},24000);
}
function resetQuoteForm(){const form=$("#quote-form");form.reset();setQuoteTagPicker("quote");$("#quote-id").value="";resetOccurrenceInput($("#quote-datetime"));$("#quote-submit").textContent="收藏";$("#quote-cancel").hidden=true;$("#quote-status").textContent=""}
function editQuote(id){const quote=state.quotes.find(item=>item.id===id);if(!quote)return;$("#quote-id").value=id;$("#quote-source").value=quote.source;$("#quote-content").value=quote.content;setQuoteTagPicker("quote",quote.tags||[]);resetOccurrenceInput($("#quote-datetime"),quote);$("#quote-submit").textContent="保存修改";$("#quote-cancel").hidden=false;$("#quote-status").textContent="正在编辑已有善言";$("#quote-form").scrollIntoView({behavior:"smooth",block:"center"});$("#quote-content").focus()}
function selectionQuoteSource(rootKey){const root=commentRoot(rootKey),label=commentRootLabel(rootKey),{type}=parseCommentRootKey(rootKey);const title=type==="book"?root?.title:type==="journal"?root?.title||root?.content:type==="quote"?root?.source:type==="chat"?root?.message:root?.content;return `${label}${title?` · ${plainPreview(title).slice(0,60)}`:""}`}
function closeSelectionQuoteModal(){const modal=$("#selection-quote-modal");modal.hidden=true;$("#selection-quote-form").reset();setQuoteTagPicker("selectionQuote");$("#selection-quote-status").textContent=""}
function openSelectionQuoteModal(selection){const label=annotationsController.rootLabel(selection.rootKey);$("#selection-quote-content").value=selection.quote;$("#selection-quote-source").value=selectionQuoteSource(selection.rootKey);setQuoteTagPicker("selectionQuote",[label]);resetOccurrenceInput($("#selection-quote-datetime"));$("#selection-quote-status").textContent="";$("#selection-quote-modal").hidden=false;$("#selection-quote-content").focus()}
function llmProfile(scene="thoughtAnswer"){const tier=llmSettings.scenarios?.[scene]||"high",profile=llmSettings.profiles?.[tier]||defaultLlmProfiles[tier]||defaultLlmProfiles.high;return{tier,...profile,effort:llmSettings.sceneEfforts?.[scene]||profile.effort}}
function accountTtsVoice(){
  const voices=state.speech?.voices||[],preferred=String(llmSettings.speech?.defaultVoice||"");
  return preferred&&(!voices.length||voices.some(voice=>voice.id===preferred))?preferred:state.speech?.defaultVoice||voices[0]?.id||""
}
function renderTtsDefaultVoice(){
  const control=$("#tts-default-voice");if(!control)return;
  const voices=state.speech?.voices||[],voice=accountTtsVoice();
  control.innerHTML=voices.length?voices.map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join(""):`<option value="">语音服务未配置</option>`;
  control.disabled=!voices.length;if(voices.some(item=>item.id===voice))control.value=voice;syncVoicePreviewButton()
}
async function toggleTtsVoicePreview(){
  const control=$("#tts-default-voice"),status=$("#tts-voice-preview-status"),voice=String(control?.value||"");
  if(voicePreviewPlaying&&voicePreviewVoice===voice){stopVoicePreview({clearStatus:true});return}
  stopVoicePreview({clearStatus:true});
  let payload;
  try{payload=speechPreviewPayload(voice)}catch(error){if(status)status.textContent=error.message;return}
  voicePreviewPending=true;voicePreviewVoice=voice;if(status)status.textContent="正在加载官方试音…";syncVoicePreviewButton();
  try{
    const selected=(state.speech?.voices||[]).find(item=>item.id===voice),samplePath=String(selected?.samplePath||"");
    const audio=await pageAudioCoordinator.playBlob(({signal})=>samplePath
      ?apiClient.requestBlob(samplePath,{signal},{fallback:"试音暂时不可用"})
      :apiClient.requestBlob("/api/speech/preview",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload),signal},{fallback:"试音暂时不可用"}));
    if(!audio||control.value!==voice||!$("#view-settings").classList.contains("active")){if(audio)pageAudioCoordinator.stop(audio);return}
    voicePreviewAudio=audio;voicePreviewPlaying=true;
    const finish=failed=>{if(voicePreviewAudio!==audio)return;voicePreviewAudio=null;voicePreviewPlaying=false;voicePreviewVoice="";if(failed&&status)status.textContent="试音暂时无法播放，请稍后再试。";else if(status)status.textContent="";syncVoicePreviewButton()};
    audio.addEventListener("ended",()=>finish(false),{once:true});
    audio.addEventListener("error",()=>finish(true),{once:true});
    if(status)status.textContent="";
  }catch(error){
    if(voicePreviewVoice===voice){stopVoicePreview();if(status)status.textContent="试音暂时不可用，请稍后再试。"}
  }finally{
    if(voicePreviewVoice===voice)voicePreviewPending=false;
    syncVoicePreviewButton()
  }
}
function ttsGenerationRateText(value){return`${(1+normalizeTtsGenerationRate(value)/100).toFixed(2)}×`}
function renderTtsGenerationRate(value){const rate=normalizeTtsGenerationRate(value),text=ttsGenerationRateText(rate),control=$("#tts-generation-rate"),output=$("#tts-generation-rate-value");if(control){control.value=String(rate);control.setAttribute("aria-valuetext",text.replace("×","倍"));control.style.setProperty("--fill",`${((rate+50)/1.5).toFixed(2)}%`)}if(output)output.textContent=text}
function settingsPayload(){
  const payload={sceneEfforts:Object.fromEntries($$("[data-ai-effort]").map(select=>[select.dataset.aiEffort,select.value])),assistantName:$("#assistant-name").value,responseStyles:Object.fromEntries($$("[data-response-style]").map(select=>[select.dataset.responseStyle,select.value])),automaticAnswers:{thoughtAnswer:$("#automatic-thought-answer").checked},speech:{defaultVoice:$("#tts-default-voice")?.value||accountTtsVoice(),generationRate:normalizeTtsGenerationRate($("#tts-generation-rate")?.value)}};
  if(!hasCapability("ai-configuration"))return payload;
  const profiles=Object.fromEntries(llmTiers.map(tier=>[tier,{...(llmSettings.profiles?.[tier]||defaultLlmProfiles[tier]),model:$(`[data-profile-model="${tier}"]`).value}]));
  const visibleScenarios=Object.fromEntries($$("[data-ai-scenario]").map(select=>[select.dataset.aiScenario,select.value]));
  return{...payload,profiles,scenarios:{...llmSettings.scenarios,...visibleScenarios},apiKey:$("#llm-api-key").value}
}
function renderSettings(){
  if(!$("#llm-settings-form"))return;
  llmSettings.profiles={...structuredClone(defaultLlmProfiles),...(llmSettings.profiles||{})};llmSettings.scenarios={...defaultLlmScenarios,...(llmSettings.scenarios||{})};llmSettings.sceneEfforts={...defaultSceneEfforts,...(llmSettings.sceneEfforts||{})};llmSettings.automaticAnswers={thoughtAnswer:llmSettings.automaticAnswers?.thoughtAnswer===true};llmSettings.speech={defaultVoice:String(llmSettings.speech?.defaultVoice||""),generationRate:normalizeTtsGenerationRate(llmSettings.speech?.generationRate)};llmSettings.responseStyles=Object.fromEntries(responseStyleScenes.map(scene=>[scene,llmSettings.responseStyles?.[scene]||"standard"]));
  $("#automatic-thought-answer").checked=llmSettings.automaticAnswers.thoughtAnswer;$("#assistant-name").value=llmSettings.assistantName||"神鸡";renderTtsDefaultVoice();renderTtsGenerationRate(llmSettings.speech.generationRate);
  for(const tier of llmTiers){const model=$(`[data-profile-model="${tier}"]`);if(model)model.value=llmSettings.profiles[tier].model}
  $$("[data-ai-scenario]").forEach(select=>{if(!select.options.length)select.innerHTML=llmTiers.map(tier=>`<option value="${tier}">${tier[0].toUpperCase()+tier.slice(1)}</option>`).join("");select.value=llmSettings.scenarios[select.dataset.aiScenario]});
  $$("[data-ai-effort]").forEach(select=>{if(!select.options.length)select.innerHTML=llmEfforts.map(effort=>`<option value="${effort}">${effort==="none"?"关闭":effort==="high"?"High":"Max"}</option>`).join("");select.value=llmSettings.sceneEfforts[select.dataset.aiEffort]});
  $$("[data-response-style]").forEach(select=>{if(!select.options.length)select.innerHTML=responseStyleOptions.map(([value,label])=>`<option value="${value}">${label}</option>`).join("");select.value=llmSettings.responseStyles[select.dataset.responseStyle]||"standard"});
  const badge=$("#llm-key-state"),hint=$("#llm-key-hint");if(badge){badge.textContent=llmSettings.hasApiKey?"密钥已配置":"未配置密钥";badge.classList.toggle("ready",llmSettings.hasApiKey)}if(hint)hint.textContent=llmSettings.hasApiKey?`${llmSettings.keyHint} · 留空保留原密钥`:"仅保存在 Owner 账户";$("#chat-model-label").textContent="结合已保存记录"
}
function renderLocalTestSettings(){const panel=$("#local-test-settings"),mineSummary=$("#mine-settings-summary");if(!panel){if(mineSummary)mineSummary.textContent="配置助手称呼、回答风格与思考强度";return}panel.hidden=!localTestConfig?.enabled;if(panel.hidden){if(mineSummary)mineSummary.textContent="配置助手称呼、回答风格与思考强度";return}const modeLabel=localTestConfig.mode==="simulation"?"使用模拟":"冷启测试";if(mineSummary)mineSummary.textContent=`本地测试：使用模拟 / 冷启测试 · 当前${modeLabel}`;$$("[data-local-test-mode]").forEach(button=>{const active=button.dataset.localTestMode===localTestConfig.mode;button.classList.toggle("active",active);button.setAttribute("aria-pressed",String(active));button.disabled=active||(button.dataset.localTestMode==="simulation"&&!localTestConfig.upstreamConfigured)});$("#local-test-badge").textContent=modeLabel;const loadedCount=localTestConfig.loadedScopes?.length||0;$("#local-test-summary").textContent=localTestConfig.mode==="simulation"?`${localTestConfig.sourceUser?.username||"线上主账户"} · ${localTestConfig.recordCount||0} 条已载入 · ${loadedCount?`${loadedCount} 个页面已读取`:"打开页面后读取记录"}`:"空账户工作区；每次切换都会重新清空。";$("#local-test-status").textContent=localTestStatusOverride||(localTestConfig.mode==="simulation"?"当前为使用模拟；记录将在打开页面时读取。":"当前为冷启测试。")}
const shiftLocalDateKey=(dateKey,days)=>{const [year,month,day]=String(dateKey).split("-").map(Number),date=new Date(Date.UTC(year,month-1,day+days));return date.toISOString().slice(0,10)};
const compactNumber=value=>new Intl.NumberFormat("zh-CN",{notation:"compact",maximumFractionDigits:1}).format(Number(value)||0);
const formatCny=value=>{const number=Number(value)||0,absolute=Math.abs(number),digits=absolute===0?2:absolute>=100?0:absolute>=10?1:absolute>=1?2:absolute>=.1?3:absolute>=.01?4:6;return `${number<0?"-":""}¥${absolute.toFixed(digits)}`};
const formatCnyAxis=value=>{const number=Number(value)||0;return number!==0&&Math.abs(number)<.000001?`${number<0?"-":""}<¥0.000001`:formatCny(number)};
const formatDuration=value=>{const milliseconds=Number(value)||0;return milliseconds>=60000?`${(milliseconds/60000).toFixed(1)} 分钟`:milliseconds>=1000?`${(milliseconds/1000).toFixed(1)} 秒`:`${Math.round(milliseconds)} ms`};
const shortDate=value=>{const [,month,day]=String(value).split("-");return `${Number(month)}/${Number(day)}`};
const sceneLabels={thoughtPrompt:"思考引子",thoughtDraft:"思考草稿",thoughtAnswer:"思考回答",followUpAnswer:"追问回答",chat:"长期对话",diaryLead:"日记引子",diaryStructure:"日记结构",diaryTopic:"日记话题",diaryReflection:"日记回望",annotationShenji:"批注神鸡",analysis:"认知复盘",bookRecognition:"书目识别",healthRecognition:"健康识别",contentImageUnderstanding:"内容图片理解",capturePolish:"语音整理",lite:"连接测试",mid:"连接测试",high:"连接测试",ultra:"连接测试"};
const serviceUnitText=item=>(item?.unitUsage||[]).map(unit=>{
  if(unit.unitType==="token")return`${compactNumber(unit.units)} Token`;
  if(unit.unitType==="character")return`${compactNumber(unit.units)} 字符`;
  if(unit.unitType==="audioMillisecond")return formatDuration(unit.units);
  if(unit.unitType==="page")return`${compactNumber(unit.units)} 页`;
  if(unit.unitType==="image")return`${compactNumber(unit.units)} 张`;
  if(unit.unitType==="document")return`${compactNumber(unit.units)} 份`;
  if(unit.unitType==="call")return`${compactNumber(unit.units)} 次 API 调用`;
  return`${compactNumber(unit.units)} ${unit.unitType}`
}).join(" · ")||"—";
function chartFrame(daily,series,{ariaLabel,valueLabel=compactNumber,actualPeak=false}={}){
  const width=760,height=260,pad={left:54,right:18,top:16,bottom:38},plotWidth=width-pad.left-pad.right,plotHeight=height-pad.top-pad.bottom,peak=Math.max(0,...series.flatMap(item=>item.values).map(value=>Number(value)||0)),scaleMax=actualPeak?(peak||1):Math.max(1,peak),axisMax=actualPeak?peak:scaleMax,x=index=>pad.left+(daily.length<=1?plotWidth/2:index*plotWidth/(daily.length-1)),y=value=>pad.top+plotHeight-(Number(value)||0)/scaleMax*plotHeight;
  const grid=(actualPeak&&peak===0?[0]:[0,.5,1]).map(ratio=>{const py=pad.top+plotHeight*(1-ratio);return `<line x1="${pad.left}" y1="${py}" x2="${width-pad.right}" y2="${py}"></line><text x="${pad.left-9}" y="${py+4}" text-anchor="end">${escapeHtml(valueLabel(axisMax*ratio))}</text>`}).join("");
  const labelIndexes=[0,Math.floor((daily.length-1)/2),daily.length-1].filter((value,index,array)=>array.indexOf(value)===index);
  const dates=labelIndexes.map(index=>`<text x="${x(index)}" y="${height-12}" text-anchor="${index===0?"start":index===daily.length-1?"end":"middle"}">${escapeHtml(shortDate(daily[index]?.date||""))}</text>`).join("");
  const paths=series.map(item=>{const points=item.values.map((value,index)=>`${x(index)},${y(value)}`).join(" "),dots=item.values.length<=31?item.values.map((value,index)=>`<circle cx="${x(index)}" cy="${y(value)}" r="3"><title>${escapeHtml(`${item.label} · ${daily[index]?.date} · ${valueLabel(value)}`)}</title></circle>`).join(""):"";return `<g class="analytics-series" style="--series:${item.color}"><polyline points="${points}"></polyline>${dots}</g>`}).join("");
  const legend=series.map(item=>`<span><i style="--series:${item.color}"></i>${escapeHtml(item.label)}</span>`).join("");
  return `<svg class="analytics-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(ariaLabel||"统计图")}"><g class="analytics-grid">${grid}${dates}</g>${paths}</svg><div class="analytics-legend">${legend}</div>`;
}
function stackedTokenChart(daily){
  const width=760,height=260,pad={left:54,right:18,top:16,bottom:38},plotWidth=width-pad.left-pad.right,plotHeight=height-pad.top-pad.bottom,answer=daily.map(item=>item.tokens.answer||0),reasoning=daily.map(item=>item.tokens.reasoning||0),total=answer.map((value,index)=>value+reasoning[index]),max=Math.max(1,...total),x=index=>pad.left+(daily.length<=1?plotWidth/2:index*plotWidth/(daily.length-1)),y=value=>pad.top+plotHeight-value/max*plotHeight,path=values=>values.map((value,index)=>`${index?"L":"M"} ${x(index)} ${y(value)}`).join(" "),area=(top,bottom)=>`${path(top)} ${bottom.map((_,index)=>`L ${x(bottom.length-1-index)} ${y(bottom[bottom.length-1-index])}`).join(" ")} Z`;
  const grid=[0,.5,1].map(ratio=>{const py=pad.top+plotHeight*(1-ratio);return `<line x1="${pad.left}" y1="${py}" x2="${width-pad.right}" y2="${py}"></line><text x="${pad.left-9}" y="${py+4}" text-anchor="end">${escapeHtml(compactNumber(max*ratio))}</text>`}).join("");
  const labelIndexes=[0,Math.floor((daily.length-1)/2),daily.length-1].filter((value,index,array)=>array.indexOf(value)===index),dates=labelIndexes.map(index=>`<text x="${x(index)}" y="${height-12}" text-anchor="${index===0?"start":index===daily.length-1?"end":"middle"}">${escapeHtml(shortDate(daily[index]?.date||""))}</text>`).join("");
  return `<svg class="analytics-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="回答与推理 Token 每日面积图"><g class="analytics-grid">${grid}${dates}</g><path class="analytics-area answer" d="${area(answer,answer.map(()=>0))}"></path><path class="analytics-area reasoning" d="${area(total,answer)}"></path><path class="analytics-area-line answer" d="${path(answer)}"></path><path class="analytics-area-line reasoning" d="${path(total)}"></path></svg><div class="analytics-legend"><span><i style="--series:#4f8d78"></i>回答</span><span><i style="--series:#c18c3f"></i>推理</span></div>`;
}
function renderStatistics(data){
  statisticsData=data;
  const {records,ai}=data;
  $("#record-total").innerHTML=`<strong>${records.total}</strong><span>累计条目</span>`;
  $("#record-stat-sections").innerHTML=(records.groups||[]).map(group=>`<section class="record-stat-section"><header><h3>${escapeHtml(group.label)}</h3><span>${group.total} 项</span></header><div class="record-module-list">${group.modules.map(module=>`<article><div class="record-module-title"><b>${escapeHtml(module.label)}</b><strong>${module.total}</strong></div><dl>${module.items.map(item=>`<div><dt>${escapeHtml(item.label)}</dt><dd>${item.count}</dd></div>`).join("")}</dl></article>`).join("")}</div></section>`).join("");
  const title=$("#statistics-page-title");if(title)title.textContent=ai?"留下了什么，也看见如何使用 AI":"留下了什么";
  if(!ai)return;
  const summary=ai.summary,cnyPerUsd=Math.max(.01,Number(ai.pricing?.cnyPerUsd)||7.2),historicalUsdToCny=value=>(Number(value)||0)*cnyPerUsd,totalCost=item=>historicalUsdToCny(item?.costsUsd?.total)+(Number(item?.costCny)||0),componentCost=(item,key)=>(Number(item?.costsCny?.[key])||0)+historicalUsdToCny(item?.costsUsd?.[key]);
  const totalTokens=summary.tokens.input+summary.tokens.output,cacheRate=summary.tokens.input?summary.tokens.cacheHit/summary.tokens.input*100:0,totalCostCny=totalCost(summary),averageCost=summary.calls?totalCostCny/summary.calls:0,knownStatuses=(summary.successfulCalls||0)+(summary.failedCalls||0),successRate=knownStatuses?(summary.successfulCalls||0)/knownStatuses*100:null,averageDuration=summary.durationKnownCalls?(summary.durationMs||0)/summary.durationKnownCalls:0,vision=ai.modalities?.find(item=>item.modality==="vision")||{calls:summary.visionCalls||0,imageCount:summary.imageCount||0,costsUsd:{total:0},costCny:0};
  $("#ai-kpis").innerHTML=[
    ["总费用",formatCny(totalCostCny),summary.costUnknownCalls?`${summary.costUnknownCalls} 次供应商调用费用待账单核对`:"按官方单价折算"],
    ["调用次数",compactNumber(summary.calls),"次"],
    ["成功率",successRate==null?"未知":`${successRate.toFixed(successRate>=10?0:1)}%`,`${summary.failedCalls||0} 次失败 · ${summary.unknownStatusCalls||0} 次历史未知`],
    ["图片理解",compactNumber(vision.calls),`${compactNumber(vision.imageCount)} 张 · ${formatCny(totalCost(vision))}`],
    ["总 Token",compactNumber(totalTokens),"输入与输出"],
    ["缓存命中率",`${cacheRate.toFixed(cacheRate>=10?0:1)}%`,`${compactNumber(summary.tokens.cacheHit)} Token`],
    ["平均费用",formatCny(averageCost),"每次实际请求"],
    ["平均响应",summary.durationKnownCalls?formatDuration(averageDuration):"未知",`${summary.usageUnknownCalls||0} 次用量未知`]
  ].map(([label,value,note])=>`<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
  $("#ai-tracking-since").textContent=`自 ${new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(ai.trackingStartedAt))} 开始统计`;
  const serviceColors={deepseekText:"#4f8d78",deepseekVision:"#3f7f91",volcengineTts:"#a65f4b",volcengineAsr:"#b77f48",volcengineOcr:"#5c7891",volcengineDocument:"#77658c",aliyunSegmentation:"#c18c3f"},fallbackServiceColors=["#547d87","#9a7052","#6f7651"];
  const callSeries=(ai.services||[]).map((service,index)=>({label:service.label,color:serviceColors[service.key]||fallbackServiceColors[index%fallbackServiceColors.length],values:ai.daily.map(day=>day.services?.[service.key]?.calls||0)}));
  $("#ai-calls-chart").innerHTML=chartFrame(ai.daily,callSeries,{ariaLabel:"多供应商服务每日调用次数",valueLabel:value=>String(Math.round(value))});
  $("#ai-service-summary").innerHTML=`<table><thead><tr><th>服务</th><th>调用</th><th>成功 / 失败</th><th>单位用量</th><th>已知费用</th><th>待账单</th></tr></thead><tbody>${(ai.services||[]).map(service=>`<tr><td>${escapeHtml(service.label)}</td><td>${service.calls}</td><td>${service.successfulCalls||0} / ${service.failedCalls||0}</td><td>${escapeHtml(serviceUnitText(service))}</td><td>${formatCny(totalCost(service))}</td><td>${service.costUnknownCalls?`${service.costUnknownCalls} 次`:"0 次"}</td></tr>`).join("")}</tbody></table>`;
  $("#ai-token-chart").innerHTML=stackedTokenChart(ai.daily);
  $("#ai-modality-summary").innerHTML=`<table><thead><tr><th>输入方式</th><th>调用</th><th>成功</th><th>图片</th><th>总 Token</th><th>费用</th><th>平均响应</th></tr></thead><tbody>${(ai.modalities||[]).map(item=>`<tr><td>${escapeHtml(item.label)}</td><td>${item.calls}</td><td>${item.successfulCalls||0}</td><td>${item.imageCount||0}</td><td>${compactNumber((item.tokens?.input||0)+(item.tokens?.output||0))}</td><td>${formatCny(totalCost(item))}${item.costUnknownCalls?` + ${item.costUnknownCalls} 次待账单`:""}</td><td>${item.durationKnownCalls?formatDuration((item.durationMs||0)/item.durationKnownCalls):"未知"}</td></tr>`).join("")}</tbody></table>`;
  const costSeries=[["input","输入未命中","#5c7891"],["cacheHit","缓存命中","#4f8d78"],["reasoning","推理","#c18c3f"],["output","回答","#a65f4b"]];
  $("#ai-cost-charts").innerHTML=ai.models.map(model=>`<section><h4>${escapeHtml(model.label)} <span>${model.calls} 次 · ${formatCny(totalCost(model))}</span></h4>${chartFrame(ai.daily,costSeries.map(([key,label,color])=>({label,color,values:ai.daily.map(day=>componentCost(day.models[model.model],key))})),{ariaLabel:`${model.label} 每日费用构成`,valueLabel:formatCnyAxis,actualPeak:true})}</section>`).join("");
  const maxScene=Math.max(1,...ai.scenes.map(item=>item.calls));
  $("#ai-scenario-bars").innerHTML=ai.scenes.length?ai.scenes.map(item=>`<div><span>${escapeHtml(sceneLabels[item.scene]||item.scene)}</span><i><b style="width:${item.calls/maxScene*100}%"></b></i><strong>${item.calls}</strong></div>`).join(""):`<div class="analytics-empty">这段时间还没有 AI 调用。</div>`;
  $("#ai-model-summary").innerHTML=`<table><thead><tr><th>供应商</th><th>调用</th><th>成功</th><th>失败</th><th>总 Token</th><th>已知费用</th><th>核算</th></tr></thead><tbody>${(ai.providers||[]).map(provider=>`<tr><td>${escapeHtml(provider.label)}</td><td>${provider.calls}</td><td>${provider.successfulCalls||0}</td><td>${provider.failedCalls||0}</td><td>${compactNumber((provider.tokens?.input||0)+(provider.tokens?.output||0))}</td><td>${formatCny(totalCost(provider))}</td><td>${provider.costUnknownCalls?`${provider.costUnknownCalls} 次待账单`:"已计入"}</td></tr>`).join("")}</tbody></table>`;
  const pricing=ai.pricing;
  $("#ai-pricing").innerHTML=`<p>${escapeHtml(pricing.estimateNote)} ${escapeHtml(pricing.historicalUsdNote||"")}</p><h4>DeepSeek · 人民币 / 百万 Token</h4><div class="pricing-table-wrap"><table><thead><tr><th>模型</th><th>时段</th><th>缓存命中</th><th>输入未命中</th><th>输出</th></tr></thead><tbody>${Object.entries(pricing.models).flatMap(([,model])=>[["offPeak","谷时"],["peak","峰时"]].map(([key,label])=>`<tr><td>${escapeHtml(model.label)}</td><td>${label}</td><td>${formatCny(model[key].cacheHit)}</td><td>${formatCny(model[key].cacheMiss)}</td><td>${formatCny(model[key].output)}</td></tr>`)).join("")}</tbody></table></div><p><a href="${escapeHtml(pricing.source)}" target="_blank" rel="noopener noreferrer">DeepSeek 官方价格</a> · 核对于 ${escapeHtml(pricing.checkedAt)}</p><h4>语音与视觉 · 官方目录价</h4><div class="pricing-table-wrap"><table><thead><tr><th>计费项</th><th>单价</th><th>单位</th><th>来源</th></tr></thead><tbody>${(pricing.providerRates||[]).map(rate=>`<tr><td>${escapeHtml(rate.label)}</td><td>${formatCny(rate.priceCny)}</td><td>${escapeHtml(rate.unitLabel)}</td><td><a href="${escapeHtml(rate.source)}" target="_blank" rel="noopener noreferrer">官方价格</a> · ${escapeHtml(rate.checkedAt)}</td></tr>`).join("")}</tbody></table></div>`;
}
function setStatisticsRange(days=7){
  $("#statistics-to").value=currentLocalDate;$("#statistics-from").value=shiftLocalDateKey(currentLocalDate,1-days);
  $$("[data-statistics-days]").forEach(button=>button.classList.toggle("active",Number(button.dataset.statisticsDays)===days));
}
async function loadStatistics(){
  const from=$("#statistics-from").value,to=$("#statistics-to").value;if(!from||!to)setStatisticsRange(7);
  const serial=++statisticsRequestSerial,owner=currentUser?.id,session=sessionSerial,status=$("#statistics-status"),button=$("#statistics-range-form button[type='submit']");
  button.disabled=true;status.textContent=hasCapability("ai-costs")?"正在汇总记录与 AI 用量…":"正在汇总记录…";
  try{const data=await request(`/api/statistics?from=${encodeURIComponent($("#statistics-from").value)}&to=${encodeURIComponent($("#statistics-to").value)}`);if(serial!==statisticsRequestSerial||owner!==currentUser?.id||session!==sessionSerial)return;renderStatistics(data);status.textContent=""}
  catch(error){if(serial===statisticsRequestSerial)status.textContent=error.message}
  finally{if(serial===statisticsRequestSerial)button.disabled=false}
}
function currentAiCostModel(scene){
  const tier=llmSettings.scenarios?.[scene]||defaultLlmScenarios[scene]||"high",profile=llmSettings.profiles?.[tier]||defaultLlmProfiles[tier];
  return{tier,model:profile.model,effort:llmSettings.sceneEfforts?.[scene]||profile.effort,label:`${profile.model==="deepseek-v4-pro"?"Pro":"Flash"} · ${tier[0].toUpperCase()+tier.slice(1)}`};
}
function aiCostScenarioEstimate(row,model=row.model){
  const pricing=aiCostStatistics?.ai?.pricing,rates=pricing?.models?.[model]?.[row.pricingPeriod];
  if(!rates)return{total:0,input:0,output:0,perCall:0};
  const calls=row.enabled?Math.max(0,Number(row.callsPerMonth)||0):0,input=Math.max(0,Number(row.avgInputTokens)||0),hit=input*Math.max(0,Math.min(100,Number(row.cacheHitPct)||0))/100,miss=input-hit,output=Math.max(0,Number(row.avgReasoningTokens)||0)+Math.max(0,Number(row.avgAnswerTokens)||0),unit=Number(pricing.unitTokens)||1e6;
  const inputCost=(hit*rates.cacheHit+miss*rates.cacheMiss)/unit,outputCost=output*rates.output/unit,perCall=inputCost+outputCost;
  return{total:perCall*calls,input:inputCost*calls,output:outputCost*calls,perCall};
}
function aiCostPlanFromForm(){
  const plan=structuredClone(aiCostPlan||{scenarios:[]});
  plan.monthlyBudgetCny=Number($("#ai-cost-budget").value)||0;
  plan.contingencyPct=Number($("#ai-cost-contingency").value)||0;
  plan.cnyPerUsd=Number($("#ai-cost-exchange").value)||0;
  plan.scenarios=(plan.scenarios||[]).map(row=>{
    const root=document.querySelector(`[data-ai-cost-row="${CSS.escape(row.scene)}"]`);
    if(!root)return row;
    return{...row,enabled:root.querySelector("[data-ai-cost-enabled]").checked,model:root.querySelector('[data-ai-cost-field="model"]').value,pricingPeriod:root.querySelector('[data-ai-cost-field="pricingPeriod"]').value,callsPerMonth:Number(root.querySelector('[data-ai-cost-field="callsPerMonth"]').value)||0,avgInputTokens:Number(root.querySelector('[data-ai-cost-field="avgInputTokens"]').value)||0,cacheHitPct:Number(root.querySelector('[data-ai-cost-field="cacheHitPct"]').value)||0,avgReasoningTokens:Number(root.querySelector('[data-ai-cost-field="avgReasoningTokens"]').value)||0,avgAnswerTokens:Number(root.querySelector('[data-ai-cost-field="avgAnswerTokens"]').value)||0};
  });
  return plan;
}
function renderAiCostRows(){
  $("#ai-cost-scenario-rows").innerHTML=(aiCostPlan?.scenarios||[]).map(row=>{
    const current=currentAiCostModel(row.scene),estimate=aiCostScenarioEstimate(row);
    return`<tr data-ai-cost-row="${escapeHtml(row.scene)}" class="${row.enabled?"":"disabled"}">
      <th><label><input type="checkbox" data-ai-cost-enabled ${row.enabled?"checked":""}><span>${escapeHtml(sceneLabels[row.scene]||row.scene)}</span></label></th>
      <td><strong>${escapeHtml(current.label)}</strong><small>${escapeHtml(current.effort==="none"?"不思考":`思考 ${current.effort.toUpperCase()}`)}</small></td>
      <td><select data-ai-cost-field="model"><option value="deepseek-flash" ${row.model==="deepseek-flash"?"selected":""}>Flash</option><option value="deepseek-v4-pro" ${row.model==="deepseek-v4-pro"?"selected":""}>Pro</option></select></td>
      <td><select data-ai-cost-field="pricingPeriod"><option value="peak" ${row.pricingPeriod==="peak"?"selected":""}>峰值</option><option value="offPeak" ${row.pricingPeriod==="offPeak"?"selected":""}>谷时</option></select></td>
      <td><input type="number" min="0" step="1" data-ai-cost-field="callsPerMonth" value="${escapeHtml(row.callsPerMonth)}"></td>
      <td><input type="number" min="0" step="1" data-ai-cost-field="avgInputTokens" value="${escapeHtml(row.avgInputTokens)}"></td>
      <td><input type="number" min="0" max="100" step=".1" data-ai-cost-field="cacheHitPct" value="${escapeHtml(row.cacheHitPct)}"></td>
      <td><input type="number" min="0" step="1" data-ai-cost-field="avgReasoningTokens" value="${escapeHtml(row.avgReasoningTokens)}"></td>
      <td><input type="number" min="0" step="1" data-ai-cost-field="avgAnswerTokens" value="${escapeHtml(row.avgAnswerTokens)}"></td>
      <td data-ai-cost-row-total>${escapeHtml(formatCny(estimate.total))}</td>
    </tr>`;
  }).join("");
}
function aiCostRecommendations(rows,projected,budget){
  const recommendations=[],enabled=rows.filter(item=>item.row.enabled).sort((a,b)=>b.estimate.total-a.estimate.total),top=enabled[0],critical=new Set(["thoughtAnswer","followUpAnswer","diaryReflection","analysis"]);
  if(budget>0&&projected>budget)recommendations.push(["先守住预算",`当前模拟超出月预算 ${formatCny(projected-budget)}，需要降低约 ${((projected-budget)/projected*100).toFixed(0)}%。`,"预算"]);
  else if(budget>0)recommendations.push(["预算仍有余量",`包含不确定性预留后，距月预算还剩 ${formatCny(budget-projected)}。`,"可控"]);
  if(top)recommendations.push(["先看最高成本场景",`${sceneLabels[top.row.scene]||top.row.scene}预计 ${formatCny(top.estimate.total)}/月，占基础成本 ${enabled.reduce((sum,item)=>sum+item.estimate.total,0)?(top.estimate.total/enabled.reduce((sum,item)=>sum+item.estimate.total,0)*100).toFixed(0):0}%。`,"优先"]);
  const downgrade=enabled.filter(item=>item.row.model==="deepseek-v4-pro"&&!critical.has(item.row.scene)).map(item=>({item,saving:item.estimate.total-aiCostScenarioEstimate(item.row,"deepseek-flash").total})).sort((a,b)=>b.saving-a.saving)[0];
  if(downgrade?.saving>0.01)recommendations.push(["轻量场景可试 Flash",`${sceneLabels[downgrade.item.row.scene]}切换 Flash 预计每月节省 ${formatCny(downgrade.saving)}；先用质量回归验证。`,"模型"]);
  const longContext=enabled.filter(item=>item.row.avgInputTokens>=20000).sort((a,b)=>b.row.avgInputTokens-a.row.avgInputTokens)[0];
  if(longContext)recommendations.push(["先压缩输入上下文",`${sceneLabels[longContext.row.scene]}平均输入 ${Number(longContext.row.avgInputTokens).toLocaleString("zh-CN")} Token。设置场景上限通常比直接降模型更稳妥。`,"Token"]);
  const cacheCandidate=enabled.filter(item=>item.row.avgInputTokens>=8000&&item.row.cacheHitPct<20).sort((a,b)=>b.row.avgInputTokens-a.row.avgInputTokens)[0];
  if(cacheCandidate)recommendations.push(["提高缓存稳定性",`${sceneLabels[cacheCandidate.row.scene]}缓存命中仅 ${cacheCandidate.row.cacheHitPct}%，可固定系统提示词前缀并减少无效变动。`,"缓存"]);
  return recommendations.slice(0,5);
}
function renderAiCostPlan(syncRows=true){
  if(!aiCostPlan||!aiCostStatistics)return;
  if(syncRows){
    $("#ai-cost-budget").value=aiCostPlan.monthlyBudgetCny;
    $("#ai-cost-contingency").value=aiCostPlan.contingencyPct;
    $("#ai-cost-exchange").value=aiCostPlan.cnyPerUsd;
    renderAiCostRows();
  }
  const rows=aiCostPlan.scenarios.map(row=>({row,estimate:aiCostScenarioEstimate(row)})),base=rows.reduce((sum,item)=>sum+item.estimate.total,0),reserve=base*(Number(aiCostPlan.contingencyPct)||0)/100,projected=base+reserve,budget=Number(aiCostPlan.monthlyBudgetCny)||0,observedUsd=Number(aiCostStatistics.ai?.summary?.costsUsd?.total)||0,observed=observedUsd*(Number(aiCostPlan.cnyPerUsd)||7.2)+(Number(aiCostStatistics.ai?.summary?.costCny)||0),difference=budget-projected;
  for(const item of rows){const root=document.querySelector(`[data-ai-cost-row="${CSS.escape(item.row.scene)}"]`),cell=root?.querySelector("[data-ai-cost-row-total]");root?.classList.toggle("disabled",!item.row.enabled);if(cell)cell.textContent=formatCny(item.estimate.total)}
  $("#ai-cost-kpis").innerHTML=[
    ["预计月成本",formatCny(projected),`基础 ${formatCny(base)} + 预留 ${formatCny(reserve)}`,budget&&projected>budget?"negative":"positive"],
    ["近 30 天实测",formatCny(observed),`${aiCostStatistics.ai?.summary?.calls||0} 次实际调用`],
    ["预算差额",budget?formatCny(difference):"未设预算",budget?`${difference>=0?"剩余":"超出"} ${formatCny(Math.abs(difference))}`:"填写月度预算",difference>=0?"positive":"negative"],
    ["预计年成本",formatCny(projected*12),"月度方案 × 12"]
  ].map(([label,value,note,tone])=>`<article class="${tone||""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`).join("");
  const recommendations=aiCostRecommendations(rows,projected,budget);
  $("#ai-cost-recommendations").innerHTML=recommendations.map(([title,copy,tag],index)=>`<li><b>${String(index+1).padStart(2,"0")}</b><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(copy)}</p></div><span>${escapeHtml(tag)}</span></li>`).join("")+`<li class="settings-link"><button type="button" data-view="settings">打开模型设置</button><p>模拟方案不会自动修改真实模型配置。</p></li>`;
  const pricing=aiCostStatistics.ai.pricing,cny=Number(aiCostPlan.cnyPerUsd)||7.2,observedCost=item=>(Number(item?.costsUsd?.total)||0)*cny+(Number(item?.costCny)||0),observedScenes=[...(aiCostStatistics.ai?.scenes||[])].sort((a,b)=>observedCost(b)-observedCost(a)).slice(0,5),p90=Number(aiCostStatistics.ai?.calibration?.p90CostCny)||0,unknownCosts=Number(aiCostStatistics.ai?.summary?.costUnknownCalls)||0;
  $("#ai-cost-observed").innerHTML=`<dl><div><dt>调用</dt><dd>${aiCostStatistics.ai?.summary?.calls||0} 次${unknownCosts?` · ${unknownCosts} 次费用待账单`:""}</dd></div><div><dt>平均输入</dt><dd>${compactNumber(aiCostStatistics.ai?.calibration?.averageInputTokens||0)} Token</dd></div><div><dt>P90 单次</dt><dd>${formatCny(p90)}</dd></div><div><dt>模拟 / 实测</dt><dd>${observed?`${(projected/observed).toFixed(1)}×`:"—"}</dd></div></dl><div class="ai-cost-observed-scenes">${observedScenes.length?observedScenes.map(item=>`<div><span>${escapeHtml(sceneLabels[item.scene]||item.scene)}</span><strong>${item.calls} 次</strong><small>${formatCny(observedCost(item))}${item.costUnknownCalls?` + ${item.costUnknownCalls} 次待账单`:""}</small></div>`).join(""):"<p>近 30 天暂无可用样本。</p>"}</div>`;
  $("#ai-cost-pricing").innerHTML=`<div class="pricing-table-wrap"><table><thead><tr><th>模型</th><th>时段</th><th>缓存命中</th><th>输入未命中</th><th>推理/回答</th></tr></thead><tbody>${Object.entries(pricing.models).flatMap(([,model])=>[["offPeak","谷时"],["peak","峰值"]].map(([period,label])=>`<tr><td>${escapeHtml(model.label)}</td><td>${label}</td><td>${formatCny(model[period].cacheHit)}</td><td>${formatCny(model[period].cacheMiss)}</td><td>${formatCny(model[period].output)}</td></tr>`)).join("")}</tbody></table></div><p>单位均为人民币 / 百万 Token；${escapeHtml(pricing.historicalUsdNote||`历史美元账本按 ${cny.toFixed(2)} 元/美元换算。`)}</p>`;
  $("#ai-cost-plan-state").textContent=budget&&projected>budget?"超过预算":"预算内";
  $("#ai-cost-plan-state").classList.toggle("over",Boolean(budget&&projected>budget));
  $("#ai-cost-updated-at").textContent=aiCostPlan.updatedAt?`参数更新于 ${formatDate(aiCostPlan.updatedAt)}`:"尚未保存";
}
function renderAiBudgetStatus(){
  if(!aiBudgetStatus)return;
  const day=aiBudgetStatus.day||{},month=aiBudgetStatus.month||{},dayUsed=Number(day.committedKnownCostCny||0),dayReserved=Number(day.reservedKnownCostCny||0),monthUsed=Number(month.committedKnownCostCny||0),monthReserved=Number(month.reservedKnownCostCny||0),unknownUsed=Number(day.committedUnknownCalls||0),unknownReserved=Number(day.reservedUnknownCalls||0);
  $("#ai-budget-period").textContent=`${day.key||"今日"} UTC · ${month.key||"本月"}`;
  $("#ai-budget-kpis").innerHTML=[
    ["今日已知费用",`${formatCny(dayUsed+dayReserved)} / ${formatCny(day.effectiveKnownCostLimitCny||0)}`,`${formatCny(dayUsed)} 已结算 · ${formatCny(dayReserved)} 已预留`,day.blocked?.knownCost],
    ["本月已知费用",`${formatCny(monthUsed+monthReserved)} / ${formatCny(month.effectiveKnownCostLimitCny||0)}`,`${formatCny(monthUsed)} 已结算 · ${formatCny(monthReserved)} 已预留`,month.blocked?.knownCost],
    ["未知费用调用",`${unknownUsed+unknownReserved} / ${day.unknownCallLimit||0}`,`${unknownUsed} 已发生 · ${unknownReserved} 已预留`,day.blocked?.unknownCost],
    ["在途任务",String(aiBudgetStatus.activeReservations||0),`控制版本 ${aiBudgetStatus.controlVersion||1}`,false]
  ].map(([label,value,note,blocked])=>`<article class="${blocked?"blocked":""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(blocked?`${note} · 已阻断`:note)}</small></article>`).join("")
}
async function readAiBudgetStatus(){
  const response=await apiClient.requestWithMetadata("/api/v1/owner/ai-budget");
  aiBudgetStatus=response.data?.data||null;aiBudgetEtag=response.etag||"";
  renderAiBudgetStatus();
  return aiBudgetStatus
}
async function submitAiBudgetCommand(command){
  if(!aiBudgetEtag)await readAiBudgetStatus();
  try{
    const response=await apiClient.requestWithMetadata("/api/v1/owner/ai-budget",{method:"PATCH",headers:{"if-match":aiBudgetEtag},body:JSON.stringify(command)});
    aiBudgetStatus=response.data?.data||null;aiBudgetEtag=response.etag||"";renderAiBudgetStatus();return aiBudgetStatus
  }catch(error){
    if(error.status===412){await readAiBudgetStatus();throw Object.assign(new Error("预算状态已被其他 Owner 更新，已重新读取。"),{code:error.code,status:error.status})}
    throw error
  }
}
async function loadAiCostPlan(){
  const serial=++aiCostRequestSerial,owner=currentUser?.id,session=sessionSerial,from=shiftLocalDateKey(currentLocalDate,-29),status=$("#ai-cost-status");status.textContent="正在读取成本方案与近 30 天账本…";
  try{
    const [plan,statistics,budgetResponse]=await Promise.all([request("/api/ai-cost-plan"),request(`/api/statistics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(currentLocalDate)}`),apiClient.requestWithMetadata("/api/v1/owner/ai-budget")]);
    if(serial!==aiCostRequestSerial||owner!==currentUser?.id||session!==sessionSerial)return;
    aiCostPlan=plan;aiCostStatistics=statistics;aiBudgetStatus=budgetResponse.data?.data||null;aiBudgetEtag=budgetResponse.etag||"";renderAiBudgetStatus();renderAiCostPlan();status.textContent="";
  }catch(error){if(serial===aiCostRequestSerial)status.textContent=error.message}
}
function ownerSurfaceRoot(surface){
  return document.querySelector(`[data-owner-surface-root="${CSS.escape(surface)}"]`)
}
function resetOwnerSurfaces(){
  clearTimeout(commercialPreviewTimer);commercialPreviewTimer=0;
  architectureSurface=null;architectureStage=0;architectureTerm="";architectureRequestSerial+=1;
  commercializationSurface=null;commercialMode="";commercialRequestSerial+=1;
  for(const surface of["architecture","commercialization"]){
    const root=ownerSurfaceRoot(surface);if(root)root.replaceChildren()
  }
}
function architectureNodeMarkup([title,detail,state]){return`<article class="${escapeHtml(state||"")}"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></article>`}
function renderArchitectureTerm(){
  const terms=architectureSurface?.terms||[],item=terms.find(term=>term.key===architectureTerm)||terms[0];if(!item)return;
  architectureTerm=item.key;
  $$("[data-architecture-term]").forEach(button=>button.classList.toggle("active",button.dataset.architectureTerm===architectureTerm));
  $("#architecture-term-code").textContent=item.code;$("#architecture-term-name").textContent=item.name;$("#architecture-term-description").textContent=item.description;$("#architecture-term-analogy").textContent=item.analogy;$("#architecture-term-timing").textContent=item.timing
}
function renderArchitecture(){
  const stages=architectureSurface?.stages||[],stage=stages[architectureStage]||stages[0];if(!stage)return;
  const tabs=$("#architecture-stage-tabs");
  if(tabs&&!tabs.children.length)tabs.innerHTML=stages.map((item,index)=>`<button class="${index===architectureStage?"active":""}" type="button" role="tab" aria-selected="${index===architectureStage}" data-architecture-stage="${index}">${escapeHtml(item.tab||item.name)}</button>`).join("");
  $$("[data-architecture-stage]").forEach(button=>{const active=Number(button.dataset.architectureStage)===architectureStage;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active))});
  $("#architecture-stage-cost").textContent=stage.cost;$("#architecture-stage-state").textContent=stage.state;$("#architecture-flow-note").textContent=stage.note;
  $("#architecture-kpis").innerHTML=(architectureSurface.kpis||[]).map(item=>`<article><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(stage[item.key])}</strong><small>${escapeHtml(item.note)}</small></article>`).join("");
  $("#architecture-main-path").innerHTML=stage.mainPath.map((node,index)=>`${index?'<span aria-hidden="true">→</span>':""}${architectureNodeMarkup(node)}`).join("");
  $("#architecture-support-paths").innerHTML=stage.supports.map(([title,nodes])=>`<section><h4>${escapeHtml(title)}</h4><div>${nodes.map(architectureNodeMarkup).join("")}</div></section>`).join("");
  $("#architecture-layer-list").innerHTML=stage.layers.map(([layer,component,spec,reason],index)=>`<article><b>${String(index+1).padStart(2,"0")}</b><strong>${escapeHtml(layer)}</strong><div><h3>${escapeHtml(component)}</h3><span>${escapeHtml(spec)}</span></div><p>${escapeHtml(reason)}</p></article>`).join("");
  $("#architecture-enter-title").textContent=stage.enter[0];$("#architecture-enter-copy").textContent=stage.enter[1];$("#architecture-defer-title").textContent=stage.defer[0];$("#architecture-defer-copy").textContent=stage.defer[1];
  const glossary=$("#architecture-glossary-grid");
  if(glossary&&!glossary.children.length)glossary.innerHTML=(architectureSurface.terms||[]).map(item=>`<button type="button" data-architecture-term="${escapeHtml(item.key)}"><b>${escapeHtml(item.code)}</b><span>${escapeHtml(item.name)}</span></button>`).join("");
  renderArchitectureTerm()
}
async function loadArchitecture(){
  if(architectureSurface){renderArchitecture();return true}
  const serial=++architectureRequestSerial,owner=currentUser?.id,session=sessionSerial,root=ownerSurfaceRoot("architecture");if(!root)return false;
  root.innerHTML='<p class="status" role="status">正在读取管理内容…</p>';
  try{
    const surface=await request("/api/owner/surfaces/architecture");
    if(serial!==architectureRequestSerial||owner!==currentUser?.id||session!==sessionSerial)return false;
    architectureSurface=surface;architectureStage=0;architectureTerm=surface.terms?.[0]?.key||"";root.innerHTML=surface.markup;renderArchitecture();return true
  }catch(error){if(serial===architectureRequestSerial)root.innerHTML=`<p class="status error" role="alert">${escapeHtml(error.message)}</p>`;return false}
}
function commercialAssumptionsFromForm(){
  const fallback=commercializationSurface?.report?.assumptions;if(!fallback)return null;
  const result=structuredClone(fallback);result.stageByModel||={};result.stagePresets||={};
  $$("[data-commercial-field]").forEach(input=>{
    const [group,key]=input.dataset.commercialField.split("."),value=Number(input.value);if(!Number.isFinite(value))return;
    result[group]||={};result[group][key]=value;
    if(Object.hasOwn(result.stageByModel,group)){
      const index=Math.max(0,Math.min((result.stagePresets[group]?.length||1)-1,Number(result.stageByModel[group])||0));
      result.stagePresets[group]||=[];result.stagePresets[group][index]||={};result.stagePresets[group][index][key]=value
    }
  });
  $$("[data-commercial-profile-field]").forEach(input=>{const [profile,key]=input.dataset.commercialProfileField.split("."),value=Number(input.value);if(!Number.isFinite(value))return;result.usageProfiles||={};result.usageProfiles[profile]||={};result.usageProfiles[profile][key]=value});
  return result
}
function populateCommercialAssumptions(assumptions){
  $$("[data-commercial-field]").forEach(input=>{const [group,key]=input.dataset.commercialField.split(".");input.value=assumptions?.[group]?.[key]??""});
  $$("[data-commercial-profile-field]").forEach(input=>{const [profile,key]=input.dataset.commercialProfileField.split(".");input.value=assumptions?.usageProfiles?.[profile]?.[key]??""})
}
function applyCommercializationSurface(surface,{mount=false}={}){
  const root=ownerSurfaceRoot("commercialization");if(!root)return false;
  if(mount||!$("#commercial-assumptions-form"))root.innerHTML=surface.markup;
  commercializationSurface=surface;commercialMode=surface.mode;
  populateCommercialAssumptions(surface.report.assumptions);
  $$("[data-commercial-mode]").forEach(button=>{const active=button.dataset.commercialMode===commercialMode;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active))});
  $$("[data-commercial-assumption-group]").forEach(group=>group.hidden=group.dataset.commercialAssumptionGroup!==commercialMode);
  $("#commercial-stage-slider").value=String(surface.view.stageIndex);
  for(const [id,value]of Object.entries(surface.view.text||{})){const element=document.getElementById(id);if(element)element.textContent=value}
  for(const [id,value]of Object.entries(surface.view.html||{})){const element=document.getElementById(id);if(element)element.innerHTML=value}
  for(const [profile,value]of Object.entries(surface.view.profileCosts||{})){const element=document.querySelector(`[data-commercial-profile-cost="${CSS.escape(profile)}"]`);if(element)element.textContent=value}
  $("#commercial-profile-share-status").classList.toggle("warning",Boolean(surface.view.shareWarning));
  $("#commercial-cashflow").hidden=Boolean(surface.view.cashflowHidden);
  return true
}
async function previewCommercialization(assumptions,{statusMessage=""}={}){
  if(!assumptions)return false;
  const serial=++commercialRequestSerial,owner=currentUser?.id,session=sessionSerial;
  try{
    const from=shiftLocalDateKey(currentLocalDate,-29),surface=await request(`/api/owner/surfaces/commercialization/preview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(currentLocalDate)}`,{method:"POST",body:JSON.stringify({assumptions,mode:commercialMode})});
    if(serial!==commercialRequestSerial||owner!==currentUser?.id||session!==sessionSerial)return false;
    applyCommercializationSurface(surface);if(statusMessage)$("#commercial-save-status").textContent=statusMessage;return true
  }catch(error){if(serial===commercialRequestSerial)$("#commercial-save-status").textContent=error.message;return false}
}
function scheduleCommercializationPreview(){
  clearTimeout(commercialPreviewTimer);
  commercialPreviewTimer=setTimeout(()=>void previewCommercialization(commercialAssumptionsFromForm()),150)
}
async function loadCommercialization(){
  if(commercializationSurface){applyCommercializationSurface(commercializationSurface);return true}
  const serial=++commercialRequestSerial,owner=currentUser?.id,session=sessionSerial,root=ownerSurfaceRoot("commercialization");if(!root)return false;
  root.innerHTML='<p class="status" role="status">正在读取管理内容…</p>';
  try{
    const from=shiftLocalDateKey(currentLocalDate,-29),surface=await request(`/api/owner/surfaces/commercialization?from=${encodeURIComponent(from)}&to=${encodeURIComponent(currentLocalDate)}`);
    if(serial!==commercialRequestSerial||owner!==currentUser?.id||session!==sessionSerial)return false;
    applyCommercializationSurface(surface,{mount:true});return true
  }catch(error){if(serial===commercialRequestSerial)root.innerHTML=`<p class="status error" role="alert">${escapeHtml(error.message)}</p>`;return false}
}
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
      switchView("captures");
      captureComposerOpen=true;renderCaptures();requestAnimationFrame(()=>$("#capture-content")?.focus())
    }
  },
  toast:showToast
});
function renderOnboarding(){onboardingV2Controller.render()}
function renderDate(){$$("[data-active-date]").forEach(input=>input.value=activeDate);installOccurrenceControls();if(!$("#capture-id")?.value)resetOccurrenceInput($("#capture-date"));if(!$("#journal-id")?.value)resetOccurrenceInput($("#journal-date"));if(!$("#quote-id")?.value)resetOccurrenceInput($("#quote-datetime"));if(!$("#keepsake-id")?.value)resetOccurrenceInput($("#keepsake-datetime"));for(const input of[$("#chain-datetime"),$("#checkin-datetime"),$("#chat-datetime")])resetOccurrenceInput(input);$$("[data-daily-form]").forEach(form=>{if(!form.elements.recordId.value)resetOccurrenceInput(form.elements.occurredAt)});const d=new Date(`${activeDate}T12:00:00`),today=activeDate===localDateKey(),label=new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"long",day:"numeric",weekday:"long"}).format(d);$$("[data-active-date-label]").forEach(element=>element.textContent=element.id==="today-date-label"?activeDate.replaceAll("-","/"):label);$$("[data-active-date-heading]").forEach(element=>{const view=element.closest(".view")?.id;element.textContent=!today?"回到这一天":view==="view-daily"?"今天，留下了什么？":view==="view-together"?"今天，一起看看":"今天，你感觉怎么样？"})}
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
    const template=document.createElement("template");template.innerHTML=keepsakeImageMarkup(item,"home-v02-keepsake-stack","eager","home");preview.append(template.content)
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
  if(item)requestAnimationFrame(()=>setupKeepsakePlacements(container))
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
    activeBookId=item.bookId;activeBookFeatureNoteId=item.noteId;pendingBookNoteId=item.noteId;switchView("books");renderBooks();return
  }
  switchView("quotes");
  requestAnimationFrame(()=>document.querySelector(`[data-quote-id="${CSS.escape(item.id)}"]`)?.scrollIntoView({behavior:"smooth",block:"center"}))
}
function renderMine(){
  const accountName=$("#mine-account-name"),notificationCount=$("#mine-notification-count");
  if(accountName)accountName.textContent=currentUser?.username||"本机使用";
  const governance=$("#mine-governance-link");if(governance){governance.hidden=!governanceUrl;if(governanceUrl)governance.href=governanceUrl}
  if(notificationCount){const unread=Number(state.notificationUnread??notificationUnreadCount)||(state.notifications||[]).filter(item=>!item.readAt&&["succeeded","failed","stale","cancelled"].includes(item.status)).length;notificationCount.textContent=unread?`${unread} 条未读`:""}
  const syncRow=$(".sync-health-row"),syncStatus=$("#mine-sync-status"),syncCount=$("#mine-sync-count");
  if(syncRow)syncRow.dataset.syncStatus=syncHealth.status;
  if(syncStatus)syncStatus.textContent=syncHealth.status==="disabled"?"增量同步已关闭，继续使用写后刷新":syncHealth.status==="conflict"?`${syncHealth.conflicts} 项同步冲突，请核对最新内容后重试`:syncHealth.status==="degraded"?"浏览器不支持持久队列，本次会话使用内存同步":syncHealth.status==="error"?syncHealth.failed?`${syncHealth.failed} 项操作重试失败，请保留当前页面并重新提交`:"同步暂时中断，将在回到前台或网络恢复后重试":syncHealth.pending?`${syncHealth.pending} 项操作等待服务端确认${syncHealth.oldestAgeMs>30000?"，已有操作超过 30 秒":""}`:syncHealth.status==="synced"?`已与服务端对齐${syncHealth.lastPullMs?` · 拉取 ${syncHealth.lastPullMs} ms`:""}${syncHealth.enqueueToAckP95Ms?` · 写确认 P95 ${syncHealth.enqueueToAckP95Ms} ms`:""}`:"正在核对本地操作与服务端状态";
  if(syncCount)syncCount.textContent=syncHealth.conflicts?`${syncHealth.conflicts} 冲突`:syncHealth.failed?`${syncHealth.failed} 失败`:syncHealth.pending?`${syncHealth.pending} 项`:"";
  const versionLabel=releaseVersion.startsWith("v")?releaseVersion:`v${releaseVersion}`;
  for(const element of[$("#sidebar-app-version"),$("#mine-app-version")])if(element)element.textContent=versionLabel
}
function renderAccountUsers(){
  const list=$("#account-role-list"),status=$("#account-role-status");if(!list)return;
  if(accountUsersLoadState==="loading"){list.innerHTML=contentState({kind:"loading",title:"正在读取账户",body:"角色只包含普通用户与 Owner。"});return}
  if(accountUsersLoadState==="failure"){list.innerHTML=contentState({kind:"failure",title:"暂时无法读取账户",body:"现有角色没有变化。",action:{command:"retry-account-users",label:"重新读取"}});return}
  list.innerHTML=accountUsers.map(user=>`<article class="account-role-row" data-account-user="${escapeHtml(user.id)}"><div><strong>${escapeHtml(user.username)}</strong><small>${user.id===currentUser?.id?"当前账户 · ":""}${user.role==="owner"?"Owner":"普通用户"}</small></div><select data-account-role="${escapeHtml(user.id)}" aria-label="${escapeHtml(`${user.username} 的角色`)}"><option value="user" ${user.role==="user"?"selected":""}>普通用户</option><option value="owner" ${user.role==="owner"?"selected":""}>Owner</option></select><button class="quiet-button" type="button" data-account-role-save="${escapeHtml(user.id)}">保存</button></article>`).join("")||contentState({title:"还没有可管理的账户",body:"新账户注册后会显示在这里。"});
  if(status&&accountUsersLoadState==="ready"&&!status.textContent)status.textContent=""
}
async function loadAccountUsers(){
  if(!hasCapability("account-roles"))return false;
  const serial=++accountUsersRequestSerial,owner=currentUser?.id,session=sessionSerial;accountUsersLoadState="loading";renderAccountUsers();
  try{const result=await request("/api/auth/users");if(serial!==accountUsersRequestSerial||owner!==currentUser?.id||session!==sessionSerial)return false;accountUsers=result.users||[];accountUsersLoadState="ready";renderAccountUsers();return true}
  catch(error){if(serial===accountUsersRequestSerial&&owner===currentUser?.id&&session===sessionSerial){accountUsersLoadState="failure";renderAccountUsers();const status=$("#account-role-status");if(status)status.textContent=error.message}return false}
}
function renderPersonalContext(){
  const summary=$("#personal-context-summary");if(!summary)return;
  const data=personalContext,status=$("#personal-context-status"),sources=Array.isArray(data?.sources)?data.sources:[],sourceById=new Map(sources.map(source=>[source.id,source])),budget=data?.tokenBudget;
  if(!data){
    $("#personal-context-meta").innerHTML="";
    $("#personal-context-disclosure").textContent="";
    $("#personal-context-source-count").textContent="0 条";
    $("#personal-context-source-list").innerHTML="";
    summary.innerHTML=personalContextLoadState==="failure"
      ?contentState({kind:"failure",title:"暂时无法核对个人概要",body:"原始记录没有被修改。请检查网络后重试。",action:{command:"retry-personal-context",label:"重新核对"}})
      :contentState({kind:"loading",title:"正在核对个人概要",body:"只读取当前账户中仍然有效的来源。"});
    return
  }
  const windowLabel=data.timeWindow?.from?`${data.timeWindow.from}${data.timeWindow.to&&data.timeWindow.to!==data.timeWindow.from?` 至 ${data.timeWindow.to}`:""}`:"尚无记录";
  $("#personal-context-meta").innerHTML=[
    ["版本",data.version||"未标记"],
    ["时间窗",windowLabel],
    ["来源",`${Number(data.sourceCount)||0} 条`],
    ["Token 上界",budget?`${Number(budget.estimatedUsed)||0} / ${Number(budget.limit)||0}`:"未估算"]
  ].map(([label,value])=>`<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  $("#personal-context-disclosure").textContent=data.disclosure||"";
  $("#personal-context-source-count").textContent=`${sources.length} 条 · 生成于 ${formatDate(data.generatedAt)}`;
  $("#personal-context-source-list").innerHTML=sources.length?`<div class="context-source-list">${sources.map(contextSourceButton).join("")}</div>`:contentState({title:"还没有可用来源",body:"先留下记录并明确允许使用，来源才会出现在这里。",action:{view:"captures",label:"留一条记录"}});
  const conclusions=Array.isArray(data.conclusions)?data.conclusions:[];
  summary.innerHTML=conclusions.length?conclusions.map(item=>{
    const evidence=item.sourceIds?.map(id=>sourceById.get(id)).filter(Boolean)||[];
    return `<details class="personal-context-conclusion" data-context-type="${escapeHtml(item.informationType||"")}"><summary><div><span>${escapeHtml(item.informationTypeLabel||"")}</span><strong>${escapeHtml(item.title||"")}</strong></div><small>${evidence.length} 条来源</small></summary><div class="personal-context-conclusion-body"><p>${escapeHtml(item.text||"").replace(/\n/g,"<br>")}</p><small>${escapeHtml(item.sampleNote||"")}</small>${evidence.length?`<div class="context-source-list">${evidence.map(contextSourceButton).join("")}</div>`:""}</div></details>`
  }).join(""):contentState({title:"记录还不足以形成概要",body:"这很正常，概要会随已确认的来源逐步更新。",action:{view:"captures",label:"继续记录"}});
  status.textContent=""
}
async function loadPersonalContext(){
  const serial=++personalContextRequestSerial,owner=currentUser?.id,session=sessionSerial,status=$("#personal-context-status");
  personalContextLoadState="loading";status.textContent="正在核对当前记录与来源…";renderPersonalContext();
  try{
    const response=await requestV1("/api/v1/personal-context");
    if(serial!==personalContextRequestSerial||owner!==currentUser?.id||session!==sessionSerial)return false;
    personalContext=response.data;personalContextLoadState="ready";renderPersonalContext();return true
  }catch(error){
    if(serial===personalContextRequestSerial&&owner===currentUser?.id&&session===sessionSerial){personalContext=null;personalContextLoadState="failure";status.textContent="";renderPersonalContext()}
    return false
  }
}
function openContextSource(button){
  const view=button.dataset.contextView,target=button.dataset.contextTarget,root=button.dataset.contextRoot,date=button.dataset.contextDate,dailyType=button.dataset.contextDailyType;
  if(date){activeDate=date;if(dailyType&&dailyTypeMeta[dailyType])activeDailyType=dailyType;renderDate();renderSliders();publishDomains(new Set(["thoughts"]));renderStateChart();renderHomeMood();renderChat()}
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
  renderDate();renderMine();
  $("#notification-dot").hidden=!Number(state.notificationUnread??notificationUnreadCount);
  if(view==="today"){renderSliders();renderHome()}
  else if(view==="daily")void healthFeatureController?.render().catch(error=>showToast(`日录显示失败：${error.message}`,"error"));
  else if(view==="captures"){renderCaptures();renderCaptureTagComposer();renderCaptureAudioDraft()}
  else if(view==="journals")renderJournals();
  else if(view==="review"){renderStateChart();renderReview()}
  else if(view==="books")renderBooks();
  else if(view==="keepsakes"){renderKeepsakes();renderKeepsakeBatch()}
  else if(view==="quotes")renderQuotes();
  else if(view==="settings"){renderSettings();renderLocalTestSettings()}
  else if(view==="trash")renderTrash();
  else if(view==="account")renderAccountUsers();
  else if(view==="personal-context")renderPersonalContext()
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
  journalDraftRestored=false;aiCostPlan=null;aiCostStatistics=null;aiBudgetStatus=null;aiBudgetEtag="";resetJournalForm();
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
  statisticsRequestSerial+=1;aiCostRequestSerial+=1;architectureRequestSerial+=1;commercialRequestSerial+=1;personalContextRequestSerial+=1;accountUsersRequestSerial+=1;analysisRequestSerial+=1;
  activeAnswerTaskId=++answerTaskSerial;healthFeatureController?.invalidateSession();bookParseSerial+=1;clearTimeout(notificationTimer);
  backgroundResultsController?.resetSession();backgroundResultsLoadErrorReported=false;backgroundResultsRetryAttempts=0;refreshCoordinator.reset();
}
function clearPrivateSessionState(){
  captureEditorSerial+=1;
  closeImageViewer({restoreFocus:false});
  onboardingV2Controller.reset();
  resetState();routeDataReady=false;routeDataRequestSerial+=1;routeLoadFailureKey="";loadedRouteKey="";fullRouteStateLoaded=false;quoteTagStates={quote:createTagMultiSelectState(),selectionQuote:createTagMultiSelectState()};llmSettings={provider:"deepseek",profiles:structuredClone(defaultLlmProfiles),scenarios:{...defaultLlmScenarios},sceneEfforts:{...defaultSceneEfforts},automaticAnswers:{thoughtAnswer:false},speech:{defaultVoice:"",generationRate:-10},hasApiKey:false,keyHint:""};
  activeAnswerTaskId=++answerTaskSerial;clearTimeout(notificationTimer);clearTimeout(keepsakeDerivativeRefreshTimer);keepsakeDerivativeRefreshTimer=0;answerDraft="";answerReasoningDraft="";trashItems=[];aiCostPlan=null;aiCostStatistics=null;aiBudgetStatus=null;aiBudgetEtag="";statisticsData=null;localTestConfig=null;localTestStatusOverride="";localTestScopeLoads.clear();onboardingSchema=null;onboardingMode="quick";onboardingDraftAnswers={};onboardingHydrated=false;notificationUnreadCount=0;notificationsLoadState="idle";actionsCoordinator.resetSession();annotationsController?.resetSession();personalContext=null;personalContextRequestSerial=0;accountUsers=[];accountUsersLoadState="idle";governanceUrl="";appVersion="0.5.7";homeMemoryKeys=[];homeMemoryByKey=new Map();homeKeepsakeId="";closeHomeEditors({restoreFocus:false});$("#capture-editor").hidden=true;document.body.classList.remove("capture-editor-open");resetOwnerSurfaces();invalidatePageLoads();draftTags=[];captureDraftTags=[];keepsakeDraftTags=[];captureComposerOpen=false;captureEditorTrigger=null;suspendedCaptureCreateDraft=null;expandedLongContentKeys.clear();
  bookParseSerial+=1;for(const url of Object.values(bookPreviewUrls))if(url)URL.revokeObjectURL(url);bookPreviewUrls={cover:"",recognition:""};pendingBookImages={cover:null,recognition:null};editingBookId="";activeBookId="";activeBookFeatureNoteId="";bookCreatorOpen=false;bookDetailCondensed=false;
  keepsakeEditor.segmentSerial+=1;keepsakeEditor.file=null;keepsakeEditor.sourceDataUrl="";keepsakeEditor.sourceImage=null;keepsakeEditor.sourceCanvas=null;keepsakeEditor.maskCanvas=null;keepsakeEditor.autoBase=null;keepsakeEditor.history=[];
  clearKeepsakeBatchState();
  contentImageDraftManager?.resetSession();for(const key of persistentContentImageKeys)renderContentImageEditor(key);
  clearCaptureAudioDraft({forget:false});pageAudioCoordinator.resetSession();stopPageAudio();
  $$("main form").forEach(form=>{form.reset();delete form.dataset.requestId});$$(".modal-backdrop").forEach(modal=>modal.hidden=true);$("#comment-panel").hidden=true;$("#comment-panel-reopen").hidden=true;$("#selection-tools").hidden=true;$("#annotation-line-counts").hidden=true;document.body.classList.remove("comment-panel-open");
}
function showAuthGate(message=""){
  const localTestEnabled=Boolean(localTestConfig?.enabled),resetApplication=applicationLifecycleReady;applicationLifecycleReady=false;resetRouteAfterAuthentication||=Boolean(currentUser);syncController?.stop();syncHealth={status:"idle",pending:0,conflicts:0,failed:0,oldestAgeMs:0,enqueueToAckP95Ms:0,lastPullMs:0,lastError:""};rotateSession();clearPrivateSessionState();if(resetApplication){void runtimeFeatureRegistry?.resetSession().catch(()=>{});runtimeStatePort?.resetSession()}currentUser=null;applyCapabilitySurface([]);try{sessionStorage.removeItem("cike:authenticated-shell")}catch{}delete document.documentElement.dataset.bootstrapVisible;document.body.classList.add("auth-locked");$("#auth-gate").hidden=false;$("#account-control").hidden=true;$("#account-authenticated").hidden=true;const registerTab=$('[data-auth-tab="register"]');if(registerTab)registerTab.hidden=localTestEnabled;if(message)$("#auth-status").textContent=message;
}
function renderAccountIdentity(){
  const username=currentUser?.username||"";
  $("#account-name").textContent=username;$("#account-current-name").textContent=username;$("#account-page-name").textContent=username;$("#account-username").value=username;
}
function prepareUserSession(user,authRequired,{keepVisible=false}={}){
  rotateSession();applyCapabilitySurface(user?.role==="owner"?ownerCapabilities:[]);if(!keepVisible)document.body.classList.add("auth-locked");if(resetRouteAfterAuthentication)pageRouter?.showList("today",{mode:"replace"});else restoreView?.();currentUser=user;resetRouteAfterAuthentication=false;$("#account-control").hidden=!authRequired;$("#account-authenticated").hidden=!authRequired;$("#account-local-mode").hidden=authRequired;renderAccountIdentity();
}
function revealUserSession(){try{sessionStorage.setItem("cike:authenticated-shell","1")}catch{}document.documentElement.dataset.bootstrapVisible="1";document.body.classList.remove("auth-locked");$("#auth-gate").hidden=true}
async function activateUserSession(user,authRequired,initialSnapshot=null,opening=null){
  prepareUserSession(user,authRequired,{keepVisible:Boolean(initialSnapshot?.visibleShell)});
  try{
    if(!await load({visibleShell:true,initialSnapshot,opening}))return false;
    await Promise.all([
      restoreContentImageDrafts(user?.id).catch(error=>showToast(`待上传图片恢复失败：${error.message}`,"error")),
      restoreCaptureAudioDraft(user?.id).catch(error=>showToast(`待提交语音恢复失败：${error.message}`,"error")),
      restoreKeepsakeBatch(user?.id).catch(error=>showToast(`小物批次恢复失败：${error.message}`,"error"))
    ]);
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
        if(currentUser?.id){restoreAnnotationUiDrafts();renderVisibleRoute();activateContentImageDraftsForCurrentRoute()}
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
  await runtimeApplication.start(applicationStartInput({
    session:{authenticated:true,authRequired:true,user,userCount:1},
    testConfig
  }));
  applicationLifecycleReady=true
}
const refreshState=(domains,options={})=>refreshCoordinator.refresh(domains,{...options,patchOnly:options.patchOnly===true});
subscribeState((next,wanted)=>{notificationUnreadCount=Number(next.notificationUnread)||notificationUnreadCount;if(wanted.has("onboardingV2"))onboardingV2Controller.reconcile(next.onboardingV2);if(wanted.has("dailyRecords"))void healthFeatureController?.render({snapshot:next,changedDomains:wanted}).catch(()=>{});if(wanted.has("captures")){renderCaptures();renderCaptureTagComposer()}if(wanted.has("journals"))renderJournals();if(wanted.has("thoughts")){renderCaptures();renderTagComposer();renderCaptureTagComposer();renderHomeMemories()}if(wanted.has("speech")){if(!wanted.has("captures"))renderCaptures();renderSettings()}if(wanted.has("checkins")){renderStateChart();renderSliders();renderHomeMood()}if(wanted.has("chat")||wanted.has("chats"))renderChat();if(wanted.has("review"))renderReview();if(wanted.has("books")){renderBooks();renderHomeMemories();if(annotationsController?.activeRootKey().startsWith("book:"))renderCommentPanel()}if(wanted.has("keepsakes")){renderKeepsakes();renderHomeKeepsake()}if(wanted.has("quotes")){renderQuotes();renderHomeMemories()}if(wanted.has("comments"))renderCommentPanel();renderNotificationSummary()});
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
      localTestConfig=result.control;replaceState(result.state);runtimeStatePort?.replace(state,Object.keys(result.state||{}),{source:"local-test-hydrate"});notificationUnreadCount=Number(state.notificationUnread)||0;loadedRouteKey=routeDataKey(pageRouter?.currentRoute());renderOnboarding();renderVisibleRoute();renderLocalTestSettings();return true
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
    load:()=>loadLegacyFeatureModule().then(module=>withCheckins(module.createLegacyPageController({view:"review"})))
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
  return descriptors
}
const pageEffects={...createPageEffects({
  syncCaptureOverflow,
  syncQuoteOverflow,
  setupQuoteBubbleScroll,
  stopQuoteBubbleScroll,
  loadStatistics,
  loadAiCostPlan,
  loadArchitecture,
  loadCommercialization,
  loadTrash
}),today:()=>actionsCoordinator.load(),"personal-context":()=>loadPersonalContext(),account:()=>loadAccountUsers()};
const lazyPageEffects=new Proxy(pageEffects,{get(target,view){const effect=target[view];if(typeof effect!=="function"||typeof view!=="string"||!LOCAL_TEST_VIEW_SCOPES[view])return effect;return()=>{void ensureLocalTestViewScope(view).then(async ready=>{if(!ready)return;await effect();await restorePendingProjections()})}}});
pageRouter=createPageRouter({query:$,queryAll:$$,effects:lazyPageEffects,basePath:applicationBasePath,onRouteStart:applyApplicationRoute,canAccessView:(_,capability)=>hasCapability(capability),onDenied:showPermissionPage});
({switchView,restoreView}=pageRouter);
$("#home-open-thought").addEventListener("click",event=>openHomeEditor("thought",event.currentTarget));
$("#home-record-voice").addEventListener("click",openQuickVoiceCapture);
$("#home-record-state").addEventListener("click",event=>openHomeEditor("state",event.currentTarget));
$("#home-shuffle").addEventListener("click",()=>renderHomeMemories({advance:true}));
$("#home-memory-grid").addEventListener("click",event=>{
  const button=event.target.closest("[data-home-memory-open]");
  if(button)openHomeMemory(homeMemoryByKey.get(button.dataset.homeMemoryOpen))
});
$("#home-keepsake").addEventListener("click",event=>{
  const button=event.target.closest("[data-home-keepsake]");
  if(!button)return;
  switchView("keepsakes");
  if(button.dataset.homeKeepsake)openKeepsakeDetail(button.dataset.homeKeepsake)
});
$$("[data-home-editor-close]").forEach(button=>button.addEventListener("click",()=>closeHomeEditors()));
$$(".home-v02-editor-backdrop").forEach(editor=>editor.addEventListener("click",event=>{if(event.target===editor)closeHomeEditors()}));
function openDiscoveryItem(item){
  const route=item?.route||{view:"thoughts",resourceType:"thought",resourceId:item?.id||""},id=route.resourceId;
  if(route.view==="books"){activeBookId=id;activeBookFeatureNoteId=String(route.targetKey||"").replace(/^note:/,"");pendingBookNoteId=activeBookFeatureNoteId;switchView("books");renderBooks();return}
  if(route.resourceType==="thought")openThoughtDetail(id);else switchView(route.view||"thoughts");
  const selector={thought:`[data-chain-id="${CSS.escape(id)}"]`,capture:`[data-capture-id="${CSS.escape(id)}"]`,journal:`[data-journal-id="${CSS.escape(id)}"]`,quote:`[data-quote-id="${CSS.escape(id)}"]`}[route.resourceType];
  requestAnimationFrame(()=>{const target=document.querySelector(selector||"");if(target instanceof HTMLDetailsElement)target.open=true;target?.scrollIntoView({behavior:"smooth",block:"center"})})
}
function openCheckinEditor(id){
  const item=state.checkins.find(value=>value.id===id);if(!item)return;
  $("#edit-checkin-id").value=id;$("#edit-checkin-datetime").value=persistedDateTimeInput(item);$("#edit-checkin-factors").value=(item.factors||[]).join(" ");$("#edit-checkin-status").textContent="";
  $("#edit-checkin-metrics").innerHTML=Object.entries(metricConfig()).map(([key,cfg])=>{const value=Number(metricValue(item,key,cfg.custom))||3,note=item.notes?.[key]||"",options=cfg.anchors.map((anchor,index)=>`<option value="${index+1}" ${value===index+1?"selected":""}>${index+1} · ${escapeHtml(anchor)}</option>`).join("");return `<label class="edit-checkin-metric"><span>${escapeHtml(cfg.label)}</span><select data-edit-checkin-metric="${escapeHtml(key)}" data-custom="${cfg.custom?"1":"0"}">${options}</select><input data-edit-checkin-note="${escapeHtml(key)}" value="${escapeHtml(note)}" maxlength="800" placeholder="备注（可空）"></label>`}).join("");
  $("#edit-checkin-modal").hidden=false;$("#edit-checkin-factors").focus();
}

for(const eventName of ["wheel","pointerdown","pointermove","touchstart","touchmove","keydown"])document.addEventListener(eventName,event=>{const viewport=event.target.closest?.(".quote-bubble p.is-auto-scrolling");if(viewport)deferQuoteBubbleScroll(viewport)},{passive:true});
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&$("#view-quotes").classList.contains("active"))setupQuoteBubbleScroll()});
window.addEventListener("scroll",syncBookDetailCondensed,{passive:true});
window.addEventListener("resize",()=>requestAnimationFrame(()=>{syncSpeechTextOverflow();syncCaptureOverflow();syncQuoteOverflow();setupQuoteBubbleScroll();setupBookTitlePans()}),{passive:true});
document.addEventListener("click",e=>{
  const card=e.target.closest(".capture-item");if(!card?.classList.contains("is-expandable"))return;
  const toggle=e.target.closest("[data-capture-expand]");
  if(!toggle&&e.target.closest("button,a,input,textarea,select,.comment-anchor"))return;
  if(!toggle&&!window.getSelection()?.isCollapsed)return;
  toggleCaptureCard(card);
});
document.addEventListener("click",e=>{const button=e.target.closest("[data-quote-expand]");if(!button)return;const viewport=button.closest(".quote-entry-card")?.querySelector(".quote-content-viewport");if(!viewport)return;const expanded=!viewport.classList.contains("expanded");setLongContentExpanded(viewport.dataset.expandKey,expanded);viewport.classList.toggle("expanded",expanded);button.textContent=expanded?"收起":"展开";button.setAttribute("aria-expanded",String(expanded));scheduleAnnotationLineCounts()});
document.addEventListener("click",e=>{const button=e.target.closest("[data-speech-text-expand]");if(!button)return;const layer=button.closest("[data-speech-text-lines]");if(!layer?.classList.contains("is-collapsible"))return;const expanded=!layer.classList.contains("is-expanded");layer.classList.toggle("is-expanded",expanded);button.textContent=expanded?"收起":"展开";button.setAttribute("aria-expanded",String(expanded));button.setAttribute("aria-label",`${expanded?"收起":"展开"}${layer.dataset.speechTextLabel||"文稿"}`);requestAnimationFrame(syncCaptureOverflow)});
document.addEventListener("play",event=>{const audio=event.target;if(!(audio instanceof HTMLAudioElement))return;const controls=audio.closest(".speech-asset-controls"),rate=controls?.querySelector("[data-speech-playback-rate]");if(rate)audio.playbackRate=normalizeTtsPlaybackRate(rate.value);claimPageAudio(audio)},true);
document.addEventListener("change",e=>{if(e.target.matches("[data-trash-select]"))$("#trash-purge-selected").disabled=!$("[data-trash-select]:checked")});
document.addEventListener("click",async e=>{
  const restore=e.target.closest("[data-trash-restore]");if(!restore)return;
  restore.disabled=true;$("#trash-status").textContent="正在恢复…";
  try{await request(`/api/trash/${restore.dataset.trashRestore}/restore`,{method:"POST",body:"{}"});await refreshState(["dailyRecords","captures","journals","thoughts","checkins","chat","review","books","keepsakes","quotes"]);await loadTrash();showToast("记录已完整恢复")}
  catch(error){$("#trash-status").textContent=error.message;restore.disabled=false}
});
$("#trash-purge-selected").addEventListener("click",async e=>{
  const button=e.currentTarget,ids=$$("[data-trash-select]:checked").map(input=>input.value);if(!ids.length)return;
  button.disabled=true;$("#trash-status").textContent="正在生成永久清理清单…";
  try{
    const plan=await request("/api/trash/purge-preview",{method:"POST",body:JSON.stringify({ids})}),confirmation=prompt(`将永久清理 ${plan.items.length} 条记录，且无法恢复。请输入“永久删除”继续：`);
    if(confirmation!=="永久删除"){$("#trash-status").textContent="已取消永久清理。";return}
    const result=await request("/api/trash/purge",{method:"POST",body:JSON.stringify({ids,planHash:plan.planHash,confirmation})});
    await loadTrash();showToast(`已永久清理 ${result.purged} 条记录`);
  }catch(error){$("#trash-status").textContent=error.message}
  finally{button.disabled=!$("[data-trash-select]:checked")}
});
document.addEventListener("click",async e=>{
  const button=e.target.closest("[data-delete-checkin],[data-chat-delete],[data-experiment-delete],[data-analysis-delete],[data-book-delete]");if(!button)return;
  const target=button.dataset.deleteCheckin?{id:button.dataset.deleteCheckin,domain:"checkins",url:`/api/v1/checkins/${encodeURIComponent(button.dataset.deleteCheckin)}`,domains:["checkins","review"],label:"状态"}:button.dataset.chatDelete?{id:button.dataset.chatDelete,domain:"chats",url:`/api/v1/chats/${encodeURIComponent(button.dataset.chatDelete)}`,domains:["chats"],label:"对话"}:button.dataset.experimentDelete?{id:button.dataset.experimentDelete,domain:"experiments",url:`/api/v1/experiments/${encodeURIComponent(button.dataset.experimentDelete)}`,domains:["experiments","review"],label:"实验"}:button.dataset.analysisDelete?{id:button.dataset.analysisDelete,domain:"analyses",url:`/api/v1/analyses/${encodeURIComponent(button.dataset.analysisDelete)}`,domains:["analyses","review"],label:"复盘"}:{id:button.dataset.bookDelete,domain:"books",url:`/api/v1/books/${encodeURIComponent(button.dataset.bookDelete)}`,domains:["books","review"],label:"书目"};
  if(!confirm(`将这条${target.label}移入回收站？`))return;
  const item=(state[target.domain]||[]).find(value=>value.id===target.id);if(!item)return;const requestId=button.dataset.requestId||crypto.randomUUID();button.dataset.requestId=requestId;button.disabled=true;
  if(button.dataset.bookDelete){activeBookId="";activeBookFeatureNoteId="";bookDetailCondensed=false}
  try{await requestV1(target.url,{method:"DELETE",headers:{"if-match":`"${item.version||1}"`,"idempotency-key":requestId}},{domains:target.domains,resource:target.domain==="books"?`book:${target.id}`:target.url,recoverCommitted:true,projection:{kind:"record.delete",domain:target.domain,id:target.id},onQueued:record=>applyPendingProjection(record)});void refreshState(target.domains).catch(error=>showToast(`${target.label}已移除，但列表刷新失败：${error.message}`,"error"));showToast(`${target.label}已移入回收站`)}
  catch(error){if(error.syncStatus==="pending")showToast(`${target.label}将在网络恢复后移入回收站`);else{await refreshState(target.domains).catch(()=>{});showToast(error.message,"error")}}
});
document.addEventListener("click",event=>{const button=event.target.closest("[data-context-source]");if(button)openContextSource(button)});
$("#capture-create-toggle").addEventListener("click",()=>{
  if(captureComposerOpen){closeCaptureEditor();return}
  openCaptureEditor($("#capture-create-toggle"))
});
$("#capture-editor-close").addEventListener("click",()=>closeCaptureEditor());
$("#capture-editor").addEventListener("click",event=>{if(event.target===event.currentTarget)closeCaptureEditor()});
$("#analysis-load-more").addEventListener("click",()=>void loadMoreAnalyses());
document.addEventListener("input",event=>{
  const input=event.target.closest("[data-feed-search]");if(!input)return;
  const scope=input.dataset.feedSearch;if(!(scope in feedSearchQueries))return;
  feedSearchQueries[scope]=input.value;
  ({captures:renderCaptures,journals:renderJournals,books:renderBooks,keepsakes:renderKeepsakes,quotes:renderQuotes})[scope]?.()
});
document.addEventListener("click",event=>{
  const button=event.target.closest("[data-content-focus],[data-content-action]");if(!button)return;
  if(button.dataset.contentFocus){
    const target=document.getElementById(button.dataset.contentFocus);
    target?.scrollIntoView({behavior:"smooth",block:"center"});target?.focus();return
  }
  const command=button.dataset.contentAction;
  if(command==="new-capture"){openCaptureEditor(button);return}
  if(command==="new-state"){switchView("today");openHomeEditor("state",button);return}
  if(command==="new-keepsake"){$("#keepsake-create-toggle")?.click();return}
  if(command==="run-analysis"){$("#run-analysis")?.click();return}
  if(command==="retry-route-state"){button.disabled=true;void loadRouteState(pageRouter?.currentRoute()).finally(()=>{if(button.isConnected)button.disabled=false});return}
  const retries={
    "retry-trash":loadTrash,
    "retry-personal-context":loadPersonalContext,
    "retry-account-users":loadAccountUsers
  };
  if(retries[command])void retries[command]()
});

document.addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;if(b.dataset.view){closeHomeEditors({restoreFocus:false});return switchView(b.dataset.view)}if(b.dataset.go){closeHomeEditors({restoreFocus:false});return switchView(b.dataset.go)}if(b.dataset.removeDraftTag!=null){draftTags=draftTags.filter(tag=>tag!==b.dataset.removeDraftTag);return renderTagComposer()}if(b.dataset.removeCaptureTag!=null){captureDraftTags=captureDraftTags.filter(tag=>tag!==b.dataset.removeCaptureTag);return renderCaptureTagComposer()}});
document.addEventListener("click",async e=>{
  const button=e.target.closest("button");if(!button)return;
  if(button.dataset.journalPrompt){const editor=$("#journal-content"),prompt=button.dataset.journalPrompt,prefix=editor.value.trim()?"\n\n":"";editor.setRangeText(`${prefix}${prompt}\n`,editor.selectionStart,editor.selectionEnd,"end");editor.focus();return}
  if(button.dataset.journalAssist){
    const mode=button.dataset.journalAssist,editor=$("#journal-content"),status=$("#journal-assist-status"),buttons=$$("[data-journal-assist]"),labels={lead:"引子",structure:"结构",topic:"话题"},title=$("#journal-title").value,date=$("#journal-date").value,content=editor.value,journalId=$("#journal-id").value,owner=currentUser?.id,session=sessionSerial;
    buttons.forEach(item=>item.disabled=true);status.textContent=`正在生成${labels[mode]}…`;
    try{
      let streamed="";
      const requestId=crypto.randomUUID(),targetId=journalId||"journal-draft",inputVersion=Date.now(),result=await requestStream("/api/journals/assist",{method:"POST",body:JSON.stringify({requestId,targetId,inputVersion,mode,occurredAt:date,title,content})},event=>{if(event.type==="content"){streamed+=event.delta||"";status.textContent=`正在生成${labels[mode]}… ${streamed.length} 字`}});
      if(result.requestId&&result.requestId!==requestId)return;
      if(owner!==currentUser?.id||session!==sessionSerial||$("#journal-date").value!==date||$("#journal-title").value!==title||editor.value!==content||$("#journal-id").value!==journalId){status.textContent=`${labels[mode]}已生成，但当前日记已经变化，未自动追加。`;return}
      const addition=(result.content||streamed).trim();
      if(addition){editor.value+=`${editor.value.trim()?"\n\n":""}${addition}`;editor.selectionStart=editor.selectionEnd=editor.value.length;editor.focus();status.textContent=`${labels[mode]}已追加到正文末尾。`;showToast(`${labels[mode]}已追加`)}
    }catch(err){status.textContent=`生成失败：${err.message}`}finally{buttons.forEach(item=>item.disabled=false)}
    return;
  }
  if(button.dataset.captureEdit)return editCapture(button.dataset.captureEdit,button);
  if(button.dataset.journalEdit)return editJournal(button.dataset.journalEdit);
  if(button.dataset.editCheckin)return openCheckinEditor(button.dataset.editCheckin);
  if(button.dataset.captureThought){openThoughtDetail(button.dataset.captureThought);return}
  if(button.dataset.capturePromote){const item=(state.captures||[]).find(value=>value.id===button.dataset.capturePromote);if(!item)return;const form=$("#chain-form");form.reset();form.elements.sourceCaptureId.value=item.id;form.elements.sourceCaptureVersion.value=String(item.version||1);form.elements.recordKind.value="thought";activeDate=eventDate(item)||activeDate;renderDate();renderSliders();publishDomains(new Set(["thoughts"]));renderStateChart();renderHomeMood();renderChat();$("#chain-question").value="";$("#chain-idea").value=item.content;draftTags=[...(item.tags||[])];renderTagComposer();syncChainRecordKind();$("#chain-status").textContent="这条念起将保留为来源。补上一个明确问题，再形成完整思考。";switchView("today");openHomeEditor("thought",button);$("#chain-question").focus();return}
  if(button.dataset.captureDelete){const id=button.dataset.captureDelete,item=(state.captures||[]).find(value=>value.id===id);if(!item||!confirm("将这条捕念移入回收站？"))return;button.disabled=true;try{await requestV1(`/api/v1/captures/${encodeURIComponent(id)}`,{method:"DELETE",headers:{"if-match":`"${item.version||1}"`}},{domains:["captures"],recoverCommitted:true,projection:{kind:"record.delete",domain:"captures",id},onQueued:record=>applyPendingProjection(record)});void refreshState("captures").catch(error=>showToast(`捕念已移除，但列表刷新失败：${error.message}`,"error"));showToast("捕念已移入回收站")}catch(err){if(err.syncStatus==="pending")showToast("捕念将在网络恢复后移入回收站");else{await refreshState("captures").catch(()=>{});showToast(err.message,"error");button.disabled=false}}return}
  if(button.dataset.journalDelete){const id=button.dataset.journalDelete,item=(state.journals||[]).find(value=>value.id===id);if(!item||!confirm("将这篇日记及其助手回望移入回收站？"))return;button.disabled=true;try{await requestV1(`/api/v1/journals/${encodeURIComponent(id)}`,{method:"DELETE",headers:{"if-match":`"${item.version||1}"`}},{domains:["journals"],recoverCommitted:true,projection:{kind:"record.delete",domain:"journals",id},onQueued:record=>applyPendingProjection(record)});void refreshState("journals").catch(error=>showToast(`日记已移除，但列表刷新失败：${error.message}`,"error"));showToast("日记已移入回收站")}catch(err){if(err.syncStatus==="pending")showToast("日记将在网络恢复后移入回收站");else{await refreshState("journals").catch(()=>{});showToast(err.message,"error");button.disabled=false}}return}
  if(button.dataset.journalReflect){const id=button.dataset.journalReflect;button.disabled=true;try{await runAnswerInModal({title:"回望这篇日记",scene:"diaryReflection",requestCall:onEvent=>requestStream(`/api/journals/${id}/reflect`,{method:"POST",body:"{}"},onEvent),onDone:()=>refreshState("journals")});showToast("日记回望已保存")}catch(err){showToast(err.message,"error")}finally{button.disabled=false}}
});
$$("[data-active-date]").forEach(input=>input.addEventListener("change",async e=>{chainDraftVersion+=1;activeDate=e.target.value||activeDate;renderDate();renderSliders();publishDomains(new Set(["thoughts"]));renderStateChart();renderHomeMood();renderChat();await healthFeatureController?.changeDate(activeDate).catch(error=>showToast(`健康截图恢复失败：${error.message}`,"error"))}));
$$("[data-content-image-editor] input[type='file']").forEach(input=>input.addEventListener("change",async event=>{
  const fileInput=event.currentTarget,editor=fileInput.closest("[data-content-image-editor]"),status=editor?.closest("form")?.querySelector(".status");
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
  const editor=remove.closest("[data-content-image-editor]"),draft=contentImageDraft(editor?.dataset.contentImageEditor),index=Number(remove.dataset.contentImageRemove);
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
$("#capture-tags").addEventListener("keydown",e=>{if(entryKeyIntent(e,{inputKind:"tag"})==="commit-tag"){e.preventDefault();commitCaptureTags()}});
$("#capture-audio-record").addEventListener("click",()=>void requestCaptureAudioRecording());
$("#capture-audio-pause").addEventListener("click",toggleCaptureAudioPause);
$("#capture-audio-stop").addEventListener("click",stopCaptureAudioRecording);
$("#capture-audio-remove").addEventListener("click",cancelCaptureAudioRecording);
$("#capture-audio-file").addEventListener("change",async event=>{
  const fileInput=event.currentTarget,file=fileInput.files?.[0];if(!file)return;
  try{await setCaptureAudioBlob(file,await importedAudioDuration(file));$("#capture-audio-recorder").open=false;delete $("#capture-form").dataset.requestId;$("#capture-audio-status").textContent="音频已保存在本机，提交后同步。"}
  catch(error){captureAudioDraft.lastError=captureAudioInputError(error);renderCaptureAudioDraft()}
  finally{fileInput.value=""}
});
document.addEventListener("click",async event=>{
  const transcribe=event.target.closest("[data-capture-transcribe]");
  if(transcribe){
    const capture=state.captures.find(item=>item.id===transcribe.dataset.captureTranscribe),audioKey=transcribe.dataset.captureAudioKey;
    if(!capture||!audioKey||captureAudioIdentity(capture)!==audioKey){showToast("原音已经变化，请在当前记录上重新开始转写。","error");return}
    transcribe.disabled=true;
    try{
      const task=await request(`/api/captures/${encodeURIComponent(transcribe.dataset.captureTranscribe)}/transcription`,{method:"POST",body:"{}"});
      if(task?.targetId!==capture.id||captureAudioIdentity(state.captures.find(item=>item.id===capture.id))!==audioKey)return;
      if(!state.aiTasks.some(item=>item.id===task.id))state.aiTasks.unshift(task);
      if(capture?.transcription)capture.transcription.status="queued";
      renderCaptures();await refreshState("notifications");scheduleNotificationPoll();showToast("语音已进入后台转写队列")
    }catch(error){
      showToast(presentError(error,{
        operation:"开始语音转写",
        object:"这段录音",
        phase:"语音转写排队",
        retained:"原音已经保存"
      }).message,"error");transcribe.disabled=false
    }
    return
  }
  const generate=event.target.closest("[data-speech-synthesize]");
  if(generate){
    const controls=generate.closest(".speech-asset-controls"),sourceType=controls?.dataset.speechSourceType;if(sourceType!=="capture")return;
    const sourceId=controls?.dataset.speechSourceId,sourceVersion=Number(controls?.dataset.speechSourceVersion),source=(state.captures||[]).find(item=>item.id===sourceId),status=controls?.querySelector(".speech-asset-status");
    if(!source||Number(source.version||1)!==sourceVersion){if(status)status.textContent="文字来源已经变化，请在当前版本上重新生成。";return}
    const asset=speechAssetForSource(state.speech.assets,{sourceType,sourceId,sourceVersion}),regenerate=generate.dataset.speechRegenerate==="true"&&Boolean(asset),payload=speechSynthesisPayload({sourceType,sourceId,sourceVersion,regenerate});
    stopPageAudio();generate.disabled=true;if(status)status.textContent=regenerate?"正在重新生成…":"正在生成…";let generated=false;
    try{
      await apiClient.requestBlob("/api/speech/synthesize",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)},{fallback:"语音合成失败"});generated=true;
      await refreshState(["speech","captures"]);showToast(regenerate?"文字朗读已重新生成":"文字朗读已生成")
    }catch(error){
      if(generated){if(status?.isConnected)status.textContent="音频已生成，但列表刷新失败，请稍后重试读取。";showToast("音频已生成，但列表刷新失败","error")}
      else{if(status)status.textContent=presentError(error,{operation:"生成文字朗读",object:"这次文字朗读",phase:"文字朗读生成",retained:"原音和文字记录没有变化"}).message}
    }finally{if(generate.isConnected)generate.disabled=false}
    return
  }
});
document.addEventListener("change",event=>{
  const control=event.target.closest("[data-speech-playback-rate]");if(!control)return;
  if(control.closest(".speech-asset-controls")?.dataset.speechSourceType!=="capture")return;
  const player=control.closest(".speech-asset-controls")?.querySelector("[data-speech-player]");if(player)player.playbackRate=normalizeTtsPlaybackRate(control.value)
});
$("#capture-cancel").addEventListener("click",resetCaptureForm);
$("#journal-cancel").addEventListener("click",resetJournalForm);
for(const id of durableDraftForms)for(const eventName of["input","change"])document.getElementById(id)?.addEventListener(eventName,saveDurableDrafts);
document.addEventListener("keydown",event=>{
  const field=event.target.closest?.("input,textarea"),form=field?.closest?.("#capture-form,#journal-form,#chain-form,#checkin-form,#chat-form,[data-daily-form],[data-book-entry-form],#keepsake-form,#quote-form,#selection-quote-form,#thought-block-form");
  if(!field||!form||field===document.activeElement&&["chain-tags","capture-tags","quote-tags","selection-quote-tags"].includes(field.id))return;
  const intent=entryKeyIntent(event,{inputKind:field.tagName==="TEXTAREA"?"multiline":"field"});
  if(intent==="submit")return void occurrenceKeyboardSubmit(event,form,field.tagName==="TEXTAREA"?"multiline":"field");
  if(intent==="block-submit")event.preventDefault()
});
function captureSubmissionError(error,stage){
  const context={
    images:{operation:"上传捕念图片",object:"这些图片",phase:"捕念图片上传",retained:"捕念草稿和待上传图片仍保存在当前页面"},
    audio:{operation:"上传捕念语音",object:"这段语音",phase:"捕念语音上传",retained:"捕念草稿和待提交语音仍保存在当前页面"},
    validation:{operation:"保存这条捕念",object:"这条捕念",retained:"当前表单内容仍保留"},
    save:{operation:"保存这条捕念",object:"这条捕念",retained:"当前表单内容和待提交媒体仍保留"}
  }[stage]||{operation:"保存这条捕念",object:"这条捕念",retained:"当前表单内容仍保留"};
  return presentError(error,{...context,publicValidation:error?.publicValidation===true}).message
}
$("#capture-form").addEventListener("submit",async e=>{
  e.preventDefault();const pendingStartedAt=performance.now();if($("#capture-tags").value.trim())commitCaptureTags();
  const form=e.currentTarget,id=$("#capture-id").value,existing=id?(state.captures||[]).find(item=>item.id===id):null,button=$("#capture-submit"),status=$("#capture-status"),requestId=form.dataset.requestId||crypto.randomUUID(),temporaryId=`pending:${requestId}`;let uploadedPaths=[],uploadedAudioPath="",projected=false,stage="images";
  if(!id)form.dataset.requestId=requestId;button.disabled=true;status.textContent=id?"正在保存修改…":"正在收下…";
  if(document.documentElement.dataset.nativePerformance==="1"||new URLSearchParams(location.search).has("native-performance")){const label=`提交等待 ${(performance.now()-pendingStartedAt).toFixed(1)} 毫秒`,metric=$("#capture-pending-metric");metric.textContent=label;setTimeout(()=>{if(metric.textContent===label)metric.textContent=""},5000)}
  try{
    const submission=await contentImagePaths("capture");uploadedPaths=submission.uploadedPaths;if(uploadedPaths.length)status.textContent="图片已上传，正在同步记录…";
    stage="audio";
    const audio=await captureAudioForSubmission();if(audio?.attachmentPath===captureAudioDraft.uploadedPath){uploadedAudioPath=audio.attachmentPath;status.textContent="语音已上传，正在同步记录…"}
    stage="validation";
    const payload=runPublicValidation(()=>({...occurrenceFields($("#capture-date")),...captureRecordPayload({content:$("#capture-content").value,attachmentPaths:submission.attachmentPaths,audio}),tags:[...captureDraftTags]}));
    stage="save";
    if(id){const result=await requestV1(`/api/v1/captures/${encodeURIComponent(id)}`,{method:"PATCH",headers:{"if-match":`"${existing?.version||1}"`},body:JSON.stringify(payload)},{domains:["captures"],recoverCommitted:true,projection:{kind:"record.update",domain:"captures",id,payload},onQueued:record=>{projected=applyPendingProjection(record)}});if(result.data)state.captures=(state.captures||[]).map(item=>item.id===id?result.data:item);renderCaptures()}
    else{
      const result=await requestV1("/api/v1/captures",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{
        domains:["captures"],
        projection:{kind:"capture.create",temporaryId,payload},
        onQueued:record=>{
          state.captures=[{id:temporaryId,...payload,createdAt:record.createdAt,_sync:{status:"sending",operationId:record.operationId}},...(state.captures||[]).filter(item=>item.id!==temporaryId)];
          projected=true;renderCaptures();status.textContent="已记下，正在同步…";
        }
      });
      state.captures=(state.captures||[]).map(item=>item.id===temporaryId?result.data:item);renderCaptures();
    }
    resetCaptureForm();void refreshState("captures").catch(error=>showToast(presentError(error,{
      operation:"刷新捕念列表",
      object:"捕念列表",
      phase:"捕念列表刷新",
      retained:"刚才的捕念已经保存"
    }).message,"error"));showToast(id?"捕念已更新":"已收进捕念");
  }catch(err){
    if(projected&&err.syncStatus==="pending"){
      const pending=(state.captures||[]).find(item=>item.id===temporaryId);if(pending)pending._sync.status="pending";renderCaptures();resetCaptureForm({preserveUploads:true});$("#capture-status").textContent="已记下，网络恢复后自动同步。";showToast("捕念已进入待同步队列");
    }else if(projected&&err.syncStatus==="conflict"){
      if(id)await refreshState("captures").catch(()=>{});else{state.captures=(state.captures||[]).filter(item=>item.id!==temporaryId);renderCaptures()}await Promise.all([discardContentImageUploads("capture",uploadedPaths),rollbackCaptureAudioUpload(uploadedAudioPath)]);status.textContent=presentError(err,{operation:"保存这条捕念",object:"这条捕念",retained:"当前表单内容仍保留，已有记录没有被覆盖"}).message;showToast("捕念同步发生冲突","error")
    }else{
      if(projected){if(id)await refreshState("captures").catch(()=>{});else{state.captures=(state.captures||[]).filter(item=>item.id!==temporaryId);renderCaptures()}}
      await Promise.all([discardContentImageUploads("capture",uploadedPaths),rollbackCaptureAudioUpload(uploadedAudioPath)]);status.textContent=captureSubmissionError(err,stage);
    }
  }finally{button.disabled=false}
});
$("#journal-draft-save").addEventListener("click",async e=>{const button=e.currentTarget,status=$("#journal-status");button.disabled=true;button.textContent="正在保存…";status.textContent="正在保存草稿…";try{const draft=await request("/api/journal-draft",{method:"PUT",body:JSON.stringify({journalId:$("#journal-id").value,title:$("#journal-title").value,content:$("#journal-content").value})});state.journalDraft=draft;status.textContent=`草稿已保存于 ${formatTime(draft.updatedAt)}。`;showToast("日记草稿已保存")}catch(err){status.textContent=presentError(err,{operation:"保存日记草稿",object:"这份日记草稿",phase:"日记草稿保存",retained:"标题和正文仍保留在当前页面"}).message}finally{button.disabled=false;button.textContent="保存草稿"}});
$("#journal-form").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget,id=$("#journal-id").value,existing=id?(state.journals||[]).find(item=>item.id===id):null,button=$("#journal-submit"),status=$("#journal-status"),requestId=form.dataset.requestId||crypto.randomUUID(),temporaryId=`pending:${requestId}`;let payload;if(!id)form.dataset.requestId=requestId;button.disabled=true;status.textContent=id?"正在保存修改…":"正在保存原文…";
  try{
    payload=runPublicValidation(()=>({...occurrenceFields($("#journal-date")),title:$("#journal-title").value,content:$("#journal-content").value,tags:splitTags($("#journal-tags").value)}));
    if(id){const result=await requestV1(`/api/v1/journals/${encodeURIComponent(id)}`,{method:"PATCH",headers:{"if-match":`"${existing?.version||1}"`},body:JSON.stringify(payload)},{domains:["journals"],recoverCommitted:true,projection:{kind:"record.update",domain:"journals",id,payload},onQueued:record=>applyPendingProjection(record)});if(result.data)state.journals=(state.journals||[]).map(item=>item.id===id?result.data:item);renderJournals()}
    else{
      const result=await requestV1("/api/v1/journals",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{domains:["journals"],projection:{kind:"record.create",domain:"journals",temporaryId,payload},onQueued:record=>applyPendingProjection(record)});
      state.journals=(state.journals||[]).map(item=>item.id===temporaryId?result.data:item);renderJournals()
    }
    delete form.dataset.requestId;resetJournalForm();void refreshState("journals").catch(error=>showToast(presentError(error,{operation:"刷新日记列表",object:"日记列表",phase:"日记列表刷新",retained:"刚才的日记已经保存"}).message,"error"));showToast(id?"日记已更新":"日记已保存")
  }catch(err){
    if(err.syncStatus==="pending"){resetJournalForm();status.textContent="原文已留存，网络恢复后自动同步。";showToast("日记已进入待同步队列")}
    else if(err.syncStatus==="conflict"){if(id)await refreshState("journals").catch(()=>{});status.textContent=presentError(err,{operation:"保存这篇日记",object:"这篇日记",retained:"当前编辑内容仍保留，已有日记没有被覆盖"}).message}
    else{if(id)await refreshState("journals").catch(()=>{});status.textContent=presentError(err,{operation:"保存这篇日记",object:"这篇日记",retained:"标题和正文仍保留在当前页面",publicValidation:err?.publicValidation===true}).message}
  }finally{button.disabled=false}
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
      state.captures=(state.captures||[]).map(item=>item.id===temporaryId?result:item);renderCaptures();await clearSubmittedContentImageDraft("thoughtRoot");chainDraftVersion+=1;form.reset();clearDurableDraft("chain-form");resetOccurrenceInput($("#chain-datetime"));draftTags=[];renderTagComposer();answerDraft="";answerReasoningDraft="";delete form.dataset.requestId;delete form.dataset.draftId;$("#chain-status").textContent="已收进念起。";closeHomeEditors();void refreshState("captures").catch(error=>showToast(`念起已保存，但页面刷新失败：${error.message}`,"error"));showToast("已收进念起");return
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
  const viewer=$("#image-viewer"),homeEditor=$$(".home-v02-editor-backdrop").find(editor=>!editor.hidden),captureEditor=$("#capture-editor"),answerModal=$("#ai-answer-modal");
  if(!viewer.hidden){
    if(e.key==="Tab")return trapHomeEditorFocus(e,viewer);
    if(e.key==="Escape"){e.preventDefault();return closeImageViewer()}
    if(e.key==="ArrowLeft"){e.preventDefault();return moveImageViewer(-1)}
    if(e.key==="ArrowRight"){e.preventDefault();return moveImageViewer(1)}
    return
  }
  if(homeEditor&&answerModal.hidden&&e.key==="Tab")return trapHomeEditorFocus(e,homeEditor);
  if(!captureEditor.hidden&&answerModal.hidden&&e.key==="Tab")return trapHomeEditorFocus(e,captureEditor);
  if(e.key!=="Escape")return;
  if(!answerModal.hidden)return closeAnswerModal();
  if(!captureEditor.hidden)return closeCaptureEditor();
  if(!$("#thought-block-modal").hidden)return $("#thought-block-modal").hidden=true;
  if(!$("#edit-checkin-modal").hidden)return $("#edit-checkin-modal").hidden=true;
  if(!$("#association-flow-modal").hidden)return setAssociationFlowOpen(false);
  if(homeEditor)closeHomeEditors()
});
$("#association-flow-toggle").addEventListener("click",()=>setAssociationFlowOpen(true));
$("#association-flow-close").addEventListener("click",()=>setAssociationFlowOpen(false));
$("#association-flow-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)setAssociationFlowOpen(false)});
$("#run-analysis").addEventListener("click",async e=>{const button=e.currentTarget;button.disabled=true;$("#analysis-status").textContent="正在比较模型草稿与你最终保留的回答，以及你保留、舍弃和长期缺席的主题…";try{await requestV1("/api/v1/analyses",{method:"POST",headers:{"idempotency-key":crypto.randomUUID()},body:"{}"},{domains:["analyses"]});void refreshState("review").catch(error=>showToast(`复盘已生成，但页面刷新失败：${error.message}`,"error"));$("#analysis-status").textContent="";showToast("认知复盘已生成")}catch(err){$("#analysis-status").textContent=err.message}finally{button.disabled=false}});
$("#experiment-form").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget,requestId=form.dataset.requestId||crypto.randomUUID();form.dataset.requestId=requestId;try{await requestV1("/api/v1/experiments",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify({hypothesis:$("#experiment-hypothesis").value,factor:$("#experiment-factor").value,outcome:$("#experiment-outcome").value,duration:$("#experiment-duration").value})},{domains:["experiments"]});delete form.dataset.requestId;form.reset();void refreshState("review")}catch(error){if(error.syncStatus!=="pending")showToast(error.message,"error");else{form.reset();showToast("实验已进入待同步队列")}}});
$("#metric-form").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget,requestId=form.dataset.requestId||crypto.randomUUID();form.dataset.requestId=requestId;try{await requestV1("/api/v1/custom-metrics",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify({name:$("#metric-name").value,low:$("#metric-low").value,high:$("#metric-high").value})},{domains:["customMetrics"]});delete form.dataset.requestId;form.reset();void refreshState(["review","checkins"])}catch(error){if(error.syncStatus!=="pending")showToast(error.message,"error");else{form.reset();showToast("指标已进入待同步队列")}}});
for(const role of ["cover","recognition"]){
  const ui=bookImageUi[role],input=$(ui.input),box=$(ui.box);
  input.addEventListener("change",e=>{const file=e.currentTarget.files?.[0];bookImagePasteTarget=role;if(file&&!setBookImage(role,file,"本地文件"))e.currentTarget.value=""});
  box.addEventListener("focusin",()=>bookImagePasteTarget=role);
  box.addEventListener("pointerdown",()=>bookImagePasteTarget=role);
  box.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();input.click()}});
  box.addEventListener("dragenter",e=>{e.preventDefault();bookImagePasteTarget=role;e.currentTarget.classList.add("dragging")});
  box.addEventListener("dragover",e=>{e.preventDefault();e.dataTransfer.dropEffect="copy";e.currentTarget.classList.add("dragging")});
  box.addEventListener("dragleave",e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.classList.remove("dragging")});
  box.addEventListener("drop",e=>{e.preventDefault();e.currentTarget.classList.remove("dragging");const file=[...(e.dataTransfer?.files||[])].find(item=>item.type.startsWith("image/"));if(!file)return $("#book-parse-status").textContent="拖入的内容里没有可用图片。";setBookImage(role,file,"拖入图片")});
}
$("#book-cover-remove").addEventListener("click",()=>{$("#book-image-path").value="";resetBookImage("cover");$("#book-parse-status").textContent="封面已移除，保存后生效。"});
$("#book-recognition-remove").addEventListener("click",()=>{resetBookImage("recognition");$("#book-parse-status").textContent=""});
$("#book-image-swap").addEventListener("click",async e=>{
  const button=e.currentTarget,recognitionFile=pendingBookImages.recognition;
  if(!recognitionFile)return;
  button.disabled=true;
  try{
    const coverFile=await currentBookCoverFile();
    if(!coverFile)return;
    $("#book-image-path").value="";
    setBookImage("cover",recognitionFile,"交换后作为封面");
    setBookImage("recognition",coverFile,"交换后用于识别");
    bookImagePasteTarget="recognition";
    $("#book-parse-status").textContent="封面与识别图已交换。";
  }catch(error){$("#book-parse-status").textContent=error.message}
  finally{updateBookImageSwapButton()}
});
$("#book-create-toggle").addEventListener("click",()=>{if(bookCreatorOpen){bookCreatorOpen=false;resetBookForm()}else{resetBookForm();bookCreatorOpen=true}renderBooks();if(bookCreatorOpen)$("#book-create-panel").scrollIntoView({behavior:"smooth",block:"start"})});
$("#book-edit-cancel").addEventListener("click",()=>{const bookId=editingBookId;resetBookForm();bookCreatorOpen=false;activeBookId=bookId;activeBookFeatureNoteId="";bookDetailCondensed=false;window.scrollTo({top:0,behavior:"auto"});renderBooks()});
$("#book-reading-start").addEventListener("input",syncBookReadingDates);
$("#book-reading-end").addEventListener("input",syncBookReadingDates);
$("#book-form").addEventListener("input",()=>{bookParseSerial+=1;$("#parse-book").disabled=!pendingBookImages.recognition});
document.addEventListener("paste",e=>{if(!$("#view-books").classList.contains("active")||$("#book-create-panel").hidden||(e.target instanceof Element&&e.target.closest('input:not([type="file"]),textarea,[contenteditable=true]')))return;const file=[...(e.clipboardData?.files||[])].find(item=>item.type.startsWith("image/"));if(!file)return;e.preventDefault();setBookImage(bookImagePasteTarget,file,"剪贴板")});
$("#parse-book").addEventListener("click",async e=>{
  const button=e.currentTarget,file=pendingBookImages.recognition||$("#book-recognition-image").files?.[0];if(!file)return $("#book-parse-status").textContent="请先选择、粘贴或拖入一张识别图。";
  const serial=++bookParseSerial,bookId=editingBookId,owner=currentUser?.id,session=sessionSerial,requestId=crypto.randomUUID(),targetId=bookId||"book-draft";button.disabled=true;$("#book-parse-status").textContent="正在识别并查询书目…";
  try{const images=await imageDataUrls([file]);if(serial!==bookParseSerial||file!==pendingBookImages.recognition||bookId!==editingBookId||owner!==currentUser?.id||session!==sessionSerial)return;const result=await request("/api/images/parse",{method:"POST",body:JSON.stringify({requestId,targetId,inputVersion:serial,kind:"book",images})});if(serial!==bookParseSerial||file!==pendingBookImages.recognition||bookId!==editingBookId||owner!==currentUser?.id||session!==sessionSerial||(result.requestId&&result.requestId!==requestId)||(result.targetId&&result.targetId!==targetId)||(Object.hasOwn(result,"inputVersion")&&Number(result.inputVersion)!==serial)){$("#book-parse-status").textContent="识别已完成，但当前书目已经变化，未自动回填。";return}for(const k of["title","author","publisher","isbn","description"])$(`#book-${k}`).value=result[k]||"";$("#book-parse-status").textContent=result.verification||"识别完成，请确认书目信息。"}
  catch(err){if(serial===bookParseSerial&&bookId===editingBookId&&owner===currentUser?.id&&session===sessionSerial)$("#book-parse-status").textContent=err.message}
  finally{if(serial===bookParseSerial&&bookId===editingBookId&&owner===currentUser?.id&&session===sessionSerial)button.disabled=false}
});
$("#book-form").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget,button=$("#book-submit"),bookId=editingBookId,existing=bookId?(state.books||[]).find(item=>item.id===bookId):null,requestId=form.dataset.requestId||crypto.randomUUID(),temporaryId=`pending:${requestId}`,coverUploadRequestId=`${requestId}:cover`;let uploadedCoverPath="";if(!bookId)form.dataset.requestId=requestId;button.disabled=true;
  try{
    let imagePath=$("#book-image-path").value;
    if(pendingBookImages.cover){$("#book-parse-status").textContent="正在上传封面…";const [image]=await imageDataUrls([pendingBookImages.cover]);[uploadedCoverPath]=await uploadOriginalImages({request,images:[image],idempotencyKey:coverUploadRequestId});imagePath=uploadedCoverPath}
    const payload={title:$("#book-title").value,author:$("#book-author").value,publisher:$("#book-publisher").value,isbn:$("#book-isbn").value,readingStartedOn:$("#book-reading-start").value,readingFinishedOn:$("#book-reading-end").value,description:$("#book-description").value,imagePath};
    if(bookId){const result=await requestV1(`/api/v1/books/${encodeURIComponent(bookId)}`,{method:"PATCH",headers:{"if-match":`"${existing?.version||1}"`},body:JSON.stringify(payload)},{resource:`book:${bookId}`,domains:["books"],recoverCommitted:true,projection:{kind:"record.update",domain:"books",id:bookId,payload},onQueued:record=>applyPendingProjection(record)});const book=state.books.find(item=>item.id===bookId);if(book){Object.assign(book,result.data||payload,{updatedAt:new Date().toISOString()});delete book._sync}}
    else{
      const result=await requestV1("/api/v1/books",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{domains:["books"],projection:{kind:"record.create",domain:"books",temporaryId,payload:{...payload,notes:[]}},onQueued:record=>applyPendingProjection(record)});
      state.books=[result.data,...(state.books||[]).filter(item=>item.id!==temporaryId&&item.id!==result.data.id)];renderBooks()
    }
    resetBookForm();bookCreatorOpen=false;activeBookId=bookId||"";renderBooks();void refreshState("books").catch(error=>showToast(`书目已保存，但列表刷新失败：${error.message}`,"error"));showToast(bookId?"书目信息已更新":"书目已加入书架");
  }catch(err){
    if(err.syncStatus==="pending"){resetBookForm();bookCreatorOpen=false;activeBookId=bookId||"";renderBooks();showToast(bookId?"书目修改将在网络恢复后同步":"书目已进入待同步队列")}
    else{if(!bookId){state.books=(state.books||[]).filter(item=>item.id!==temporaryId);renderBooks()}else await refreshState("books").catch(()=>{});if(uploadedCoverPath)await discardUploadedImagePath(uploadedCoverPath,coverUploadRequestId);$("#book-parse-status").textContent=err.message}
  }finally{button.disabled=false}
});
document.addEventListener("submit",async e=>{
  const form=e.target.closest("[data-book-entry-form]");if(!form)return;e.preventDefault();
  const bookId=form.dataset.bookEntryForm,noteId=form.elements.noteId.value,button=form.querySelector('[type="submit"]'),status=form.querySelector(".status"),payload={...occurrenceFields(form.elements.occurredAt),type:form.elements.type.value,favorite:form.elements.favorite.value,content:form.elements.content.value},requestId=form.dataset.requestId||crypto.randomUUID(),temporaryId=`pending:${requestId}`;let savedNoteId=noteId;if(!noteId)form.dataset.requestId=requestId;
  button.disabled=true;status.textContent=noteId?"正在保存修改…":"正在写入时间线…";
  try{
    if(noteId){const book=state.books.find(item=>item.id===bookId),note=book?.notes?.find(item=>item.id===noteId),result=await requestV1(`/api/v1/books/${encodeURIComponent(bookId)}/notes/${encodeURIComponent(noteId)}`,{method:"PATCH",headers:{"if-match":`"${note?.version||1}"`},body:JSON.stringify(payload)},{resource:`book:${bookId}`,domains:["books"],recoverCommitted:true,projection:{kind:"book.note.update",bookId,id:noteId,payload},onQueued:record=>applyPendingProjection(record)});if(note){Object.assign(note,result.data||payload,{updatedAt:new Date().toISOString()});delete note._sync}renderBooks()}
    else{
      const result=await requestV1(`/api/v1/books/${encodeURIComponent(bookId)}/notes`,{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{domains:["books"],resource:`book:${bookId}`,projection:{kind:"book.note.create",bookId,temporaryId,payload},onQueued:record=>applyPendingProjection(record)});
      savedNoteId=result.data.id;
      const book=state.books.find(item=>item.id===bookId);if(book)book.notes=[result.data,...(book.notes||[]).filter(item=>item.id!==temporaryId&&item.id!==result.data.id)];pendingBookNoteId=savedNoteId;renderBooks()
    }
    delete form.dataset.requestId;pendingBookNoteId=savedNoteId;void refreshState("books").catch(error=>showToast(`读书记录已保存，但列表刷新失败：${error.message}`,"error"));showToast(noteId?"读书记录已更新":"读书记录已保存")
  }
  catch(err){
    if(err.syncStatus==="pending"){renderBooks();showToast("读书记录已进入待同步队列")}
    else{
      if(!noteId){const book=state.books.find(item=>item.id===bookId);if(book)book.notes=(book.notes||[]).filter(item=>item.id!==temporaryId)}
      renderBooks();const retry=$("#book-detail [data-book-entry-form]");
      if(retry){retry.elements.noteId.value=noteId;retry.elements.type.value=payload.type;retry.elements.favorite.value=payload.favorite;resetOccurrenceInput(retry.elements.occurredAt,payload);retry.elements.content.value=payload.content;retry.querySelector(".status").textContent=err.message;if(noteId){retry.querySelector("[data-book-entry-heading]").textContent="编辑记录";retry.querySelector("[data-book-entry-cancel]").hidden=false;retry.querySelector('[type="submit"]').textContent="保存修改"}}
    }
  }
});
document.addEventListener("click",async e=>{
  const button=e.target.closest("button");if(!button)return;
  const openId=button.dataset.openBook||button.dataset.bookMemory;
  if(openId){window.scrollTo({top:0,behavior:"auto"});activeBookId=openId;activeBookFeatureNoteId="";bookDetailCondensed=false;pendingBookNoteId=button.dataset.bookNote||"";bookCreatorOpen=false;renderBooks();return}
  if(button.dataset.bookBack!=null){activeBookId="";activeBookFeatureNoteId="";pendingBookNoteId="";setBookDetailCondensed(false);renderBooks();window.scrollTo({top:0,behavior:"smooth"});return}
  if(button.dataset.bookAddNote!=null){$("#book-detail [data-book-entry-form]")?.scrollIntoView({behavior:"smooth",block:"center"});return}
  if(button.dataset.bookFeatureNote){document.querySelector(`#book-note-${CSS.escape(button.dataset.bookFeatureNote)}`)?.scrollIntoView({behavior:"smooth",block:"center"});return}
  if(button.dataset.bookEntryCancel!=null){renderBooks();return}
  if(button.dataset.bookEdit){const editBook=state.books.find(item=>item.id===button.dataset.bookEdit);if(editBook)openBookEditor(editBook);return}
  const book=state.books.find(item=>item.id===activeBookId);
  if(!book)return;
  if(button.dataset.bookNoteEdit){
    const note=(book.notes||[]).find(item=>item.id===button.dataset.bookNoteEdit),form=$("#book-detail [data-book-entry-form]");if(!note||!form)return;
    form.elements.noteId.value=note.id;form.elements.type.value=note.type||"record";form.elements.favorite.value=note.favorite||"none";resetOccurrenceInput(form.elements.occurredAt,note);form.elements.content.value=note.content;form.querySelector("[data-book-entry-heading]").textContent="编辑记录";form.querySelector("[data-book-entry-cancel]").hidden=false;form.querySelector('[type="submit"]').textContent="保存修改";form.scrollIntoView({behavior:"smooth",block:"center"});form.elements.content.focus();return;
  }
  if(button.dataset.bookNoteFavorite){
    const note=(book.notes||[]).find(item=>item.id===button.dataset.bookNoteFavorite);if(!note)return;
    const payload={occurredAt:eventTimestamp(note),type:note.type,content:note.content,favorite:button.dataset.nextFavorite};button.disabled=true;try{await requestV1(`/api/v1/books/${encodeURIComponent(book.id)}/notes/${encodeURIComponent(note.id)}`,{method:"PATCH",headers:{"if-match":`"${note.version||1}"`},body:JSON.stringify(payload)},{resource:`book:${book.id}`,domains:["books"],recoverCommitted:true,projection:{kind:"book.note.update",bookId:book.id,id:note.id,payload},onQueued:record=>applyPendingProjection(record)});pendingBookNoteId=note.id;void refreshState("books").catch(error=>showToast(`收藏状态已更新，但列表刷新失败：${error.message}`,"error"));showToast(button.dataset.nextFavorite==="star"?"已标为星标":button.dataset.nextFavorite==="sprout"?"已标为萌芽":"已取消收藏")}catch(err){if(err.syncStatus==="pending")showToast("收藏状态将在网络恢复后同步");else{await refreshState("books").catch(()=>{});showToast(err.message,"error");button.disabled=false}}return;
  }
  if(button.dataset.bookNoteDelete){
    const note=(book.notes||[]).find(item=>item.id===button.dataset.bookNoteDelete);if(!note||!confirm(`将这条${note.type==="thought"?"附加思考":"记录"}移入回收站？`))return;
    button.disabled=true;try{await requestV1(`/api/v1/books/${encodeURIComponent(book.id)}/notes/${encodeURIComponent(note.id)}`,{method:"DELETE",headers:{"if-match":`"${note.version||1}"`}},{resource:`book:${book.id}`,domains:["books"],recoverCommitted:true,projection:{kind:"book.note.delete",bookId:book.id,id:note.id},onQueued:record=>applyPendingProjection(record)});void refreshState("books").catch(error=>showToast(`读书记录已移除，但列表刷新失败：${error.message}`,"error"));showToast("读书记录已移入回收站")}catch(err){if(err.syncStatus==="pending")showToast("读书记录将在网络恢复后移入回收站");else{await refreshState("books").catch(()=>{});showToast(err.message,"error");button.disabled=false}}
  }
});
$("#keepsake-create-toggle").addEventListener("click",()=>{const workspace=$("#keepsake-workspace"),opening=workspace.hidden;if(opening){if(keepsakeBatch.items.length)void loadKeepsakeBatchItem(keepsakeBatch.activeIndex,{capture:false});else resetKeepsakeEditor();workspace.hidden=false;workspace.scrollIntoView({behavior:"smooth",block:"start"})}else{void persistKeepsakeBatch();resetKeepsakeEditor({close:true});renderKeepsakeBatch()}});
$("#keepsake-load-more").addEventListener("click",loadNextKeepsakePage);
$("#keepsake-editor-close").addEventListener("click",()=>{void persistKeepsakeBatch();resetKeepsakeEditor({close:true});renderKeepsakeBatch()});
$("#keepsake-cancel-edit").addEventListener("click",()=>{resetKeepsakeEditor();$("#keepsake-workspace").scrollIntoView({behavior:"smooth",block:"start"})});
$("#keepsake-image").addEventListener("change",async e=>{const fileInput=e.currentTarget,files=[...(fileInput.files||[])];if(!files.length)return;try{if($("#keepsake-id").value)await setKeepsakeFile(files[0]);else await setKeepsakeBatchFiles(files)}catch(error){$("#keepsake-segment-status").textContent=error.message}finally{fileInput.value=""}});
$("#keepsake-batch-add").addEventListener("click",()=>$("#keepsake-image").click());
document.addEventListener("click",e=>{const button=e.target.closest("[data-keepsake-batch-select]");if(button&&!keepsakeBatch.loading)void loadKeepsakeBatchItem(Number(button.dataset.keepsakeBatchSelect))});
document.addEventListener("click",e=>{const button=e.target.closest("[data-keepsake-batch-remove]");if(button&&!keepsakeBatch.loading)void removeKeepsakeBatchItem(Number(button.dataset.keepsakeBatchRemove))});
$("#keepsake-upload-box").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();$("#keepsake-image").click()}});
$("#keepsake-upload-box").addEventListener("dragenter",e=>{e.preventDefault();e.currentTarget.classList.add("dragging")});
$("#keepsake-upload-box").addEventListener("dragover",e=>{e.preventDefault();e.dataTransfer.dropEffect="copy";e.currentTarget.classList.add("dragging")});
$("#keepsake-upload-box").addEventListener("dragleave",e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.classList.remove("dragging")});
$("#keepsake-upload-box").addEventListener("drop",e=>{e.preventDefault();e.currentTarget.classList.remove("dragging");const files=[...(e.dataTransfer?.files||[])].filter(item=>item.type.startsWith("image/"));if(!files.length)return $("#keepsake-segment-status").textContent="拖入的内容里没有可用图片。";if($("#keepsake-id").value)void setKeepsakeFile(files[0],"拖入图片");else void setKeepsakeBatchFiles(files,"拖入图片").catch(error=>$("#keepsake-segment-status").textContent=error.message)});
document.addEventListener("paste",e=>{if(!$("#view-keepsakes").classList.contains("active")||(e.target instanceof Element&&e.target.closest("input,textarea,[contenteditable=true]")))return;const files=[...(e.clipboardData?.files||[])].filter(item=>item.type.startsWith("image/"));if(!files.length)return;e.preventDefault();if($("#keepsake-id").value)void setKeepsakeFile(files[0],"剪贴板");else void setKeepsakeBatchFiles(files,"剪贴板").catch(error=>$("#keepsake-segment-status").textContent=error.message)});
$("#keepsake-auto-segment").addEventListener("click",segmentCurrentKeepsake);
$("#keepsake-understand").addEventListener("click",understandCurrentKeepsake);
$("#keepsake-tag-toggle").addEventListener("click",event=>{const expanded=event.currentTarget.getAttribute("aria-expanded")!=="true";event.currentTarget.setAttribute("aria-expanded",String(expanded));renderKeepsakeTagSuggestions();if(expanded)$("#keepsake-tags").focus()});
$("#keepsake-tags").addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===","){event.preventDefault();commitKeepsakeTagInput()}else if(event.key==="Backspace"&&!event.currentTarget.value&&keepsakeDraftTags.length){keepsakeDraftTags.pop();renderKeepsakeTagSuggestions();scheduleKeepsakeBatchPersist()}});
$("#keepsake-tags").addEventListener("input",()=>{renderKeepsakeTagSuggestions();if(activeKeepsakeBatchItem())scheduleKeepsakeBatchPersist()});
$("#keepsake-tags").addEventListener("blur",()=>{if($("#keepsake-tags").value.trim())commitKeepsakeTagInput()});
$("#keepsake-brush-keep").addEventListener("click",()=>{keepsakeEditor.mode="keep";$("#keepsake-brush-keep").classList.add("active");$("#keepsake-brush-erase").classList.remove("active");$("#keepsake-brush-keep").setAttribute("aria-pressed","true");$("#keepsake-brush-erase").setAttribute("aria-pressed","false")});
$("#keepsake-brush-erase").addEventListener("click",()=>{keepsakeEditor.mode="erase";$("#keepsake-brush-erase").classList.add("active");$("#keepsake-brush-keep").classList.remove("active");$("#keepsake-brush-erase").setAttribute("aria-pressed","true");$("#keepsake-brush-keep").setAttribute("aria-pressed","false")});
$("#keepsake-brush-size").addEventListener("input",e=>{$("#keepsake-brush-output").value=e.currentTarget.value;const cursor=$("#keepsake-canvas-cursor");cursor.style.width=cursor.style.height=`${e.currentTarget.value}px`});
$("#keepsake-edge-expansion").addEventListener("input",e=>{$("#keepsake-edge-output").value=e.currentTarget.value;if(keepsakeEditor.autoBase){applyKeepsakeExpansion();$("#keepsake-segment-status").textContent="已按当前场景边缘重新生成自动轮廓；之后仍可手动修正。"}});
$("#keepsake-background-opacity").addEventListener("input",event=>{$("#keepsake-background-output").value=`${event.currentTarget.value}%`;scheduleKeepsakeRender()});
$("#keepsake-reset-mask").addEventListener("click",()=>{if(!keepsakeEditor.maskCanvas)return;invalidateKeepsakeSegmentation();pushKeepsakeHistory();keepsakeEditor.maskCanvas.getContext("2d").clearRect(0,0,keepsakeEditor.maskCanvas.width,keepsakeEditor.maskCanvas.height);keepsakeEditor.autoBase=null;keepsakeEditor.source="manual";keepsakeEditor.mediaDirty=true;scheduleKeepsakeRender();const item=activeKeepsakeBatchItem();if(item){item.alphaMask="";item.status="editing";void persistKeepsakeBatch({capture:false});renderKeepsakeBatch()}$("#keepsake-segment-status").textContent="轮廓已清空，可用“保留”笔刷重新涂抹。"});
$("#keepsake-undo").addEventListener("click",()=>{const previous=keepsakeEditor.history.pop();if(!previous||!keepsakeEditor.maskCanvas)return;invalidateKeepsakeSegmentation();keepsakeEditor.maskCanvas.getContext("2d").putImageData(previous,0,0);keepsakeEditor.mediaDirty=true;$("#keepsake-undo").disabled=!keepsakeEditor.history.length;scheduleKeepsakeRender();if(activeKeepsakeBatchItem()){captureActiveKeepsakeBatchItem();void persistKeepsakeBatch();renderKeepsakeBatch()}});
const keepsakePaintCanvas=$("#keepsake-mask-canvas");
keepsakePaintCanvas.addEventListener("pointerdown",e=>{if(!keepsakeEditor.maskCanvas)return;e.preventDefault();invalidateKeepsakeSegmentation();keepsakePaintCanvas.setPointerCapture(e.pointerId);pushKeepsakeHistory();keepsakeEditor.drawing=true;keepsakeEditor.lastPoint=keepsakeCanvasPoint(e);paintKeepsakeStroke(keepsakeEditor.lastPoint,keepsakeEditor.lastPoint)});
keepsakePaintCanvas.addEventListener("pointermove",e=>{const rect=keepsakePaintCanvas.getBoundingClientRect(),cursor=$("#keepsake-canvas-cursor");cursor.hidden=false;cursor.style.left=`${e.clientX-rect.left}px`;cursor.style.top=`${e.clientY-rect.top}px`;if(!keepsakeEditor.drawing)return;const next=keepsakeCanvasPoint(e);paintKeepsakeStroke(keepsakeEditor.lastPoint,next);keepsakeEditor.lastPoint=next});
const endKeepsakeStroke=e=>{keepsakeEditor.drawing=false;keepsakeEditor.lastPoint=null;if(e.pointerId!=null&&keepsakePaintCanvas.hasPointerCapture(e.pointerId))keepsakePaintCanvas.releasePointerCapture(e.pointerId);if(activeKeepsakeBatchItem()){captureActiveKeepsakeBatchItem();void persistKeepsakeBatch();renderKeepsakeBatch()}};
keepsakePaintCanvas.addEventListener("pointerup",endKeepsakeStroke);keepsakePaintCanvas.addEventListener("pointercancel",endKeepsakeStroke);keepsakePaintCanvas.addEventListener("pointerleave",()=>{$("#keepsake-canvas-cursor").hidden=true});
for(const selector of["#keepsake-title","#keepsake-datetime","#keepsake-note","#keepsake-edge-expansion","#keepsake-background-opacity"])for(const eventName of["input","change"])$(selector).addEventListener(eventName,()=>{if(activeKeepsakeBatchItem())scheduleKeepsakeBatchPersist()});
$("#keepsake-edge-expansion").addEventListener("change",()=>{if(activeKeepsakeBatchItem()){captureActiveKeepsakeBatchItem();void persistKeepsakeBatch();renderKeepsakeBatch()}});
$("#keepsake-form").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget,button=$("#keepsake-save"),status=$("#keepsake-save-status"),id=$("#keepsake-id").value,batchItem=!id&&form.dataset.batchItemId?keepsakeBatch.items.find(item=>item.itemId===form.dataset.batchItemId):null;if(!keepsakeEditor.sourceCanvas||!keepsakeEditor.maskCanvas)return status.textContent="请先放入一张照片。";
  const alpha=maskImageDataFromCanvas(keepsakeEditor.maskCanvas).data;let hasSubject=false;for(let index=3;index<alpha.length;index+=4)if(alpha[index]>20){hasSubject=true;break}if(!hasSubject)return status.textContent="轮廓还是空的，请自动识别或用“保留”笔刷涂出主体。";
  button.disabled=true;status.textContent="正在生成压缩图…";
  try{
    const mediaChanged=!id||Boolean(batchItem)||keepsakeEditor.mediaDirty||Boolean(keepsakeEditor.file),alphaMask=mediaChanged?keepsakeEditor.maskCanvas.toDataURL("image/png"):"";
    const basePayload={...occurrenceFields($("#keepsake-datetime")),title:$("#keepsake-title").value,note:$("#keepsake-note").value,tags:keepsakeTagsFromInput(),source:keepsakeEditor.source,edgeExpansion:Number($("#keepsake-edge-expansion").value),backgroundOpacityPct:Number($("#keepsake-background-opacity").value)};
    if(batchItem){
      captureActiveKeepsakeBatchItem();batchItem.status="uploading";batchItem.lastError=null;batchItem.uploadRequestId||=crypto.randomUUID();renderKeepsakeBatch();await persistKeepsakeBatch();
      if(!batchItem.mediaPaths)batchItem.mediaPaths=await uploadKeepsakeMedia({request,image:keepsakeEditor.sourceDataUrl,alphaMask,idempotencyKey:batchItem.uploadRequestId});
      batchItem.status="saving";batchItem.createRequestId||=crypto.randomUUID();await persistKeepsakeBatch();renderKeepsakeBatch();
      const{attachmentPaths,...mediaPaths}=batchItem.mediaPaths;
      await request("/api/keepsakes",{method:"POST",headers:{"idempotency-key":batchItem.createRequestId},body:JSON.stringify({...basePayload,...mediaPaths,cutoutPath:""})});
      const index=keepsakeBatch.items.findIndex(item=>item.itemId===batchItem.itemId);if(index>=0)await removeKeepsakeBatchItem(index,{discard:false});
      if(!keepsakeBatch.items.length){$("#keepsake-workspace").hidden=true;window.scrollTo({top:0,behavior:"auto"})}
      await refreshState(["keepsakes","review"]);showToast(keepsakeBatch.items.length?"本件小物已保存，请继续处理下一件":"小物批次已保存完成");return
    }
    const payload={...basePayload,...(mediaChanged?{alphaMask,...(!id||keepsakeEditor.file?{image:keepsakeEditor.sourceDataUrl}: {})}:{})};
    const requestId=form.dataset.requestId||crypto.randomUUID();form.dataset.requestId=requestId;
    await request(id?`/api/keepsakes/${id}`:"/api/keepsakes",{method:id?"PATCH":"POST",headers:id?{}:{"idempotency-key":requestId},body:JSON.stringify(payload)});resetKeepsakeEditor({close:true});await refreshState(["keepsakes","review"]);window.scrollTo({top:0,behavior:"auto"});showToast(id?"小物留存已更新":"小物已数字留存");
  }catch(error){
    if(batchItem){batchItem.status="failed";batchItem.lastError={message:error.message};if(!uncertainMediaSubmission(error)&&batchItem.mediaPaths){await discardKeepsakeMedia({request,attachmentPaths:batchItem.mediaPaths.attachmentPaths,uploadRequestId:batchItem.uploadRequestId}).catch(()=>{});batchItem.mediaPaths=null;batchItem.uploadRequestId="";batchItem.createRequestId=""}await persistKeepsakeBatch();renderKeepsakeBatch()}
    status.textContent=error.message
  }finally{button.disabled=false}
});
document.addEventListener("click",async e=>{
  const tagSuggestion=e.target.closest("[data-keepsake-tag-suggestion]"),tagRemove=e.target.closest("[data-keepsake-tag-remove]"),back=e.target.closest("[data-keepsake-back]"),view=e.target.closest("[data-keepsake-view]"),derive=e.target.closest("[data-keepsake-derive]"),edit=e.target.closest("[data-keepsake-edit]"),remove=e.target.closest("[data-keepsake-delete]"),open=e.target.closest("[data-keepsake-open]");
  if(tagSuggestion){keepsakeDraftTags=uniqueKeepsakeTags([...keepsakeDraftTags,tagSuggestion.dataset.keepsakeTagSuggestion]);$("#keepsake-tags").value="";renderKeepsakeTagSuggestions();scheduleKeepsakeBatchPersist();$("#keepsake-tags").focus();return}
  if(tagRemove){keepsakeDraftTags=keepsakeDraftTags.filter(tag=>tag!==tagRemove.dataset.keepsakeTagRemove);renderKeepsakeTagSuggestions();scheduleKeepsakeBatchPersist();return}
  if(back){activeKeepsakeId="";activeKeepsakeView="presentation";activeKeepsakeOriginalPath="";renderKeepsakes();window.scrollTo({top:0,behavior:"smooth"});return}
  if(view){view.disabled=true;try{await setKeepsakeDetailView(view.dataset.keepsakeView)}catch(error){showToast(error.message,"error")}finally{view.disabled=false}return}
  if(derive){derive.disabled=true;try{await request(`/api/keepsakes/${encodeURIComponent(derive.dataset.keepsakeDerive)}/derive`,{method:"POST",body:"{}"});await refreshState("keepsakes");showToast("正在重新生成清晰图")}catch(error){showToast(error.message,"error");derive.disabled=false}return}
  if(edit){edit.disabled=true;try{await editKeepsake(edit.dataset.keepsakeEdit)}finally{if(edit.isConnected)edit.disabled=false}return}
  if(remove){if(!confirm("将这件小物移入回收站？原图与轮廓会保留 30 天。"))return;remove.disabled=true;try{await request(`/api/keepsakes/${remove.dataset.keepsakeDelete}`,{method:"DELETE"});await refreshState(["keepsakes","review"]);showToast("小物已移入回收站")}catch(error){showToast(error.message,"error");remove.disabled=false}return}
  if(open)openKeepsakeDetail(open.dataset.keepsakeOpen);
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
$("#quote-refresh").addEventListener("click",()=>renderQuoteSky(true));
$("#quote-cancel").addEventListener("click",resetQuoteForm);
$("#quote-form").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget,id=$("#quote-id").value,existing=id?(state.quotes||[]).find(item=>item.id===id):null,button=$("#quote-submit"),status=$("#quote-status"),payload={...occurrenceFields($("#quote-datetime")),source:$("#quote-source").value,content:$("#quote-content").value,tags:quoteTagsForSubmission("quote")},requestId=form.dataset.requestId||crypto.randomUUID(),temporaryId=`pending:${requestId}`;if(!id)form.dataset.requestId=requestId;button.disabled=true;status.textContent=id?"正在保存修改…":"正在收藏…";
  try{
    if(id){const result=await requestV1(`/api/v1/quotes/${encodeURIComponent(id)}`,{method:"PATCH",headers:{"if-match":`"${existing?.version||1}"`},body:JSON.stringify(payload)},{domains:["quotes"],recoverCommitted:true,projection:{kind:"record.update",domain:"quotes",id,payload},onQueued:record=>applyPendingProjection(record)});if(result.data)state.quotes=(state.quotes||[]).map(item=>item.id===id?result.data:item);renderQuotes()}
    else{
      const result=await requestV1("/api/v1/quotes",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{domains:["quotes"],projection:{kind:"record.create",domain:"quotes",temporaryId,payload},onQueued:record=>applyPendingProjection(record)});
      state.quotes=(state.quotes||[]).map(item=>item.id===temporaryId?result.data:item);renderQuotes()
    }
    delete form.dataset.requestId;resetQuoteForm();void refreshState("quotes").catch(error=>showToast(`善言已保存，但列表刷新失败：${error.message}`,"error"));showToast(id?"善言已更新":"善言已收藏")
  }catch(err){if(err.syncStatus==="pending"){resetQuoteForm();status.textContent="已收藏，网络恢复后自动同步。";showToast(id?"善言修改将在网络恢复后同步":"善言已进入待同步队列")}else{if(id)await refreshState("quotes").catch(()=>{});status.textContent=err.message}}finally{button.disabled=false}
});
document.addEventListener("click",async e=>{const edit=e.target.closest("[data-quote-edit]"),remove=e.target.closest("[data-quote-delete]");if(edit)return editQuote(edit.dataset.quoteEdit);if(!remove)return;const id=remove.dataset.quoteDelete,item=(state.quotes||[]).find(value=>value.id===id);if(!item||!confirm("将这条善言及其批注移入回收站？"))return;remove.disabled=true;try{await requestV1(`/api/v1/quotes/${encodeURIComponent(id)}`,{method:"DELETE",headers:{"if-match":`"${item.version||1}"`}},{domains:["quotes"],recoverCommitted:true,projection:{kind:"record.delete",domain:"quotes",id},onQueued:record=>applyPendingProjection(record)});if($("#quote-id").value===id)resetQuoteForm();void refreshState("quotes").catch(error=>showToast(`善言已移除，但列表刷新失败：${error.message}`,"error"));showToast("善言已移入回收站")}catch(err){if(err.syncStatus==="pending")showToast("善言将在网络恢复后移入回收站");else{await refreshState("quotes").catch(()=>{});showToast(err.message,"error");remove.disabled=false}}});
$("#selection-quote-close").addEventListener("click",closeSelectionQuoteModal);
$("#selection-quote-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)closeSelectionQuoteModal()});
$("#selection-quote-form").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#selection-quote-status"),payload={...occurrenceFields($("#selection-quote-datetime")),source:$("#selection-quote-source").value,content:$("#selection-quote-content").value,tags:quoteTagsForSubmission("selectionQuote")},requestId=form.dataset.requestId||crypto.randomUUID(),temporaryId=`pending:${requestId}`;form.dataset.requestId=requestId;button.disabled=true;status.textContent="正在收藏…";
  try{
    const result=await requestV1("/api/v1/quotes",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{domains:["quotes"],projection:{kind:"record.create",domain:"quotes",temporaryId,payload},onQueued:record=>applyPendingProjection(record)});
    state.quotes=(state.quotes||[]).map(item=>item.id===temporaryId?result.data:item);delete form.dataset.requestId;closeSelectionQuoteModal();void refreshState("quotes").catch(error=>showToast(`善言已保存，但列表刷新失败：${error.message}`,"error"));showToast("选中文字已收为善言")
  }catch(err){if(err.syncStatus==="pending"){closeSelectionQuoteModal();showToast("善言已进入待同步队列")}else status.textContent=err.message}finally{button.disabled=false}
});
setStatisticsRange(7);
$$("[data-statistics-days]").forEach(button=>button.addEventListener("click",()=>{setStatisticsRange(Number(button.dataset.statisticsDays));void loadStatistics()}));
$("#statistics-range-form").addEventListener("submit",event=>{event.preventDefault();$$("[data-statistics-days]").forEach(button=>button.classList.remove("active"));void loadStatistics()});
$("#view-architecture")?.addEventListener("click",event=>{
  const stageButton=event.target.closest("[data-architecture-stage]"),termButton=event.target.closest("[data-architecture-term]");
  if(stageButton){architectureStage=Math.max(0,Math.min((architectureSurface?.stages?.length||1)-1,Number(stageButton.dataset.architectureStage)||0));renderArchitecture();return}
  if(termButton){architectureTerm=termButton.dataset.architectureTerm;renderArchitectureTerm()}
});
$("#ai-budget-add-form").addEventListener("submit",async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#ai-budget-status"),amountCny=Number($("#ai-budget-add-amount").value),reason=$("#ai-budget-add-reason").value.trim();button.disabled=true;status.textContent="正在追加临时额度…";
  try{await submitAiBudgetCommand({command:"addTemporaryBudget",scope:$("#ai-budget-add-scope").value,amountCny,reason});form.reset();status.textContent="临时额度已追加。";showToast("全站预算已更新")}
  catch(error){status.textContent=error.message}
  finally{button.disabled=false}
});
$("#ai-budget-recover-form").addEventListener("submit",async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#ai-budget-status"),reason=$("#ai-budget-recover-reason").value.trim();button.disabled=true;status.textContent="正在解除阻断…";
  try{await submitAiBudgetCommand({command:"recover",scope:$("#ai-budget-recover-scope").value,reason});form.reset();status.textContent="当前周期阻断已解除。";showToast("预算阻断已解除")}
  catch(error){status.textContent=error.message}
  finally{button.disabled=false}
});
$("#ai-cost-form").addEventListener("input",()=>{
  if(!aiCostPlan||!aiCostStatistics)return;
  aiCostPlan=aiCostPlanFromForm();
  renderAiCostPlan(false);
});
$("#ai-cost-calibrate").addEventListener("click",()=>{
  if(!aiCostPlan||!aiCostStatistics)return;
  const observed=new Map((aiCostStatistics.ai?.scenes||[]).map(item=>[item.scene,item]));
  aiCostPlan=aiCostPlanFromForm();
  aiCostPlan.scenarios=aiCostPlan.scenarios.map(row=>{
    const sample=observed.get(row.scene),calls=Number(sample?.calls)||0,current=currentAiCostModel(row.scene);
    if(!calls)return{...row,enabled:false,model:current.model,callsPerMonth:0};
    const input=Number(sample.tokens?.input)||0;
    return{...row,enabled:true,model:current.model,callsPerMonth:calls,avgInputTokens:Math.round(input/calls),cacheHitPct:input?Math.round((Number(sample.tokens?.cacheHit)||0)/input*1000)/10:0,avgReasoningTokens:Math.round((Number(sample.tokens?.reasoning)||0)/calls),avgAnswerTokens:Math.round((Number(sample.tokens?.answer)||0)/calls)};
  });
  renderAiCostPlan(true);
  $("#ai-cost-status").textContent="已按近 30 天实测调用与当前模型配置校准，保存后生效。";
});
$("#ai-cost-form").addEventListener("submit",async event=>{
  event.preventDefault();
  if(!aiCostPlan)return;
  const button=event.currentTarget.querySelector('[type="submit"]'),status=$("#ai-cost-status");button.disabled=true;status.textContent="正在保存成本方案…";
  try{aiCostPlan=await request("/api/ai-cost-plan",{method:"PATCH",body:JSON.stringify(aiCostPlanFromForm())});renderAiCostPlan(true);status.textContent="AI 成本方案已保存。";showToast("AI 成本方案已更新")}
  catch(error){status.textContent=error.message}
  finally{button.disabled=false}
});
$("#view-commercialization").addEventListener("click",event=>{
  const button=event.target.closest("[data-commercial-mode]");if(!button||!commercializationSurface)return;
  const assumptions=commercialAssumptionsFromForm();commercialMode=button.dataset.commercialMode;void previewCommercialization(assumptions)
});
$("#view-commercialization").addEventListener("input",event=>{
  if(!commercializationSurface)return;
  if(event.target.matches("#commercial-stage-slider")){
    const assumptions=commercialAssumptionsFromForm(),presets=assumptions?.stagePresets?.[commercialMode]||[],index=Math.max(0,Math.min(presets.length-1,Number(event.target.value)||0));
    assumptions.stageByModel[commercialMode]=index;assumptions[commercialMode]=structuredClone(presets[index]);void previewCommercialization(assumptions,{statusMessage:"阶段参数已切换，保存后跟随账户。"});return
  }
  if(event.target.matches("[data-commercial-field],[data-commercial-profile-field]"))scheduleCommercializationPreview()
});
$("#view-commercialization").addEventListener("submit",async event=>{
  if(event.target.id!=="commercial-assumptions-form")return;
  event.preventDefault();clearTimeout(commercialPreviewTimer);const button=event.target.querySelector('[type="submit"]'),status=$("#commercial-save-status"),assumptions=commercialAssumptionsFromForm();button.disabled=true;status.textContent="正在保存估算…";
  try{
    const report=await request("/api/commercialization",{method:"PATCH",body:JSON.stringify({assumptions})});
    commercializationSurface={...commercializationSurface,report:{...report,legacyV2:Boolean(report.legacyV2)}};await previewCommercialization(report.assumptions,{statusMessage:"估算参数已保存。"});showToast("商业化估算已更新")
  }catch(error){status.textContent=error.message}
  finally{button.disabled=false}
});
document.addEventListener("click",event=>{const button=event.target.closest("[data-commercial-source-view]");if(button)openCommercialSource(button.dataset.commercialSourceView,button.dataset.commercialSourceId,button.dataset.commercialSourceDate)});
$$("[data-local-test-mode]").forEach(button=>button.addEventListener("click",async()=>{
  const mode=button.dataset.localTestMode,label=mode==="simulation"?"使用模拟":"冷启测试",message=mode==="simulation"?"切换到使用模拟？记录会在打开对应页面时只读加载，线上不会收到任何业务写入。":"清空冷启测试账户并重新开始？";
  if(!confirm(message))return;
  rotateSession();resetOwnerSurfaces();invalidatePageLoads();
  const expectedSession=sessionSerial,expectedOwner=currentUser?.id,controls=$$("[data-local-test-mode]"),status=$("#local-test-status");controls.forEach(control=>control.disabled=true);localTestStatusOverride=mode==="simulation"?"正在切换到使用模拟…":"正在创建空账户…";status.textContent=localTestStatusOverride;
  try{
    const nextConfig=await request("/api/local-test-mode",{method:"POST",body:JSON.stringify({mode})});
    if(expectedSession!==sessionSerial||expectedOwner!==currentUser?.id||nextConfig?.mode!==mode)throw Object.assign(new Error("已忽略不属于当前账户或模式的响应"),{code:"LOCAL_TEST_RESPONSE_MISMATCH"});localTestConfig=nextConfig;localTestScopeLoads.clear();await load();
    switchView(mode==="cold"?"today":"settings");localTestStatusOverride=mode==="simulation"?"已切换；打开页面时读取对应记录。":"已切换到冷启测试。";renderLocalTestSettings();showToast(`已切换到${label}`)
  }
  catch(error){const timeout=["AbortError","TimeoutError"].includes(error?.name)||/aborted due to timeout|timed out/i.test(error?.message||"");localTestStatusOverride=timeout?"线上数据读取超时，请检查网络后重试。":error.message;renderLocalTestSettings()}
  finally{if(localTestConfig?.upstreamConfigured||mode!=="simulation")controls.forEach(control=>control.disabled=false);renderLocalTestSettings()}
}));
$$("[data-onboarding-mode]").forEach(button=>button.addEventListener("click",()=>{collectOnboardingAnswers();onboardingMode=button.dataset.onboardingMode==="detailed"?"detailed":"quick";$("#onboarding-understanding").closest("label").hidden=true;$("#onboarding-status").textContent=onboardingMode==="detailed"?"详细版共 18 题，全部作答后才能完成。":"快速版共 8 题，全部作答后才能完成。";renderOnboardingQuestions()}));
$$("[data-onboarding-sample]").forEach(button=>button.addEventListener("click",()=>{$("#onboarding-material").value=button.dataset.onboardingSample;$("#onboarding-understanding").closest("label").hidden=true}));
$("#onboarding-file").addEventListener("change",async event=>{const file=event.currentTarget.files?.[0];if(!file)return;if(file.size>1024*1024){$("#onboarding-status").textContent="导入文件不能超过 1 MB。";event.currentTarget.value="";return}try{$("#onboarding-material").value=await file.text();$("#onboarding-status").textContent=`已读取 ${file.name}，确认前仍可修改。`}catch{$("#onboarding-status").textContent="文件读取失败，请重试。"}});
$("#onboarding-preview").addEventListener("click",async()=>{const form=$("#onboarding-form"),status=$("#onboarding-status");if(!form.reportValidity()){status.textContent="请先完成当前版本的全部题目。";return}status.textContent="正在整理初始认知…";try{const result=await request("/api/onboarding/preview",{method:"POST",body:JSON.stringify(onboardingPayload())}),understanding=$("#onboarding-understanding");understanding.value=result.understanding;understanding.closest("label").hidden=false;understanding.focus();status.textContent="这是可修改的初步理解，后续真实记录优先。"}catch(error){status.textContent=error.message}});
$("#onboarding-skip").addEventListener("click",()=>{for(const key of["gender","region","occupation","major","school","introduction","works"]){const field=$(`#onboarding-${key}`);if(field)field.value=""}$$('#onboarding-interests input[type="checkbox"]').forEach(input=>input.checked=false);$("#onboarding-material").value="";$("#onboarding-file").value="";$("#onboarding-understanding").value="";$("#onboarding-understanding").closest("label").hidden=true;$("#onboarding-optional").open=false;$("#onboarding-status").textContent="已略过可选资料；完成全部题目后即可开始。"});
$("#onboarding-legacy-back").addEventListener("click",()=>onboardingV2Controller.backFromLegacy());
$("#onboarding-form").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#onboarding-status");if(!form.reportValidity()){status.textContent="请完成当前版本的全部题目。";return}button.disabled=true;try{state.onboarding=await request("/api/onboarding",{method:"PATCH",body:JSON.stringify(onboardingPayload())});await load();showToast("旧版问卷已保存，原始选择继续保留")}catch(error){status.textContent=error.message}finally{button.disabled=false}});
$("#onboarding-v2-reopen").addEventListener("click",()=>{switchView("today");requestAnimationFrame(()=>onboardingV2Controller.reopen())});
$("#reset-response-styles").addEventListener("click",()=>{$("#assistant-name").value="神鸡";$$("[data-response-style]").forEach(select=>select.value="standard");$("#llm-settings-status").textContent="已恢复默认称呼与风格，保存后生效。"});
$("#tts-default-voice").addEventListener("change",()=>stopVoicePreview({clearStatus:true}));
$("#tts-voice-preview").addEventListener("click",()=>void toggleTtsVoicePreview());
$("#tts-generation-rate").addEventListener("input",event=>renderTtsGenerationRate(event.currentTarget.value));
$("#llm-settings-form").addEventListener("submit",async e=>{e.preventDefault();stopVoicePreview({clearStatus:true});const ownerSettings=hasCapability("ai-configuration"),button=e.currentTarget.querySelector('[type="submit"]'),status=$("#llm-settings-status");button.disabled=true;status.textContent="正在保存…";try{llmSettings=await request(ownerSettings?"/api/settings":"/api/preferences",{method:ownerSettings?"POST":"PATCH",body:JSON.stringify(settingsPayload())});const key=$("#llm-api-key");if(key)key.value="";renderSettings();status.textContent=ownerSettings?"模型、场景与语音设置已保存。":"思考、回答与语音偏好已保存。";showToast("设置已保存")}catch(err){status.textContent=err.message}finally{button.disabled=false}});
$("#test-llm").addEventListener("click",async e=>{stopVoicePreview({clearStatus:true});const button=e.currentTarget,status=$("#llm-settings-status"),tier=$("#llm-test-tier").value;button.disabled=true;status.textContent=`正在保存并测试 ${tier[0].toUpperCase()+tier.slice(1)}…`;try{llmSettings=await request("/api/settings",{method:"POST",body:JSON.stringify(settingsPayload())});$("#llm-api-key").value="";renderSettings();const result=await request("/api/settings/test",{method:"POST",body:JSON.stringify({tier})}),profile=llmSettings.profiles[tier];status.textContent=`连接成功 · ${profile.model==="deepseek-v4-pro"?"DeepSeek Pro":"DeepSeek Flash"} · ${profile.effort==="none"?"思考关闭":`思考 ${profile.effort.toUpperCase()}`}`;showToast(result.reply||"DeepSeek 连接成功")}catch(err){status.textContent=`连接失败：${err.message}`}finally{button.disabled=false}});
function syncLocalDate(){const next=localDateKey();if(next===currentLocalDate)return;const followedToday=activeDate===currentLocalDate;currentLocalDate=next;if(followedToday){activeDate=next;renderDate();renderSliders();publishDomains(new Set(["thoughts"]));renderStateChart();renderHomeMood();renderChat()}}
function markApplicationForeground(){apiClient.markForeground();syncLocalDate();restoreView?.()}
setInterval(syncLocalDate,30000);
document.addEventListener("visibilitychange",()=>{if(document.hidden){saveDurableDrafts();stopCaptureAudioRecording();stopPageAudio()}else markApplicationForeground()});
window.addEventListener("pagehide",()=>{saveDurableDrafts();stopCaptureAudioRecording();stopPageAudio()});
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
$("#username-form").addEventListener("submit",async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#username-status");button.disabled=true;status.textContent="正在修改…";
  try{const result=await authRequest("/api/auth/username",{username:form.elements.username.value},"PATCH");currentUser=result.user;renderAccountIdentity();status.textContent="用户名已更新。";showToast("用户名已更新")}
  catch(error){status.textContent=error.message}
  finally{button.disabled=false}
});
$("#password-form").addEventListener("submit",async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#password-status"),currentPassword=form.elements.currentPassword.value,newPassword=form.elements.newPassword.value,confirmPassword=form.elements.confirmPassword.value;
  form.elements.confirmPassword.setCustomValidity(newPassword===confirmPassword?"":"两次输入的新密码不一致");
  if(!form.reportValidity())return;
  button.disabled=true;status.textContent="正在修改…";
  try{await authRequest("/api/auth/password",{currentPassword,newPassword},"PATCH");form.reset();status.textContent="密码已更新，其他设备上的登录已退出。";showToast("密码已更新")}
  catch(error){status.textContent=error.message}
  finally{button.disabled=false}
});
$("#password-form [name='confirmPassword']").addEventListener("input",event=>event.currentTarget.setCustomValidity(""));
$("#account-role-list").addEventListener("click",async event=>{
  const button=event.target.closest("[data-account-role-save]");if(!button)return;
  const userId=button.dataset.accountRoleSave,user=accountUsers.find(item=>item.id===userId),select=$(`[data-account-role="${CSS.escape(userId)}"]`),role=select?.value,status=$("#account-role-status");
  if(!user||!["user","owner"].includes(role)||role===user.role)return;
  if(user.role==="owner"&&role==="user"&&!confirm(`撤销 ${user.username} 的 Owner 权限？该账户需要重新登录。`)){select.value=user.role;return}
  button.disabled=true;status.textContent="正在更新角色…";
  try{
    const result=await authRequest(`/api/auth/users/${encodeURIComponent(userId)}/role`,{role},"PATCH");
    if(userId===currentUser?.id){showAuthGate("账户权限已变更，请重新登录。");return}
    accountUsers=accountUsers.map(item=>item.id===userId?result.user:item);renderAccountUsers();status.textContent="角色已更新；该账户需要重新登录。"
  }catch(error){select.value=user.role;status.textContent=error.message}
  finally{if(button.isConnected)button.disabled=false}
});
$("#logout-button").addEventListener("click",logout);$("#logout-button-account").addEventListener("click",logout);
export async function startApplication(initial = null, { opening = null } = {}) {
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
