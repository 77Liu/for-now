import { sessionSerial } from "../../session/index.mjs";
import { publishDomains, replaceState, state } from "../../state/index.mjs";

export function createCollaborationRuntime({
  runtime,$,$$,ownerSurfaceVault,escapeHtml,plainPreview,renderMarkdown,
  createLatexRenderer,appUrl,dailyTypeMeta,renderDate,renderSliders,
  renderStateChart,renderHomeMood,renderChat,openThoughtDetail,
  switchView,loadAnnotationsFeatureModule,request,refreshState,
  scheduleNotificationPoll,openSelectionQuoteModal,resetContentImageEditor,
  persistContentImageDraft,contentImagePaths,imageRecordPayload,
  clearSubmittedContentImageDraft,discardContentImageUploads,
  uncertainMediaSubmission,contentImagesMarkup,formatDate,showToast,
  empty,thoughtsFeatureControllers,loadBackgroundResultsFeatureModule,
  backgroundResultsRetryLimit
} = {}) {
function hasCapability(capability){return runtime.currentCapabilities.has(capability)}
function applyCapabilitySurface(capabilities=[]){
  runtime.currentCapabilities=new Set(Array.isArray(capabilities)?capabilities:[]);
  if(!runtime.ownerSurfaceEntries){
    runtime.ownerSurfaceEntries=$$("[data-owner-capability]").map((node,index)=>{
      const marker=document.createComment(`owner-capability-${index}`);
      node.parentNode.insertBefore(marker,node);
      return{node,marker,capability:node.dataset.ownerCapability}
    })
  }
  for(const entry of runtime.ownerSurfaceEntries){
    if(hasCapability(entry.capability)){
      if(!entry.node.isConnected&&entry.marker.parentNode)entry.marker.parentNode.insertBefore(entry.node,entry.marker.nextSibling)
    }else if(entry.node.isConnected)ownerSurfaceVault.append(entry.node)
  }
}
function showPermissionPage(view,capability){
  runtime.deniedAccess={view,capability};
  if(!runtime.currentUser)runtime.requestedAuthenticatedView=view;
  const names={"ai-cost":"AI 成本",architecture:"架构设计",commercialization:"商业化"};
  const title=$("#permission-title"),copy=$("#permission-copy");
  if(title)title.textContent=`${names[view]||"此页面"}仅 Owner 可访问`;
  if(copy)copy.textContent=`当前账户没有访问此管理页面的权限（${capability}）。敏感内容未加载，你仍可继续使用个人记录与偏好设置。`
}
const createLatexAsset=(tagName,properties,kind)=>new Promise((resolve,reject)=>{
  const element=document.createElement(tagName);
  Object.assign(element,properties);
  element.dataset.latexAsset=kind;
  element.onload=resolve;
  element.onerror=()=>{
    document.querySelectorAll("[data-latex-asset]").forEach(asset=>asset.remove());
    reject(new Error(`LATEX_ASSET_LOAD_FAILED:${kind}`))
  };
  document.head.append(element)
});
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
  const collections={capture:"captures",journal:"journals",thought:"thoughts",checkin:"checkins",dailyRecord:"dailyRecords",modelUnknown:"modelUnknowns"};
  const item=state[collections[type]]?.find(value=>value.id===id);
  if(!item)return{exists:false,text:""};
  const base={exists:true,version:Number(item.version)||1,occurredAt:item.occurredAt||item.createdAt||item.updatedAt||""};
  if(type==="capture")return{...base,text:item.content||"图片或语音捕念"};
  if(type==="journal")return{...base,text:`${item.title?`${item.title}：`:""}${item.content||""}`};
  if(type==="thought")return{...base,text:item.content||item.modelDraft||""};
  if(type==="checkin")return{...base,text:`情绪 ${item.mood} · 精力 ${item.energy} · 压力 ${item.stress} · 睡眠 ${item.sleep}`};
  if(type==="modelUnknown")return{...base,text:item.question||item.text||"待澄清的问题"};
  return{...base,text:item.description||item.exerciseType||`${item.type||"健康"}记录`}
}
function contextSourceButton(source){
  const location=source?.location||{};
  const live=source.excerpt
    ?{exists:true,matches:true,text:source.excerpt}
    :currentContextSource(source);
  const matches=Boolean(source.excerpt)
    ||live.exists
      &&live.version===Number(source.version||1)
      &&(source.resourceType!=="onboarding"||!source.occurredAt||live.occurredAt===source.occurredAt);
  const canOpen=live.exists&&location.view&&location.view!=="personal-context";
  const copy=!live.exists
    ?"来源已删除或当前不可用"
    :matches
      ?live.text
      :"来源当前版本已变化；旧摘录未保留";
  return `<article class="context-source-item${live.exists&&matches?"":" unavailable"}"><div><b>${escapeHtml(source.recordType||"记录")}</b><small>${escapeHtml(source.occurredOn||"时间未记")} · 版本 ${Number(source.version)||1}</small></div><p>${escapeHtml(plainPreview(copy))}</p>${canOpen?`<button class="subtle-action" type="button" data-context-source data-context-view="${escapeHtml(location.view)}" data-context-target="${escapeHtml(location.targetId||source.resourceId||"")}" data-context-root="${escapeHtml(location.rootId||"")}" data-context-key="${escapeHtml(location.targetKey||"")}" data-context-date="${escapeHtml(location.occurredOn||source.occurredOn||"")}" data-context-daily-type="${escapeHtml(location.dailyType||"")}">查看${matches?"原记录":"当前版本"}</button>`:""}</article>`
}
function contextReceiptMarkup(receipt, citations = [], citationStatus = "") {
  const sources = Array.isArray(receipt?.sources) ? receipt.sources : [];
  const budget = receipt?.tokenBudget;
  const verified = Array.isArray(citations) ? citations : [];
  const citationMarkup = citationStatus === "matched"
    ? `<details class="matched-citations"><summary>已匹配原文引用（${verified.length}）</summary><p>引用片段与本次提供的原文逐字匹配；请结合原文上下文判断它是否支持回答。</p><ol>${verified.map(item => (
      `<li><q>${escapeHtml(item.exactQuote || "")}</q><small>${escapeHtml(item.recordType || "原文")} · 版本 ${Number(item.version) || 1}</small></li>`
    )).join("")}</ol></details>`
    : citationStatus === "none"
      ? "<p class=\"citation-empty-note\">本次回答没有能与原文逐字匹配的引用。</p>"
      : "";
  if (!sources.length) return citationMarkup;
  const budgetText = budget
    ? `${Number(budget.estimatedUsed) || 0} / ${Number(budget.limit) || 0} UTF-8 字节上界`
    : "";
  return `${citationMarkup}<details class="context-audit"><summary><span>本次参考</span><small>${sources.length} 条编排选入${budgetText ? ` · ${budgetText}` : ""}</small></summary><p class="context-audit-note">这些材料在回答前被选入，不代表回答逐条引用。</p><div class="context-source-list">${sources.map(contextSourceButton).join("")}</div></details>`;
}
function openContextReceiptSource(button){
  const view=button.dataset.contextView,target=button.dataset.contextTarget,root=button.dataset.contextRoot,date=button.dataset.contextDate,dailyType=button.dataset.contextDailyType;
  if(date){
    runtime.activeDate=date;
    if(dailyType&&dailyTypeMeta[dailyType])runtime.activeDailyType=dailyType;
    renderDate();
    renderSliders();
    publishDomains(new Set(["thoughts","activeDate"]));
    renderStateChart();
    renderHomeMood();
    renderChat()
  }
  if(view==="thoughts")openThoughtDetail(root||target);else switchView(view);
  requestAnimationFrame(()=>{
    const selectors={
      thoughts:`[data-chain-id="${CSS.escape(root||target)}"]`,
      captures:`[data-capture-id="${CSS.escape(target)}"]`,
      journals:`[data-journal-id="${CSS.escape(target)}"]`,
      together:`[data-chat-id="${CSS.escape(target)}"]`,
      daily:`[data-daily-record-id="${CSS.escape(target)}"]`,
      today:`[data-checkin-id="${CSS.escape(target)}"]`
    };
    const element=document.querySelector(selectors[view]||"");
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
function clearThoughtTracePending(rootKey){
  const {type,id}=parseCommentRootKey(rootKey);
  if(type!=="thought"||!id)return;

  state.insights.aiOnlyThoughtIds=(state.insights.aiOnlyThoughtIds||[])
    .filter(value=>value!==id);
  document.querySelectorAll(`[data-chain-id="${CSS.escape(id)}"]`).forEach(card=>{
    card.closest(".thought-timeline-entry")?.querySelector(".thought-trace-pending")?.remove()
  })
}
function createRuntimeAnnotationsController(module){return module.createAnnotationsFeatureController({
  data:{
    getSnapshot:()=>state,
    getAccountId:()=>runtime.currentUser?.id||"",
    request,
    refreshNotifications:()=>refreshState("notifications"),
    scheduleNotificationPoll,
    clearThoughtTracePending,
    openSelectionQuote:openSelectionQuoteModal
  },
  media:{
    resetDraft:()=>resetContentImageEditor("comment"),
    startDraft:selection=>{void runtime.contentImageDraftManager.persist("comment",{selection,text:"",requestId:"",assistantClientRequestId:""})},
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
  if(runtime.annotationsController)return runtime.annotationsController;
  const module=await loadAnnotationsFeatureModule();
  if(!runtime.annotationsController){
    runtime.annotationRootKey=module.annotationRootKey;runtime.parseAnnotationRootKey=module.parseAnnotationRootKey;
    runtime.annotationsController=createRuntimeAnnotationsController(module)
  }
  return runtime.annotationsController
}
const commentRootKey=(type,id)=>runtime.annotationRootKey?runtime.annotationRootKey(type,id):`${type}:${id}`;
const parseCommentRootKey=value=>{
  if(runtime.parseAnnotationRootKey)return runtime.parseAnnotationRootKey(value);
  const divider=String(value||"").indexOf(":");
  if(divider<1)return{type:"",id:""};
  return{type:value.slice(0,divider),id:value.slice(divider+1)}
};
const commentRoot=value=>runtime.annotationsController?.getRoot(value)||null;
const commentRootLabel=value=>runtime.annotationsController?.rootLabel(value)||"正文";
const markCommentTarget=(...args)=>runtime.annotationsController?.markTarget(...args);
const tagCommentableTargets=(...args)=>runtime.annotationsController?.tagThoughtTargets(...args);
const applyCommentAnchors=(...args)=>runtime.annotationsController?.applyAnchors(...args);
const scheduleAnnotationLineCounts=()=>runtime.annotationsController?.scheduleLayout();
const restoreAnnotationUiDrafts=()=>runtime.annotationsController?.restoreDrafts();
const renderCommentPanel=(...args)=>runtime.annotationsController?.renderPanel(...args);
const openCommentPanel=(...args)=>runtime.annotationsController?.openPanel(...args);
function patchActiveThoughtTarget(target){
  for(const controller of thoughtsFeatureControllers){
    if(controller.patchTarget(target))return true
  }
  return false
}
function reconcileActiveThoughtRoute(){
  let reconciled=false;
  for(const controller of thoughtsFeatureControllers){
    controller.render?.({snapshot:state,changedDomains:["thoughts"]});
    if(controller.reconcileRoute())reconciled=true
  }
  return reconciled
}
function createRuntimeBackgroundResultsController(module){return module.createBackgroundResultsFeatureController({
  data:{getSnapshot:()=>state,getAccountId:()=>runtime.currentUser?.id||"",replaceSnapshot:replaceState,request,refresh:(domains,options)=>refreshState(domains,options),publish:domains=>publishDomains(new Set(domains))},
  navigation:{openThoughtDetail,switchView},
  annotations:{
    openTarget:async(target,isCurrent)=>{
      const controller=await ensureAnnotationsController();
      if(!isCurrent())return false;
      controller.openPanel(commentRootKey(target.resourceType,target.targetId),target.annotationId);
      return true
    },
    refreshTarget:target=>{
      const controller=runtime.annotationsController;
      const annotation=controller?.findTaskAnnotation(target);
      if(annotation&&controller.isActiveRoot(commentRootKey(target.resourceType,target.targetId))){
        controller.refreshAnnotation(annotation)
      }
      return true
    }
  },
  view:{patchThoughtTarget:patchActiveThoughtTarget,scheduleAnnotationLayout:scheduleAnnotationLineCounts,showToast},
  platform:{document,window,requestFrame:callback=>requestAnimationFrame(callback),escapeSelector:value=>CSS.escape(value)}
})}
async function ensureBackgroundResultsController(){
  if(runtime.backgroundResultsController)return runtime.backgroundResultsController;
  const module=await loadBackgroundResultsFeatureModule();
  runtime.backgroundResultsController||=createRuntimeBackgroundResultsController(module);
  return runtime.backgroundResultsController
}
async function syncBackgroundTaskResults(tasks,owner,session){
  const hasResults=Array.isArray(tasks)
    &&tasks.some(task=>task?.status==="succeeded"&&task?.resultId);
  if(!hasResults){
    runtime.backgroundResultsRetryAttempts=0;
    return false
  }
  try{
    const controller=await ensureBackgroundResultsController();
    if(owner!==runtime.currentUser?.id||session!==runtime.sessionSerial)return false;
    runtime.backgroundResultsLoadErrorReported=false;
    const changed=await controller.sync(tasks);
    runtime.backgroundResultsRetryAttempts=controller.needsRetry()
      ?Math.min(backgroundResultsRetryLimit,runtime.backgroundResultsRetryAttempts+1)
      :0;
    return changed
  }catch(error){
    runtime.backgroundResultsRetryAttempts=Math.min(backgroundResultsRetryLimit,runtime.backgroundResultsRetryAttempts+1);
    const isCurrentSession=owner===runtime.currentUser?.id&&session===runtime.sessionSerial;
    if(isCurrentSession&&!runtime.backgroundResultsLoadErrorReported){
      runtime.backgroundResultsLoadErrorReported=true;
      showToast(`后台结果模块加载失败：${error.message}`,"error")
    }
    return false
  }
}
return Object.freeze({
  hasCapability,
  applyCapabilitySurface,
  showPermissionPage,
  renderLatex,
  currentContextSource,
  contextSourceButton,
  contextReceiptMarkup,
  openContextReceiptSource,
  clearThoughtTracePending,
  createRuntimeAnnotationsController,
  ensureAnnotationsController,
  commentRootKey,
  parseCommentRootKey,
  commentRoot,
  commentRootLabel,
  markCommentTarget,
  tagCommentableTargets,
  applyCommentAnchors,
  scheduleAnnotationLineCounts,
  restoreAnnotationUiDrafts,
  renderCommentPanel,
  openCommentPanel,
  patchActiveThoughtTarget,
  reconcileActiveThoughtRoute,
  createRuntimeBackgroundResultsController,
  ensureBackgroundResultsController,
  syncBackgroundTaskResults
})
}
