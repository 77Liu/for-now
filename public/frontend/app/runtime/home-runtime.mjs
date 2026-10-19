import { navigateAfterOnboarding } from "../../../generated/features/onboarding-v2/navigation.mjs";
import { publishDomains, state } from "../../state/index.mjs";
import { createHomeChatRenderer } from "./home-chat-renderer.mjs";
import { createHomeCheckinRenderer } from "./home-checkin-renderer.mjs";
import { createHomeSelectionQuoteModal } from "./home-selection-quote-modal.mjs";

export function createHomeRuntime({
  runtime,$,$$,eventDate,eventTimestamp,formatDate,formatDateKey,
  localDateKey,plainPreview,escapeHtml,renderMarkdown,contextReceiptMarkup,
  contentState,commentRootKey,markCommentTarget,renderLatex,
  applyCommentAnchors,appUrl,keepsakeMediaSources,keepsakePlacementCss,
  scanKeepsakeAlpha,createHomeMemoryPool,selectHomeMemories,
  quoteTagPickerConfig,createTagMultiSelectState,
  reduceTagMultiSelectState,commentRoot,commentRootLabel,parseCommentRootKey,
  resetOccurrenceInput,defaultLlmProfiles,createOnboardingV2Controller,
  requestV1,onboardingDraftStore,switchView,openThoughtDetail,
  openCaptureFeature,showToast,installOccurrenceControls,
  renderStateChart,renderCheckinSurfaces,unmountRouteContent,
  activateContentImageDraftsForCurrentRoute
} = {}) {
const renderChat=createHomeChatRenderer({
  getState:()=>state,runtime,eventDate,$,renderMarkdown,contextReceiptMarkup,contentState,
  commentRootKey,markCommentTarget,renderLatex,applyCommentAnchors
});
const {metricConfig,metricValue,renderSliders}=createHomeCheckinRenderer({
  $, $$, getState:()=>state, runtime, eventTimestamp, escapeHtml
});
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
  const elements=quoteTagPickerElements(key),model=runtime.quoteTagStates[key];
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
  runtime.quoteTagStates[key]=reduceTagMultiSelectState(runtime.quoteTagStates[key],action);
  const root=quoteTagPickerElements(key)?.root;
  if(root&&open!==undefined)root.dataset.open=String(open);
  renderQuoteTagPicker(key);
  return runtime.quoteTagStates[key]
}
function setQuoteTagPicker(key,selected=[]){
  runtime.quoteTagStates[key]=createTagMultiSelectState({candidates:quoteTagCandidates(),selected});
  const root=quoteTagPickerElements(key)?.root;if(root)root.dataset.open="false";
  renderQuoteTagPicker(key)
}
function quoteTagsForSubmission(key){
  const input=quoteTagPickerElements(key)?.input;
  let state=reduceTagMultiSelectState(runtime.quoteTagStates[key],{type:"input",value:input?.value||""});
  if(state.query)state=reduceTagMultiSelectState(state,{type:"commit"});
  runtime.quoteTagStates[key]=state;
  renderQuoteTagPicker(key);
  return[...(runtime.quoteTagStates[key]?.selected||[])]
}
const {closeSelectionQuoteModal,openSelectionQuoteModal}=createHomeSelectionQuoteModal({
  runtime,$,commentRoot,commentRootLabel,parseCommentRootKey,plainPreview,
  setQuoteTagPicker,resetOccurrenceInput
});
function llmProfile(scene = "thoughtAnswer") {
  const tier = runtime.llmSettings.scenarios?.[scene] || "high";
  const profile = runtime.llmSettings.profiles?.[tier] || defaultLlmProfiles[tier] || defaultLlmProfiles.high;
  const effort = runtime.llmSettings.sceneEfforts?.[scene] || profile.effort;
  return {tier, ...profile, effort};
}

const shiftLocalDateKey = (dateKey, days) => {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const shiftedDate = new Date(Date.UTC(year, month - 1, day + days));
  return shiftedDate.toISOString().slice(0, 10);
};
const compactNumber=value=>new Intl.NumberFormat("zh-CN",{notation:"compact",maximumFractionDigits:1}).format(Number(value)||0);
const formatCny = value => {
  const number = Number(value) || 0;
  const absolute = Math.abs(number);
  let digits = 6;
  if (absolute === 0) digits = 2;
  else if (absolute >= 100) digits = 0;
  else if (absolute >= 10) digits = 1;
  else if (absolute >= 1) digits = 2;
  else if (absolute >= 0.1) digits = 3;
  else if (absolute >= 0.01) digits = 4;
  const sign = number < 0 ? "-" : "";
  return `${sign}¥${absolute.toFixed(digits)}`;
};

const formatDuration = value => {
  const milliseconds = Number(value) || 0;
  if (milliseconds >= 60000) return `${(milliseconds / 60000).toFixed(1)} 分钟`;
  if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(1)} 秒`;
  return `${Math.round(milliseconds)} ms`;
};
function openCommercialSource(view,id,date){
  if(view==="together"&&date){runtime.activeDate=eventDate({occurredAt:date});renderDate();renderChat()}
  if(view==="thoughts")openThoughtDetail(id);else switchView(view);
  requestAnimationFrame(()=>{
    const selectors={thoughts:`[data-chain-id="${CSS.escape(id)}"]`,captures:`[data-capture-id="${CSS.escape(id)}"]`,journals:`[data-journal-id="${CSS.escape(id)}"]`,books:`[data-book-id="${CSS.escape(id)}"]`,together:`[data-chat-id="${CSS.escape(id)}"]`},target=document.querySelector(selectors[view]||"");
    if(target instanceof HTMLDetailsElement)target.open=true;
    target?.scrollIntoView({behavior:"smooth",block:"center"});
  });
}
function collectOnboardingAnswers(){
  const selectedAnswers=$$('#onboarding-questions input[type="radio"]:checked');
  for(const input of selectedAnswers){
    const questionId=input.name.replace(/^onboarding-/,"");
    runtime.onboardingDraftAnswers[questionId]=input.value;
  }
  return runtime.onboardingDraftAnswers
}
function renderOnboardingQuestions(){
  const list=$("#onboarding-questions");
  if(!list||!runtime.onboardingSchema)return;
  const questions=runtime.onboardingSchema.questions.filter(question=>
    question.tier==="quick"||runtime.onboardingMode==="detailed"
  );
  list.className="onboarding-question-list";
  list.innerHTML=questions.map((question,index)=>{
    const heading=`<header><span>${escapeHtml(question.dimension)} · ${String(index+1).padStart(2,"0")}</span><h3>${escapeHtml(question.prompt)}</h3></header>`;
    const options=question.options.map(option=>{
      const checked=runtime.onboardingDraftAnswers[question.id]===option.value;
      return `<label><input type="radio" name="onboarding-${escapeHtml(question.id)}" value="${escapeHtml(option.value)}" ${checked?"checked":""} required><span>${escapeHtml(option.label)}</span></label>`;
    }).join("");
    return `<section class="onboarding-question">${heading}<div class="onboarding-options">${options}</div></section>`;
  }).join("");
  $$('[data-onboarding-mode]').forEach(button=>{
    const active=button.dataset.onboardingMode===runtime.onboardingMode;
    button.classList.toggle("active",active);
    button.setAttribute("aria-pressed",String(active));
  })
}
function onboardingPayload(){
  collectOnboardingAnswers();
  const profile={
    gender:$("#onboarding-gender").value,
    region:$("#onboarding-region").value,
    occupation:$("#onboarding-occupation").value,
    major:$("#onboarding-major").value,
    school:$("#onboarding-school").value,
    introduction:$("#onboarding-introduction").value,
    works:$("#onboarding-works").value
  };
  return{
    status:"completed",
    questionnaireMode:runtime.onboardingMode,
    answers:runtime.onboardingDraftAnswers,
    profile,
    interests:$$('#onboarding-interests input[type="checkbox"]:checked').map(input=>input.value),
    material:$("#onboarding-material").value,
    understanding:$("#onboarding-understanding").value
  }
}
function renderLegacyOnboarding(){
  if(!runtime.onboardingSchema)return;
  if(!runtime.onboardingHydrated){
    const saved=state.onboarding||{};runtime.onboardingMode=saved.questionnaireMode==="detailed"?"detailed":"quick";runtime.onboardingDraftAnswers={...(saved.answers||{})};
    const profile=saved.profile||{};for(const key of["gender","region","occupation","major","school","introduction","works"]){const field=$(`#onboarding-${key}`);if(field)field.value=profile[key]||""}
    $("#onboarding-interests").innerHTML=(runtime.onboardingSchema.interests||[]).map(value=>`<label><input type="checkbox" value="${escapeHtml(value)}" ${(saved.interests||[]).includes(value)?"checked":""}><span>${escapeHtml(value)}</span></label>`).join("");
    $("#onboarding-material").value=saved.material||"";$("#onboarding-understanding").value=saved.understanding||"";$("#onboarding-understanding").closest("label").hidden=!saved.understanding;runtime.onboardingHydrated=true
  }
  renderOnboardingQuestions()
}
const onboardingV2Controller=createOnboardingV2Controller({
  requestV1:(...args)=>requestV1(...args),
  draftStore:onboardingDraftStore,
  owner:()=>runtime.currentUser?.id||"",
  updateState:value=>{state.onboardingV2=value},
  onLegacy:renderLegacyOnboarding,
  onFirstAction: action => navigateAfterOnboarding(action, {
    showToday: () => switchView("today"),
    openQuestion: () => $("#home-open-thought").click(),
    openRecord: () => { void openCaptureFeature("openComposer"); }
  }),
  toast:showToast
});
function renderOnboarding(){onboardingV2Controller.render()}
function renderDate(){
  $$('[data-active-date]').forEach(input=>input.value=runtime.activeDate);
  installOccurrenceControls();
  if(!$("#quote-id")?.value)resetOccurrenceInput($("#quote-datetime"));
  for(const input of[$("#checkin-datetime"),$("#chat-datetime")]){
    resetOccurrenceInput(input);
  }
  $$('[data-daily-form]').forEach(form=>{
    if(!form.elements.recordId.value)resetOccurrenceInput(form.elements.occurredAt);
  });

  const date=new Date(`${runtime.activeDate}T12:00:00`);
  const today=runtime.activeDate===localDateKey();
  const label=new Intl.DateTimeFormat("zh-CN",{
    year:"numeric",
    month:"long",
    day:"numeric",
    weekday:"long"
  }).format(date);
  $$('[data-active-date-label]').forEach(element=>{
    element.textContent=element.id==="today-date-label"
      ?runtime.activeDate.replaceAll("-","/")
      :label;
  });
  $$('[data-active-date-heading]').forEach(element=>{
    const view=element.closest(".view")?.id;
    if(!today){
      element.textContent="回到这一天";
    }else if(view==="view-daily"){
      element.textContent="今天，留下了什么？";
    }else if(view==="view-together"){
      element.textContent="今天，一起看看";
    }else{
      element.textContent="今天，你感觉怎么样？";
    }
  })
}
function homeMemorySource(item){
  const date=item.occurredAt?formatDate(item.occurredAt):formatDateKey(item.occurredOn);
  if(item.type==="book")return `书间 · 《${item.sourceTitle||"未命名书目"}》 · ${date}`;
  if(item.type==="quote")return `拾句 · ${item.sourceTitle||"来源未记"} · ${date}`;
  return `思绪 · ${date}`
}
let renderedMemoryScope = null;
/** 状态通知只重建可见首页；显式首页准备允许在揭幕前装配。账户/会话变化先清旧DOM和索引。 */
function renderHomeMemories({advance=false,preparing=false}={}){
  const container=$("#home-memory-grid"),status=$("#home-memory-status"),shuffle=$("#home-shuffle");
  if(!container)return;
  const scope = JSON.stringify([runtime.currentUser?.id || "local", runtime.sessionSerial]);
  const scopeChanged = renderedMemoryScope !== scope;
  if (scopeChanged) {
    runtime.homeMemoryKeys = [];
    runtime.homeMemoryByKey = new Map();
  }
  const surface = container.closest(".view");
  const visible = (runtime.pageRouter?.currentRoute()?.view || "today") === "today"
    && (preparing || (!surface?.hidden && surface?.classList.contains("active")
      && !document.body.classList.contains("auth-locked")));
  if (!visible) {
    if (scopeChanged && renderedMemoryScope !== null) {
      container.replaceChildren();
      status.textContent = "";
      shuffle.hidden = true;
    }
    renderedMemoryScope = scope;
    return;
  }
  renderedMemoryScope = scope;
  const pool=Array.isArray(state.homeMemories)?state.homeMemories:createHomeMemoryPool(state),poolByKey=new Map(pool.map(item=>[item.key,item])),limit=Math.min(3,pool.length);
  runtime.homeMemoryByKey=poolByKey;
  let selected=advance?[]:runtime.homeMemoryKeys.map(key=>poolByKey.get(key)).filter(Boolean).slice(0,limit);
  if(selected.length<limit){
    const selectedKeys=new Set(selected.map(item=>item.key));
    selected.push(...selectHomeMemories(pool.filter(item=>!selectedKeys.has(item.key)),{
      previousKeys:advance?runtime.homeMemoryKeys:[],
      limit:limit-selected.length
    }))
  }
  if(advance&&limit)selected=selectHomeMemories(pool,{previousKeys:runtime.homeMemoryKeys,limit});
  runtime.homeMemoryKeys=selected.map(item=>item.key);
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
  let item=items.find(value=>value.id===runtime.homeKeepsakeId);
  if(!item&&items.length){item=items[Math.floor(Math.random()*items.length)];runtime.homeKeepsakeId=item.id}
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
  renderHomeMemories({preparing:true});
  renderHomeKeepsake();
  renderHomeMood()
}
function closeHomeEditors({restoreFocus=true}={}){
  const opened=$$(".home-v02-editor-backdrop").filter(editor=>!editor.hidden),trigger=runtime.homeEditorTrigger;
  opened.forEach(editor=>editor.hidden=true);
  document.body.classList.remove("home-v02-editor-open");
  if(opened.length)runtime.homeEditorTrigger=null;
  if(restoreFocus&&opened.length&&trigger?.isConnected)trigger.focus({preventScroll:true})
}
function openHomeEditor(kind,trigger=null){
  const editor=$(`#home-${kind}-editor`);
  if(!editor)return;
  closeHomeEditors({restoreFocus:false});
  const fallback=kind==="thought"?$("#home-open-thought"):$("#home-record-state");
  runtime.homeEditorTrigger=trigger instanceof HTMLElement
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
  const view=runtime.pageRouter?.currentRoute()?.view||"today";
  if(runtime.renderedRouteView&&runtime.renderedRouteView!==view)unmountRouteContent(runtime.renderedRouteView);
  runtime.renderedRouteView=view;
  renderDate();
  $("#notification-dot").hidden=!Number(state.notificationUnread??runtime.notificationUnreadCount);
  if(view==="today"){renderSliders();renderHome()}
  else if(view==="daily")void runtime.healthFeatureController?.render().catch(error=>showToast(`日录显示失败：${error.message}`,"error"));
  activateContentImageDraftsForCurrentRoute()
}
function afterVisibleShellPaint(){
  if(document.visibilityState==="hidden")return new Promise(resolve=>setTimeout(resolve,0));
  return new Promise(resolve=>{
    let settled=false;
    const finish=()=>{if(settled)return;settled=true;resolve()};
    setTimeout(finish,50);
    requestAnimationFrame(()=>setTimeout(finish,0))
  })
}
function releaseSeries(value){const match=/^v?(\d+)\.(\d+)/.exec(String(value||""));return match?Number(match[1])*1000+Number(match[2]):null}
function assertNativeServerCompatibility(meta){
  if(!document.documentElement.dataset.apiOrigin)return;
  const client=releaseSeries(runtime.releaseVersion),server=releaseSeries(meta?.releaseVersion);
  if(server!=null&&client!=null&&server>=client)return;
  const serverLabel=meta?.releaseVersion||"旧版本";
  throw Object.assign(new Error(`当前 App ${runtime.releaseVersion} 与服务端 ${serverLabel} 不兼容，请使用匹配版本或等待服务端升级。`),{code:"CLIENT_SERVER_VERSION_MISMATCH"})
}
return Object.freeze({
  renderChat,
  metricConfig,
  metricValue,
  renderSliders,
  dataUrlFromBlob,
  loadImageSource,
  blankCanvas,
  renderHomeMemories,
  renderHomeKeepsake,
  renderHomeMood,
  renderHome,
  quoteTagCandidates,
  quoteTagPickerElements,
  renderQuoteTagPicker,
  updateQuoteTagPicker,
  setQuoteTagPicker,
  quoteTagsForSubmission,
  closeSelectionQuoteModal,
  openSelectionQuoteModal,
  llmProfile,
  shiftLocalDateKey,
  compactNumber,
  formatCny,
  formatDuration,
  openCommercialSource,
  collectOnboardingAnswers,
  renderOnboardingQuestions,
  onboardingPayload,
  renderLegacyOnboarding,
  onboardingV2Controller,
  renderOnboarding,
  renderDate,
  closeHomeEditors,
  openHomeEditor,
  trapHomeEditorFocus,
  openHomeMemory,
  onboardingBlocksPrivateShell,
  completeOnboardingSnapshot,
  renderVisibleRoute,
  afterVisibleShellPaint,
  assertNativeServerCompatibility
})
}
