export const THOUGHT_DISCOVERY_TYPES = Object.freeze(["question", "idea", "answer", "record"]);
export const DISCOVERY_GENRES = Object.freeze(["thought", "capture", "journal", "bookExcerpt", "quote"]);

const TYPE_SET = new Set(THOUGHT_DISCOVERY_TYPES);
const GENRE_SET = new Set(DISCOVERY_GENRES);
const DEFAULT_FILTERS = Object.freeze({
  query: "",
  types: THOUGHT_DISCOVERY_TYPES,
  genres: ["thought"],
  freshOnly: false
});

function normalizeTypes(value) {
  if (value == null) return THOUGHT_DISCOVERY_TYPES.slice();
  if (!Array.isArray(value) || value.some(type => !TYPE_SET.has(type))) {
    throw new TypeError("Unknown thought discovery type");
  }
  const selected = new Set(value);
  return THOUGHT_DISCOVERY_TYPES.filter(type => selected.has(type));
}

function normalizeGenres(value) {
  if (value == null) return ["thought"];
  if (!Array.isArray(value) || value.some(genre => !GENRE_SET.has(genre))) {
    throw new TypeError("Unknown discovery genre");
  }
  const selected = new Set(value);
  return DISCOVERY_GENRES.filter(genre => selected.has(genre));
}

export function normalizeThoughtDiscoveryFilters(input = {}) {
  return {
    query: typeof input.query === "string" ? input.query.trim().normalize("NFKC") : "",
    types: normalizeTypes(input.types),
    genres: normalizeGenres(input.genres),
    freshOnly: input.freshOnly === true
  };
}

function responseError(result, fallback) {
  if (!result?.error) return null;
  const message = typeof result.error === "string" ? result.error : result.error.message;
  return Object.assign(new Error(message || fallback), {
    code: result.code || result.error.code || "THOUGHT_DISCOVERY_FAILED"
  });
}

export function createThoughtDiscoveryController({
  transport,
  onNavigate = () => {}
}) {
  for (const method of ["search", "markRead", "snooze", "openRandomDoor"]) {
    if (typeof transport?.[method] !== "function") {
      throw new TypeError(`Thought discovery transport must provide ${method}`);
    }
  }

  let state = {
    filters: normalizeThoughtDiscoveryFilters(DEFAULT_FILTERS),
    items: [],
    nextCursor: "",
    total: 0,
    untracedCount: 0,
    totalUntracedCount: 0,
    loading: false,
    loadingMore: false,
    error: null
  };
  let epoch = 0;
  const listeners = new Set();

  const snapshot = () => ({
    ...state,
    filters: {
      ...state.filters,
      types: state.filters.types.slice(),
      genres: state.filters.genres.slice()
    },
    items: state.items.slice()
  });
  const publish = () => {
    const value = snapshot();
    for (const listener of listeners) listener(value);
  };
  const replace = changes => {
    state = { ...state, ...changes };
    publish();
  };
  const fail = (error, ticket) => {
    if (ticket !== epoch) return false;
    replace({
      loading: false,
      loadingMore: false,
      error: error?.message || "思绪检索失败"
    });
    throw error;
  };
  const filtersForRequest = () => ({
    query: state.filters.query,
    types: state.filters.types.slice(),
    genres: state.filters.genres.slice(),
    freshOnly: state.filters.freshOnly
  });

  async function refresh() {
    const ticket = ++epoch;
    const filters = filtersForRequest();
    replace({ loading: true, loadingMore: false, error: null });
    try {
      const result = await transport.search({ ...filters, cursor: "" });
      if (ticket !== epoch) return false;
      const error = responseError(result, "思绪检索失败");
      if (error) throw error;
      if (result?.invalidCursor) throw new Error("思绪检索游标无效");
      replace({
        items: Array.isArray(result?.items) ? result.items.slice() : [],
        nextCursor: result?.nextCursor || "",
        total: Number(result?.total) || 0,
        untracedCount: Number(result?.untracedCount) || 0,
        totalUntracedCount: Number(result?.totalUntracedCount) || 0,
        loading: false,
        error: null
      });
      return true;
    } catch (error) {
      return fail(error, ticket);
    }
  }

  async function loadMore() {
    if (!state.nextCursor || state.loading || state.loadingMore) return false;
    const ticket = epoch;
    const cursor = state.nextCursor;
    const filters = filtersForRequest();
    replace({ loadingMore: true, error: null });
    try {
      const result = await transport.search({ ...filters, cursor });
      if (ticket !== epoch || cursor !== state.nextCursor) return false;
      const error = responseError(result, "继续加载思绪失败");
      if (error) throw error;
      if (result?.invalidCursor) throw new Error("思绪检索游标无效");
      const itemKey = item => item?.key || `${item?.genre || "thought"}:${item?.id || ""}`;
      const known = new Set(state.items.map(itemKey));
      const additions = (Array.isArray(result?.items) ? result.items : []).filter(item => !known.has(itemKey(item)));
      replace({
        items: [...state.items, ...additions],
        nextCursor: result?.nextCursor || "",
        total: Number(result?.total) || state.total,
        untracedCount: Number.isFinite(Number(result?.untracedCount))
          ? Number(result.untracedCount)
          : state.untracedCount,
        totalUntracedCount: Number.isFinite(Number(result?.totalUntracedCount))
          ? Number(result.totalUntracedCount)
          : state.totalUntracedCount,
        loadingMore: false,
        error: null
      });
      return true;
    } catch (error) {
      return fail(error, ticket);
    }
  }

  function setFilters(changes, { reload = true } = {}) {
    const next = normalizeThoughtDiscoveryFilters({ ...state.filters, ...changes });
    const changed = next.query !== state.filters.query
      || next.freshOnly !== state.filters.freshOnly
      || next.types.join("\u0000") !== state.filters.types.join("\u0000")
      || next.genres.join("\u0000") !== state.filters.genres.join("\u0000");
    if (!changed) return reload ? refresh() : Promise.resolve(false);
    epoch += 1;
    replace({
      filters: next,
      items: [],
      nextCursor: "",
      total: 0,
      untracedCount: 0,
      totalUntracedCount: 0,
      loading: false,
      loadingMore: false,
      error: null
    });
    return reload ? refresh() : Promise.resolve(true);
  }

  function applyStatus(id, value) {
    const isThought = item => (item.genre || "thought") === "thought" && item.id === id;
    const current = state.items.find(isThought);
    if (!current || !value?.status) return;
    const wasFresh = Boolean(current.fresh);
    const wasUntraced = Boolean(current.untraced);
    const fresh = Boolean(value.fresh);
    const untraced = Boolean(value.untraced);
    const leavesFreshFilter = state.filters.freshOnly && wasFresh && !fresh;
    replace({
      items: state.items.map(item => isThought(item) ? {
        ...item,
        status: { ...item.status, ...value.status },
        untraced,
        fresh
      } : item).filter(item => !leavesFreshFilter || !isThought(item)),
      total: leavesFreshFilter ? Math.max(0, state.total - 1) : state.total,
      untracedCount: Math.max(0, state.untracedCount + Number(fresh) - Number(wasFresh)),
      totalUntracedCount: Math.max(0, state.totalUntracedCount + Number(untraced) - Number(wasUntraced))
    });
  }

  async function updateStatus(id, operation) {
    const ticket = epoch;
    try {
      const result = await operation();
      if (ticket !== epoch) return false;
      const error = responseError(result, "更新思绪回访状态失败");
      if (error) throw error;
      if (result?.missing) throw new Error("这条思绪不存在");
      applyStatus(id, result?.value);
      return true;
    } catch (error) {
      return fail(error, ticket);
    }
  }

  const markRead = id => updateStatus(id, () => transport.markRead(id));
  const snooze = (id, until) => updateStatus(id, () => transport.snooze(id, until));

  async function openRandomDoor() {
    const ticket = epoch;
    try {
      const result = await transport.openRandomDoor(filtersForRequest());
      if (ticket !== epoch) return null;
      const error = responseError(result, "任意门暂时无法打开");
      if (error) throw error;
      const value = result?.value || null;
      if (value) onNavigate(value);
      return value;
    } catch (error) {
      return fail(error, ticket);
    }
  }

  function reset(filters = DEFAULT_FILTERS) {
    epoch += 1;
    state = {
      filters: normalizeThoughtDiscoveryFilters(filters),
      items: [],
      nextCursor: "",
      total: 0,
      untracedCount: 0,
      totalUntracedCount: 0,
      loading: false,
      loadingMore: false,
      error: null
    };
    publish();
  }

  return Object.freeze({
    getState: snapshot,
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("Subscriber must be a function");
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    refresh,
    loadMore,
    setFilters,
    setQuery: (query, options) => setFilters({ query }, options),
    setTypes: (types, options) => setFilters({ types }, options),
    setGenres: (genres, options) => setFilters({ genres }, options),
    setFreshOnly: (freshOnly, options) => setFilters({ freshOnly }, options),
    markRead,
    snooze,
    openRandomDoor,
    reset
  });
}

export {
  backgroundResultFromSnapshot,
  backgroundTaskTarget,
  createBackgroundResultController,
  mergeBackgroundTaskResult
} from "./background-results.mjs";
export {
  annotationMenuItems,
  annotationPresentation,
  copyAnnotationContent,
  sortAnnotationItemsByPosition
} from "./annotation-tools.mjs";
