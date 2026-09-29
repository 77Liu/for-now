import crypto from "node:crypto";
import { safeText, recordVersion } from "../../shared/validation/index.mjs";
import { cleanAttachmentPaths } from "../../shared/attachments/index.mjs";
import { eventTimeFields } from "../../shared/time/index.mjs";

const CATEGORIES = ["小票", "纸品", "立牌", "小物", "其他"];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const pathValue = value => cleanAttachmentPaths([value])[0] || "";
const derivativeKeys = ["thumbPath", "displayPath", "editPath", "alphaMaskPath"];

export function normalizeKeepsake(item, eventTime) {
  const originalPath = pathValue(item.originalPath);
  const cutoutPath = pathValue(item.cutoutPath);
  const derivatives = Object.fromEntries(derivativeKeys.map(key => [key, pathValue(item[key])]));
  const completeDerivatives = derivativeKeys.every(key => derivatives[key]);
  const normalized = {
    category: "其他", note: "", tags: [], source: "manual",
    ...item, ...eventTime,
    version: recordVersion(item.version),
    tags: (Array.isArray(item.tags) ? item.tags : []).map(tag => safeText(tag, 30)).filter(Boolean).slice(0, 8),
    originalPath,
    cutoutPath,
    ...derivatives,
    thumbPath: derivatives.thumbPath || cutoutPath,
    displayPath: derivatives.displayPath || cutoutPath,
    derivativeState: completeDerivatives ? "ready" : originalPath && cutoutPath ? "legacy" : "invalid"
  };
  return originalPath && (completeDerivatives || cutoutPath)
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
  const tags = (hasOwn(input, "tags") ? (Array.isArray(input.tags) ? input.tags : []) : existing?.tags || []).map(tag => safeText(tag, 30)).filter(Boolean).slice(0, 8);
  const completeDerivatives = derivativeKeys.every(key => derivatives[key]);
  if (!originalPath || (!completeDerivatives && !cutoutPath)) return { error: "请先完成原图和全部派生图保存" };
  return {
    value: {
      ...eventTime,
      title,
      category: CATEGORIES.includes(input.category) ? input.category : existing?.category || "其他",
      note: safeText(input.note, 2000),
      tags,
      originalPath,
      cutoutPath,
      ...derivatives,
      derivativeState: completeDerivatives ? "ready" : "legacy",
      source: input.source === "auto" ? "auto" : existing?.source || "manual",
      edgeExpansion: Math.max(0, Math.min(20, Number(input.edgeExpansion) || 0))
    }
  };
}

export function publicKeepsake(item) {
  const { originalPath, ...visible } = normalizeKeepsake(item, {
    occurredAt: item.occurredAt,
    occurredOn: item.occurredOn
  });
  return visible;
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
    async create(input) {
      const parsed = keepsakePayload(input);
      if (parsed.error) return parsed;
      const keepsake = { id: createId(), createdAt: now(), ...parsed.value };
      await repository.update(items => items.unshift(keepsake));
      return { value: keepsake };
    },
    update(id, input) {
      return repository.update(items => {
        const keepsake = items.find(item => item.id === id);
        if (!keepsake) return { missing: true };
        const parsed = keepsakePayload(input, keepsake);
        if (parsed.error) return parsed;
        Object.assign(keepsake, parsed.value, { updatedAt: now() });
        return { value: keepsake };
      });
    }
  };
}
