import crypto from "node:crypto";
import { safeText, recordVersion } from "../../shared/validation/index.mjs";
import { cleanAttachmentPaths } from "../../shared/attachments/index.mjs";
import { eventTimeFields } from "../../shared/time/index.mjs";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const pathValue = value => cleanAttachmentPaths([value])[0] || "";
const derivativeKeys = ["thumbPath", "displayPath", "editPath", "alphaMaskPath"];
const publicMediaKeys = ["cutoutPath", ...derivativeKeys];
const requestDigest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalizeTags = values => {
  const tags = [], seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const tag = safeText(value, 30), key = tag.toLocaleLowerCase("zh-CN");
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === 8) break;
  }
  return tags;
};
const backgroundOpacityPct = (value, fallback = 15) => {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(30, Math.round(parsed))) : fallback;
};
const priorRequest = (items, trashItems, clientRequestId) => (
  items.find(item => item.clientRequestId === clientRequestId)
  || trashItems.find(item => item.type === "keepsake" && item.payload?.clientRequestId === clientRequestId)?.payload
);

export function keepsakeImageCandidates(input = {}, { existingTags = [] } = {}) {
  const knownByKey = new Map(normalizeTags(existingTags).map(tag => [tag.toLocaleLowerCase("zh-CN"), tag]));
  return {
    title: safeText(input.title, 120),
    tags: normalizeTags(input.tags)
      .map(tag => knownByKey.get(tag.toLocaleLowerCase("zh-CN")))
      .filter(Boolean)
      .slice(0, 3),
    description: safeText(input.description, 2000)
  };
}

export function normalizeKeepsake(item, eventTime) {
  const { category: legacyCategory, ...record } = item || {};
  void legacyCategory;
  const originalPath = pathValue(record.originalPath);
  const cutoutPath = pathValue(record.cutoutPath);
  const derivatives = Object.fromEntries(derivativeKeys.map(key => [key, pathValue(record[key])]));
  const completeDerivatives = derivativeKeys.every(key => derivatives[key]);
  const pendingDerivatives = originalPath
    && derivatives.alphaMaskPath
    && ["pending", "failed"].includes(record.derivativeState);
  const normalized = {
    note: "", tags: [], source: "manual",
    ...record, ...eventTime,
    version: recordVersion(record.version),
    tags: normalizeTags(record.tags),
    backgroundOpacityPct: backgroundOpacityPct(record.backgroundOpacityPct),
    originalPath,
    cutoutPath,
    ...derivatives,
    thumbPath: derivatives.thumbPath || cutoutPath,
    displayPath: derivatives.displayPath || cutoutPath,
    derivativeState: completeDerivatives
      ? "ready"
      : pendingDerivatives
        ? record.derivativeState
        : originalPath && cutoutPath
          ? "legacy"
          : "invalid"
  };
  return originalPath && (completeDerivatives || cutoutPath || pendingDerivatives)
    ? normalized
    : { ...normalized, validationState: "invalid" };
}

export function keepsakePayload(input, existing = null) {
  const title = safeText(input.title, 120);
  if (!title) return { error: "请填写小物名称" };
  const eventTime = eventTimeFields(input, existing);
  if (!eventTime) return { error: "留存时间格式不正确" };
  const originalPath = hasOwn(input, "originalPath") ? pathValue(input.originalPath) : existing?.originalPath || "";
  const cutoutPath = hasOwn(input, "cutoutPath") ? pathValue(input.cutoutPath) : existing?.cutoutPath || "";
  const derivatives = Object.fromEntries(derivativeKeys.map(key => [
    key,
    hasOwn(input, key) ? pathValue(input[key]) : existing?.[key] || ""
  ]));
  const tags = normalizeTags(hasOwn(input, "tags") ? input.tags : existing?.tags || []);
  const opacity = hasOwn(input, "backgroundOpacityPct")
    ? backgroundOpacityPct(input.backgroundOpacityPct, existing?.backgroundOpacityPct ?? 15)
    : backgroundOpacityPct(existing?.backgroundOpacityPct);
  const completeDerivatives = derivativeKeys.every(key => derivatives[key]);
  const requestedDerivativeState = hasOwn(input, "derivativeState")
    ? input.derivativeState
    : existing?.derivativeState;
  const pendingDerivatives = originalPath
    && derivatives.alphaMaskPath
    && ["pending", "failed"].includes(requestedDerivativeState);
  if (!originalPath || (!completeDerivatives && !cutoutPath && !pendingDerivatives)) {
    return { error: "请先完成原图和全部派生图保存" };
  }
  return {
    value: {
      ...eventTime,
      title,
      note: safeText(input.note, 2000),
      tags,
      originalPath,
      cutoutPath,
      ...derivatives,
      derivativeState: completeDerivatives ? "ready" : pendingDerivatives ? requestedDerivativeState : "legacy",
      source: input.source === "auto" ? "auto" : existing?.source || "manual",
      edgeExpansion: Math.max(0, Math.min(20, Number(input.edgeExpansion) || 0)),
      backgroundOpacityPct: opacity
    }
  };
}

export function keepsakeMediaManifest(item) {
  const originalPath = pathValue(item?.originalPath);
  const publicPath = value => {
    const resourcePath = pathValue(value);
    return resourcePath && resourcePath !== originalPath ? resourcePath : "";
  };
  const firstPublicPath = (...values) => values.map(publicPath).find(Boolean) || "";
  const listImagePath = firstPublicPath(item?.thumbPath, item?.cutoutPath);
  const detailImagePath = firstPublicPath(item?.displayPath, item?.cutoutPath);
  const backgroundPath = publicPath(item?.editPath);
  const derivativeState = String(item?.derivativeState || "invalid");
  const status = ["pending", "failed"].includes(derivativeState)
    ? derivativeState
    : listImagePath && detailImagePath
      ? "ready"
      : "unavailable";
  return {
    version: 1,
    status,
    originalAvailable: Boolean(originalPath),
    retryable: status === "failed",
    list: { imagePath: listImagePath, backgroundPath },
    detail: { imagePath: detailImagePath, backgroundPath }
  };
}

export function publicKeepsake(item) {
  const normalized = normalizeKeepsake(item, {
    occurredAt: item.occurredAt,
    occurredOn: item.occurredOn
  });
  const media = keepsakeMediaManifest(normalized);
  const { originalPath, requestHash, previewPath, ...visible } = normalized;
  void requestHash;
  void previewPath;
  for (const key of publicMediaKeys) {
    if (visible[key] === originalPath) visible[key] = "";
  }
  return { ...visible, media };
}

export function originalKeepsakeMedia(item) {
  const originalPath = pathValue(item?.originalPath);
  return originalPath ? { originalPath } : null;
}

// The repository callback receives only this domain's collection.
export function createKeepsakeRecords({ repository, now = () => new Date().toISOString(), createId = () => crypto.randomUUID() }) {
  return {
    async get(id) {
      return (await repository.read()).find(item => item.id === id) || null;
    },
    async create(input, { clientRequestId = "" } = {}) {
      const parsed = keepsakePayload(input);
      if (parsed.error) return parsed;
      const requestHash = clientRequestId ? requestDigest(parsed.value) : "";
      const createRecord = (items, trashItems = [], useLegacyLookup = true) => {
        if (clientRequestId && useLegacyLookup) {
          const duplicate = priorRequest(items, trashItems, clientRequestId);
          if (duplicate) return duplicate.requestHash === requestHash ? { value: duplicate, duplicate: true } : { conflict: true };
        }
        const keepsake = {
          id: createId(),
          createdAt: now(),
          ...parsed.value,
          ...(clientRequestId ? { version: 1, clientRequestId, requestHash } : {})
        };
        items.unshift(keepsake);
        return { value: keepsake, duplicate: false };
      };
      if (clientRequestId && typeof repository.executeIdempotent === "function") {
        try {
          return await repository.executeIdempotent(
            { scope: "keepsakes.create", key: clientRequestId, requestHash },
            (items, trashItems = []) => createRecord(items, trashItems, false),
            { onReplay: result => ({ ...result, duplicate: true }) }
          );
        } catch (error) {
          if (error?.code === "IDEMPOTENCY_KEY_REUSED") return { conflict: true };
          throw error;
        }
      }
      return repository.update((items, trashItems = []) => createRecord(items, trashItems));
    },
    update(id, input) {
      return repository.update(items => {
        const keepsake = items.find(item => item.id === id);
        if (!keepsake) return { missing: true };
        const parsed = keepsakePayload(input, keepsake);
        if (parsed.error) return parsed;
        Object.assign(keepsake, parsed.value, { updatedAt: now() });
        delete keepsake.category;
        return { value: keepsake };
      });
    }
  };
}
