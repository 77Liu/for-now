import crypto from "node:crypto";
import { eventTimeFields } from "../../shared/time/index.mjs";
import { recordVersion, safeText } from "../../shared/validation/index.mjs";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const requestDigest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const QUOTE_CREATE_SCOPE = "quotes.create";

async function executeCreate(repository, request, mutate) {
  if (!request.key || typeof repository.executeIdempotent !== "function") {
    return repository.update(mutate);
  }
  let executed = false;
  try {
    const result = await repository.executeIdempotent(request, (...args) => {
      executed = true;
      const response = mutate(...args);
      if (response?.conflict) {
        throw Object.assign(new Error("同一幂等键不能用于不同内容"), {
          statusCode: 409,
          code: "IDEMPOTENCY_KEY_REUSED"
        });
      }
      return response;
    });
    return executed ? result : { ...result, duplicate: true };
  } catch (error) {
    if (error?.code === "IDEMPOTENCY_KEY_REUSED") return { conflict: true };
    throw error;
  }
}

function pageOf(items, { afterId = "", limit = 20 } = {}) {
  const start = afterId ? items.findIndex(item => item.id === afterId) + 1 : 0;
  if (afterId && start === 0) return { invalidCursor: true };
  const page = items.slice(start, start + limit);
  return { items: page, nextId: start + page.length < items.length ? page.at(-1)?.id || "" : "" };
}

function priorQuote(items, trashItems, clientRequestId) {
  return items.find(item => item.clientRequestId === clientRequestId)
    || trashItems.find(item => item.type === "quote" && item.payload?.clientRequestId === clientRequestId)?.payload;
}

function idempotencyPayload(input, value) {
  const canonical = { ...value };
  if (!hasOwn(input, "occurredAt")) delete canonical.occurredAt;
  if (!hasOwn(input, "occurredOn")) delete canonical.occurredOn;
  return canonical;
}

const quoteTags = value => (
  Array.isArray(value) ? value : []
).map(tag => safeText(tag, 30)).filter(Boolean).slice(0, 8);

export function normalizeQuote(quote = {}) {
  return {
    tags: [],
    annotations: [],
    annotationDrift: [],
    ...quote,
    tags: quoteTags(quote.tags),
    version: recordVersion(quote.version)
  };
}

export function quotePayload(input = {}, existing = null, { partial = false } = {}) {
  const field = (key, max) => (
    partial && existing && !hasOwn(input, key)
      ? safeText(existing[key], max)
      : safeText(input[key], max)
  );
  const source = field("source", 500);
  const content = field("content", 5000);
  if (!source || !content) return { error: "来源和内容都必须填写" };
  const eventTime = eventTimeFields(input, existing);
  if (!eventTime) return { error: "发生时间格式不正确" };
  const tags = partial && existing && !hasOwn(input, "tags")
    ? quoteTags(existing.tags)
    : quoteTags(input.tags);
  return { value: { ...eventTime, source, content, tags } };
}

export function createQuoteRecords({
  repository,
  reanchorAnnotations = () => {},
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID()
}) {
  if (!repository || typeof repository.read !== "function" || typeof repository.update !== "function") {
    throw new TypeError("Quote records require a repository with read() and update()");
  }
  if (typeof reanchorAnnotations !== "function") {
    throw new TypeError("Quote records require an annotation reanchor function");
  }

  return {
    async list(options) {
      const page = pageOf(await repository.read(), options);
      return page.invalidCursor ? page : { ...page, items: page.items.map(normalizeQuote) };
    },

    async get(id) {
      const quote = (await repository.read()).find(item => item.id === id);
      return quote ? normalizeQuote(quote) : null;
    },

    async create(input, { clientRequestId = "" } = {}) {
      const parsed = quotePayload(input);
      if (parsed.error) return parsed;
      const requestHash = clientRequestId ? requestDigest(idempotencyPayload(input, parsed.value)) : "";
      return executeCreate(repository, {
        scope: QUOTE_CREATE_SCOPE,
        key: clientRequestId,
        requestHash
      }, (items, trashItems = []) => {
        if (clientRequestId) {
          const duplicate = priorQuote(items, trashItems, clientRequestId);
          if (duplicate) {
            return duplicate.requestHash === requestHash
              ? { value: normalizeQuote(duplicate), duplicate: true }
              : { conflict: true };
          }
        }
        const quote = {
          id: createId(),
          createdAt: now(),
          ...parsed.value,
          annotations: [],
          annotationDrift: [],
          ...(clientRequestId ? { version: 1, clientRequestId, requestHash } : {})
        };
        items.unshift(quote);
        return { value: quote, duplicate: false };
      });
    },

    update(id, input, { expectedVersion = null, partial = false } = {}) {
      if (!partial && (!safeText(input?.source, 500) || !safeText(input?.content, 5000))) {
        return Promise.resolve({ error: "来源和内容都必须填写" });
      }
      return repository.update(items => {
        const quote = items.find(item => item.id === id);
        if (!quote) return { missing: true };
        const currentVersion = recordVersion(quote.version);
        if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
          return { versionConflict: true, currentVersion };
        }
        const parsed = quotePayload(input, quote, { partial });
        if (parsed.error) return parsed;
        reanchorAnnotations(quote, "content", quote.content || "", parsed.value.content);
        Object.assign(quote, parsed.value, {
          updatedAt: now(),
          version: currentVersion + 1
        });
        return { value: quote };
      });
    }
  };
}
