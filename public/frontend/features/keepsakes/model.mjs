export const KEEPSAKE_PAGE_SIZE = 12;
export const KEEPSAKE_PREFETCH_MARGIN_PX = 160;
export const KEEPSAKE_BATCH_DRAFT_KEY = "keepsake-batch";

export const normalizeKeepsakeSearch = value => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase("zh-CN")
  .replace(/\s+/g, " ")
  .trim();

function searchableText(values) {
  const parts = [];
  const append = value => {
    if (value == null) return;
    if (Array.isArray(value)) return value.forEach(append);
    if (typeof value === "object") return Object.values(value).forEach(append);
    parts.push(String(value));
  };
  values.forEach(append);
  return normalizeKeepsakeSearch(parts.join(" "));
}

export function keepsakeMatchesSearch(item, query) {
  const normalized = normalizeKeepsakeSearch(query);
  if (!normalized) return true;
  const text = searchableText([item?.title, item?.tags, item?.note]);
  return normalized.split(" ").every(term => text.includes(term));
}

export function sortedKeepsakes(items, eventTimestamp) {
  return [...(items || [])].sort((left, right) => (
    String(eventTimestamp(right) || "").localeCompare(String(eventTimestamp(left) || ""))
  ));
}

export function uniqueKeepsakeTags(values, limit = 8) {
  const tags = [];
  const seen = new Set();
  for (const value of values || []) {
    const tag = String(value || "").trim();
    const key = tag.toLocaleLowerCase("zh-CN");
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === limit) break;
  }
  return tags;
}

export function keepsakeBatchStatus(item, index, activeIndex) {
  if (item?.status === "saving") return "正在保存";
  if (item?.status === "uploading") return "正在上传";
  if (item?.status === "failed") return item.lastError?.message || "失败，可重试";
  if (item?.alphaMask) return "已编辑，待保存";
  return index === activeIndex ? "正在编辑" : "待编辑";
}

export function keepsakeDerivativeLabel(item) {
  if (item?.derivativeState === "pending") return "正在生成清晰图";
  if (item?.derivativeState === "failed") return "清晰图待重试";
  return "";
}

export function createKeepsakeFeatureState() {
  return {
    activation: null,
    surface: null,
    session: {},
    generation: 0,
    accountId: "",
    searchQuery: "",
    activeId: "",
    activeView: "presentation",
    activeOriginalPath: "",
    selectedTags: [],
    visibleCount: KEEPSAKE_PAGE_SIZE,
    paginationOwner: "",
    editor: {
      file: null,
      sourceDataUrl: "",
      sourceImage: null,
      sourceCanvas: null,
      maskCanvas: null,
      autoBase: null,
      history: [],
      mode: "keep",
      drawing: false,
      lastPoint: null,
      source: "manual",
      originalPath: "",
      cutoutPath: "",
      mediaDirty: false,
      renderFrame: 0,
      segmentGeneration: 0,
      understandingGeneration: 0
    },
    batch: {
      generation: 0,
      owner: "",
      items: [],
      activeIndex: 0,
      loading: false,
      previewUrls: []
    }
  };
}

export function clearKeepsakeAccountState(state) {
  state.accountId = "";
  state.activeId = "";
  state.activeView = "presentation";
  state.activeOriginalPath = "";
  state.selectedTags = [];
  state.visibleCount = KEEPSAKE_PAGE_SIZE;
  state.paginationOwner = "";
  state.batch.generation += 1;
  state.batch.owner = "";
  state.batch.items = [];
  state.batch.activeIndex = 0;
  state.batch.loading = false;
}
