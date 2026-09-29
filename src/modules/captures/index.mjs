import crypto from "node:crypto";
import { cleanAttachmentPaths } from "../../shared/attachments/index.mjs";
import { eventTimeFields } from "../../shared/time/index.mjs";
import { recordVersion, safeText } from "../../shared/validation/index.mjs";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const AFTER_COMMIT = Symbol.for("for-now.after-commit");
const requestDigest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const IDEMPOTENCY_SCOPE = "captures.create";
const tagsOf = value => (Array.isArray(value) ? value : [])
  .map(tag => safeText(tag, 30))
  .filter(Boolean)
  .slice(0, 8);

const markReplay = result => (
  result && typeof result === "object" ? { ...result, duplicate: true } : result
);

function idempotencyPayload(input, value) {
  const canonical = { ...value };
  if (!hasOwn(input, "occurredAt")) delete canonical.occurredAt;
  if (!hasOwn(input, "occurredOn")) delete canonical.occurredOn;
  return canonical;
}

function priorRequest(items, trashItems, clientRequestId) {
  return items.find(item => item.clientRequestId === clientRequestId)
    || trashItems.find(item => item.type === "capture" && item.payload?.clientRequestId === clientRequestId)?.payload;
}

function pageOf(items, { afterId = "", limit = 20 } = {}) {
  const start = afterId ? items.findIndex(item => item.id === afterId) + 1 : 0;
  if (afterId && start === 0) return { invalidCursor: true };
  const page = items.slice(start, start + limit);
  return { items: page, nextId: start + page.length < items.length ? page.at(-1)?.id || "" : "" };
}

const versioned = item => item ? { ...item, version: recordVersion(item.version) } : null;

export function capturePayload(input, existing = null) {
  const merged = existing ? { ...existing, ...input } : input;
  const content = safeText(merged.content, 12000);
  const attachmentPaths = cleanAttachmentPaths(merged.attachmentPaths);
  if (!content && !attachmentPaths.length) {
    return { error: existing ? "请保留文字或至少一张图片" : "先写一点什么，或插入图片" };
  }
  const eventTime = eventTimeFields(input, existing);
  if (!eventTime) return { error: "发生时间格式不正确" };
  return {
    value: {
      ...eventTime,
      content,
      tags: tagsOf(merged.tags),
      attachmentPaths
    }
  };
}

export function createCaptureRecords({
  repository,
  reanchorAnnotations,
  reconcileOriginalImages = null,
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID()
}) {
  return {
    async list(options) {
      const page = pageOf(await repository.read(), options);
      return page.invalidCursor ? page : { ...page, items: page.items.map(versioned) };
    },

    async get(id) {
      return versioned((await repository.read()).find(item => item.id === id));
    },

    async create(input, { clientRequestId = "" } = {}) {
      const parsed = capturePayload(input);
      if (parsed.error) return parsed;
      const requestHash = clientRequestId ? requestDigest(idempotencyPayload(input, parsed.value)) : "";
      const create = (items, trashItems = [], useLegacyLookup = true) => {
        if (clientRequestId && useLegacyLookup) {
          const duplicate = priorRequest(items, trashItems, clientRequestId);
          if (duplicate) {
            return duplicate.requestHash === requestHash
              ? { value: duplicate, duplicate: true }
              : { conflict: true };
          }
        }
        const capture = {
          id: createId(),
          createdAt: now(),
          ...parsed.value,
          annotations: [],
          annotationDrift: [],
          ...(clientRequestId ? { version: 1, clientRequestId, requestHash } : {})
        };
        items.unshift(capture);
        return { value: capture, duplicate: false };
      };
      if (clientRequestId && typeof repository.executeIdempotent === "function") {
        return repository.executeIdempotent(
          {
            scope: IDEMPOTENCY_SCOPE,
            key: clientRequestId,
            requestHash
          },
          (items, trashItems = []) => create(items, trashItems, false),
          { onReplay: markReplay }
        );
      }
      return repository.update((items, trashItems = []) => create(items, trashItems));
    },

    update(id, input, { expectedVersion = null } = {}) {
      return repository.update((items, _trashItems, store) => {
        const capture = items.find(item => item.id === id);
        if (!capture) return { missing: true };
        const currentVersion = recordVersion(capture.version);
        if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
          return { versionConflict: true, currentVersion };
        }
        const parsed = capturePayload(input, capture);
        if (parsed.error) return parsed;
        if (capture.content !== parsed.value.content) {
          reanchorAnnotations(capture, "content", capture.content, parsed.value.content);
        }
        const updatedAt = now();
        let reconciled = null;
        if (store && typeof reconcileOriginalImages === "function") {
          reconciled = reconcileOriginalImages(store, "capture", id, parsed.value.attachmentPaths, {
            changedAt: updatedAt,
            touchResource: false,
            allowEmptyImages: true
          });
          if (!reconciled.value) return reconciled;
        }
        Object.assign(capture, parsed.value, {
          updatedAt,
          version: currentVersion + 1
        });
        const result = { value: capture, ...(reconciled?.trashId ? { trashId: reconciled.trashId } : {}) };
        if (reconciled?.[AFTER_COMMIT]) Object.defineProperty(result, AFTER_COMMIT, { value: reconciled[AFTER_COMMIT] });
        return result;
      });
    }
  };
}
