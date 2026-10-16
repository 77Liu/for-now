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
  const children = new Map<string, Summary[]>();
  for (const item of items) {
    if (typeof item.relatedTo !== "string") continue;
    const blocks = children.get(item.relatedTo) || [];
    blocks.push(item);
    children.set(item.relatedTo, blocks);
  }
  return items.filter(item => {
    if (item.type !== "question" || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, limits.pageSize * limits.maxPages).map(item => {
    const attachmentPaths = item.attachmentPaths;
    const blocks = children.get(item.id) || [];
    const preview = selectPreview(blocks, item.preview);
    const content = String(item.content || "");
    const previousPreview = item.preview as { truncated?: boolean } | null;
    const tags = [...new Set([...(Array.isArray(item.tags) ? item.tags : []), ...blocks.flatMap(block => Array.isArray(block.tags) ? block.tags : [])])].slice(0, 8);
    return {
      id: item.id,
      type: "question",
      version: item.version,
      occurredAt: item.occurredAt || null,
      occurredOn: item.occurredOn || null,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
      disposition: item.disposition || "kept",
      ...(item.clientRequestId ? { clientRequestId: item.clientRequestId } : {}),
      ...(item._sync ? { _sync: item._sync } : {}),
      ...(item.sourceRef && typeof item.sourceRef === "object" ? {
        sourceRef: Object.fromEntries(Object.entries(item.sourceRef).filter(([key]) => ["type", "id", "version"].includes(key)))
      } : {}),
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

/**
 * 完整权威thought域只收敛当前摘要窗口；新增根依据真实create变化，旧cursor拓扑失效后禁止续页。
 * 原页成员仅保留定位凭据，新根不伪造服务端opaque cursor；淘汰资格由当前真实DOM阅读者判断。
 * @since unreleased
 */
export function reconcileThoughtSyncWindow(
  snapshot: { thoughts?: Summary[]; thoughtPage?: { window?: ThoughtWindow; sort?: string; stale?: boolean; requestCursor?: string; prevCursor?: string } },
  incoming: Summary[], route: { query?: Record<string, string> },
  limits: Limits & { questionPreviewLimit: number; userPreviewLimit: number },
  selectPreview: (blocks: Summary[], previous: unknown) => { kind: string; text: string } | null,
  canEvict: (id: string) => boolean = () => false,
  changes: { domain?: string; resourceId?: string; changeType?: string }[] = []
) {
  const page = snapshot.thoughtPage, window = page?.window;
  if (!window || !page || !Array.isArray(incoming)) return false;
  const roots = new Map(incoming.filter(item => item.type === "question").map(item => [item.id, item]));
  const known = new Set((snapshot.thoughts || []).filter(item => item.type === "question").map(item => item.id));
  const createdRoots = new Set(changes.filter(change => change.domain === "thoughts" && change.changeType === "create"
    && change.resourceId && roots.has(change.resourceId)).map(change => change.resourceId));
  const wanted = new Set([...known, ...[...createdRoots].slice(0, limits.pageSize * limits.maxPages)]);
  const selected = incoming.filter(item => wanted.has(item.id) || typeof item.relatedTo === "string" && wanted.has(item.relatedTo));
  const summaries = summarizeThoughtWindowItems(selected, { ...limits, maxPages: Math.max(limits.maxPages, Math.ceil(wanted.size / limits.pageSize)) }, selectPreview);
  const byId = new Map(summaries.map(item => [item.id, item]));
  const existing = (snapshot.thoughts || []).filter(item => item.type === "question");
  let changed = false, topologyChanged = false;
  const items = existing.flatMap(item => {
    // 未确认本地编辑属于原队列/ACK结算，旧同步不能先闪回正文再重放。
    if (item._sync) return [item];
    const saved = byId.get(item.id);
    if (!saved) {
      if (item._sync) return [item];
      changed = true; topologyChanged = true; return [];
    }
    if (Number(item.version || 0) > Number(saved.version || 0)) return [item];
    if (JSON.stringify(item) === JSON.stringify(saved)) return [item];
    changed = true;
    const key = (route?.query?.sort || page.sort) === "created" ? "createdAt" : "occurredAt";
    if (String(item[key] || item.createdAt || "") !== String(saved[key] || saved.createdAt || "")) topologyChanged = true;
    return [saved];
  });
  const firstPage = window.pages[0];
  const headProven = firstPage ? !firstPage.requestCursor && !firstPage.prevCursor
    : Object.hasOwn(page, "requestCursor") && !page.requestCursor
      && Object.hasOwn(page, "prevCursor") && !page.prevCursor && !route?.query?.cursor;
  const newestEdge = headProven && !route?.query?.q && !route?.query?.tag;
  const tuple = (item: Summary) => [(route?.query?.sort || page.sort) === "created" ? item.createdAt || item.occurredAt || "" : item.occurredAt || item.createdAt || "", item.createdAt || "", item.id];
  const compare = (left: Summary, right: Summary) => {
    const a = tuple(left), b = tuple(right);
    return String(b[0]).localeCompare(String(a[0])) || String(b[1]).localeCompare(String(a[1])) || String(b[2]).localeCompare(String(a[2]));
  };
  const capacity = limits.pageSize * limits.maxPages;
  if (newestEdge) {
    const edge = existing[0];
    const additions = summaries.filter(item => createdRoots.has(item.id) && !known.has(item.id) && (!edge || compare(item, edge) < 0)).sort(compare);
    for (const addition of additions.slice(0, capacity)) {
      if (items.length >= capacity) {
        const last = items.at(-1);
        if (!last || !canEvict(last.id)) break;
        items.pop();
      }
      items.push(addition); changed = true; topologyChanged = true;
    }
  }
  // 窗口外根的普通更新也可能改变日期或筛选资格；完整权威域只能证明其存在，不能猜旧排序。
  const outsideRootUpdated = changes.some(change => change.domain === "thoughts" && change.changeType === "update"
    && change.resourceId && roots.has(change.resourceId) && !known.has(change.resourceId));
  if ([...createdRoots].some(id => !known.has(id!)) || outsideRootUpdated
    || changes.some(change => change.domain === "thoughts" && change.changeType === "reorder")) topologyChanged = true;
  if (newestEdge && topologyChanged) items.sort(compare);
  if (topologyChanged && !window.stale) { window.stale = true; window.generation += 1; }
  if (topologyChanged) page.stale = true;
  if (changed) {
    snapshot.thoughts = items;
    const retained = new Map(items.map(item => [item.id, item]));
    for (const member of window.pages) member.items = member.items.flatMap(item => {
      const current = retained.get(item.id);
      return current ? [current] : [];
    });
  }
  return changed || topologyChanged;
}

/**
 * 当前单条详情按稳定ID/版本接入完整同步域；已经接入的较新根与未确认编辑不被旧在途读取回退。
 * 权威缺失仍按完整域删除，未持久化表单由原阅读/草稿端口负责。
 * @since unreleased
 */
export function reconcileThoughtDetailSync(current: Summary[], incoming: Summary[], rootId: string): Summary[] {
  const belongs = (item: Summary) => item.id === rootId || item.relatedTo === rootId;
  const previous = current.filter(belongs), next = incoming.filter(belongs);
  const oldRoot = previous.find(item => item.id === rootId), newRoot = next.find(item => item.id === rootId);
  if (newRoot && oldRoot && !Object.hasOwn(oldRoot, "blockCount")
    && (oldRoot._sync || Number(oldRoot.version || 0) > Number(newRoot.version || 0))) return previous;
  const byId = new Map(previous.map(item => [item.id, item]));
  return next.map(item => {
    const old = byId.get(item.id);
    return old && !Object.hasOwn(old, "blockCount") && (old._sync || Number(old.version || 0) > Number(item.version || 0)) ? old : item;
  });
}
