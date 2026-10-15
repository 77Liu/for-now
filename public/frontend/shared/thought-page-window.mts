/**
 * 思绪相邻分页窗口、位置检查点与当前页面阅读恢复资格。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：不保存完整历史或正文副本；请求归属及页面生命周期由调用者复验。
 */
type Summary = { id: string; [key: string]: unknown };
type Page = {
  requestCursor: string;
  direction: string;
  nextCursor: string;
  prevCursor: string;
  items: Summary[];
};
type PageBoundary = { requestCursor: string; nextCursor: string; prevCursor: string; count: number };
type Meta = {
  requestCursor?: string;
  direction?: string;
  nextCursor?: string;
  prevCursor?: string;
  pages?: PageBoundary[];
};
type Limits = { pageSize: number; maxPages: number; maxCheckpoints: number };
/** 当前账户与路由内连续相邻页；过期窗口禁止追加。 @since unreleased */
export type ThoughtWindow = {
  pages: Page[];
  ownerKey: string;
  routeKey: string;
  generation: number;
  stale: boolean;
};

/** 从服务端单页或有限旧前缀建立窗口，边界只采用服务端opaque cursor。 @since unreleased */
export function seedThoughtWindow(items: Summary[], meta: Meta, ownerKey: string, routeKey: string, limits: Limits): ThoughtWindow {
  let offset = 0;
  const pages: Page[] = meta.pages?.map(page => {
    const current = {
      ...page,
      requestCursor: page.requestCursor || "",
      direction: "next",
      items: items.slice(offset, offset + page.count)
    };
    offset += page.count;
    return current;
  }) || [{
    requestCursor: meta.requestCursor || "",
    direction: meta.direction || "next",
    nextCursor: meta.nextCursor || "",
    prevCursor: meta.prevCursor || "",
    items: items.slice()
  }];
  if (pages.length > limits.maxPages || pages.some(page => page.items.length > limits.pageSize)) {
    throw new Error("分页响应超过窗口容量，请刷新");
  }
  return { pages, ownerKey, routeKey, generation: 0, stale: false };
}

/** 同步发布相邻页并只淘汰远端边缘；失败不修改旧窗口。 @since unreleased */
export function extendThoughtWindow(window: ThoughtWindow, page: Page, direction: string, limits: Limits): ThoughtWindow {
  if (window.stale) throw new Error("内容已变化，请刷新后继续");
  if (page.items.length > limits.pageSize) throw new Error("分页响应过大，请刷新");
  const cursor = direction === "prev" ? page.prevCursor : page.nextCursor;
  if (cursor && cursor === page.requestCursor) throw new Error("分页游标没有前进，请刷新后继续");
  const known = new Set(window.pages.flatMap(current => current.items.map(item => item.id)));
  const incoming = { ...page, items: page.items.filter(item => !known.has(item.id)) };
  const pages = direction === "prev" ? [incoming, ...window.pages] : [...window.pages, incoming];
  while (pages.length > limits.maxPages) {
    if (direction === "prev") pages.pop();
    else pages.shift();
  }
  return { ...window, pages };
}

/** 扁平摘要与实际边缘游标；不把容量当作历史结束标记。 @since unreleased */
export function thoughtWindowProjection(window: ThoughtWindow) {
  return {
    items: window.pages.flatMap(page => page.items),
    prevCursor: window.pages[0]?.prevCursor || "",
    nextCursor: window.pages.at(-1)?.nextCursor || ""
  };
}

/** 最多保留指定数量的位置记录；不接受正文或摘要缓存。 @since unreleased */
export function saveThoughtCheckpoint(
  storage: Storage | undefined,
  owner: string,
  key: string,
  position: { cursor: string; direction: string; anchorId: string; offset: number },
  limit: number
) {
  if (!storage) return;
  const name = `for-now:thought-positions:${owner}`;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(name) || "[]");
    const previous = Array.isArray(parsed)
      ? parsed.filter(value => value && typeof value === "object" && value.key !== key)
      : [];
    storage.setItem(name, JSON.stringify([...previous, { key, ...position }].slice(-limit)));
  } catch {
    // URL仍可重建，位置缓存失败不改变读取结果。
  }
}

/** 清理账户位置缓存；退出后的旧位置不得进入新账户。 @since unreleased */
export function clearThoughtCheckpoints(storage: Storage | undefined, owner: string) {
  try {
    storage?.removeItem(`for-now:thought-positions:${owner}`);
  } catch {
    // 受限存储不阻止退出或清理内存。
  }
}

/** 仅返回当前账户同路由位置，缺失或损坏时由页首恢复。 @since unreleased */
export function readThoughtCheckpoint(storage: Storage | undefined, owner: string, key: string) {
  try {
    const values = JSON.parse(storage?.getItem(`for-now:thought-positions:${owner}`) || "[]");
    const candidate = Array.isArray(values) ? values.find(value => value?.key === key) : null;
    return candidate && typeof candidate.anchorId === "string" && Number.isFinite(candidate.offset) ? candidate : null;
  } catch {
    return null;
  }
}

/** 将既有待同步呈现收敛为摘要；预览语义必须由领域selector提供，原文由既有队列/草稿负责。 @since unreleased */
export function summarizeThoughtWindowItems(
  items: Summary[],
  limits: Limits & { questionPreviewLimit: number; userPreviewLimit: number },
  selectPreview: (blocks: Summary[], previous: unknown) => { kind: string; text: string } | null
) {
  const seen = new Set<string>();
  return items.filter(item => {
    if (item.type !== "question" || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, limits.pageSize * limits.maxPages).map(item => {
    const {
      attachmentPaths, remarks: _remarks, followUps: _followUps,
      modelDraft: _modelDraft, modelReasoning: _modelReasoning,
      reasoningContent: _reasoning, ...root
    } = item;
    const blocks = items.filter(child => child.relatedTo === item.id);
    const preview = selectPreview(blocks, item.preview);
    const content = String(item.content || "");
    const previousPreview = item.preview as { truncated?: boolean } | null;
    const tags = [...new Set([...(Array.isArray(item.tags) ? item.tags : []), ...blocks.flatMap(block => Array.isArray(block.tags) ? block.tags : [])])].slice(0, 8);
    return {
      ...root,
      tags,
      content: content.slice(0, limits.questionPreviewLimit),
      contentTruncated: Boolean(item.contentTruncated) || content.length > limits.questionPreviewLimit,
      blockCount: blocks.length || item.blockCount || 0,
      answerCount: blocks.length ? blocks.filter(block => block.type === "answer").length : item.answerCount || 0,
      attachmentCount: Array.isArray(attachmentPaths) ? attachmentPaths.length : item.attachmentCount || 0,
      preview: preview ? {
        kind: preview.kind,
        content: preview.text.slice(0, limits.userPreviewLimit),
        truncated: preview.text.length > limits.userPreviewLimit || (!blocks.length && previousPreview?.truncated === true)
      } : null
    };
  });
}

/**
 * 当前思绪页面的恢复资格，不保存第二份窗口、正文或滚动位置。
 * 调用者在真实用户输入时推进意图代数，在重绘开始时替换恢复批次。
 * @since unreleased
 */
export function createThoughtReadingState(getScope: () => string) {
  let interactionRevision = 0;
  let renderRevision = 0;
  const capture = () => ({ scope: getScope(), interactionRevision, renderRevision });
  return Object.freeze({
    capture,
    beginRender() {
      renderRevision += 1;
      return capture();
    },
    interact() {
      interactionRevision += 1;
    },
    invalidate() {
      renderRevision += 1;
      interactionRevision += 1;
    },
    isCurrent(token: ReturnType<typeof capture>) {
      return token.scope === getScope()
        && token.interactionRevision === interactionRevision
        && token.renderRevision === renderRevision;
    }
  });
}
