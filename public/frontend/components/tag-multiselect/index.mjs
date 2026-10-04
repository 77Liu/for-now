const DEFAULT_MAX_SELECTED = 8;
const DEFAULT_MAX_TAG_LENGTH = 30;
const TAG_PREFIX = /^[#＃]+\s*/u;

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function normalizeTag(value, { maxLength = DEFAULT_MAX_TAG_LENGTH } = {}) {
  const limit = positiveInteger(maxLength, DEFAULT_MAX_TAG_LENGTH);
  return String(value ?? "")
    .trim()
    .replace(TAG_PREFIX, "")
    .replace(/\s+/gu, " ")
    .slice(0, limit)
    .trim();
}

const tagKey = (value, maxLength = DEFAULT_MAX_TAG_LENGTH) => (
  normalizeTag(value, { maxLength }).normalize("NFKC").toLocaleLowerCase("zh-CN")
);

export function normalizeTagList(values, {
  maxLength = DEFAULT_MAX_TAG_LENGTH,
  limit = Number.POSITIVE_INFINITY
} = {}) {
  const tags = [];
  const seen = new Set();
  const source = Array.isArray(values) ? values : [values];
  const normalizedLimit = Number.isFinite(Number(limit))
    ? Math.max(0, Math.floor(Number(limit)))
    : Number.POSITIVE_INFINITY;
  if (normalizedLimit === 0) return tags;
  for (const value of source) {
    const tag = normalizeTag(value, { maxLength });
    const key = tagKey(tag, maxLength);
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= normalizedLimit) break;
  }
  return tags;
}

function buildState({
  candidates = [],
  selected = [],
  input = "",
  maxSelected = DEFAULT_MAX_SELECTED,
  maxTagLength = DEFAULT_MAX_TAG_LENGTH
}, { activeIndex } = {}) {
  const selectedLimit = positiveInteger(maxSelected, DEFAULT_MAX_SELECTED);
  const tagLengthLimit = positiveInteger(maxTagLength, DEFAULT_MAX_TAG_LENGTH);
  const knownCandidates = normalizeTagList(candidates, { maxLength: tagLengthLimit });
  const knownByKey = new Map(knownCandidates.map(tag => [tagKey(tag, tagLengthLimit), tag]));
  const selectedTags = normalizeTagList(selected, {
    maxLength: tagLengthLimit,
    limit: selectedLimit
  }).map(tag => knownByKey.get(tagKey(tag, tagLengthLimit)) || tag);
  const normalizedCandidates = normalizeTagList([...knownCandidates, ...selectedTags], {
    maxLength: tagLengthLimit
  });
  const selectedKeys = new Set(selectedTags.map(tag => tagKey(tag, tagLengthLimit)));
  const rawInput = String(input ?? "");
  const query = normalizeTag(rawInput, { maxLength: tagLengthLimit });
  const queryKey = tagKey(query, tagLengthLimit);
  const atLimit = selectedTags.length >= selectedLimit;
  const available = normalizedCandidates.filter(tag => (
    !selectedKeys.has(tagKey(tag, tagLengthLimit))
    && (!queryKey || tagKey(tag, tagLengthLimit).includes(queryKey))
  ));
  const knownKeys = new Set(normalizedCandidates.map(tag => tagKey(tag, tagLengthLimit)));
  const canCreate = Boolean(queryKey)
    && !atLimit
    && !knownKeys.has(queryKey)
    && !selectedKeys.has(queryKey);
  const options = atLimit
    ? []
    : [
        ...available.map(value => ({ type: "candidate", value })),
        ...(canCreate ? [{ type: "create", value: query }] : [])
      ];
  const defaultActiveIndex = queryKey && options.length ? 0 : -1;
  const resolvedActiveIndex = Number.isInteger(activeIndex)
    && activeIndex >= 0
    && activeIndex < options.length
    ? activeIndex
    : defaultActiveIndex;

  return {
    candidates: normalizedCandidates,
    selected: selectedTags,
    input: rawInput,
    query,
    options,
    activeIndex: resolvedActiveIndex,
    activeOption: options[resolvedActiveIndex] || null,
    canCreate,
    atLimit,
    maxSelected: selectedLimit,
    maxTagLength: tagLengthLimit
  };
}

export function createTagMultiSelectState(options = {}) {
  return buildState(options);
}

function selectTag(state, value) {
  const tag = normalizeTag(value, { maxLength: state.maxTagLength });
  if (!tag || state.atLimit) return state;
  const key = tagKey(tag, state.maxTagLength);
  if (state.selected.some(item => tagKey(item, state.maxTagLength) === key)) {
    return buildState({ ...state, input: "" });
  }
  const known = state.candidates.find(item => tagKey(item, state.maxTagLength) === key) || tag;
  return buildState({
    ...state,
    candidates: [...state.candidates, known],
    selected: [...state.selected, known],
    input: ""
  });
}

function removeTag(state, value) {
  const key = tagKey(value, state.maxTagLength);
  if (!key) return state;
  const selected = state.selected.filter(tag => tagKey(tag, state.maxTagLength) !== key);
  return selected.length === state.selected.length ? state : buildState({ ...state, selected });
}

function moveActiveOption(state, direction) {
  if (!state.options.length) return state;
  const step = direction < 0 ? -1 : 1;
  const activeIndex = state.activeIndex < 0
    ? step > 0 ? 0 : state.options.length - 1
    : (state.activeIndex + step + state.options.length) % state.options.length;
  return {
    ...state,
    activeIndex,
    activeOption: state.options[activeIndex]
  };
}

export function reduceTagMultiSelectState(state, action = {}) {
  if (!state || typeof state !== "object") {
    throw new TypeError("Tag multi-select state is required");
  }
  switch (action.type) {
    case "input":
      return buildState({ ...state, input: action.value });
    case "select":
      return selectTag(state, action.value);
    case "remove":
      return removeTag(state, action.value);
    case "commit":
      if (state.activeOption) return selectTag(state, state.activeOption.value);
      return state.query ? selectTag(state, state.query) : buildState({ ...state, input: "" });
    case "move":
      return moveActiveOption(state, Number(action.direction) || 1);
    case "clear-input":
      return buildState({ ...state, input: "" });
    case "set-candidates":
      return buildState({ ...state, candidates: action.values });
    case "set-selected":
      return buildState({ ...state, selected: action.values });
    default:
      throw new TypeError(`Unsupported tag multi-select action: ${String(action.type || "")}`);
  }
}

export function handleTagMultiSelectKey(state, event = {}) {
  if (event.isComposing) return { state, handled: false, intent: "none" };
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const nextState = reduceTagMultiSelectState(state, {
      type: "move",
      direction: event.key === "ArrowDown" ? 1 : -1
    });
    return {
      state: nextState,
      handled: state.options.length > 0,
      intent: state.options.length ? "move" : "none"
    };
  }
  if ((event.key === "Home" || event.key === "End") && state.options.length) {
    const activeIndex = event.key === "Home" ? 0 : state.options.length - 1;
    return {
      state: {
        ...state,
        activeIndex,
        activeOption: state.options[activeIndex]
      },
      handled: true,
      intent: "move"
    };
  }
  if (event.key === "Enter") {
    const option = state.activeOption;
    return {
      state: reduceTagMultiSelectState(state, { type: "commit" }),
      handled: true,
      intent: option?.type === "create" ? "create" : option ? "select" : "none"
    };
  }
  if (event.key === "Backspace" && !state.query && state.selected.length) {
    return {
      state: removeTag(state, state.selected.at(-1)),
      handled: true,
      intent: "remove"
    };
  }
  if (event.key === "Escape" && (state.input || state.activeIndex >= 0)) {
    return {
      state: reduceTagMultiSelectState(state, { type: "clear-input" }),
      handled: true,
      intent: "clear"
    };
  }
  return { state, handled: false, intent: "none" };
}
