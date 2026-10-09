import { sessionSerial } from "../../session/index.mjs";
import { publishDomains, state } from "../../state/index.mjs";

export function installGlobalEvents({
  runtime,$,$$,actionsCoordinator,localTestViewScopes,ensureLocalTestViewScope,
  restorePendingProjections,createPageRouter,applicationBasePath,
  applyApplicationRoute,hasCapability,showPermissionPage,renderHomeMemories,
  openHomeMemory,openHomeEditor,closeHomeEditors,renderDate,renderSliders,
  renderStateChart,renderHomeMood,renderChat,showToast,
  pageAudioCoordinator,claimPageAudio,stopPageAudio,normalizeTtsPlaybackRate,
  requestV1,refreshState,applyPendingProjection,contentImageDraft,
  renderContentImageEditor,setContentImageFiles,
  queueContentImageUnderstanding,metricConfig,metricValue,splitTags,
  clearDurableDraft,saveDurableDrafts,durableDraftForms,
  resetOccurrenceInput,occurrenceFields,occurrenceKeyboardSubmit,
  entryKeyIntent,imageRecordPayload,captureRecordPayload,contentImagePaths,
  clearSubmittedContentImageDraft,discardContentImageUploads,llmProfile,
  runAnswerInModal,requestStream,startBackgroundChainAnswer,request,
  quoteTagPickerConfig,quoteTagPickerElements,updateQuoteTagPicker,
  renderQuoteTagPicker,quoteTagsForSubmission,quoteTagCandidates,
  closeSelectionQuoteModal,
  collectOnboardingAnswers,renderOnboardingQuestions,onboardingPayload,
  onboardingV2Controller,load,localDateKey,apiClient,setAuthTab,setAuthBusy,
  authRequest,restartApplicationForUser,showAuthGate,mediaDraftStore,
  persistedDateTimeInput,escapeHtml,presentError,
  openThoughtDetail,openContextReceiptSource,loadRouteState,renderTagComposer,
  commitDraftTags,chainRecordKind,syncChainRecordKind,resetContentImageEditor,closeAnswerModal,
  openImageViewer,closeImageViewer,moveImageViewer,trapHomeEditorFocus,
  handleTagMultiSelectKey
} = {}) {
const pageEffects={today:()=>{if(runtime.applicationLifecycleReady&&runtime.currentUser?.id)void actionsCoordinator.load()}};
const lazyPageEffects=new Proxy(pageEffects,{get(target,view){const effect=target[view];if(typeof view!=="string"||!localTestViewScopes[view])return effect;return()=>{void ensureLocalTestViewScope(view).then(async ready=>{if(!ready)return;if(typeof effect==="function")await effect();await restorePendingProjections()})}}});
const pageRouter=createPageRouter({query:$,queryAll:$$,effects:lazyPageEffects,basePath:applicationBasePath,onRouteStart:applyApplicationRoute,canAccessView:(_,capability)=>hasCapability(capability),onDenied:showPermissionPage});
const {switchView,restoreView}=pageRouter;
async function openCaptureFeature(action,trigger=null){
  await Promise.resolve(switchView("captures"));
  return runtime.capturesFeatureController?.[action]?.(trigger)||false
}
async function openLibraryFeature(id,options={}){
  await Promise.resolve(switchView("books"));
  return runtime.libraryFeatureController?.openBook(id,options)||false
}
async function openQuoteFeature(id){
  await Promise.resolve(switchView("quotes"));
  return runtime.quotesFeatureController?.openItem(id)||false
}
async function openKeepsakeFeature(id){
  await Promise.resolve(switchView("keepsakes"));
  return id?runtime.keepsakesFeatureController?.openItem(id)||false:true
}
$("#home-open-thought").addEventListener("click",event=>openHomeEditor("thought",event.currentTarget));
$("#home-record-voice").addEventListener("click",event=>void openCaptureFeature("openQuickVoice",event.currentTarget));
$("#home-record-state").addEventListener("click",event=>openHomeEditor("state",event.currentTarget));
$("#home-shuffle").addEventListener("click",()=>renderHomeMemories({advance:true}));
$("#home-memory-grid").addEventListener("click",event=>{
  const button=event.target.closest("[data-home-memory-open]");
  if(button)openHomeMemory(runtime.homeMemoryByKey.get(button.dataset.homeMemoryOpen))
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

document.addEventListener("click",e=>{const b=e.target.closest("button");if(!b||b.closest("#view-ai-cost,#view-architecture,#view-commercialization"))return;if(b.dataset.view){closeHomeEditors({restoreFocus:false});return switchView(b.dataset.view)}if(b.dataset.go){closeHomeEditors({restoreFocus:false});return switchView(b.dataset.go)}if(b.dataset.removeDraftTag!=null){runtime.draftTags=runtime.draftTags.filter(tag=>tag!==b.dataset.removeDraftTag);return renderTagComposer()}});
document.addEventListener("click",async e=>{
  const button=e.target.closest("button");if(!button)return;
  if(button.dataset.editCheckin)return openCheckinEditor(button.dataset.editCheckin);
});
$$("[data-active-date]").forEach(input=>input.addEventListener("change",async e=>{runtime.chainDraftVersion+=1;runtime.activeDate=e.target.value||runtime.activeDate;renderDate();renderSliders();publishDomains(new Set(["thoughts","activeDate"]));renderStateChart();renderHomeMood();renderChat();await runtime.healthFeatureController?.changeDate(runtime.activeDate).catch(error=>showToast(`健康截图恢复失败：${error.message}`,"error"))}));
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
  await runtime.contentImageDraftManager.remove(editor.dataset.contentImageEditor,index)
    .then(()=>renderContentImageEditor(editor.dataset.contentImageEditor))
    .catch(error=>showToast(`图片暂存失败：${error.message}`,"error"))
});
document.addEventListener("click",event=>{const button=event.target.closest("[data-content-image-understand]");if(button)void queueContentImageUnderstanding(button)});
$("#checkin-confirm-all").addEventListener("click",()=>{$$("[data-metric]").forEach(input=>{input.dataset.confirmed="true";input.closest(".metric").classList.remove("unconfirmed");const label=metricConfig()[input.dataset.metric];$(`#${CSS.escape(input.dataset.metric)}-anchor`).textContent=label.anchors[Number(input.value)-1]});navigator.vibrate?.(12);$("#checkin-status").textContent="已确认当前四项，可以直接保存。"});
$("#chain-tags").addEventListener("keydown",e=>{if(entryKeyIntent(e,{inputKind:"tag"})==="commit-tag"){e.preventDefault();commitDraftTags()}});
$("#chain-form").elements.recordKind.forEach(input=>input.addEventListener("change",()=>{runtime.chainDraftVersion+=1;delete $("#chain-form").dataset.requestId;syncChainRecordKind()}));
$("#thought-source-cancel").addEventListener("click",()=>{const form=$("#chain-form");form.reset();clearDurableDraft("chain-form");resetOccurrenceInput($("#chain-datetime"));runtime.draftTags=[];renderTagComposer();runtime.answerDraft="";runtime.answerReasoningDraft="";$("#chain-status").textContent="已取消从念起展开，可以重新记录。";$("#chain-question").focus()});
for(const selector of["#chain-question","#chain-idea","#chain-answer"])$(selector).addEventListener("input",()=>{runtime.chainDraftVersion+=1;if(selector!=="#chain-answer"){runtime.answerDraft="";runtime.answerReasoningDraft=""}delete $("#chain-form").dataset.requestId});
$("#chain-form").addEventListener("reset",event=>{runtime.chainDraftVersion+=1;resetContentImageEditor("thoughtRoot");delete event.currentTarget.dataset.draftId;event.currentTarget.elements.sourceCaptureId.value="";event.currentTarget.elements.sourceCaptureVersion.value="";queueMicrotask(syncChainRecordKind)});
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
  const button=e.currentTarget,question=$("#chain-question"),status=$("#thought-prompt-status"),selectedDate=runtime.activeDate,owner=runtime.currentUser?.id,requestId=crypto.randomUUID(),targetId=$("#chain-form").dataset.draftId||crypto.randomUUID(),inputVersion=runtime.chainDraftVersion;$("#chain-form").dataset.draftId=targetId;
  if(question.value.trim()){status.textContent="问题框已有内容，清空后再生成新的引子。";question.focus();return}
  let changed=false;const markChanged=()=>{changed=true};question.addEventListener("input",markChanged);$("#chain-form").addEventListener("reset",markChanged);
  button.disabled=true;button.textContent="正在想…";status.textContent="正在找一个可以接住的开头…";
  try{
    const result=await request("/api/thought-prompts",{method:"POST",body:JSON.stringify({requestId,targetId,inputVersion,...occurrenceFields($("#chain-datetime"))})});
    if(changed||question.value.trim()||runtime.activeDate!==selectedDate||runtime.currentUser?.id!==owner||(result.requestId&&result.requestId!==requestId)){status.textContent="引子已生成；当前输入已变化，请继续你的思考。";return}
    question.value=result.prompt||"";question.focus();question.setSelectionRange(question.value.length,question.value.length);
    status.textContent=result.hasHistory?"从之前的记录接了一步；它只是引子，可以随手改。":"先抛来一个轻巧的问题；它只是引子，可以随手改。";
  }catch(err){status.textContent=`生成失败：${err.message}`}
  finally{question.removeEventListener("input",markChanged);$("#chain-form").removeEventListener("reset",markChanged);button.disabled=false;button.textContent="✦ 给个引子"}
});
$("#draft-answer-button").addEventListener("click",async e=>{
  const button=e.currentTarget,form=$("#chain-form"),question=$("#chain-question"),idea=$("#chain-idea"),q=question.value.trim();if(!q){$("#chain-status").textContent="先写下问题，我才能结合你的记录回答。";question.focus();return}
  const targetId=form.dataset.draftId||crypto.randomUUID(),requestId=crypto.randomUUID(),inputVersion=runtime.chainDraftVersion,owner=runtime.currentUser?.id,session=runtime.sessionSerial,ideaSnapshot=idea.value;form.dataset.draftId=targetId;let applied=false;
  const isCurrent=()=>runtime.chainDraftVersion===inputVersion&&runtime.currentUser?.id===owner&&runtime.sessionSerial===session&&question.value.trim()===q&&idea.value===ideaSnapshot;
  button.disabled=true;
  try{await runAnswerInModal({title:"生成可编辑回答草稿",scene:"thoughtDraft",isCurrent,requestCall:onEvent=>requestStream("/api/answer-drafts",{method:"POST",body:JSON.stringify({requestId,targetId,inputVersion,question:q,idea:ideaSnapshot})},onEvent),onDone:r=>{if(r.requestId!==requestId||r.targetId!==targetId||Number(r.inputVersion)!==inputVersion)return;applied=true;runtime.answerDraft=r.draft;runtime.answerReasoningDraft=r.reasoningContent||"";$("#chain-answer").value=r.draft;$("#chain-status").textContent="草稿已填入回答框。请按你的判断修改，再提交整套思考。"}});showToast(applied?"回答草稿已生成，可直接修改":"旧草稿已完成，但没有覆盖当前输入",applied?"success":"error")}
  catch(err){$("#chain-status").textContent=err.message}
  finally{button.disabled=false}
});
$("#chain-form").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget,b=form.querySelector('[type="submit"]');if(b.disabled)return;if($("#chain-tags").value.trim())commitDraftTags();const recordKind=chainRecordKind(),requestId=form.dataset.requestId||crypto.randomUUID(),temporaryId=`pending:${requestId}`,answer=$("#chain-answer").value,sourceCaptureId=form.elements.sourceCaptureId.value,sourceCaptureVersion=Number(form.elements.sourceCaptureVersion.value)||0;let uploadedPaths=[];form.dataset.requestId=requestId;b.disabled=true;b.textContent="正在保存…";$("#chain-status").textContent=recordKind==="capture"?"正在收进念起…":"正在保存整套思考…";
  try{
    const submission=await contentImagePaths("thoughtRoot");uploadedPaths=submission.uploadedPaths;
    const eventTime=occurrenceFields($("#chain-datetime")),original=imageRecordPayload({content:$("#chain-question").value,attachmentPaths:submission.attachmentPaths});
    if(recordKind==="capture"){
      const payload={...eventTime,...captureRecordPayload(original),tags:runtime.draftTags},result=(await requestV1("/api/v1/captures",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{domains:["captures"],projection:{kind:"capture.create",temporaryId,payload},onQueued:record=>applyPendingProjection(record)})).data;
      state.captures=(state.captures||[]).map(item=>item.id===temporaryId?result:item);publishDomains(new Set(["captures"]));await clearSubmittedContentImageDraft("thoughtRoot");runtime.chainDraftVersion+=1;form.reset();clearDurableDraft("chain-form");resetOccurrenceInput($("#chain-datetime"));runtime.draftTags=[];renderTagComposer();runtime.answerDraft="";runtime.answerReasoningDraft="";delete form.dataset.requestId;delete form.dataset.draftId;$("#chain-status").textContent="已收进念起。";closeHomeEditors();void refreshState("captures").catch(error=>showToast(`念起已保存，但页面刷新失败：${error.message}`,"error"));showToast("已收进念起");return
    }
    const needsAnswer=Boolean(original.content.trim()||original.attachmentPaths.length)&&!answer.trim()&&runtime.llmSettings.automaticAnswers?.thoughtAnswer===true,payload={...eventTime,question:original.content,attachmentPaths:original.attachmentPaths,idea:$("#chain-idea").value,answer,modelDraft:runtime.answerDraft,modelReasoning:runtime.answerReasoningDraft,tags:runtime.draftTags,generateAnswer:needsAnswer,...(sourceCaptureId?{sourceRef:{type:"capture",id:sourceCaptureId,version:sourceCaptureVersion}}:{})},result=(await requestV1("/api/v1/thought-chains",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{domains:["thoughts","aiTasks","notifications"],projection:{kind:"thought.chain.create",temporaryId,payload},onQueued:record=>applyPendingProjection(record)})).data,question=result.items.find(item=>item.type==="question");
    state.thoughts=[...result.items,...(state.thoughts||[]).filter(item=>!String(item.id).startsWith(`${temporaryId}:`))];publishDomains(new Set(["thoughts"]));await clearSubmittedContentImageDraft("thoughtRoot");runtime.chainDraftVersion+=1;form.reset();clearDurableDraft("chain-form");resetOccurrenceInput($("#chain-datetime"));runtime.draftTags=[];renderTagComposer();runtime.answerDraft="";runtime.answerReasoningDraft="";delete form.dataset.requestId;delete form.dataset.draftId;$("#chain-status").textContent=needsAnswer?"思考已保存，后台生成一条图文合并回答。":answer.trim()?"已保存为一套完整思考。":"思考已保存，未自动调用 AI。";closeHomeEditors();void refreshState(["thoughts","review","notifications"],{chainId:question?.id}).catch(error=>showToast(`记录已保存，但页面刷新失败：${error.message}`,"error"));if(needsAnswer&&question){void startBackgroundChainAnswer(question,result.task)}showToast(needsAnswer?"思考已保存，可继续记录":"整套思考已保存，不会重复记录")
  }catch(err){
    if(err.syncStatus==="pending"){await clearSubmittedContentImageDraft("thoughtRoot");runtime.chainDraftVersion+=1;form.reset();clearDurableDraft("chain-form");resetOccurrenceInput($("#chain-datetime"));runtime.draftTags=[];renderTagComposer();runtime.answerDraft="";runtime.answerReasoningDraft="";delete form.dataset.requestId;delete form.dataset.draftId;$("#chain-status").textContent=recordKind==="capture"?"念起已留存，网络恢复后自动同步。":"思考已留存，网络恢复后自动同步。";closeHomeEditors();showToast(recordKind==="capture"?"念起已进入待同步队列":"思考已进入待同步队列")}
    else{await discardContentImageUploads("thoughtRoot",uploadedPaths);$("#chain-status").textContent=err.message}
  }finally{b.disabled=false;syncChainRecordKind()}
});
$("#chat-form").addEventListener("submit",async e=>{
  e.preventDefault();const form=e.currentTarget,b=form.querySelector("button"),requestId=form.dataset.requestId||crypto.randomUUID(),payload={...occurrenceFields($("#chat-datetime")),message:$("#chat-input").value};form.dataset.requestId=requestId;b.disabled=true;$("#chat-status").textContent="正在结合你已保存的记录…";
  try{await requestV1("/api/v1/chats",{method:"POST",headers:{"idempotency-key":requestId},body:JSON.stringify(payload)},{domains:["chats"]});delete form.dataset.requestId;$("#chat-input").value="";resetOccurrenceInput($("#chat-datetime"));void refreshState("chat").catch(error=>showToast(`回答已保存，但页面刷新失败：${error.message}`,"error"));$("#chat-status").textContent=""}
  catch(err){$("#chat-status").textContent=err.syncStatus==="pending"?"问题已留存，网络恢复后自动处理。":err.message}
  finally{b.disabled=false}
});
$("#edit-checkin-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const id = $("#edit-checkin-id").value;
  const item = (state.checkins || []).find(value => value.id === id);
  const payload = {
    occurredAt: $("#edit-checkin-datetime").value,
    factors: splitTags($("#edit-checkin-factors").value),
    custom: {},
    notes: {}
  };

  $$('[data-edit-checkin-metric]').forEach(input => {
    const key = input.dataset.editCheckinMetric;
    if (input.dataset.custom === "1") {
      payload.custom[key] = Number(input.value);
    } else {
      payload[key] = Number(input.value);
    }
    payload.notes[key] = $(`[data-edit-checkin-note="${CSS.escape(key)}"]`)?.value || "";
  });

  button.disabled = true;
  $("#edit-checkin-status").textContent = "正在保存修改…";
  try {
    await requestV1(
      `/api/v1/checkins/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "if-match": `"${item?.version || 1}"` },
        body: JSON.stringify(payload)
      },
      {
        domains: ["checkins"],
        recoverCommitted: true,
        projection: { kind: "record.update", domain: "checkins", id, payload },
        onQueued: record => applyPendingProjection(record)
      }
    );
    $("#edit-checkin-modal").hidden = true;
    void refreshState(["checkins", "review"])
      .catch(error => showToast(`状态已更新，但列表刷新失败：${error.message}`, "error"));
    showToast("此刻状态已更新");
  } catch (error) {
    if (error.syncStatus === "pending") {
      $("#edit-checkin-modal").hidden = true;
      showToast("状态修改将在网络恢复后同步");
    } else {
      await refreshState(["checkins", "review"]).catch(() => {});
      $("#edit-checkin-status").textContent = error.message;
    }
  } finally {
    button.disabled = false;
  }
});
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
    const result=handleTagMultiSelectKey(runtime.quoteTagStates[key],{
      key:event.key,
      isComposing:event.isComposing,
      selectionStart:event.currentTarget.selectionStart,
      selectionEnd:event.currentTarget.selectionEnd
    });
    if(!result.handled||event.key==="Enter"&&result.intent==="none")return;
    event.preventDefault();runtime.quoteTagStates[key]=result.state;
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
$$("[data-onboarding-mode]").forEach(button=>button.addEventListener("click",()=>{collectOnboardingAnswers();runtime.onboardingMode=button.dataset.onboardingMode==="detailed"?"detailed":"quick";$("#onboarding-understanding").closest("label").hidden=true;$("#onboarding-status").textContent=runtime.onboardingMode==="detailed"?"详细版共 18 题，全部作答后才能完成。":"快速版共 8 题，全部作答后才能完成。";renderOnboardingQuestions()}));
$$("[data-onboarding-sample]").forEach(button=>button.addEventListener("click",()=>{$("#onboarding-material").value=button.dataset.onboardingSample;$("#onboarding-understanding").closest("label").hidden=true}));
$("#onboarding-file").addEventListener("change",async event=>{const file=event.currentTarget.files?.[0];if(!file)return;if(file.size>1024*1024){$("#onboarding-status").textContent="导入文件不能超过 1 MB。";event.currentTarget.value="";return}try{$("#onboarding-material").value=await file.text();$("#onboarding-status").textContent=`已读取 ${file.name}，确认前仍可修改。`}catch{$("#onboarding-status").textContent="文件读取失败，请重试。"}});
$("#onboarding-preview").addEventListener("click",async()=>{const form=$("#onboarding-form"),status=$("#onboarding-status");if(!form.reportValidity()){status.textContent="请先完成当前版本的全部题目。";return}status.textContent="正在整理初始认知…";try{const result=await request("/api/onboarding/preview",{method:"POST",body:JSON.stringify(onboardingPayload())}),understanding=$("#onboarding-understanding");understanding.value=result.understanding;understanding.closest("label").hidden=false;understanding.focus();status.textContent="这是可修改的初步理解，后续真实记录优先。"}catch(error){status.textContent=error.message}});
$("#onboarding-skip").addEventListener("click",()=>{for(const key of["gender","region","occupation","major","school","introduction","works"]){const field=$(`#onboarding-${key}`);if(field)field.value=""}$$('#onboarding-interests input[type="checkbox"]').forEach(input=>input.checked=false);$("#onboarding-material").value="";$("#onboarding-file").value="";$("#onboarding-understanding").value="";$("#onboarding-understanding").closest("label").hidden=true;$("#onboarding-optional").open=false;$("#onboarding-status").textContent="已略过可选资料；完成全部题目后即可开始。"});
$("#onboarding-legacy-back").addEventListener("click",()=>onboardingV2Controller.backFromLegacy());
$("#onboarding-form").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#onboarding-status");if(!form.reportValidity()){status.textContent="请完成当前版本的全部题目。";return}button.disabled=true;try{state.onboarding=await request("/api/onboarding",{method:"PATCH",body:JSON.stringify(onboardingPayload())});await load();showToast("旧版问卷已保存，原始选择继续保留")}catch(error){status.textContent=error.message}finally{button.disabled=false}});
$("#onboarding-v2-reopen").addEventListener("click",()=>{switchView("today");requestAnimationFrame(()=>onboardingV2Controller.reopen())});
function syncLocalDate(){const next=localDateKey();if(next===runtime.currentLocalDate)return;const followedToday=runtime.activeDate===runtime.currentLocalDate;runtime.currentLocalDate=next;if(followedToday){runtime.activeDate=next;renderDate();renderSliders();publishDomains(new Set(["thoughts","activeDate"]));renderStateChart();renderHomeMood();renderChat()}}
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
    event.preventDefault();const form=event.currentTarget,fields=new FormData(form),status=$("#auth-status"),operation=++runtime.authOperationSerial;setAuthBusy(true);status.textContent=formId==="login-form"?"正在登录…":"正在创建账户…";
    try{const result=await authRequest(endpoint,Object.fromEntries(fields));if(operation!==runtime.authOperationSerial)return;form.reset();await restartApplicationForUser(result.user)}
    catch(error){if(operation===runtime.authOperationSerial)status.textContent=error.message}
    finally{if(operation===runtime.authOperationSerial)setAuthBusy(false)}
  });
}
const logout=async()=>{
  if(onboardingV2Controller.hasUnsynced()&&!confirm("当前有尚未同步的五问草稿。退出会从此设备清除这份草稿，仍要退出？"))return;
  const operation=++runtime.authOperationSerial,owner=runtime.currentUser?.id;clearDurableDraft();const clearing=owner?Promise.all([mediaDraftStore.clear(owner),onboardingV2Controller.clearOwner(owner)]):Promise.resolve();showAuthGate();setAuthTab("login");setAuthBusy(true);$("#auth-status").textContent="正在退出…";
  try{await Promise.all([clearing,authRequest("/api/auth/logout",{})])}
  catch(error){if(operation===runtime.authOperationSerial)$("#auth-status").textContent=`本地内容已锁定；服务端退出失败：${error.message}`}
  finally{if(operation===runtime.authOperationSerial){setAuthBusy(false);if($("#auth-status").textContent==="正在退出…")$("#auth-status").textContent=""}}
};
$("#logout-button").addEventListener("click",logout);
return Object.freeze({
  pageRouter,
  switchView,
  restoreView,
  openCaptureFeature,
  openLibraryFeature,
  openQuoteFeature,
  openKeepsakeFeature,
  openDiscoveryItem,
  openCheckinEditor,
  logout
})
}
