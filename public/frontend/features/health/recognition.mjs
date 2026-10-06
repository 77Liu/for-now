import {
  uploadOriginalImages,
  uploadPendingMediaItems,
  validatedImageFiles
} from "../../media/index.mjs";
import {
  applyWeightBatchRecognition,
  createWeightBatchItems,
  WEIGHT_BATCH_MAX_ITEMS
} from "./drafts.mjs";

export function createHealthRecognition({
  request,
  imageDataUrls,
  createId,
  lifecycle,
  view,
  getActiveDate,
  getActiveType,
  beginRequest,
  bump,
  ticket,
  sameSession,
  active,
  current,
  discardUploadedItem,
  getLatestRequest,
  clearLatestRequest,
  showToast
}) {
  async function setImages(files, source = "已选择", append = false) {
    const type = getActiveType();
    const status = view.status();
    const draft = lifecycle.draft(type);
    const max = type === "sleep" ? 2 : type === "weight" ? WEIGHT_BATCH_MAX_ITEMS : 1;
    if (getLatestRequest()) {
      status.textContent = "正在识别当前截图，请完成后再替换。";
      return false;
    }
    bump();
    const operation = ticket(type);
    try {
      const currentItems = type === "weight" || draft.date === getActiveDate()
        ? draft.items
        : [];
      const next = append
        ? [...currentItems.map(item => item.file), ...files]
        : [...files];
      const validated = validatedImageFiles(next, max);
      const retained = new Set(validated);
      const removed = currentItems.filter(item => !retained.has(item.file));
      const created = type === "weight"
        ? createWeightBatchItems(
          validated.filter(file => !currentItems.some(item => item.file === file)),
          { assignedDate: getActiveDate(), createId }
        )
        : [];
      draft.date = getActiveDate();
      draft.result = null;
      draft.submissionOperationId = "";
      draft.items = validated.map(file => (
        currentItems.find(item => item.file === file)
        || (type === "weight" ? created.shift() : { file })
      ));
      draft.activeIndex = Math.min(
        draft.activeIndex || 0,
        Math.max(0, draft.items.length - 1)
      );
      if (type === "weight") view.applyActiveWeightItem();
      view.renderUploader();
      await Promise.all([
        lifecycle.persist(type),
        ...removed.map(item => discardUploadedItem(item))
      ]);
      if (!active(operation)) return false;
      status.textContent = type === "weight"
        ? `${source}${append ? "已追加" : ""} · ${draft.items.length} 张图片已进入批次，请先确认每张对应日期。`
        : `${source}${append ? "已追加" : ""} · ${draft.items.length} 张图片已就绪，识别后仍可修改。`;
      return true;
    } catch (error) {
      status.textContent = error.message;
      return false;
    }
  }

  async function removeImage(index) {
    if (getLatestRequest()) return false;
    bump();
    const type = getActiveType();
    const operation = ticket(type);
    if (type === "weight") {
      view.captureActiveWeightItem();
      await lifecycle.removeWeightItem(index);
      if (!active(operation)) return false;
      view.renderUploader();
      if (lifecycle.draft("weight").items.length) view.applyActiveWeightItem();
      else view.resetForm("weight");
      view.status().textContent = lifecycle.files("weight").length
        ? `批次剩余 ${lifecycle.files("weight").length} 张截图。`
        : "体重批次已清空。";
      return true;
    }
    const draft = lifecycle.draft(type);
    const [item] = draft.items.splice(index, 1);
    draft.result = null;
    view.renderUploader();
    await Promise.all([
      lifecycle.persist(type),
      discardUploadedItem(item)
    ]);
    if (!active(operation)) return false;
    view.status().textContent = draft.items.length
      ? `已保留 ${draft.items.length} 张图片。`
      : "请重新选择或粘贴截图。";
    return true;
  }

  async function uploadItems(type, items, operation) {
    const existingPaths=new Set(items.map(item=>item.uploadedPath).filter(Boolean));
    let latestItems=items;
    try {
      return await uploadPendingMediaItems({
        items,
        createId,
        upload: async (file, idempotencyKey) => {
          const [image] = await imageDataUrls([file]);
          return (await uploadOriginalImages({
            request,
            images: [image],
            idempotencyKey
          }))[0];
        },
        onProgress: async nextItems => {
          latestItems=nextItems;
          if(!active(operation))return;
          const draft = lifecycle.draft(type);
          if (type === "weight") {
            const itemId = items[0]?.itemId;
            const index = draft.items.findIndex(item => item.itemId === itemId);
            if (index >= 0) draft.items[index] = { ...draft.items[index], ...nextItems[0] };
          } else {
            draft.items = nextItems;
          }
          await lifecycle.persist(type);
        }
      });
    } finally {
      if(!active(operation)&&sameSession(operation)){
        const stale=latestItems.filter(item=>item.uploadedPath&&!existingPaths.has(item.uploadedPath));
        await Promise.all(stale.map(item=>discardUploadedItem(item)));
        const paths=new Set(stale.map(item=>item.uploadedPath)),requests=new Set(stale.map(item=>item.uploadRequestId).filter(Boolean)),draft=lifecycle.draft(type);
        let changed=false;
        for(const item of draft.items)if(paths.has(item.uploadedPath)||requests.has(item.uploadRequestId)){item.uploadedPath="";item.uploadRequestId="";changed=true}
        if(changed)await lifecycle.persist(type)
      }
    }
  }

  async function recognizeWeightBatch(operation, status, forceActive = false) {
    const draft = lifecycle.draft("weight");
    let completed = 0;
    let failed = 0;
    for (let index = 0; index < draft.items.length; index += 1) {
      let item = draft.items[index];
      if ((item.recognition && !(forceActive && index === draft.activeIndex))
        || item.submissionOperationId) continue;
      if (!current(operation)) return;
      item.status = "uploading";
      item.recognitionError = null;
      view.renderUploader();
      await lifecycle.persist("weight");
      try {
        const uploaded = await uploadItems("weight", [item], operation);
        if (!sameSession(operation)) return;
        const indexNow = draft.items.findIndex(value => value.itemId === item.itemId);
        if (indexNow < 0) throw new Error("这张截图已从批次移除");
        draft.items[indexNow] = { ...draft.items[indexNow], ...uploaded.items[0] };
        item = draft.items[indexNow];
        const inputVersion = item.revision;
        const requestId = forceActive && indexNow === draft.activeIndex
          ? createId()
          : item.recognitionRequestId || createId();
        const targetId = `daily:weight:${item.itemId}:${item.assignedDate}`;
        item.recognitionRequestId = requestId;
        item.status = "recognizing";
        view.renderUploader();
        await lifecycle.persist("weight");
        const result = await request("/api/images/parse", {
          method: "POST",
          body: JSON.stringify({
            requestId,
            targetId,
            inputVersion,
            kind: "weight",
            referenceDate: item.assignedDate,
            attachmentPaths: [item.uploadedPath]
          })
        });
        const currentItem = draft.items.find(value => value.itemId === item.itemId);
        const responseMatches = active(operation)
          && current(operation)
          && currentItem
          && (!result.requestId || result.requestId === requestId)
          && (!result.targetId || result.targetId === targetId)
          && (!Object.hasOwn(result, "inputVersion")
            || Number(result.inputVersion) === inputVersion);
        if (!responseMatches) {
          if (active(operation)) {
            status.textContent = "识别已完成，但当前表单已经变化或截图日期已调整，未自动回填。";
          }
          return;
        }
        Object.assign(
          currentItem,
          applyWeightBatchRecognition(currentItem, {
            ...result,
            attachmentPaths: [currentItem.uploadedPath]
          }, {
            requestId,
            expectedRevision: inputVersion
          }).item
        );
        completed += 1;
      } catch (error) {
        if (!active(operation)) return;
        const currentItem = draft.items.find(value => value.itemId === item.itemId);
        if (!currentItem) continue;
        currentItem.status = "failed";
        currentItem.recognitionError = { message: error.message || "识别失败" };
        failed += 1;
      }
      if (!sameSession(operation)) return;
      await lifecycle.persist("weight");
      if(active(operation))view.renderUploader();
    }
    const firstReview = draft.items.findIndex(
      item => item.recognition && !item.submissionOperationId
    );
    if (firstReview >= 0) draft.activeIndex = firstReview;
    await lifecycle.persist("weight");
    if (!active(operation)) return;
    view.renderUploader();
    view.applyActiveWeightItem();
    status.textContent = failed
      ? `${completed} 张已识别，${failed} 张失败；修正后可直接重试失败项。`
      : `${completed} 张已逐图识别，请逐项核对日期和指标后保存。`;
  }

  async function parseImages() {
    const type = getActiveType();
    const date = getActiveDate();
    const files = lifecycle.files(type);
    const status = view.status();
    if (!files.length) {
      status.textContent = "请先选择、粘贴或拖入截图。";
      return false;
    }
    const operation = beginRequest(type, date);
    view.query("#parse-health-images").disabled = true;
    view.query("#health-images").disabled = true;
    view.queryAll("[data-active-date]").forEach(control => {
      control.disabled = true;
    });
    status.textContent = "正在安全上传原图…";
    try {
      if (type === "weight") {
        const forceActive = lifecycle.draft("weight").items.every(
          item => item.recognition || item.submissionOperationId
        );
        await recognizeWeightBatch(operation, status, forceActive);
        return true;
      }
      const draft = lifecycle.draft(type);
      if (draft.date !== date) throw new Error("截图所属日期已变化，请重新选择");
      const uploaded = await uploadItems(type, draft.items, operation);
      if (!active(operation)) return false;
      draft.items = uploaded.items;
      await lifecycle.persist(type);
      if (!active(operation) || !current(operation)) return false;
      status.textContent = "正在识别并核对字段…";
      const requestId = createId();
      const targetId = `daily:${type}:${date}`;
      const result = await request("/api/images/parse", {
        method: "POST",
        body: JSON.stringify({
          requestId,
          targetId,
          inputVersion: operation.revision,
          kind: type,
          referenceDate: date,
          attachmentPaths: uploaded.attachmentPaths
        })
      });
      const responseMatches = active(operation)
        && current(operation)
        && (!result.requestId || result.requestId === requestId)
        && (!result.targetId || result.targetId === targetId)
        && (!Object.hasOwn(result, "inputVersion")
          || Number(result.inputVersion) === operation.revision);
      if (!responseMatches) {
        if (getLatestRequest() === operation.revision && active(operation)) {
          status.textContent = "识别已完成，但当前表单已经变化，未自动回填。";
        }
        return false;
      }
      draft.result = result;
      await lifecycle.persist(type);
      view.applyRecognitionResult(type, result);
      status.textContent = result.verification
        || "识别完成。请核对后保存，空白字段可以手动补充。";
      showToast("截图已识别并回填");
      return true;
    } catch (error) {
      if(active(operation)&&current(operation))status.textContent=error.message;
      return false;
    } finally {
      clearLatestRequest(operation.revision);
      if(sameSession(operation)&&!getLatestRequest()){
        const imageInput=view.query("#health-images");if(imageInput)imageInput.disabled=false;
        view.queryAll("[data-active-date]").forEach(control=>{control.disabled=false});
        if(active(operation)&&type===getActiveType())view.renderUploader()
      }
    }
  }

  return Object.freeze({ setImages, removeImage, parseImages });
}
