import { createApiClient } from "../api/index.mjs";
import { escapeHtml, plainPreview, renderMarkdown } from "../content/index.mjs";
import {
  createPageEffects,
  DISCOVERY_GENRES,
  createThoughtDiscoveryController,
  createBackgroundResultController,
  backgroundResultFromSnapshot,
  mergeBackgroundTaskResult,
  annotationMenuItems,
  annotationPresentation,
  copyAnnotationContent,
  sortAnnotationItemsByPosition,
  createDownloadDescriptor,
  createActionsViewModel,
  buildCreateActionCommand,
  buildUpdateActionCommand,
  buildSetActionStatusCommand,
  buildCompleteActionCommand,
  buildUndoActionCompletionCommand,
  buildDeleteActionCommand,
  buildCreateHabitCommand,
  buildSetHabitEnabledCommand,
  buildHabitAdjustmentCommand,
  buildHabitCheckinCommand,
  buildDeleteHabitCommand,
  buildDeleteHabitCheckinCommand,
  feedbackSubmissionPayload,
  feedbackViewModel,
  buildHomeMoodSeries,
  createHomeMemoryPool,
  selectHomeMemories,
  keepsakeMediaSources
} from "../features/index.mjs";
import {
  imageRecordPayload,
  imageUnderstandingPayload,
  uploadOriginalImages,
  validatedImageFiles
} from "../media/index.mjs";
import { createPageRouter } from "../pages/index.mjs";
import { sessionScope, sessionSerial, rotateSession } from "../session/index.mjs";
import { state, replaceState, resetState, subscribeState, createRefreshCoordinator } from "../state/index.mjs";
import { createOccurrenceDraft, entryKeyIntent, eventDate, eventTimestamp, formatDate, formatDateKey, formatTime, localDateKey, localDateTimeForDate, occurrenceSubmission, persistedDateTimeInput, toLocalDateTimeInput } from "../time/index.mjs";

const apiClient=createApiClient({baseUrl:new URL("../../app.js",import.meta.url),session:sessionScope,onAuthRequired:()=>showAuthGate()});
const appUrl=apiClient.appUrl;
const refreshCoordinator=createRefreshCoordinator({session:sessionScope,requestState:()=>request("/api/state")});
const baseMetrics={mood:{label:"情绪",anchors:["非常难受","有些低落","平稳、无明显起伏","感觉不错","轻盈而愉快"]},energy:{label:"精力",anchors:["几乎耗尽","勉强支撑","够用，但有限","精力较好","充沛、想行动"]},stress:{label:"压力",anchors:["快要撑不住","很紧绷","压力明显但可应对","有一点紧绷","身心松弛"]},sleep:{label:"睡眠",anchors:["几乎没休息好","明显不足","基本够用","睡得不错","充分恢复"]}};
const trendLabels=Object.fromEntries(Object.entries(baseMetrics).map(([k,v])=>[k,v.label]));
const llmTiers=["lite","mid","high","ultra"];
const defaultLlmProfiles={lite:{model:"deepseek-flash",effort:"none"},mid:{model:"deepseek-flash",effort:"high"},high:{model:"deepseek-v4-pro",effort:"high"},ultra:{model:"deepseek-v4-pro",effort:"max"}};
const defaultLlmScenarios={thoughtPrompt:"lite",thoughtDraft:"high",thoughtAnswer:"ultra",followUpAnswer:"ultra",chat:"high",diaryLead:"lite",diaryStructure:"mid",diaryTopic:"high",diaryReflection:"ultra",annotationShenji:"high",analysis:"ultra",bookRecognition:"mid",healthRecognition:"mid",contentImageUnderstanding:"mid"};
const responseStyleOptions=[["concise","简短"],["standard","标准"],["deep","深入"],["structured","结构化"],["exploratory","开放探索"]];
const responseStyleScenes=["thoughtDraft","thoughtAnswer","followUpAnswer","chat","diaryReflection","annotationShenji","analysis"];
let switchView;
let backgroundResultController=null;
let currentLocalDate=localDateKey();
let llmSettings={provider:"deepseek",profiles:structuredClone(defaultLlmProfiles),scenarios:{...defaultLlmScenarios},automaticAnswers:{thoughtAnswer:false},hasApiKey:false,keyHint:""};
let activeDate=currentLocalDate,activeDailyType="sleep",healthFiles={sleep:[],heartRate:[],weight:[],exercise:[]},healthPreviewUrls=[],thoughtFilter="all",quoteTimer,quoteScrollFrame=0,quoteSkyIndex=0,answerDraft="",answerReasoningDraft="",toastTimer,notificationTimer,draftTags=[],captureDraftTags=[],pendingSelection=null,activeCommentRoot="",activeAnnotationId="",activeShenjiComposer="",answerTaskSerial=0,activeAnswerTaskId=0,pendingBookImages={cover:null,recognition:null},bookPreviewUrls={cover:"",recognition:""},bookImagePasteTarget="recognition",editingBookId="",activeBookId="",bookCreatorOpen=false,journalDraftRestored=false,pendingBookNoteId="",activeBookFeatureNoteId="",bookDetailCondensed=false,activeKeepsakeId="",activeKeepsakeView="presentation",activeKeepsakeOriginalPath="",currentUser=null,statisticsData=null,statisticsRequestSerial=0,aiCostPlan=null,aiCostStatistics=null,aiCostRequestSerial=0,architectureStage=0,architectureTerm="api",commercialMode="validation",commercialStatistics=null,commercialRequestSerial=0,trashItems=[],notificationUnreadCount=0,chainDraftVersion=0,healthParseSerial=0,bookParseSerial=0,localTestConfig=null,onboardingSchema=null,onboardingMode="quick",onboardingDraftAnswers={},onboardingHydrated=false,discoveryController=null,actionsSnapshot={actions:[],habits:[],habitCheckins:[]},actionsRequestSerial=0,feedbackItems=[],feedbackRequestSerial=0,exportManifest=null,authOperationSerial=0,authBusy=false,appVersion="0.2.0",releaseVersion="0.2.0";
let homeMemoryKeys=[],homeMemoryByKey=new Map(),homeEditorTrigger=null;
const keepsakeEditor={file:null,sourceDataUrl:"",sourceImage:null,sourceCanvas:null,maskCanvas:null,autoBase:null,history:[],mode:"keep",drawing:false,lastPoint:null,source:"manual",originalPath:"",cutoutPath:"",renderFrame:0,segmentSerial:0};
const contentImageDrafts=Object.fromEntries(["capture","thoughtRoot","thoughtBlock","comment"].map(key=>[key,{items:[],uploadRequestId:""}]));
const quoteScrollStates=new WeakMap();
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
function renderLatex(container){if(!container||!window.katex)return;container.querySelectorAll("[data-tex]").forEach(element=>{try{window.katex.render(decodeURIComponent(element.dataset.tex||""),element,{displayMode:element.classList.contains("latex-display"),throwOnError:false,strict:"ignore",trust:false})}catch{element.textContent=decodeURIComponent(element.dataset.tex||"")}})}
function reasoningDisclosure(value){return value?`<details class="saved-reasoning"><summary title="展开模型思考">思考</summary><div class="saved-reasoning-content markdown-content">${renderMarkdown(value)}</div></details>`:""}
function commentRootKey(type,id){return `${type}:${id}`}
function parseCommentRootKey(value){const divider=String(value||"").indexOf(":");return divider<1?{type:"",id:""}:{type:value.slice(0,divider),id:value.slice(divider+1)}}
function clearThoughtTracePending(rootKey){const {type,id}=parseCommentRootKey(rootKey);if(type!=="thought"||!id)return;state.insights.aiOnlyThoughtIds=(state.insights.aiOnlyThoughtIds||[]).filter(value=>value!==id);document.querySelectorAll(`[data-chain-id="${CSS.escape(id)}"]`).forEach(card=>card.closest(".thought-timeline-entry")?.querySelector(".thought-trace-pending")?.remove())}
function commentRoot(value){const {type,id}=parseCommentRootKey(value),collections={capture:"captures",journal:"journals",chat:"chats",analysis:"analyses",book:"books",quote:"quotes"};if(type==="thought")return state.thoughts.find(item=>item.id===id&&item.type==="question");return collections[type]?state[collections[type]]?.find(item=>item.id===id):null}
function commentEndpoint(value,suffix=""){const {type,id}=parseCommentRootKey(value);return `/api/annotations/${encodeURIComponent(type)}/${encodeURIComponent(id)}${suffix}`}
function commentRootLabel(value){const {type}=parseCommentRootKey(value);return({thought:"主题思考",capture:"捕念",journal:"日记",chat:"长期对话",analysis:"认知复盘",book:"读书笔记",quote:"善言"})[type]||"正文"}
function markCommentTarget(element,rootKey,targetKey){if(!element)return;element.classList.add("commentable");element.dataset.commentRoot=rootKey;element.dataset.commentTarget=targetKey}
function tagCommentableTargets(container,chains){[...(container?.querySelectorAll(".chain-record")||[])].forEach((card,index)=>{const chain=chains[index];if(!chain)return;const rootId=chain.question.id,rootKey=commentRootKey("thought",rootId);markCommentTarget(card.querySelector(".thought-question-content"),rootKey,`question:${rootId}`);card.querySelectorAll("[data-thought-block-id]").forEach(element=>{const item=chain.children.find(value=>value.id===element.dataset.thoughtBlockId);if(item)markCommentTarget(element.querySelector(".thought-block-content"),rootKey,`${item.type}:${item.id}`)});card.querySelectorAll(".response-entry[data-followup-id]").forEach(entry=>{const id=entry.dataset.followupId;markCommentTarget(entry.querySelector(".followup-question .markdown-content"),rootKey,`followup-question:${id}`);markCommentTarget(entry.querySelector(".followup-answer .model-answer-content > .markdown-content"),rootKey,`followup-answer:${id}`)})})}
function commentTextNodes(container){const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT,{acceptNode(node){if(!node.nodeValue||!node.nodeValue.length)return NodeFilter.FILTER_REJECT;const parent=node.parentElement;if(!parent||parent.closest("button, textarea, input")||parent.closest('.katex-html[aria-hidden="true"]'))return NodeFilter.FILTER_REJECT;return NodeFilter.FILTER_ACCEPT}});const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);return nodes}
function commentText(container){return commentTextNodes(container).map(node=>node.nodeValue).join("")}
function wrapCommentRange(container,start,end,rootId,annotationId,kind="comment"){let offset=0;for(const node of commentTextNodes(container)){const nodeStart=offset,nodeEnd=offset+node.nodeValue.length;offset=nodeEnd;if(end<=nodeStart||start>=nodeEnd)continue;const from=Math.max(0,start-nodeStart),to=Math.min(node.nodeValue.length,end-nodeStart);if(to<=from)continue;const selected=node.splitText(from),after=selected.splitText(to-from),mark=document.createElement("mark"),presentation=annotationPresentation({kind});mark.className=`comment-anchor ${presentation.className}`.trim();mark.dataset.commentRoot=rootId;mark.dataset.annotationId=annotationId;selected.parentNode.insertBefore(mark,selected);mark.append(selected);void after}}
function applySingleCommentAnchor(rootKey,annotation){document.querySelectorAll(`.commentable[data-comment-root="${CSS.escape(rootKey)}"][data-comment-target="${CSS.escape(annotation.targetKey)}"]`).forEach(element=>{if(element.querySelector(`.comment-anchor[data-annotation-id="${CSS.escape(annotation.id)}"]`))return;const text=commentText(element);let start=Number(annotation.start)||0,end=Number(annotation.end)||start;if(text.slice(start,end)!==annotation.quote){start=text.indexOf(annotation.quote);end=start+annotation.quote.length}if(start>=0&&end>start)wrapCommentRange(element,start,end,rootKey,annotation.id,annotation.kind)})}
function removeCommentAnchors(annotationId){document.querySelectorAll(`.comment-anchor[data-annotation-id="${CSS.escape(annotationId)}"]`).forEach(mark=>{const parent=mark.parentNode;mark.replaceWith(...mark.childNodes);parent?.normalize()})}
function applyCommentAnchors(container){container?.querySelectorAll(".commentable").forEach(element=>{const rootKey=element.dataset.commentRoot,root=commentRoot(rootKey),annotations=(root?.annotations||[]).filter(item=>item.targetKey===element.dataset.commentTarget).sort((a,b)=>b.start-a.start);for(const annotation of annotations){const text=commentText(element);let start=Number(annotation.start)||0,end=Number(annotation.end)||start;if(text.slice(start,end)!==annotation.quote){start=text.indexOf(annotation.quote);end=start+annotation.quote.length}if(start>=0&&end>start)wrapCommentRange(element,start,end,rootKey,annotation.id,annotation.kind)}})}
function commentSelection(){const selection=window.getSelection();if(!selection||selection.isCollapsed||!selection.rangeCount)return null;const range=selection.getRangeAt(0),startElement=range.startContainer.nodeType===Node.TEXT_NODE?range.startContainer.parentElement:range.startContainer,endElement=range.endContainer.nodeType===Node.TEXT_NODE?range.endContainer.parentElement:range.endContainer,startTarget=startElement?.closest?.(".commentable"),endTarget=endElement?.closest?.(".commentable");if(!startTarget||startTarget!==endTarget)return null;const quote=selection.toString().trim();if(!quote||quote.length>1000)return null;const prefix=document.createRange();prefix.selectNodeContents(startTarget);prefix.setEnd(range.startContainer,range.startOffset);let start=prefix.toString().length;const raw=selection.toString(),leading=raw.length-raw.trimStart().length;start+=leading;return{rootKey:startTarget.dataset.commentRoot,targetKey:startTarget.dataset.commentTarget,start,end:start+quote.length,quote,rect:range.getBoundingClientRect()}}
function showSelectionCommentButton(){const found=commentSelection(),tools=$("#selection-tools");if(!found){tools.hidden=true;return}pendingSelection=found;tools.hidden=false;const viewport=window.visualViewport,left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,width=viewport?.width||window.innerWidth,height=viewport?.height||window.innerHeight,x=Math.max(left+8,Math.min(left+width-tools.offsetWidth-8,found.rect.left+found.rect.width/2-tools.offsetWidth/2)),above=found.rect.top-tools.offsetHeight-9,y=above>=top+8?above:Math.min(top+height-tools.offsetHeight-8,found.rect.bottom+9);tools.style.left=`${x}px`;tools.style.top=`${Math.max(top+8,y)}px`}
function pendingAiTask(kind,targetId,subtargetId=""){return(state.aiTasks||[]).find(task=>task.kind===kind&&task.targetId===targetId&&(!subtargetId||task.subtargetId===subtargetId)&&["queued","running","cancelling"].includes(task.status))}
function annotationMenuMarkup(annotation){return `<details class="annotation-menu"><summary title="更多操作" aria-label="更多操作">⋯</summary><div role="menu">${annotationMenuItems(annotation).map(item=>`<button type="button" role="menuitem" class="${item.destructive?"danger":""}" ${item.id==="delete"?`data-comment-delete="${escapeHtml(annotation.id)}"`:`data-annotation-menu="${escapeHtml(item.id)}" data-annotation-id="${escapeHtml(annotation.id)}"`}>${escapeHtml(item.label)}</button>`).join("")}</div></details>`}
function annotationCard(annotation){const presentation=annotationPresentation(annotation),mark=annotation.kind!=="comment",{id:targetId}=parseCommentRootKey(activeCommentRoot),pending=pendingAiTask("annotationShenji",targetId,annotation.id),shenji=(annotation.shenji||[]).map(item=>`<div class="shenji-turn">${item.message?`<div class="shenji-user"><span>@你</span><div class="markdown-content">${renderMarkdown(item.message)}</div></div>`:""}<div class="shenji-answer markdown-content"><span class="shenji-label">@神鸡</span>${reasoningDisclosure(item.reasoningContent)}${renderMarkdown(item.answer)}</div><small>${formatDate(item.createdAt)}</small></div>`).join(""),images=contentImagesMarkup(annotation,"comment");return `<article class="comment-card ${mark?`${presentation.kind}-card`:""} ${activeAnnotationId===annotation.id?"active":""}" data-comment-card="${annotation.id}">${mark?`<span class="annotation-kind">${escapeHtml(presentation.label)}</span>`:""}<blockquote>${escapeHtml(annotation.quote)}</blockquote>${mark?"":`${annotation.text?`<p>${escapeHtml(annotation.text)}</p>`:""}<small>${formatDate(annotation.createdAt)}</small>${(annotation.replies||[]).map(reply=>`<div class="comment-reply"><p>${escapeHtml(reply.text)}</p><small>${formatDate(reply.createdAt)}</small></div>`).join("")}<form class="comment-reply-form" data-comment-reply="${annotation.id}"><input placeholder="回复这条评论…" required><button type="submit">回复</button></form>`}${images}${shenji?`<div class="shenji-thread">${shenji}</div>`:""}<form class="shenji-form" data-shenji-form="${annotation.id}" ${activeShenjiComposer===annotation.id?"":"hidden"}><div><span class="shenji-label">@神鸡</span><textarea name="message" rows="3" placeholder="可留空直接询问标记内容，也可补充你的问题…"></textarea></div><button type="submit" ${pending?"disabled":""}>发送</button><p class="shenji-status" role="status">${pending?"回复正在后台生成，可继续使用其他功能。":""}</p></form><div class="annotation-actions"><button type="button" class="shenji-toggle" data-shenji-toggle="${annotation.id}">@神鸡</button>${annotationMenuMarkup(annotation)}</div></article>`}
function driftCard(annotation){const context=annotation.originalContext||{before:"",focus:annotation.quote,after:""},replies=(annotation.replies||[]).map(item=>`<div class="comment-reply"><p>${escapeHtml(item.text)}</p><small>${formatDate(item.createdAt)}</small></div>`).join(""),shenji=(annotation.shenji||[]).map(item=>`<div class="shenji-turn">${item.message?`<div class="shenji-user"><span>@你</span><div class="markdown-content">${renderMarkdown(item.message)}</div></div>`:""}<div class="shenji-answer markdown-content"><span class="shenji-label">@神鸡</span>${reasoningDisclosure(item.reasoningContent)}${renderMarkdown(item.answer)}</div></div>`).join("");return `<article class="drift-card" data-drift-card="${annotation.id}"><div class="drift-meta"><span>${annotation.kind==="highlight"?"失效划线":"失效评论"}</span><small>${escapeHtml(annotation.driftReason||"原文已变化")}</small></div><div class="drift-context"><span>${escapeHtml(context.before)}</span><mark>${escapeHtml(context.focus||annotation.quote)}</mark><span>${escapeHtml(context.after)}</span></div>${annotation.text?`<p>${escapeHtml(annotation.text)}</p>`:""}${replies}${shenji}<button type="button" class="comment-delete" data-drift-delete="${annotation.id}">删除漂流记录</button></article>`}
function renderCommentPanel(){const panel=$("#comment-panel");if(!activeCommentRoot){panel.hidden=true;return}const root=commentRoot(activeCommentRoot);if(!root){activeCommentRoot="";panel.hidden=true;return}panel.hidden=false;panel.querySelector("header h2").textContent=`${commentRootLabel(activeCommentRoot)}批注`;$("#comment-composer").hidden=!(pendingSelection?.rootKey===activeCommentRoot);if(pendingSelection?.rootKey===activeCommentRoot)$("#comment-quote").textContent=pendingSelection.quote;const annotations=sortAnnotationItemsByPosition(root.annotations||[]),drift=[...(root.annotationDrift||[])].sort((a,b)=>(b.driftedAt||b.createdAt).localeCompare(a.driftedAt||a.createdAt)),live=annotations.length?annotations.map(annotationCard).join(""):empty("还没有有效评论或标记。选中正文后即可添加。"),driftSection=drift.length?`<section class="drift-box"><header><h3>评论漂流箱</h3><span>${drift.length}</span></header><p class="drift-help">原文被改写或删除后，无法可靠定位的批注会保留在这里。</p>${drift.map(driftCard).join("")}</section>`:"";$("#comment-panel-list").innerHTML=live+driftSection;renderLatex($("#comment-panel-list"));requestAnimationFrame(()=>{if(activeAnnotationId)panel.querySelector(`[data-comment-card="${CSS.escape(activeAnnotationId)}"]`)?.scrollIntoView({block:"center"})})}
function refreshAnnotationCard(annotation){const current=document.querySelector(`[data-comment-card="${CSS.escape(annotation.id)}"]`);if(!current)return renderCommentPanel();const draft=current.querySelector("[data-shenji-form] textarea")?.value||"",composerOpen=!current.querySelector("[data-shenji-form]")?.hidden,template=document.createElement("template");template.innerHTML=annotationCard(annotation).trim();const next=template.content.firstElementChild;current.replaceWith(next);const composer=next.querySelector("[data-shenji-form]"),input=composer?.querySelector("textarea");if(input)input.value=draft;if(composer)composer.hidden=!composerOpen;renderLatex(next)}
function formIdentity(form,index){for(const key of["followUpRoot","followupManualAnswer","followupEdit"])if(form.dataset[key])return`${key}:${form.dataset[key]}`;return`form:${index}`}
function captureFormDrafts(root){
  const active=document.activeElement;
  return[...root.querySelectorAll("form")].map((form,index)=>({
    key:formIdentity(form,index),hidden:form.hidden,requestId:form.dataset.requestId||"",
    fields:[...form.querySelectorAll("input,textarea,select")].map((field,fieldIndex)=>({
      key:field.name?`name:${field.name}`:field.id?`id:${field.id}`:`field:${fieldIndex}`,
      value:field.value,checked:field instanceof HTMLInputElement&&["checkbox","radio"].includes(field.type)?field.checked:null,focused:field===active,
      selectionStart:typeof field.selectionStart==="number"?field.selectionStart:null,
      selectionEnd:typeof field.selectionEnd==="number"?field.selectionEnd:null
    }))
  }))
}
function restoreFormDrafts(root,drafts){
  const forms=[...root.querySelectorAll("form")];
  for(const [index,form]of forms.entries()){
    const draft=drafts.find(item=>item.key===formIdentity(form,index));if(!draft)continue;
    form.hidden=draft.hidden;if(draft.requestId)form.dataset.requestId=draft.requestId;
    const fields=[...form.querySelectorAll("input,textarea,select")];
    for(const [fieldIndex,field]of fields.entries()){
      const key=field.name?`name:${field.name}`:field.id?`id:${field.id}`:`field:${fieldIndex}`,saved=draft.fields.find(item=>item.key===key);if(!saved)continue;
      if(saved.checked!==null)field.checked=saved.checked;else field.value=saved.value;
      if(saved.focused){field.focus({preventScroll:true});if(saved.selectionStart!==null&&typeof field.setSelectionRange==="function")field.setSelectionRange(saved.selectionStart,saved.selectionEnd)}
    }
  }
}
const durableDraftForms=["chain-form","checkin-form"];
const durableDraftKey=()=>currentUser?.id?`cike:session-drafts:${currentUser.id}`:"";
function saveDurableDrafts(){
  const key=durableDraftKey();if(!key)return;
  const forms=durableDraftForms.map(id=>document.getElementById(id)).filter(Boolean);
  const payload={forms:captureFormDrafts({querySelectorAll:()=>forms}),draftTags,captureDraftTags};
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
function patchThoughtTaskTarget(target){
  const chain=thoughtChains().find(item=>item.question.id===target.targetId);if(!chain)return false;
  const cards=[...document.querySelectorAll(`[data-chain-id="${CSS.escape(target.targetId)}"]`)];if(!cards.length)return true;
  for(const current of cards){
    const drafts=captureFormDrafts(current),rootOpen=current.open,openFollowUps=new Set([...current.querySelectorAll("[data-followup-id][open]")].map(item=>item.dataset.followupId)),template=document.createElement("template");
    template.innerHTML=chainCard(chain,false).trim();const next=template.content.querySelector(".chain-record");if(!next)continue;
    current.replaceWith(next);next.open=rootOpen;next.querySelectorAll("[data-followup-id]").forEach(item=>item.open=openFollowUps.has(item.dataset.followupId));restoreFormDrafts(next,drafts);
    tagCommentableTargets(next.parentElement,[chain]);renderLatex(next);applyCommentAnchors(next);
    next.addEventListener("toggle",()=>{if(next.open)requestAnimationFrame(()=>syncThoughtBlockOverflow(next))});
    if(next.open)requestAnimationFrame(()=>syncThoughtBlockOverflow(next))
  }
  return true
}
function annotationForTask(target){
  const collections={capture:"captures",journal:"journals",chat:"chats",analysis:"analyses",book:"books",quote:"quotes"},root=target.resourceType==="thought"
    ?state.thoughts.find(item=>item.id===target.targetId&&item.type==="question")
    :state[collections[target.resourceType]]?.find(item=>item.id===target.targetId);
  return root?.annotations?.find(item=>item.id===target.subtargetId)||null
}
function openCommentPanel(rootKey,annotationId=""){activeCommentRoot=rootKey;activeAnnotationId=annotationId;renderCommentPanel()}
const splitTags=v=>String(v||"").split(/[,，#\s]+/).map(x=>x.trim()).filter(Boolean);
const bookReadingRange=book=>book.readingStartedOn?`${formatDateKey(book.readingStartedOn)} — ${book.readingFinishedOn?formatDateKey(book.readingFinishedOn):"至今"}`:"阅读日期未记录";
const empty=t=>`<div class="empty">${escapeHtml(t)}</div>`;
const avg=v=>v.length?v.reduce((s,x)=>s+Number(x),0)/v.length:null;
const formatBytes=value=>value<1024?`${value} B`:value<1048576?`${(value/1024).toFixed(1)} KB`:`${(value/1048576).toFixed(1)} MB`;
const imageDataUrls=files=>Promise.all(files.map(file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("无法读取图片，请重新选择"));reader.readAsDataURL(file)})));
function contentImageDraft(key){return contentImageDrafts[key]}
function revokeContentImageItem(item){if(item?.preview&&item.file)URL.revokeObjectURL(item.preview)}
function renderContentImageEditor(key){
  const editor=document.querySelector(`[data-content-image-editor="${CSS.escape(key)}"]`),draft=contentImageDraft(key);if(!editor||!draft)return;
  const previews=editor.querySelector("[data-content-image-previews]");
  previews.innerHTML=draft.items.map((item,index)=>`<figure class="content-image-preview"><img src="${escapeHtml(item.preview||appUrl(item.path))}" alt="图片原文 ${index+1}"><button type="button" data-content-image-remove="${index}" aria-label="移除图片 ${index+1}" title="移除图片">×</button></figure>`).join("");
  const input=editor.querySelector('input[type="file"]');if(input)input.disabled=draft.items.length>=2
}
function resetContentImageEditor(key,paths=[]){
  const draft=contentImageDraft(key);if(!draft)return;
  draft.items.forEach(revokeContentImageItem);draft.items=[...new Set(paths)].slice(0,2).map(path=>({path}));draft.uploadRequestId="";
  const input=document.querySelector(`[data-content-image-editor="${CSS.escape(key)}"] input[type="file"]`);if(input)input.value="";
  renderContentImageEditor(key)
}
function setContentImageFiles(key,files){
  const draft=contentImageDraft(key),existing=draft.items.filter(item=>item.path);draft.items.filter(item=>item.file).forEach(revokeContentImageItem);
  const selected=validatedImageFiles(files,Math.max(0,2-existing.length));
  draft.items=[...existing,...selected.map(file=>({file,preview:URL.createObjectURL(file)}))];draft.uploadRequestId="";renderContentImageEditor(key)
}
async function contentImagePaths(key){
  const draft=contentImageDraft(key),existing=draft.items.filter(item=>item.path).map(item=>item.path),pending=draft.items.filter(item=>item.file);
  if(!pending.length)return{attachmentPaths:existing,uploadedPaths:[]};
  draft.uploadRequestId||=crypto.randomUUID();
  const uploadedPaths=await uploadOriginalImages({request,images:await imageDataUrls(pending.map(item=>item.file)),idempotencyKey:draft.uploadRequestId});
  return{attachmentPaths:[...existing,...uploadedPaths],uploadedPaths}
}
async function discardContentImageUploads(key,uploadedPaths){
  if(!uploadedPaths.length)return;
  try{
    const draft=contentImageDraft(key),result=await request("/api/images/discard",{method:"POST",body:JSON.stringify({attachmentPaths:uploadedPaths,uploadRequestId:draft.uploadRequestId})});
    if(result.discarded?.length)contentImageDraft(key).uploadRequestId=""
  }catch{}
}
function pendingContentImageTask(targetType,targetId){
  return(state.aiTasks||[]).find(task=>task.kind==="contentImageUnderstanding"&&task.contentTargetType===targetType&&task.contentTargetId===targetId&&["queued","running","cancelling"].includes(task.status))
}
function contentImagesMarkup(resource,targetType){
  const paths=Array.isArray(resource?.attachmentPaths)?resource.attachmentPaths:[],understandings=Array.isArray(resource?.imageUnderstandings)?resource.imageUnderstandings:[];
  if(!paths.length&&!understandings.length)return"";
  const pending=pendingContentImageTask(targetType,resource.id);
  return `<section class="content-attachments" data-content-attachments="${escapeHtml(targetType)}:${escapeHtml(resource.id)}">${paths.length?`<div class="content-originals">${paths.map((source,index)=>`<a href="${escapeHtml(appUrl(source))}" target="_blank" rel="noopener noreferrer" title="查看原图"><img src="${escapeHtml(appUrl(source))}" alt="图片原文 ${index+1}" loading="lazy"></a>`).join("")}</div>`:""}${understandings.map(item=>`<div class="content-understanding"><small>AI 图片理解 · 独立派生</small><div class="markdown-content">${renderMarkdown(item.content)}</div></div>`).join("")}${paths.length?`<div class="content-image-actions"><button type="button" data-content-image-understand="${escapeHtml(targetType)}" data-content-target-id="${escapeHtml(resource.id)}" data-content-version="${resource.version||1}" ${pending?"disabled":""}>✦ ${understandings.length?"重新理解":"理解图片"}</button><span class="content-image-task-status">${pending?"正在后台理解…":""}</span></div>`:""}</section>`
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
  }catch(error){if(status)status.textContent=error.message;button.disabled=false;showToast(error.message,"error")}
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
  editingBookId="";$("#book-form").reset();$("#book-reading-start").value=localDateKey();syncBookReadingDates();$("#book-image-path").value="";resetBookImage("cover");resetBookImage("recognition");$("#book-form-title").textContent="创建书目";$("#book-submit").textContent="创建书目";$("#book-edit-cancel").hidden=true;$("#book-parse-status").textContent="";
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
let latestHealthRequest=0;
function resetHealthImages(){
  healthParseSerial+=1;
  healthPreviewUrls.forEach(url=>URL.revokeObjectURL(url));healthPreviewUrls=[];
  healthFiles[activeDailyType]=[];$("#health-images").value="";$("#health-image-previews").innerHTML="";$("#health-upload-box").classList.remove("has-image","dragging");$("#parse-health-images").disabled=true;$("#health-parse-status").textContent="";
}
function renderHealthUploader(){
  const visible=Boolean(dailyTypeMeta[activeDailyType]),workflow=$("#health-image-workflow");workflow.hidden=!visible;if(!visible)return;
  const max=activeDailyType==="sleep"?2:1,files=healthFiles[activeDailyType]||[];
  $("#health-images").multiple=max>1;$("#health-upload-title").textContent=`优先上传 ${max===2?"1–2":"1"} 张${dailyTypeMeta[activeDailyType].label}截图`;
  const hints={sleep:"总览与详情可一起识别",heartRate:"包含日视图与今日概览",weight:"体重或体成分报告，未显示的字段留空",exercise:"运动详情，项目、时长与心率可一起识别"};
  $("#health-upload-hint").textContent=`点击、粘贴或拖入 · ${hints[activeDailyType]} · 合计不超过 8 MB`;
  healthPreviewUrls.forEach(url=>URL.revokeObjectURL(url));healthPreviewUrls=files.map(file=>URL.createObjectURL(file));
  $("#health-image-previews").innerHTML=files.map((file,index)=>`<figure><img src="${healthPreviewUrls[index]}" alt="待识别截图 ${index+1}"><figcaption>${escapeHtml(file.name||`截图 ${index+1}`)} · ${formatBytes(file.size)}</figcaption><button type="button" data-health-image-remove="${index}" aria-label="移除截图 ${index+1}">×</button></figure>`).join("");
  $("#health-upload-box").classList.toggle("has-image",files.length>0);$("#parse-health-images").disabled=!files.length;
}
function setHealthImages(files,source="已选择",append=false){
  healthParseSerial+=1;
  const status=$("#health-parse-status"),max=activeDailyType==="sleep"?2:1;
  try{const next=append?[...(healthFiles[activeDailyType]||[]),...files]:[...files];healthFiles[activeDailyType]=validatedImageFiles(next,max);renderHealthUploader();status.textContent=`${source}${append?"已追加":""} · ${healthFiles[activeDailyType].length} 张图片已就绪，识别后仍可修改。`;return true}catch(error){status.textContent=error.message;return false}
}
function dailyForm(type=activeDailyType){return $(`[data-daily-form="${CSS.escape(type)}"]`)}
function resetDailyForm(type=activeDailyType){
  healthParseSerial+=1;latestHealthRequest=0;
  const form=dailyForm(type);if(!form)return;form.reset();form.elements.recordId.value="";if(form.elements.attachmentPaths)form.elements.attachmentPaths.value="";resetOccurrenceInput(form.elements.occurredAt);form.querySelector('[type="submit"]').textContent=dailyTypeMeta[type].save;form.querySelector("[data-daily-cancel]").hidden=true;form.querySelector(".status").textContent="";
  for(const key of["verification","trendSegments"])if(form.elements[key])form.elements[key].value="";
  form.querySelectorAll(".daily-details").forEach(details=>details.open=false);
  if(type===activeDailyType){$("#health-parse-status").textContent="";$("#parse-health-images").disabled=!(healthFiles[type]||[]).length}
  if(type==="weight")form.elements.clothing.value="none";
}
function switchDailyType(type){
  if(!dailyTypeMeta[type])return;healthParseSerial+=1;activeDailyType=type;
  latestHealthRequest=0;$("#health-parse-status").textContent="";
  $$("[data-daily-tab]").forEach(button=>{const active=button.dataset.dailyTab===type;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active))});
  $$("[data-daily-form]").forEach(form=>{const active=form.dataset.dailyForm===type;form.hidden=!active;form.classList.toggle("active",active)});
  renderHealthUploader();renderDailyRecords();
}
const durationLabel=value=>Number.isFinite(Number(value))?`${Math.floor(Number(value)/60)}小时${String(Math.round(Number(value)%60)).padStart(2,"0")}分`:"—";
const valueLabel=(value,suffix="")=>value==null?"—":`${value}${suffix}`;
const secondsLabel=value=>Number.isFinite(value)?[Math.floor(value/3600),Math.floor(value%3600/60),value%60].map(part=>String(part).padStart(2,"0")).join(":"):"";
function fillDailyField(field,value){
  if(field.matches?.("[data-duration]"))field.value=secondsLabel(value);
  else if(field.type==="datetime-local")field.value=value?toLocalDateTimeInput(value):"";
  else field.value=Array.isArray(value)?JSON.stringify(value):value??"";
}
function dailyStructuredValues(item){
  const values=[...dailyForm(item.type).querySelectorAll("[data-health-metric]")].filter(field=>Number.isFinite(item[field.name]));
  return values.length?`<div class="daily-values">${values.map(field=>`<span><b>${escapeHtml(field.hasAttribute("data-duration")?secondsLabel(item[field.name]):item[field.name])}</b>${escapeHtml(field.closest("label").querySelector("span").textContent)}</span>`).join("")}</div>`:"";
}
function weightChart(records){
  records=records.filter(item=>Number.isFinite(item.adjustedWeight)&&Number.isFinite(item.lower95)&&Number.isFinite(item.upper95));
  if(!records.length)return"";
  const items=[...records].sort((a,b)=>eventTimestamp(a).localeCompare(eventTimestamp(b))).slice(-30),width=900,height=220,left=48,right=24,top=18,bottom=40,values=items.flatMap(item=>[item.lower95,item.upper95,item.adjustedWeight]).filter(Number.isFinite),min=Math.floor((Math.min(...values)-.5)*2)/2,max=Math.ceil((Math.max(...values)+.5)*2)/2||min+1,x=index=>items.length===1?width/2:left+index*(width-left-right)/(items.length-1),y=value=>top+(max-value)*(height-top-bottom)/(max-min||1);
  const grid=[min,(min+max)/2,max].map(value=>`<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}"/><text x="${left-8}" y="${y(value)+4}" text-anchor="end">${value.toFixed(1)}</text>`).join(""),marks=items.map((item,index)=>{const px=x(index),interval=item.clothing!=="none"?`<line class="weight-interval" x1="${px}" x2="${px}" y1="${y(item.upper95)}" y2="${y(item.lower95)}"/><line class="weight-cap" x1="${px-5}" x2="${px+5}" y1="${y(item.upper95)}" y2="${y(item.upper95)}"/><line class="weight-cap" x1="${px-5}" x2="${px+5}" y1="${y(item.lower95)}" y2="${y(item.lower95)}"/>`:"";return `${interval}<circle class="weight-point" cx="${px}" cy="${y(item.adjustedWeight)}" r="5"><title>${item.occurredOn} · 校正 ${item.adjustedWeight} kg${item.clothing!=="none"?` · 95% ${item.lower95}～${item.upper95} kg`:""}</title></circle><text class="weight-date" x="${px}" y="${height-14}" text-anchor="middle">${item.occurredOn.slice(5)}</text>`}).join("");
  return `<div class="weight-chart-legend"><span><i></i>衣物校正值</span><span><i class="interval"></i>穿衣记录 95% 估计区间</span></div><svg class="weight-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="最近体重衣物校正值与95%估计区间"><g class="weight-grid">${grid}</g>${marks}</svg><p class="weight-chart-note">图中使用衣物校正值进行比较；区间来自固定衣物重量假设，不代表体脂秤测量误差或医学置信区间。</p>`;
}
function dailyRecordCard(item){
  const labels={sleep:"睡眠",heartRate:"心率",weight:"体重",exercise:"运动"},source=item.source==="screenshot"?"截图识别":"手动记录";let body="";
  if(item.type==="sleep")body=`<div class="daily-values"><span><b>${durationLabel(item.totalMinutes)}</b>总睡眠</span><span><b>${valueLabel(item.deepMinutes," 分")}</b>深睡 ${valueLabel(item.deepPercent,"%")}</span><span><b>${valueLabel(item.lightMinutes," 分")}</b>浅睡 ${valueLabel(item.lightPercent,"%")}</span><span><b>${valueLabel(item.remMinutes," 分")}</b>快速眼动 ${valueLabel(item.remPercent,"%")}</span><span><b>${valueLabel(item.awakeCount," 次")}</b>清醒 · ${valueLabel(item.awakeMinutes," 分")}</span><span><b>${valueLabel(item.averageHeartRate)}</b>心率 · 血氧 ${valueLabel(item.averageOxygen,"%")} · 呼吸 ${valueLabel(item.respiratoryRate)}</span></div>`;
  if(item.type==="heartRate")body=`<div class="daily-values"><span><b>${valueLabel(item.minimum)}–${valueLabel(item.maximum)}</b>心率范围</span><span><b>${valueLabel(item.average)}</b>平均</span><span><b>${valueLabel(item.resting)}</b>静息</span><span><b>${valueLabel(item.sleepAverage)}</b>睡眠平均</span></div>${item.trendAnalysis?`<p class="heart-trend">${escapeHtml(item.trendAnalysis)}</p>`:""}`;
  if(item.type==="weight")body=Number.isFinite(item.adjustedWeight)&&Number.isFinite(item.measuredWeight)?`<div class="weight-record-value"><strong>${item.adjustedWeight.toFixed(2)} kg</strong><span>秤上 ${item.measuredWeight.toFixed(2)} kg · ${item.clothing==="none"?"不穿衣":item.clothing==="light"?"轻便衣物":"厚重衣物"}</span>${item.clothing!=="none"&&Number.isFinite(item.lower95)&&Number.isFinite(item.upper95)?`<small>95% 估计区间 ${item.lower95.toFixed(2)}–${item.upper95.toFixed(2)} kg</small>`:""}</div>`:`<p class="weight-model-note">总重量未填写 · 仅记录体成分或描述</p>`;
  if(item.type==="exercise"&&item.exerciseType)body=`<h4 class="exercise-type">${escapeHtml(item.exerciseType)}</h4>`;
  if(["weight","exercise"].includes(item.type)){
    body+=dailyStructuredValues(item);
    if(item.description)body+=`<p class="exercise-description">${escapeHtml(item.description)}</p>`;
    if(item.verification)body+=`<p class="weight-model-note">识别核对：${escapeHtml(item.verification)}</p>`;
    if(item.attachmentPaths?.length)body+=`<div class="daily-attachments">${item.attachmentPaths.map((url,index)=>`<a href="${escapeHtml(appUrl(url))}" target="_blank" rel="noopener noreferrer">查看截图 ${index+1}</a>`).join("")}</div>`;
  }
  return `<article class="daily-record-entry" data-daily-record-id="${item.id}"><header><div><span>${labels[item.type]}</span><time>${escapeHtml(item.occurredOn)} · ${formatTime(eventTimestamp(item))}</time></div><small>${source}</small></header>${body}<footer><button type="button" data-daily-edit="${item.id}">编辑</button><button type="button" class="danger" data-daily-delete="${item.id}">删除</button></footer></article>`;
}
function renderDailyRecords(){
  const items=[...(state.dailyRecords||[])].filter(item=>item.type===activeDailyType).sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a)));
  $("#daily-history-title").textContent=`${dailyTypeMeta[activeDailyType].label}记录`;$("#daily-history-count").textContent=`${items.length} 条`;$("#daily-record-chart").innerHTML=activeDailyType==="weight"?weightChart(items):"";
  $("#daily-record-list").innerHTML=items.length?items.map(dailyRecordCard).join(""):empty(`还没有${dailyTypeMeta[activeDailyType].label}记录。`);
}
function editDailyRecord(id){
  const item=(state.dailyRecords||[]).find(record=>record.id===id);if(!item)return;switchDailyType(item.type);const form=dailyForm(item.type);resetDailyForm(item.type);form.elements.recordId.value=item.id;resetOccurrenceInput(form.elements.occurredAt,item);if(form.elements.attachmentPaths)form.elements.attachmentPaths.value=JSON.stringify(item.attachmentPaths||[]);
  for(const [key,value]of Object.entries(item)){if(["id","type","createdAt","occurredAt","occurredOn","attachmentPaths","trendSegments"].includes(key)||!form.elements[key])continue;fillDailyField(form.elements[key],value)}
  form.querySelectorAll(".daily-details").forEach(details=>details.open=[...details.querySelectorAll("input")].some(input=>input.value!==""));
  if(form.elements.bedtime)form.elements.bedtime.value=item.bedtime?toLocalDateTimeInput(item.bedtime):"";if(form.elements.wakeTime)form.elements.wakeTime.value=item.wakeTime?toLocalDateTimeInput(item.wakeTime):"";if(form.elements.trendSegments)form.elements.trendSegments.value=JSON.stringify(item.trendSegments||[]);
  form.querySelector('[type="submit"]').textContent="保存修改";form.querySelector("[data-daily-cancel]").hidden=false;form.querySelector(".status").textContent="正在编辑已有记录";form.scrollIntoView({behavior:"smooth",block:"center"});
}

function setAnswerStatus(id,message,kind="working"){document.querySelectorAll(`[data-answer-chain="${CSS.escape(id)}"]`).forEach(button=>{let status=button.closest(".chain-expanded")?.querySelector(".card-action-status");if(!status){status=document.createElement("p");status.className="card-action-status";status.setAttribute("role","status");status.setAttribute("aria-live","polite");button.closest(".chain-expanded")?.append(status)}status.className=`card-action-status ${kind}`;status.textContent=message})}
async function request(url,options={}){const answerId=url.match(/^\/api\/thoughts\/([^/]+)\/answer$/)?.[1];try{const result=await apiClient.request(url,options);if(answerId)setAnswerStatus(answerId,"回答已生成并保存。","success");return result}catch(error){if(answerId&&error.name!=="AbortError")setAnswerStatus(answerId,`未能生成：${error.message}，可重试。`,"error");throw error}}
async function requestV1(url,options={}){
  const result=await request(url,options);
  if(!result||result.error)throw new Error(result?.error?.message||"接口返回异常");
  return{data:result.data,meta:result.meta||{}}
}
async function listAllV1(url){
  const items=[],seen=new Set();let cursor="";
  do{
    const separator=url.includes("?")?"&":"?",result=await requestV1(`${url}${separator}limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);
    items.push(...(Array.isArray(result.data)?result.data:[]));cursor=result.meta.nextCursor||"";
    if(cursor&&seen.has(cursor))throw new Error("列表游标没有前进");if(cursor)seen.add(cursor)
  }while(cursor);
  return items
}
const optionalRequest=url=>apiClient.request(url,{headers:{accept:"application/json"}},{optional:true,authGate:false});
async function requestStream(url,options={},onEvent=()=>{}){
  const answerId=url.match(/^\/api\/thoughts\/([^/]+)\/answer$/)?.[1];
  try{const result=await apiClient.requestStream(url,options,onEvent);if(answerId)setAnswerStatus(answerId,"回答已生成并保存。","success");return result}
  catch(error){if(answerId&&error.name!=="AbortError")setAnswerStatus(answerId,`未能生成：${error.message}，可重试。`,"error");throw error}
}
function showToast(message,kind="success"){const t=$("#toast");t.textContent=message;t.className=`toast ${kind}`;t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.hidden=true,3200)}
const trashTypeLabels={checkin:"状态",dailyRecord:"健康日录",capture:"捕念",journal:"日记",journalReflection:"日记回望",thoughtChain:"思绪",thoughtBlock:"思绪内容",thoughtRemark:"思绪备注",thoughtFollowUp:"追问",annotation:"批注",annotationDrift:"漂流批注",chat:"对话",book:"书目",bookNote:"读书记录",keepsake:"小物",quote:"善言",experiment:"实验",analysis:"复盘",customMetric:"自定义指标",action:"行动",habit:"习惯",habitCheckin:"习惯打卡"};
function trashPayload(entry){if(entry.type==="thoughtChain"){const records=entry.payload?.items||[];return records.map(record=>record.item).filter(Boolean)}return[entry.payload]}
function trashTitle(entry){
  const items=trashPayload(entry),item=items.find(value=>value.type==="question")||items[0]||{};
  return plainPreview(item.content||item.question||item.title||item.message||item.source||item.hypothesis||item.name||item.text||"无标题记录").slice(0,120)||"无标题记录"
}
function trashDetail(entry){
  const ignored=new Set(["id","clientRequestId","requestHash","originalPath","cutoutPath","imagePath","attachmentPaths"]);
  const rows=[];
  const visit=(value,label="")=>{
    if(value==null||rows.length>=80)return;
    if(Array.isArray(value)){value.forEach((item,index)=>visit(item,`${label}${label?" · ":""}${index+1}`));return}
    if(typeof value==="object"){for(const[key,item]of Object.entries(value)){if(!ignored.has(key))visit(item,key)}return}
    if(typeof value!=="string"||!value.trim()||/^(?:[0-9a-f-]{24,}|\d{4}-\d{2}-\d{2}T)/i.test(value))return;
    rows.push(`<div><b>${escapeHtml(label||"内容")}</b><div class="markdown-content">${renderMarkdown(value)}</div></div>`)
  };
  trashPayload(entry).forEach(item=>visit(item));
  return rows.join("")||"<p>这条记录没有可预览的文字内容。</p>"
}
function renderTrash(){
  const list=$("#trash-list"),selected=new Set($$("[data-trash-select]:checked").map(input=>input.value));
  $("#trash-retention").textContent="默认保留 30 天";
  list.innerHTML=trashItems.length?trashItems.map(entry=>`<article class="trash-entry" data-trash-id="${escapeHtml(entry.id)}"><label class="trash-select"><input type="checkbox" data-trash-select value="${escapeHtml(entry.id)}" ${selected.has(entry.id)?"checked":""}><span>选择</span></label><div class="trash-copy"><header><span>${escapeHtml(trashTypeLabels[entry.type]||entry.type)}</span><time>${formatDate(entry.deletedAt)}</time></header><h2>${escapeHtml(trashTitle(entry))}</h2><p>保留期标记至 ${escapeHtml(formatDate(entry.purgeAfter))}；永久清理始终由你确认。</p><details><summary>查看完整内容</summary><div class="trash-detail">${trashDetail(entry)}</div></details></div><button class="quiet-button" type="button" data-trash-restore="${escapeHtml(entry.id)}">恢复</button></article>`).join(""):empty("回收站是空的。");
  renderLatex(list);$("#trash-purge-selected").disabled=!selected.size;
}
async function loadTrash(){
  const status=$("#trash-status"),owner=currentUser?.id,session=sessionSerial;status.textContent="正在读取回收站…";
  try{const result=await request("/api/trash");if(owner!==currentUser?.id||session!==sessionSerial)return false;trashItems=result.items||[];renderTrash();status.textContent="";return true}
  catch(error){if(owner===currentUser?.id&&session===sessionSerial)status.textContent=error.message;return false}
}
const taskStatusLabels={queued:"排队中",running:"生成中",succeeded:"已完成",failed:"失败",stale:"目标已变化",cancelled:"已取消"};
function renderNotifications(){
  const items=state.notifications||[],tasks=new Map((state.aiTasks||[]).map(task=>[task.id,task])),unread=Number(state.notificationUnread??notificationUnreadCount)||items.filter(item=>!item.readAt&&["succeeded","failed","stale","cancelled"].includes(item.status)).length;
  $("#notification-dot").hidden=!unread;
  $("#notification-list").innerHTML=items.length?items.map(item=>{const task=tasks.get(item.taskId),canRetry=task&&["failed","stale"].includes(task.status);return `<article class="notification-entry ${item.readAt?"":"unread"}"><div><header><b>${escapeHtml(item.title||"后台任务")}</b><span>${escapeHtml(taskStatusLabels[item.status]||item.status)}</span><time>${formatDate(item.updatedAt||item.createdAt)}</time></header><p>${escapeHtml(item.message||"")}</p></div><div>${item.targetId?`<button class="subtle-action" type="button" data-notification-open="${escapeHtml(item.targetId)}" data-notification-task="${escapeHtml(item.taskId||"")}" data-notification-id="${escapeHtml(item.id)}">查看</button>`:""}${canRetry?`<button class="subtle-action" type="button" data-task-retry="${escapeHtml(task.id)}">重试</button>`:""}${item.readAt?"":`<button class="subtle-action" type="button" data-notification-read="${escapeHtml(item.id)}">已读</button>`}</div></article>`}).join(""):empty("还没有后台任务通知。");
  renderMine();
}
function scheduleNotificationPoll(){
  clearTimeout(notificationTimer);
  if(!(state.aiTasks||[]).some(task=>["queued","running","cancelling"].includes(task.status)))return;
  notificationTimer=setTimeout(async()=>{try{await loadNotifications()}finally{scheduleNotificationPoll()}},1800);
}
async function loadNotifications(){const owner=currentUser?.id,session=sessionSerial;try{const [notifications,tasks]=await Promise.all([request("/api/notifications"),request("/api/ai-tasks")]);if(owner!==currentUser?.id||session!==sessionSerial)return false;state.notifications=notifications.items||[];state.aiTasks=tasks.items||[];notificationUnreadCount=Number(notifications.unread)||0;state.notificationUnread=notificationUnreadCount;renderNotifications();await backgroundResultController?.sync(state.aiTasks);$("#notifications-status").textContent="";return true}catch(error){if(owner===currentUser?.id&&session===sessionSerial)$("#notifications-status").textContent=error.message;return false}}
async function openAiTaskTarget(task,notification){
  const resourceType=task?.resourceType||notification?.resourceType||"thought",targetId=task?.targetId||notification?.targetId,subtargetId=task?.subtargetId||notification?.subtargetId||"",kind=task?.kind||"thoughtAnswer";
  const destination={thought:["thoughts","thoughts"],capture:["captures","captures"],journal:["journals","journals"],chat:["together","chat"],analysis:["review","review"],book:["books","books"],quote:["quotes","quotes"]}[resourceType]||["thoughts","thoughts"];
  switchView(destination[0]);
  await refreshState([destination[1],"notifications"],resourceType==="thought"?{chainId:targetId,followUpId:kind==="followUpAnswer"?subtargetId:""}:{});
  if(kind==="contentImageUnderstanding"){
    if(task?.contentTargetType==="comment"&&targetId&&subtargetId){openCommentPanel(commentRootKey(resourceType,targetId),subtargetId);return}
    if(task?.contentTargetType==="capture")return requestAnimationFrame(()=>document.querySelector(`[data-capture-id="${CSS.escape(task.contentTargetId)}"]`)?.scrollIntoView({behavior:"smooth",block:"center"}));
    const block=task?.contentTargetType==="thoughtBlock"?state.thoughts.find(item=>item.id===task.contentTargetId):null,rootId=task?.contentTargetType==="thoughtRoot"?task.contentTargetId:block?.relatedTo;
    if(rootId)return requestAnimationFrame(()=>document.querySelector(`[data-chain-id="${CSS.escape(rootId)}"]`)?.scrollIntoView({behavior:"smooth",block:"center"}))
  }
  if(kind==="annotationShenji"&&targetId&&subtargetId){
    openCommentPanel(commentRootKey(resourceType,targetId),subtargetId);
    requestAnimationFrame(()=>document.querySelector(`[data-comment-card="${CSS.escape(subtargetId)}"]`)?.scrollIntoView({behavior:"smooth",block:"center"}));
    return
  }
  if(resourceType==="thought"&&targetId)requestAnimationFrame(()=>document.querySelector(`[data-chain-id="${CSS.escape(targetId)}"]`)?.scrollIntoView({behavior:"smooth",block:"center"}))
}
function commitDraftTags(){const input=$("#chain-tags"),values=splitTags(input.value);for(const value of values)if(!draftTags.includes(value))draftTags.push(value);input.value="";renderTagComposer()}
function renderTagComposer(){const list=$("#chain-tag-list");if(!list)return;list.innerHTML=draftTags.map(tag=>`<span class="tag-chip">#${escapeHtml(tag)}<button type="button" data-remove-draft-tag="${escapeHtml(tag)}" aria-label="移除标签 ${escapeHtml(tag)}">×</button></span>`).join("");const known=[...new Set(state.thoughts.flatMap(item=>item.tags||[]))].filter(tag=>!draftTags.includes(tag));$("#tag-suggestions").innerHTML=known.map(tag=>`<option value="${escapeHtml(tag)}"></option>`).join("")}
function commitCaptureTags(){const input=$("#capture-tags"),values=splitTags(input.value);for(const value of values)if(!captureDraftTags.includes(value))captureDraftTags.push(value);input.value="";renderCaptureTagComposer()}
function renderCaptureTagComposer(){const list=$("#capture-tag-list");if(!list)return;list.innerHTML=captureDraftTags.map(tag=>`<span class="tag-chip">#${escapeHtml(tag)}<button type="button" data-remove-capture-tag="${escapeHtml(tag)}" aria-label="移除关键词 ${escapeHtml(tag)}">×</button></span>`).join("");const known=[...new Set([...(state.captures||[]),...(state.thoughts||[])].flatMap(item=>item.tags||[]))].filter(tag=>!captureDraftTags.includes(tag));$("#capture-tag-suggestions").innerHTML=known.map(tag=>`<option value="${escapeHtml(tag)}"></option>`).join("")}
function metricConfig(){const custom=Object.fromEntries((state.customMetrics||[]).map(x=>[x.id,{label:x.name,anchors:[x.low,"偏低","居中","偏高",x.high],custom:true}]));return{...baseMetrics,...custom}}
function metricValue(checkin,key,custom){return custom?checkin.custom?.[key]:checkin[key]}
function metricReference(key,custom){const eligible=state.checkins.filter(x=>x.occurredOn<=activeDate).sort((a,b)=>b.occurredOn.localeCompare(a.occurredOn)||eventTimestamp(b).localeCompare(eventTimestamp(a)));const previous=eligible.map(x=>metricValue(x,key,custom)).find(x=>Number.isFinite(Number(x)));const history=eligible.slice(0,30).map(x=>Number(metricValue(x,key,custom))).filter(Number.isFinite);return{previous:previous==null?null:Number(previous),average:avg(history)}}
function metricMarker(kind,value,label){if(!Number.isFinite(value))return"";const position=Math.max(0,Math.min(100,(value-1)*25)),thumbOffset=11-position*.22,left=`calc(${position}% + ${thumbOffset.toFixed(3)}px)`;return `<span class="metric-history-marker ${kind}" style="left:${left}" data-position="${position}" role="img" aria-label="${label} ${value.toFixed(2)}" title="${label} ${value.toFixed(2)}"></span>`}
function sliderTemplate(key,cfg){const ref=metricReference(key,cfg.custom),value=ref.previous??(ref.average==null?3:Math.round(ref.average));return `<div class="metric unconfirmed"><div class="metric-top"><span class="metric-label">${escapeHtml(cfg.label)}</span><span class="anchor" id="${key}-anchor">待确认 · ${escapeHtml(cfg.anchors[value-1])}</span><button class="note-toggle" type="button" data-note="${key}" aria-expanded="false">＋备注</button></div><div class="metric-scale">${metricMarker("previous",ref.previous,"上一次")}${metricMarker("average",ref.average,"近30次平均")}<input type="range" id="metric-${key}" data-metric="${key}" data-custom="${cfg.custom?"1":"0"}" data-confirmed="false" min="1" max="5" value="${value}" step="1" aria-label="${escapeHtml(cfg.label)} 1到5，必须确认"></div><div class="range-labels"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div><input class="note-field" id="${key}-note" placeholder="可选：补充一句话" maxlength="800"></div>`}
function renderSliders(){const cfg=metricConfig();$("#sliders").innerHTML=`<div class="metric-history-legend" aria-label="历史参照图例"><span><i class="previous"></i>上一次</span><span><i class="average"></i>近30次平均</span></div>${Object.entries(cfg).map(([k,v])=>sliderTemplate(k,v)).join("")}`;$$('[data-metric]').forEach(input=>{const update=(confirmed=false)=>{if(confirmed){input.dataset.confirmed="true";input.closest(".metric").classList.remove("unconfirmed")}const prefix=input.dataset.confirmed==="true"?"":"待确认 · ";$(`#${CSS.escape(input.dataset.metric)}-anchor`).textContent=`${prefix}${cfg[input.dataset.metric].anchors[Number(input.value)-1]}`};input.addEventListener("input",()=>update(true));input.addEventListener("change",()=>navigator.vibrate?.(8));input.addEventListener("pointerdown",()=>update(true));update()});$$(".note-toggle").forEach(b=>b.addEventListener("click",()=>{const f=$(`#${CSS.escape(b.dataset.note)}-note`);f.classList.toggle("visible");b.setAttribute("aria-expanded",String(f.classList.contains("visible")));if(f.classList.contains("visible"))f.focus()}))}

const thoughtDate=chain=>eventDate(chain.question);
function thoughtChains(){const roots=state.thoughts.filter(x=>x.type==="question"),ids=new Set(roots.map(x=>x.id));const grouped=roots.map(question=>({question,children:state.thoughts.filter(x=>x.relatedTo===question.id).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))}));state.thoughts.filter(x=>x.type!=="question"&&(!x.relatedTo||!ids.has(x.relatedTo))).forEach(x=>grouped.push({question:{...x,type:"question",content:"（旧记录未关联问题）"},children:[x]}));return grouped.sort((a,b)=>thoughtDate(b).localeCompare(thoughtDate(a))||eventTimestamp(b.question).localeCompare(eventTimestamp(a.question)))}
function thoughtAnswerPreview(content){return plainPreview(content).replace(/^(?:核心判断|给我判断|给你(?:一个)?判断|我的判断|结论)(?:\s*[：:]|\s+)\s*/u,"").trimStart()}
function thoughtBlockBody(content){
  return `<div class="thought-block-content-frame"><div class="thought-block-content markdown-content">${renderMarkdown(content||"")}</div></div><button class="thought-block-expand" type="button" data-thought-block-expand aria-expanded="false" hidden><span>展开全文</span><i aria-hidden="true">⌄</i></button>`
}
function thoughtContentBlock(item,question){
  const ai=item.authorType==="ai"||/^(?:deepseek|codex)/.test(item.origin||"")||Boolean(item.reasoningContent),labels={idea:"初步想法",record:"记录",answer:ai?"AI 回答":"我的回答"},label=labels[item.type]||"内容",source=ai?"AI 派生":"用户原文";
  return `<article class="thought-content-block ${ai?"ai":""}" data-thought-block-id="${item.id}"><header><div><b>${label}</b><span>${source}</span>${item.generation?`<small>第 ${item.generation} 次</small>`:""}</div><time>${formatDate(eventTimestamp(item))}</time></header>${reasoningDisclosure(item.reasoningContent)}${thoughtBlockBody(item.content||item.modelDraft||"")}${contentImagesMarkup(item,"thoughtBlock")}${item.modelDraft&&item.editedFromModel?`<small class="edit-signal">${item.content?"由 AI 草稿修改后保留":"未保留 AI 草稿"}</small>`:""}<footer><span>版本 ${item.version||1}</span><div><button class="subtle-action" type="button" data-thought-block-edit="${item.id}" data-root-id="${question.id}">编辑</button><button class="subtle-action danger" type="button" data-thought-block-delete="${item.id}" data-root-id="${question.id}">删除</button></div></footer></article>`
}
function thoughtFollowUpBlock(followUp,question,index){
  const pending=pendingAiTask("followUpAnswer",question.id,followUp.id);
  return `<details class="response-entry thought-content-block followup-block" data-followup-id="${followUp.id}"><summary><div class="response-summary-copy"><div class="response-summary-head"><strong>追问 ${index+1}</strong><span>用户原文</span><small>版本 ${followUp.version||1} · ${formatDate(followUp.updatedAt||followUp.createdAt)}</small></div><p>${escapeHtml(plainPreview(followUp.question))}</p></div></summary><div class="response-entry-body"><div class="followup-question"><b>追问问题</b><div class="markdown-content">${renderMarkdown(followUp.question)}</div></div><div class="followup-answer"><b>追问回答</b>${followUp.answer?`<div class="model-answer-content">${reasoningDisclosure(followUp.reasoningContent)}<div class="markdown-content">${renderMarkdown(followUp.answer)}</div></div>`:`<form class="manual-followup-answer" data-followup-manual-answer="${followUp.id}" data-root-id="${question.id}" data-version="${followUp.version||1}"><textarea rows="3" placeholder="直接写下回答…" aria-label="追问回答" required></textarea><div><button class="quiet-button" type="submit">保存回答</button><button type="button" class="subtle-action answer-action" data-followup-answer="${followUp.id}" data-root-id="${question.id}" ${pending?"disabled":""}>✦ 给我回答</button></div></form>`}<p class="followup-status" role="status" aria-live="polite">${pending?"回答正在后台生成，可继续使用其他功能。":""}</p></div><div class="followup-record-actions"><button type="button" class="subtle-action" data-followup-edit-toggle="${followUp.id}">编辑</button><button type="button" class="subtle-action danger" data-followup-delete="${followUp.id}" data-root-id="${question.id}">删除</button></div><form class="followup-edit-form" data-followup-edit="${followUp.id}" data-root-id="${question.id}" data-version="${followUp.version||1}" hidden><label>追问问题<textarea rows="3" name="question" required>${escapeHtml(followUp.question)}</textarea></label><label>追问回答（可空）<textarea rows="5" name="answer">${escapeHtml(followUp.answer||"")}</textarea></label><div><button class="quiet-button" type="submit">保存修改</button><button class="subtle-action" type="button" data-followup-edit-cancel="${followUp.id}">取消</button></div></form></div></details>`
}
function thoughtStream(question,children){
  const items=[
    ...children.map(item=>({time:eventTimestamp(item),markup:thoughtContentBlock(item,question)})),
    ...(question.remarks||[]).map(remark=>({time:remark.updatedAt||remark.createdAt,markup:`<article class="thought-content-block remark-block"><header><div><b>备注</b><span>用户原文</span></div><time>${formatDate(remark.updatedAt||remark.createdAt)}</time></header>${thoughtBlockBody(remark.text)}<footer><span>版本 ${remark.version||1}</span><div><button class="subtle-action" type="button" data-edit-remark="${remark.id}" data-thought-id="${question.id}">编辑</button><button class="subtle-action danger" type="button" data-delete-remark="${remark.id}" data-thought-id="${question.id}">删除</button></div></footer></article>`})),
    ...(question.followUps||[]).map((followUp,index)=>({time:followUp.updatedAt||followUp.answeredAt||followUp.createdAt,markup:thoughtFollowUpBlock(followUp,question,index)}))
  ].sort((a,b)=>String(b.time).localeCompare(String(a.time)));
  return `<section class="thought-content-stream"><header><b>内容时间线</b><span>${items.length} 条 · 最新在前</span></header>${items.length?items.map(item=>item.markup).join(""):'<p class="missing-part">还没有后续内容。</p>'}</section>`
}
function chainCard({question,children},showDate=true){
  const ideas=children.filter(x=>x.type==="idea"),answers=children.filter(x=>x.type==="answer"),ideaText=ideas.map(x=>x.content).join(" "),answerPreview=thoughtAnswerPreview(answers.at(-1)?.content||"")||(answers.some(x=>x.modelDraft)?"AI 草稿未被保留":"尚未回答"),annotationCount=(question.annotations||[]).length+(question.annotationDrift||[]).length;
  const dispositionActions=`${question.disposition!=="kept"?`<button class="subtle-action" data-disposition="${question.id}" data-value="kept">保留</button>`:""}${question.disposition!=="discarded"?`<button class="subtle-action" data-disposition="${question.id}" data-value="discarded">舍弃</button>`:""}`;
  const tags=question.tags?.length?`#${question.tags.map(escapeHtml).join(" #")}`:"未标记",tracePending=(state.insights.aiOnlyThoughtIds||[]).includes(question.id)?'<span class="thought-trace-pending">📫没有你的痕迹⏳</span>':"";
  return `<article class="thought-timeline-entry"><div class="timeline-date">${showDate?escapeHtml(eventDate(question)):""}</div><header class="thought-entry-meta"><div class="thought-entry-markers"><span class="thought-entry-tags">${tags}</span>${tracePending}</div><time>${formatTime(eventTimestamp(question))}</time></header><details class="thought-card chain-record" data-chain-id="${question.id}"><summary class="chain-summary"><div class="summary-content"><strong class="question-preview">${escapeHtml(plainPreview(question.content)||"图片记录")}</strong>${ideaText?`<p class="idea-preview">${escapeHtml(plainPreview(ideaText))}</p>`:""}<p class="answer-preview">${escapeHtml(answerPreview)}</p></div><span class="expand-mark" aria-hidden="true">⌄</span></summary><div class="chain-expanded"><section class="chain-part"><b>问题</b><div><div class="thought-question-content markdown-content">${renderMarkdown(question.content)}</div>${contentImagesMarkup(question,"thoughtRoot")}</div></section>${thoughtStream(question,children)}<form class="followup-form" data-follow-up-root="${question.id}" hidden><label><span>追问问题</span><textarea rows="3" name="question" placeholder="补充一个追问…" required></textarea></label><label><span>回答（可选）</span><textarea rows="3" name="answer" placeholder="已有答案时可一起记下"></textarea></label><button class="quiet-button followup-submit" type="submit">＋ 追问</button><p class="followup-status" role="status" aria-live="polite"></p></form><div class="thought-actions"><button class="subtle-action answer-action" data-answer-chain="${question.id}">✦ ${answers.length?"重新回答":"给我回答"}</button><button class="subtle-action" data-thought-block-add="record" data-root-id="${question.id}">＋记录</button><button class="subtle-action" data-thought-block-add="idea" data-root-id="${question.id}">＋想法</button>${annotationCount?`<button class="subtle-action" data-open-comments="${question.id}">批注 ${annotationCount}</button>`:""}${dispositionActions}<button class="subtle-action" data-edit-chain="${question.id}">编辑主题</button><button class="subtle-action" data-followup-compose="${question.id}" aria-expanded="false">＋追问</button><button class="subtle-action" data-remark="${question.id}">＋备注</button><button class="subtle-action danger" data-delete-chain="${question.id}">删除</button></div></div></details></article>`
}
function chainCardsMarkup(chains){return chains.map((chain,index)=>chainCard(chain,index===0||thoughtDate(chain)!==thoughtDate(chains[index-1]))).join("")}
function renderThoughtFilters(chains){const tags=[...new Set(chains.flatMap(({question,children})=>[...(question.tags||[]),...children.flatMap(x=>x.tags||[])]))].sort((a,b)=>a.localeCompare(b,"zh-CN"));if(thoughtFilter!=="all"&&!tags.includes(thoughtFilter))thoughtFilter="all";$("#thought-filters").innerHTML=["all",...tags].map(tag=>`<button class="filter-button ${thoughtFilter===tag?"active":""}" data-tag-filter="${escapeHtml(tag)}">${tag==="all"?"全部":`#${escapeHtml(tag)}`}</button>`).join("")}
function thoughtOpenState(){const roots=new Set(),followUps=new Set();$$('.chain-record[open][data-chain-id]').forEach(card=>roots.add(card.dataset.chainId));$$('.response-entry[open][data-followup-id]').forEach(entry=>{const root=entry.closest('[data-chain-id]')?.dataset.chainId;if(root)followUps.add(`${root}:${entry.dataset.followupId}`)});return{roots,followUps}}
function restoreThoughtOpenState(openState){$$('[data-chain-id]').forEach(card=>{if(openState.roots.has(card.dataset.chainId))card.open=true;card.querySelectorAll('[data-followup-id]').forEach(entry=>{if(openState.followUps.has(`${card.dataset.chainId}:${entry.dataset.followupId}`))entry.open=true})})}
function syncThoughtBlockOverflow(root=document){
  root.querySelectorAll(".thought-content-block:not(.followup-block)").forEach(card=>{
    const frame=card.querySelector(".thought-block-content-frame"),button=card.querySelector("[data-thought-block-expand]");if(!frame||!button)return;
    const expanded=card.classList.contains("is-expanded");card.classList.remove("is-collapsible");
    const limit=parseFloat(getComputedStyle(frame).getPropertyValue("--thought-block-collapsed-height"))||420,overflows=frame.scrollHeight>limit+1;
    card.classList.toggle("is-collapsible",overflows);card.classList.toggle("is-expanded",overflows&&expanded);button.hidden=!overflows;button.setAttribute("aria-expanded",String(overflows&&expanded));button.querySelector("span").textContent=overflows&&expanded?"收起":"展开全文";
  })
}
function setupThoughtBlockOverflow(){
  $$(".chain-record").forEach(card=>card.addEventListener("toggle",()=>{if(card.open)requestAnimationFrame(()=>syncThoughtBlockOverflow(card))}));
  requestAnimationFrame(()=>$$(".chain-record[open]").forEach(syncThoughtBlockOverflow))
}
function renderThoughts(extraOpen={}){const open=thoughtOpenState();if(extraOpen.chainId)open.roots.add(extraOpen.chainId);if(extraOpen.followUpId)open.followUps.add(`${extraOpen.chainId}:${extraOpen.followUpId}`);const chains=thoughtChains(),today=chains.filter(x=>thoughtDate(x)===activeDate).slice(0,5);$("#today-thoughts").innerHTML=today.length?chainCardsMarkup(today):empty("这一天还没有思绪记录。");renderThoughtFilters(chains);const items=thoughtFilter==="all"?chains:chains.filter(({question,children})=>[...(question.tags||[]),...children.flatMap(x=>x.tags||[])].includes(thoughtFilter));$("#all-thoughts").innerHTML=items.length?chainCardsMarkup(items):empty("这个标签下还没有记录。");tagCommentableTargets($("#today-thoughts"),today);tagCommentableTargets($("#all-thoughts"),items);renderLatex($("#today-thoughts"));renderLatex($("#all-thoughts"));applyCommentAnchors($("#today-thoughts"));applyCommentAnchors($("#all-thoughts"));restoreThoughtOpenState(open);setupThoughtBlockOverflow()}

function captureCard(item,showDate=true){
  const tags=item.tags?.length?`#${item.tags.map(escapeHtml).join(" #")}`:"未标记";
  return `<article class="capture-timeline-entry" data-capture-id="${item.id}"><div class="timeline-date capture-date">${showDate?escapeHtml(eventDate(item)):""}</div><header class="capture-meta"><span class="capture-top-tags">${tags}</span><time class="capture-entry-time">${formatTime(eventTimestamp(item))}</time></header><div class="capture-item"><div class="capture-copy"><div class="capture-content-viewport"><div class="record-actions capture-actions"><button type="button" data-capture-promote="${item.id}">展开成思考</button><div class="capture-actions-row"><button type="button" data-capture-edit="${item.id}">编辑</button><button type="button" class="danger" data-capture-delete="${item.id}" aria-label="删除这条捕念">删除</button></div></div>${item.content?`<div class="markdown-content">${renderMarkdown(item.content)}</div>`:""}${contentImagesMarkup(item,"capture")}</div></div><button class="capture-expand" type="button" data-capture-expand aria-expanded="false" aria-label="展开捕念" hidden>⌄</button></div></article>`;
}
function syncCaptureOverflow(){
  $$(".capture-item").forEach(card=>{
    const viewport=card.querySelector(".capture-content-viewport"),button=card.querySelector("[data-capture-expand]");if(!viewport||!button)return;
    const wasExpanded=viewport.classList.contains("expanded");viewport.classList.remove("expanded");
    const overflows=viewport.scrollHeight>viewport.clientHeight+1;
    const expanded=wasExpanded&&overflows;
    viewport.classList.toggle("expanded",expanded);card.classList.toggle("is-expandable",overflows);card.classList.toggle("is-expanded",expanded);button.hidden=!overflows;button.setAttribute("aria-expanded",String(expanded));button.setAttribute("aria-label",expanded?"收起捕念":"展开捕念");
  });
}
function toggleCaptureCard(card){
  if(!card?.classList.contains("is-expandable"))return;
  const viewport=card.querySelector(".capture-content-viewport"),button=card.querySelector("[data-capture-expand]"),expanded=!viewport.classList.contains("expanded");
  viewport.classList.toggle("expanded",expanded);card.classList.toggle("is-expanded",expanded);button.setAttribute("aria-expanded",String(expanded));button.setAttribute("aria-label",expanded?"收起捕念":"展开捕念");
}
function renderCaptures(){
  const items=[...(state.captures||[])].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a)));
  $("#capture-count").textContent=`${items.length} 条`;
  $("#capture-list").innerHTML=items.length?items.map((item,index)=>captureCard(item,index===0||eventDate(item)!==eventDate(items[index-1]))).join(""):empty("这里还没有捕念。下一次有什么一闪而过，直接放进来。");
  items.forEach(item=>markCommentTarget($(`[data-capture-id="${CSS.escape(item.id)}"] .capture-copy .markdown-content`),commentRootKey("capture",item.id),"content"));
  renderLatex($("#capture-list"));applyCommentAnchors($("#capture-list"));requestAnimationFrame(syncCaptureOverflow);
}
function resetCaptureForm(){
  $("#capture-form").reset();delete $("#capture-form").dataset.requestId;$("#capture-id").value="";resetContentImageEditor("capture");captureDraftTags=[];renderCaptureTagComposer();resetOccurrenceInput($("#capture-date"));$("#capture-submit").textContent="收下";$("#capture-cancel").hidden=true;$("#capture-status").textContent="";
}
function editCapture(id){
  const item=state.captures.find(value=>value.id===id);if(!item)return;
  $("#capture-id").value=item.id;$("#capture-content").value=item.content;resetContentImageEditor("capture",item.attachmentPaths||[]);captureDraftTags=[...(item.tags||[])];$("#capture-tags").value="";renderCaptureTagComposer();resetOccurrenceInput($("#capture-date"),item);$("#capture-submit").textContent="保存修改";$("#capture-cancel").hidden=false;$("#capture-status").textContent="正在编辑已有捕念";$("#capture-form").scrollIntoView({behavior:"smooth",block:"start"});$("#capture-content").focus();
}
function reflectionMarkup(item,reflection,index){
  const stale=reflection.sourceUpdatedAt&&(reflection.sourceUpdatedAt!==(item.updatedAt||item.createdAt));
  return `<details class="journal-reflection" data-reflection-id="${reflection.id}" ${index===0?"open":""}><summary><span>助手回望${index?" "+(item.reflections.length-index):""}</span><small>${stale?"基于修改前版本 · ":""}${formatDate(reflection.createdAt)}</small></summary><div class="model-answer-content">${reasoningDisclosure(reflection.reasoningContent)}<div class="markdown-content">${renderMarkdown(reflection.content)}</div></div></details>`;
}
function journalCard(item){
  const title=item.title||`${eventDate(item)} 日记`,reflections=item.reflections||[],tags=item.tags?.length?`<div class="record-tags">${item.tags.map(tag=>`<span>#${escapeHtml(tag)}</span>`).join("")}</div>`:"";
  return `<details class="card journal-entry" data-journal-id="${item.id}"><summary><div><time>${escapeHtml(eventDate(item))}</time><strong>${escapeHtml(title)}</strong><p>${escapeHtml(plainPreview(item.content))}</p></div><span class="expand-mark" aria-hidden="true">⌄</span></summary><div class="journal-entry-body"><div class="markdown-content journal-original">${renderMarkdown(item.content)}</div>${tags}<div class="record-actions"><button type="button" class="reflect-action" data-journal-reflect="${item.id}">✦ ${reflections.length?"再次回望":"请助手回望"}</button><button type="button" data-journal-edit="${item.id}">编辑</button><button type="button" class="danger" data-journal-delete="${item.id}">删除</button></div>${reflections.length?`<section class="journal-reflections"><h3>回望记录</h3>${reflections.map((reflection,index)=>reflectionMarkup(item,reflection,index)).join("")}</section>`:""}</div></details>`;
}
function renderJournals(){
  if(!journalDraftRestored){journalDraftRestored=true;restoreJournalDraft(state.journalDraft)}
  const open=new Set($$(".journal-entry[open]").map(item=>item.dataset.journalId)),items=[...(state.journals||[])].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a)));
  $("#journal-count").textContent=`${items.length} 篇`;
  $("#journal-list").innerHTML=items.length?items.map(journalCard).join(""):empty("还没有日记。写一句真实的话，就是开始。");
  $$(".journal-entry").forEach(card=>{const item=items.find(value=>value.id===card.dataset.journalId);if(!item)return;if(open.has(item.id))card.open=true;const rootKey=commentRootKey("journal",item.id);markCommentTarget(card.querySelector(".journal-original"),rootKey,"content");(item.reflections||[]).forEach(reflection=>markCommentTarget(card.querySelector(`[data-reflection-id="${CSS.escape(reflection.id)}"] .model-answer-content>.markdown-content`),rootKey,`reflection:${reflection.id}`))});renderLatex($("#journal-list"));applyCommentAnchors($("#journal-list"));
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

function renderCheckinHistory(items){
  const list=$("#checkin-history"),ordered=[...items].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a))),cfg=metricConfig();
  if(!ordered.length){list.innerHTML="";return}
  list.innerHTML=`<div class="checkin-history-heading"><b>单次记录</b><span>${ordered.length} 次</span></div><div class="checkin-history-list">${ordered.map(item=>{const values=Object.entries(cfg).map(([key,meta])=>{const value=metricValue(item,key,meta.custom);return Number.isFinite(Number(value))?`<span>${escapeHtml(meta.label)} ${Number(value)}</span>`:""}).filter(Boolean).join(""),factors=item.factors?.length?`因素：${item.factors.map(escapeHtml).join("、")}`:"未记录因素";return `<article class="checkin-history-entry"><header><time>${escapeHtml(eventDate(item))} · ${formatTime(eventTimestamp(item))}</time><span><button type="button" data-edit-checkin="${escapeHtml(item.id)}" aria-label="编辑 ${escapeHtml(eventDate(item))} ${formatTime(eventTimestamp(item))} 的状态">编辑</button><button type="button" class="danger" data-delete-checkin="${escapeHtml(item.id)}" aria-label="删除这次状态">删除</button></span></header><div>${values}</div><p>${factors}</p></article>`}).join("")}</div>`;
}
function renderStateChart(){
  const days=Number($("#chart-range")?.value||30),cutoff=new Date(`${activeDate}T12:00:00`);cutoff.setDate(cutoff.getDate()-days+1);
  const available=state.checkins.filter(item=>item.occurredOn<=activeDate),eligible=available.filter(item=>new Date(`${item.occurredOn}T12:00:00`)>=cutoff),groups=new Map();
  for(const item of eligible){if(!groups.has(item.occurredOn))groups.set(item.occurredOn,[]);groups.get(item.occurredOn).push(item)}
  renderCheckinHistory(available);
  const dates=[...groups.keys()].sort();if(!dates.length){$("#state-chart").innerHTML=empty("记录一次状态后，这里会出现时间线。");return}
  const mean=(items,getter)=>{const values=items.map(getter).map(Number).filter(Number.isFinite);return values.length?avg(values):null},round=value=>Math.round(value*100)/100;
  const daily=dates.map(date=>{const entries=groups.get(date),mood=mean(entries,x=>x.mood),energy=mean(entries,x=>x.energy),stress=mean(entries,x=>x.stress),sleep=mean(entries,x=>x.sleep),composite=[mood,energy,stress,sleep].every(Number.isFinite)?0.3*mood+0.3*energy+0.25*sleep+0.15*stress:null;return{date,entries:entries.length,mood,energy,stress,sleep,composite,score:composite==null?null:Math.round((composite-1)*25),custom:Object.fromEntries((state.customMetrics||[]).map(metric=>[metric.id,mean(entries,x=>x.custom?.[metric.id])]))}});
  const palette=["#7885c8","#70a68c","#d39a78","#a990c8","#7aa8b8","#b2a56b","#cb87a1"],series=[{key:"mood",label:"情绪",color:palette[0]},{key:"energy",label:"精力",color:palette[1]},{key:"stress",label:"压力",color:palette[2]},{key:"sleep",label:"睡眠",color:palette[3]},...(state.customMetrics||[]).map((metric,index)=>({key:`custom.${metric.id}`,label:metric.name,color:palette[(index+4)%palette.length]}))];
  const valueOf=(day,key)=>key.startsWith("custom.")?day.custom[key.slice(7)]:day[key],width=900,height=250,left=42,right=18,top=20,bottom=42,x=index=>daily.length===1?width/2:left+index*(width-left-right)/(daily.length-1),y=value=>top+(5-value)*(height-top-bottom)/4,pathFor=key=>daily.map((day,index)=>({index,value:valueOf(day,key)})).filter(point=>Number.isFinite(point.value)).map((point,index)=>`${index?"L":"M"}${x(point.index)},${y(point.value)}`).join(" ");
  const labels=daily.map((day,index)=>(index===0||index===daily.length-1||daily.length<=7)?`<text x="${x(index)}" y="232" text-anchor="middle">${day.date.slice(5)}</text>`:"").join(""),grid=[1,2,3,4,5].map(value=>`<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}"/><text x="25" y="${y(value)+4}">${value}</text>`).join("");
  const paleLines=series.map(item=>{const path=pathFor(item.key),dots=daily.map((day,index)=>{const value=valueOf(day,item.key);return Number.isFinite(value)?`<circle class="metric-dot" style="--series:${item.color}" cx="${x(index)}" cy="${y(value)}" r="3.5"><title>${day.date} · ${item.label} ${round(value)} · ${day.entries} 次提交均值</title></circle>`:""}).join("");return path?`<path class="metric-line" style="--series:${item.color}" d="${path}"/>${dots}`:""}).join("");
  const scorePath=pathFor("composite"),scoreDots=daily.map((day,index)=>Number.isFinite(day.composite)?`<circle class="score-dot" cx="${x(index)}" cy="${y(day.composite)}" r="5"><title>${day.date} · 综合 ${day.score}/100 · ${day.entries} 次提交均值</title></circle>`:"").join(""),current=daily.at(-1),summary=[["情绪",current.mood],["精力",current.energy],["压力",current.stress],["睡眠",current.sleep]].map(([label,value])=>`${label} ${round(value)}`).join(" · ");
  $("#state-chart").innerHTML=`<div class="chart-stats"><span><b>${daily.length}</b> 个记录日</span><span><b>${eligible.length}</b> 次提交</span><span><b>${current.score??"—"}</b> 最新综合分</span></div><div class="chart-day-summary"><b>${current.date}</b><span>${current.entries} 次提交取均值：${summary}</span></div><div class="chart-legend">${series.map(item=>`<span><i style="--series:${item.color}"></i>${escapeHtml(item.label)}</span>`).join("")}<span class="score-legend"><i></i>综合状态</span></div><svg class="timeline-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="所有状态指标的每日均值与综合状态趋势"><g class="chart-grid">${grid}${labels}</g>${paleLines}<path class="score-line" d="${scorePath}"/>${scoreDots}</svg><p class="score-method">所有指标均为 1 最差、5 最好。综合分 = 情绪 30% + 精力 30% + 睡眠 25% + 压力状态 15%，再换算为 0–100。自定义指标只展示趋势，不擅自计入总分。</p>`
}
function renderChat(){const chats=state.chats.filter(x=>eventDate(x)===activeDate);$("#chat-history").innerHTML=chats.length?[...chats].reverse().map(x=>`<div class="chat-message user" data-chat-id="${x.id}" data-chat-part="message"><div class="markdown-content">${renderMarkdown(x.message)}</div></div><div class="chat-message agent" data-chat-id="${x.id}" data-chat-part="answer">${reasoningDisclosure(x.reasoningContent)}<div class="markdown-content">${renderMarkdown(x.answer)}</div><button class="subtle-action danger chat-delete" type="button" data-chat-delete="${x.id}">删除对话</button></div>`).join(""):empty("在这里提问，我会带着你的长期记录一起回答。");chats.forEach(item=>{const rootKey=commentRootKey("chat",item.id);markCommentTarget($(`[data-chat-id="${CSS.escape(item.id)}"][data-chat-part="message"]>.markdown-content`),rootKey,"message");markCommentTarget($(`[data-chat-id="${CSS.escape(item.id)}"][data-chat-part="answer"]>.markdown-content`),rootKey,"answer")});renderLatex($("#chat-history"));applyCommentAnchors($("#chat-history"))}
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
function renderAnalysisHistory(){
  const list=$("#analysis-list"),known=new Set([...list.querySelectorAll("[data-analysis-id]")].map(item=>item.dataset.analysisId)),opened=new Set([...list.querySelectorAll("[data-analysis-id][open]")].map(item=>item.dataset.analysisId)),items=[...(state.analyses||[])].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  $("#analysis-count").textContent=`${items.length} 份`;
  list.innerHTML=items.length?items.map((item,index)=>{const label=item.reason==="weekly-background"?"后台周复盘":"主动复盘",isNew=!known.has(item.id),open=opened.has(item.id)||(index===0&&(!known.size||isNew));return `<details class="analysis-entry" data-analysis-id="${item.id}" ${open?"open":""}><summary><div><div class="analysis-summary-meta"><time>${formatDate(item.createdAt)}</time><span>${label}</span>${index===0?'<b>最新</b>':""}</div><p>${escapeHtml(plainPreview(item.content))}</p></div><span class="expand-mark" aria-hidden="true">⌄</span></summary><div class="analysis-entry-body">${reasoningDisclosure(item.reasoningContent)}<div class="analysis-content markdown-content">${renderMarkdown(item.content)}</div><button class="subtle-action danger" type="button" data-analysis-delete="${item.id}">删除复盘</button></div></details>`}).join(""):empty("已有任一状态、健康、捕念、日记或思绪记录，就可以生成低样本认知复盘。");
  items.forEach(item=>markCommentTarget(list.querySelector(`[data-analysis-id="${CSS.escape(item.id)}"] .analysis-content`),commentRootKey("analysis",item.id),"content"));
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
function bookCoverMarkup(book,className="book-cover"){return book.imagePath?`<img class="${className}" src="${escapeHtml(appUrl(book.imagePath))}" alt="${escapeHtml(book.title)}">`:`<div class="${className} placeholder" aria-hidden="true">书</div>`}
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
    return `<article class="book-timeline-entry" id="book-note-${note.id}" data-note-id="${note.id}">
      ${date!==previous?`<time class="book-entry-date">${escapeHtml(date)}</time>`:""}
      <div class="book-entry-card card">
        <header><span class="book-entry-type ${note.type==="thought"?"thought":""}">${type}</span><time>${formatTime(eventTimestamp(note))}</time></header>
        <div class="book-note markdown-content">${renderMarkdown(note.content)}</div>
        <footer><button class="book-favorite ${note.favorite||"none"}" type="button" data-book-note-favorite="${note.id}" data-next-favorite="${favorite.next}" title="${favorite.label}，点击切换" aria-label="${favorite.label}，点击切换">${favorite.icon}</button><div><button class="subtle-action" type="button" data-book-note-edit="${note.id}">编辑</button><button class="subtle-action danger" type="button" data-book-note-delete="${note.id}">删除</button></div></footer>
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
  notes.forEach(note=>markCommentTarget(detail.querySelector(`[data-note-id="${CSS.escape(note.id)}"] .book-note`),rootKey,`note:${note.id}`));
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
  if(!editingBookId&&!$("#book-reading-start").value)$("#book-reading-start").value=localDateKey();
  if(activeBookId&&!book){activeBookId="";activeBookFeatureNoteId="";bookDetailCondensed=false}
  const detailBook=state.books.find(item=>item.id===activeBookId),inDetail=Boolean(detailBook),creator=$("#book-create-panel"),library=$("#book-library"),detail=$("#book-detail"),toggle=$("#book-create-toggle");
  $("#view-books").classList.toggle("book-detail-mode",inDetail);
  $("#view-books").classList.toggle("book-detail-condensed",inDetail&&bookDetailCondensed);
  detail.classList.toggle("is-condensed",inDetail&&bookDetailCondensed);
  $("#book-count").textContent=hasBooks?`${state.books.length} 本`:"";
  $("#book-note-count").textContent=`${state.books.reduce((sum,item)=>sum+(item.notes||[]).length,0)} 条笔记`;
  toggle.hidden=!hasBooks||inDetail;toggle.textContent=bookCreatorOpen?"收起创建":"＋ 添加书目";
  creator.hidden=inDetail||(hasBooks&&!bookCreatorOpen);creator.classList.toggle("cold-start",!hasBooks);
  library.hidden=inDetail||!hasBooks;detail.hidden=!inDetail;
  if(inDetail){renderBookDetail(detailBook);return}
  detail.innerHTML="";
  if(!hasBooks){$("#book-grid").innerHTML="";return}
  renderBookMemories();
  $("#book-grid").innerHTML=state.books.map(book=>{
    const notes=sortedBookNotes(book),latest=notes[0];
    return `<article class="book-card card" data-book-id="${book.id}"><button class="book-card-open" type="button" data-open-book="${book.id}">${bookCoverMarkup(book,"book-gallery-cover")}<span class="book-card-copy"><span class="book-title-frame" data-title="${escapeHtml(book.title)}" title="${escapeHtml(book.title)}"><strong class="book-title">${escapeHtml(book.title)}</strong></span><span>${escapeHtml(book.author||"作者未填")}</span><small class="book-card-reading">${escapeHtml(bookReadingRange(book))}</small><small>${notes.length} 条记录${latest?` · ${formatDate(eventTimestamp(latest))}`:""}</small></span><span class="book-card-arrow" aria-hidden="true">→</span></button></article>`
  }).join("");
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
  previewCtx.clearRect(0,0,preview.width,preview.height);previewCtx.save();previewCtx.globalAlpha=.15;previewCtx.drawImage(source,0,0);previewCtx.restore();previewCtx.drawImage(keepsakeCutoutCanvas(),0,0);
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
  keepsakeEditor.autoBase=maskImageDataFromCanvas(target);keepsakeEditor.source="auto";applyKeepsakeExpansion();
  return true;
}
function keepsakeSegmentationDataUrl(){
  return keepsakeWorkingImage(1600).toDataURL("image/jpeg",.9);
}
function resetKeepsakeEditor({close=false}={}){
  keepsakeEditor.segmentSerial+=1;keepsakeEditor.file=null;keepsakeEditor.sourceDataUrl="";keepsakeEditor.sourceImage=null;keepsakeEditor.sourceCanvas=null;keepsakeEditor.maskCanvas=null;keepsakeEditor.autoBase=null;keepsakeEditor.source="manual";keepsakeEditor.originalPath="";keepsakeEditor.cutoutPath="";keepsakeEditor.drawing=false;keepsakeEditor.lastPoint=null;
  keepsakeEditor.mode="keep";$("#keepsake-brush-keep").classList.add("active");$("#keepsake-brush-erase").classList.remove("active");$("#keepsake-brush-keep").setAttribute("aria-pressed","true");$("#keepsake-brush-erase").setAttribute("aria-pressed","false");
  $("#keepsake-auto-segment").disabled=false;
  clearKeepsakeHistory();$("#keepsake-form").reset();$("#keepsake-id").value="";resetOccurrenceInput($("#keepsake-datetime"));$("#keepsake-edge-expansion").value="8";$("#keepsake-edge-output").value="8";$("#keepsake-image").value="";$("#keepsake-editor").hidden=true;$("#keepsake-upload-box").hidden=false;$("#keepsake-upload-box").classList.remove("dragging","has-image");$("#keepsake-upload-title").textContent="选择、粘贴或拖入小物照片";$("#keepsake-upload-hint").textContent="PNG / JPEG / WebP · 不超过 8 MB";$("#keepsake-segment-status").textContent="";$("#keepsake-save-status").textContent="";$("#keepsake-save").textContent="保存小物";$("#keepsake-cancel-edit").hidden=true;$("#keepsake-editor-eyebrow").textContent="新建留存";$("#keepsake-editor-title").textContent="拍下或放入一张照片";
  if(close)$("#keepsake-workspace").hidden=true;
}
function invalidateKeepsakeSegmentation(){keepsakeEditor.segmentSerial+=1;$("#keepsake-auto-segment").disabled=false}
async function prepareKeepsakeImage({dataUrl,file=null,cutoutUrl="",auto=true,serial=++keepsakeEditor.segmentSerial}){
  const image=await loadImageSource(dataUrl),maxSide=1600,scale=Math.min(1,maxSide/Math.max(image.naturalWidth,image.naturalHeight)),width=Math.max(1,Math.round(image.naturalWidth*scale)),height=Math.max(1,Math.round(image.naturalHeight*scale)),sourceCanvas=blankCanvas(width,height),maskCanvas=blankCanvas(width,height);
  if(serial!==keepsakeEditor.segmentSerial)return false;
  sourceCanvas.getContext("2d").drawImage(image,0,0,width,height);
  if(cutoutUrl){const cutout=await loadImageSource(cutoutUrl),temp=blankCanvas(width,height),tempCtx=temp.getContext("2d",{willReadFrequently:true});tempCtx.drawImage(cutout,0,0,width,height);const sourceData=tempCtx.getImageData(0,0,width,height),maskData=new ImageData(width,height);for(let i=0;i<sourceData.data.length;i+=4)maskData.data[i]=maskData.data[i+1]=maskData.data[i+2]=maskData.data[i+3]=sourceData.data[i+3];maskCanvas.getContext("2d").putImageData(maskData,0,0)}
  if(serial!==keepsakeEditor.segmentSerial)return false;
  keepsakeEditor.file=file;keepsakeEditor.sourceDataUrl=dataUrl;keepsakeEditor.sourceImage=image;keepsakeEditor.sourceCanvas=sourceCanvas;keepsakeEditor.maskCanvas=maskCanvas;keepsakeEditor.autoBase=null;keepsakeEditor.source="manual";clearKeepsakeHistory();
  $("#keepsake-upload-box").hidden=true;$("#keepsake-editor").hidden=false;renderKeepsakeCanvases();
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
  const serial=++keepsakeEditor.segmentSerial,owner=currentUser?.id,session=sessionSerial,requestId=crypto.randomUUID(),targetId=$("#keepsake-id").value||"keepsake-draft";button.disabled=true;status.textContent="正在识别主体，通常需要数秒…";pushKeepsakeHistory();
  try{
    const result=await request("/api/keepsakes/segment",{method:"POST",body:JSON.stringify({requestId,targetId,inputVersion:serial,image:keepsakeSegmentationDataUrl()})});
    if(serial!==keepsakeEditor.segmentSerial||owner!==currentUser?.id||session!==sessionSerial||(result.requestId&&result.requestId!==requestId))return;
    if(!result.cutout)throw new Error("服务未返回透明轮廓");
    if(!await applySegmentedKeepsakeMask(result.cutout,serial))return;
    status.textContent="自动轮廓已生成，可继续涂抹修正。";
  }catch(error){if(serial===keepsakeEditor.segmentSerial)status.textContent=`自动提取未完成：${error.message}。仍可手动涂抹。`}
  finally{if(serial===keepsakeEditor.segmentSerial)button.disabled=false}
}
function keepsakeCanvasPoint(event){
  const canvas=$("#keepsake-mask-canvas"),rect=canvas.getBoundingClientRect();
  return{x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height};
}
function paintKeepsakeStroke(from,to){
  const canvas=keepsakeEditor.maskCanvas;if(!canvas)return;const ctx=canvas.getContext("2d"),display=$("#keepsake-mask-canvas"),scale=canvas.width/display.getBoundingClientRect().width,size=Number($("#keepsake-brush-size").value)*scale;
  ctx.save();ctx.globalCompositeOperation=keepsakeEditor.mode==="erase"?"destination-out":"source-over";ctx.strokeStyle="#fff";ctx.fillStyle="#fff";ctx.lineWidth=size;ctx.lineCap="round";ctx.lineJoin="round";ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);ctx.stroke();ctx.beginPath();ctx.arc(to.x,to.y,size/2,0,Math.PI*2);ctx.fill();ctx.restore();keepsakeEditor.source="manual";scheduleKeepsakeRender();
}
function keepsakeImageMarkup(item,className="",loading="lazy",mode="list"){
  let imagePath="";
  try{imagePath=keepsakeMediaSources(item,mode).imagePath}catch{}
  return `<span class="keepsake-image-stack ${className}"><img class="keepsake-image-cutout" src="${escapeHtml(appUrl(imagePath))}" alt="${escapeHtml(item.title)}" loading="${loading}"></span>`;
}
function keepsakeTagsMarkup(tags){
  return (tags||[]).length?`<span class="keepsake-tags">${tags.map(tag=>`<span>#${escapeHtml(tag)}</span>`).join("")}</span>`:"";
}
function renderKeepsakeDetail(item){
  const original=activeKeepsakeView==="original",detail=$("#keepsake-detail");
  detail.dataset.keepsakeId=item.id;
  detail.innerHTML=`<nav class="keepsake-detail-nav"><button class="book-back" type="button" data-keepsake-back>← 返回陈列</button><div class="keepsake-detail-actions"><button class="text-button" type="button" data-keepsake-edit="${escapeHtml(item.id)}">编辑</button><button class="text-button danger" type="button" data-keepsake-delete="${escapeHtml(item.id)}">删除</button></div></nav>
    <div class="keepsake-detail-layout">
      <section class="keepsake-detail-media">
        <div class="keepsake-detail-viewbar"><span>${original?"原始照片":"主体清晰 · 环境 15%"}</span><div class="segmented-control" aria-label="图片显示方式"><button type="button" data-keepsake-view="presentation" aria-pressed="${String(!original)}" class="${original?"":"active"}">呈现</button><button type="button" data-keepsake-view="original" aria-pressed="${String(original)}" class="${original?"active":""}">原图</button></div></div>
        <div class="keepsake-detail-image-wrap">${keepsakeImageMarkup(original?{...item,originalPath:activeKeepsakeOriginalPath}:item,"keepsake-detail-image","eager",original?"original":"detail")}</div>
      </section>
      <section class="keepsake-detail-copy">
        <p class="eyebrow">${escapeHtml(item.category||"其他")}</p>
        <h2>${escapeHtml(item.title)}</h2>
        <time datetime="${escapeHtml(eventTimestamp(item))}">${escapeHtml(formatDateKey(eventDate(item)))} · ${formatTime(eventTimestamp(item))}</time>
        ${keepsakeTagsMarkup(item.tags)}
        <p class="keepsake-detail-note">${item.note?escapeHtml(item.note):"没有留下文字备注。"}</p>
      </section>
    </div>`;
}
function renderKeepsakes(){
  const items=[...(state.keepsakes||[])].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a)));
  let detailItem=items.find(item=>item.id===activeKeepsakeId);if(activeKeepsakeId&&!detailItem){activeKeepsakeId="";activeKeepsakeView="presentation"}
  detailItem=items.find(item=>item.id===activeKeepsakeId);const inDetail=Boolean(detailItem),library=$(".keepsake-library"),detail=$("#keepsake-detail");
  $("#view-keepsakes").classList.toggle("keepsake-detail-mode",inDetail);$("#keepsake-count").textContent=items.length?`${items.length} 件`:"";$("#keepsake-library-count").textContent=`${items.length} 件`;$("#keepsake-create-toggle").hidden=inDetail;library.hidden=inDetail;detail.hidden=!inDetail;
  if(inDetail){renderKeepsakeDetail(detailItem);return}
  detail.innerHTML="";
  $("#keepsake-grid").innerHTML=items.length?items.map(item=>`<article class="keepsake-card" data-keepsake-id="${escapeHtml(item.id)}"><button class="keepsake-card-open" type="button" data-keepsake-open="${escapeHtml(item.id)}" aria-label="查看 ${escapeHtml(item.title)} 详情">${keepsakeImageMarkup(item,"keepsake-card-image")}<span class="keepsake-card-copy"><span class="keepsake-card-meta"><span class="keepsake-card-category">${escapeHtml(item.category||"其他")}</span><time>${formatDate(eventTimestamp(item))}</time></span><strong>${escapeHtml(item.title)}</strong>${item.note?`<span class="keepsake-card-note">${escapeHtml(item.note)}</span>`:""}${keepsakeTagsMarkup(item.tags)}</span></button><div class="keepsake-card-actions"><button type="button" data-keepsake-edit="${escapeHtml(item.id)}">编辑</button><button type="button" class="danger" data-keepsake-delete="${escapeHtml(item.id)}">删除</button></div></article>`).join(""):empty("还没有数字留存的小物。");
}
async function editKeepsake(id){
  const item=(state.keepsakes||[]).find(value=>value.id===id);if(!item)return;
  resetKeepsakeEditor();const serial=keepsakeEditor.segmentSerial;
  activeKeepsakeId="";activeKeepsakeView="presentation";renderKeepsakes();$("#keepsake-workspace").hidden=false;$("#keepsake-editor-eyebrow").textContent="编辑留存";$("#keepsake-editor-title").textContent=item.title;$("#keepsake-id").value=item.id;$("#keepsake-title").value=item.title;$("#keepsake-category").value=item.category||"其他";resetOccurrenceInput($("#keepsake-datetime"),item);$("#keepsake-tags").value=(item.tags||[]).join(" ");$("#keepsake-note").value=item.note||"";$("#keepsake-edge-expansion").value=String(item.edgeExpansion??8);$("#keepsake-edge-output").value=String(item.edgeExpansion??8);$("#keepsake-save").textContent="保存修改";$("#keepsake-cancel-edit").hidden=false;$("#keepsake-segment-status").textContent="正在载入编辑图与蒙版…";
  try{const original=await request(`/api/keepsakes/${encodeURIComponent(id)}/original`),media=keepsakeMediaSources(item,"edit"),[editImage,alphaMask]=await Promise.all([apiClient.readBlob(media.imagePath),apiClient.readBlob(media.alphaMaskPath)]),[dataUrl,cutoutUrl]=await Promise.all([dataUrlFromBlob(editImage),dataUrlFromBlob(alphaMask)]);if(serial!==keepsakeEditor.segmentSerial)return;if(!await prepareKeepsakeImage({dataUrl,cutoutUrl,auto:false,serial}))return;keepsakeEditor.originalPath=original.originalPath;keepsakeEditor.cutoutPath=media.alphaMaskPath;$("#keepsake-segment-status").textContent="编辑图与蒙版已载入，可涂抹修正或重新识别。";$("#keepsake-workspace").scrollIntoView({behavior:"smooth",block:"start"})}catch(error){if(serial===keepsakeEditor.segmentSerial)$("#keepsake-segment-status").textContent=error.message}
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
function renderQuoteSky(advance=false){const sky=$("#quote-sky-content"),previousIds=new Set([...sky.querySelectorAll(".quote-bubble")].map(item=>item.dataset.quoteId));if(advance)quoteSkyIndex+=1;const items=rotatingQuotes();if(advance&&state.quotes.length>items.length&&items.every(item=>previousIds.has(item.id))){const alternate=state.quotes.find(item=>!previousIds.has(item.id));if(alternate)items[items.length-1]=alternate}sky.innerHTML=items.length?items.map(x=>{const visibleLines=3+Math.floor(Math.random()*3);return `<article class="quote-bubble" data-quote-id="${x.id}" data-visible-lines="${visibleLines}" style="--quote-content-max-height:${(visibleLines*1.72).toFixed(2)}em"><p><span class="quote-scroll-track">“<span class="quote-content">${escapeHtml(x.content)}</span>”</span></p>${quoteTagsMarkup(x.tags)}<small>— ${escapeHtml(x.source)}</small></article>`}).join(""):`<div class="empty quote-sky-empty">收藏至少一条善言后，它们会在这里随机浮现。</div>`;items.forEach(item=>markCommentTarget(sky.querySelector(`[data-quote-id="${CSS.escape(item.id)}"] .quote-content`),commentRootKey("quote",item.id),"content"));applyCommentAnchors(sky);requestAnimationFrame(setupQuoteBubbleScroll)}
function syncQuoteOverflow(){
  $$(".quote-entry").forEach(entry=>{
    const viewport=entry.querySelector(".quote-content-viewport"),button=entry.querySelector("[data-quote-expand]");if(!viewport||!button)return;
    const wasExpanded=viewport.classList.contains("expanded");viewport.classList.remove("expanded");
    const overflows=viewport.scrollHeight>viewport.clientHeight+1;
    viewport.classList.toggle("expanded",wasExpanded&&overflows);button.hidden=!overflows;button.textContent=wasExpanded&&overflows?"收起":"展开";button.setAttribute("aria-expanded",String(wasExpanded&&overflows));
  });
}
function renderQuotes(){
  const dateOf=eventDate,items=[...state.quotes].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a))),timeline=$("#quote-timeline");
  renderQuoteSky();
  timeline.innerHTML=items.length?items.map((item,index)=>`<article class="quote-entry" data-quote-id="${item.id}">${index===0||dateOf(item)!==dateOf(items[index-1])?`<div class="quote-date">${escapeHtml(dateOf(item))}</div>`:""}<header class="quote-entry-meta"><cite title="${escapeHtml(item.source)}">${escapeHtml(item.source)}</cite><span class="quote-entry-tools"><time>${formatTime(eventTimestamp(item))}</time><button class="subtle-action" type="button" data-quote-edit="${item.id}">编辑</button><button class="subtle-action danger" type="button" data-quote-delete="${item.id}">删除</button></span></header><div class="quote-entry-card card"><blockquote class="quote-content-viewport">${escapeHtml(item.content)}</blockquote><button class="quote-expand" type="button" data-quote-expand aria-expanded="false" hidden>展开</button>${quoteTagsMarkup(item.tags)}</div></article>`).join(""):"";
  items.forEach(item=>markCommentTarget(timeline.querySelector(`[data-quote-id="${CSS.escape(item.id)}"] blockquote`),commentRootKey("quote",item.id),"content"));
  applyCommentAnchors(timeline);requestAnimationFrame(syncQuoteOverflow);clearInterval(quoteTimer);
  if(state.quotes.length>3)quoteTimer=setInterval(()=>{if($("#view-quotes").classList.contains("active")&&!document.hidden&&!$("#quote-sky").matches(":hover"))renderQuoteSky(true)},24000);
}
function resetQuoteForm(){const form=$("#quote-form");form.reset();$("#quote-id").value="";resetOccurrenceInput($("#quote-datetime"));$("#quote-submit").textContent="收藏";$("#quote-cancel").hidden=true;$("#quote-status").textContent=""}
function editQuote(id){const quote=state.quotes.find(item=>item.id===id);if(!quote)return;$("#quote-id").value=id;$("#quote-source").value=quote.source;$("#quote-content").value=quote.content;$("#quote-tags").value=(quote.tags||[]).join(" ");resetOccurrenceInput($("#quote-datetime"),quote);$("#quote-submit").textContent="保存修改";$("#quote-cancel").hidden=false;$("#quote-status").textContent="正在编辑已有善言";$("#quote-form").scrollIntoView({behavior:"smooth",block:"center"});$("#quote-content").focus()}
function selectionQuoteSource(rootKey){const root=commentRoot(rootKey),label=commentRootLabel(rootKey),{type}=parseCommentRootKey(rootKey);const title=type==="book"?root?.title:type==="journal"?root?.title||root?.content:type==="quote"?root?.source:type==="chat"?root?.message:root?.content;return `${label}${title?` · ${plainPreview(title).slice(0,60)}`:""}`}
function closeSelectionQuoteModal(){const modal=$("#selection-quote-modal");modal.hidden=true;$("#selection-quote-form").reset();$("#selection-quote-status").textContent=""}
function openSelectionQuoteModal(selection){const label=commentRootLabel(selection.rootKey);$("#selection-quote-content").value=selection.quote;$("#selection-quote-source").value=selectionQuoteSource(selection.rootKey);$("#selection-quote-tags").value=label;resetOccurrenceInput($("#selection-quote-datetime"));$("#selection-quote-status").textContent="";$("#selection-quote-modal").hidden=false;pendingSelection=null;window.getSelection()?.removeAllRanges();$("#selection-quote-content").focus()}
function llmProfile(scene="thoughtAnswer"){const tier=llmSettings.scenarios?.[scene]||"high",profile=llmSettings.profiles?.[tier]||defaultLlmProfiles[tier]||defaultLlmProfiles.high;return{tier,...profile}}
function modelName(scene="thoughtAnswer"){const profile=llmProfile(scene);return `${profile.model==="deepseek-v4-pro"?"DeepSeek Pro":"DeepSeek Flash"} · ${profile.tier[0].toUpperCase()+profile.tier.slice(1)}`}
function settingsPayload(){return{profiles:Object.fromEntries(llmTiers.map(tier=>[tier,{model:$(`[data-profile-model="${tier}"]`).value,effort:$(`[data-profile-effort="${tier}"]`).value}])),scenarios:Object.fromEntries($$("[data-ai-scenario]").map(select=>[select.dataset.aiScenario,select.value])),assistantName:$("#assistant-name").value,responseStyles:Object.fromEntries($$("[data-response-style]").map(select=>[select.dataset.responseStyle,select.value])),automaticAnswers:{thoughtAnswer:$("#automatic-thought-answer").checked},apiKey:$("#llm-api-key").value}}
function renderSettings(){const badge=$("#llm-key-state"),hint=$("#llm-key-hint");if(!badge)return;llmSettings.profiles={...structuredClone(defaultLlmProfiles),...(llmSettings.profiles||{})};llmSettings.scenarios={...defaultLlmScenarios,...(llmSettings.scenarios||{})};llmSettings.automaticAnswers={thoughtAnswer:llmSettings.automaticAnswers?.thoughtAnswer===true};llmSettings.responseStyles=Object.fromEntries(responseStyleScenes.map(scene=>[scene,llmSettings.responseStyles?.[scene]||"standard"]));$("#automatic-thought-answer").checked=llmSettings.automaticAnswers.thoughtAnswer;$("#assistant-name").value=llmSettings.assistantName||"神鸡";for(const tier of llmTiers){$(`[data-profile-model="${tier}"]`).value=llmSettings.profiles[tier].model;$(`[data-profile-effort="${tier}"]`).value=llmSettings.profiles[tier].effort}$$("[data-ai-scenario]").forEach(select=>{if(!select.options.length)select.innerHTML=llmTiers.map(tier=>`<option value="${tier}">${tier[0].toUpperCase()+tier.slice(1)}</option>`).join("");select.value=llmSettings.scenarios[select.dataset.aiScenario]});$$("[data-response-style]").forEach(select=>{if(!select.options.length)select.innerHTML=responseStyleOptions.map(([value,label])=>`<option value="${value}">${label}</option>`).join("");select.value=llmSettings.responseStyles[select.dataset.responseStyle]||"standard"});badge.textContent=llmSettings.hasApiKey?"密钥已配置":"未配置密钥";badge.classList.toggle("ready",llmSettings.hasApiKey);hint.textContent=llmSettings.hasApiKey?`${llmSettings.keyHint} · 留空保留原密钥`:"仅保存在本机";const chat=llmProfile("chat");$("#chat-model-label").textContent=`${modelName("chat")} · ${chat.effort==="none"?"不思考":chat.effort.toUpperCase()}`}
function renderLocalTestSettings(){const panel=$("#local-test-settings"),mineSummary=$("#mine-settings-summary");if(!panel)return;panel.hidden=!localTestConfig?.enabled;if(panel.hidden){if(mineSummary)mineSummary.textContent="配置本地测试数据、助手称呼与模型档位";return}const modeLabel=localTestConfig.mode==="simulation"?"使用模拟":"冷启测试";if(mineSummary)mineSummary.textContent=`本地测试：使用模拟 / 冷启测试 · 当前${modeLabel}`;$$("[data-local-test-mode]").forEach(button=>{const active=button.dataset.localTestMode===localTestConfig.mode;button.classList.toggle("active",active);button.setAttribute("aria-pressed",String(active));button.disabled=button.dataset.localTestMode==="simulation"&&!localTestConfig.upstreamConfigured});$("#local-test-badge").textContent=modeLabel;$("#local-test-summary").textContent=localTestConfig.mode==="simulation"?`${localTestConfig.sourceUser?.username||"线上主账户"} · ${localTestConfig.recordCount||0} 条记录 · ${localTestConfig.snapshotAt?formatDate(localTestConfig.snapshotAt):"尚未拉取"}`:"空账户工作区；每次切换都会重新清空。"}
const shiftLocalDateKey=(dateKey,days)=>{const [year,month,day]=String(dateKey).split("-").map(Number),date=new Date(Date.UTC(year,month-1,day+days));return date.toISOString().slice(0,10)};
const compactNumber=value=>new Intl.NumberFormat("zh-CN",{notation:"compact",maximumFractionDigits:1}).format(Number(value)||0);
const formatCny=value=>{const number=Number(value)||0,absolute=Math.abs(number),digits=absolute===0?2:absolute>=100?0:absolute>=10?1:absolute>=1?2:absolute>=.1?3:absolute>=.01?4:6;return `${number<0?"-":""}¥${absolute.toFixed(digits)}`};
const formatDuration=value=>{const milliseconds=Number(value)||0;return milliseconds>=60000?`${(milliseconds/60000).toFixed(1)} 分钟`:milliseconds>=1000?`${(milliseconds/1000).toFixed(1)} 秒`:`${Math.round(milliseconds)} ms`};
const shortDate=value=>{const [,month,day]=String(value).split("-");return `${Number(month)}/${Number(day)}`};
const sceneLabels={thoughtPrompt:"思考引子",thoughtDraft:"思考草稿",thoughtAnswer:"思考回答",followUpAnswer:"追问回答",chat:"长期对话",diaryLead:"日记引子",diaryStructure:"日记结构",diaryTopic:"日记话题",diaryReflection:"日记回望",annotationShenji:"批注神鸡",analysis:"认知复盘",bookRecognition:"书目识别",healthRecognition:"健康识别",contentImageUnderstanding:"内容图片理解",lite:"连接测试",mid:"连接测试",high:"连接测试",ultra:"连接测试"};
function chartFrame(daily,series,{ariaLabel,valueLabel=compactNumber}={}){
  const width=760,height=260,pad={left:54,right:18,top:16,bottom:38},plotWidth=width-pad.left-pad.right,plotHeight=height-pad.top-pad.bottom,max=Math.max(1,...series.flatMap(item=>item.values)),x=index=>pad.left+(daily.length<=1?plotWidth/2:index*plotWidth/(daily.length-1)),y=value=>pad.top+plotHeight-(Number(value)||0)/max*plotHeight;
  const grid=[0,.5,1].map(ratio=>{const py=pad.top+plotHeight*(1-ratio);return `<line x1="${pad.left}" y1="${py}" x2="${width-pad.right}" y2="${py}"></line><text x="${pad.left-9}" y="${py+4}" text-anchor="end">${escapeHtml(valueLabel(max*ratio))}</text>`}).join("");
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
  const {records,ai}=data,summary=ai.summary,cnyPerUsd=Math.max(.01,Number(ai.pricing?.cnyPerUsd)||7.2),costCny=value=>(Number(value)||0)*cnyPerUsd;
  $("#record-total").innerHTML=`<strong>${records.total}</strong><span>累计条目</span>`;
  $("#record-stat-sections").innerHTML=(records.groups||[]).map(group=>`<section class="record-stat-section"><header><h3>${escapeHtml(group.label)}</h3><span>${group.total} 项</span></header><div class="record-module-list">${group.modules.map(module=>`<article><div class="record-module-title"><b>${escapeHtml(module.label)}</b><strong>${module.total}</strong></div><dl>${module.items.map(item=>`<div><dt>${escapeHtml(item.label)}</dt><dd>${item.count}</dd></div>`).join("")}</dl></article>`).join("")}</div></section>`).join("");
  const totalTokens=summary.tokens.input+summary.tokens.output,cacheRate=summary.tokens.input?summary.tokens.cacheHit/summary.tokens.input*100:0,averageCost=summary.calls?summary.costsUsd.total/summary.calls:0,knownStatuses=(summary.successfulCalls||0)+(summary.failedCalls||0),successRate=knownStatuses?(summary.successfulCalls||0)/knownStatuses*100:null,averageDuration=summary.durationKnownCalls?(summary.durationMs||0)/summary.durationKnownCalls:0,vision=ai.modalities?.find(item=>item.modality==="vision")||{calls:summary.visionCalls||0,imageCount:summary.imageCount||0,costsUsd:{total:0}};
  $("#ai-kpis").innerHTML=[
    ["总费用",formatCny(costCny(summary.costsUsd.total)),"按官方单价折算"],
    ["调用次数",compactNumber(summary.calls),"次"],
    ["成功率",successRate==null?"未知":`${successRate.toFixed(successRate>=10?0:1)}%`,`${summary.failedCalls||0} 次失败 · ${summary.unknownStatusCalls||0} 次历史未知`],
    ["图片理解",compactNumber(vision.calls),`${compactNumber(vision.imageCount)} 张 · ${formatCny(costCny(vision.costsUsd.total))}`],
    ["总 Token",compactNumber(totalTokens),"输入与输出"],
    ["缓存命中率",`${cacheRate.toFixed(cacheRate>=10?0:1)}%`,`${compactNumber(summary.tokens.cacheHit)} Token`],
    ["平均费用",formatCny(costCny(averageCost)),"每次实际请求"],
    ["平均响应",summary.durationKnownCalls?formatDuration(averageDuration):"未知",`${summary.usageUnknownCalls||0} 次用量未知`]
  ].map(([label,value,note])=>`<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
  $("#ai-tracking-since").textContent=`自 ${new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(ai.trackingStartedAt))} 开始统计`;
  const modelColors={"deepseek-flash":"#4f8d78","deepseek-v4-pro":"#a65f4b"};
  const callSeries=ai.models.map(model=>({label:model.label,color:modelColors[model.model],values:ai.daily.map(day=>day.models[model.model]?.calls||0)}));
  callSeries.push({label:"其中图片理解",color:"#c18c3f",values:ai.daily.map(day=>day.visionCalls||0)});
  $("#ai-calls-chart").innerHTML=chartFrame(ai.daily,callSeries,{ariaLabel:"各 DeepSeek 模型与图片理解每日调用次数",valueLabel:value=>String(Math.round(value))});
  $("#ai-token-chart").innerHTML=stackedTokenChart(ai.daily);
  $("#ai-modality-summary").innerHTML=`<table><thead><tr><th>输入方式</th><th>调用</th><th>成功</th><th>图片</th><th>总 Token</th><th>费用</th><th>平均响应</th></tr></thead><tbody>${(ai.modalities||[]).map(item=>`<tr><td>${escapeHtml(item.label)}</td><td>${item.calls}</td><td>${item.successfulCalls||0}</td><td>${item.imageCount||0}</td><td>${compactNumber((item.tokens?.input||0)+(item.tokens?.output||0))}</td><td>${formatCny(costCny(item.costsUsd?.total))}</td><td>${item.durationKnownCalls?formatDuration((item.durationMs||0)/item.durationKnownCalls):"未知"}</td></tr>`).join("")}</tbody></table>`;
  const costSeries=[["input","输入未命中","#5c7891"],["cacheHit","缓存命中","#4f8d78"],["reasoning","推理","#c18c3f"],["output","回答","#a65f4b"]];
  $("#ai-cost-charts").innerHTML=ai.models.map(model=>`<section><h4>${escapeHtml(model.label)} <span>${model.calls} 次 · ${formatCny(costCny(model.costsUsd.total))}</span></h4>${chartFrame(ai.daily,costSeries.map(([key,label,color])=>({label,color,values:ai.daily.map(day=>costCny(day.models[model.model]?.costsUsd[key]))})),{ariaLabel:`${model.label} 每日费用构成`,valueLabel:formatCny})}</section>`).join("");
  const maxScene=Math.max(1,...ai.scenes.map(item=>item.calls));
  $("#ai-scenario-bars").innerHTML=ai.scenes.length?ai.scenes.map(item=>`<div><span>${escapeHtml(sceneLabels[item.scene]||item.scene)}</span><i><b style="width:${item.calls/maxScene*100}%"></b></i><strong>${item.calls}</strong></div>`).join(""):`<div class="analytics-empty">这段时间还没有 AI 调用。</div>`;
  $("#ai-model-summary").innerHTML=`<table><thead><tr><th>模型</th><th>调用</th><th>图片</th><th>失败</th><th>输入</th><th>输出</th><th>费用</th></tr></thead><tbody>${ai.models.map(model=>`<tr><td>${escapeHtml(model.label)}</td><td>${model.calls}</td><td>${model.visionCalls||0}</td><td>${model.failedCalls||0}</td><td>${compactNumber(model.tokens.input)}</td><td>${compactNumber(model.tokens.output)}</td><td>${formatCny(costCny(model.costsUsd.total))}</td></tr>`).join("")}</tbody></table>`;
  const pricing=ai.pricing;
  $("#ai-pricing").innerHTML=`<p>${escapeHtml(pricing.estimateNote)} 价格核对于 ${escapeHtml(pricing.checkedAt)}，页面统一以人民币 / 百万 Token 展示，换算系数为 ${cnyPerUsd.toFixed(2)}。<a href="${escapeHtml(pricing.source)}" target="_blank" rel="noopener noreferrer">DeepSeek 官方价格</a></p><div class="pricing-table-wrap"><table><thead><tr><th>模型</th><th>时段</th><th>缓存命中</th><th>输入未命中</th><th>输出</th></tr></thead><tbody>${Object.entries(pricing.models).flatMap(([,model])=>[["offPeak","谷时"],["peak","峰时"]].map(([key,label])=>`<tr><td>${escapeHtml(model.label)}</td><td>${label}</td><td>${formatCny(costCny(model[key].cacheHit))}</td><td>${formatCny(costCny(model[key].cacheMiss))}</td><td>${formatCny(costCny(model[key].output))}</td></tr>`)).join("")}</tbody></table></div>`;
}
function setStatisticsRange(days=7){
  $("#statistics-to").value=currentLocalDate;$("#statistics-from").value=shiftLocalDateKey(currentLocalDate,1-days);
  $$("[data-statistics-days]").forEach(button=>button.classList.toggle("active",Number(button.dataset.statisticsDays)===days));
}
async function loadStatistics(){
  const from=$("#statistics-from").value,to=$("#statistics-to").value;if(!from||!to)setStatisticsRange(7);
  const serial=++statisticsRequestSerial,owner=currentUser?.id,session=sessionSerial,status=$("#statistics-status"),button=$("#statistics-range-form button[type='submit']");
  button.disabled=true;status.textContent="正在汇总记录与 AI 用量…";
  try{const data=await request(`/api/statistics?from=${encodeURIComponent($("#statistics-from").value)}&to=${encodeURIComponent($("#statistics-to").value)}`);if(serial!==statisticsRequestSerial||owner!==currentUser?.id||session!==sessionSerial)return;renderStatistics(data);status.textContent=""}
  catch(error){if(serial===statisticsRequestSerial)status.textContent=error.message}
  finally{if(serial===statisticsRequestSerial)button.disabled=false}
}
function currentAiCostModel(scene){
  const tier=llmSettings.scenarios?.[scene]||defaultLlmScenarios[scene]||"high",profile=llmSettings.profiles?.[tier]||defaultLlmProfiles[tier];
  return{tier,model:profile.model,effort:profile.effort,label:`${profile.model==="deepseek-v4-pro"?"Pro":"Flash"} · ${tier[0].toUpperCase()+tier.slice(1)}`};
}
function aiCostScenarioEstimate(row,model=row.model){
  const pricing=aiCostStatistics?.ai?.pricing,rates=pricing?.models?.[model]?.[row.pricingPeriod];
  if(!rates)return{total:0,input:0,output:0,perCall:0};
  const calls=row.enabled?Math.max(0,Number(row.callsPerMonth)||0):0,input=Math.max(0,Number(row.avgInputTokens)||0),hit=input*Math.max(0,Math.min(100,Number(row.cacheHitPct)||0))/100,miss=input-hit,output=Math.max(0,Number(row.avgReasoningTokens)||0)+Math.max(0,Number(row.avgAnswerTokens)||0),exchange=Math.max(.01,Number(aiCostPlan?.cnyPerUsd)||7.2),unit=Number(pricing.unitTokens)||1e6;
  const inputCost=(hit*rates.cacheHit+miss*rates.cacheMiss)/unit*exchange,outputCost=output*rates.output/unit*exchange,perCall=inputCost+outputCost;
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
  const rows=aiCostPlan.scenarios.map(row=>({row,estimate:aiCostScenarioEstimate(row)})),base=rows.reduce((sum,item)=>sum+item.estimate.total,0),reserve=base*(Number(aiCostPlan.contingencyPct)||0)/100,projected=base+reserve,budget=Number(aiCostPlan.monthlyBudgetCny)||0,observedUsd=Number(aiCostStatistics.ai?.summary?.costsUsd?.total)||0,observed=observedUsd*(Number(aiCostPlan.cnyPerUsd)||7.2),difference=budget-projected;
  for(const item of rows){const root=document.querySelector(`[data-ai-cost-row="${CSS.escape(item.row.scene)}"]`),cell=root?.querySelector("[data-ai-cost-row-total]");root?.classList.toggle("disabled",!item.row.enabled);if(cell)cell.textContent=formatCny(item.estimate.total)}
  $("#ai-cost-kpis").innerHTML=[
    ["预计月成本",formatCny(projected),`基础 ${formatCny(base)} + 预留 ${formatCny(reserve)}`,budget&&projected>budget?"negative":"positive"],
    ["近 30 天实测",formatCny(observed),`${aiCostStatistics.ai?.summary?.calls||0} 次实际调用`],
    ["预算差额",budget?formatCny(difference):"未设预算",budget?`${difference>=0?"剩余":"超出"} ${formatCny(Math.abs(difference))}`:"填写月度预算",difference>=0?"positive":"negative"],
    ["预计年成本",formatCny(projected*12),"月度方案 × 12"]
  ].map(([label,value,note,tone])=>`<article class="${tone||""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`).join("");
  const recommendations=aiCostRecommendations(rows,projected,budget);
  $("#ai-cost-recommendations").innerHTML=recommendations.map(([title,copy,tag],index)=>`<li><b>${String(index+1).padStart(2,"0")}</b><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(copy)}</p></div><span>${escapeHtml(tag)}</span></li>`).join("")+`<li class="settings-link"><button type="button" data-view="settings">打开模型设置</button><p>模拟方案不会自动修改真实模型配置。</p></li>`;
  const observedScenes=[...(aiCostStatistics.ai?.scenes||[])].sort((a,b)=>(b.costsUsd?.total||0)-(a.costsUsd?.total||0)).slice(0,5);
  const pricing=aiCostStatistics.ai.pricing,cny=Number(aiCostPlan.cnyPerUsd)||7.2,p90=(Number(aiCostStatistics.ai?.calibration?.p90CostCny)||0)*cny/(Number(pricing.cnyPerUsd)||7.2);
  $("#ai-cost-observed").innerHTML=`<dl><div><dt>调用</dt><dd>${aiCostStatistics.ai?.summary?.calls||0} 次</dd></div><div><dt>平均输入</dt><dd>${compactNumber(aiCostStatistics.ai?.calibration?.averageInputTokens||0)} Token</dd></div><div><dt>P90 单次</dt><dd>${formatCny(p90)}</dd></div><div><dt>模拟 / 实测</dt><dd>${observed?`${(projected/observed).toFixed(1)}×`:"—"}</dd></div></dl><div class="ai-cost-observed-scenes">${observedScenes.length?observedScenes.map(item=>`<div><span>${escapeHtml(sceneLabels[item.scene]||item.scene)}</span><strong>${item.calls} 次</strong><small>${formatCny((Number(item.costsUsd?.total)||0)*cny)}</small></div>`).join(""):"<p>近 30 天暂无可用样本。</p>"}</div>`;
  $("#ai-cost-pricing").innerHTML=`<div class="pricing-table-wrap"><table><thead><tr><th>模型</th><th>时段</th><th>缓存命中</th><th>输入未命中</th><th>推理/回答</th></tr></thead><tbody>${Object.entries(pricing.models).flatMap(([,model])=>[["offPeak","谷时"],["peak","峰值"]].map(([period,label])=>`<tr><td>${escapeHtml(model.label)}</td><td>${label}</td><td>${formatCny(model[period].cacheHit*cny)}</td><td>${formatCny(model[period].cacheMiss*cny)}</td><td>${formatCny(model[period].output*cny)}</td></tr>`)).join("")}</tbody></table></div><p>单位均为人民币 / 百万 Token；汇率 ${cny.toFixed(2)} 元/美元。</p>`;
  $("#ai-cost-plan-state").textContent=budget&&projected>budget?"超过预算":"预算内";
  $("#ai-cost-plan-state").classList.toggle("over",Boolean(budget&&projected>budget));
  $("#ai-cost-updated-at").textContent=aiCostPlan.updatedAt?`参数更新于 ${formatDate(aiCostPlan.updatedAt)}`:"尚未保存";
}
async function loadAiCostPlan(){
  const serial=++aiCostRequestSerial,owner=currentUser?.id,session=sessionSerial,from=shiftLocalDateKey(currentLocalDate,-29),status=$("#ai-cost-status");status.textContent="正在读取成本方案与近 30 天账本…";
  try{
    const [plan,statistics]=await Promise.all([request("/api/ai-cost-plan"),request(`/api/statistics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(currentLocalDate)}`)]);
    if(serial!==aiCostRequestSerial||owner!==currentUser?.id||session!==sessionSerial)return;
    aiCostPlan=plan;aiCostStatistics=statistics;renderAiCostPlan();status.textContent="";
  }catch(error){if(serial===aiCostRequestSerial)status.textContent=error.message}
}
const architectureStages=[
  {
    name:"内部验证期",scale:"MAU ≤ 20",peak:"< 2 QPS",availability:"人工保障",cost:"约 ¥200–520/月",state:"当前运行",
    note:"全部能力集中在一台 ECS；请求经过 Nginx 后直接进入 Node 单体。",
    mainPath:[["用户","浏览器 / PWA","active"],["Nginx","HTTPS + 静态文件","active"],["Node 主服务器","2 vCPU / 1.57 GiB 可见","focus"]],
    supports:[
      ["后台任务",[["进程内任务执行器","AI 并发 ≤ 20","active"],["DeepSeek / 图片服务","外部供应商","active"]]],
      ["数据",[["JSON + ESSD","40 GB","active"],["私有 OSS","附件按量使用","active"]]],
      ["监控恢复",[["云监控 + 日志","同机采集","active"],["每日备份","OSS + 恢复演练","active"]]]
    ],
    layers:[
      ["前端","Nginx 同机","静态 HTML/CSS/JS 与 API 同一台机器","用户少，独立 CDN 收益有限。"],
      ["防火墙","安全组 + Nginx","只开放 80/443；SSH 限定来源","先保证最小公网暴露。"],
      ["流量分发","暂不需要 ALB","DNS 直接指向主服务器","只有一台服务器，无处可分发。"],
      ["主服务器","Node 单体 · 2 vCPU / 1.57 GiB 可见","认证、API、AI 调度、静态文件","使用 2026-09-27 生产只读观测值。"],
      ["后台任务","同进程任务执行器","持久任务 + 内存调度、限并发、失败可见","任务少时先保证正确性。"],
      ["数据","JSON + 40 GB ESSD","OSS 存图片和附件","整文件写入是主要扩容瓶颈。"],
      ["监控","云监控 + 本机日志","服务、磁盘、备份和 AI 费用告警","不需要单独购买监控服务器。"],
      ["备份灾备","每日快照 + OSS 备份","定期隔离恢复","备份成功不等于可以恢复。"]
    ],
    enter:["先完成正确性","备份恢复与跨账户隔离必须稳定。"],defer:["不拆微服务","暂不上 RDS、Redis、消息队列和 Kubernetes。"]
  },
  {
    name:"MVP 内部推送",scale:"DAU 100 · MAU 400",peak:"5–10 QPS",availability:"99.5% 内部目标",cost:"约 ¥1.7k–4.5k/月",state:"规划",
    note:"前端独立发布，API 与 Worker 分机；PostgreSQL 接管正式数据和任务。",
    mainPath:[["用户","浏览器 / PWA","active"],["CDN","静态文件","active"],["WAF / Nginx","基础防护","active"],["API 主服务器","1 × 2C4G","focus"]],
    supports:[
      ["后台任务",[["PG 任务表","租约 / 重试","active"],["Worker 服务器","1 × 2C4G","focus"],["AI 供应商","模型 / 图片","active"]]],
      ["数据",[["RDS PostgreSQL","2C4G · 100 GB","focus"],["私有 OSS","100–500 GB","active"]]],
      ["监控恢复",[["SLS + 云监控","集中日志","active"],["PITR + OSS 版本","月度恢复","active"]]]
    ],
    layers:[
      ["前端","OSS + CDN","静态前端独立构建发布","前端更新不再重启 API。"],
      ["防火墙","WAF 基础规则","安全组与 VPC 白名单","数据库和 Worker 不暴露公网。"],
      ["流量分发","Nginx 单入口","暂不购买多实例 ALB","API 仍只有一个实例。"],
      ["主服务器","API ECS · 1 × 2C4G","模块化单体与 /api/v1","只处理快速请求。"],
      ["后台任务","Worker ECS · 1 × 2C4G","AI、图片、索引和定时任务","慢任务不占住 API。"],
      ["数据","RDS PG · 2C4G / 100GB","事务、版本与账户隔离","JSON 只保留为迁移恢复点。"],
      ["监控","SLS + 云监控","汇总 API、Worker、RDS 与任务终态","使用托管服务，不自建监控机。"],
      ["备份灾备","RDS PITR + OSS 版本","月度恢复演练","目标是可恢复，不是多区域。"]
    ],
    enter:["先迁移数据底座","OpenAPI、幂等和 3 份真实快照 dry-run 通过。"],defer:["不做多实例","暂不上读副本、分片和跨区域。"]
  },
  {
    name:"快速上升期",scale:"DAU 1 万 · MAU 4 万",peak:"20–80 QPS",availability:"99.9% 设计目标",cost:"约 ¥62k–150k/月",state:"规划",
    note:"ALB 把请求分给无状态 API 池；消息队列把慢任务交给弹性 Worker 池。",
    mainPath:[["用户","浏览器 / PWA","active"],["CDN","全国静态节点","active"],["WAF","入口防火墙","active"],["ALB","健康分发","focus"],["API 服务器池","2–4 × 4C8G","focus"]],
    supports:[
      ["后台任务",[["MNS / RocketMQ","削峰 / 死信","active"],["Worker 池","4–12 × 4C8G","focus"],["AI 网关","配额 / 重试","active"]]],
      ["数据",[["RDS PG HA","8C32G · 500 GB","focus"],["Redis HA","2–4 GB","active"],["OSS + CDN","2 TB / 3–10 TB流量","active"]]],
      ["监控恢复",[["SLS + ARMS","链路 / SLO / 成本","active"],["PITR + 跨区备份","月度自动恢复","active"]]]
    ],
    layers:[
      ["前端","CDN 全国节点","静态资源、附件缓存与版本发布","降低源站带宽和访问延迟。"],
      ["防火墙","WAF + 安全组","限速、Bot 和常见 Web 攻击","公网只到 ALB，内部走 VPC。"],
      ["流量分发","ALB","TLS、健康检查、轮询分发","任一 API 故障会被自动绕开。"],
      ["主服务器","API 池 · 2–4 × 4C8G","自动伸缩上限约 6 台","实例无状态，配置和会话共享。"],
      ["后台任务","Worker 池 · 4–12 × 4C8G","消息队列、死信、优先级","按排队时长和供应商配额扩缩。"],
      ["数据","RDS HA + Redis + OSS","8C32G / 500GB；Redis 2–4GB","Redis 只存缓存、限流和短租约。"],
      ["监控","SLS + ARMS/APM","黄金信号、队列、Token 与成本","监控不进入业务主路径。"],
      ["备份灾备","PITR + 跨区备份","月度自动、季度人工恢复","先实现单区域高可靠。"]
    ],
    enter:["单机指标触顶","CPU >70% 或事件循环 P95 >100ms，并通过峰值 5 倍压测。"],defer:["不做跨区双写","暂不分片，也不引入独立向量库。"]
  },
  {
    name:"影响力期",scale:"DAU 2.5 万 · MAU 10 万",peak:"80–200 QPS",availability:"99.9% · RPO 5m",cost:"约 ¥150k–380k/月",state:"规划",
    note:"多可用区 API 和 Worker 自动扩缩；数据库、缓存、队列与监控均消除单点。",
    mainPath:[["用户","浏览器 / PWA","active"],["CDN + WAF","边缘缓存与防护","active"],["ALB 标准版","多可用区","focus"],["API 弹性池","4–10 × 8C16G","focus"]],
    supports:[
      ["后台任务",[["托管 MQ","优先级 / 背压","active"],["Worker 弹性池","8–24 × 8C16G","focus"],["AI 网关","熔断 / 降级","active"]]],
      ["数据",[["PG 集群","16C64G · 1 TB","focus"],["只读副本","读瓶颈后启用","active"],["Redis 集群","8–16 GB","active"]]],
      ["监控恢复",[["SLS + ARMS + 大盘","SLO / 容量预测","active"],["跨区备份","RTO 60m 设计目标","active"]]]
    ],
    layers:[
      ["前端","CDN + WAF","HTTPS、静态缓存与边缘防护","入口承受突发流量。"],
      ["防火墙","WAF + 云防火墙","公网区、应用区、数据区隔离","统一安全策略和出口控制。"],
      ["流量分发","ALB 标准版","多可用区与 LCU 弹性","按健康与权重分发。"],
      ["主服务器","API 池 · 4–10 × 8C16G","跨可用区自动扩缩","滚动发布时至少保留 2 个实例。"],
      ["后台任务","Worker 池 · 8–24 × 8C16G","AI、图片、索引独立队列","防止一种任务拖垮全部任务。"],
      ["数据","PG 16C64G / 1TB","读副本 + Redis 8–16GB","读副本只在读 CPU 成瓶颈后启用。"],
      ["监控","SLS + ARMS + Grafana","SLO、追踪、成本与容量预测","可有独立大盘，无需自建监控主机。"],
      ["备份灾备","跨区备份 + 自动恢复验证","RPO≤5m、RTO≤60m 设计目标","实测达标后才能承诺。"]
    ],
    enter:["共享资源触顶","连接池 >70% 或最老任务等待 >30 秒。"],defer:["不默认多活","无容量证据时不拆微服务、不跨区写入。"]
  },
  {
    name:"市场占有期",scale:"DAU 4.6 万 · MAU 18.4 万",peak:"150–400 QPS",availability:"99.95% 内部目标",cost:"约 ¥290k–730k/月",state:"规划",
    note:"GTM 在主区域和温备区域之间切换；区域内仍是相同的 API、Worker、数据与监控闭环。",
    mainPath:[["用户","全国访问","active"],["CDN / ESA","边缘加速","active"],["GTM + WAF","区域切换与防护","focus"],["区域 ALB","区内分发","active"],["主区 API 池","6–16 × 8C16G","focus"]],
    supports:[
      ["后台任务",[["区域队列","背压 / 配额","active"],["Worker 池","12–40 × 8C16G","focus"],["AI 网关","供应商路由 / 降级","active"]]],
      ["数据",[["PG 集群","32C128G · 2 TB","focus"],["1–2 读副本","分析 / 导出","active"],["异地温备","DTS / PITR / OSS CRR","active"]]],
      ["监控恢复",[["跨区监控","独立告警通道","active"],["季度切换演练","切换 / 回切 / 校验","active"]]]
    ],
    layers:[
      ["前端","CDN / ESA 全国边缘","静态与动态加速、防护","避免所有流量直达主区。"],
      ["防火墙","WAF + 云防火墙 + Anti-DDoS","区域入口、VPC 分段和出口控制","安全策略集中管理。"],
      ["流量分发","GTM → 区域 ALB","主区承载，灾备区健康待命","故障时按演练流程切区。"],
      ["主服务器","主区 API · 6–16 × 8C16G","温备区维持 30%–50% 容量","区域内无状态自动扩缩。"],
      ["后台任务","Worker · 12–40 × 8C16G","区域队列 + AI 网关","统一模型配额、熔断和成本预算。"],
      ["数据","PG 32C128G / 2TB","读副本、Redis 16–32GB、OSS CRR","单库优化后仍触顶才按账户分片。"],
      ["监控","跨区 SLS/ARMS","独立于主区的告警通道","主区故障时仍必须能告警。"],
      ["备份灾备","异地温备 PG + OSS CRR","季度切换、回切和一致性校验","默认异步复制并明确 RPO。"]
    ],
    enter:["恢复能力不足","单库接近容量或存在地域合规要求。"],defer:["不跨区双写","账户数量本身不是分片理由。"]
  }
];
const architectureTerms={
  worker:["Worker","后台工作进程","不接网页请求，专门执行 AI、图片、索引、通知和定时任务。","公司的后厨","MVP 开始持久化慢任务时"],
  pg:["PG","PostgreSQL 数据库","保存账户、记录、任务和版本；事务保证一组操作全部成功或全部失败。","正式总账","替换 JSON 数据源时"],
  cdn:["CDN","内容分发网络","把前端文件和图片缓存到离用户更近的节点，减少源站流量和等待。","全国前置仓","出现异地用户或静态流量时"],
  waf:["WAF","Web 应用防火墙","检查 HTTP 请求，拦截常见攻击、恶意扫描、Bot 和异常频率。","入口安检","公开邀请用户前"],
  alb:["ALB","应用负载均衡","检查 API 服务器健康状态，把请求分给可用实例，并绕开故障实例。","银行取号分柜台","API 增加到两台时"],
  queue:["MQ","消息队列","可靠保存待执行任务，削平高峰，并支持重试、优先级和死信。","待办传送带","任务积压或突发明显时"],
  redis:["Redis","高速临时数据服务","保存缓存、共享限流和短租约；正式数据仍必须在 PostgreSQL。","高速便签板","多 API 实例共享状态时"],
  oss:["OSS","对象存储","保存图片、附件和备份；数据库只保存对象编号、大小和引用。","文件仓库","当前阶段已经适用"],
  vpc:["VPC","云内私有网络","让数据库、Redis 和 Worker 只通过内网访问，不直接暴露公网。","园区内部道路","引入托管数据服务时"],
  monitor:["SLS / ARMS","日志与应用监控","收集延迟、流量、错误、CPU、队列、Token 和费用并触发告警。","值班室","从 Demo 就需要基础版本"],
  pitr:["PITR","时间点恢复","利用数据库日志把数据恢复到故障或误操作发生前的某个时间。","录像回放","迁移 PostgreSQL 后"],
  rpo:["RPO / RTO","恢复目标","RPO 是最多能丢多久的数据；RTO 是系统多久必须恢复。","保险赔付标准","准备对外承诺可靠性时"]
};
function renderArchitectureTerm(){
  const item=architectureTerms[architectureTerm]||architectureTerms.worker;
  $$("[data-architecture-term]").forEach(button=>button.classList.toggle("active",button.dataset.architectureTerm===architectureTerm));
  $("#architecture-term-code").textContent=item[0];$("#architecture-term-name").textContent=item[1];$("#architecture-term-description").textContent=item[2];$("#architecture-term-analogy").textContent=item[3];$("#architecture-term-timing").textContent=item[4];
}
function architectureNodeMarkup([title,detail,state]){return`<article class="${state||""}"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></article>`}
function renderArchitecture(){
  if(!$("#view-architecture"))return;
  const stage=architectureStages[architectureStage]||architectureStages[0];
  $$("[data-architecture-stage]").forEach(button=>{const active=Number(button.dataset.architectureStage)===architectureStage;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active))});
  $("#architecture-stage-cost").textContent=stage.cost;$("#architecture-stage-state").textContent=stage.state;$("#architecture-flow-note").textContent=stage.note;
  $("#architecture-kpis").innerHTML=[["阶段",stage.name,"当前产品路线"],["用户规模",stage.scale,"规划容量"],["峰值流量",stage.peak,"压测假设"],["可靠性",stage.availability,"内部目标"]].map(([label,value,note])=>`<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`).join("");
  $("#architecture-main-path").innerHTML=stage.mainPath.map((node,index)=>`${index?'<span aria-hidden="true">→</span>':""}${architectureNodeMarkup(node)}`).join("");
  $("#architecture-support-paths").innerHTML=stage.supports.map(([title,nodes])=>`<section><h4>${escapeHtml(title)}</h4><div>${nodes.map(architectureNodeMarkup).join("")}</div></section>`).join("");
  $("#architecture-layer-list").innerHTML=stage.layers.map(([layer,component,spec,reason],index)=>`<article><b>${String(index+1).padStart(2,"0")}</b><strong>${escapeHtml(layer)}</strong><div><h3>${escapeHtml(component)}</h3><span>${escapeHtml(spec)}</span></div><p>${escapeHtml(reason)}</p></article>`).join("");
  $("#architecture-enter-title").textContent=stage.enter[0];$("#architecture-enter-copy").textContent=stage.enter[1];$("#architecture-defer-title").textContent=stage.defer[0];$("#architecture-defer-copy").textContent=stage.defer[1];
  if(!$("#architecture-glossary-grid").children.length)$("#architecture-glossary-grid").innerHTML=Object.entries(architectureTerms).map(([key,item])=>`<button type="button" data-architecture-term="${escapeHtml(key)}"><b>${escapeHtml(item[0])}</b><span>${escapeHtml(item[1])}</span></button>`).join("");
  renderArchitectureTerm();
}
const commercialTagPattern=/^(?:商业|商业化|创业|创业点子|变现)$/u;
const commercialKeywordPattern=/(?:有偿用户|付费用户|商业化变现|订阅|成本核算|预期收益|愿付费)/u;
const commercialPaymentFactPattern=/(?:用户.{0,6}(?:已付款|已付费)|实际收入|收到.{0,4}元收入|完成收款|付费成交|用户续费|订阅成功)/u;
const commercialModelKeys=["validation","subscription","delivery","usagePack"];
const commercialProfileKeys=["low","medium","high","full"];
const commercialStages=[
  {name:"内部验证期",rationale:"验证需求与成本口径，不以规模或利润为目标。"},
  {name:"MVP 内部推送",rationale:"控制在可人工兜底的范围，验证留存、付费与交付标准化。"},
  {name:"快速上升期",rationale:"以 DAU 1 万为量级门槛，开始按团队、基础设施和获客效率核算。"},
  {name:"影响力期",rationale:"以 MAU 10 万、DAU 2.5 万为参考，要求自动化运营和稳定成本护栏。"},
  {name:"市场占有期",rationale:"按 1.84 亿 AI 生活助手用户中的 1% 可服务人群，再取得其中 10%：约 18.4 万 MAU。"}
];
const commercialStageScales={
  validation:["5 名定向体验者","20 名邀请体验者","100 名分批研究样本","300 名多批次样本","1,000 名长期研究样本"],
  subscription:["DAU 5 · MAU 20","DAU 100 · MAU 400","DAU 1 万 · MAU 4 万","DAU 2.5 万 · MAU 10 万","DAU 4.6 万 · MAU 18.4 万"],
  delivery:["4 单/月","30 单/月","800 单/月","5,000 单/月","15,000 单/月"],
  usagePack:["10 名购买者/月","80 名购买者/月","4,000 名购买者/月","15,000 名购买者/月","36,800 名购买者/月"]
};
function commercialEvidence(){
  const items=[],add=(type,view,id,title,content,tags,date)=>{const text=[title,content,(tags||[]).join(" ")].join(" ");if(!(tags||[]).some(tag=>commercialTagPattern.test(tag))&&!commercialKeywordPattern.test(text))return;items.push({type,view,id,title:plainPreview(title)||type,content:plainPreview(content||title),tags:tags||[],date:date||""})};
  for(const item of state.captures||[])add("捕念","captures",item.id,plainPreview(item.content).slice(0,48),item.content,item.tags,eventTimestamp(item));
  for(const item of state.journals||[])add("日记","journals",item.id,item.title||`${eventDate(item)} 日记`,item.content,item.tags,eventTimestamp(item));
  const roots=(state.thoughts||[]).filter(item=>item.type==="question");
  for(const root of roots){
    const children=(state.thoughts||[]).filter(item=>item.relatedTo===root.id&&item.authorType!=="ai"&&["idea","record","answer"].includes(item.type));
    const content=[root.content,...children.map(item=>item.content)].filter(Boolean).join("\n");
    add("思绪","thoughts",root.id,root.content,content,[...(root.tags||[]),...children.flatMap(item=>item.tags||[])],eventTimestamp(root));
  }
  for(const item of state.chats||[])add("共参","together",item.id,item.message,item.message,[],eventTimestamp(item));
  for(const book of state.books||[])for(const note of book.notes||[])add("书间","books",book.id,book.title,note.content,[],eventTimestamp(note));
  return items.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
}
function commercialAssumptionsFromForm(){
  const fallback=state.commercialization?.assumptions||{},result=structuredClone(fallback);
  result.stageByModel||={};result.stagePresets||={};
  $$("[data-commercial-field]").forEach(input=>{
    const [group,key]=input.dataset.commercialField.split("."),value=Number(input.value);
    if(!Number.isFinite(value))return;
    result[group]||={};result[group][key]=value;
    if(commercialModelKeys.includes(group)){
      const index=Math.max(0,Math.min(4,Number(result.stageByModel[group])||0));
      result.stagePresets[group]||=[];result.stagePresets[group][index]||={};result.stagePresets[group][index][key]=value;
    }
  });
  $$("[data-commercial-profile-field]").forEach(input=>{
    const [profile,key]=input.dataset.commercialProfileField.split("."),value=Number(input.value);
    if(!Number.isFinite(value))return;
    result.usageProfiles||={};result.usageProfiles[profile]||={};result.usageProfiles[profile][key]=value;
  });
  return result;
}
function populateCommercialAssumptions(assumptions){
  $$("[data-commercial-field]").forEach(input=>{const [group,key]=input.dataset.commercialField.split(".");input.value=assumptions?.[group]?.[key]??""});
  $$("[data-commercial-profile-field]").forEach(input=>{const [profile,key]=input.dataset.commercialProfileField.split(".");input.value=assumptions?.usageProfiles?.[profile]?.[key]??""});
}
function commercialAiBasis(assumptions){
  const summary=commercialStatistics?.ai?.summary,calls=Number(summary?.calls)||0,totalUsd=Number(summary?.costsUsd?.total)||0,observed=calls?totalUsd*Number(assumptions.common.usdCny)/calls:0,floor=Number(assumptions.common.aiCostFloorPerCallCny)||0;
  return{calls,totalUsd,observed,unit:Math.max(observed,floor)};
}
function commercialUsageEconomics(assumptions,ai){
  const profiles=commercialProfileKeys.map(key=>{
    const item=assumptions.usageProfiles?.[key]||{},activeDays=Number(item.activeDaysPerMonth)||0,foregroundCalls=activeDays*(Number(item.foregroundAiCallsPerActiveDay)||0),backgroundCalls=activeDays*(Number(item.backgroundAiCallsPerActiveDay)||0),imageCalls=Number(item.imageCallsPerMonth)||0,aiCost=(foregroundCalls+backgroundCalls)*ai.unit,imageCost=imageCalls*(Number(assumptions.common.segmentationCostPerImageCny)||0);
    return{key,item,share:Number(item.sharePct)||0,activeDays,requests:activeDays*(Number(item.requestsPerActiveDay)||0),foregroundCalls,backgroundCalls,imageCalls,aiCost,imageCost,cost:aiCost+imageCost};
  });
  const shareTotal=profiles.reduce((sum,profile)=>sum+profile.share,0),weighted=(key)=>shareTotal?profiles.reduce((sum,profile)=>sum+profile[key]*profile.share/shareTotal,0):0;
  return{profiles,shareTotal,requests:weighted("requests"),foregroundCalls:weighted("foregroundCalls"),backgroundCalls:weighted("backgroundCalls"),aiCalls:weighted("foregroundCalls")+weighted("backgroundCalls"),imageCalls:weighted("imageCalls"),aiCost:weighted("aiCost"),imageCost:weighted("imageCost"),cost:weighted("cost")};
}
function renderCommercialUsage(assumptions,ai){
  const usage=commercialUsageEconomics(assumptions,ai),shareStatus=$("#commercial-profile-share-status");
  for(const profile of usage.profiles){
    const cell=document.querySelector(`[data-commercial-profile-cost="${profile.key}"]`);
    if(cell)cell.textContent=formatCny(profile.cost);
  }
  shareStatus.textContent=`人群占比合计 ${usage.shareTotal.toFixed(1)}%${Math.abs(usage.shareTotal-100)>.01?"，已归一化计算":""}`;
  shareStatus.classList.toggle("warning",Math.abs(usage.shareTotal-100)>.01);
  $("#commercial-profile-summary").innerHTML=[
    ["加权请求",`${usage.requests.toFixed(1)} 次/人/月`,"用于 API、队列与日志容量"],
    ["加权 AI",`${usage.aiCalls.toFixed(1)} 次/人/月`,`其中后台 ${usage.backgroundCalls.toFixed(1)} 次`],
    ["加权图片",`${usage.imageCalls.toFixed(1)} 张/人/月`,"按图片分割单价"],
    ["资源单位成本",`${formatCny(usage.cost)}/人/月`,`AI ${formatCny(usage.aiCost)} · 图片 ${formatCny(usage.imageCost)}`]
  ].map(([label,value,note])=>`<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`).join("");
  const calibration=commercialStatistics?.ai?.calibration||{},service=commercialStatistics?.service||{},formatInt=value=>Math.round(Number(value)||0).toLocaleString("zh-CN");
  $("#commercial-observed-usage").innerHTML=[
    ["AI 活跃日",`${formatInt(calibration.activeDays)} 天`],
    ["AI 调用强度",`${(Number(calibration.averageCallsPerActiveDay)||0).toFixed(1)} 次/活跃日`],
    ["单次成本",`均值 ${formatCny(ai.observed)} · P90 ${formatCny(calibration.p90CostCny)}`],
    ["输入 Token",`均值 ${formatInt(calibration.averageInputTokens)} · 最大 ${formatInt(calibration.maxInputTokens)}`],
    ["完成写操作",`${formatInt(service.completedWrites)} 次`],
    ["图片分割请求",`${formatInt(service.segmentationRequests)} 次`]
  ].map(([label,value])=>`<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  const averageTokens=Number(calibration.averageInputTokens)||0,maxTokens=Number(calibration.maxInputTokens)||0;
  $("#commercial-context-risk").textContent=ai.calls?`实测平均输入 ${formatInt(averageTokens)} Token、最大 ${formatInt(maxTokens)} Token。当前按记录条数截断，不会随总记录数无限线性增长；但单条长文和完整回答链仍可把请求推到高位。应补统一 Token 硬预算、分层摘要、按需检索和超限告警。`:"当前按记录条数截断，不会随总记录数无限线性增长；但单条长文和完整回答链仍可能推高请求。上线前应补统一 Token 硬预算、分层摘要、按需检索和超限告警。";
  return usage;
}
function renderCommercialStage(assumptions){
  const index=Math.max(0,Math.min(4,Number(assumptions.stageByModel?.[commercialMode])||0)),stage=commercialStages[index];
  $("#commercial-stage-slider").value=String(index);
  $("#commercial-stage-name").textContent=stage.name;
  $("#commercial-stage-scale").textContent=commercialStageScales[commercialMode][index];
  $("#commercial-stage-rationale").textContent=stage.rationale;
}
function commercialKpis(items){
  $("#commercial-kpis").innerHTML=items.map(([label,value,note,tone])=>`<article class="${tone||""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`).join("");
}
function commercialRows(rows){
  $("#commercial-cost-rows").innerHTML=rows.map(([label,basis,amount,type])=>`<tr class="${type||""}"><td>${escapeHtml(label)}</td><td>${escapeHtml(basis)}</td><td>${escapeHtml(formatCny(amount))}</td></tr>`).join("");
}
function commercialUnitEconomics(items){
  $("#commercial-unit-economics").innerHTML=items.map(([label,value])=>`<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
}
function renderValidationModel(assumptions,ai){
  const item=assumptions.validation,common=assumptions.common,participants=Number(item.participants)||0,rewards=participants*item.rewardPerParticipantCny,modelCost=participants*item.aiCallsPerParticipant*ai.unit,imageCost=participants*item.imageCallsPerParticipant*common.segmentationCostPerImageCny,cashCost=rewards+modelCost+imageCost,interviewHours=participants*item.interviewMinutesPerParticipant/60,interviewCost=interviewHours*common.laborHourlyCny,developmentCost=item.developmentHoursTotal*common.laborHourlyCny,fullCost=cashCost+interviewCost+developmentCost,tasks=participants*item.tasksPerParticipant,suggestions=participants*item.validSuggestionsPerParticipant;
  commercialKpis([
    ["现金支出",formatCny(cashCost),`${participants} 人 × ${formatCny(item.rewardPerParticipantCny)} 报酬`],
    ["访谈成本",formatCny(interviewCost),`${interviewHours.toFixed(1)} 小时 × ${formatCny(common.laborHourlyCny)}/小时`],
    ["开发成本",formatCny(developmentCost),`${item.developmentHoursTotal} 小时 × ${formatCny(common.laborHourlyCny)}/小时`],
    ["完整投入",formatCny(fullCost),"现金、访谈与开发"]
  ]);
  $("#commercial-breakdown-title").textContent="有偿体验研究账";
  commercialRows([
    ["体验者报酬",`${participants} 人 × ${formatCny(item.rewardPerParticipantCny)}/人`,-rewards],
    ["AI 调用",`${participants*item.aiCallsPerParticipant} 次 × ${formatCny(ai.unit)}`,-modelCost],
    ["图片分割",`${participants*item.imageCallsPerParticipant} 张 × ${formatCny(common.segmentationCostPerImageCny)}/张`,-imageCost],
    ["访谈工时",`${interviewHours.toFixed(1)} 小时 × ${formatCny(common.laborHourlyCny)}/小时`,-interviewCost,"labor"],
    ["开发工时",`${item.developmentHoursTotal} 小时 × ${formatCny(common.laborHourlyCny)}/小时`,-developmentCost,"labor"]
  ]);
  $("#commercial-cost-total").innerHTML=`<tr><th colspan="2">完整研究投入</th><td class="negative">${escapeHtml(formatCny(fullCost))}</td></tr>`;
  commercialUnitEconomics([
    ["体验任务目标",`${tasks} 项`],
    ["有效建议目标",`${suggestions} 条`],
    ["单条建议成本",suggestions?`${formatCny(fullCost/suggestions)}/条`:"—"],
    ["单人完整成本",participants?`${formatCny(fullCost/participants)}/人`:"—"]
  ]);
  $("#commercial-method-note").textContent=`体验周期为 ${item.testDays} 天。该模型只有投入与学习产出，不计算收入；有效建议需满足可复现、可行动或能改变优先级。`;
}
function subscriptionProjection(item,common,usage){
  const rows=[],months=Math.max(1,Math.round(item.simulationMonths)||1),churn=item.monthlyChurnPct/100;
  let users=Number(item.payingUsers)||0;
  const activePerPaying=users>0?Math.max(1,(Number(item.monthlyActiveUsers)||0)/users):1;
  for(let index=0;index<months;index++){
    if(index)users=Math.max(0,users*(1-churn)+item.newPaidUsersPerMonth);
    const activeUsers=index||Number(item.payingUsers)?users*activePerPaying:Number(item.monthlyActiveUsers)||0,revenue=users*item.monthlyPriceCny,modelCost=activeUsers*usage.aiCost,imageCost=activeUsers*usage.imageCost,paymentCost=revenue*item.paymentFeePct/100,refundCost=revenue*item.refundPct/100,acquisition=item.newPaidUsersPerMonth*item.acquisitionCostPerNewUserCny,cashSpend=modelCost+imageCost+paymentCost+refundCost+item.fixedMonthlyCostCny+acquisition,cashFlow=revenue-cashSpend,laborHours=item.operationsHoursPerMonth+item.developmentHoursPerMonth,laborCost=laborHours*common.laborHourlyCny,fullProfit=cashFlow-laborCost;
    rows.push({index,users,activeUsers,revenue,modelCost,imageCost,paymentCost,refundCost,acquisition,cashSpend,cashFlow,laborHours,laborCost,fullProfit});
  }
  return rows;
}
function renderSubscriptionCashflow(rows,item,common){
  const start=new Date(`${currentLocalDate}T12:00:00`),monthLabel=index=>{const date=new Date(start.getFullYear(),start.getMonth()+index,1);return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`},totals=rows.reduce((sum,row)=>{for(const key of["revenue","cashSpend","cashFlow","laborHours","laborCost","fullProfit"])sum[key]+=row[key];return sum},{revenue:0,cashSpend:0,cashFlow:0,laborHours:0,laborCost:0,fullProfit:0});
  $("#commercial-cashflow").hidden=false;
  $("#commercial-cashflow-range").textContent=`统计 ${monthLabel(0)} 至 ${monthLabel(rows.length-1)}，共 ${rows.length} 个月；工时单价 ${formatCny(common.laborHourlyCny)}/小时`;
  $("#commercial-cashflow-rows").innerHTML=rows.map(row=>`<tr><td>${monthLabel(row.index)}</td><td>${row.users.toFixed(1)}</td><td>${formatCny(row.revenue)}</td><td>${formatCny(row.cashSpend)}</td><td class="${row.cashFlow>=0?"positive":"negative"}">${formatCny(row.cashFlow)}</td><td>${item.developmentHoursPerMonth.toFixed(1)}</td><td>${formatCny(row.laborCost)}</td><td class="${row.fullProfit>=0?"positive":"negative"}">${formatCny(row.fullProfit)}</td></tr>`).join("");
  $("#commercial-cashflow-total").innerHTML=`<tr><th>合计</th><td>—</td><td>${formatCny(totals.revenue)}</td><td>${formatCny(totals.cashSpend)}</td><td class="${totals.cashFlow>=0?"positive":"negative"}">${formatCny(totals.cashFlow)}</td><td>${(item.developmentHoursPerMonth*rows.length).toFixed(1)}</td><td>${formatCny(totals.laborCost)}</td><td class="${totals.fullProfit>=0?"positive":"negative"}">${formatCny(totals.fullProfit)}</td></tr>`;
}
function renderSubscriptionModel(assumptions,ai,usage){
  const item=assumptions.subscription,common=assumptions.common,rows=subscriptionProjection(item,common,usage),first=rows[0],totals=rows.reduce((sum,row)=>{sum.revenue+=row.revenue;sum.cashFlow+=row.cashFlow;sum.fullProfit+=row.fullProfit;return sum},{revenue:0,cashFlow:0,fullProfit:0}),activePerPaying=item.payingUsers?Math.max(1,item.monthlyActiveUsers/item.payingUsers):1,perPayingVariable=activePerPaying*usage.cost+item.monthlyPriceCny*(item.paymentFeePct+item.refundPct)/100,contribution=item.monthlyPriceCny-perPayingVariable,cashBreakEven=contribution>0?Math.ceil((item.fixedMonthlyCostCny+item.newPaidUsersPerMonth*item.acquisitionCostPerNewUserCny)/contribution):null,fullBreakEven=contribution>0?Math.ceil((item.fixedMonthlyCostCny+item.newPaidUsersPerMonth*item.acquisitionCostPerNewUserCny+(item.operationsHoursPerMonth+item.developmentHoursPerMonth)*common.laborHourlyCny)/contribution):null,churn=item.monthlyChurnPct/100,ltv=churn>0?contribution/churn:null,ltvCac=ltv!=null&&item.acquisitionCostPerNewUserCny>0?ltv/item.acquisitionCostPerNewUserCny:null,fullMargin=totals.revenue?totals.fullProfit/totals.revenue*100:0;
  commercialKpis([
    [`${rows.length} 月累计收入`,formatCny(totals.revenue),`首月 ${first.users.toFixed(1)} 名付费用户`],
    [`${rows.length} 月净现金流`,formatCny(totals.cashFlow),"不计个人工时",totals.cashFlow>=0?"positive":"negative"],
    ["首月活跃规模",`${item.dailyActiveUsers.toLocaleString("zh-CN")} DAU`,`${item.monthlyActiveUsers.toLocaleString("zh-CN")} MAU`],
    [`${rows.length} 月完整结余`,formatCny(totals.fullProfit),`${fullMargin.toFixed(1)}% 完整利润率`,totals.fullProfit>=0?"positive":"negative"]
  ]);
  $("#commercial-breakdown-title").textContent=`首月订阅经营账`;
  commercialRows([
    ["订阅收入",`${first.users.toFixed(1)} 人 × ${formatCny(item.monthlyPriceCny)}/人/月`,first.revenue,"revenue"],
    ["AI 调用",`${Math.round(first.activeUsers*usage.aiCalls).toLocaleString("zh-CN")} 次 · 含后台任务`,-first.modelCost],
    ["图片分割",`${Math.round(first.activeUsers*usage.imageCalls).toLocaleString("zh-CN")} 张 × ${formatCny(common.segmentationCostPerImageCny)}/张`,-first.imageCost],
    ["支付费",`${item.paymentFeePct}%/收入`,-first.paymentCost],
    ["退款",`${item.refundPct}%/收入`,-first.refundCost],
    ["固定现金成本",`${formatCny(item.fixedMonthlyCostCny)}/月`,-item.fixedMonthlyCostCny],
    ["新增用户获客",`${item.newPaidUsersPerMonth} 人/月 × ${formatCny(item.acquisitionCostPerNewUserCny)}/人`,-first.acquisition],
    ["经营工时",`${item.operationsHoursPerMonth} 小时/月 × ${formatCny(common.laborHourlyCny)}/小时`,-item.operationsHoursPerMonth*common.laborHourlyCny,"labor"],
    ["研发工时",`${item.developmentHoursPerMonth} 小时/月 × ${formatCny(common.laborHourlyCny)}/小时`,-item.developmentHoursPerMonth*common.laborHourlyCny,"labor"]
  ]);
  $("#commercial-cost-total").innerHTML=`<tr><th colspan="2">首月完整结余</th><td class="${first.fullProfit>=0?"positive":"negative"}">${escapeHtml(formatCny(first.fullProfit))}</td></tr>`;
  commercialUnitEconomics([
    ["单付费用户月贡献",formatCny(contribution)],
    ["现金盈亏平衡",cashBreakEven==null?"不可达":`${cashBreakEven} 人`],
    ["完整盈亏平衡",fullBreakEven==null?"不可达":`${fullBreakEven} 人`],
    ["LTV / CAC",ltvCac==null?"—":`${ltvCac.toFixed(1)}×`]
  ]);
  $("#commercial-method-note").textContent=`首月 ${item.monthlyActiveUsers.toLocaleString("zh-CN")} MAU 中有 ${item.payingUsers.toLocaleString("zh-CN")} 名付费用户；免费与付费用户都按四类画像产生资源成本。第 2 月起保持首月 MAU/付费比，按流失与新增推演。LTV 不含固定成本和人工。`;
  renderSubscriptionCashflow(rows,item,common);
}
function renderDeliveryModel(assumptions,ai){
  const item=assumptions.delivery,common=assumptions.common,orders=Number(item.ordersPerMonth)||0,hostedOrders=orders*(1-item.byokPct/100),byokOrders=orders-hostedOrders,serviceRevenue=orders*item.serviceFeePerOrderCny,prepaidPrincipal=hostedOrders*item.hostedPrepaidPerOrderCny,prepaidCash=prepaidPrincipal*(1+item.maintenanceMarkupPct/100),usedPrincipal=prepaidPrincipal*item.prepaidUtilizationPct/100,recognizedHostedRevenue=usedPrincipal*(1+item.maintenanceMarkupPct/100),liabilityIncrease=Math.max(0,prepaidCash-recognizedHostedRevenue),cashInflow=serviceRevenue+prepaidCash,earnedRevenue=serviceRevenue+recognizedHostedRevenue,paymentCost=cashInflow*item.paymentFeePct/100,refundCost=cashInflow*item.refundPct/100,acquisition=orders*item.acquisitionCostPerOrderCny,cashOut=usedPrincipal+paymentCost+refundCost+acquisition,cashFlow=cashInflow-cashOut,deliveryHours=orders*item.deliveryHoursPerOrder,supportHours=orders*item.supportHoursPerOrder,laborCost=(deliveryHours+supportHours+item.developmentHoursPerMonth)*common.laborHourlyCny,fullProfit=earnedRevenue-usedPrincipal-paymentCost-refundCost-acquisition-laborCost;
  commercialKpis([
    ["月现金流入",formatCny(cashInflow),`服务费 + 托管预存`],
    ["净现金流",formatCny(cashFlow),`未扣个人工时`,cashFlow>=0?"positive":"negative"],
    ["新增合同负债",formatCny(liabilityIncrease),`预存余额与未赚维护费`],
    ["完整利润",formatCny(fullProfit),"计入全部工时",fullProfit>=0?"positive":"negative"]
  ]);
  $("#commercial-breakdown-title").textContent="一次性交付与托管预存账";
  commercialRows([
    ["系统服务费",`${orders} 单/月 × ${formatCny(item.serviceFeePerOrderCny)}/单`,serviceRevenue,"revenue"],
    ["托管预存流入",`${hostedOrders.toFixed(1)} 单 × 本金 ${formatCny(item.hostedPrepaidPerOrderCny)} × (1 + ${item.maintenanceMarkupPct}%)`,prepaidCash,"revenue"],
    ["调用成本",`托管本金 × ${item.prepaidUtilizationPct}% 已消耗`,-usedPrincipal],
    ["未消耗预存",`留作后续履约，不计利润`,-liabilityIncrease,"liability"],
    ["支付费",`${item.paymentFeePct}%/现金流入`,-paymentCost],
    ["退款",`${item.refundPct}%/现金流入`,-refundCost],
    ["获客",`${orders} 单/月 × ${formatCny(item.acquisitionCostPerOrderCny)}/单`,-acquisition],
    ["交付工时",`${deliveryHours.toFixed(1)} 小时/月 × ${formatCny(common.laborHourlyCny)}/小时`,-deliveryHours*common.laborHourlyCny,"labor"],
    ["支持工时",`${supportHours.toFixed(1)} 小时/月 × ${formatCny(common.laborHourlyCny)}/小时`,-supportHours*common.laborHourlyCny,"labor"],
    ["研发工时",`${item.developmentHoursPerMonth} 小时/月 × ${formatCny(common.laborHourlyCny)}/小时`,-item.developmentHoursPerMonth*common.laborHourlyCny,"labor"]
  ]);
  $("#commercial-cost-total").innerHTML=`<tr><th colspan="2">月度完整利润</th><td class="${fullProfit>=0?"positive":"negative"}">${escapeHtml(formatCny(fullProfit))}</td></tr>`;
  commercialUnitEconomics([
    ["BYOK / 托管",`${byokOrders.toFixed(1)} / ${hostedOrders.toFixed(1)} 单`],
    ["当月确认收入",formatCny(earnedRevenue)],
    ["单笔完整利润",orders?`${formatCny(fullProfit/orders)}/单`:"—"],
    ["服务与支持",`${(item.deliveryHoursPerOrder+item.supportHoursPerOrder).toFixed(2)} 小时/单`]
  ]);
  $("#commercial-method-note").textContent=`BYOK 用户自行承担模型费用；托管用户预存调用本金并按实际消耗支付 ${item.maintenanceMarkupPct}% 维护费。未消耗的本金和对应维护费作为合同负债，不计入当期利润。`;
}
function renderUsagePackModel(assumptions,ai){
  const item=assumptions.usagePack,common=assumptions.common,buyers=Number(item.buyersPerMonth)||0,packs=buyers*item.packsPerBuyer,revenue=packs*item.pricePerPackCny,utilization=item.utilizationPct/100,aiCalls=packs*item.includedAiCallsPerPack*utilization,imageCalls=packs*item.includedImageCallsPerPack*utilization,modelCost=aiCalls*ai.unit,imageCost=imageCalls*common.segmentationCostPerImageCny,paymentCost=revenue*item.paymentFeePct/100,refundCost=revenue*item.refundPct/100,acquisition=buyers*item.acquisitionCostPerBuyerCny,cashCost=modelCost+imageCost+paymentCost+refundCost+acquisition,cashProfit=revenue-cashCost,laborCost=item.supportHoursPerMonth*common.laborHourlyCny,fullProfit=cashProfit-laborCost,variablePerPack=packs?(modelCost+imageCost+paymentCost+refundCost)/packs:0;
  commercialKpis([
    ["月度收入",formatCny(revenue),`${packs.toFixed(1)} 包/月 × ${formatCny(item.pricePerPackCny)}/包`],
    ["实际资源成本",formatCny(modelCost+imageCost),`${item.utilizationPct}% 额度使用率`],
    ["净现金流",formatCny(cashProfit),"含获客与退款",cashProfit>=0?"positive":"negative"],
    ["完整利润",formatCny(fullProfit),"计入支持工时",fullProfit>=0?"positive":"negative"]
  ]);
  $("#commercial-breakdown-title").textContent="用量增值包月度账";
  commercialRows([
    ["用量包收入",`${packs.toFixed(1)} 包/月 × ${formatCny(item.pricePerPackCny)}/包`,revenue,"revenue"],
    ["AI 调用",`${Math.round(aiCalls)} 次/月 × ${formatCny(ai.unit)}/次`,-modelCost],
    ["图片分割",`${Math.round(imageCalls)} 张/月 × ${formatCny(common.segmentationCostPerImageCny)}/张`,-imageCost],
    ["支付费",`${item.paymentFeePct}%/收入`,-paymentCost],
    ["退款",`${item.refundPct}%/收入`,-refundCost],
    ["获客",`${buyers} 人/月 × ${formatCny(item.acquisitionCostPerBuyerCny)}/人`,-acquisition],
    ["支持工时",`${item.supportHoursPerMonth} 小时/月 × ${formatCny(common.laborHourlyCny)}/小时`,-laborCost,"labor"]
  ]);
  $("#commercial-cost-total").innerHTML=`<tr><th colspan="2">月度完整利润</th><td class="${fullProfit>=0?"positive":"negative"}">${escapeHtml(formatCny(fullProfit))}</td></tr>`;
  commercialUnitEconomics([
    ["单包变量成本",`${formatCny(variablePerPack)}/包`],
    ["单包现金贡献",packs?`${formatCny((revenue-(modelCost+imageCost+paymentCost+refundCost))/packs)}/包`:"—"],
    ["额度使用率",`${item.utilizationPct}%`],
    ["实际消耗",`${Math.round(aiCalls)} 次 AI · ${Math.round(imageCalls)} 张图`]
  ]);
  $("#commercial-method-note").textContent="用量包用于覆盖高强度 AI 与图片调用，不应把基础记录能力切碎收费；使用率越高，未使用额度带来的缓冲越小。";
}
function renderCommercialization(syncInputs=true){
  if(!$("#view-commercialization")||!state.commercialization?.assumptions)return;
  const assumptions=syncInputs?state.commercialization.assumptions:commercialAssumptionsFromForm();
  if(!syncInputs)state.commercialization.assumptions=assumptions;
  if(syncInputs)populateCommercialAssumptions(assumptions);
  const current=syncInputs?assumptions:commercialAssumptionsFromForm(),ai=commercialAiBasis(current),evidence=commercialEvidence(),paidFacts=evidence.filter(item=>commercialPaymentFactPattern.test(`${item.title} ${item.content}`));
  $("#commercial-stage").textContent=paidFacts.length?"用户付费验证中":"有偿调研准备";
  $("#commercial-verdict-title").textContent=paidFacts.length?"已经出现用户付费事实，继续核对交付成本与第 7 天留存。":"先付费招募体验者，换取完成任务、有效建议和结构化访谈。";
  $("#commercial-verdict-copy").textContent=paidFacts.length?`已从用户原文识别 ${paidFacts.length} 条完成态付费线索；仍需逐条核对金额、是否补贴以及付款后的持续使用。`:"这笔支出是产品研究成本，不是收入。访谈与研发工时分别核算，后续再用无补贴场景验证用户是否愿意付款。";
  $$("[data-commercial-mode]").forEach(button=>{const active=button.dataset.commercialMode===commercialMode;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active))});
  $$("[data-commercial-assumption-group]").forEach(group=>group.hidden=group.dataset.commercialAssumptionGroup!==commercialMode);
  $("#commercial-updated-at").textContent=`${state.commercialization.updatedAt?`参数更新于 ${formatDate(state.commercialization.updatedAt)}`:"使用示例假设"}${state.commercialization.legacyV2?" · 已保留旧版参数供核对":""}`;
  $("#commercial-evidence-count").textContent=`${evidence.length} 条`;
  $("#commercial-paid-evidence").textContent=paidFacts.length?`${paidFacts.length} 条`:"待记录";
  $("#commercial-ai-sample").textContent=ai.calls?`${ai.calls} 次`:"暂无";
  $("#commercial-model-basis").textContent=ai.calls?"实际账本 + 保守底线":"假设";
  renderCommercialStage(current);
  const usage=renderCommercialUsage(current,ai);
  $("#commercial-evidence-summary").textContent=`${evidence.length} 条用户原文 · AI 回答未计入`;
  $("#commercial-evidence-list").innerHTML=evidence.length?evidence.map(item=>`<article><header><span>${escapeHtml(item.type)}</span><time>${escapeHtml(item.date?eventDate({occurredAt:item.date}):"")}</time></header><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.content)}</p>${item.tags.length?`<div>${item.tags.map(tag=>`<span>#${escapeHtml(tag)}</span>`).join("")}</div>`:""}<button type="button" data-commercial-source-view="${escapeHtml(item.view)}" data-commercial-source-id="${escapeHtml(item.id)}" data-commercial-source-date="${escapeHtml(item.date)}">查看原记录</button></article>`).join(""):empty("还没有能确认的商业化原始记录。");
  $("#commercial-cashflow").hidden=true;$("#commercial-cashflow-rows").innerHTML="";$("#commercial-cashflow-total").innerHTML="";
  if(commercialMode==="validation")renderValidationModel(current,ai);
  else if(commercialMode==="subscription")renderSubscriptionModel(current,ai,usage);
  else if(commercialMode==="delivery")renderDeliveryModel(current,ai);
  else renderUsagePackModel(current,ai);
  const p90=Number(commercialStatistics?.ai?.calibration?.p90CostCny)||0,sampleNote=ai.calls?`近 30 天实际均值 ${formatCny(ai.observed)}/次、P90 ${formatCny(p90)}/次，共 ${ai.calls} 次；估算采用均值与保守底线中的较高值 ${formatCny(ai.unit)}/次。`:`近 30 天没有 AI 成本样本，暂按 ${formatCny(ai.unit)}/次。`;
  $("#commercial-method-note").textContent+=` ${sampleNote}`;
}
async function loadCommercialization(){
  const serial=++commercialRequestSerial,owner=currentUser?.id,session=sessionSerial,from=shiftLocalDateKey(currentLocalDate,-29),status=$("#commercial-save-status");status.textContent="正在汇总近 30 天成本与记录…";
  try{
    const stats=await request(`/api/statistics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(currentLocalDate)}`);
    if(serial!==commercialRequestSerial||owner!==currentUser?.id||session!==sessionSerial)return;commercialStatistics=stats;renderCommercialization();status.textContent="";
  }catch(error){if(serial===commercialRequestSerial)status.textContent=error.message}
}
function openCommercialSource(view,id,date){
  if(view==="together"&&date){activeDate=eventDate({occurredAt:date});renderDate();renderChat()}
  switchView(view);
  requestAnimationFrame(()=>{
    const selectors={thoughts:`[data-chain-id="${CSS.escape(id)}"]`,captures:`[data-capture-id="${CSS.escape(id)}"]`,journals:`[data-journal-id="${CSS.escape(id)}"]`,books:`[data-book-id="${CSS.escape(id)}"]`,together:`[data-chat-id="${CSS.escape(id)}"]`},target=document.querySelector(selectors[view]||"");
    if(target instanceof HTMLDetailsElement)target.open=true;
    target?.scrollIntoView({behavior:"smooth",block:"center"});
  });
}
function collectOnboardingAnswers(){for(const input of $$('#onboarding-questions input[type="radio"]:checked'))onboardingDraftAnswers[input.name.replace(/^onboarding-/,"")]=input.value;return onboardingDraftAnswers}
function renderOnboardingQuestions(){const list=$("#onboarding-questions");if(!list||!onboardingSchema)return;const questions=onboardingSchema.questions.filter(question=>question.tier==="quick"||onboardingMode==="detailed");list.className="onboarding-question-list";list.innerHTML=questions.map((question,index)=>`<section class="onboarding-question"><header><span>${escapeHtml(question.dimension)} · ${String(index+1).padStart(2,"0")}</span><h3>${escapeHtml(question.prompt)}</h3></header><div class="onboarding-options">${question.options.map(option=>`<label><input type="radio" name="onboarding-${escapeHtml(question.id)}" value="${escapeHtml(option.value)}" ${onboardingDraftAnswers[question.id]===option.value?"checked":""} required><span>${escapeHtml(option.label)}</span></label>`).join("")}</div></section>`).join("");$$("[data-onboarding-mode]").forEach(button=>{const active=button.dataset.onboardingMode===onboardingMode;button.classList.toggle("active",active);button.setAttribute("aria-pressed",String(active))})}
function onboardingPayload(){collectOnboardingAnswers();return{status:"completed",questionnaireMode:onboardingMode,answers:onboardingDraftAnswers,profile:{gender:$("#onboarding-gender").value,region:$("#onboarding-region").value,occupation:$("#onboarding-occupation").value,major:$("#onboarding-major").value,school:$("#onboarding-school").value,introduction:$("#onboarding-introduction").value,works:$("#onboarding-works").value},interests:$$('#onboarding-interests input[type="checkbox"]:checked').map(input=>input.value),material:$("#onboarding-material").value,understanding:$("#onboarding-understanding").value}}
function renderOnboarding(){
  const panel=$("#onboarding-workspace");if(!panel)return;
  panel.hidden=state.onboarding?.status!=="pending"||!onboardingSchema;
  if(panel.hidden)return;
  if(!onboardingHydrated){
    const saved=state.onboarding||{};onboardingMode=saved.questionnaireMode==="detailed"?"detailed":"quick";onboardingDraftAnswers={...(saved.answers||{})};
    const profile=saved.profile||{};for(const key of["gender","region","occupation","major","school","introduction","works"]){const field=$(`#onboarding-${key}`);if(field)field.value=profile[key]||""}
    $("#onboarding-interests").innerHTML=(onboardingSchema.interests||[]).map(value=>`<label><input type="checkbox" value="${escapeHtml(value)}" ${(saved.interests||[]).includes(value)?"checked":""}><span>${escapeHtml(value)}</span></label>`).join("");
    $("#onboarding-material").value=saved.material||"";$("#onboarding-understanding").value=saved.understanding||"";$("#onboarding-understanding").closest("label").hidden=!saved.understanding;onboardingHydrated=true
  }
  renderOnboardingQuestions()
}
function renderDate(){$$("[data-active-date]").forEach(input=>input.value=activeDate);installOccurrenceControls();if(!$("#capture-id")?.value)resetOccurrenceInput($("#capture-date"));if(!$("#journal-id")?.value)resetOccurrenceInput($("#journal-date"));if(!$("#quote-id")?.value)resetOccurrenceInput($("#quote-datetime"));if(!$("#keepsake-id")?.value)resetOccurrenceInput($("#keepsake-datetime"));for(const input of[$("#chain-datetime"),$("#checkin-datetime"),$("#chat-datetime")])resetOccurrenceInput(input);$$("[data-daily-form]").forEach(form=>{if(!form.elements.recordId.value)resetOccurrenceInput(form.elements.occurredAt)});const d=new Date(`${activeDate}T12:00:00`),today=activeDate===localDateKey(),label=new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"long",day:"numeric",weekday:"long"}).format(d);$$("[data-active-date-label]").forEach(element=>element.textContent=label);$$("[data-active-date-heading]").forEach(element=>{const view=element.closest(".view")?.id;element.textContent=!today?"回到这一天":view==="view-daily"?"今天，留下了什么？":view==="view-together"?"今天，一起看看":"今天，你感觉怎么样？"})}
function homeMemorySource(item){
  const date=item.occurredAt?formatDate(item.occurredAt):formatDateKey(item.occurredOn);
  if(item.type==="book")return `书间 · 《${item.sourceTitle||"未命名书目"}》 · ${date}`;
  if(item.type==="quote")return `拾句 · ${item.sourceTitle||"来源未记"} · ${date}`;
  return `思绪 · ${date}`
}
function renderHomeMemories({advance=false}={}){
  const container=$("#home-memory-grid"),status=$("#home-memory-status"),shuffle=$("#home-shuffle");
  if(!container)return;
  const pool=createHomeMemoryPool(state),poolByKey=new Map(pool.map(item=>[item.key,item])),limit=Math.min(3,pool.length);
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
  const item=[...(state.keepsakes||[])].sort((left,right)=>eventTimestamp(right).localeCompare(eventTimestamp(left)))[0];
  const button=document.createElement("button");
  button.className="home-v02-keepsake-entry";
  button.type="button";
  button.dataset.homeKeepsake=item?.id||"";
  const preview=document.createElement("span");
  preview.className=`home-v02-keepsake-preview${item?"":" empty"}`;
  if(item){
    const image=document.createElement("img");
    image.src=appUrl(item.cutoutPath||item.displayPath||item.thumbPath||item.originalPath);
    image.alt=item.title;
    image.loading="lazy";
    preview.append(image)
  }else{
    preview.textContent="物";
    preview.setAttribute("aria-hidden","true")
  }
  const copy=document.createElement("span");
  copy.className="home-v02-keepsake-copy";
  const label=document.createElement("small");
  label.textContent=item?`${item.category||"小物"} · ${formatDate(eventTimestamp(item))}`:"留存一件小物";
  const title=document.createElement("strong");
  title.textContent=item?.title||"小物";
  const arrow=document.createElement("span");
  arrow.className="home-v02-keepsake-arrow";
  arrow.textContent="→";
  arrow.setAttribute("aria-hidden","true");
  copy.append(label,title);
  button.append(preview,copy,arrow);
  button.setAttribute("aria-label",item?`打开小物：${item.title}`:"打开小物");
  container.replaceChildren(button)
}
function renderHomeMood(){
  const svg=$("#home-mood-sparkline");
  if(!svg)return;
  const series=buildHomeMoodSeries(state.checkins||[],activeDate,7),available=series.filter(item=>Number.isFinite(item.value)),namespace="http://www.w3.org/2000/svg",x=index=>10+index*260/Math.max(1,series.length-1),y=value=>49-(value-1)*10;
  svg.replaceChildren();
  if(!available.length){
    const label=document.createElementNS(namespace,"text");
    label.setAttribute("x","3");label.setAttribute("y","34");label.textContent="还没有记录";
    svg.append(label);svg.setAttribute("aria-label","近 7 日还没有情绪记录");return
  }
  let segment=[];
  const drawSegment=()=>{
    if(segment.length>1){
      const line=document.createElementNS(namespace,"polyline");
      line.setAttribute("points",segment.map(item=>`${x(item.index)},${y(item.value)}`).join(" "));
      svg.append(line)
    }
    segment=[]
  };
  series.forEach((item,index)=>{
    if(Number.isFinite(item.value))segment.push({...item,index});
    else drawSegment()
  });
  drawSegment();
  series.forEach((item,index)=>{
    if(!Number.isFinite(item.value))return;
    const point=document.createElementNS(namespace,"circle"),title=document.createElementNS(namespace,"title");
    point.setAttribute("cx",x(index));point.setAttribute("cy",y(item.value));point.setAttribute("r","2.6");
    title.textContent=`${item.date} · 情绪 ${item.value.toFixed(2)} · ${item.count} 次记录均值`;
    point.append(title);svg.append(point)
  });
  svg.setAttribute("aria-label",`近 7 日有 ${available.length} 个情绪记录日；查看趋势可读详细数值。`)
}
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
  if(restoreFocus&&opened.length&&trigger?.isConnected)requestAnimationFrame(()=>trigger.focus({preventScroll:true}))
}
function openHomeEditor(kind){
  const editor=$(`#home-${kind}-editor`);
  if(!editor)return;
  closeHomeEditors({restoreFocus:false});
  const fallback=kind==="thought"?$("#home-open-thought"):$("#home-record-state");
  homeEditorTrigger=document.activeElement instanceof HTMLElement&&document.activeElement!==document.body?document.activeElement:fallback;
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
    switchView("thoughts");
    requestAnimationFrame(()=>{const card=document.querySelector(`[data-chain-id="${CSS.escape(item.id)}"]`);if(card instanceof HTMLDetailsElement)card.open=true;card?.scrollIntoView({behavior:"smooth",block:"center"})});
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
  if(notificationCount){const unread=Number(state.notificationUnread??notificationUnreadCount)||(state.notifications||[]).filter(item=>!item.readAt&&["succeeded","failed","stale","cancelled"].includes(item.status)).length;notificationCount.textContent=unread?`${unread} 条未读`:""}
  const versionLabel=releaseVersion.startsWith("v")?releaseVersion:`v${releaseVersion}`;
  for(const element of[$("#sidebar-app-version"),$("#mine-app-version")])if(element)element.textContent=versionLabel
}
function discoveryCard(item){
  const primary=item.matches?.[0]||item.question||{},sources=[...new Set((item.matches||[]).map(match=>match.sourceLabel))].join(" · ");
  const key=item.key||`thought:${item.id}`,thought=(item.genre||"thought")==="thought",status=thought?(item.fresh?"待回访":item.status?.snoozed?"已稍后":"已读"):item.genreLabel||"原始记录";
  return `<article class="discovery-entry" data-discovery-id="${escapeHtml(key)}"><header><div><span>${escapeHtml(status)}</span><small>${escapeHtml([item.genreLabel,sources||item.sourceLabel||"用户原文"].filter(Boolean).join(" · "))}</small></div><time>${formatDate(item.occurredAt||item.createdAt)}</time></header><h2>${escapeHtml(plainPreview(item.title||item.question?.content||primary.content||"无标题记录"))}</h2><p>${escapeHtml(plainPreview(primary.content||"").slice(0,220))}</p><footer><span>${item.matchCount||0} 处命中</span><div><button class="subtle-action" type="button" data-discovery-action="${escapeHtml(key)}">转为行动</button>${thought?`<button class="subtle-action" type="button" data-discovery-snooze="${escapeHtml(key)}">明天再看</button>`:""}<button class="quiet-button" type="button" data-discovery-open="${escapeHtml(key)}">查看原记录</button></div></footer></article>`
}
function renderDiscovery(snapshot=discoveryController?.getState()){
  if(!snapshot||!$("#discovery-list"))return;
  $("#discovery-count").textContent=`${snapshot.total} 条 · ${snapshot.totalUntracedCount} 条尚无你的后续痕迹`;
  $("#discovery-status").textContent=snapshot.loading?"正在检索…":snapshot.error||"";
  $("#discovery-list").innerHTML=snapshot.items.length?snapshot.items.map(discoveryCard).join(""):empty(snapshot.loading?"正在检索…":"没有符合条件的记录。");
  $("#discovery-more").hidden=!snapshot.nextCursor;$("#discovery-more").disabled=snapshot.loadingMore;$("#discovery-more").textContent=snapshot.loadingMore?"正在加载…":"继续加载"
}
async function loadDiscovery(){if(!discoveryController)return false;try{return await discoveryController.refresh()}catch(error){showToast(error.message,"error");return false}}
function renderActionsWorkspace(){
  if(!$("#action-columns"))return;
  const view=createActionsViewModel(actionsSnapshot,{today:currentLocalDate});
  $("#actions-summary").textContent=`${view.summary.openActions} 项待推进 · ${view.summary.checkedToday}/${view.summary.activeHabits} 个习惯已打卡`;
  $("#action-columns").innerHTML=view.actionColumns.map(column=>`<section class="action-column"><header><b>${column.label}</b><span>${column.count}</span></header>${column.items.length?column.items.map(item=>`<article class="action-entry"><div><span class="action-priority priority-${item.priority.toLowerCase()}">${item.priorityLabel}</span><h3>${escapeHtml(item.title)}</h3><small>${escapeHtml(item.sourceLabel)}</small></div><div class="action-entry-buttons">${item.status==="todo"?`<button class="quiet-button" type="button" data-action-start="${escapeHtml(item.id)}" data-version="${item.version}">开始</button>`:item.status==="doing"?`<button class="quiet-button" type="button" data-action-complete="${escapeHtml(item.id)}" data-version="${item.version}">完成</button>`:`<button class="subtle-action" type="button" data-action-reopen="${escapeHtml(item.id)}" data-version="${item.version}">撤销完成</button>`}<button class="subtle-action" type="button" data-action-edit="${escapeHtml(item.id)}" data-version="${item.version}">编辑</button><button class="subtle-action danger" type="button" data-action-delete="${escapeHtml(item.id)}" data-version="${item.version}" aria-label="删除行动">删除</button></div></article>`).join(""):empty("暂无")}</section>`).join("");
  $("#habit-list").innerHTML=view.habits.length?view.habits.map(item=>`<article class="habit-entry"><header><div><h3>${escapeHtml(item.title)}</h3><span>${escapeHtml(item.frequencyLabel)} · ${item.period.count}/${item.period.target}</span></div><b class="${item.period.complete?"complete":""}">${item.period.complete?"已达成":item.statusLabel}</b></header><div class="habit-progress"><i style="width:${Math.min(100,item.period.count/item.period.target*100)}%"></i></div>${item.latestFeeling?`<p>${escapeHtml(item.latestFeeling)}</p>`:""}<footer>${item.checkedToday?`<button class="quiet-button" type="button" data-habit-uncheck="${escapeHtml(item.todayCheckin.id)}" data-version="${item.todayCheckin.version}">撤销打卡</button>`:`<button class="quiet-button" type="button" data-habit-checkin="${escapeHtml(item.id)}" ${item.canCheckIn?"":"disabled"}>今日打卡</button>`}<button class="subtle-action" type="button" data-habit-toggle="${escapeHtml(item.id)}" data-enabled="${String(item.enabled)}" data-version="${item.version}">${item.enabled?"暂停":"启用"}</button><button class="subtle-action" type="button" data-habit-adjust="${escapeHtml(item.id)}" data-version="${item.version}">调整</button><button class="subtle-action danger" type="button" data-habit-delete="${escapeHtml(item.id)}" data-version="${item.version}">删除</button></footer></article>`).join(""):empty("还没有习惯。");
}
async function loadActionsWorkspace(){
  if(!$("#action-columns"))return false;
  const requestSerial=++actionsRequestSerial,owner=currentUser?.id,session=sessionSerial,status=$("#action-status");status.textContent="正在同步行动…";
  try{
    const [actions,habits]=await Promise.all([listAllV1("/api/v1/actions"),listAllV1("/api/v1/habits")]);
    const checkins=(await Promise.all(habits.map(item=>listAllV1(`/api/v1/habits/${encodeURIComponent(item.id)}/checkins`)))).flat();
    if(requestSerial!==actionsRequestSerial||owner!==currentUser?.id||session!==sessionSerial)return false;
    actionsSnapshot={actions,habits,habitCheckins:checkins};renderActionsWorkspace();status.textContent="";return true
  }catch(error){if(requestSerial===actionsRequestSerial&&owner===currentUser?.id&&session===sessionSerial)status.textContent=error.message;return false}
}
async function runActionCommand(command,{idempotencyKey=""}={}){
  const headers={},options={};
  if(command.expectedVersion)headers["if-match"]=`"${command.expectedVersion}"`;
  if(["actions.create","habits.create","habitCheckins.create"].includes(command.type))headers["idempotency-key"]=idempotencyKey||crypto.randomUUID();
  if(command.type==="actions.create")Object.assign(options,{method:"POST",body:JSON.stringify(command.input)});
  else if(command.type==="actions.update")Object.assign(options,{method:"PATCH",body:JSON.stringify(command.input)});
  else if(command.type==="actions.setStatus")Object.assign(options,{method:"PATCH",body:JSON.stringify({status:command.status})});
  else if(command.type==="actions.complete")Object.assign(options,{method:"POST"});
  else if(command.type==="actions.undoCompletion")Object.assign(options,{method:"POST"});
  else if(command.type==="actions.delete")Object.assign(options,{method:"DELETE"});
  else if(command.type==="habits.create")Object.assign(options,{method:"POST",body:JSON.stringify(command.input)});
  else if(command.type==="habits.setEnabled")Object.assign(options,{method:"PATCH",body:JSON.stringify({status:command.enabled?"active":"paused"})});
  else if(command.type==="habits.recordAdjustment")Object.assign(options,{method:"POST",body:JSON.stringify(command.input)});
  else if(command.type==="habits.delete")Object.assign(options,{method:"DELETE"});
  else if(command.type==="habitCheckins.create")Object.assign(options,{method:"POST",body:JSON.stringify(command.input)});
  else if(command.type==="habitCheckins.delete")Object.assign(options,{method:"DELETE"});
  else throw new Error("暂不支持这个行动操作");
  const routes={
    "actions.create":"/api/v1/actions",
    "actions.update":`/api/v1/actions/${encodeURIComponent(command.id)}`,
    "actions.setStatus":`/api/v1/actions/${encodeURIComponent(command.id)}`,
    "actions.complete":`/api/v1/actions/${encodeURIComponent(command.id)}/complete`,
    "actions.undoCompletion":`/api/v1/actions/${encodeURIComponent(command.id)}/reopen`,
    "actions.delete":`/api/v1/actions/${encodeURIComponent(command.id)}`,
    "habits.create":"/api/v1/habits",
    "habits.setEnabled":`/api/v1/habits/${encodeURIComponent(command.id)}`,
    "habits.recordAdjustment":`/api/v1/habits/${encodeURIComponent(command.id)}/adjustments`,
    "habits.delete":`/api/v1/habits/${encodeURIComponent(command.id)}`,
    "habitCheckins.create":`/api/v1/habits/${encodeURIComponent(command.habitId)}/checkins`,
    "habitCheckins.delete":`/api/v1/habit-checkins/${encodeURIComponent(command.id)}`
  };
  options.headers=headers;
  const result=await requestV1(routes[command.type],options);
  if(!await loadActionsWorkspace())throw Object.assign(new Error("已保存，但行动列表刷新失败，请稍后重试同步。"),{saved:true});
  return result
}
function renderFeedback(){
  if(!$("#feedback-list"))return;
  const items=feedbackItems.map(feedbackViewModel);
  $("#feedback-count").textContent=`${items.length} 条`;
  $("#feedback-list").innerHTML=items.length?items.map(item=>`<article class="feedback-entry"><header><span>${escapeHtml(item.typeLabel)}</span><b>${escapeHtml(item.statusLabel)}</b></header><h3>${escapeHtml(item.feature)}</h3><p>${escapeHtml(item.body)}</p><footer><small>${formatDate(item.createdAt)} · ${escapeHtml(item.appVersion)}</small><span>${escapeHtml(item.contextLabel)}</span></footer></article>`).join(""):empty("还没有提交记录。")
}
async function loadFeedback(){
  if(!$("#feedback-list"))return false;
  const requestSerial=++feedbackRequestSerial,owner=currentUser?.id,session=sessionSerial;
  try{const items=await listAllV1("/api/v1/feedback");if(requestSerial!==feedbackRequestSerial||owner!==currentUser?.id||session!==sessionSerial)return false;feedbackItems=items;renderFeedback();return true}
  catch(error){if(requestSerial===feedbackRequestSerial&&owner===currentUser?.id&&session===sessionSerial)$("#feedback-status").textContent=error.message;return false}
}
function renderExport(){
  if(!$("#export-summary"))return;
  const summary=exportManifest?.summary;
  $("#export-summary").innerHTML=summary?`<dl><div><dt>资源</dt><dd>${summary.resources}</dd></div><div><dt>附件</dt><dd>${summary.attachments}</dd></div><div><dt>附件引用</dt><dd>${summary.attachmentReferences}</dd></div><div><dt>待核对引用</dt><dd>${summary.orphanReferences}</dd></div></dl><p>快照版本 ${escapeHtml(String(exportManifest.snapshotVersion??""))} · 默认排除密钥与模型内部推理。</p>`:"<p>尚未生成快照。</p>"
}
async function loadExportManifest(){
  if(!$("#export-summary"))return false;
  try{exportManifest=(await requestV1("/api/v1/exports/account?format=manifest")).data;renderExport();$("#export-status").textContent="";return true}
  catch(error){$("#export-status").textContent=error.message;return false}
}
async function downloadExport(format){
  const status=$("#export-status");status.textContent="正在生成导出文件…";
  try{
    const file=(await requestV1(`/api/v1/exports/account?format=${encodeURIComponent(format)}`)).data;
    const descriptor=createDownloadDescriptor(file),url=URL.createObjectURL(descriptor.blob),link=document.createElement("a");
    link.href=url;link.download=descriptor.filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),0);
    status.textContent=`已生成 ${descriptor.filename}`
  }catch(error){status.textContent=error.message}
}
function render(){renderDate();renderOnboarding();renderSliders();renderDailyRecords();renderHealthUploader();renderCaptures();renderJournals();renderThoughts();renderStateChart();renderChat();renderReview();renderBooks();renderKeepsakes();renderQuotes();renderHome();renderTagComposer();renderCaptureTagComposer();renderCommentPanel();renderSettings();renderLocalTestSettings();renderArchitecture();renderCommercialization();renderNotifications();renderMine();renderActionsWorkspace();renderFeedback();renderExport()}
async function load(){const owner=currentUser?.id,session=sessionSerial;journalDraftRestored=false;aiCostPlan=null;aiCostStatistics=null;commercialStatistics=null;resetJournalForm();const [nextState,nextSettings,nextOnboardingSchema,nextLocalTestConfig,meta]=await Promise.all([request("/api/state"),request("/api/settings"),optionalRequest("/api/onboarding/schema"),optionalRequest("/api/local-test-mode"),request("/api/meta")]);if(owner!==currentUser?.id||session!==sessionSerial)return false;replaceState(nextState);llmSettings=nextSettings;onboardingSchema=nextOnboardingSchema;localTestConfig=nextLocalTestConfig;appVersion=meta.version||"development";releaseVersion=meta.releaseVersion||releaseVersion;onboardingHydrated=false;notificationUnreadCount=Number(state.notificationUnread)||0;render();restoreDurableDrafts();await loadActionsWorkspace();scheduleNotificationPoll();return true}
function setAuthTab(tab){
  if(authBusy)return;
  $$("[data-auth-tab]").forEach(button=>{const active=button.dataset.authTab===tab;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active))});
  $("#login-form").hidden=tab!=="login";$("#register-form").hidden=tab!=="register";$("#auth-status").textContent="";
  (tab==="login"?$("#login-form"):$("#register-form")).elements.username.focus();
}
function setAuthBusy(value){authBusy=value;$$(".auth-form input,.auth-form button,[data-auth-tab]").forEach(control=>control.disabled=value)}
function invalidatePageLoads(){
  actionsRequestSerial+=1;feedbackRequestSerial+=1;statisticsRequestSerial+=1;aiCostRequestSerial+=1;commercialRequestSerial+=1;
  activeAnswerTaskId=++answerTaskSerial;healthParseSerial+=1;latestHealthRequest=0;bookParseSerial+=1;clearTimeout(notificationTimer);
  discoveryController?.reset();backgroundResultController?.reset();refreshCoordinator.reset();
}
function clearPrivateSessionState(){
  resetState();llmSettings={provider:"deepseek",profiles:structuredClone(defaultLlmProfiles),scenarios:{...defaultLlmScenarios},automaticAnswers:{thoughtAnswer:false},hasApiKey:false,keyHint:""};
  activeAnswerTaskId=++answerTaskSerial;clearTimeout(notificationTimer);answerDraft="";answerReasoningDraft="";trashItems=[];aiCostPlan=null;aiCostStatistics=null;commercialStatistics=null;statisticsData=null;localTestConfig=null;onboardingSchema=null;onboardingMode="quick";onboardingDraftAnswers={};onboardingHydrated=false;notificationUnreadCount=0;actionsSnapshot={actions:[],habits:[],habitCheckins:[]};feedbackItems=[];exportManifest=null;appVersion="0.2.0";homeMemoryKeys=[];homeMemoryByKey=new Map();closeHomeEditors({restoreFocus:false});invalidatePageLoads();draftTags=[];captureDraftTags=[];pendingSelection=null;activeCommentRoot="";activeAnnotationId="";activeShenjiComposer="";
  healthParseSerial+=1;latestHealthRequest=0;healthPreviewUrls.forEach(url=>URL.revokeObjectURL(url));healthPreviewUrls=[];healthFiles={sleep:[],heartRate:[],weight:[],exercise:[]};
  bookParseSerial+=1;for(const url of Object.values(bookPreviewUrls))if(url)URL.revokeObjectURL(url);bookPreviewUrls={cover:"",recognition:""};pendingBookImages={cover:null,recognition:null};editingBookId="";activeBookId="";activeBookFeatureNoteId="";bookCreatorOpen=false;bookDetailCondensed=false;
  keepsakeEditor.segmentSerial+=1;keepsakeEditor.file=null;keepsakeEditor.sourceDataUrl="";keepsakeEditor.sourceImage=null;keepsakeEditor.sourceCanvas=null;keepsakeEditor.maskCanvas=null;keepsakeEditor.autoBase=null;keepsakeEditor.history=[];
  for(const key of Object.keys(contentImageDrafts))resetContentImageEditor(key);
  $$("main form").forEach(form=>{form.reset();delete form.dataset.requestId});$$(".modal-backdrop").forEach(modal=>modal.hidden=true);$("#comment-panel").hidden=true;$("#selection-tools").hidden=true;
  Object.keys(dailyTypeMeta).forEach(resetDailyForm);resetHealthImages();
}
function showAuthGate(){
  const localTestEnabled=Boolean(localTestConfig?.enabled);rotateSession();clearPrivateSessionState();currentUser=null;document.body.classList.add("auth-locked");$("#auth-gate").hidden=false;$("#account-control").hidden=true;$("#account-authenticated").hidden=true;const registerTab=$('[data-auth-tab="register"]');if(registerTab)registerTab.hidden=localTestEnabled;
}
function renderAccountIdentity(){
  const username=currentUser?.username||"";
  $("#account-name").textContent=username;$("#account-current-name").textContent=username;$("#account-page-name").textContent=username;$("#account-username").value=username;
}
function prepareUserSession(user,authRequired){
  rotateSession();currentUser=user;document.body.classList.add("auth-locked");$("#account-control").hidden=!authRequired;$("#account-authenticated").hidden=!authRequired;$("#account-local-mode").hidden=authRequired;renderAccountIdentity();
  if(authRequired)$(".local-note").textContent="● 账户数据已隔离";
}
function revealUserSession(){document.body.classList.remove("auth-locked");$("#auth-gate").hidden=true}
async function activateUserSession(user,authRequired){
  prepareUserSession(user,authRequired);
  try{if(!await load())return false;revealUserSession();return true}
  catch(error){if(currentUser?.id===user?.id)showAuthGate();throw error}
}
async function authRequest(endpoint,payload,method="POST"){
  return apiClient.request(endpoint,{method,body:JSON.stringify(payload||{})},{authGate:false,fallback:"账户操作失败"});
}
async function bootstrap(){
  let session,testConfig=null;
  try{[session,testConfig]=await Promise.all([apiClient.request("/api/auth/me",{headers:{accept:"application/json"}},{authGate:false,allowUnauthorized:true}),optionalRequest("/api/local-test-mode")])}catch{showAuthGate();$("#auth-status").textContent="无法连接服务，请检查网络后重试。";return}
  if(!session.authenticated){showAuthGate();localTestConfig=testConfig;const registerTab=$('[data-auth-tab="register"]');if(registerTab)registerTab.hidden=Boolean(testConfig?.enabled);setAuthTab(testConfig?.enabled||session.userCount?"login":"register");return}
  await activateUserSession(session.user,session.authRequired);
}
const refreshState=(domains,options={})=>refreshCoordinator.refresh(domains,options);
backgroundResultController=createBackgroundResultController({
  loadResult:async task=>backgroundResultFromSnapshot(state,task)||(await request(`/api/ai-tasks/${encodeURIComponent(task.id)}/result`)).result,
  applyResult:({task,target,result})=>{
    if(backgroundResultFromSnapshot(state,task))return true;
    const merged=mergeBackgroundTaskResult(state,task,result);if(!merged.changed)return false;
    replaceState(merged.value);
    if(target.kind==="annotationShenji"){const annotation=annotationForTask(target);if(annotation&&activeCommentRoot===commentRootKey(target.resourceType,target.targetId))refreshAnnotationCard(annotation);return true}
    if(target.kind==="contentImageUnderstanding"){
      if(target.contentTargetType==="capture"){renderCaptures();return true}
      if(target.contentTargetType==="comment"){const annotation=annotationForTask(target);if(annotation&&activeCommentRoot===commentRootKey(target.resourceType,target.targetId))refreshAnnotationCard(annotation);return true}
      const block=target.contentTargetType==="thoughtBlock"?state.thoughts.find(item=>item.id===target.contentTargetId):null;
      return patchThoughtTaskTarget({...target,targetId:target.contentTargetType==="thoughtRoot"?target.contentTargetId:block?.relatedTo})
    }
    return patchThoughtTaskTarget(target)
  },
  captureViewState:()=>({x:window.scrollX,y:window.scrollY,commentScroll:$("#comment-panel-list")?.scrollTop||0}),
  restoreViewState:view=>{if(!view)return;window.scrollTo(view.x,view.y);if($("#comment-panel-list"))$("#comment-panel-list").scrollTop=view.commentScroll},
  onError:error=>showToast(`后台结果同步失败：${error.message}`,"error")
});
subscribeState((next,wanted,thoughtOptions)=>{notificationUnreadCount=Number(next.notificationUnread)||notificationUnreadCount;if(wanted.has("dailyRecords"))renderDailyRecords();if(wanted.has("captures")){renderCaptures();renderCaptureTagComposer()}if(wanted.has("journals"))renderJournals();if(wanted.has("thoughts")){renderThoughts(thoughtOptions);renderTagComposer();renderCaptureTagComposer();renderHomeMemories()}if(wanted.has("checkins")){renderStateChart();renderSliders();renderHomeMood()}if(wanted.has("chat"))renderChat();if(wanted.has("review"))renderReview();if(wanted.has("books")){renderBooks();renderHomeMemories();if(activeCommentRoot.startsWith("book:"))renderCommentPanel()}if(wanted.has("keepsakes")){renderKeepsakes();renderHomeKeepsake()}if(wanted.has("quotes")){renderQuotes();renderHomeMemories()}if(wanted.has("comments"))renderCommentPanel();renderNotifications()});
function setAnswerModalStep(step){const order=["context","thinking","answer","done"],current=order.indexOf(step);$$("#ai-answer-progress li").forEach((item,index)=>{item.classList.toggle("active",index===current);item.classList.toggle("done",index<current||(step==="done"&&index===current))})}
function closeAnswerModal(){const modal=$("#ai-answer-modal"),busy=modal.dataset.busy==="true";modal.hidden=true;if(busy)showToast("回答继续在后台生成，完成后会提醒。")}
async function runAnswerInModal({title,scene="thoughtAnswer",requestCall,onDone,isCurrent=()=>true}){
  const taskId=++answerTaskSerial,modal=$("#ai-answer-modal"),result=$("#ai-answer-result"),output=$("#ai-answer-output"),reasoningBox=$("#ai-answer-reasoning"),reasoningContent=$("#ai-answer-reasoning-content"),reasoningState=$("#ai-answer-reasoning-state"),status=$("#ai-answer-status");
  activeAnswerTaskId=taskId;modal.hidden=false;modal.dataset.busy="true";$("#ai-answer-title").textContent=title;output.hidden=true;result.innerHTML="";reasoningBox.hidden=true;reasoningBox.open=true;reasoningContent.replaceChildren();reasoningState.textContent="生成中";status.className="status answer-modal-status";status.textContent="正在整理个人语境与完整问答链…";setAnswerModalStep("context");
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(activeAnswerTaskId===taskId){setAnswerModalStep("thinking");status.textContent=`${modelName(scene)} 正在思考…`}
  let reasoning="",answer="",renderFrame=0,answerStarted=false;
  const renderAnswer=()=>{renderFrame=0;if(activeAnswerTaskId!==taskId)return;result.innerHTML=renderMarkdown(answer);renderLatex(result);result.scrollIntoView({block:"nearest"})};
  const scheduleAnswerRender=()=>{if(!renderFrame)renderFrame=requestAnimationFrame(renderAnswer)};
  const onEvent=event=>{
    if(activeAnswerTaskId!==taskId)return;
    if(event.type==="reasoning"){const delta=event.delta||"",stickToBottom=reasoningContent.scrollHeight-reasoningContent.scrollTop-reasoningContent.clientHeight<32;reasoning+=delta;reasoningBox.hidden=false;reasoningBox.open=true;reasoningContent.append(document.createTextNode(delta));if(stickToBottom)reasoningContent.scrollTop=reasoningContent.scrollHeight;setAnswerModalStep("thinking");return}
    if(event.type==="content"){answer+=event.delta||"";if(!answerStarted){answerStarted=true;reasoningState.textContent=reasoning?"思考完成":"未返回思考过程";reasoningBox.open=false;reasoningBox.hidden=!reasoning;output.hidden=false;setAnswerModalStep("answer");status.textContent="正在生成回答…"}scheduleAnswerRender()}
  };
  try{
    const response=await requestCall(onEvent),finalAnswer=response.draft||response.content||response.answer||answer;
    if(response.reasoningContent&&!reasoning){reasoning=response.reasoningContent;reasoningContent.textContent=reasoning}
    answer=finalAnswer;if(renderFrame)cancelAnimationFrame(renderFrame);
    if(activeAnswerTaskId===taskId){renderAnswer();output.hidden=!answer;if(reasoning){reasoningContent.innerHTML=renderMarkdown(reasoning);renderLatex(reasoningContent);reasoningState.textContent="思考完成";reasoningBox.open=false}if(isCurrent()&&onDone)await onDone(response);setAnswerModalStep("done");status.textContent=isCurrent()?"回答已生成并保存。":"回答已生成，但目标输入已经变化，未自动写入。";modal.dataset.busy="false"}
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
const pageEffects={...createPageEffects({
  syncCaptureOverflow,
  syncQuoteOverflow,
  setupQuoteBubbleScroll,
  stopQuoteBubbleScroll,
  loadStatistics,
  loadAiCostPlan,
  loadCommercialization,
  loadNotifications,
  scheduleNotificationPoll,
  loadTrash
}),today:()=>void loadActionsWorkspace(),discovery:()=>void loadDiscovery(),feedback:()=>void loadFeedback(),export:()=>void loadExportManifest()};
({switchView}=createPageRouter({query:$,queryAll:$$,effects:pageEffects}));
$("#home-open-thought").addEventListener("click",()=>openHomeEditor("thought"));
$("#home-record-state").addEventListener("click",()=>openHomeEditor("state"));
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
const discoveryQuery=input=>{
  const params=new URLSearchParams();
  if(input.query)params.set("q",input.query);
  for(const genre of input.genres||[])params.append("genre",genre);
  for(const type of input.types||[])params.append("type",type);
  if(input.freshOnly)params.set("fresh","1");
  if(input.cursor)params.set("cursor",input.cursor);
  params.set("limit","20");
  return params.toString()
};
function openDiscoveryItem(item){
  const route=item?.route||{view:"thoughts",resourceType:"thought",resourceId:item?.id||""},id=route.resourceId;
  if(route.view==="books"){activeBookId=id;activeBookFeatureNoteId=String(route.targetKey||"").replace(/^note:/,"");pendingBookNoteId=activeBookFeatureNoteId;switchView("books");renderBooks();return}
  switchView(route.view||"thoughts");
  const selector={thought:`[data-chain-id="${CSS.escape(id)}"]`,capture:`[data-capture-id="${CSS.escape(id)}"]`,journal:`[data-journal-id="${CSS.escape(id)}"]`,quote:`[data-quote-id="${CSS.escape(id)}"]`}[route.resourceType];
  requestAnimationFrame(()=>{const target=document.querySelector(selector||"");if(target instanceof HTMLDetailsElement)target.open=true;target?.scrollIntoView({behavior:"smooth",block:"center"})})
}
discoveryController=createThoughtDiscoveryController({
  transport:{
    async search(input){const result=await requestV1(`/api/v1/discovery?${discoveryQuery(input)}`);return{items:result.data,nextCursor:result.meta.nextCursor||"",total:result.meta.total||0,untracedCount:result.meta.untracedCount||0,totalUntracedCount:result.meta.totalUntracedCount||0}},
    async markRead(id){const item=discoveryController.getState().items.find(value=>value.id===id),result=await requestV1(`/api/v1/thought-chains/${encodeURIComponent(id)}/discovery`,{method:"PATCH",headers:{"if-match":`"${item?.status?.version||1}"`},body:JSON.stringify({action:"read"})});return{value:result.data}},
    async snooze(id,until){const item=discoveryController.getState().items.find(value=>value.id===id),result=await requestV1(`/api/v1/thought-chains/${encodeURIComponent(id)}/discovery`,{method:"PATCH",headers:{"if-match":`"${item?.status?.version||1}"`},body:JSON.stringify({action:"snooze",until})});return{value:result.data}},
    async openRandomDoor(input){const result=await requestV1(`/api/v1/discovery/random?${discoveryQuery(input)}`);return{value:result.data,total:result.meta.total||0}}
  },
  onNavigate:openDiscoveryItem
});
discoveryController.setGenres(DISCOVERY_GENRES,{reload:false});
discoveryController.subscribe(renderDiscovery);
$("#discovery-form").addEventListener("submit",event=>{
  event.preventDefault();
  const form=event.currentTarget,types=[...form.elements.type].filter(input=>input.checked).map(input=>input.value),genres=[...form.elements.genre].filter(input=>input.checked).map(input=>input.value);
  void discoveryController.setFilters({query:form.elements.query.value,types,genres,freshOnly:form.elements.freshOnly.checked}).catch(error=>showToast(error.message,"error"))
});
$("#discovery-more").addEventListener("click",()=>void discoveryController.loadMore().catch(error=>showToast(error.message,"error")));
$("#discovery-random").addEventListener("click",()=>void discoveryController.openRandomDoor().catch(error=>showToast(error.message,"error")));
$("#discovery-list").addEventListener("click",async event=>{
  const open=event.target.closest("[data-discovery-open]"),snooze=event.target.closest("[data-discovery-snooze]"),action=event.target.closest("[data-discovery-action]");
  const itemFor=key=>discoveryController.getState().items.find(value=>(value.key||`thought:${value.id}`)===key);
  if(action){const item=itemFor(action.dataset.discoveryAction);if(!item)return;action.dataset.requestId||=crypto.randomUUID();action.disabled=true;try{await runActionCommand(buildCreateActionCommand({title:plainPreview(item.title||item.question?.content||"回访记录"),priority:"none",sourceRef:{type:item.resourceType||"thought",id:item.resourceId||item.id,label:"寻迹"}}),{idempotencyKey:action.dataset.requestId});delete action.dataset.requestId;showToast("已转为行动")}catch(error){showToast(error.message,"error")}finally{action.disabled=false}}
  if(open){const item=itemFor(open.dataset.discoveryOpen);if(!item)return;open.disabled=true;try{if((item.genre||"thought")==="thought")await discoveryController.markRead(item.id);openDiscoveryItem(item)}catch(error){showToast(error.message,"error")}finally{open.disabled=false}}
  if(snooze){const item=itemFor(snooze.dataset.discoverySnooze);if(!item)return;snooze.disabled=true;const until=new Date(Date.now()+86400000).toISOString();try{await discoveryController.snooze(item.id,until);showToast("已安排明天再看")}catch(error){showToast(error.message,"error")}finally{snooze.disabled=false}}
});
$("#action-form").addEventListener("submit",async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#action-status"),submittedDraft=formSnapshot(form);form.dataset.requestId||=crypto.randomUUID();button.disabled=true;status.textContent="正在添加…";
  try{await runActionCommand(buildCreateActionCommand({title:form.elements.title.value,priority:form.elements.priority.value}),{idempotencyKey:form.dataset.requestId});delete form.dataset.requestId;if(formSnapshot(form)===submittedDraft){form.reset();status.textContent=""}else status.textContent="提交时的行动已保存；等待期间的新输入已保留。";showToast("行动已添加")}
  catch(error){status.textContent=error.message}
  finally{button.disabled=false}
});
$("#action-form").addEventListener("input",event=>{delete event.currentTarget.dataset.requestId});
$("#habit-form").addEventListener("submit",async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#habit-status"),submittedDraft=formSnapshot(form),cadence=form.elements.cadence.value,target=cadence==="daily"?1:Number(form.elements.target.value);form.dataset.requestId||=crypto.randomUUID();button.disabled=true;status.textContent="正在添加…";
  try{await runActionCommand(buildCreateHabitCommand({title:form.elements.title.value,frequency:{cadence,target}}),{idempotencyKey:form.dataset.requestId});delete form.dataset.requestId;if(formSnapshot(form)===submittedDraft){form.reset();form.elements.target.value="1";status.textContent=""}else status.textContent="提交时的习惯已保存；等待期间的新输入已保留。";showToast("习惯已添加")}
  catch(error){status.textContent=error.message}
  finally{button.disabled=false}
});
$("#habit-form").addEventListener("input",event=>{delete event.currentTarget.dataset.requestId});
$("#habit-form").elements.cadence.addEventListener("change",event=>{const target=$("#habit-form").elements.target,daily=event.currentTarget.value==="daily";target.disabled=daily;if(daily)target.value="1";else if(Number(target.value)<1)target.value="3"});
document.addEventListener("click",async event=>{
  const button=event.target.closest("[data-action-start],[data-action-complete],[data-action-reopen],[data-action-edit],[data-action-delete],[data-habit-checkin],[data-habit-uncheck],[data-habit-toggle],[data-habit-adjust],[data-habit-delete]");
  if(!button)return;
  let command,options={};
  if(button.dataset.actionStart)command=buildSetActionStatusCommand(button.dataset.actionStart,"doing",button.dataset.version);
  else if(button.dataset.actionComplete)command=buildCompleteActionCommand(button.dataset.actionComplete,button.dataset.version);
  else if(button.dataset.actionReopen)command=buildUndoActionCompletionCommand(button.dataset.actionReopen,button.dataset.version);
  else if(button.dataset.actionEdit){const item=actionsSnapshot.actions.find(value=>value.id===button.dataset.actionEdit),title=prompt("修改行动：",item?.title||"");if(!title?.trim())return;const priority=prompt("优先级：P0 / P1 / P2 / P3 / none",item?.priority||"none");if(!priority)return;command=buildUpdateActionCommand(button.dataset.actionEdit,{title,priority},button.dataset.version)}
  else if(button.dataset.actionDelete){if(!confirm("将这项行动移入回收站？"))return;command=buildDeleteActionCommand(button.dataset.actionDelete,button.dataset.version)}
  else if(button.dataset.habitCheckin){let feeling=button.dataset.feeling;if(feeling===undefined){const answer=prompt("今天完成时的感受（可留空）：","");if(answer===null)return;feeling=answer;button.dataset.feeling=feeling}button.dataset.requestId||=crypto.randomUUID();options.idempotencyKey=button.dataset.requestId;command=buildHabitCheckinCommand(button.dataset.habitCheckin,{occurredOn:currentLocalDate,feeling})}
  else if(button.dataset.habitUncheck){if(!confirm("撤销今天的习惯打卡？"))return;command=buildDeleteHabitCheckinCommand(button.dataset.habitUncheck,button.dataset.version)}
  else if(button.dataset.habitToggle)command=buildSetHabitEnabledCommand(button.dataset.habitToggle,button.dataset.enabled!=="true",button.dataset.version);
  else if(button.dataset.habitAdjust){const habit=actionsSnapshot.habits.find(value=>value.id===button.dataset.habitAdjust),note=prompt("记录这次调整：");if(!note?.trim()||!habit)return;const cadence=prompt("频次：daily（每天）或 weekly（每周）",habit.frequency?.cadence||"daily");if(!["daily","weekly"].includes(cadence))return showToast("频次只能是 daily 或 weekly","error");const target=cadence==="weekly"?Number(prompt("新的每周目标天数：",String(habit.frequency?.target||3))):1;if(!Number.isInteger(target)||target<1||target>7)return showToast("目标天数必须是 1 到 7","error");command=buildHabitAdjustmentCommand(button.dataset.habitAdjust,{note,frequency:{cadence,target}},button.dataset.version)}
  else if(button.dataset.habitDelete){if(!confirm("将这个习惯及其打卡记录移入回收站？"))return;command=buildDeleteHabitCommand(button.dataset.habitDelete,button.dataset.version)}
  button.disabled=true;try{await runActionCommand(command,options);delete button.dataset.requestId;delete button.dataset.feeling;showToast("已更新")}catch(error){showToast(error.message,"error")}finally{button.disabled=false}
});
$("#feedback-form").elements.includeContext.addEventListener("change",event=>{const field=$("#feedback-context-field");field.hidden=!event.currentTarget.checked;if(event.currentTarget.checked&&!event.currentTarget.form.elements.contextSummary.value)event.currentTarget.form.elements.contextSummary.value=`页面：产品反馈；应用版本：${appVersion}`});
$("#feedback-form").addEventListener("submit",async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#feedback-status"),submittedDraft=formSnapshot(form),payload=feedbackSubmissionPayload({type:form.elements.type.value,feature:form.elements.feature.value,body:form.elements.body.value,includeContext:form.elements.includeContext.checked,contextSummary:form.elements.contextSummary.value},{appVersion});form.dataset.requestId||=crypto.randomUUID();button.disabled=true;status.textContent="正在提交…";
  try{await requestV1("/api/v1/feedback",{method:"POST",headers:{"idempotency-key":form.dataset.requestId},body:JSON.stringify(payload)});delete form.dataset.requestId;const unchanged=formSnapshot(form)===submittedDraft;if(unchanged){form.reset();$("#feedback-context-field").hidden=true}const refreshed=await loadFeedback();status.textContent=!refreshed?"反馈已提交，但列表刷新失败，请稍后重试同步。":unchanged?"反馈已提交。":"提交时的反馈已保存；等待期间的新输入已保留。";showToast("反馈已提交")}
  catch(error){status.textContent=error.message}
  finally{button.disabled=false}
});
$("#feedback-form").addEventListener("input",event=>{delete event.currentTarget.dataset.requestId});
document.addEventListener("click",event=>{const button=event.target.closest("[data-export-format]");if(button)void downloadExport(button.dataset.exportFormat)});
function openChainEditor(id){const chain=thoughtChains().find(x=>x.question.id===id);if(!chain)return;$("#edit-chain-id").value=id;$("#edit-chain-datetime").value=toLocalDateTimeInput(eventTimestamp(chain.question));$("#edit-chain-question").value=chain.question.content;$("#edit-chain-tags").value=(chain.question.tags||[]).join(" ");$("#edit-chain-status").textContent="这里只修改主题。初步想法、回答与记录请在各自内容块上编辑。";$("#edit-chain-modal").hidden=false;$("#edit-chain-question").focus()}
function openThoughtBlockEditor(rootId,type="record",blockId=""){
  const item=blockId?state.thoughts.find(value=>value.id===blockId&&value.relatedTo===rootId):null,modal=$("#thought-block-modal"),select=$("#thought-block-type");
  $("#thought-block-root-id").value=rootId;$("#thought-block-id").value=item?.id||"";$("#thought-block-form").dataset.version=String(item?.version||1);select.value=item?.type||type;select.disabled=Boolean(item);resetOccurrenceInput($("#thought-block-datetime"),item);$("#thought-block-content").value=item?.content||"";resetContentImageEditor("thoughtBlock",item?.attachmentPaths||[]);$("#thought-block-title").textContent=item?"编辑内容":`新增${select.options[select.selectedIndex].text}`;$("#thought-block-status").textContent="";modal.hidden=false;$("#thought-block-content").focus()
}
function openCheckinEditor(id){
  const item=state.checkins.find(value=>value.id===id);if(!item)return;
  $("#edit-checkin-id").value=id;$("#edit-checkin-datetime").value=persistedDateTimeInput(item);$("#edit-checkin-factors").value=(item.factors||[]).join(" ");$("#edit-checkin-status").textContent="";
  $("#edit-checkin-metrics").innerHTML=Object.entries(metricConfig()).map(([key,cfg])=>{const value=Number(metricValue(item,key,cfg.custom))||3,note=item.notes?.[key]||"",options=cfg.anchors.map((anchor,index)=>`<option value="${index+1}" ${value===index+1?"selected":""}>${index+1} · ${escapeHtml(anchor)}</option>`).join("");return `<label class="edit-checkin-metric"><span>${escapeHtml(cfg.label)}</span><select data-edit-checkin-metric="${escapeHtml(key)}" data-custom="${cfg.custom?"1":"0"}">${options}</select><input data-edit-checkin-note="${escapeHtml(key)}" value="${escapeHtml(note)}" maxlength="800" placeholder="备注（可空）"></label>`}).join("");
  $("#edit-checkin-modal").hidden=false;$("#edit-checkin-factors").focus();
}

document.addEventListener("mouseup",()=>setTimeout(showSelectionCommentButton));
document.addEventListener("touchend",()=>setTimeout(showSelectionCommentButton,180),{passive:true});
document.addEventListener("selectionchange",()=>{if(!window.getSelection()?.isCollapsed)setTimeout(showSelectionCommentButton,80)});
document.addEventListener("keyup",e=>{if(e.key.startsWith("Arrow")||e.key==="Shift")setTimeout(showSelectionCommentButton)});
for(const eventName of ["wheel","pointerdown","pointermove","touchstart","touchmove","keydown"])document.addEventListener(eventName,event=>{const viewport=event.target.closest?.(".quote-bubble p.is-auto-scrolling");if(viewport)deferQuoteBubbleScroll(viewport)},{passive:true});
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&$("#view-quotes").classList.contains("active"))setupQuoteBubbleScroll()});
window.addEventListener("scroll",()=>{$("#selection-tools").hidden=true;syncBookDetailCondensed()},{passive:true});
window.addEventListener("resize",()=>requestAnimationFrame(()=>{syncCaptureOverflow();syncThoughtBlockOverflow();syncQuoteOverflow();setupQuoteBubbleScroll();setupBookTitlePans()}),{passive:true});
window.visualViewport?.addEventListener("resize",()=>{$("#selection-tools").hidden=true},{passive:true});
window.visualViewport?.addEventListener("scroll",()=>{$("#selection-tools").hidden=true},{passive:true});
document.addEventListener("click",e=>{
  const card=e.target.closest(".capture-item");if(!card?.classList.contains("is-expandable"))return;
  const toggle=e.target.closest("[data-capture-expand]");
  if(!toggle&&e.target.closest("button,a,input,textarea,select,.comment-anchor"))return;
  if(!toggle&&!window.getSelection()?.isCollapsed)return;
  toggleCaptureCard(card);
});
document.addEventListener("click",e=>{const button=e.target.closest("[data-quote-expand]");if(!button)return;const viewport=button.closest(".quote-entry-card")?.querySelector(".quote-content-viewport");if(!viewport)return;const expanded=!viewport.classList.contains("expanded");viewport.classList.toggle("expanded",expanded);button.textContent=expanded?"收起":"展开";button.setAttribute("aria-expanded",String(expanded))});
document.addEventListener("click",e=>{const button=e.target.closest("[data-thought-block-expand]");if(!button)return;const card=button.closest(".thought-content-block");if(!card?.classList.contains("is-collapsible"))return;const expanded=!card.classList.contains("is-expanded");card.classList.toggle("is-expanded",expanded);button.setAttribute("aria-expanded",String(expanded));button.querySelector("span").textContent=expanded?"收起":"展开全文";if(!expanded)card.scrollIntoView({block:"nearest"})});
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
$("#notifications-read-all").addEventListener("click",async e=>{const button=e.currentTarget;button.disabled=true;try{await request("/api/notifications/read-all",{method:"POST",body:"{}"});await loadNotifications()}catch(error){$("#notifications-status").textContent=error.message}finally{button.disabled=false}});
document.addEventListener("click",async e=>{
  const read=e.target.closest("[data-notification-read]"),open=e.target.closest("[data-notification-open]"),retry=e.target.closest("[data-task-retry]");if(!read&&!open&&!retry)return;
  try{
    if(retry){retry.disabled=true;await request(`/api/ai-tasks/${retry.dataset.taskRetry}/retry`,{method:"POST",body:"{}"});await loadNotifications();scheduleNotificationPoll();showToast("任务已重新排队");return}
    const id=(read||open).dataset.notificationId||read?.dataset.notificationRead;if(id)await request(`/api/notifications/${id}/read`,{method:"PATCH",body:"{}"});
    if(open){const task=(state.aiTasks||[]).find(item=>item.id===open.dataset.notificationTask),notification=(state.notifications||[]).find(item=>item.id===id);await openAiTaskTarget(task,notification)}
    else await loadNotifications()
  }catch(error){$("#notifications-status").textContent=error.message}
});
document.addEventListener("click",async e=>{
  const button=e.target.closest("[data-delete-checkin],[data-chat-delete],[data-experiment-delete],[data-analysis-delete],[data-book-delete]");if(!button)return;
  const target=button.dataset.deleteCheckin?{url:`/api/checkins/${button.dataset.deleteCheckin}`,domains:["checkins","review"],label:"状态"}:button.dataset.chatDelete?{url:`/api/chats/${button.dataset.chatDelete}`,domains:"chat",label:"对话"}:button.dataset.experimentDelete?{url:`/api/experiments/${button.dataset.experimentDelete}`,domains:"review",label:"实验"}:button.dataset.analysisDelete?{url:`/api/analyses/${button.dataset.analysisDelete}`,domains:"review",label:"复盘"}:{url:`/api/books/${button.dataset.bookDelete}`,domains:["books","review"],label:"书目"};
  if(!confirm(`将这条${target.label}移入回收站？`))return;
  button.disabled=true;
  try{await request(target.url,{method:"DELETE"});if(button.dataset.bookDelete){activeBookId="";activeBookFeatureNoteId="";bookDetailCondensed=false}await refreshState(target.domains);showToast(`${target.label}已移入回收站`)}
  catch(error){showToast(error.message,"error");button.disabled=false}
});
document.addEventListener("click",async e=>{
  const add=e.target.closest("[data-thought-block-add]"),edit=e.target.closest("[data-thought-block-edit]"),remove=e.target.closest("[data-thought-block-delete]");
  if(add)return openThoughtBlockEditor(add.dataset.rootId,add.dataset.thoughtBlockAdd);
  if(edit){const item=state.thoughts.find(value=>value.id===edit.dataset.thoughtBlockEdit);if(item)return openThoughtBlockEditor(edit.dataset.rootId,item.type,item.id)}
  if(!remove)return;
  if(!confirm("将这条思绪内容移入回收站？"))return;remove.disabled=true;
  try{await request(`/api/thoughts/${remove.dataset.thoughtBlockDelete}`,{method:"DELETE"});await refreshState(["thoughts","review"],{chainId:remove.dataset.rootId});showToast("思绪内容已移入回收站")}
  catch(error){showToast(error.message,"error");remove.disabled=false}
});
$("#selection-tools").addEventListener("mousedown",e=>e.preventDefault());
$("#selection-tools").addEventListener("click",async e=>{const action=e.target.closest("[data-selection-action]")?.dataset.selectionAction;if(!action||!pendingSelection)return;const selection={...pendingSelection};$("#selection-tools").hidden=true;if(action==="comment"){resetContentImageEditor("comment");openCommentPanel(selection.rootKey);$("#comment-text").focus();return}if(action==="quote"){openSelectionQuoteModal(selection);return}try{const annotation=await request(commentEndpoint(selection.rootKey),{method:"POST",body:JSON.stringify({...selection,kind:action,text:""})}),root=commentRoot(selection.rootKey);if(root){root.annotations||=[];root.annotations.push(annotation)}clearThoughtTracePending(selection.rootKey);pendingSelection=null;window.getSelection()?.removeAllRanges();applySingleCommentAnchor(selection.rootKey,annotation);showToast(action==="emphasis"?"已添加红色加重":"已添加绿色划线")}catch(err){showToast(err.message,"error")}});
$("#comment-panel-close").addEventListener("click",()=>{activeCommentRoot="";activeAnnotationId="";activeShenjiComposer="";pendingSelection=null;resetContentImageEditor("comment");$("#comment-panel").hidden=true;$("#selection-tools").hidden=true;window.getSelection()?.removeAllRanges()});
$("#comment-composer").addEventListener("submit",async e=>{e.preventDefault();if(!pendingSelection)return;const button=e.currentTarget.querySelector('button[type="submit"]'),status=$("#comment-status"),selection={...pendingSelection};let uploadedPaths=[];button.disabled=true;status.textContent="正在保存…";try{const submission=await contentImagePaths("comment");uploadedPaths=submission.uploadedPaths;const original=imageRecordPayload({content:$("#comment-text").value,attachmentPaths:submission.attachmentPaths}),annotation=await request(commentEndpoint(selection.rootKey),{method:"POST",body:JSON.stringify({...selection,text:original.content,attachmentPaths:original.attachmentPaths})}),root=commentRoot(selection.rootKey);if(root){root.annotations||=[];root.annotations.push(annotation)}clearThoughtTracePending(selection.rootKey);activeAnnotationId=annotation.id;$("#comment-text").value="";resetContentImageEditor("comment");pendingSelection=null;window.getSelection()?.removeAllRanges();applySingleCommentAnchor(selection.rootKey,annotation);renderCommentPanel();showToast("评论已保存")}catch(err){await discardContentImageUploads("comment",uploadedPaths);status.textContent=err.message}finally{button.disabled=false}});
document.addEventListener("click",e=>{const anchor=e.target.closest(".comment-anchor");if(!anchor)return;pendingSelection=null;openCommentPanel(anchor.dataset.commentRoot,anchor.dataset.annotationId)});
document.addEventListener("submit",async e=>{const form=e.target.closest("[data-comment-reply]");if(!form)return;e.preventDefault();const input=form.querySelector("input"),button=form.querySelector("button"),annotationId=form.dataset.commentReply;button.disabled=true;try{const reply=await request(commentEndpoint(activeCommentRoot,`/${annotationId}/replies`),{method:"POST",body:JSON.stringify({text:input.value})}),root=commentRoot(activeCommentRoot),annotation=root?.annotations?.find(item=>item.id===annotationId);if(annotation){annotation.replies||=[];annotation.replies.push(reply);activeAnnotationId=annotationId;refreshAnnotationCard(annotation)}showToast("回复已保存")}catch(err){showToast(err.message,"error");button.disabled=false}});
document.addEventListener("click",e=>{const button=e.target.closest("[data-shenji-toggle]");if(!button)return;const id=button.dataset.shenjiToggle;activeShenjiComposer=activeShenjiComposer===id?"":id;document.querySelectorAll("[data-shenji-form]").forEach(form=>form.hidden=form.dataset.shenjiForm!==activeShenjiComposer);const form=button.closest(".comment-card")?.querySelector("[data-shenji-form]");if(form&&!form.hidden)form.elements.message.focus()});
document.addEventListener("click",async e=>{
  const button=e.target.closest("[data-annotation-menu]");if(!button)return;
  const root=commentRoot(activeCommentRoot),annotation=root?.annotations?.find(item=>item.id===button.dataset.annotationId);if(!annotation)return;
  const action=button.dataset.annotationMenu;
  try{
    if(action==="copy-quote"||action==="copy-comment"){await copyAnnotationContent(annotation,action==="copy-comment"?"comment":"quote",value=>navigator.clipboard.writeText(value));showToast("已复制");return}
    const kind={ "to-comment":"comment","to-highlight":"highlight","to-emphasis":"emphasis" }[action];if(!kind)return;
    const text=kind==="comment"&&!annotation.text?prompt("写下这条评论的内容",""):"";
    if(kind==="comment"&&!String(text||annotation.text||"").trim())return;
    const updated=await request(commentEndpoint(activeCommentRoot,`/${annotation.id}/convert`),{method:"PATCH",body:JSON.stringify({kind,...(text?{text}:{})})});
    Object.assign(annotation,updated);removeCommentAnchors(annotation.id);applySingleCommentAnchor(activeCommentRoot,annotation);activeAnnotationId=annotation.id;renderCommentPanel();showToast(`已转为${annotationPresentation(annotation).label}`)
  }catch(error){showToast(error.message,"error")}
});
document.addEventListener("submit",async e=>{const form=e.target.closest("[data-shenji-form]");if(!form)return;e.preventDefault();const annotationId=form.dataset.shenjiForm,button=form.querySelector('button[type="submit"]'),status=form.querySelector(".shenji-status"),message=form.elements.message.value,rootKey=activeCommentRoot,{type:resourceType,id:targetId}=parseCommentRootKey(rootKey),clientRequestId=form.dataset.requestId||crypto.randomUUID();form.dataset.requestId=clientRequestId;button.disabled=true;status.textContent="正在加入后台队列…";let queued=false;try{const task=await request("/api/ai-tasks",{method:"POST",body:JSON.stringify({kind:"annotationShenji",resourceType,targetId,subtargetId:annotationId,payload:{message},clientRequestId})});queued=true;if(!state.aiTasks.some(item=>item.id===task.id))state.aiTasks.unshift(task);status.textContent="已进入后台队列，可继续使用其他功能。";await refreshState("notifications");scheduleNotificationPoll();showToast("神鸡回复已在后台排队")}catch(err){status.textContent=`未能排队：${err.message}`}finally{if(!queued)button.disabled=false}});
document.addEventListener("click",async e=>{const button=e.target.closest("[data-comment-delete]");if(!button)return;const annotationId=button.dataset.commentDelete,root=commentRoot(activeCommentRoot),annotation=root?.annotations?.find(item=>item.id===annotationId),label=annotationPresentation(annotation).label;if(!confirm(`将这条${label}${annotation?.shenji?.length?"及其神鸡对话":""}移入回收站？`))return;try{await request(commentEndpoint(activeCommentRoot,`/${annotationId}`),{method:"DELETE"});if(root)root.annotations=(root.annotations||[]).filter(item=>item.id!==annotationId);removeCommentAnchors(annotationId);button.closest(".comment-card")?.remove();activeAnnotationId="";if(activeShenjiComposer===annotationId)activeShenjiComposer="";if(!$("#comment-panel-list").querySelector(".comment-card"))renderCommentPanel();showToast(`${label}已移入回收站`)}catch(err){showToast(err.message,"error")}});
document.addEventListener("click",async e=>{const button=e.target.closest("[data-drift-delete]");if(!button)return;const driftId=button.dataset.driftDelete;if(!confirm("将这条漂流批注及其评论记录移入回收站？"))return;try{await request(commentEndpoint(activeCommentRoot,`/drift/${driftId}`),{method:"DELETE"});const root=commentRoot(activeCommentRoot);if(root)root.annotationDrift=(root.annotationDrift||[]).filter(item=>item.id!==driftId);renderCommentPanel();showToast("漂流批注已移入回收站")}catch(err){showToast(err.message,"error")}});

document.addEventListener("submit",async e=>{const form=e.target.closest("[data-follow-up-root]");if(!form)return;e.preventDefault();const button=form.querySelector('button[type="submit"]'),status=form.querySelector(".followup-status"),rootId=form.dataset.followUpRoot;button.disabled=true;status.textContent="正在保存追问…";try{const saved=await request(`/api/thoughts/${rootId}/follow-ups`,{method:"POST",body:JSON.stringify({question:form.elements.question.value,answer:form.elements.answer.value})});await refreshState(["thoughts","review"],{chainId:rootId,followUpId:saved.id});showToast(form.elements.answer.value.trim()?"追问与回答已保存":"追问已保存")}catch(err){status.textContent=err.message;button.disabled=false}});
document.addEventListener("submit",async e=>{const form=e.target.closest("[data-followup-manual-answer]");if(!form)return;e.preventDefault();const button=form.querySelector('button[type="submit"]'),status=form.closest(".followup-answer")?.querySelector(".followup-status"),rootId=form.dataset.rootId,followUpId=form.dataset.followupManualAnswer;button.disabled=true;if(status)status.textContent="正在保存回答…";try{await request(`/api/thoughts/${rootId}/follow-ups/${followUpId}`,{method:"PATCH",body:JSON.stringify({expectedVersion:Number(form.dataset.version)||1,answer:form.querySelector("textarea").value})});await refreshState("thoughts",{chainId:rootId,followUpId});showToast("追问回答已保存")}catch(err){if(status)status.textContent=err.message;button.disabled=false}});
document.addEventListener("submit",async e=>{const form=e.target.closest("[data-followup-edit]");if(!form)return;e.preventDefault();const button=form.querySelector('button[type="submit"]'),rootId=form.dataset.rootId,followUpId=form.dataset.followupEdit;button.disabled=true;try{await request(`/api/thoughts/${rootId}/follow-ups/${followUpId}`,{method:"PATCH",body:JSON.stringify({expectedVersion:Number(form.dataset.version)||1,question:form.elements.question.value,answer:form.elements.answer.value})});await refreshState("thoughts",{chainId:rootId,followUpId});showToast("追问已更新")}catch(err){showToast(err.message,"error");button.disabled=false}});
document.addEventListener("click",e=>{const toggle=e.target.closest("[data-followup-edit-toggle]"),cancel=e.target.closest("[data-followup-edit-cancel]");if(!toggle&&!cancel)return;const id=(toggle||cancel).dataset.followupEditToggle||(toggle||cancel).dataset.followupEditCancel,form=document.querySelector(`[data-followup-edit="${CSS.escape(id)}"]`);if(form){form.hidden=cancel?true:!form.hidden;if(!form.hidden)form.elements.question.focus()}});
document.addEventListener("click",async e=>{const button=e.target.closest("[data-followup-delete]");if(!button)return;if(!confirm("将这条追问及其回答移入回收站？"))return;button.disabled=true;try{await request(`/api/thoughts/${button.dataset.rootId}/follow-ups/${button.dataset.followupDelete}`,{method:"DELETE"});await refreshState("thoughts",{chainId:button.dataset.rootId});showToast("追问已移入回收站")}catch(err){showToast(err.message,"error");button.disabled=false}});
document.addEventListener("click",async e=>{const button=e.target.closest("[data-followup-answer]");if(!button)return;const rootId=button.dataset.rootId,followUpId=button.dataset.followupAnswer,root=state.thoughts.find(item=>item.id===rootId&&item.type==="question"),followUp=root?.followUps?.find(item=>item.id===followUpId),clientRequestId=button.dataset.requestId||crypto.randomUUID();if(!root||!followUp)return;button.dataset.requestId=clientRequestId;button.disabled=true;const status=button.closest(".followup-answer")?.querySelector(".followup-status");if(status)status.textContent="正在加入后台队列…";try{const task=await request("/api/ai-tasks",{method:"POST",body:JSON.stringify({kind:"followUpAnswer",targetId:rootId,subtargetId:followUpId,inputVersion:root.version||1,subtargetVersion:followUp.version||1,clientRequestId})});if(!state.aiTasks.some(item=>item.id===task.id))state.aiTasks.unshift(task);if(status)status.textContent="回答已进入后台队列，可继续使用其他功能。";await refreshState("notifications");scheduleNotificationPoll();showToast("追问回答已在后台排队")}catch(err){if(status)status.textContent=`未能排队：${err.message}`;showToast(err.message,"error");button.disabled=false}});

document.addEventListener("click",async e=>{const b=e.target.closest("button");if(!b)return;if(b.dataset.view){closeHomeEditors({restoreFocus:false});return switchView(b.dataset.view)}if(b.dataset.go){closeHomeEditors({restoreFocus:false});return switchView(b.dataset.go)}if(b.dataset.openComments)return openCommentPanel(commentRootKey("thought",b.dataset.openComments));if(b.dataset.followupCompose){const form=b.closest(".chain-record")?.querySelector(`[data-follow-up-root="${CSS.escape(b.dataset.followupCompose)}"]`);if(!form)return;form.hidden=!form.hidden;b.setAttribute("aria-expanded",String(!form.hidden));if(!form.hidden){form.elements.question.focus();form.scrollIntoView({block:"nearest",behavior:"smooth"})}return}if(b.dataset.removeDraftTag!=null){draftTags=draftTags.filter(tag=>tag!==b.dataset.removeDraftTag);return renderTagComposer()}if(b.dataset.removeCaptureTag!=null){captureDraftTags=captureDraftTags.filter(tag=>tag!==b.dataset.removeCaptureTag);return renderCaptureTagComposer()}if(b.dataset.tagFilter!=null){thoughtFilter=b.dataset.tagFilter;return renderThoughts()}if(b.dataset.editChain)return openChainEditor(b.dataset.editChain);if(b.dataset.answerChain){const question=state.thoughts.find(item=>item.id===b.dataset.answerChain&&item.type==="question");if(!question)return;b.disabled=true;try{await startBackgroundChainAnswer(question)}finally{b.disabled=false}return}if(b.dataset.remark){const text=prompt("新增一条备注：");if(text?.trim()){await request(`/api/thoughts/${b.dataset.remark}/remarks`,{method:"POST",body:JSON.stringify({text})});await refreshState("thoughts",{chainId:b.dataset.remark});showToast("备注已保存")}return}if(b.dataset.editRemark){const item=state.thoughts.find(x=>x.id===b.dataset.thoughtId),remark=item?.remarks?.find(x=>x.id===b.dataset.editRemark);if(!remark)return;const text=prompt("编辑备注：",remark.text);if(text?.trim()){await request(`/api/thoughts/${b.dataset.thoughtId}/remarks/${b.dataset.editRemark}`,{method:"PATCH",body:JSON.stringify({text})});await refreshState("thoughts",{chainId:b.dataset.thoughtId});showToast("备注已更新")}return}if(b.dataset.deleteRemark){if(!confirm("将这条备注移入回收站？"))return;await request(`/api/thoughts/${b.dataset.thoughtId}/remarks/${b.dataset.deleteRemark}`,{method:"DELETE"});await refreshState("thoughts",{chainId:b.dataset.thoughtId});showToast("备注已移入回收站");return}if(b.dataset.disposition){await request(`/api/thoughts/${b.dataset.disposition}/disposition`,{method:"PATCH",body:JSON.stringify({disposition:b.dataset.value})});await refreshState(["thoughts","review"],{chainId:b.dataset.disposition});showToast(b.dataset.value==="kept"?"已保留":"已舍弃");return}if(b.dataset.deleteChain){if(!confirm("将整套思绪及其内容移入回收站？"))return;b.disabled=true;try{await request(`/api/thought-chains/${b.dataset.deleteChain}`,{method:"DELETE"});await refreshState(["thoughts","review"]);showToast("整套思绪已移入回收站")}catch(err){showToast(err.message,"error");b.disabled=false}}});
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
  if(button.dataset.captureEdit)return editCapture(button.dataset.captureEdit);
  if(button.dataset.journalEdit)return editJournal(button.dataset.journalEdit);
  if(button.dataset.editCheckin)return openCheckinEditor(button.dataset.editCheckin);
  if(button.dataset.capturePromote){const item=(state.captures||[]).find(value=>value.id===button.dataset.capturePromote);if(!item)return;activeDate=eventDate(item)||activeDate;renderDate();renderSliders();renderThoughts();renderStateChart();renderHomeMood();renderChat();$("#chain-question").value="";$("#chain-idea").value=item.content;draftTags=[...(item.tags||[])];renderTagComposer();$("#chain-status").textContent="捕念已放入初步想法。补上一个明确问题，再形成完整思考。";switchView("today");openHomeEditor("thought");$("#chain-question").focus();return}
  if(button.dataset.captureDelete){if(!confirm("将这条捕念移入回收站？"))return;button.disabled=true;try{await request(`/api/captures/${button.dataset.captureDelete}`,{method:"DELETE"});await refreshState("captures");showToast("捕念已移入回收站")}catch(err){showToast(err.message,"error");button.disabled=false}return}
  if(button.dataset.journalDelete){if(!confirm("将这篇日记及其助手回望移入回收站？"))return;button.disabled=true;try{await request(`/api/journals/${button.dataset.journalDelete}`,{method:"DELETE"});await refreshState("journals");showToast("日记已移入回收站")}catch(err){showToast(err.message,"error");button.disabled=false}return}
  if(button.dataset.journalReflect){const id=button.dataset.journalReflect;button.disabled=true;try{await runAnswerInModal({title:"回望这篇日记",scene:"diaryReflection",requestCall:onEvent=>requestStream(`/api/journals/${id}/reflect`,{method:"POST",body:"{}"},onEvent),onDone:()=>refreshState("journals")});showToast("日记回望已保存")}catch(err){showToast(err.message,"error")}finally{button.disabled=false}}
});
$$("[data-active-date]").forEach(input=>input.addEventListener("change",e=>{chainDraftVersion+=1;healthParseSerial+=1;activeDate=e.target.value||activeDate;renderDate();renderSliders();renderDailyRecords();renderThoughts();renderStateChart();renderHomeMood();renderChat()}));$("#chart-range").addEventListener("change",renderStateChart);
$$("[data-daily-tab]").forEach(button=>button.addEventListener("click",()=>switchDailyType(button.dataset.dailyTab)));
$("#health-images").addEventListener("change",e=>{if(!setHealthImages(e.currentTarget.files,"本地文件"))e.currentTarget.value=""});
$("#health-upload-box").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();$("#health-images").click()}});
$("#health-upload-box").addEventListener("dragenter",e=>{e.preventDefault();e.currentTarget.classList.add("dragging")});
$("#health-upload-box").addEventListener("dragover",e=>{e.preventDefault();e.dataTransfer.dropEffect="copy";e.currentTarget.classList.add("dragging")});
$("#health-upload-box").addEventListener("dragleave",e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.classList.remove("dragging")});
$("#health-upload-box").addEventListener("drop",e=>{e.preventDefault();e.currentTarget.classList.remove("dragging");const files=[...(e.dataTransfer?.files||[])].filter(item=>item.type.startsWith("image/"));setHealthImages(files,"拖入图片",activeDailyType==="sleep")});
document.addEventListener("paste",e=>{if(!$("#view-daily").classList.contains("active")||!dailyTypeMeta[activeDailyType]||(e.target instanceof Element&&e.target.closest("input,textarea,[contenteditable=true]")))return;const files=[...(e.clipboardData?.files||[])].filter(item=>item.type.startsWith("image/"));if(!files.length)return;e.preventDefault();setHealthImages(files,"剪贴板",activeDailyType==="sleep")});
document.addEventListener("click",e=>{const button=e.target.closest("[data-health-image-remove]");if(!button)return;healthParseSerial+=1;healthFiles[activeDailyType].splice(Number(button.dataset.healthImageRemove),1);renderHealthUploader();$("#health-parse-status").textContent=healthFiles[activeDailyType].length?`已保留 ${healthFiles[activeDailyType].length} 张图片。`:"请重新选择或粘贴截图。"});
$("#parse-health-images").addEventListener("click",async e=>{
  const button=e.currentTarget,type=activeDailyType,date=activeDate,files=[...(healthFiles[type]||[])],status=$("#health-parse-status"),serial=++healthParseSerial,owner=currentUser?.id,session=sessionSerial;if(!files.length)return status.textContent="请先选择、粘贴或拖入截图。";
  latestHealthRequest=serial;
  button.disabled=true;status.textContent=`${modelName("healthRecognition")} 正在识别并核对字段…`;
  try{
    const images=await imageDataUrls(files);if(serial!==healthParseSerial||type!==activeDailyType||date!==activeDate||owner!==currentUser?.id||session!==sessionSerial)return;
    const requestId=crypto.randomUUID(),targetId=`daily:${type}:${date}`,result=await request("/api/images/parse",{method:"POST",body:JSON.stringify({requestId,targetId,inputVersion:serial,kind:type,referenceDate:date,images})});if(serial!==healthParseSerial||type!==activeDailyType||date!==activeDate||owner!==currentUser?.id||session!==sessionSerial||(result.requestId&&result.requestId!==requestId)||(result.targetId&&result.targetId!==targetId)||(Object.hasOwn(result,"inputVersion")&&Number(result.inputVersion)!==serial)){if(latestHealthRequest===serial&&type===activeDailyType&&owner===currentUser?.id&&session===sessionSerial)status.textContent="识别已完成，但当前表单已经变化，未自动回填。";return}const form=dailyForm(type);
    for(const [key,value]of Object.entries(result)){if(["attachmentPaths","date"].includes(key)||!form.elements[key])continue;fillDailyField(form.elements[key],value)}
    form.elements.attachmentPaths.value=JSON.stringify(result.attachmentPaths||[]);
    const recognizedTime=result.wakeTime||result.measuredAt||result.startedAt;
    if(recognizedTime){setOccurrenceMode(form.elements.occurredAt,"manual");fillDailyField(form.elements.occurredAt,recognizedTime)}
    else if(result.date){setOccurrenceMode(form.elements.occurredAt,"manual");form.elements.occurredAt.value=localDateTimeForDate(result.date)}
    form.querySelectorAll(".daily-details").forEach(details=>details.open=[...details.querySelectorAll("input")].some(input=>input.value!==""));
    status.textContent=result.verification||"识别完成。请核对后保存，空白字段可以手动补充。";showToast("截图已识别并回填");
  }catch(err){if(serial===healthParseSerial&&owner===currentUser?.id&&session===sessionSerial)status.textContent=err.message}
  finally{if(latestHealthRequest===serial&&type===activeDailyType&&owner===currentUser?.id&&session===sessionSerial)button.disabled=!(healthFiles[type]||[]).length}
});
$$("[data-daily-form]").forEach(form=>form.addEventListener("submit",async e=>{
  e.preventDefault();const current=e.currentTarget,type=current.dataset.dailyForm,id=current.elements.recordId.value,button=current.querySelector('[type="submit"]'),status=current.querySelector(".status"),payload=Object.fromEntries(new FormData(current).entries()),serial=++healthParseSerial,owner=currentUser?.id,session=sessionSerial;latestHealthRequest=0;
  try{Object.assign(payload,occurrenceFields(current.elements.occurredAt))}catch(error){status.textContent=error.message;return}
  delete payload.recordId;payload.type=type;payload.attachmentPaths=payload.attachmentPaths?JSON.parse(payload.attachmentPaths):[];payload.source=payload.attachmentPaths.length?"screenshot":"manual";if(payload.trendSegments){try{payload.trendSegments=JSON.parse(payload.trendSegments)}catch{payload.trendSegments=[]}}
  current.querySelectorAll('input[type="number"]').forEach(input=>{payload[input.name]=input.value===""?null:Number(input.value)});
  current.querySelectorAll("[data-duration]").forEach(input=>{payload[input.name]=input.value===""?null:input.value.split(":").reduce((sum,part)=>sum*60+Number(part),0)});
  button.disabled=true;status.textContent=id?"正在保存修改…":"正在保存…";
  try{await request(id?`/api/daily-records/${id}`:"/api/daily-records",{method:id?"PATCH":"POST",body:JSON.stringify(payload)});if(owner!==currentUser?.id||session!==sessionSerial)return;if(serial===healthParseSerial&&type===activeDailyType){resetDailyForm(type);resetHealthImages()}await refreshState("dailyRecords");showToast(id?"日录已更新":`${dailyTypeMeta[type].label}已记录`)}
  catch(err){if(owner===currentUser?.id&&session===sessionSerial)status.textContent=err.message}finally{button.disabled=false}
}));
for(const type of Object.keys(dailyTypeMeta))for(const event of["input","change"])dailyForm(type)?.addEventListener(event,()=>{healthParseSerial+=1;$("#parse-health-images").disabled=!(healthFiles[activeDailyType]||[]).length});
$$("[data-daily-cancel]").forEach(button=>button.addEventListener("click",()=>resetDailyForm(button.closest("[data-daily-form]").dataset.dailyForm)));
$$("[data-content-image-editor] input[type='file']").forEach(input=>input.addEventListener("change",event=>{
  const editor=event.currentTarget.closest("[data-content-image-editor]"),status=editor?.closest("form")?.querySelector(".status");
  try{setContentImageFiles(editor.dataset.contentImageEditor,event.currentTarget.files);delete editor.closest("form")?.dataset.requestId;event.currentTarget.value="";if(status)status.textContent=""}
  catch(error){event.currentTarget.value="";if(status)status.textContent=error.message;else showToast(error.message,"error")}
}));
document.addEventListener("click",event=>{
  const remove=event.target.closest("[data-content-image-remove]");if(!remove)return;
  const editor=remove.closest("[data-content-image-editor]"),draft=contentImageDraft(editor?.dataset.contentImageEditor),index=Number(remove.dataset.contentImageRemove);
  if(!draft||!Number.isSafeInteger(index)||!draft.items[index])return;
  revokeContentImageItem(draft.items[index]);draft.items.splice(index,1);renderContentImageEditor(editor.dataset.contentImageEditor)
});
document.addEventListener("click",event=>{const button=event.target.closest("[data-content-image-understand]");if(button)void queueContentImageUnderstanding(button)});
document.addEventListener("click",async e=>{
  const button=e.target.closest("[data-daily-edit],[data-daily-delete]");if(!button)return;
  if(button.dataset.dailyEdit)return editDailyRecord(button.dataset.dailyEdit);
  if(!confirm("将这条日录移入回收站？"))return;button.disabled=true;
  try{await request(`/api/daily-records/${button.dataset.dailyDelete}`,{method:"DELETE"});await refreshState("dailyRecords");showToast("日录已移入回收站")}catch(err){showToast(err.message,"error");button.disabled=false}
});
$("#checkin-confirm-all").addEventListener("click",()=>{$$("[data-metric]").forEach(input=>{input.dataset.confirmed="true";input.closest(".metric").classList.remove("unconfirmed");const label=metricConfig()[input.dataset.metric];$(`#${CSS.escape(input.dataset.metric)}-anchor`).textContent=label.anchors[Number(input.value)-1]});navigator.vibrate?.(12);$("#checkin-status").textContent="已确认当前四项，可以直接保存。"});
$("#chain-tags").addEventListener("keydown",e=>{if(entryKeyIntent(e,{inputKind:"tag"})==="commit-tag"){e.preventDefault();commitDraftTags()}});$("#chain-tags").addEventListener("blur",()=>{if($("#chain-tags").value.trim())commitDraftTags()});
for(const selector of["#chain-question","#chain-idea","#chain-answer"])$(selector).addEventListener("input",()=>{chainDraftVersion+=1;if(selector!=="#chain-answer"){answerDraft="";answerReasoningDraft=""}delete $("#chain-form").dataset.requestId});
$("#chain-form").addEventListener("reset",()=>{chainDraftVersion+=1;resetContentImageEditor("thoughtRoot");delete $("#chain-form").dataset.draftId});
$("#capture-tags").addEventListener("keydown",e=>{if(entryKeyIntent(e,{inputKind:"tag"})==="commit-tag"){e.preventDefault();commitCaptureTags()}});$("#capture-tags").addEventListener("blur",()=>{if($("#capture-tags").value.trim())commitCaptureTags()});
$("#capture-cancel").addEventListener("click",resetCaptureForm);
$("#journal-cancel").addEventListener("click",resetJournalForm);
for(const id of durableDraftForms)for(const eventName of["input","change"])document.getElementById(id)?.addEventListener(eventName,saveDurableDrafts);
document.addEventListener("keydown",event=>{
  const field=event.target.closest?.("input,textarea"),form=field?.closest?.("#capture-form,#journal-form,#chain-form,#checkin-form,#chat-form,[data-daily-form],[data-book-entry-form],#keepsake-form,#quote-form,#selection-quote-form,#thought-block-form");
  if(!field||!form||field===document.activeElement&&["chain-tags","capture-tags"].includes(field.id))return;
  const intent=entryKeyIntent(event,{inputKind:field.tagName==="TEXTAREA"?"multiline":"field"});
  if(intent==="submit")return void occurrenceKeyboardSubmit(event,form,field.tagName==="TEXTAREA"?"multiline":"field");
  if(intent==="block-submit")event.preventDefault()
});
$("#capture-form").addEventListener("submit",async e=>{e.preventDefault();if($("#capture-tags").value.trim())commitCaptureTags();const form=e.currentTarget,id=$("#capture-id").value,button=$("#capture-submit"),status=$("#capture-status"),requestId=form.dataset.requestId||crypto.randomUUID();let uploadedPaths=[];if(!id)form.dataset.requestId=requestId;button.disabled=true;status.textContent=id?"正在保存修改…":"正在收下…";try{const submission=await contentImagePaths("capture");uploadedPaths=submission.uploadedPaths;const original=imageRecordPayload({content:$("#capture-content").value,attachmentPaths:submission.attachmentPaths}),payload={...occurrenceFields($("#capture-date")),...original,tags:captureDraftTags};if(id)await request(`/api/captures/${id}`,{method:"PATCH",body:JSON.stringify(payload)});else await requestV1("/api/v1/captures",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)});resetCaptureForm();await refreshState("captures");showToast(id?"捕念已更新":"已收进捕念")}catch(err){await discardContentImageUploads("capture",uploadedPaths);status.textContent=err.message}finally{button.disabled=false}});
$("#journal-draft-save").addEventListener("click",async e=>{const button=e.currentTarget,status=$("#journal-status");button.disabled=true;button.textContent="正在保存…";status.textContent="正在保存草稿…";try{const draft=await request("/api/journal-draft",{method:"PUT",body:JSON.stringify({journalId:$("#journal-id").value,title:$("#journal-title").value,content:$("#journal-content").value})});state.journalDraft=draft;status.textContent=`草稿已保存于 ${formatTime(draft.updatedAt)}。`;showToast("日记草稿已保存")}catch(err){status.textContent=err.message}finally{button.disabled=false;button.textContent="保存草稿"}});
$("#journal-form").addEventListener("submit",async e=>{e.preventDefault();const id=$("#journal-id").value,button=$("#journal-submit"),status=$("#journal-status"),payload={...occurrenceFields($("#journal-date")),title:$("#journal-title").value,content:$("#journal-content").value,tags:splitTags($("#journal-tags").value)};button.disabled=true;status.textContent=id?"正在保存修改…":"正在保存原文…";try{await request(id?`/api/journals/${id}`:"/api/journals",{method:id?"PATCH":"POST",body:JSON.stringify(payload)});resetJournalForm();await refreshState("journals");showToast(id?"日记已更新":"日记已保存")}catch(err){status.textContent=err.message}finally{button.disabled=false}});
$("#checkin-form").addEventListener("submit",async e=>{e.preventDefault();const b=e.currentTarget.querySelector('[type="submit"]'),missing=$$('[data-metric]').filter(x=>x.dataset.confirmed!=="true");if(missing.length){$("#checkin-status").textContent=`请先确认：${missing.map(x=>metricConfig()[x.dataset.metric].label).join("、")}`;missing[0].focus();return}b.disabled=true;b.textContent="正在保存…";const payload={...occurrenceFields($("#checkin-datetime")),notes:{},custom:{},factors:splitTags($("#checkin-factors").value)};$$('[data-metric]').forEach(x=>{const k=x.dataset.metric;if(x.dataset.custom==="1")payload.custom[k]=Number(x.value);else payload[k]=Number(x.value);payload.notes[k]=$(`#${CSS.escape(k)}-note`)?.value||""});try{await request("/api/checkins",{method:"POST",body:JSON.stringify(payload)});clearDurableDraft("checkin-form");resetOccurrenceInput($("#checkin-datetime"));$("#checkin-status").textContent="已保存，正在同步列表…";closeHomeEditors();showToast("此刻状态已保存");void refreshState(["checkins","review"]).catch(error=>showToast(`状态已保存，但页面同步失败：${error.message}`,"error"))}catch(err){$("#checkin-status").textContent=err.message}finally{b.disabled=false;b.textContent="记下此刻"}});
$("#thought-prompt-button").addEventListener("click",async e=>{
  const button=e.currentTarget,question=$("#chain-question"),status=$("#thought-prompt-status"),selectedDate=activeDate,owner=currentUser?.id,requestId=crypto.randomUUID(),targetId=$("#chain-form").dataset.draftId||crypto.randomUUID(),inputVersion=chainDraftVersion;$("#chain-form").dataset.draftId=targetId;
  if(question.value.trim()){status.textContent="问题框已有内容，清空后再生成新的引子。";question.focus();return}
  let changed=false;const markChanged=()=>{changed=true};question.addEventListener("input",markChanged);$("#chain-form").addEventListener("reset",markChanged);
  button.disabled=true;button.textContent="正在想…";status.textContent=`${modelName("thoughtPrompt")} 正在找一个可以接住的开头…`;
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
$("#chain-form").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget,b=form.querySelector('[type="submit"]');if(b.disabled)return;if($("#chain-tags").value.trim())commitDraftTags();const id=form.dataset.requestId||crypto.randomUUID(),answer=$("#chain-answer").value;let uploadedPaths=[];form.dataset.requestId=id;b.disabled=true;b.textContent="正在保存…";$("#chain-status").textContent="正在保存整套思考…";try{const submission=await contentImagePaths("thoughtRoot");uploadedPaths=submission.uploadedPaths;const original=imageRecordPayload({content:$("#chain-question").value,attachmentPaths:submission.attachmentPaths}),needsAnswer=Boolean(original.content.trim()||original.attachmentPaths.length)&&!answer.trim()&&llmSettings.automaticAnswers?.thoughtAnswer===true,result=await request("/api/thought-chains",{method:"POST",body:JSON.stringify({clientRequestId:id,...occurrenceFields($("#chain-datetime")),question:original.content,attachmentPaths:original.attachmentPaths,idea:$("#chain-idea").value,answer,modelDraft:answerDraft,modelReasoning:answerReasoningDraft,tags:draftTags,generateAnswer:needsAnswer})}),question=result.items.find(item=>item.type==="question");chainDraftVersion+=1;form.reset();clearDurableDraft("chain-form");resetOccurrenceInput($("#chain-datetime"));draftTags=[];renderTagComposer();answerDraft="";answerReasoningDraft="";delete form.dataset.requestId;delete form.dataset.draftId;b.disabled=false;b.textContent="收进思绪箱";$("#chain-status").textContent=needsAnswer?"思考已保存，后台生成一条图文合并回答。":answer.trim()?"已保存为一套完整思考。":"思考已保存，未自动调用 AI。";closeHomeEditors();void refreshState(["thoughts","review","notifications"],{chainId:question?.id}).catch(error=>showToast(`记录已保存，但页面刷新失败：${error.message}`,"error"));if(needsAnswer&&question){void startBackgroundChainAnswer(question,result.task)}showToast(needsAnswer?"思考已保存，可继续记录":"整套思考已保存，不会重复记录")}catch(err){await discardContentImageUploads("thoughtRoot",uploadedPaths);$("#chain-status").textContent=err.message}finally{b.disabled=false;b.textContent="收进思绪箱"}});
$("#chat-form").addEventListener("submit",async e=>{e.preventDefault();const b=e.currentTarget.querySelector("button");b.disabled=true;$("#chat-status").textContent=`${modelName("chat")} 正在结合你的长期记录…`;try{await request("/api/chat",{method:"POST",body:JSON.stringify({...occurrenceFields($("#chat-datetime")),message:$("#chat-input").value})});$("#chat-input").value="";resetOccurrenceInput($("#chat-datetime"));await refreshState("chat");$("#chat-status").textContent=""}catch(err){$("#chat-status").textContent=err.message}finally{b.disabled=false}});
$("#edit-chain-form").addEventListener("submit",async e=>{e.preventDefault();const b=e.currentTarget.querySelector('[type="submit"]'),id=$("#edit-chain-id").value;b.disabled=true;$("#edit-chain-status").textContent="正在保存…";try{await request(`/api/thought-chains/${id}`,{method:"PATCH",body:JSON.stringify({occurredAt:$("#edit-chain-datetime").value,question:$("#edit-chain-question").value,tags:splitTags($("#edit-chain-tags").value)})});$("#edit-chain-modal").hidden=true;await refreshState(["thoughts","review"],{chainId:id});showToast("思绪主题已更新")}catch(err){$("#edit-chain-status").textContent=err.message}finally{b.disabled=false}});
$("#thought-block-form").addEventListener("submit",async e=>{
  e.preventDefault();const button=e.currentTarget.querySelector('[type="submit"]'),rootId=$("#thought-block-root-id").value,id=$("#thought-block-id").value;let uploadedPaths=[];button.disabled=true;$("#thought-block-status").textContent="正在保存…";
  try{const submission=await contentImagePaths("thoughtBlock");uploadedPaths=submission.uploadedPaths;const original=imageRecordPayload({content:$("#thought-block-content").value,attachmentPaths:submission.attachmentPaths}),payload={type:$("#thought-block-type").value,relatedTo:rootId,...occurrenceFields($("#thought-block-datetime")),...original,...(id?{expectedVersion:Number(e.currentTarget.dataset.version)||1}:{})};await request(id?`/api/thoughts/${id}`:"/api/thoughts",{method:id?"PATCH":"POST",body:JSON.stringify(payload)});$("#thought-block-modal").hidden=true;resetContentImageEditor("thoughtBlock");await refreshState(["thoughts","review"],{chainId:rootId});showToast(id?"内容已更新":"内容已加入时间线")}
  catch(error){await discardContentImageUploads("thoughtBlock",uploadedPaths);$("#thought-block-status").textContent=error.message}
  finally{button.disabled=false}
});
$("#edit-checkin-form").addEventListener("submit",async e=>{e.preventDefault();const button=e.currentTarget.querySelector('[type="submit"]'),id=$("#edit-checkin-id").value,payload={occurredAt:$("#edit-checkin-datetime").value,factors:splitTags($("#edit-checkin-factors").value),custom:{},notes:{}};$$("[data-edit-checkin-metric]").forEach(input=>{const key=input.dataset.editCheckinMetric;if(input.dataset.custom==="1")payload.custom[key]=Number(input.value);else payload[key]=Number(input.value);payload.notes[key]=$(`[data-edit-checkin-note="${CSS.escape(key)}"]`)?.value||""});button.disabled=true;$("#edit-checkin-status").textContent="正在保存修改…";try{await request(`/api/checkins/${id}`,{method:"PATCH",body:JSON.stringify(payload)});$("#edit-checkin-modal").hidden=true;await refreshState(["checkins","review"]);showToast("此刻状态已更新")}catch(err){$("#edit-checkin-status").textContent=err.message}finally{button.disabled=false}});
$("#edit-chain-modal .modal-close").addEventListener("click",()=>$("#edit-chain-modal").hidden=true);$("#edit-chain-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)e.currentTarget.hidden=true});
$("#thought-block-modal .modal-close").addEventListener("click",()=>$("#thought-block-modal").hidden=true);$("#thought-block-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)e.currentTarget.hidden=true});$("#thought-block-type").addEventListener("change",e=>$("#thought-block-title").textContent=`新增${e.currentTarget.options[e.currentTarget.selectedIndex].text}`);
$("#edit-checkin-modal .modal-close").addEventListener("click",()=>$("#edit-checkin-modal").hidden=true);$("#edit-checkin-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)e.currentTarget.hidden=true});
$("#ai-answer-close").addEventListener("click",closeAnswerModal);$("#ai-answer-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)closeAnswerModal()});
document.addEventListener("keydown",e=>{const homeEditor=$$(".home-v02-editor-backdrop").find(editor=>!editor.hidden),answerModal=$("#ai-answer-modal");if(homeEditor&&answerModal.hidden&&e.key==="Tab")return trapHomeEditorFocus(e,homeEditor);if(e.key!=="Escape")return;if(!answerModal.hidden)return closeAnswerModal();if(!$("#thought-block-modal").hidden)return $("#thought-block-modal").hidden=true;if(!$("#edit-checkin-modal").hidden)return $("#edit-checkin-modal").hidden=true;if(!$("#association-flow-modal").hidden)return setAssociationFlowOpen(false);if(homeEditor)closeHomeEditors()});
$("#association-flow-toggle").addEventListener("click",()=>setAssociationFlowOpen(true));
$("#association-flow-close").addEventListener("click",()=>setAssociationFlowOpen(false));
$("#association-flow-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)setAssociationFlowOpen(false)});
$("#run-analysis").addEventListener("click",async e=>{const button=e.currentTarget;button.disabled=true;$("#analysis-status").textContent="正在比较模型草稿与你最终保留的回答，以及你保留、舍弃和长期缺席的主题…";try{await request("/api/analysis/run",{method:"POST",body:"{}"});await refreshState("review");$("#analysis-status").textContent="";showToast("认知复盘已生成")}catch(err){$("#analysis-status").textContent=err.message}finally{button.disabled=false}});
$("#experiment-form").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget;await request("/api/experiments",{method:"POST",body:JSON.stringify({hypothesis:$("#experiment-hypothesis").value,factor:$("#experiment-factor").value,outcome:$("#experiment-outcome").value,duration:$("#experiment-duration").value})});form.reset();await refreshState("review");showToast("个人实验已开始")});
$("#metric-form").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget;await request("/api/custom-metrics",{method:"POST",body:JSON.stringify({name:$("#metric-name").value,low:$("#metric-low").value,high:$("#metric-high").value})});form.reset();await refreshState(["review","checkins"])});
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
  e.preventDefault();const button=$("#book-submit"),bookId=editingBookId;button.disabled=true;
  try{
    let imagePath=$("#book-image-path").value;
    if(pendingBookImages.cover){$("#book-parse-status").textContent="正在上传封面…";const [image]=await imageDataUrls([pendingBookImages.cover]),uploaded=await request("/api/images/upload",{method:"POST",body:JSON.stringify({image})});imagePath=uploaded.attachmentPath}
    const payload={title:$("#book-title").value,author:$("#book-author").value,publisher:$("#book-publisher").value,isbn:$("#book-isbn").value,readingStartedOn:$("#book-reading-start").value,readingFinishedOn:$("#book-reading-end").value,description:$("#book-description").value,imagePath};
    await request(bookId?`/api/books/${bookId}`:"/api/books",{method:bookId?"PATCH":"POST",body:JSON.stringify(payload)});
    resetBookForm();bookCreatorOpen=false;activeBookId=bookId||"";await refreshState("books");showToast(bookId?"书目信息已更新":"书目已加入书架");
  }catch(err){$("#book-parse-status").textContent=err.message}finally{button.disabled=false}
});
document.addEventListener("submit",async e=>{
  const form=e.target.closest("[data-book-entry-form]");if(!form)return;e.preventDefault();
  const bookId=form.dataset.bookEntryForm,noteId=form.elements.noteId.value,button=form.querySelector('[type="submit"]'),status=form.querySelector(".status"),payload={...occurrenceFields(form.elements.occurredAt),type:form.elements.type.value,favorite:form.elements.favorite.value,content:form.elements.content.value};
  button.disabled=true;status.textContent=noteId?"正在保存修改…":"正在写入时间线…";
  try{await request(noteId?`/api/books/${bookId}/notes/${noteId}`:`/api/books/${bookId}/notes`,{method:noteId?"PATCH":"POST",body:JSON.stringify(payload)});pendingBookNoteId=noteId;await refreshState("books");showToast(noteId?"读书记录已更新":"读书记录已保存")}
  catch(err){status.textContent=err.message;button.disabled=false}
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
    button.disabled=true;try{await request(`/api/books/${book.id}/notes/${note.id}`,{method:"PATCH",body:JSON.stringify({occurredAt:eventTimestamp(note),type:note.type,content:note.content,favorite:button.dataset.nextFavorite})});pendingBookNoteId=note.id;await refreshState("books");showToast(button.dataset.nextFavorite==="star"?"已标为星标":button.dataset.nextFavorite==="sprout"?"已标为萌芽":"已取消收藏")}catch(err){showToast(err.message,"error");button.disabled=false}return;
  }
  if(button.dataset.bookNoteDelete){
    const note=(book.notes||[]).find(item=>item.id===button.dataset.bookNoteDelete);if(!note||!confirm(`将这条${note.type==="thought"?"附加思考":"记录"}移入回收站？`))return;
    button.disabled=true;try{await request(`/api/books/${book.id}/notes/${note.id}`,{method:"DELETE"});await refreshState("books");showToast("读书记录已移入回收站")}catch(err){showToast(err.message,"error");button.disabled=false}
  }
});
$("#keepsake-create-toggle").addEventListener("click",()=>{const workspace=$("#keepsake-workspace"),opening=workspace.hidden;if(opening){resetKeepsakeEditor();workspace.hidden=false;workspace.scrollIntoView({behavior:"smooth",block:"start"})}else resetKeepsakeEditor({close:true})});
$("#keepsake-editor-close").addEventListener("click",()=>resetKeepsakeEditor({close:true}));
$("#keepsake-cancel-edit").addEventListener("click",()=>{resetKeepsakeEditor();$("#keepsake-workspace").scrollIntoView({behavior:"smooth",block:"start"})});
$("#keepsake-image").addEventListener("change",e=>{const file=e.currentTarget.files?.[0];if(file&&!setKeepsakeFile(file))e.currentTarget.value=""});
$("#keepsake-upload-box").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();$("#keepsake-image").click()}});
$("#keepsake-upload-box").addEventListener("dragenter",e=>{e.preventDefault();e.currentTarget.classList.add("dragging")});
$("#keepsake-upload-box").addEventListener("dragover",e=>{e.preventDefault();e.dataTransfer.dropEffect="copy";e.currentTarget.classList.add("dragging")});
$("#keepsake-upload-box").addEventListener("dragleave",e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.classList.remove("dragging")});
$("#keepsake-upload-box").addEventListener("drop",e=>{e.preventDefault();e.currentTarget.classList.remove("dragging");const file=[...(e.dataTransfer?.files||[])].find(item=>item.type.startsWith("image/"));if(file)setKeepsakeFile(file,"拖入图片");else $("#keepsake-segment-status").textContent="拖入的内容里没有可用图片。"});
document.addEventListener("paste",e=>{if(!$("#view-keepsakes").classList.contains("active")||(e.target instanceof Element&&e.target.closest("input,textarea,[contenteditable=true]")))return;const file=[...(e.clipboardData?.files||[])].find(item=>item.type.startsWith("image/"));if(!file)return;e.preventDefault();setKeepsakeFile(file,"剪贴板")});
$("#keepsake-auto-segment").addEventListener("click",segmentCurrentKeepsake);
$("#keepsake-brush-keep").addEventListener("click",()=>{keepsakeEditor.mode="keep";$("#keepsake-brush-keep").classList.add("active");$("#keepsake-brush-erase").classList.remove("active");$("#keepsake-brush-keep").setAttribute("aria-pressed","true");$("#keepsake-brush-erase").setAttribute("aria-pressed","false")});
$("#keepsake-brush-erase").addEventListener("click",()=>{keepsakeEditor.mode="erase";$("#keepsake-brush-erase").classList.add("active");$("#keepsake-brush-keep").classList.remove("active");$("#keepsake-brush-erase").setAttribute("aria-pressed","true");$("#keepsake-brush-keep").setAttribute("aria-pressed","false")});
$("#keepsake-brush-size").addEventListener("input",e=>{$("#keepsake-brush-output").value=e.currentTarget.value;const cursor=$("#keepsake-canvas-cursor");cursor.style.width=cursor.style.height=`${e.currentTarget.value}px`});
$("#keepsake-edge-expansion").addEventListener("input",e=>{$("#keepsake-edge-output").value=e.currentTarget.value;if(keepsakeEditor.autoBase){applyKeepsakeExpansion();$("#keepsake-segment-status").textContent="已按当前场景边缘重新生成自动轮廓；之后仍可手动修正。"}});
$("#keepsake-reset-mask").addEventListener("click",()=>{if(!keepsakeEditor.maskCanvas)return;invalidateKeepsakeSegmentation();pushKeepsakeHistory();keepsakeEditor.maskCanvas.getContext("2d").clearRect(0,0,keepsakeEditor.maskCanvas.width,keepsakeEditor.maskCanvas.height);keepsakeEditor.autoBase=null;keepsakeEditor.source="manual";scheduleKeepsakeRender();$("#keepsake-segment-status").textContent="轮廓已清空，可用“保留”笔刷重新涂抹。"});
$("#keepsake-undo").addEventListener("click",()=>{const previous=keepsakeEditor.history.pop();if(!previous||!keepsakeEditor.maskCanvas)return;invalidateKeepsakeSegmentation();keepsakeEditor.maskCanvas.getContext("2d").putImageData(previous,0,0);$("#keepsake-undo").disabled=!keepsakeEditor.history.length;scheduleKeepsakeRender()});
const keepsakePaintCanvas=$("#keepsake-mask-canvas");
keepsakePaintCanvas.addEventListener("pointerdown",e=>{if(!keepsakeEditor.maskCanvas)return;e.preventDefault();invalidateKeepsakeSegmentation();keepsakePaintCanvas.setPointerCapture(e.pointerId);pushKeepsakeHistory();keepsakeEditor.drawing=true;keepsakeEditor.lastPoint=keepsakeCanvasPoint(e);paintKeepsakeStroke(keepsakeEditor.lastPoint,keepsakeEditor.lastPoint)});
keepsakePaintCanvas.addEventListener("pointermove",e=>{const rect=keepsakePaintCanvas.getBoundingClientRect(),cursor=$("#keepsake-canvas-cursor");cursor.hidden=false;cursor.style.left=`${e.clientX-rect.left}px`;cursor.style.top=`${e.clientY-rect.top}px`;if(!keepsakeEditor.drawing)return;const next=keepsakeCanvasPoint(e);paintKeepsakeStroke(keepsakeEditor.lastPoint,next);keepsakeEditor.lastPoint=next});
const endKeepsakeStroke=e=>{keepsakeEditor.drawing=false;keepsakeEditor.lastPoint=null;if(e.pointerId!=null&&keepsakePaintCanvas.hasPointerCapture(e.pointerId))keepsakePaintCanvas.releasePointerCapture(e.pointerId)};
keepsakePaintCanvas.addEventListener("pointerup",endKeepsakeStroke);keepsakePaintCanvas.addEventListener("pointercancel",endKeepsakeStroke);keepsakePaintCanvas.addEventListener("pointerleave",()=>{$("#keepsake-canvas-cursor").hidden=true});
$("#keepsake-form").addEventListener("submit",async e=>{
  e.preventDefault();const button=$("#keepsake-save"),status=$("#keepsake-save-status"),id=$("#keepsake-id").value;if(!keepsakeEditor.sourceCanvas||!keepsakeEditor.maskCanvas)return status.textContent="请先放入一张照片。";
  const alpha=maskImageDataFromCanvas(keepsakeEditor.maskCanvas).data;let hasSubject=false;for(let index=3;index<alpha.length;index+=4)if(alpha[index]>20){hasSubject=true;break}if(!hasSubject)return status.textContent="轮廓还是空的，请自动识别或用“保留”笔刷涂出主体。";
  button.disabled=true;status.textContent="正在生成压缩图…";
  try{
    const alphaMask=keepsakeEditor.maskCanvas.toDataURL("image/png");
    const payload={...occurrenceFields($("#keepsake-datetime")),title:$("#keepsake-title").value,category:$("#keepsake-category").value,note:$("#keepsake-note").value,tags:splitTags($("#keepsake-tags").value),alphaMask,...(!id||keepsakeEditor.file?{image:keepsakeEditor.sourceDataUrl}:{}),source:keepsakeEditor.source,edgeExpansion:Number($("#keepsake-edge-expansion").value)};
    await request(id?`/api/keepsakes/${id}`:"/api/keepsakes",{method:id?"PATCH":"POST",body:JSON.stringify(payload)});resetKeepsakeEditor({close:true});await refreshState(["keepsakes","review"]);window.scrollTo({top:0,behavior:"auto"});showToast(id?"小物留存已更新":"小物已数字留存");
  }catch(error){status.textContent=error.message}finally{button.disabled=false}
});
document.addEventListener("click",async e=>{
  const back=e.target.closest("[data-keepsake-back]"),view=e.target.closest("[data-keepsake-view]"),edit=e.target.closest("[data-keepsake-edit]"),remove=e.target.closest("[data-keepsake-delete]"),open=e.target.closest("[data-keepsake-open]");
  if(back){activeKeepsakeId="";activeKeepsakeView="presentation";activeKeepsakeOriginalPath="";renderKeepsakes();window.scrollTo({top:0,behavior:"smooth"});return}
  if(view){view.disabled=true;try{await setKeepsakeDetailView(view.dataset.keepsakeView)}catch(error){showToast(error.message,"error")}finally{view.disabled=false}return}
  if(edit){editKeepsake(edit.dataset.keepsakeEdit);return}
  if(remove){if(!confirm("将这件小物移入回收站？原图与轮廓会保留 30 天。"))return;remove.disabled=true;try{await request(`/api/keepsakes/${remove.dataset.keepsakeDelete}`,{method:"DELETE"});await refreshState(["keepsakes","review"]);showToast("小物已移入回收站")}catch(error){showToast(error.message,"error");remove.disabled=false}return}
  if(open)openKeepsakeDetail(open.dataset.keepsakeOpen);
});
$("#quote-refresh").addEventListener("click",()=>renderQuoteSky(true));
$("#quote-cancel").addEventListener("click",resetQuoteForm);
$("#quote-form").addEventListener("submit",async e=>{e.preventDefault();const id=$("#quote-id").value,button=$("#quote-submit"),status=$("#quote-status"),payload={...occurrenceFields($("#quote-datetime")),source:$("#quote-source").value,content:$("#quote-content").value,tags:splitTags($("#quote-tags").value)};button.disabled=true;status.textContent=id?"正在保存修改…":"正在收藏…";try{await request(id?`/api/quotes/${id}`:"/api/quotes",{method:id?"PATCH":"POST",body:JSON.stringify(payload)});resetQuoteForm();await refreshState("quotes");showToast(id?"善言已更新":"善言已收藏")}catch(err){status.textContent=err.message}finally{button.disabled=false}});
document.addEventListener("click",async e=>{const edit=e.target.closest("[data-quote-edit]"),remove=e.target.closest("[data-quote-delete]");if(edit)return editQuote(edit.dataset.quoteEdit);if(!remove)return;if(!confirm("将这条善言及其批注移入回收站？"))return;remove.disabled=true;try{await request(`/api/quotes/${remove.dataset.quoteDelete}`,{method:"DELETE"});if($("#quote-id").value===remove.dataset.quoteDelete)resetQuoteForm();await refreshState("quotes");showToast("善言已移入回收站")}catch(err){showToast(err.message,"error");remove.disabled=false}});
$("#selection-quote-close").addEventListener("click",closeSelectionQuoteModal);
$("#selection-quote-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)closeSelectionQuoteModal()});
$("#selection-quote-form").addEventListener("submit",async e=>{e.preventDefault();const button=e.currentTarget.querySelector('[type="submit"]'),status=$("#selection-quote-status"),payload={...occurrenceFields($("#selection-quote-datetime")),source:$("#selection-quote-source").value,content:$("#selection-quote-content").value,tags:splitTags($("#selection-quote-tags").value)};button.disabled=true;status.textContent="正在收藏…";try{await request("/api/quotes",{method:"POST",body:JSON.stringify(payload)});closeSelectionQuoteModal();await refreshState("quotes");showToast("选中文字已收为善言")}catch(err){status.textContent=err.message}finally{button.disabled=false}});
setStatisticsRange(7);
$$("[data-statistics-days]").forEach(button=>button.addEventListener("click",()=>{setStatisticsRange(Number(button.dataset.statisticsDays));void loadStatistics()}));
$("#statistics-range-form").addEventListener("submit",event=>{event.preventDefault();$$("[data-statistics-days]").forEach(button=>button.classList.remove("active"));void loadStatistics()});
$("#view-architecture")?.addEventListener("click",event=>{
  const stageButton=event.target.closest("[data-architecture-stage]"),termButton=event.target.closest("[data-architecture-term]");
  if(stageButton){architectureStage=Math.max(0,Math.min(4,Number(stageButton.dataset.architectureStage)||0));renderArchitecture();return}
  if(termButton){architectureTerm=termButton.dataset.architectureTerm;renderArchitectureTerm()}
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
$$("[data-commercial-mode]").forEach(button=>button.addEventListener("click",()=>{
  state.commercialization.assumptions=commercialAssumptionsFromForm();
  commercialMode=button.dataset.commercialMode;
  renderCommercialization(true);
}));
$("#commercial-assumptions-form").addEventListener("input",()=>renderCommercialization(false));
$("#view-commercialization").addEventListener("input",event=>{
  if(!event.target.matches("[data-commercial-profile-field]"))return;
  renderCommercialization(false);
});
$("#commercial-stage-slider").addEventListener("input",event=>{
  const assumptions=commercialAssumptionsFromForm(),index=Math.max(0,Math.min(4,Number(event.currentTarget.value)||0));
  assumptions.stageByModel[commercialMode]=index;
  assumptions[commercialMode]=structuredClone(assumptions.stagePresets[commercialMode][index]);
  state.commercialization.assumptions=assumptions;
  renderCommercialization(true);
  $("#commercial-save-status").textContent="阶段参数已切换，保存后跟随账户。";
});
$("#commercial-assumptions-form").addEventListener("submit",async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('[type="submit"]'),status=$("#commercial-save-status"),assumptions=commercialAssumptionsFromForm();button.disabled=true;status.textContent="正在保存估算…";
  try{state.commercialization=await request("/api/commercialization",{method:"PATCH",body:JSON.stringify({assumptions})});renderCommercialization();status.textContent="估算参数已保存。";showToast("商业化估算已更新")}
  catch(error){status.textContent=error.message}
  finally{button.disabled=false}
});
document.addEventListener("click",event=>{const button=event.target.closest("[data-commercial-source-view]");if(button)openCommercialSource(button.dataset.commercialSourceView,button.dataset.commercialSourceId,button.dataset.commercialSourceDate)});
$$("[data-local-test-mode]").forEach(button=>button.addEventListener("click",async()=>{
  const mode=button.dataset.localTestMode,label=mode==="simulation"?"使用模拟":"冷启测试",message=mode==="simulation"?"重新拉取线上主账户并覆盖本地模拟数据？线上不会收到任何业务写入。":"清空冷启测试账户并重新开始？";
  if(!confirm(message))return;
  rotateSession();invalidatePageLoads();
  const expectedSession=sessionSerial,expectedOwner=currentUser?.id,controls=$$("[data-local-test-mode]"),status=$("#local-test-status");controls.forEach(control=>control.disabled=true);status.textContent=mode==="simulation"?"正在只读拉取线上最新数据…":"正在创建空账户…";
  try{const nextConfig=await request("/api/local-test-mode",{method:"POST",body:JSON.stringify({mode})});if(expectedSession!==sessionSerial||expectedOwner!==currentUser?.id||nextConfig?.mode!==mode)throw Object.assign(new Error("已忽略不属于当前账户或模式的响应"),{code:"LOCAL_TEST_RESPONSE_MISMATCH"});localTestConfig=nextConfig;await load();switchView(mode==="cold"?"today":"settings");if(mode==="simulation")$("#local-test-status").textContent=`已切换到${label}。`;showToast(`已切换到${label}`)}
  catch(error){status.textContent=error.message;renderLocalTestSettings()}
  finally{if(localTestConfig?.upstreamConfigured||mode!=="simulation")controls.forEach(control=>control.disabled=false)}
}));
$$("[data-onboarding-mode]").forEach(button=>button.addEventListener("click",()=>{collectOnboardingAnswers();onboardingMode=button.dataset.onboardingMode==="detailed"?"detailed":"quick";$("#onboarding-understanding").closest("label").hidden=true;$("#onboarding-status").textContent=onboardingMode==="detailed"?"详细版共 18 题，全部作答后才能完成。":"快速版共 8 题，全部作答后才能完成。";renderOnboardingQuestions()}));
$$("[data-onboarding-sample]").forEach(button=>button.addEventListener("click",()=>{$("#onboarding-material").value=button.dataset.onboardingSample;$("#onboarding-understanding").closest("label").hidden=true}));
$("#onboarding-file").addEventListener("change",async event=>{const file=event.currentTarget.files?.[0];if(!file)return;if(file.size>1024*1024){$("#onboarding-status").textContent="导入文件不能超过 1 MB。";event.currentTarget.value="";return}try{$("#onboarding-material").value=await file.text();$("#onboarding-status").textContent=`已读取 ${file.name}，确认前仍可修改。`}catch{$("#onboarding-status").textContent="文件读取失败，请重试。"}});
$("#onboarding-preview").addEventListener("click",async()=>{const form=$("#onboarding-form"),status=$("#onboarding-status");if(!form.reportValidity()){status.textContent="请先完成当前版本的全部题目。";return}status.textContent="正在整理初始认知…";try{const result=await request("/api/onboarding/preview",{method:"POST",body:JSON.stringify(onboardingPayload())}),understanding=$("#onboarding-understanding");understanding.value=result.understanding;understanding.closest("label").hidden=false;understanding.focus();status.textContent="这是可修改的初步理解，后续真实记录优先。"}catch(error){status.textContent=error.message}});
$("#onboarding-skip").addEventListener("click",()=>{for(const key of["gender","region","occupation","major","school","introduction","works"]){const field=$(`#onboarding-${key}`);if(field)field.value=""}$$('#onboarding-interests input[type="checkbox"]').forEach(input=>input.checked=false);$("#onboarding-material").value="";$("#onboarding-file").value="";$("#onboarding-understanding").value="";$("#onboarding-understanding").closest("label").hidden=true;$("#onboarding-optional").open=false;$("#onboarding-status").textContent="已略过可选资料；完成全部题目后即可开始。"});
$("#onboarding-form").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#onboarding-status");if(!form.reportValidity()){status.textContent="请完成当前版本的全部题目。";return}button.disabled=true;try{state.onboarding=await request("/api/onboarding",{method:"PATCH",body:JSON.stringify(onboardingPayload())});renderOnboarding();showToast("初始认知已保存，可继续用真实记录修正")}catch(error){status.textContent=error.message}finally{button.disabled=false}});
$("#reset-response-styles").addEventListener("click",()=>{$("#assistant-name").value="神鸡";$$("[data-response-style]").forEach(select=>select.value="standard");$("#llm-settings-status").textContent="已恢复默认称呼与风格，保存后生效。"});
$("#llm-settings-form").addEventListener("submit",async e=>{e.preventDefault();const button=e.currentTarget.querySelector('[type="submit"]'),status=$("#llm-settings-status");button.disabled=true;status.textContent="正在保存…";try{llmSettings=await request("/api/settings",{method:"POST",body:JSON.stringify(settingsPayload())});$("#llm-api-key").value="";renderSettings();status.textContent="四档配置与各场景选择已保存。";showToast("DeepSeek 设置已保存")}catch(err){status.textContent=err.message}finally{button.disabled=false}});
$("#test-llm").addEventListener("click",async e=>{const button=e.currentTarget,status=$("#llm-settings-status"),tier=$("#llm-test-tier").value;button.disabled=true;status.textContent=`正在保存并测试 ${tier[0].toUpperCase()+tier.slice(1)}…`;try{llmSettings=await request("/api/settings",{method:"POST",body:JSON.stringify(settingsPayload())});$("#llm-api-key").value="";renderSettings();const result=await request("/api/settings/test",{method:"POST",body:JSON.stringify({tier})}),profile=llmSettings.profiles[tier];status.textContent=`连接成功 · ${profile.model==="deepseek-v4-pro"?"DeepSeek Pro":"DeepSeek Flash"} · ${profile.effort==="none"?"思考关闭":`思考 ${profile.effort.toUpperCase()}`}`;showToast(result.reply||"DeepSeek 连接成功")}catch(err){status.textContent=`连接失败：${err.message}`}finally{button.disabled=false}});
function syncLocalDate(){const next=localDateKey();if(next===currentLocalDate)return;const followedToday=activeDate===currentLocalDate;currentLocalDate=next;if(followedToday){activeDate=next;renderDate();renderSliders();renderThoughts();renderStateChart();renderHomeMood();renderChat()}}
function markApplicationForeground(){apiClient.markForeground();syncLocalDate()}
setInterval(syncLocalDate,30000);
document.addEventListener("visibilitychange",()=>{if(document.hidden)saveDurableDrafts();else markApplicationForeground()});
window.addEventListener("pagehide",saveDurableDrafts);
window.addEventListener("pageshow",markApplicationForeground);
$$("[data-auth-tab]").forEach(button=>button.addEventListener("click",()=>setAuthTab(button.dataset.authTab)));
for(const [formId,endpoint]of[["login-form","/api/auth/login"],["register-form","/api/auth/register"]]){
  $(`#${formId}`).addEventListener("submit",async event=>{
    event.preventDefault();const form=event.currentTarget,fields=new FormData(form),status=$("#auth-status"),operation=++authOperationSerial;setAuthBusy(true);status.textContent=formId==="login-form"?"正在登录…":"正在创建账户…";
    try{const result=await authRequest(endpoint,Object.fromEntries(fields));if(operation!==authOperationSerial)return;form.reset();await activateUserSession(result.user,true)}
    catch(error){if(operation===authOperationSerial)status.textContent=error.message}
    finally{if(operation===authOperationSerial)setAuthBusy(false)}
  });
}
const logout=async()=>{
  const operation=++authOperationSerial;clearDurableDraft();showAuthGate();setAuthTab("login");setAuthBusy(true);$("#auth-status").textContent="正在退出…";
  try{await authRequest("/api/auth/logout",{})}
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
$("#logout-button").addEventListener("click",logout);$("#logout-button-account").addEventListener("click",logout);
export function startApplication() {
  return bootstrap().catch(error => {
    showAuthGate();
    $("#auth-status").textContent = error.message;
  });
}
