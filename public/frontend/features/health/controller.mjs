import { changeWeightBatchDate, createHealthDraftLifecycle, HEALTH_DAILY_TYPES } from "./drafts.mjs";
import { createHealthView } from "./view.mjs";

const noop=()=>{};
const emptyDelegate=Object.freeze({mount:()=>noop,render:()=>false,unmount:noop,resetSession:noop});
function requireFunction(value,name){if(typeof value!=="function")throw new TypeError(`Health feature requires ${name}`);return value}

export function createHealthFeatureController({
  delegate=emptyDelegate,
  request,
  requestV1,
  draftStore,
  listOperations,
  subscribeOperations,
  getAccountId,
  getActiveDate,
  getActiveType,
  setActiveType,
  getRecords,
  replaceRecord,
  applyPendingRecord,
  refreshRecords,
  resetOccurrenceInput,
  occurrenceFields,
  imageDataUrls,
  escapeMarkup,
  viewerAttachmentPath,
  localDateTimeForDate,
  toLocalDateTimeInput,
  showToast = noop,
  confirmDelete = message => globalThis.confirm(message),
  typeMeta,
  createId = () => crypto.randomUUID(),
  createFile,
  readFormData,
  objectUrls = globalThis.URL
} = {}) {
  for(const method of["mount","render","unmount","resetSession"])requireFunction(delegate?.[method],`delegate.${method}`);
  for(const[name,value]of Object.entries({request,requestV1,listOperations,subscribeOperations,getAccountId,getActiveDate,getActiveType,setActiveType,getRecords,replaceRecord,applyPendingRecord,refreshRecords,resetOccurrenceInput,occurrenceFields,imageDataUrls,escapeMarkup,viewerAttachmentPath,localDateTimeForDate,toLocalDateTimeInput,showToast,confirmDelete,createId}))requireFunction(value,name);
  if(!typeMeta||HEALTH_DAILY_TYPES.some(type=>!typeMeta[type]))throw new TypeError("Health feature requires typeMeta");

  let activation=null,surface=null,mountGeneration=0;
  let session={};
  let revision=0;
  let latestRequest=0;

  const root=()=>activation?.root||surface;
  const bump=()=>++revision;
  const ticket=(type=getActiveType(),date=getActiveDate())=>({session,owner:String(getAccountId()||""),revision,type,date,mount:activation?.generation||0});
  const sameSession=value=>Boolean(value&&value.session===session&&value.owner===String(getAccountId()||""));
  const active=value=>Boolean(sameSession(value)&&activation&&value.mount===activation.generation);
  const current=value=>Boolean(sameSession(value)&&value.revision===revision&&value.type===getActiveType()&&value.date===getActiveDate());

  async function discardUploadedItem(item,fallbackRequestId=""){
    const attachmentPath=item?.uploadedPath,uploadRequestId=item?.uploadRequestId||fallbackRequestId;
    if(!attachmentPath||!uploadRequestId)return false;
    try {
      const result=await request("/api/images/discard",{method:"POST",body:JSON.stringify({attachmentPaths:[attachmentPath],uploadRequestId})});
      return result.discarded?.includes(attachmentPath);
    }catch{return false}
  }

  const lifecycle = createHealthDraftLifecycle({
    store: draftStore,
    listOperations,
    discardItem: discardUploadedItem,
    createId,
    ...(createFile ? { createFile } : {})
  });
  const view = createHealthView({
    getRoot: root,
    getActiveDate,
    getActiveType,
    lifecycle,
    typeMeta,
    resetOccurrenceInput,
    escapeMarkup,
    localDateTimeForDate,
    toLocalDateTimeInput,
    touch: () => {
      latestRequest = 0;
      return bump();
    },
    getLatestRequest: () => latestRequest,
    objectUrls
  });
  let recordsWorkflow=null,interactionsWorkflow=null,recordsWorkflowRequest=null;
  async function ensureRecords(){
    if(recordsWorkflow)return recordsWorkflow;
    const scope=ticket();
    const pending=recordsWorkflowRequest||import("./records.mjs").then(module=>{
      const records=module.createHealthRecordsView({
        view,
        getRecords,
        getActiveType,
        switchType,
        resetOccurrenceInput,
        viewerAttachmentPath,
        escapeMarkup,
        typeMeta
      });
      const interactions=module.createHealthInteractions({
        lifecycle,
        view,
        records,
        getActiveType,
        getLatestRequest:()=>latestRequest,
        bump,
        switchType,
        changeWeightBatchDate,
        mediaOperation,
        submissionOperation
      });
      return{records,interactions}
    });
    recordsWorkflowRequest=pending;
    try{
      const workflow=await pending;
      if(!active(scope))throw new DOMException("Feature activation changed","AbortError");
      recordsWorkflow=workflow.records;
      interactionsWorkflow=workflow.interactions;
      return recordsWorkflow
    }catch(error){
      if(recordsWorkflowRequest===pending)recordsWorkflowRequest=null;
      throw error
    }
  }

  function presentRestoredDrafts() {
    for (const type of HEALTH_DAILY_TYPES) {
      if(type==="weight")continue;
      const draft = lifecycle.draft(type), target = view.form(type);
      if (draft.submissionOperationId && target) {
        target.dataset.requestId = draft.submissionOperationId;
        target.querySelector('[type="submit"]').disabled = true;
      }
      if(draft.result)view.applyRecognitionResult(type,draft.result)
    }
  }

  let mediaWorkflow=null,mediaWorkflowRequest=null;
  function mediaOperation(method,...args){
    const scope=ticket();
    if(mediaWorkflow)return mediaWorkflow[method](...args);
    const pending=mediaWorkflowRequest||import("./recognition.mjs").then(module=>module.createHealthRecognition({
        request,
        imageDataUrls,
        createId,
        lifecycle,
        view,
        getActiveDate,
        getActiveType,
        beginRequest:(type,date)=>{const serial=bump();latestRequest=serial;return ticket(type,date)},
        bump,
        ticket,
        sameSession,
        active,
        current,
        discardUploadedItem,
        getLatestRequest:()=>latestRequest,
        clearLatestRequest:serial=>{if(latestRequest===serial)latestRequest=0},
        showToast
      }));
    mediaWorkflowRequest=pending;
    return pending.then(workflow=>{if(!active(scope))return false;mediaWorkflow=workflow;return workflow[method](...args)}).catch(error=>{if(mediaWorkflowRequest===pending)mediaWorkflowRequest=null;if(view.status())view.status().textContent=error.message;return false})
  }

  async function restore() {
    const operation=ticket();
    await lifecycle.restore(operation.owner, getActiveDate());
    if (!sameSession(operation)) return false;
    if(!active(operation))return true;
    presentRestoredDrafts();
    view.renderUploader();
    view.applyActiveWeightItem();
    const message = view.draftStatus();
    if(message&&view.status())view.status().textContent=message;
    return true;
  }

  async function changeDate(date) {
    view.captureActiveWeightItem();
    bump();
    view.revokePreviews();
    const operation=ticket();
    await lifecycle.changeDate(date);
    if (!sameSession(operation)) return false;
    if(!active(operation))return true;
    presentRestoredDrafts();
    view.renderUploader();
    view.applyActiveWeightItem();
    const message = view.draftStatus();
    if(message&&view.status())view.status().textContent=message;
    return true;
  }

  function switchType(type) {
    if (!typeMeta[type]) return false;
    bump();
    latestRequest = 0;
    setActiveType(type);
    view.queryAll("[data-daily-tab]").forEach(button => {
      const selected = button.dataset.dailyTab === type;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
    });
    view.queryAll("[data-daily-form]").forEach(target => {
      const selected = target.dataset.dailyForm === type;
      target.hidden = !selected;
      target.classList.toggle("active", selected);
    });
    view.renderUploader();
    if (type === "weight") view.applyActiveWeightItem();
    view.status().textContent = view.draftStatus(type);
    recordsWorkflow?.render();
    return true;
  }

  let submissionRequest = null;
  async function submissionOperation(method, ...args) {
    const scope=ticket();
    try {
      const records=await ensureRecords();
      const pending = submissionRequest || import("./submission.mjs").then(module => module.createHealthSubmission({
        lifecycle,
        view,
        records,
        requestV1,
        getRecords,
        replaceRecord,
        applyPendingRecord,
        refreshRecords,
        occurrenceFields,
        getActiveDate,
        getActiveType,
        sameSession,
        active,
        isMounted:()=>Boolean(activation),
        current,
        bump,
        ticket,
        createId,
        showToast,
        typeMeta,
        confirmDelete,
        readFormData
      }));
      submissionRequest = pending;
      const workflow=await pending;
      if(["submit","removeRecord"].includes(method)?!active(scope):!sameSession(scope))throw new DOMException("Feature session changed","AbortError");
      return workflow[method](...args);
    } catch (error) {
      submissionRequest = null;
      throw error;
    }
  }

  const unmount = async () => {
    const currentActivation = activation;
    if (!currentActivation) return false;
    activation = null;
    currentActivation.unlink();
    view.revokePreviews();
    view.clearReasoning();
    await currentActivation.disposeDelegate();
    return true;
  };

  function invalidateSession() {
    session = {};
    bump();
    latestRequest = 0;
    for(const type of HEALTH_DAILY_TYPES)view.resetForm(type);
    lifecycle.resetSession();
    view.clearSurface();
  }

  return Object.freeze({
    async mount(context = {}) {
      await unmount();
      if (!context.root || typeof context.root !== "object") {
        throw new TypeError("Health feature requires a root");
      }
      if (context.signal?.aborted) {
        throw new DOMException("Feature activation changed", "AbortError");
      }
      surface=context.root;const candidate = {
        root: context.root,
        signal: context.signal,
        generation:++mountGeneration,
        unlink: noop,
        disposeDelegate: noop
      };
      const disposeDelegate = await delegate.mount(context);
      candidate.disposeDelegate = typeof disposeDelegate === "function"
        ? disposeDelegate
        : () => delegate.unmount();
      if (context.signal?.aborted) {
        await candidate.disposeDelegate();
        throw new DOMException("Feature activation changed", "AbortError");
      }
      activation = candidate;
      try {
        const records=await ensureRecords();
        const listeners=Object.entries(interactionsWorkflow.listeners);
        for(const[name,listener]of listeners)candidate.root.addEventListener?.(name,listener);
        const pasteSurface=candidate.root.ownerDocument||candidate.root;
        pasteSurface.addEventListener?.("paste",interactionsWorkflow.paste);
        const abort=()=>{if(activation===candidate)void unmount()};
        if(candidate.signal)candidate.signal.addEventListener("abort",abort,{once:true});
        const unsubscribeOperations=subscribeOperations(record=>{
          if(activation!==candidate||record?.owner!==String(getAccountId()||"")
            ||!record?.domains?.includes("dailyRecords"))return;
          if(record.status==="committed")void submissionOperation("finalizeOperation",record.operationId).catch(()=>{});
          else if(["failed","conflict"].includes(record.status))void submissionOperation("releaseOperation",record.operationId).catch(()=>{})
        });
        candidate.unlink=()=>{
          for(const[name,listener]of listeners)candidate.root.removeEventListener?.(name,listener);
          pasteSurface.removeEventListener?.("paste",interactionsWorkflow.paste);
          candidate.signal?.removeEventListener("abort",abort);
          unsubscribeOperations()
        };
        await restore();
        records.render();
      } catch (error) {
        await unmount();
        throw error;
      }
      return () => activation === candidate ? unmount() : false;
    },
    async render(context={}){
      if(!activation)return false;
      const delegated=delegate.render(context),owner=String(getAccountId()||"");
      if(owner&&lifecycle.owner()!==owner)await restore();
      const records=await ensureRecords();
      const recordsRendered=records.render();
      const uploaderRendered=view.renderUploader();
      return recordsRendered||uploaderRendered||delegated||false;
    },
    unmount,
    async resetSession() {
      invalidateSession();
      const failures = [];
      try {
        await unmount();
      } catch (error) {
        failures.push(error);
      }
      try {
        await delegate.resetSession();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, "Health feature session reset failed");
      }
    },
    invalidateSession,
    changeDate,
    switchType,
    form: view.form,
    resetForm: view.resetForm,
    renderUploader: view.renderUploader
  });
}

export * from "./drafts.mjs";
