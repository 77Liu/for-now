import { state } from "../../state/index.mjs";
import { isPendingAiTaskStatus, isWaitingForUserModelTask, pendingAiTaskMessage } from "../../shared/ai-task-status.mjs";

export function createContentMediaRuntime({
  runtime,$,mediaDraftStore,runPublicValidation,validatedImageFiles,
  uploadPendingMediaItems,uploadOriginalImages,request,imageRecordPayload,
  parseCommentRootKey,toLocalDateTimeInput,eventTimestamp,apiClient,showToast,
  presentError,requestV1,imageUnderstandingPayload,refreshState,
  scheduleNotificationPoll,appUrl,escapeHtml,renderMarkdown
} = {}) {
const persistentContentImageKeys=new Set(["capture","thoughtRoot","thoughtBlock","comment"]);
const imageViewer={paths:[],index:0,objectUrl:"",requestSerial:0,trigger:null};
let contentImageDraftManager=null,contentImageDraftManagerRequest=null;
const uncertainMediaSubmission=error=>{const status=Number(error?.status||error?.statusCode||0);return!status||[408,425,429].includes(status)||status>=500};
const imageDataUrls=files=>Promise.all(files.map(file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("无法读取图片，请重新选择"));reader.readAsDataURL(file)})));
async function initializeContentImageDraftManager(){
  if(contentImageDraftManager)return contentImageDraftManager;
  const pending=contentImageDraftManagerRequest||import("../../media/content-image-drafts.mjs");
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
function contentImageDraft(key){return contentImageDraftManager?.snapshot(key)||{owner:"",key,items:[],uploadRequestId:"",context:null}}
function currentContentImageContext(key){
  if(key==="comment")return runtime.annotationsController?.commentDraftContext()||null;
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
  if(!runtime.currentUser?.id||!persistentContentImageKeys.has(key)||(key==="capture"&&$("#capture-id")?.value))return;
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
  if(!hasDraft||(view&&runtime.pageRouter?.currentRoute()?.view!==view))return false;
  renderContentImageEditor(key);
  const status=document.querySelector(`[data-content-image-editor="${CSS.escape(key)}"]`)?.closest("form")?.querySelector(".status");
  if(status&&!status.textContent){
    const failed=draft.items.filter(item=>item.lastError).length;
    status.textContent=draft.items.length?`已恢复 ${draft.items.length} 张待上传图片${failed?`，其中 ${failed} 张可重试`:""}。`:"已恢复未提交评论。"
  }
  if(key==="comment"){
    if(!runtime.annotationsController)return false;
    const restored=runtime.annotationsController.restoreCommentDraft(draft.context);
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
function activateContentImageDraftsForCurrentRoute(owner=runtime.currentUser?.id){
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
  if(owner!==runtime.currentUser?.id)return false;
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
  if(!contentImageDraftManager)return Promise.resolve(false);
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
function pendingContentImageTask(targetType, targetId) {
  return (state.aiTasks || []).find(task => (
    task.kind === "contentImageUnderstanding"
    && task.contentTargetType === targetType
    && task.contentTargetId === targetId
    && isPendingAiTaskStatus(task.status)
  ));
}
function contentImagesMarkup(resource, targetType) {
  const paths = Array.isArray(resource?.attachmentPaths) ? resource.attachmentPaths : [];
  const understandings = Array.isArray(resource?.imageUnderstandings)
    ? resource.imageUnderstandings
    : [];
  if (!paths.length && !understandings.length) return "";
  const pending = pendingContentImageTask(targetType, resource.id);
  const originals = paths.length
    ? `<div class="content-originals">${paths.map((source, index) => (
      `<button class="content-original-button" type="button" data-image-viewer-path="${escapeHtml(source)}" title="查看原图 ${index + 1}" aria-label="查看原图 ${index + 1}"><img src="${escapeHtml(appUrl(source))}" alt="图片 ${index + 1}" loading="lazy"></button>`
    )).join("")}</div>`
    : "";
  const understandingMarkup = understandings.map(item => (
    `<div class="content-understanding"><small>AI 图片理解</small><div class="markdown-content">${renderMarkdown(item.content)}</div></div>`
  )).join("");
  const actions = paths.length
    ? `<div class="content-image-actions"><button type="button" data-content-image-understand="${escapeHtml(targetType)}" data-content-target-id="${escapeHtml(resource.id)}" data-content-version="${resource.version || 1}" ${pending ? "disabled" : ""}>✦ ${understandings.length ? "重新理解" : "理解图片"}</button><span class="content-image-task-status">${pending ? pendingAiTaskMessage(pending, "正在后台理解…") : ""}</span></div>`
    : "";
  return `<section class="content-attachments" data-content-attachments="${escapeHtml(targetType)}:${escapeHtml(resource.id)}">${originals}${understandingMarkup}${actions}</section>`;
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
async function queueContentImageUnderstanding(button) {
  const targetType = button.dataset.contentImageUnderstand;
  const targetId = button.dataset.contentTargetId;
  const resource = contentImageResource(targetType, targetId);
  const requestId = button.dataset.requestId || crypto.randomUUID();
  if (!resource?.attachmentPaths?.length) return;
  button.dataset.requestId = requestId;
  button.disabled = true;
  const status = button.parentElement?.querySelector(".content-image-task-status");
  if (status) status.textContent = "正在加入后台队列…";
  try {
    const response = await requestV1("/api/v1/content-attachments/understandings", {
      method: "POST",
      headers: { "idempotency-key": requestId },
      body: JSON.stringify(imageUnderstandingPayload({
        targetType,
        targetId,
        inputVersion: resource.version || 1,
        attachmentPaths: resource.attachmentPaths
      }))
    });
    const task = response.data;
    if (task && !state.aiTasks.some(item => item.id === task.id)) state.aiTasks.unshift(task);
    if (status) status.textContent = pendingAiTaskMessage(task, "正在后台理解…");
    await refreshState("notifications");
    scheduleNotificationPoll();
    showToast(isWaitingForUserModelTask(task)
      ? "图片理解等待核心用户模型就绪"
      : "图片理解已进入后台队列");
  } catch (error) {
    const message=presentError(error,{
      operation:"提交图片理解",
      object:"这次图片理解",
      phase:"图片理解排队",
      retained:"原图和已有记录已经保存"
    }).message;
    if (status) status.textContent = message;
    button.disabled = false;
    showToast(message, "error");
  }
}
return Object.freeze({
  get manager(){return contentImageDraftManager},
  persistentContentImageKeys,
  initializeContentImageDraftManager,
  uncertainMediaSubmission,
  imageDataUrls,
  contentImageDraft,
  persistContentImageDraft,
  activateContentImageDraft,
  activateContentImageDraftsForCurrentRoute,
  restoreContentImageDrafts,
  abandonContentImageDraft,
  renderContentImageEditor,
  resetContentImageEditor,
  clearSubmittedContentImageDraft,
  setContentImageFiles,
  contentImagePaths,
  discardUploadedMediaItem,
  discardUploadedImagePath,
  discardContentImageUploads,
  viewerAttachmentPath,
  openImageViewer,
  closeImageViewer,
  moveImageViewer,
  contentImagesMarkup,
  queueContentImageUnderstanding
})
}
