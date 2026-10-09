import { sessionScope, sessionSerial } from "../../session/index.mjs";
import { mergeStateSnapshot, publishDomains, state } from "../../state/index.mjs";
import { localDateKey } from "../../time/index.mjs";

export function createDataRuntime({
  runtime,
  apiClient,
  syncStore,
  createRequestCoordinator,
  createRefreshCoordinator,
  createIncrementalSync,
  $,
  getActionsCoordinator,
  renderStateChart,
  renderHomeMood,
  reconcileActiveThoughtRoute,
  clearRouteLoadFailure,
  renderVisibleRoute,
  renderRouteLoadFailure,
  syncBackgroundTaskResults,
  ensureBackgroundResultsController,
  backgroundResultsRetryLimit
} = {}) {
const requestCoordinator=createRequestCoordinator({store:syncStore,send:(url,options)=>request(url,options)});
const refreshCoordinator=createRefreshCoordinator({
  session:sessionScope,
  requestState:async()=>{
    const route=runtime.pageRouter?.currentRoute(),key=routeDataKey(route),snapshot=await requestRouteState(route);
    return key===routeDataKey(runtime.pageRouter?.currentRoute())?{...state,...snapshot}:state
  },
  afterReplace:()=>restorePendingProjections()
});
function setAnswerStatus(id,message,kind="working"){
  document.querySelectorAll(`[data-answer-chain="${CSS.escape(id)}"]`).forEach(button=>{
    let status=button.closest(".chain-expanded")?.querySelector(".card-action-status");
    if(!status){
      status=document.createElement("p");
      status.className="card-action-status";
      status.setAttribute("role","status");
      status.setAttribute("aria-live","polite");
      button.closest(".chain-expanded")?.append(status)
    }
    status.className=`card-action-status ${kind}`;
    status.textContent=message
  })
}
async function request(url,options={}){
  const answerId=url.match(/^\/api\/thoughts\/([^/]+)\/answer$/)?.[1];
  try{
    const result=await apiClient.request(url,options);
    if(answerId)setAnswerStatus(answerId,"回答已生成并保存。","success");
    return result
  }catch(error){
    if(answerId&&error.name!=="AbortError"){
      setAnswerStatus(answerId,`未能生成：${error.message}，可重试。`,"error")
    }
    throw error
  }
}
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
        owner:runtime.currentUser?.id,url,options,domains:syncDomainsFor(url),...coordination,
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
async function loadRouteState(route,requestSerial=++runtime.routeDataRequestSerial){
  const key=routeDataKey(route),owner=runtime.currentUser?.id,session=sessionSerial,panel=$(`#view-${route.view||"today"}`);
  panel?.setAttribute("aria-busy","true");
  try{
    const snapshot=await requestRouteState(route);
    if(requestSerial!==runtime.routeDataRequestSerial||owner!==runtime.currentUser?.id||session!==sessionSerial)return false;
    clearRouteLoadFailure(route);mergeStateSnapshot(snapshot);runtime.loadedRouteKey=key;runtime.fullRouteStateLoaded=Boolean(snapshot?._routeProjection?.complete);runtime.routeDataReady=true;renderVisibleRoute();runtime.runtimeFeatureRegistry?.notifyState(state,new Set(Object.keys(snapshot||{})));reconcileActiveThoughtRoute();return true
  }catch(error){
    if(requestSerial===runtime.routeDataRequestSerial&&owner===runtime.currentUser?.id&&session===sessionSerial){runtime.routeLoadFailureKey=key;renderRouteLoadFailure(route);showToast("当前页面读取失败，已有记录没有变化。","error")}
    return false
  }finally{
    if(requestSerial===runtime.routeDataRequestSerial)panel?.removeAttribute("aria-busy")
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
  try{
    const result=await apiClient.requestStream(url,options,onEvent);
    if(answerId)setAnswerStatus(answerId,"回答已生成并保存。","success");
    return result
  }catch(error){
    if(answerId&&error.name!=="AbortError"){
      setAnswerStatus(answerId,`未能生成：${error.message}，可重试。`,"error")
    }
    throw error
  }
}
function showToast(message,kind="success"){
  const toast=$("#toast");
  toast.textContent=message;
  toast.className=`toast ${kind}`;
  toast.hidden=false;
  clearTimeout(runtime.toastTimer);
  runtime.toastTimer=setTimeout(()=>toast.hidden=true,3200)
}
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
  if(projection.kind==="action.command")return getActionsCoordinator().applyPendingRecord(record);
  return false
}
async function restorePendingProjections(){
  const owner=runtime.currentUser?.id,session=sessionSerial;if(!owner)return 0;
  const records=await requestCoordinator.list(owner,["pending","sending"]);
  if(owner!==runtime.currentUser?.id||session!==sessionSerial)return 0;
  let restored=0;
  for(const record of records){
    if(owner!==runtime.currentUser?.id||session!==sessionSerial)return restored;
    if(applyPendingProjection(record))restored+=1
  }
  const route=runtime.pageRouter?.currentRoute();
  if(runtime.routeLoadFailureKey&&routeDataKey(route)===runtime.routeLoadFailureKey)renderRouteLoadFailure(route);
  return restored
}
async function applyIncrementalSnapshot(snapshot,changes){
  const domains=mergeStateSnapshot(snapshot);
  getActionsCoordinator().applyIncrementalSnapshot(snapshot,{sessionTicket:sessionScope.capture()});
  const rendered=new Set([...domains].filter(domain=>!["actions","habits","habitCheckins"].includes(domain)));
  if(domains.has("clusters")||domains.has("insights"))rendered.add("review");
  if(rendered.size)publishDomains(rendered);
  await restorePendingProjections();
  return changes.length
}
async function updateSyncHealth(event){
  if(!runtime.currentUser?.id)return;
  if(event.type==="operation")getActionsCoordinator().applyOperationStatus(event);
  const metrics=await requestCoordinator.metrics(runtime.currentUser.id);
  const oldest=metrics.oldestPendingAt?Math.max(0,Date.now()-new Date(metrics.oldestPendingAt).getTime()):0;
  runtime.syncHealth={
    status:event.type==="disabled"?"disabled":metrics.conflicts?"conflict":event.type==="error"||metrics.failed?"error":metrics.pending?"pending":metrics.durable?"synced":"degraded",
    pending:metrics.pending,
    conflicts:metrics.conflicts,
    failed:metrics.failed,
    oldestAgeMs:oldest,
    enqueueToAckP95Ms:metrics.enqueueToAckP95Ms,
    lastPullMs:event.type==="pull"?event.durationMs:runtime.syncHealth.lastPullMs,
    lastError:event.type==="error"?(event.code||"SYNC_FAILED"):""
  };
  runtime.runtimeFeatureRegistry?.notifyState(state,new Set(["syncHealth"]))
}
runtime.syncController=createIncrementalSync({
  coordinator:requestCoordinator,
  request:url=>requestV1(url),
  applySnapshot:applyIncrementalSnapshot,
  resnapshot:async()=>{
    await refreshState(["checkins","dailyRecords","captures","journals","thoughts","chat","review","books","keepsakes","quotes","notifications","onboardingV2","feedback"]);
    await getActionsCoordinator().load()
  },
  onStatus:event=>void updateSyncHealth(event)
});
function notificationUnread(snapshot=state){
  const items=snapshot.notifications||[];
  return Number(snapshot.notificationUnread??runtime.notificationUnreadCount)||items.filter(item=>!item.readAt&&["succeeded","failed","stale","cancelled"].includes(item.status)).length
}
function renderNotificationSummary(){
  const unread=notificationUnread();
  $("#notification-dot").hidden=!unread;
}
function publishNotificationState(){
  renderNotificationSummary();
  runtime.runtimeFeatureRegistry?.notifyState(state,new Set(["notifications","aiTasks","notificationUnread"]))
}
function scheduleNotificationPoll(){
  clearTimeout(runtime.notificationTimer);
  const active=(state.aiTasks||[]).some(task=>["queued","running","cancelling"].includes(task.status)),retrying=runtime.backgroundResultsRetryAttempts>0&&runtime.backgroundResultsRetryAttempts<backgroundResultsRetryLimit;
  if(!active&&!retrying)return;
  runtime.notificationTimer=setTimeout(async()=>{try{await loadNotifications()}finally{scheduleNotificationPoll()}},1800);
}
async function loadNotifications(){
  const owner=runtime.currentUser?.id,session=sessionSerial;
  runtime.notificationsLoadState="loading";
  publishNotificationState();
  try{
    const [notifications,tasks]=await Promise.all([
      request("/api/notifications"),
      request("/api/ai-tasks")
    ]);
    if(owner!==runtime.currentUser?.id||session!==sessionSerial)return false;

    state.notifications=notifications.items||[];
    state.aiTasks=tasks.items||[];
    runtime.notificationUnreadCount=Number(notifications.unread)||0;
    state.notificationUnread=runtime.notificationUnreadCount;
    runtime.notificationsLoadState="ready";
    publishNotificationState();
    await syncBackgroundTaskResults(state.aiTasks,owner,session);
    return true
  }catch(error){
    if(owner===runtime.currentUser?.id&&session===sessionSerial){
      runtime.notificationsLoadState="failure";
      publishNotificationState()
    }
    return false
  }
}
async function openAiTaskTarget(task,notification){
  const owner=runtime.currentUser?.id,session=sessionSerial;
  try{
    const controller=await ensureBackgroundResultsController();
    if(owner!==runtime.currentUser?.id||session!==sessionSerial)return false;
    runtime.backgroundResultsLoadErrorReported=false;
    runtime.backgroundResultsRetryAttempts=0;
    return await controller.openTarget(task,notification)
  }catch(error){
    if(owner===runtime.currentUser?.id&&session===sessionSerial){
      showToast(`无法定位后台结果：${error.message}`,"error")
    }
    return false
  }
}
const refreshState=(domains,options={})=>refreshCoordinator.refresh(domains,{...options,patchOnly:options.patchOnly===true});
return Object.freeze({
  requestCoordinator,
  refreshCoordinator,
  setAnswerStatus,
  request,
  requestV1,
  routeDataKey,
  routeStateUrl,
  requestRouteState,
  loadRouteState,
  listAllV1,
  optionalRequest,
  optionalPublicRequest,
  requestStream,
  showToast,
  applyPendingProjection,
  restorePendingProjection,
  restorePendingProjections,
  applyIncrementalSnapshot,
  updateSyncHealth,
  notificationUnread,
  renderNotificationSummary,
  publishNotificationState,
  scheduleNotificationPoll,
  loadNotifications,
  openAiTaskTarget,
  refreshState
})
}
