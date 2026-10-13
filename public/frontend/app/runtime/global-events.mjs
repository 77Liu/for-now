import { sessionSerial } from "../../session/index.mjs";
import { publishDomains, state } from "../../state/index.mjs";
import { viewSections } from "../../pages/index.mjs";
import { installAuthEvents } from "./auth-events.mjs";
import { installOnboardingEvents } from "./onboarding-events.mjs";
import { installCheckinEditEvent, installCheckinSubmissionEvent } from "./checkin-events.mjs";
import { installRecordSubmissionEvents } from "./record-events.mjs";
import { installQuoteSubmissionEvent } from "./quote-events.mjs";

export function installGlobalEvents({
  runtime,$,$$,actionsCoordinator,testSupport,
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
  resolvePersonalizedTask,
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
const pageEffects = {
  today: () => {
    if (runtime.applicationLifecycleReady && runtime.currentUser?.id) {
      void actionsCoordinator.load();
    }
  }
};
const lazyPageEffects = Object.fromEntries(Object.keys(viewSections).map(view=>[
  view,()=>{
    void testSupport.ensureView(view).then(async ready=>{
      if(!ready)return;
      if(typeof pageEffects[view]==="function")await pageEffects[view]();
      await restorePendingProjections()
    })
  }
]));
const pageRouter=createPageRouter({query:$,queryAll:$$,effects:lazyPageEffects,basePath:applicationBasePath,onRouteStart:applyApplicationRoute,canAccessView:(_,capability)=>hasCapability(capability),onDenied:showPermissionPage});
const {switchView,restoreView}=pageRouter;
installOnboardingEvents({
  $, $$, runtime, collectOnboardingAnswers, renderOnboardingQuestions,
  onboardingPayload, onboardingV2Controller, load, request, showToast, switchView
});
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
  const item = state.checkins.find(value => value.id === id);
  if (!item) return;

  $("#edit-checkin-id").value = id;
  $("#edit-checkin-datetime").value = persistedDateTimeInput(item);
  $("#edit-checkin-factors").value = (item.factors || []).join(" ");
  $("#edit-checkin-status").textContent = "";

  const metrics = Object.entries(metricConfig()).map(([key, config]) => {
    const value = Number(metricValue(item, key, config.custom)) || 3;
    const note = item.notes?.[key] || "";
    const options = config.anchors.map((anchor, index) => {
      const selected = value === index + 1 ? "selected" : "";
      return `<option value="${index + 1}" ${selected}>${index + 1} · ${escapeHtml(anchor)}</option>`;
    }).join("");

    return `<label class="edit-checkin-metric"><span>${escapeHtml(config.label)}</span><select data-edit-checkin-metric="${escapeHtml(key)}" data-custom="${config.custom ? "1" : "0"}">${options}</select><input data-edit-checkin-note="${escapeHtml(key)}" value="${escapeHtml(note)}" maxlength="800" placeholder="备注（可空）"></label>`;
  }).join("");

  $("#edit-checkin-metrics").innerHTML = metrics;
  $("#edit-checkin-modal").hidden = false;
  $("#edit-checkin-factors").focus();
}

document.addEventListener("play", event => {
  const audio = event.target;
  if (!(audio instanceof HTMLAudioElement)) return;

  const controls = audio.closest(".speech-asset-controls");
  const rate = controls?.querySelector("[data-speech-playback-rate]");
  if (rate) audio.playbackRate = normalizeTtsPlaybackRate(rate.value);
  claimPageAudio(audio);
}, true);

document.addEventListener("click", async event => {
  const button = event.target.closest("[data-delete-checkin],[data-chat-delete]");
  if (!button) return;

  const target = button.dataset.deleteCheckin
    ? {
        id: button.dataset.deleteCheckin,
        domain: "checkins",
        url: `/api/v1/checkins/${encodeURIComponent(button.dataset.deleteCheckin)}`,
        domains: ["checkins", "review"],
        label: "状态"
      }
    : {
        id: button.dataset.chatDelete,
        domain: "chats",
        url: `/api/v1/chats/${encodeURIComponent(button.dataset.chatDelete)}`,
        domains: ["chats"],
        label: "对话"
      };

  if (!confirm(`将这条${target.label}移入回收站？`)) return;

  const item = (state[target.domain] || []).find(value => value.id === target.id);
  if (!item) return;

  const requestId = button.dataset.requestId || crypto.randomUUID();
  button.dataset.requestId = requestId;
  button.disabled = true;

  try {
    await requestV1(target.url, {
      method: "DELETE",
      headers: {
        "if-match": `"${item.version || 1}"`,
        "idempotency-key": requestId
      }
    }, {
      domains: target.domains,
      resource: target.url,
      recoverCommitted: true,
      projection: { kind: "record.delete", domain: target.domain, id: target.id },
      onQueued: record => applyPendingProjection(record)
    });
    void refreshState(target.domains).catch(error =>
      showToast(`${target.label}已移除，但列表刷新失败：${error.message}`, "error")
    );
    showToast(`${target.label}已移入回收站`);
  } catch (error) {
    if (error.syncStatus === "pending") {
      showToast(`${target.label}将在网络恢复后移入回收站`);
    } else {
      await refreshState(target.domains).catch(() => {});
      showToast(error.message, "error");
    }
  }
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

document.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button || button.closest("#view-ai-cost,#view-architecture,#view-commercialization")) {
    return;
  }
  if (button.dataset.view) {
    closeHomeEditors({restoreFocus: false});
    return switchView(button.dataset.view);
  }
  if (button.dataset.go) {
    closeHomeEditors({restoreFocus: false});
    return switchView(button.dataset.go);
  }
  if (button.dataset.removeDraftTag != null) {
    runtime.draftTags = runtime.draftTags.filter(tag => tag !== button.dataset.removeDraftTag);
    return renderTagComposer();
  }
});
document.addEventListener("click",async e=>{
  const button=e.target.closest("button");if(!button)return;
  if(button.dataset.editCheckin)return openCheckinEditor(button.dataset.editCheckin);
});
$$("[data-active-date]").forEach(input => input.addEventListener("change", async event => {
  runtime.chainDraftVersion += 1;
  runtime.activeDate = event.target.value || runtime.activeDate;
  renderDate();
  renderSliders();
  publishDomains(new Set(["thoughts", "activeDate"]));
  renderStateChart();
  renderHomeMood();
  renderChat();
  await runtime.healthFeatureController?.changeDate(runtime.activeDate)
    .catch(error => showToast(`健康截图恢复失败：${error.message}`, "error"));
}));
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
$("#checkin-confirm-all").addEventListener("click", () => {
  $$("[data-metric]").forEach(input => {
    input.dataset.confirmed = "true";
    input.closest(".metric").classList.remove("unconfirmed");
    const label = metricConfig()[input.dataset.metric];
    $(`#${CSS.escape(input.dataset.metric)}-anchor`).textContent = label.anchors[Number(input.value) - 1];
  });
  navigator.vibrate?.(12);
  $("#checkin-status").textContent = "已确认当前四项，可以直接保存。";
});
$("#chain-tags").addEventListener("keydown",e=>{if(entryKeyIntent(e,{inputKind:"tag"})==="commit-tag"){e.preventDefault();commitDraftTags()}});
$("#chain-form").elements.recordKind.forEach(input=>input.addEventListener("change",()=>{runtime.chainDraftVersion+=1;delete $("#chain-form").dataset.requestId;syncChainRecordKind()}));
$("#thought-source-cancel").addEventListener("click", () => {
  const form = $("#chain-form");
  form.reset();
  clearDurableDraft("chain-form");
  resetOccurrenceInput($("#chain-datetime"));
  runtime.draftTags = [];
  renderTagComposer();
  runtime.answerDraft = "";
  runtime.answerReasoningDraft = "";
  $("#chain-status").textContent = "已取消从念起展开，可以重新记录。";
  $("#chain-question").focus();
});
for (const selector of ["#chain-question", "#chain-idea", "#chain-answer"]) {
  $(selector).addEventListener("input", () => {
    runtime.chainDraftVersion += 1;
    if (selector !== "#chain-answer") {
      runtime.answerDraft = "";
      runtime.answerReasoningDraft = "";
    }
    delete $("#chain-form").dataset.requestId;
  });
}
$("#chain-form").addEventListener("reset", event => {
  runtime.chainDraftVersion += 1;
  resetContentImageEditor("thoughtRoot");
  delete event.currentTarget.dataset.draftId;
  event.currentTarget.elements.sourceCaptureId.value = "";
  event.currentTarget.elements.sourceCaptureVersion.value = "";
  queueMicrotask(syncChainRecordKind);
});
for(const id of durableDraftForms)for(const eventName of["input","change"])document.getElementById(id)?.addEventListener(eventName,saveDurableDrafts);
document.addEventListener("keydown",event=>{
  const field=event.target.closest?.("input,textarea"),form=field?.closest?.("#chain-form,#checkin-form,#chat-form,[data-daily-form],[data-book-entry-form],#quote-form,#selection-quote-form,#thought-block-form");
  if(!field||!form||field===document.activeElement&&["chain-tags","quote-tags","selection-quote-tags"].includes(field.id))return;
  const intent=entryKeyIntent(event,{inputKind:field.tagName==="TEXTAREA"?"multiline":"field"});
  if(intent==="submit")return void occurrenceKeyboardSubmit(event,form,field.tagName==="TEXTAREA"?"multiline":"field");
  if(intent==="block-submit")event.preventDefault()
});
installCheckinSubmissionEvent({
  $, $$, showToast, requestV1, refreshState, localDateKey, metricConfig, splitTags,
  clearDurableDraft, resetOccurrenceInput, occurrenceFields,
  renderStateChart, renderHomeMood, renderSliders, closeHomeEditors
});
installRecordSubmissionEvents({
  runtime, $, showToast, requestV1, refreshState, applyPendingProjection,
  clearDurableDraft, resetOccurrenceInput, occurrenceFields,
  contentImagePaths, imageRecordPayload, captureRecordPayload, publishDomains,
  clearSubmittedContentImageDraft, discardContentImageUploads,
  renderTagComposer, closeHomeEditors, request, runAnswerInModal, requestStream,
  resolvePersonalizedTask,
  startBackgroundChainAnswer, commitDraftTags, chainRecordKind,
  syncChainRecordKind
});
installCheckinEditEvent({ $, $$, showToast, requestV1, refreshState, applyPendingProjection, splitTags });
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
installQuoteSubmissionEvent({
  $, occurrenceFields, quoteTagsForSubmission, requestV1,
  applyPendingProjection, closeSelectionQuoteModal, refreshState, showToast
});
function syncLocalDate() {
  const next = localDateKey();
  if (next === runtime.currentLocalDate) return;
  const followedToday = runtime.activeDate === runtime.currentLocalDate;
  runtime.currentLocalDate = next;
  if (!followedToday) return;
  runtime.activeDate = next;
  renderDate();
  renderSliders();
  publishDomains(new Set(["thoughts", "activeDate"]));
  renderStateChart();
  renderHomeMood();
  renderChat();
}
function markApplicationForeground(){apiClient.markForeground();syncLocalDate();restoreView?.()}
setInterval(syncLocalDate,30000);
document.addEventListener("visibilitychange",()=>{if(document.hidden){saveDurableDrafts();stopPageAudio()}else markApplicationForeground()});
window.addEventListener("pagehide",()=>{saveDurableDrafts();stopPageAudio()});
window.addEventListener("pageshow",markApplicationForeground);
const logout = installAuthEvents({
  $, $$, runtime, onboardingV2Controller, clearDurableDraft, mediaDraftStore,
  setAuthTab, setAuthBusy, authRequest, restartApplicationForUser, showAuthGate
});
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
