import crypto from "node:crypto";
import { WAITING_FOR_USER_MODEL_STATUS } from "../../shared/core-model-gate.mjs";
import { recordVersion, safeText } from "../../shared/validation/index.mjs";
import {
  CONTENT_ATTACHMENT_MAX_IMAGES,
  contentOriginalPayload,
  imageUnderstandingResult,
  normalizeContentAttachmentTarget,
  normalizeOriginalImagePaths
} from "./schema.mjs";

export const CONTENT_ATTACHMENT_TRASH_TYPE = "contentAttachment";

const AFTER_COMMIT = Symbol.for("for-now.after-commit");
const ATTACHMENT_PATH = /^\/attachments\/[\w.-]+$/;
const ANNOTATION_HOST_COLLECTIONS = [
  "thoughts",
  "captures",
  "journals",
  "chats",
  "analyses",
  "books",
  "quotes"
];
const COLLECTION_RESOURCE_TYPES = {
  thoughts: "thought",
  captures: "capture",
  journals: "journal",
  chats: "chat",
  analyses: "analysis",
  books: "book",
  quotes: "quote"
};

const cloned = value => structuredClone(value);
const pathsOf = resource => [...new Set((Array.isArray(resource?.attachmentPaths) ? resource.attachmentPaths : [])
  .filter(path => typeof path === "string" && ATTACHMENT_PATH.test(path)))];
const understandingsOf = resource => Array.isArray(resource?.imageUnderstandings)
  ? resource.imageUnderstandings
  : [];
const originalTextOf = (targetType, resource) => targetType === "comment"
  ? String(resource?.text ?? "")
  : String(resource?.content ?? "");

function findComment(store, id, owner = null) {
  let found = null;
  for (const collection of ANNOTATION_HOST_COLLECTIONS) {
    if (owner && owner.collection !== collection) continue;
    for (const host of Array.isArray(store?.[collection]) ? store[collection] : []) {
      if (owner && owner.id !== host.id) continue;
      for (const field of ["annotations", "annotationDrift"]) {
        const resource = (Array.isArray(host?.[field]) ? host[field] : []).find(item => item?.id === id);
        if (!resource) continue;
        if (found) throw Object.assign(new Error("请指定批注所属的内容记录"), {
          code: "CONTENT_ATTACHMENT_OWNER_REQUIRED", statusCode: 409
        });
        found = { resource, parent: host, collection, field };
      }
    }
  }
  return found;
}

export function resolveContentAttachmentResource(store, targetType, targetId, owner = null) {
  if (targetType === "comment") return findComment(store, targetId, owner);
  if (targetType === "capture") {
    const resource = (Array.isArray(store?.captures) ? store.captures : []).find(item => item?.id === targetId);
    return resource ? { resource, parent: null, collection: "captures" } : null;
  }
  const thoughts = Array.isArray(store?.thoughts) ? store.thoughts : [];
  if (targetType === "thoughtRoot") {
    const resource = thoughts.find(item => item?.id === targetId && item.type === "question");
    return resource ? { resource, parent: null, collection: "thoughts" } : null;
  }
  if (targetType === "thoughtBlock") {
    const resource = thoughts.find(item => item?.id === targetId && item.type !== "question");
    if (!resource) return null;
    const parent = thoughts.find(item => item?.id === resource.relatedTo && item.type === "question") || null;
    return { resource, parent, collection: "thoughts" };
  }
  return null;
}

function timestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError("Content attachments now() must return a valid date");
  return parsed.toISOString();
}

function expectedVersionResult(resource, expectedVersion) {
  if (expectedVersion == null) return { currentVersion: recordVersion(resource.version) };
  const parsed = Number(expectedVersion);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { error: "资源版本无效", code: "INVALID_RESOURCE_VERSION" };
  }
  const currentVersion = recordVersion(resource.version);
  return parsed === currentVersion
    ? { currentVersion }
    : { versionConflict: true, currentVersion };
}

function touch(resource, changedAt) {
  resource.version = recordVersion(resource.version) + 1;
  resource.updatedAt = changedAt;
}

function touchLocated(located, changedAt) {
  touch(located.resource, changedAt);
  if (located.parent && located.parent !== located.resource) touch(located.parent, changedAt);
}

function project(located, targetType, targetId, inventoryByPath = new Map()) {
  const originalImages = pathsOf(located.resource).map(path => {
    const row = inventoryByPath.get(path);
    return {
      path,
      state: row && (!row.state || row.state === "verified") ? "verified" : "missing",
      ...(Number.isFinite(Number(row?.bytes)) ? { bytes: Number(row.bytes) } : {}),
      ...(typeof row?.sha256 === "string" && row.sha256 ? { sha256: row.sha256 } : {})
    };
  });
  return {
    targetType,
    targetId,
    version: recordVersion(located.resource.version),
    originalImages,
    imageUnderstandings: cloned(understandingsOf(located.resource))
  };
}

function taskTarget(located, targetType, targetId) {
  const resourceType = COLLECTION_RESOURCE_TYPES[located.collection] || "";
  if (targetType === "comment") {
    return {
      taskResourceType: resourceType,
      taskTargetId: located.parent?.id || "",
      taskSubtargetId: targetId
    };
  }
  return { taskResourceType: resourceType, taskTargetId: targetId, taskSubtargetId: "" };
}

export function createContentAttachmentService({
  repository,
  recordCommands = null,
  trash,
  attachmentInventory,
  getAccountId,
  requestImageUnderstanding = null,
  cancelTask = () => false,
  resolveResource = resolveContentAttachmentResource,
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID(),
  maxImages = CONTENT_ATTACHMENT_MAX_IMAGES
}) {
  if (!repository || typeof repository.read !== "function" || typeof repository.update !== "function") {
    throw new TypeError("Content attachments require a repository with read() and update()");
  }
  if (!trash || typeof trash.add !== "function" || typeof trash.get !== "function" || typeof trash.remove !== "function") {
    throw new TypeError("Content attachments require the trash service");
  }
  if (typeof attachmentInventory !== "function" || typeof getAccountId !== "function") {
    throw new TypeError("Content attachments require account-scoped inventory and identity");
  }
  if (!Number.isSafeInteger(maxImages) || maxImages < 1) throw new TypeError("maxImages must be a positive integer");

  const accountId = () => {
    const value = safeText(getAccountId(), 100);
    if (!value) throw Object.assign(new Error("Missing authenticated account"), {
      code: "AUTH_REQUIRED",
      statusCode: 401
    });
    return value;
  };

  async function inventoryIndex(paths) {
    accountId();
    if (!paths.length) return new Map();
    const rows = await attachmentInventory({ paths });
    return new Map((Array.isArray(rows) ? rows : [])
      .filter(row => typeof row?.path === "string" && ATTACHMENT_PATH.test(row.path))
      .map(row => [row.path, row]));
  }

  async function verifyOwned(paths) {
    const inventory = await inventoryIndex(paths);
    return verifyInventory(paths, inventory);
  }

  function verifyInventory(paths, inventory) {
    const unavailable = paths.find(path => {
      const row = inventory.get(path);
      return !row || (row.state && row.state !== "verified");
    });
    return unavailable
      ? { forbidden: true, error: "图片附件不属于当前账户或尚未完成保存", code: "ATTACHMENT_NOT_OWNED" }
      : { inventory };
  }

  async function prepareOriginalContent(targetType, input) {
    const parsed = contentOriginalPayload(targetType, input, { maxImages });
    if (parsed.error) return parsed;
    const owned = await verifyOwned(parsed.value.attachmentPaths);
    return owned.forbidden ? owned : { value: parsed.value };
  }

  function locate(store, targetType, targetId, owner = null) {
    return resolveResource(store, targetType, targetId, owner);
  }

  async function get(targetType, targetId, { owner = null } = {}) {
    const target = normalizeContentAttachmentTarget(targetType, targetId);
    if (target.error) return target;
    if (recordCommands) return recordCommands.run({
      commandId: "contentAttachment.get", targetType, targetId, owner, readOnly: true,
      mutate(store, inventory) {
        const located = locate(store, targetType, targetId, owner);
        return located ? { value: project(located, targetType, targetId, inventory) } : { missing: true };
      }
    });
    const store = await repository.read();
    const located = locate(store, targetType, targetId, owner);
    const inventory = await inventoryIndex(pathsOf(located?.resource));
    return located ? { value: project(located, targetType, targetId, inventory) } : { missing: true };
  }

  function moveRemovedToTrash(store, located, targetType, targetId, removedPaths, changedAt) {
    if (!removedPaths.length) return null;
    store.trash ||= [];
    const removed = new Set(removedPaths);
    const imageUnderstandings = understandingsOf(located.resource)
      .filter(item => (item.sourceAttachmentPaths || []).some(path => removed.has(path)));
    if (imageUnderstandings.length) {
      const movedIds = new Set(imageUnderstandings.map(item => item.id));
      located.resource.imageUnderstandings = understandingsOf(located.resource)
        .filter(item => !movedIds.has(item.id));
    }
    const payload = {
      id: createId(),
      targetType,
      targetId,
      attachmentPaths: [...removedPaths],
      imageUnderstandings: cloned(imageUnderstandings),
      removedAt: changedAt
    };
    return trash.add(store.trash, CONTENT_ATTACHMENT_TRASH_TYPE, payload, {
      kind: CONTENT_ATTACHMENT_TRASH_TYPE,
      targetType,
      targetId,
      parentId: targetId,
      ...(targetType === "comment" ? { owner: { collection: located.collection, id: located.parent.id } } : {})
    });
  }

  function cancelUnderstandingTasks(store, located, targetType, targetId, removedPaths, changedAt) {
    if (!removedPaths.length) return [];
    const removed = new Set(removedPaths), running = [];
    for (const task of store.aiTasks || []) {
      if (task.kind !== "contentImageUnderstanding"
        || task.payload?.targetType !== targetType
        || task.payload?.targetId !== targetId
        || (targetType === "comment" && (
          task.resourceType !== COLLECTION_RESOURCE_TYPES[located.collection]
          || task.targetId !== located.parent.id || task.subtargetId !== targetId
        ))
        || !["queued", "running", "cancelling", WAITING_FOR_USER_MODEL_STATUS].includes(task.status)
        || !(task.payload?.attachmentPaths || []).some(path => removed.has(path))) continue;
      const notStarted = ["queued", WAITING_FOR_USER_MODEL_STATUS].includes(task.status);
      Object.assign(task, {
        status: notStarted ? "cancelled" : "cancelling",
        updatedAt: changedAt,
        error: notStarted ? "原始图片已移除，任务未调用" : "原始图片已移除，正在停止理解"
      });
      if (notStarted) task.completedAt = changedAt;
      else {
        task.cancellationRequestedAt ||= changedAt;
        running.push(task.id);
      }
      const notification = (store.notifications || []).find(item => item.taskId === task.id);
      if (notification) Object.assign(notification, {
        status: task.status,
        message: task.error,
        updatedAt: changedAt,
        ...(notStarted ? { readAt: "" } : {})
      });
    }
    return running;
  }

  function afterCommit(result, taskIds) {
    if (taskIds.length) {
      Object.defineProperty(result, AFTER_COMMIT, {
        value: () => taskIds.forEach(cancelTask),
        configurable: true
      });
    }
    return result;
  }

  function reconcileOriginalImagesInStore(store, targetType, targetId, attachmentPaths, {
    expectedVersion = null,
    changedAt = timestamp(now()),
    touchResource = true,
    allowEmptyImages = false,
    owner = null,
    inventory = new Map()
  } = {}) {
    const target = normalizeContentAttachmentTarget(targetType, targetId);
    if (target.error) return target;
    const parsed = normalizeOriginalImagePaths(attachmentPaths, { maxImages });
    if (parsed.error) return parsed;
    const located = locate(store, targetType, targetId, owner);
    if (!located) return { missing: true };
    const version = expectedVersionResult(located.resource, expectedVersion);
    if (version.error || version.versionConflict) return version;
    if (!allowEmptyImages && !originalTextOf(targetType, located.resource).trim() && !parsed.value.length) {
      return { error: "仅图片记录至少需要保留一张原始图片", code: "CONTENT_OR_IMAGE_REQUIRED" };
    }
    const current = pathsOf(located.resource);
    if (current.length === parsed.value.length && current.every((path, index) => path === parsed.value[index])) {
      return { value: project(located, targetType, targetId, inventory), unchanged: true };
    }
    const next = new Set(parsed.value);
    const removedPaths = current.filter(path => !next.has(path));
    const trashEntry = moveRemovedToTrash(
      store,
      located,
      targetType,
      targetId,
      removedPaths,
      changedAt
    );
    const runningTaskIds = cancelUnderstandingTasks(store, located, targetType, targetId, removedPaths, changedAt);
    located.resource.attachmentPaths = [...parsed.value];
    if (touchResource) touchLocated(located, changedAt);
    return afterCommit({
      value: project(located, targetType, targetId, inventory),
      ...(trashEntry ? { trashId: trashEntry.id } : {})
    }, runningTaskIds);
  }

  async function replaceOriginalImages(targetType, targetId, attachmentPaths, { expectedVersion = null, owner = null } = {}) {
    const target = normalizeContentAttachmentTarget(targetType, targetId);
    if (target.error) return target;
    const parsed = normalizeOriginalImagePaths(attachmentPaths, { maxImages });
    if (parsed.error) return parsed;
    if (recordCommands) return recordCommands.run({
      commandId: "contentAttachment.replace", targetType, targetId, owner, paths: parsed.value,
      mutate(store, inventory) {
        const owned = verifyInventory(parsed.value, inventory);
        return owned.forbidden ? owned : reconcileOriginalImagesInStore(store, targetType, targetId,
          parsed.value, { expectedVersion, owner, inventory });
      }
    });
    const owned = await verifyOwned(parsed.value);
    if (owned.forbidden) return owned;
    const changedAt = timestamp(now());
    return repository.update(store => reconcileOriginalImagesInStore(
      store,
      targetType,
      targetId,
      parsed.value,
      { expectedVersion, owner, changedAt, inventory: owned.inventory }
    ));
  }

  async function removeOriginalImage(targetType, targetId, attachmentPath, options = {}) {
    const target = normalizeContentAttachmentTarget(targetType, targetId);
    if (target.error) return target;
    const parsed = normalizeOriginalImagePaths([attachmentPath], { maxImages, requireImages: true });
    if (parsed.error) return parsed;
    const remove = (store, inventory) => {
      const owned = verifyInventory(parsed.value, inventory);
      if (owned.forbidden) return owned;
      const located = locate(store, targetType, targetId, options.owner);
      if (!located) return { missing: true };
      const version = expectedVersionResult(located.resource, options.expectedVersion);
      if (version.error || version.versionConflict) return version;
      const current = pathsOf(located.resource);
      if (!current.includes(attachmentPath)) return { attachmentMissing: true };
      return reconcileOriginalImagesInStore(store, targetType, targetId,
        current.filter(path => path !== attachmentPath), { ...options, inventory });
    };
    if (recordCommands) return recordCommands.run({
      commandId: "contentAttachment.remove", targetType, targetId, owner: options.owner,
      paths: parsed.value, mutate: remove
    });
    const owned = await verifyOwned(parsed.value);
    if (owned.forbidden) return owned;
    return repository.update(store => remove(store, owned.inventory));
  }

  function recoveryPayload(entry) {
    const originals = normalizeOriginalImagePaths(entry?.payload?.attachmentPaths || [], {
      maxImages,
      requireImages: true
    });
    if (originals.error) return { invalid: true };
    const imageUnderstandings = Array.isArray(entry?.payload?.imageUnderstandings)
      ? entry.payload.imageUnderstandings
      : [];
    const sourcePaths = new Set(originals.value);
    for (const item of imageUnderstandings) {
      const sources = normalizeOriginalImagePaths(item?.sourceAttachmentPaths || [], {
        maxImages,
        requireImages: true
      });
      if (sources.error) return { invalid: true };
      sources.value.forEach(path => sourcePaths.add(path));
    }
    return {
      value: {
        attachmentPaths: originals.value,
        imageUnderstandings,
        sourcePaths: [...sourcePaths]
      }
    };
  }

  function restoreOriginalImagesInStore(document, normalizedTrashId, expectedVersion, inventory) {
    const changedAt = timestamp(now());
    const currentEntry = trash.get(document.trash || [], normalizedTrashId);
    if (!currentEntry || currentEntry.type !== CONTENT_ATTACHMENT_TRASH_TYPE) return { missing: true };
    const currentRecovery = recoveryPayload(currentEntry);
    if (currentRecovery.invalid) return currentRecovery;
    if (verifyInventory(currentRecovery.value.sourcePaths, inventory).forbidden) return { attachmentMissing: true };
    const { targetType, targetId, owner } = currentEntry.location || {};
    const located = locate(document, targetType, targetId, owner);
    if (!located) return { parentMissing: true };
    const version = expectedVersionResult(located.resource, expectedVersion);
    if (version.error || version.versionConflict) return version;
    const current = pathsOf(located.resource);
    if (currentRecovery.value.attachmentPaths.some(path => current.includes(path))) return { restoreConflict: true };
    const combined = normalizeOriginalImagePaths([
      ...current,
      ...currentRecovery.value.attachmentPaths
    ], { maxImages });
    if (combined.error) return combined;
    const combinedSet = new Set(combined.value);
    if (currentRecovery.value.imageUnderstandings.some(item => (
      item.sourceAttachmentPaths.some(path => !combinedSet.has(path))
    ))) return { restoreConflict: true };
    located.resource.attachmentPaths = combined.value;
    const existingIds = new Set(understandingsOf(located.resource).map(item => item.id));
    const restoredUnderstandings = currentRecovery.value.imageUnderstandings
      .filter(item => item?.id && !existingIds.has(item.id));
    if (restoredUnderstandings.length) {
      located.resource.imageUnderstandings = [
        ...understandingsOf(located.resource),
        ...cloned(restoredUnderstandings)
      ];
    }
    touchLocated(located, changedAt);
    trash.remove(document.trash, [normalizedTrashId]);
    return { value: project(located, targetType, targetId, inventory) };
  }

  async function restoreOriginalImages(trashId, { expectedVersion = null } = {}) {
    const normalizedTrashId = safeText(trashId, 100);
    if (!normalizedTrashId) return { missing: true };
    if (recordCommands) return recordCommands.run({
      commandId: "contentAttachment.restore", trashId: normalizedTrashId,
      mutate: (store, inventory) => restoreOriginalImagesInStore(store, normalizedTrashId, expectedVersion, inventory)
    });
    const store = await repository.read();
    const entry = trash.get(store.trash || [], normalizedTrashId);
    if (!entry || entry.type !== CONTENT_ATTACHMENT_TRASH_TYPE) return { missing: true };
    const recovery = recoveryPayload(entry);
    if (recovery.invalid) return recovery;
    const owned = await verifyOwned(recovery.value.sourcePaths);
    if (owned.forbidden) return { attachmentMissing: true };
    return repository.update(document => {
      return restoreOriginalImagesInStore(document, normalizedTrashId, expectedVersion, owned.inventory);
    });
  }

  async function prepareUnderstanding({
    targetType,
    targetId,
    attachmentPaths,
    inputVersion,
    owner = null
  }) {
    const target = normalizeContentAttachmentTarget(targetType, targetId);
    if (target.error) return target;
    const parsed = normalizeOriginalImagePaths(attachmentPaths, { maxImages, requireImages: true });
    if (parsed.error) return parsed;
    const prepare = (store, inventory) => {
      const owned = verifyInventory(parsed.value, inventory);
      if (owned.forbidden) return owned;
      const prepared = prepareUnderstandingInStore(store, {
        targetType, targetId, attachmentPaths: parsed.value, inputVersion, owner
      });
      if (!prepared.value) return prepared;
      const { located, ...value } = prepared.value;
      return { value: { accountId: accountId(), ...value } };
    };
    if (recordCommands) return recordCommands.run({
      commandId: "contentAttachment.prepareUnderstanding", targetType, targetId, owner,
      paths: parsed.value, readOnly: true, mutate: prepare
    });
    const owned = await verifyOwned(parsed.value);
    if (owned.forbidden) return owned;
    const store = await repository.read();
    return prepare(store, owned.inventory);
  }

  function prepareUnderstandingInStore(store, {
    targetType,
    targetId,
    attachmentPaths,
    inputVersion,
    owner = null
  }) {
    const target = normalizeContentAttachmentTarget(targetType, targetId);
    if (target.error) return target;
    const parsed = normalizeOriginalImagePaths(attachmentPaths, { maxImages, requireImages: true });
    if (parsed.error) return parsed;
    const located = locate(store, targetType, targetId, owner);
    if (!located) return { missing: true };
    const version = expectedVersionResult(located.resource, inputVersion);
    if (version.error || version.versionConflict) return version;
    const current = new Set(pathsOf(located.resource));
    if (parsed.value.some(path => !current.has(path))) return { attachmentMissing: true };
    return {
      value: {
        located,
        targetType,
        targetId,
        inputVersion: version.currentVersion,
        attachmentPaths: parsed.value,
        ...(targetType === "comment" ? { owner: { collection: located.collection, id: located.parent.id } } : {}),
        originalText: originalTextOf(targetType, located.resource),
        ...taskTarget(located, targetType, targetId)
      }
    };
  }

  async function requestUnderstanding(input, { clientRequestId = "" } = {}) {
    if (typeof requestImageUnderstanding !== "function") return { notConfigured: true };
    const normalizedRequestId = safeText(clientRequestId, 100);
    if (!normalizedRequestId) {
      return { error: "图片理解请求缺少幂等标识", code: "IDEMPOTENCY_KEY_REQUIRED" };
    }
    const prepared = await prepareUnderstanding(input);
    if (!prepared.value) return prepared;
    return {
      value: await requestImageUnderstanding({
        ...prepared.value,
        clientRequestId: normalizedRequestId
      })
    };
  }

  function saveUnderstandingInStore(store, {
    targetType,
    targetId,
    inputVersion,
    attachmentPaths,
    content,
    model = "",
    sourceTaskId = "",
    clientRequestId = "",
    owner = null
  }) {
    const target = normalizeContentAttachmentTarget(targetType, targetId);
    if (target.error) return target;
    const parsed = imageUnderstandingResult({
      attachmentPaths,
      content,
      model,
      sourceTaskId,
      clientRequestId
    }, { maxImages });
    if (parsed.error) return parsed;
    const changedAt = timestamp(now());
    const located = locate(store, targetType, targetId, owner);
    if (!located) return { missing: true };
    const duplicate = understandingsOf(located.resource).find(item => (
      (parsed.value.sourceTaskId && item.sourceTaskId === parsed.value.sourceTaskId)
      || (parsed.value.clientRequestId && item.clientRequestId === parsed.value.clientRequestId)
    ));
    if (duplicate) return { value: cloned(duplicate), duplicate: true };
    const version = expectedVersionResult(located.resource, inputVersion);
    if (version.error || version.versionConflict) return { stale: true, currentVersion: version.currentVersion };
    const current = new Set(pathsOf(located.resource));
    if (parsed.value.sourceAttachmentPaths.some(path => !current.has(path))) return { stale: true, currentVersion: version.currentVersion };
    const understanding = {
      id: createId(),
      kind: "imageUnderstanding",
      content: parsed.value.content,
      sourceAttachmentPaths: parsed.value.sourceAttachmentPaths,
      createdAt: changedAt,
      origin: "ai-derived",
      sourceVersion: version.currentVersion,
      ...(parsed.value.model ? { model: parsed.value.model } : {}),
      ...(parsed.value.sourceTaskId ? { sourceTaskId: parsed.value.sourceTaskId } : {}),
      ...(parsed.value.clientRequestId ? { clientRequestId: parsed.value.clientRequestId } : {})
    };
    located.resource.imageUnderstandings ||= [];
    located.resource.imageUnderstandings.push(understanding);
    touchLocated(located, changedAt);
    return { value: cloned(understanding) };
  }

  async function saveUnderstanding(input) {
    const parsed = imageUnderstandingResult({
      attachmentPaths: input.attachmentPaths,
      content: input.content,
      model: input.model,
      sourceTaskId: input.sourceTaskId,
      clientRequestId: input.clientRequestId
    }, { maxImages });
    if (parsed.error) return parsed;
    if (recordCommands) return recordCommands.run({
      commandId: "contentAttachment.saveUnderstanding", targetType: input.targetType,
      targetId: input.targetId, owner: input.owner, paths: parsed.value.sourceAttachmentPaths,
      mutate(store, inventory) {
        const owned = verifyInventory(parsed.value.sourceAttachmentPaths, inventory);
        return owned.forbidden ? owned : saveUnderstandingInStore(store, input);
      }
    });
    const owned = await verifyOwned(parsed.value.sourceAttachmentPaths);
    if (owned.forbidden) return owned;
    return repository.update(store => saveUnderstandingInStore(store, input));
  }

  function taskResult(store, task) {
    if (task?.kind !== "contentImageUnderstanding" || !task.resultId) return null;
    const located = locate(store, task.payload?.targetType, task.payload?.targetId, task.payload?.owner);
    return understandingsOf(located?.resource).find(item => (
      item.id === task.resultId && item.sourceTaskId === task.id
    )) || null;
  }

  return {
    get,
    replaceOriginalImages,
    reconcileOriginalImagesInStore,
    removeOriginalImage,
    restoreOriginalImages,
    prepareOriginalContent,
    prepareUnderstanding,
    prepareUnderstandingInStore,
    requestUnderstanding,
    saveUnderstanding,
    saveUnderstandingInStore,
    taskResult,
    contentOriginalPayload: (targetType, input) => contentOriginalPayload(targetType, input, { maxImages })
  };
}
