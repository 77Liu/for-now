import { THOUGHT_PAGING } from "../../../generated/thought-pagination-config.mjs";
import { reconcileThoughtWindowMutation, applyThoughtWindowSync, applyThoughtDetailSync } from "../../features/thoughts/index.mjs";
import { createNotificationRuntime } from "../../../generated/app/runtime/notification-runtime.mjs";
import { BUSINESS_ID_BYTES, encodeBusinessId, isBusinessId } from "../../../generated/business-identifiers.mjs";
import { sessionScope, sessionSerial } from "../../session/index.mjs";
import { mergeStateSnapshot, publishDomains, state } from "../../state/index.mjs";
import { localDateKey } from "../../time/index.mjs";
import { isPendingAiTaskStatus } from "../../shared/ai-task-status.mjs";
import { createPersonalizedTaskRuntime } from "./personalized-task-runtime.mjs";

export function createDataRuntime({
  runtime,
  apiClient,
  syncStore,
  createRequestCoordinator,
  createRefreshCoordinator,
  createIncrementalSync,
  createRecordSyncLoop,
  applyRecordBatch,
  rebaseRecordScopes,
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
// 真实publicControl提供mode/switchedAt；snapshotAt/loadedScopes不是工作区身份。
const syncWorkspace=()=>runtime.localTestConfig?.enabled
  ?JSON.stringify([runtime.localTestConfig.mode,runtime.localTestConfig.switchedAt||""]):"";
const syncScope=()=>String(sessionSerial);
function captureDataScope(){
  const owner=runtime.currentUser?.id,session=sessionSerial,workspace=syncWorkspace();
  return{owner,session,workspace,isCurrent:()=>owner===runtime.currentUser?.id&&session===sessionSerial&&workspace===syncWorkspace()}
}
const requestCoordinator=createRequestCoordinator({store:syncStore,send:(url,options)=>request(url,options),getWorkspace:syncWorkspace,getScope:syncScope});
const refreshCoordinator=createRefreshCoordinator({
  session:sessionScope,
  requestState:async()=>{
    const route=runtime.pageRouter?.currentRoute(),key=routeDataKey(route),snapshot=await requestRouteState(route);
    if(key!==routeDataKey(runtime.pageRouter?.currentRoute()))return state;
    if(!runtime.featureFlags?.recordSyncV2)return{...state,...snapshot};
    const{thoughts:_recordThoughts,thoughtPage:_recordPage,...legacySnapshot}=snapshot;
    return{...state,...legacySnapshot}
  },
  afterReplace:consumer=>restorePendingProjections(consumer)
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
  if(projection.kind==="book.note.create")return{kind:projection.kind,domain:"books",bookId:projection.bookId,temporaryId:projection.temporaryId};
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
    state.thoughts=(state.thoughts||[]).filter(item=>(item.id!==snapshot.temporaryId&&!String(item.id).startsWith(prefix))||item._sync?.operationId!==operationId);
    if(state.thoughts.length===previousLength)return false;
    publishThoughtMutation();return true
  }
  if(snapshot.kind==="book.note.create"){
    const book=(state.books||[]).find(item=>item.id===snapshot.bookId);if(!book)return false;
    const previousLength=(book.notes||[]).length;
    book.notes=(book.notes||[]).filter(item=>item.id!==snapshot.temporaryId||item._sync?.operationId!==operationId);
    if(book.notes.length===previousLength)return false;
    publishDomains(new Set(["books"]));return true
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
    state.thoughts[index]=root.value;publishThoughtMutation();return true
  }
  if(snapshot.kind==="thought.chain.delete"){
    if((state.thoughts||[]).some(item=>item.id===snapshot.id))return false;
    for(const entry of [...snapshot.items].sort((left,right)=>left.index-right.index)){
      if(!state.thoughts.some(item=>item.id===entry.value.id))state.thoughts.splice(Math.min(entry.index,state.thoughts.length),0,entry.value)
    }
    publishThoughtMutation();return true
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
    delete root._sync;publishThoughtMutation();return true
  }
  return false
}
async function requestV1(url,options={},coordination={}){
  const method=String(options.method||"GET").toUpperCase();
  const consumer=captureDataScope();
  let result,operationId="";
  if(["GET","HEAD"].includes(method))result=await request(url,options);
  else{
    if(method==="POST"&&coordination.projection?.temporaryId&&!isBusinessId(coordination.projection.temporaryId)){
      coordination.projection.temporaryId=encodeBusinessId(crypto.getRandomValues(new Uint8Array(BUSINESS_ID_BYTES)));
    }
    const snapshot=typeof coordination.captureProjection==="function"
      ?coordination.captureProjection()
      :pendingProjectionSnapshot(coordination.projection),onQueued=coordination.onQueued;
    try{
      result=await requestCoordinator.request({
        allocateBusinessId:true,
        provisionalId:isBusinessId(coordination.projection?.temporaryId)?coordination.projection.temporaryId:"",
        owner:runtime.currentUser?.id,url,options,domains:syncDomainsFor(url),...coordination,
        onQueued:record=>{operationId=record.operationId;if(consumer.isCurrent())return onQueued?.(record)}
      });
      if(!consumer.isCurrent())throw new DOMException("数据作用域已变化","AbortError");
      settlePendingProjection(coordination.projection,operationId,result?.data);
      if(coordination.projection?.kind==="thought.chain.delete"){
        const id=coordination.projection.id,previousLength=(state.thoughts||[]).length;
        state.thoughts=(state.thoughts||[]).filter(item=>item.id!==id&&item.relatedTo!==id);
        if(state.thoughts.length!==previousLength)publishThoughtMutation();
        reconcileActiveThoughtRoute()
      }
    }catch(error){
      if(consumer.isCurrent()&&["failed","conflict"].includes(error?.syncStatus)){
        if(typeof coordination.restoreProjection==="function")await coordination.restoreProjection(snapshot,operationId,error);
        else restorePendingProjection(snapshot,operationId)
      }
      throw error
    }
  }
  if(!consumer.isCurrent())throw new DOMException("数据作用域已变化","AbortError");
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
    const recordOwned=runtime.featureFlags?.recordSyncV2&&runtime.applicationLifecycleReady;
    const incoming=recordOwned?(({thoughts:_recordThoughts,thoughtPage:_recordPage,...rest})=>rest)(snapshot):snapshot;
    clearRouteLoadFailure(route);mergeStateSnapshot(incoming);runtime.loadedRouteKey=key;runtime.fullRouteStateLoaded=Boolean(snapshot?._routeProjection?.complete);runtime.routeDataReady=true;
    if(recordOwned)await runtime.syncController?.rebaseRecords?.();
    renderVisibleRoute();runtime.runtimeFeatureRegistry?.notifyState(state,new Set(Object.keys(incoming||{})));reconcileActiveThoughtRoute();
    return true
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
function publishThoughtMutation() {
  reconcileThoughtWindowMutation(state, runtime.pageRouter?.currentRoute(), runtime.featureFlags?.thoughtPaging?.enabled, THOUGHT_PAGING);
  publishDomains(new Set(["thoughts"]));
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
    if((state.thoughts||[]).some(item=>item.clientRequestId===record.operationId||item.id===projection.temporaryId||String(item.id).startsWith(`${projection.temporaryId}:`)))return false;
    const occurredAt=projection.payload.occurredAt||record.createdAt,rootId=isBusinessId(projection.temporaryId)?projection.temporaryId:`${projection.temporaryId}:root`,items=[{
      id:rootId,type:"question",content:projection.payload.question||"",attachmentPaths:projection.payload.attachmentPaths||[],
      tags:projection.payload.tags||[],authorType:"user",occurredAt,createdAt:record.createdAt,version:1,_sync:sync,
      ...(projection.payload.sourceRef?{sourceRef:projection.payload.sourceRef}:{})
    }];
    if(projection.payload.idea)items.push({id:`${projection.temporaryId}:idea`,type:"idea",relatedTo:rootId,content:projection.payload.idea,authorType:"user",occurredAt,createdAt:record.createdAt,version:1,_sync:sync});
    if(projection.payload.answer)items.push({id:`${projection.temporaryId}:answer`,type:"answer",relatedTo:rootId,content:projection.payload.answer,authorType:"user",occurredAt,createdAt:record.createdAt,version:1,_sync:sync});
    state.thoughts=[...items,...state.thoughts];publishThoughtMutation();return true
  }
  if(projection.kind==="thought.chain.delete"){
    const previousLength=(state.thoughts||[]).length;
    state.thoughts=(state.thoughts||[]).filter(item=>item.id!==projection.id&&item.relatedTo!==projection.id);
    if(state.thoughts.length===previousLength)return false;
    publishThoughtMutation();return true
  }
  if(projection.kind==="thought.chain.update"){
    const root=(state.thoughts||[]).find(item=>item.id===projection.id&&item.type==="question");
    if(!root)return false;
    Object.assign(root,{content:projection.payload.question,tags:projection.payload.tags,occurredAt:projection.payload.occurredAt,_sync:sync});
    publishThoughtMutation();return true
  }
  if(projection.kind==="action.command")return getActionsCoordinator().applyPendingRecord(record);
  return false
}
async function restorePendingProjections(recovery=null){
  const consumer=captureDataScope(),owner=consumer.owner;
  const current=()=>consumer.isCurrent()&&(!recovery||recovery.isCurrent());
  if(!owner||!current())return 0;
  const records=await requestCoordinator.list(owner,["pending","sending"]);
  if(!current())return 0;
  let restored=0;
  for(const record of records){
    if(!current())return restored;
    if(applyPendingProjection(record))restored+=1
  }
  const route=runtime.pageRouter?.currentRoute();
  if(runtime.routeLoadFailureKey&&routeDataKey(route)===runtime.routeLoadFailureKey)renderRouteLoadFailure(route);
  return restored
}
async function applyIncrementalSnapshot(snapshot,changes,consumer=captureDataScope()){
  if(!consumer.isCurrent())return false;
  let incoming = snapshot, thoughtWindowInvalidated = false;
  if(runtime.featureFlags?.recordSyncV2&&Object.hasOwn(incoming||{},"thoughts")){
    const{thoughts:_recordOwnedThoughts,...legacyOnly}=incoming;
    incoming=legacyOnly
  }
  if (!runtime.featureFlags?.recordSyncV2
    && runtime.featureFlags?.thoughtPaging?.enabled
    && Object.hasOwn(snapshot || {}, "thoughts")) {
    const { thoughts: _fullThoughts, ...other } = snapshot;
    const route = runtime.pageRouter?.currentRoute();
    if (route?.view === "thoughts" && route.kind !== "detail" && state.thoughtPage?.kind === "list") {
      thoughtWindowInvalidated = applyThoughtWindowSync(state, snapshot.thoughts, route, THOUGHT_PAGING, id => {
        const card = document.querySelector(`#all-thoughts [data-chain-id="${CSS.escape(id)}"]`);
        if (runtime.annotationsController?.isActiveRoot?.(`thought:${id}`)) return false;
        if (!card) return true;
        if (card.contains(document.activeElement)) return false;
        const selection = document.getSelection();
        if (selection && !selection.isCollapsed && (card.contains(selection.anchorNode) || card.contains(selection.focusNode))) return false;
        const rect = card.getBoundingClientRect();
        return rect.bottom <= 0 || rect.top >= window.innerHeight;
      }, changes);
      incoming = other;
    } else if (route?.view === "thoughts" && route.kind === "detail") {
      const rootId = route.resourceId;
      incoming = { ...other, thoughts: applyThoughtDetailSync(state.thoughts || [], snapshot.thoughts, rootId) };
    } else incoming = other;
  }
  const domains=mergeStateSnapshot(incoming);
  getActionsCoordinator().applyIncrementalSnapshot(snapshot,{sessionTicket:sessionScope.capture()});
  const rendered=new Set([...domains].filter(domain=>!["actions","habits","habitCheckins"].includes(domain)));
  if(thoughtWindowInvalidated || domains.has("thoughtPage"))rendered.add("thoughts");
  if(domains.has("clusters")||domains.has("insights"))rendered.add("review");
  if(rendered.size)publishDomains(rendered);
  if(!consumer.isCurrent())return false;
  await restorePendingProjections(consumer);
  return consumer.isCurrent()?changes.length:false
}
async function updateSyncHealth(event){
  const consumer=captureDataScope();
  if(!consumer.owner||event.owner&&event.owner!==consumer.owner
    ||event.workspace!=null&&event.workspace!==consumer.workspace
    ||event.scope!=null&&event.scope!==syncScope())return;
  if(event.type==="operation")getActionsCoordinator().applyOperationStatus(event);
  const metrics=await requestCoordinator.metrics(consumer.owner);
  if(!consumer.isCurrent())return;
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
const legacySyncController=createIncrementalSync({
  coordinator:requestCoordinator,
  request:(url,options)=>requestV1(url,options),
  getScope:syncScope,
  getWorkspace:syncWorkspace,
  getSignal:()=>sessionScope.capture().signal,
  applySnapshot:applyIncrementalSnapshot,
  resnapshot:async consumer=>{
    if(!consumer.isCurrent())return false;
    const domains=["checkins","dailyRecords","captures","journals","chat","review","books","keepsakes","quotes","notifications","onboardingV2","feedback"];
    if(!runtime.featureFlags?.recordSyncV2)domains.splice(4,0,"thoughts");
    const applied=await refreshState(domains,{isCurrent:consumer.isCurrent});
    if(!consumer.isCurrent())return false;
    if(applied===false)throw new Error("同步重读尚未应用");
    const actionsApplied=await getActionsCoordinator().load({isCurrent:consumer.isCurrent});
    if(actionsApplied===false&&consumer.isCurrent())throw new Error("行动同步重读尚未应用");
    return consumer.isCurrent()
  },
  onStatus:event=>void updateSyncHealth(event)
});
function activeRecordScopes(){
  const route=runtime.pageRouter?.currentRoute()||{view:"today",query:{}};
  if(route.view==="thoughts"&&route.kind==="detail"&&route.resourceId){
    const scopeKey=`thoughtDetail:${route.resourceId}`;
    return{activeScopeKey:scopeKey,scopes:[{scopeKey,kind:"thoughtDetail",id:route.resourceId}]}
  }
  const scopeKey=route.view==="thoughts"?"thoughtPage:active":"thoughtPage:home";
  return{activeScopeKey:scopeKey,scopes:[{
    scopeKey,kind:"thoughtPage",query:route.query?.q||"",tag:route.query?.tag||"",
    sort:route.query?.sort==="created"?"created":"occurred",
    cursor:route.view==="thoughts"?(route.query?.cursor||""):"",
    direction:route.view==="thoughts"?(route.query?.direction||"next"):"next"
  }]}
}
const recordEntityKey=key=>JSON.stringify([key.entityType,key.parentType,key.parentId,key.entityId]);
function hydrateRecordScopes(cursor,consumer){
  if(!consumer.isCurrent())return false;
  const request=activeRecordScopes(),scope=request.scopes[0];
  if(!scope)return false;
  const detail=scope.kind==="thoughtDetail";
  if(detail&&state.thoughtPage?.kind!=="detail")return false;
  if(!detail&&state.thoughtPage?.kind!=="list")return false;
  const rootId=detail?scope.id:"";
  const values=(state.thoughts||[]).filter(item=>!item?._sync&&(detail
    ?item.id===rootId||item.relatedTo===rootId
    :item.type==="question"));
  const entities=values.map(item=>{
    const block=detail&&item.id!==rootId,key={
      entityType:block?"thoughtBlock":"thoughtChain",
      entityId:item.id,
      parentType:block?"thoughtChain":null,
      parentId:block?rootId:null
    };
    return{key,version:Math.max(1,Number(item.version)||1),deliveryCursor:cursor,
      projection:structuredClone(item),tombstone:false}
  });
  rebaseRecordScopes({
    highWaterCursor:cursor,
    activeScopeKey:request.activeScopeKey,
    scopes:[{
      scopeKey:scope.scopeKey,descriptorVersion:1,kind:scope.kind,entities,
      orderedEntityKeys:entities.map(entity=>recordEntityKey(entity.key)),
      metadata:{...(state.thoughtPage||{})}
    }]
  },recordSyncContext(consumer));
  return consumer.isCurrent()
}
const recordSyncContext=consumer=>({
  accountId:consumer.owner,
  workspace:consumer.workspace,
  generation:consumer.generation
});
const recordSyncController=createRecordSyncLoop({
  request:(url,options)=>requestV1(url,options),
  getScope:syncScope,
  getWorkspace:syncWorkspace,
  getSignal:()=>sessionScope.capture().signal,
  getScopes:activeRecordScopes,
  hydrateScopes:hydrateRecordScopes,
  applyBatch:async(batch,consumer)=>{
    if(!consumer.isCurrent())return{committed:false,staleScopeKeys:[]};
    const result=applyRecordBatch(batch,recordSyncContext(consumer));
    if(!consumer.isCurrent())return{committed:false,staleScopeKeys:[]};
    if(Array.isArray(batch.changes)&&batch.changes.length)publishDomains(new Set(["thoughts"]));
    await restorePendingProjections(consumer);
    return result
  },
  rebaseScopes:async(payload,consumer)=>{
    if(!consumer.isCurrent())return false;
    const result=rebaseRecordScopes(payload,recordSyncContext(consumer));
    if(!consumer.isCurrent())return false;
    publishDomains(new Set(["thoughts"]));
    await restorePendingProjections(consumer);
    return result
  },
  onStatus:event=>void updateSyncHealth(event)
});
runtime.syncController={
  async start(owner,options={}){
    const [legacy,records]=await Promise.all([
      legacySyncController.start(owner,options),
      recordSyncController.start(owner,{recordSync:runtime.featureFlags?.recordSyncV2===true})
    ]);
    return Boolean(legacy||records)
  },
  stop(){legacySyncController.stop();recordSyncController.stop()},
  async pull(){return Promise.all([legacySyncController.pull(),recordSyncController.pull()])},
  async drain(options){return legacySyncController.drain(options)},
  rebaseRecords(){return recordSyncController.rebase()},
  cursor:()=>({v1:legacySyncController.cursor(),v2:recordSyncController.cursor()})
};
const {
  notificationUnread, renderNotificationSummary, publishNotificationState,
  scheduleNotificationPoll, readNotificationSnapshot, loadNotifications
}=createNotificationRuntime({
  runtime,
  getSnapshot:()=>state,
  getSessionSerial:()=>sessionSerial,
  request,
  syncResults:syncBackgroundTaskResults,
  setUnreadDot:unread=>{$("#notification-dot").hidden=!unread},
  retryLimit:backgroundResultsRetryLimit,
  isPendingTask:isPendingAiTaskStatus
});
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
const refreshState=async(domains,options={})=>{
  const requested=typeof domains==="string"?[domains]:Array.from(domains||[]);
  if(!requested.includes("notifications"))return refreshCoordinator.refresh(domains,{...options,patchOnly:options.patchOnly===true});
  const others=requested.filter(domain=>domain!=="notifications");
  if(others.length&&(await refreshCoordinator.refresh(others,{...options,patchOnly:options.patchOnly===true}))===false)return false;
  // 通知任务有独立HTTP读取；当前路由快照成功不代表通知读取成功。
  // 结果接入由显式恢复或轮询完成，此处不重复同步同一结果。
  if(options.isCurrent&&!options.isCurrent())return false;
  return readNotificationSnapshot(false,{isCurrent:options.isCurrent})
};
const resolvePersonalizedTask=createPersonalizedTaskRuntime({
  runtime,
  request,
  getSessionSerial:()=>sessionSerial,
  getTasks:()=>state.aiTasks,
  setTasks:tasks=>{state.aiTasks=tasks},
  publish:publishDomains,
  scheduleNotificationPoll
});
return Object.freeze({
  requestCoordinator,
  refreshCoordinator,
  setAnswerStatus,
  request,
  resolvePersonalizedTask,
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
