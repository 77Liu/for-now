import { changeWeightBatchDate, createHealthDraftLifecycle, HEALTH_DAILY_TYPES } from "./drafts.mjs";
import { createHealthView } from "./view.mjs";

const noop=()=>{};
function requireFunction(value,name){if(typeof value!=="function")throw new TypeError(`Health feature requires ${name}`);return value}

export function createHealthFeatureController({
  delegate,
  request,
  draftStore,
  listOperations,
  getAccountId,
  getActiveDate,
  getActiveType,
  setActiveType,
  renderRecords,
  resetOccurrenceInput,
  imageDataUrls,
  escapeMarkup,
  localDateTimeForDate,
  toLocalDateTimeInput,
  showToast = noop,
  typeMeta,
  createId = () => crypto.randomUUID(),
  createFile,
  objectUrls = globalThis.URL
} = {}) {
  for(const method of["mount","render","unmount","resetSession"])requireFunction(delegate?.[method],`delegate.${method}`);
  for(const[name,value]of Object.entries({request,listOperations,getAccountId,getActiveDate,getActiveType,setActiveType,renderRecords,resetOccurrenceInput,imageDataUrls,escapeMarkup,localDateTimeForDate,toLocalDateTimeInput,showToast,createId}))requireFunction(value,name);
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
    renderRecords();
    return true;
  }

  let submissionRequest = null;
  async function submissionOperation(method, ...args) {
    const scope=ticket();
    try {
      const pending = submissionRequest || import("./submission.mjs").then(module => module.createHealthSubmission({
        lifecycle,
        view,
        getActiveDate,
        getActiveType,
        sameSession,
        active,
        isMounted:()=>Boolean(activation),
        current,
        bump,
        ticket,
        createId
      }));
      submissionRequest = pending;
      const workflow=await pending;if(method==="prepare"?!active(scope):!sameSession(scope))throw new DOMException("Feature session changed","AbortError");return workflow[method](...args);
    } catch (error) {
      submissionRequest = null;
      throw error;
    }
  }

  function handleClick(event) {
    const tab = event.target.closest?.("[data-daily-tab]");
    if (tab) return switchType(tab.dataset.dailyTab);
    const select = event.target.closest?.("[data-weight-batch-select]");
    if (select) {
      if (latestRequest) return false;
      view.captureActiveWeightItem();
      lifecycle.draft("weight").activeIndex = Number(select.dataset.weightBatchSelect) || 0;
      void lifecycle.persist("weight");
      view.renderUploader();
      return view.applyActiveWeightItem();
    }
    const remove = event.target.closest?.("[data-health-image-remove]");
    if (remove) {
      void mediaOperation("removeImage",Number(remove.dataset.healthImageRemove));
      return true;
    }
    if (event.target.closest?.("#parse-health-images")) {
      void mediaOperation("parseImages");
      return true;
    }
    const cancel = event.target.closest?.("[data-daily-cancel]");
    if (!cancel) return false;
    const type = cancel.closest("[data-daily-form]")?.dataset.dailyForm;
    view.resetForm(type);
    if (type === "weight") view.applyActiveWeightItem();
    return true;
  }

  function handleChange(event) {
    const imageInput = event.target.closest?.("#health-images");
    if (imageInput) {
      void mediaOperation("setImages",imageInput.files,"本地文件").then(ok => {
        if (!ok) imageInput.value = "";
      });
      return;
    }
    const dateInput = event.target.closest?.("[data-weight-batch-date]");
    if (dateInput) {
      const draft = lifecycle.draft("weight");
      const index = Number(dateInput.dataset.weightBatchDate);
      const item = draft.items[index];
      if (!item) return;
      view.captureActiveWeightItem();
      try {
        draft.items[index] = changeWeightBatchDate(item, dateInput.value);
        bump();
        if (index === draft.activeIndex) view.applyActiveWeightItem();
        view.renderUploader();
        void lifecycle.persist("weight");
      } catch (error) {
        view.status().textContent = error.message;
      }
      return;
    }
    handleFormChange(event);
  }

  function handleFormChange(event) {
    const target = event.target.closest?.("[data-daily-form]");
    if (!target) return;
    bump();
    if (target.dataset.dailyForm === "weight") {
      view.captureActiveWeightItem();
      void lifecycle.persist("weight");
      view.renderUploader();
    } else {
      view.query("#parse-health-images").disabled = !lifecycle.files(getActiveType()).length;
    }
  }

  function handleKeydown(event) {
    if (!event.target.closest?.("#health-upload-box")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    view.query("#health-images")?.click();
  }

  function handleDrag(event) {
    const box = event.target.closest?.("#health-upload-box");
    if (!box) return;
    if (event.type === "dragenter" || event.type === "dragover") {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      box.classList.add("dragging");
      return;
    }
    if (event.type === "dragleave") {
      if (!box.contains(event.relatedTarget)) box.classList.remove("dragging");
      return;
    }
    event.preventDefault();
    box.classList.remove("dragging");
    const files = [...(event.dataTransfer?.files || [])].filter(
      item => item.type.startsWith("image/")
    );
    void mediaOperation("setImages",files,"拖入图片",["sleep","weight"].includes(getActiveType()));
  }

  function handlePaste(event) {
    if (event.target.closest?.("input,textarea,[contenteditable=true]")) return;
    const files = [...(event.clipboardData?.files || [])].filter(
      item => item.type.startsWith("image/")
    );
    if (!files.length) return;
    event.preventDefault();
    void mediaOperation("setImages",files,"剪贴板",["sleep","weight"].includes(getActiveType()));
  }

  const unmount = async () => {
    const currentActivation = activation;
    if (!currentActivation) return false;
    activation = null;
    currentActivation.unlink();
    view.revokePreviews();
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
      const listeners = [
        ["click", handleClick],
        ["change", handleChange],
        ["input", handleFormChange],
        ["keydown", handleKeydown],
        ["dragenter", handleDrag],
        ["dragover", handleDrag],
        ["dragleave", handleDrag],
        ["drop", handleDrag]
      ];
      for(const[name,listener]of listeners)candidate.root.addEventListener?.(name,listener);
      const pasteSurface=candidate.root.ownerDocument||candidate.root;
      pasteSurface.addEventListener?.("paste",handlePaste);
      const abort = () => {
        if (activation === candidate) void unmount();
      };
      if (candidate.signal) candidate.signal.addEventListener("abort", abort, { once: true });
      candidate.unlink = () => {
        for(const[name,listener]of listeners)candidate.root.removeEventListener?.(name,listener);
        pasteSurface.removeEventListener?.("paste",handlePaste);
        candidate.signal?.removeEventListener("abort", abort);
      };
      activation = candidate;
      try {
        await restore();
      } catch (error) {
        await unmount();
        throw error;
      }
      return () => activation === candidate ? unmount() : false;
    },
    async render(context={}){
      const delegated=delegate.render(context),owner=String(getAccountId()||"");
      if(owner&&lifecycle.owner()!==owner)await restore();
      return view.renderUploader()||delegated||false;
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
    renderUploader: view.renderUploader,
    prepareSubmission:(...args)=>submissionOperation("prepare",...args),
    markQueued:(...args)=>submissionOperation("markQueued",...args),
    completeSubmission:(...args)=>submissionOperation("complete",...args),
    failSubmission:(...args)=>submissionOperation("fail",...args),
    submissionDisabled(type) {
      const draft = lifecycle.draft(type);
      const item = type === "weight" ? draft.items[draft.activeIndex] : null;
      return type === "weight"
        ? Boolean(item && (!item.recognition || item.submissionOperationId))
        : Boolean(draft.submissionOperationId);
    },
    weightBatchCount: () => lifecycle.draft("weight").items.length,
    finalizeOperation:(...args)=>submissionOperation("finalizeOperation",...args),
    releaseOperation:(...args)=>submissionOperation("releaseOperation",...args)
  });
}

export * from "./drafts.mjs";
