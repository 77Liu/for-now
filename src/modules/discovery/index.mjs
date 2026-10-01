import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { recordVersion } from "../../shared/validation/index.mjs";

export const THOUGHT_DISCOVERY_TYPES = Object.freeze(["question", "idea", "answer", "record"]);
export const DISCOVERY_GENRES = Object.freeze(["thought", "capture", "journal", "bookExcerpt", "quote"]);

const TYPE_SET = new Set(THOUGHT_DISCOVERY_TYPES);
const GENRE_SET = new Set(DISCOVERY_GENRES);
const GENRE_LABELS = Object.freeze({
  thought: "思绪",
  capture: "捕念",
  journal: "日记",
  bookExcerpt: "书摘",
  quote: "善言"
});
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const text = value => typeof value === "string" ? value : "";
const normalizedText = value => text(value).normalize("NFKC").toLocaleLowerCase();
const validTime = value => {
  const milliseconds = Date.parse(value || "");
  return Number.isFinite(milliseconds) ? milliseconds : null;
};
const sourceOf = (item, fallback = "user") => {
  if (item?.authorType === "user") return "user";
  if (item?.authorType === "ai") return "ai";
  const ai = /^(?:deepseek|codex)/u.test(text(item?.origin))
    || Boolean(item?.modelDraft)
    || Boolean(item?.reasoningContent);
  return ai ? "ai" : fallback;
};
const contentOf = item => text(item?.content) || text(item?.modelDraft);
const sourceLabel = source => source === "ai" ? "应答" : "用户原文";
const sourceBoundary = source => source === "ai" ? "ai_derived" : "user_original";
const hasItems = value => Array.isArray(value) && value.length > 0;

function thoughtsOf(document) {
  const thoughts = Array.isArray(document) ? document : document?.thoughts;
  if (!Array.isArray(thoughts)) throw new TypeError("Discovery repository must provide a thoughts collection");
  return thoughts;
}

const collectionOf = (document, name) => Array.isArray(document?.[name]) ? document[name] : [];

function normalizeTypes(value) {
  if (value == null) return THOUGHT_DISCOVERY_TYPES.slice();
  const input = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(input)) return null;
  const selected = new Set(input.map(item => text(item).trim()).filter(Boolean));
  if ([...selected].some(type => !TYPE_SET.has(type))) return null;
  return THOUGHT_DISCOVERY_TYPES.filter(type => selected.has(type));
}

function normalizeGenres(value) {
  if (value == null) return ["thought"];
  const input = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(input)) return null;
  const selected = new Set(input.map(item => text(item).trim()).filter(Boolean));
  if ([...selected].some(genre => !GENRE_SET.has(genre))) return null;
  return DISCOVERY_GENRES.filter(genre => selected.has(genre));
}

export function normalizeThoughtDiscoveryFilters(input = {}) {
  const types = normalizeTypes(input.types);
  if (!types) return {
    error: "思绪类型只能是 question、idea、answer、record",
    code: "INVALID_DISCOVERY_TYPES"
  };
  const genres = normalizeGenres(input.genres);
  if (!genres) return {
    error: "检索体裁只能是 thought、capture、journal、bookExcerpt、quote",
    code: "INVALID_DISCOVERY_GENRES"
  };
  const requestedLimit = Number(input.limit);
  return {
    query: text(input.query).trim().normalize("NFKC"),
    types,
    genres,
    freshOnly: input.freshOnly === true || input.fresh === "fresh",
    cursor: text(input.cursor),
    limit: Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT
  };
}

function isUntouchedAiAnswer(item) {
  const content = text(item?.content).trim();
  const modelDraft = text(item?.modelDraft).trim();
  return item?.type === "answer"
    && sourceOf(item) === "ai"
    && Boolean(modelDraft)
    && content === modelDraft
    && !item.editedFromModel
    && !item.updatedAt
    && !["manual", "deepseek-edited"].includes(item.origin);
}

function hasUserTrace(root, children) {
  return Boolean(
    root.updatedAt
    || root.dispositionAt
    || hasItems(root.annotations)
    || hasItems(root.annotationDrift)
    || hasItems(root.remarks)
    || hasItems(root.followUps)
    || children.some(item => ["idea", "record"].includes(item.type) && sourceOf(item) === "user" && contentOf(item).trim())
    || children.some(item => item.type === "answer"
      && !isUntouchedAiAnswer(item)
      && (contentOf(item).trim() || text(item.modelDraft).trim()))
  );
}

function chainRevision(root, children) {
  const block = item => [
    text(item?.id),
    text(item?.type),
    Number(item?.version) || 0,
    text(item?.createdAt),
    text(item?.updatedAt),
    text(item?.content),
    text(item?.modelDraft),
    Boolean(item?.editedFromModel),
    text(item?.authorType),
    text(item?.origin)
  ];
  const nested = values => (Array.isArray(values) ? values : []).map(item => [
    text(item?.id),
    Number(item?.version) || 0,
    text(item?.createdAt),
    text(item?.updatedAt),
    text(item?.question),
    text(item?.answer),
    text(item?.text)
  ]);
  const value = JSON.stringify({
    root: block(root),
    children: children.map(block).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
    remarks: nested(root.remarks),
    followUps: nested(root.followUps),
    annotations: nested(root.annotations),
    annotationDrift: nested(root.annotationDrift)
  });
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function latestActivityTime(root, children) {
  const values = [root, ...children].flatMap(item => [
    validTime(item?.updatedAt),
    validTime(item?.createdAt),
    validTime(item?.occurredAt)
  ]).filter(value => value != null);
  return values.length ? Math.max(...values) : 0;
}

function statusFor(root, children, nowMilliseconds) {
  const discovery = root.discovery && typeof root.discovery === "object" && !Array.isArray(root.discovery)
    ? root.discovery
    : {};
  const revision = chainRevision(root, children);
  const readAtMilliseconds = validTime(discovery.readAt);
  const read = discovery.seenRevision
    ? discovery.seenRevision === revision
    : readAtMilliseconds != null && readAtMilliseconds >= latestActivityTime(root, children);
  const snoozedUntilMilliseconds = validTime(discovery.snoozedUntil);
  const snoozed = snoozedUntilMilliseconds != null && snoozedUntilMilliseconds > nowMilliseconds;
  const untraced = children.some(isUntouchedAiAnswer) && !hasUserTrace(root, children);
  return {
    revision,
    version: recordVersion(discovery.version),
    read,
    readAt: readAtMilliseconds == null ? null : new Date(readAtMilliseconds).toISOString(),
    snoozed,
    snoozedUntil: snoozedUntilMilliseconds == null ? null : new Date(snoozedUntilMilliseconds).toISOString(),
    untraced,
    fresh: untraced && !read && !snoozed
  };
}

function projectContent(item, {
  query,
  genre,
  resourceType,
  resourceId,
  type,
  title = "",
  content = contentOf(item),
  tags = item?.tags,
  targetKey = "content",
  fallbackSource = "user"
}) {
  const source = sourceOf(item, fallbackSource);
  const queryKey = normalizedText(query);
  const normalizedTags = Array.isArray(tags) ? tags.slice() : [];
  const matchingTags = queryKey
    ? normalizedTags.filter(tag => normalizedText(tag).includes(queryKey))
    : [];
  return {
    id: text(item.id),
    resourceType,
    resourceId,
    targetKey,
    genre,
    type,
    title: text(title),
    content,
    tags: normalizedTags,
    occurredAt: text(item.occurredAt) || null,
    occurredOn: text(item.occurredOn) || null,
    createdAt: text(item.createdAt) || null,
    updatedAt: text(item.updatedAt) || null,
    source,
    sourceLabel: sourceLabel(source),
    sourceBoundary: sourceBoundary(source),
    match: queryKey ? {
      content: normalizedText(content).includes(queryKey),
      ...(title ? { title: normalizedText(title).includes(queryKey) } : {}),
      tags: matchingTags
    } : null
  };
}

function projectBlock(item, rootId, query) {
  return {
    ...projectContent(item, {
      query,
      genre: "thought",
      resourceType: "thought",
      resourceId: rootId,
      type: item.type,
      targetKey: `${item.type}:${item.id}`
    }),
    rootId
  };
}

function contentMatches({ content = "", title = "", tags = [] }, query) {
  const queryKey = normalizedText(query);
  if (!queryKey) return true;
  return normalizedText(content).includes(queryKey)
    || normalizedText(title).includes(queryKey)
    || tags.some(tag => normalizedText(tag).includes(queryKey));
}

function blockMatches(item, filters) {
  if (!filters.types.includes(item.type)) return false;
  return contentMatches({
    content: contentOf(item),
    tags: Array.isArray(item.tags) ? item.tags : []
  }, filters.query);
}

function rootSortTime(root) {
  return validTime(root.occurredAt) ?? validTime(root.createdAt) ?? 0;
}

function beforeCursor(candidate, cursor) {
  return candidate.sortTime < cursor.sortTime
    || (candidate.sortTime === cursor.sortTime && candidate.value.key < cursor.key);
}

function compareCandidates(left, right) {
  if (left.sortTime !== right.sortTime) return right.sortTime - left.sortTime;
  if (left.value.key === right.value.key) return 0;
  return left.value.key < right.value.key ? 1 : -1;
}

function filterSignature(filters) {
  return JSON.stringify([
    normalizedText(filters.query),
    filters.types,
    filters.genres,
    filters.freshOnly
  ]);
}

function encodeCursor(candidate, filters) {
  return Buffer.from(JSON.stringify({
    version: 2,
    sortTime: candidate.sortTime,
    key: candidate.value.key,
    filter: filterSignature(filters)
  }), "utf8").toString("base64url");
}

function decodeCursor(value, filters) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed?.version !== 2
      || !Number.isFinite(parsed.sortTime)
      || typeof parsed.key !== "string"
      || !parsed.key
      || parsed.filter !== filterSignature(filters)) return false;
    return parsed;
  } catch {
    return false;
  }
}

const routeFor = (view, resourceType, resourceId, targetKey = "") => ({
  view,
  resourceType,
  resourceId,
  ...(targetKey ? { targetKey } : {})
});

function candidateValue({ key, genre, id, title, matches, route, occurredAt, occurredOn, createdAt }) {
  const sources = [...new Set(matches.map(item => item.source))];
  return {
    key,
    id,
    resourceType: route.resourceType,
    resourceId: route.resourceId,
    genre,
    genreLabel: GENRE_LABELS[genre],
    title,
    matches,
    matchCount: matches.length,
    occurredAt: occurredAt || null,
    occurredOn: occurredOn || null,
    createdAt: createdAt || null,
    source: sources.length === 1 ? sources[0] : "mixed",
    sourceLabel: sources.map(sourceLabel).join(" · "),
    sourceBoundary: sources.length === 1 ? sourceBoundary(sources[0]) : "mixed",
    route
  };
}

function thoughtCandidatesFor(thoughts, filters, nowMilliseconds) {
  const roots = thoughts.filter(item => item?.type === "question" && typeof item.id === "string" && item.id);
  const children = new Map(roots.map(root => [root.id, []]));
  for (const item of thoughts) {
    if (item?.type !== "question" && children.has(item?.relatedTo)) children.get(item.relatedTo).push(item);
  }
  return roots.map(root => {
    const chainChildren = children.get(root.id);
    const blocks = [root, ...chainChildren];
    const matches = blocks.filter(item => blockMatches(item, filters))
      .map(item => projectBlock(item, root.id, filters.query));
    if (!matches.length) return null;
    const status = statusFor(root, chainChildren, nowMilliseconds);
    if (filters.freshOnly && !status.fresh) return null;
    const question = projectBlock(root, root.id, "");
    const { revision, ...publicStatus } = status;
    const key = `thought:${root.id}`;
    return {
      sortTime: rootSortTime(root),
      revision,
      value: {
        ...candidateValue({
          key,
          genre: "thought",
          id: root.id,
          title: question.content,
          matches,
          route: routeFor("thoughts", "thought", root.id, `question:${root.id}`),
          occurredAt: question.occurredAt,
          occurredOn: question.occurredOn,
          createdAt: question.createdAt
        }),
        rootId: root.id,
        question,
        status: publicStatus,
        untraced: status.untraced,
        fresh: status.fresh
      }
    };
  }).filter(Boolean);
}

function captureCandidatesFor(document, filters) {
  return collectionOf(document, "captures").map(item => {
    const tags = Array.isArray(item?.tags) ? item.tags : [];
    if (!item?.id || !contentMatches({ content: contentOf(item), tags }, filters.query)) return null;
    const match = projectContent(item, {
      query: filters.query,
      genre: "capture",
      resourceType: "capture",
      resourceId: item.id,
      type: "capture",
      tags
    });
    return {
      sortTime: rootSortTime(item),
      value: candidateValue({
        key: `capture:${item.id}`,
        genre: "capture",
        id: item.id,
        title: contentOf(item),
        matches: [match],
        route: routeFor("captures", "capture", item.id, "content"),
        occurredAt: match.occurredAt,
        occurredOn: match.occurredOn,
        createdAt: match.createdAt
      })
    };
  }).filter(Boolean);
}

function journalCandidatesFor(document, filters) {
  return collectionOf(document, "journals").map(item => {
    if (!item?.id) return null;
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const matches = [];
    if (contentMatches({ content: contentOf(item), title: text(item.title), tags }, filters.query)) {
      matches.push(projectContent(item, {
        query: filters.query,
        genre: "journal",
        resourceType: "journal",
        resourceId: item.id,
        type: "journal",
        title: item.title,
        tags
      }));
    }
    for (const reflection of Array.isArray(item.reflections) ? item.reflections : []) {
      const reflectionTags = Array.isArray(reflection.tags) ? reflection.tags : [];
      if (!contentMatches({ content: contentOf(reflection), tags: reflectionTags }, filters.query)) continue;
      matches.push(projectContent(reflection, {
        query: filters.query,
        genre: "journal",
        resourceType: "journal",
        resourceId: item.id,
        type: "reflection",
        title: item.title,
        tags: reflectionTags,
        targetKey: `reflection:${reflection.id}`,
        fallbackSource: "ai"
      }));
    }
    if (!matches.length) return null;
    const first = matches[0];
    return {
      sortTime: latestActivityTime(item, matches),
      value: candidateValue({
        key: `journal:${item.id}`,
        genre: "journal",
        id: item.id,
        title: text(item.title) || contentOf(item),
        matches,
        route: routeFor("journals", "journal", item.id, first.targetKey),
        occurredAt: text(item.occurredAt) || first.occurredAt,
        occurredOn: text(item.occurredOn) || first.occurredOn,
        createdAt: text(item.createdAt) || first.createdAt
      })
    };
  }).filter(Boolean);
}

function bookExcerptCandidatesFor(document, filters) {
  return collectionOf(document, "books").map(book => {
    if (!book?.id) return null;
    const bookTags = Array.isArray(book.tags) ? book.tags : [];
    const matches = (Array.isArray(book.notes) ? book.notes : []).flatMap(note => {
      const tags = [...new Set([...bookTags, ...(Array.isArray(note.tags) ? note.tags : [])])];
      if (!contentMatches({ content: contentOf(note), title: text(book.title), tags }, filters.query)) return [];
      return [projectContent(note, {
        query: filters.query,
        genre: "bookExcerpt",
        resourceType: "book",
        resourceId: book.id,
        type: "bookExcerpt",
        title: book.title,
        tags,
        targetKey: `note:${note.id}`
      })];
    });
    if (!matches.length) return null;
    const first = matches[0];
    return {
      sortTime: latestActivityTime(book, matches),
      value: candidateValue({
        key: `bookExcerpt:${book.id}`,
        genre: "bookExcerpt",
        id: book.id,
        title: text(book.title),
        matches,
        route: routeFor("books", "book", book.id, first.targetKey),
        occurredAt: first.occurredAt || text(book.occurredAt),
        occurredOn: first.occurredOn || text(book.occurredOn),
        createdAt: text(book.createdAt) || first.createdAt
      })
    };
  }).filter(Boolean);
}

function quoteCandidatesFor(document, filters) {
  return collectionOf(document, "quotes").map(item => {
    const tags = Array.isArray(item?.tags) ? item.tags : [];
    if (!item?.id || !contentMatches({
      content: contentOf(item),
      title: text(item.source),
      tags
    }, filters.query)) return null;
    const match = projectContent(item, {
      query: filters.query,
      genre: "quote",
      resourceType: "quote",
      resourceId: item.id,
      type: "quote",
      title: item.source,
      tags
    });
    return {
      sortTime: rootSortTime(item),
      value: candidateValue({
        key: `quote:${item.id}`,
        genre: "quote",
        id: item.id,
        title: text(item.source) || contentOf(item),
        matches: [match],
        route: routeFor("quotes", "quote", item.id, "content"),
        occurredAt: match.occurredAt,
        occurredOn: match.occurredOn,
        createdAt: match.createdAt
      })
    };
  }).filter(Boolean);
}

function candidatesFor(document, filters, nowMilliseconds) {
  const candidates = [];
  if (filters.genres.includes("thought")) {
    candidates.push(...thoughtCandidatesFor(thoughtsOf(document), filters, nowMilliseconds));
  }
  if (!filters.freshOnly && !Array.isArray(document)) {
    if (filters.genres.includes("capture")) candidates.push(...captureCandidatesFor(document, filters));
    if (filters.genres.includes("journal")) candidates.push(...journalCandidatesFor(document, filters));
    if (filters.genres.includes("bookExcerpt")) candidates.push(...bookExcerptCandidatesFor(document, filters));
    if (filters.genres.includes("quote")) candidates.push(...quoteCandidatesFor(document, filters));
  }
  return candidates.sort(compareCandidates);
}

function nowValue(now) {
  const value = now();
  const milliseconds = validTime(value);
  if (milliseconds == null) throw new TypeError("Discovery clock must return a valid date");
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

export function createThoughtDiscoveryService({
  repository,
  now = () => new Date().toISOString(),
  random = Math.random
}) {
  if (!repository || typeof repository.read !== "function" || typeof repository.update !== "function") {
    throw new TypeError("Discovery repository must provide read and update");
  }

  const readCandidates = async filters => {
    const parsed = normalizeThoughtDiscoveryFilters(filters);
    if (parsed.error) return parsed;
    const clock = nowValue(now);
    const document = await repository.read();
    return {
      filters: parsed,
      candidates: candidatesFor(document, parsed, clock.milliseconds)
    };
  };

  async function search(input = {}) {
    const result = await readCandidates(input);
    if (result.error) return result;
    const cursor = decodeCursor(result.filters.cursor, result.filters);
    if (cursor === false) return { invalidCursor: true };
    const eligible = cursor
      ? result.candidates.filter(candidate => beforeCursor(candidate, cursor))
      : result.candidates;
    const selected = eligible.slice(0, result.filters.limit);
    const hasMore = eligible.length > selected.length;
    return {
      items: selected.map(candidate => candidate.value),
      nextCursor: hasMore ? encodeCursor(selected.at(-1), result.filters) : "",
      total: result.candidates.length,
      untracedCount: result.candidates.filter(candidate => candidate.value.fresh).length,
      totalUntracedCount: result.candidates.filter(candidate => candidate.value.untraced).length
    };
  }

  async function countUntraced(input = {}) {
    const result = await readCandidates({ ...input, cursor: "", limit: MAX_LIMIT });
    if (result.error) return result;
    return result.candidates.filter(candidate => candidate.value.fresh).length;
  }

  async function mutateStatus(id, mutation, { expectedVersion = null, clock = nowValue(now) } = {}) {
    return repository.update(document => {
      const thoughts = thoughtsOf(document);
      const root = thoughts.find(item => item?.id === id && item.type === "question");
      if (!root) return { missing: true };
      const children = thoughts.filter(item => item?.relatedTo === root.id && item.type !== "question");
      const discovery = root.discovery && typeof root.discovery === "object" && !Array.isArray(root.discovery)
        ? { ...root.discovery }
        : {};
      const currentVersion = recordVersion(discovery.version);
      if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
        return { versionConflict: true, currentVersion };
      }
      mutation(discovery, root, children, clock);
      discovery.version = currentVersion + 1;
      discovery.updatedAt = clock.iso;
      root.discovery = discovery;
      const { revision, ...status } = statusFor(root, children, clock.milliseconds);
      return { value: { id: root.id, status, untraced: status.untraced, fresh: status.fresh } };
    });
  }

  const markRead = (id, options = {}) => mutateStatus(id, (discovery, root, children, clock) => {
    discovery.readAt = clock.iso;
    discovery.seenRevision = chainRevision(root, children);
  }, options);

  function snooze(id, until, options = {}) {
    const untilMilliseconds = validTime(until);
    const clock = nowValue(now);
    if (untilMilliseconds == null || untilMilliseconds <= clock.milliseconds) {
      return Promise.resolve({
        error: "免打扰时间必须是晚于当前时间的有效时间",
        code: "INVALID_SNOOZE_UNTIL"
      });
    }
    const normalizedUntil = new Date(untilMilliseconds).toISOString();
    return mutateStatus(id, discovery => {
      discovery.snoozedUntil = normalizedUntil;
    }, { ...options, clock });
  }

  const clearSnooze = (id, options = {}) => mutateStatus(id, discovery => {
    delete discovery.snoozedUntil;
  }, options);

  async function openRandomDoor(input = {}, options = {}) {
    const result = await readCandidates({ ...input, cursor: "", limit: MAX_LIMIT });
    if (result.error) return result;
    if (!result.candidates.length) return { value: null, total: 0 };
    const randomSource = typeof options === "function"
      ? options
      : typeof options.random === "function"
        ? options.random
        : random;
    if (typeof randomSource !== "function") throw new TypeError("Discovery random source must be a function");
    const sample = Number(randomSource());
    const ratio = Number.isFinite(sample) ? Math.max(0, Math.min(sample, 1)) : 0;
    const index = Math.min(result.candidates.length - 1, Math.floor(ratio * result.candidates.length));
    return {
      value: result.candidates[index].value,
      index,
      total: result.candidates.length
    };
  }

  return Object.freeze({
    search,
    countUntraced,
    markRead,
    snooze,
    clearSnooze,
    openRandomDoor,
    randomDoor: openRandomDoor
  });
}

export const createThoughtDiscovery = createThoughtDiscoveryService;
