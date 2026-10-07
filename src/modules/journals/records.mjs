import crypto from "node:crypto";
import { eventTimeFields } from "../../shared/time/index.mjs";
import { recordVersion, safeText } from "../../shared/validation/index.mjs";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const requestDigest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const JOURNAL_CREATE_IDEMPOTENCY_SCOPE = "journals.create";
const JOURNAL_DRAFT_IDEMPOTENCY_SCOPE = "journalDraft.save";
export const JOURNAL_REFLECTION_IDEMPOTENCY_SCOPE = "journalReflections.create";
const tagsOf = value => (Array.isArray(value) ? value : [])
  .map(tag => safeText(tag, 30))
  .filter(Boolean)
  .slice(0, 8);

const isIdempotencyConflict = error => error?.code === "IDEMPOTENCY_KEY_REUSED";
const markReplay = result => (
  result && typeof result === "object" ? { ...result, duplicate: true } : result
);

function idempotencyPayload(input, value) {
  const canonical = { ...value };
  if (!hasOwn(input, "occurredAt")) delete canonical.occurredAt;
  if (!hasOwn(input, "occurredOn")) delete canonical.occurredOn;
  return canonical;
}

function journalDraftIdempotencyPayload(input) {
  return {
    journalId: safeText(input.journalId, 100),
    title: safeText(input.title, 120),
    content: safeText(input.content, 50000)
  };
}

function priorJournalRequest(state, clientRequestId) {
  return state.journals.find(item => item.clientRequestId === clientRequestId)
    || state.trash?.find(item => item.type === "journal" && item.payload?.clientRequestId === clientRequestId)?.payload;
}

function priorReflectionRequest(state, clientRequestId) {
  for (const journal of state.journals) {
    const reflection = (journal.reflections || []).find(item => item.clientRequestId === clientRequestId);
    if (reflection) return { journalId: journal.id, reflection };
  }
  const deleted = state.trash?.find(item => (
    item.type === "journalReflection"
    && item.payload?.clientRequestId === clientRequestId
  ));
  return deleted ? { journalId: deleted.location?.parentId || "", reflection: deleted.payload } : null;
}

function pageOf(items, { afterId = "", limit = 20 } = {}) {
  const start = afterId ? items.findIndex(item => item.id === afterId) + 1 : 0;
  if (afterId && start === 0) return { invalidCursor: true };
  const page = items.slice(start, start + limit);
  return { items: page, nextId: start + page.length < items.length ? page.at(-1)?.id || "" : "" };
}

const versionedReflection = item => ({ ...item, version: recordVersion(item.version) });
const versionedJournal = item => item ? {
  ...item,
  version: recordVersion(item.version),
  reflections: (item.reflections || []).map(versionedReflection)
} : null;

export function journalPayload(input, existing = null) {
  const merged = existing ? { ...existing, ...input } : input;
  const content = safeText(merged.content, 50000);
  if (!content) return { error: "日记内容不能为空" };
  const eventTime = eventTimeFields(input, existing);
  if (!eventTime) return { error: "发生时间格式不正确" };
  return {
    value: {
      ...eventTime,
      title: safeText(merged.title, 120),
      content,
      tags: tagsOf(merged.tags)
    }
  };
}

export function journalDraftPayload(input, journals) {
  const title = safeText(input.title, 120);
  const content = safeText(input.content, 50000);
  if (!title && !content) return { error: "先写下一点内容再保存草稿" };
  const requestedJournalId = safeText(input.journalId, 100);
  return {
    value: {
      journalId: journals.some(item => item.id === requestedJournalId) ? requestedJournalId : "",
      title,
      content
    }
  };
}

export function createJournalRecords({
  repository,
  reanchorAnnotations,
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID()
}) {
  const executeIdempotent = (scope, key, requestHash, operation) => repository.executeIdempotent(
    { scope, key, requestHash },
    operation,
    { onReplay: markReplay }
  );

  return {
    async list(options) {
      const page = pageOf((await repository.read()).journals, options);
      return page.invalidCursor ? page : { ...page, items: page.items.map(versionedJournal) };
    },

    async get(id) {
      return versionedJournal((await repository.read()).journals.find(item => item.id === id));
    },

    async getDraft() {
      const draft = (await repository.read()).journalDraft;
      return draft ? { ...draft, version: recordVersion(draft.version) } : null;
    },

    async create(input, { clientRequestId = "" } = {}) {
      const parsed = journalPayload(input);
      if (parsed.error) return parsed;
      const requestHash = clientRequestId ? requestDigest(idempotencyPayload(input, parsed.value)) : "";
      const create = (state, useLegacyLookup = true) => {
        if (clientRequestId && useLegacyLookup) {
          const duplicate = priorJournalRequest(state, clientRequestId);
          if (duplicate) {
            return duplicate.requestHash === requestHash
              ? { value: duplicate, duplicate: true }
              : { conflict: true };
          }
        }
        const journal = {
          id: createId(),
          createdAt: now(),
          ...parsed.value,
          reflections: [],
          annotations: [],
          annotationDrift: [],
          ...(clientRequestId ? { version: 1, clientRequestId, requestHash } : {})
        };
        state.journals.unshift(journal);
        if (!state.journalDraft?.journalId) state.journalDraft = null;
        return { value: journal, duplicate: false };
      };
      if (clientRequestId && typeof repository.executeIdempotent === "function") {
        return executeIdempotent(
          JOURNAL_CREATE_IDEMPOTENCY_SCOPE,
          clientRequestId,
          requestHash,
          state => create(state, false)
        );
      }
      return repository.update(state => create(state));
    },

    update(id, input, { expectedVersion = null } = {}) {
      return repository.update(state => {
        const journal = state.journals.find(item => item.id === id);
        if (!journal) return { missing: true };
        const currentVersion = recordVersion(journal.version);
        if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
          return { versionConflict: true, currentVersion };
        }
        const parsed = journalPayload(input, journal);
        if (parsed.error) return parsed;
        if (journal.content !== parsed.value.content) {
          reanchorAnnotations(journal, "content", journal.content, parsed.value.content);
        }
        Object.assign(journal, parsed.value, {
          updatedAt: now(),
          version: currentVersion + 1
        });
        if (state.journalDraft?.journalId === id) state.journalDraft = null;
        return { value: journal };
      });
    },

    async saveDraft(input, { clientRequestId = "" } = {}) {
      const requestHash = clientRequestId
        ? requestDigest(journalDraftIdempotencyPayload(input))
        : "";
      const save = (state, useLegacyLookup = true) => {
        const parsed = journalDraftPayload(input, state.journals);
        if (parsed.error) return parsed;
        const storedRequestHash = clientRequestId && useLegacyLookup
          ? requestDigest(parsed.value)
          : requestHash;
        if (clientRequestId && useLegacyLookup && state.journalDraft?.clientRequestId === clientRequestId) {
          return state.journalDraft.requestHash === storedRequestHash
            ? { value: state.journalDraft, duplicate: true }
            : { conflict: true };
        }
        const nextVersion = state.journalDraft ? recordVersion(state.journalDraft.version) + 1 : 1;
        state.journalDraft = {
          ...parsed.value,
          updatedAt: now(),
          ...(clientRequestId ? { version: nextVersion, clientRequestId, requestHash: storedRequestHash } : {})
        };
        return { value: state.journalDraft, duplicate: false };
      };
      if (clientRequestId && typeof repository.executeIdempotent === "function") {
        const current = await repository.read();
        const initial = journalDraftPayload(input, current.journals);
        if (initial.error) return initial;
        return executeIdempotent(
          JOURNAL_DRAFT_IDEMPOTENCY_SCOPE,
          clientRequestId,
          requestHash,
          state => save(state, false)
        );
      }
      return repository.update(state => save(state));
    },

    async findReflectionRequest(journalId, clientRequestId, requestHash) {
      if (!clientRequestId) return null;
      if (typeof repository.readIdempotent === "function") {
        try {
          const replay = await repository.readIdempotent({
            scope: JOURNAL_REFLECTION_IDEMPOTENCY_SCOPE,
            key: clientRequestId,
            requestHash
          });
          if (replay !== undefined) {
            return replay && typeof replay === "object" && hasOwn(replay, "value")
              ? markReplay(replay)
              : { value: replay, duplicate: true };
          }
        } catch (error) {
          if (isIdempotencyConflict(error)) return { conflict: true };
          throw error;
        }
      }
      const duplicate = priorReflectionRequest(await repository.read(), clientRequestId);
      if (!duplicate) return null;
      return duplicate.journalId === journalId && duplicate.reflection.requestHash === requestHash
        ? { value: duplicate.reflection, duplicate: true }
        : { conflict: true };
    },

    addReflection(journalId, input, { clientRequestId = "", requestHash = "" } = {}) {
      const add = (state, useLegacyLookup = true) => {
        if (clientRequestId && useLegacyLookup) {
          const duplicate = priorReflectionRequest(state, clientRequestId);
          if (duplicate) {
            return duplicate.journalId === journalId && duplicate.reflection.requestHash === requestHash
              ? { value: duplicate.reflection, duplicate: true }
              : { conflict: true };
          }
        }
        const journal = state.journals.find(item => item.id === journalId);
        if (!journal) return { missing: true };
        const reflection = {
          id: createId(),
          createdAt: now(),
          sourceUpdatedAt: input.sourceUpdatedAt,
          content: input.content,
          ...(input.reasoningContent ? { reasoningContent: input.reasoningContent } : {}),
          ...(input.contextReceipt ? { contextReceipt: structuredClone(input.contextReceipt) } : {}),
          ...(clientRequestId ? { version: 1, clientRequestId, requestHash } : {})
        };
        journal.reflections ||= [];
        journal.reflections.unshift(reflection);
        return { value: reflection, duplicate: false };
      };
      if (clientRequestId && typeof repository.executeIdempotent === "function") {
        return executeIdempotent(
          JOURNAL_REFLECTION_IDEMPOTENCY_SCOPE,
          clientRequestId,
          requestHash,
          state => add(state, false)
        );
      }
      return repository.update(state => add(state));
    }
  };
}
