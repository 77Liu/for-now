import crypto from "node:crypto";
import { eventTimeFields } from "../../shared/time/index.mjs";
import { recordVersion, safeText } from "../../shared/validation/index.mjs";

const clamp5 = value => Math.min(5, Math.max(1, Number(value) || 3));
const requestDigest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const priorRequest = (items, trashItems, clientRequestId) => (
  items.find(item => item.clientRequestId === clientRequestId)
  || trashItems.find(item => item.type === "checkin" && item.payload?.clientRequestId === clientRequestId)?.payload
);

function idempotencyPayload(input, value) {
  const canonical = { ...value };
  if (!hasOwn(input, "occurredAt")) delete canonical.occurredAt;
  if (!hasOwn(input, "occurredOn")) delete canonical.occurredOn;
  return canonical;
}

function pageOf(items, { afterId = "", limit = 20 } = {}) {
  const start = afterId ? items.findIndex(item => item.id === afterId) + 1 : 0;
  if (afterId && start === 0) return { invalidCursor: true };
  const page = items.slice(start, start + limit);
  return { items: page, nextId: start + page.length < items.length ? page.at(-1)?.id || "" : "" };
}

export function checkinPayload(input, existing = null) {
  const merged = existing ? { ...existing, ...input } : input;
  const eventTime = eventTimeFields(input, existing);
  if (!eventTime) return { error: "发生时间格式不正确" };
  return {
    value: {
      ...eventTime,
      mood: clamp5(merged.mood),
      energy: clamp5(merged.energy),
      stress: clamp5(merged.stress),
      sleep: clamp5(merged.sleep),
      factors: (merged.factors || []).map(value => safeText(value, 40)).filter(Boolean).slice(0, 20),
      custom: Object.fromEntries(Object.entries(merged.custom || {}).map(([key, value]) => [safeText(key, 60), clamp5(value)])),
      notes: Object.fromEntries(Object.entries(merged.notes || {}).map(([key, value]) => [
        existing ? safeText(key, 60) : key,
        safeText(value, 800)
      ]))
    }
  };
}

export function createCheckinRecords({
  repository,
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID()
}) {
  return {
    async list(options) {
      return pageOf(await repository.read(), options);
    },

    async get(id) {
      return (await repository.read()).find(item => item.id === id) || null;
    },

    async create(input, { clientRequestId = "" } = {}) {
      const parsed = checkinPayload(input);
      if (parsed.error) return parsed;
      const requestHash = clientRequestId ? requestDigest(idempotencyPayload(input, parsed.value)) : "";
      const createRecord = (items, trashItems = [], useLegacyLookup = true) => {
        if (clientRequestId && useLegacyLookup) {
          const duplicate = priorRequest(items, trashItems, clientRequestId);
          if (duplicate) {
            return duplicate.requestHash === requestHash
              ? { value: duplicate, duplicate: true }
              : { conflict: true };
          }
        }
        const entry = {
          id: createId(),
          createdAt: now(),
          ...parsed.value,
          ...(clientRequestId ? { version: 1, clientRequestId, requestHash } : {})
        };
        items.unshift(entry);
        return { value: entry, duplicate: false };
      };
      if (clientRequestId && typeof repository.executeIdempotent === "function") {
        return repository.executeIdempotent(
          { scope: "checkins.create", key: clientRequestId, requestHash },
          (items, trashItems = []) => createRecord(items, trashItems, false),
          { onReplay: result => ({ ...result, duplicate: true }) }
        );
      }
      return repository.update((items, trashItems = []) => createRecord(items, trashItems));
    },

    update(id, input, { expectedVersion = null } = {}) {
      return repository.update(items => {
        const entry = items.find(item => item.id === id);
        if (!entry) return { missing: true };
        const currentVersion = recordVersion(entry.version);
        if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
          return { versionConflict: true, currentVersion };
        }
        const parsed = checkinPayload(input, entry);
        if (parsed.error) return parsed;
        Object.assign(entry, parsed.value, {
          updatedAt: now(),
          version: currentVersion + 1
        });
        return { value: entry };
      });
    }
  };
}
