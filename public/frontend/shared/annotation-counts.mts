/**
 * 从当前账户已确认批注集合派生线程、回复、标记和漂流数量及展示文案。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：不保存状态、不增加待确认数量；不完整根的总数为未知，回复与AI对话不混计。
 */
type Entry = { id?: string; version?: number; kind?: string; targetKey?: string; replies?: Entry[]; shenji?: Entry[]; [key: string]: unknown };
type Root = { annotations?: Entry[]; annotationDrift?: Entry[]; blockCount?: unknown };

/** 同一确认集合按稳定ID保留最新版；只派生副本，不改业务事实数组。 @since unreleased */
export function uniqueAnnotationEntries(entries: Entry[] = []): Entry[] {
  const result = new Map<string, Entry>();
  for (const entry of entries) {
    if (!entry?.id) continue;
    const current = result.get(entry.id);
    if (!current || Number(entry.version || 1) >= Number(current.version || 1)) result.set(entry.id, entry);
  }
  return [...result.values()];
}

/**
 * 投影同一根/可选target的确认集合；完整性由真实加载入口提供，摘要不能推断为完整空数组。
 * kind缺省兼容历史comment；marks及drift独立，AI对话另列。未知时保留可见子集但不声称总数。
 * @since unreleased
 */
export function projectAnnotationCounts(root: Root | null, { complete, targetKey = "" }: { complete?: boolean; targetKey?: string } = {}) {
  const loaded = complete !== false && !!root && !Object.hasOwn(root, "blockCount")
    && Array.isArray(root.annotations) && Array.isArray(root.annotationDrift);
  const matches = (item: Entry) => !targetKey || item.targetKey === targetKey;
  const entries = uniqueAnnotationEntries(root?.annotations).filter(matches).map(item => ({
    ...item,
    replies: uniqueAnnotationEntries(item.replies),
    shenji: uniqueAnnotationEntries(item.shenji)
  }));
  const threads = entries.filter(item => !["highlight", "emphasis"].includes(item.kind || "comment"));
  const marks = entries.filter(item => ["highlight", "emphasis"].includes(item.kind || ""));
  const drift = uniqueAnnotationEntries(root?.annotationDrift).filter(matches);
  return {
    loaded, entries, threads, marks, drift,
    threadCount: loaded ? threads.length : null,
    replyCount: loaded ? threads.reduce((total, item) => total + item.replies.length, 0) : null,
    assistantCount: loaded ? entries.reduce((total, item) => total + item.shenji.length, 0) : null,
    markCount: loaded ? marks.length : null,
    driftCount: loaded ? drift.length : null
  };
}

/** 同一计数投影的展示文案；未知不显示0，漂流及标记不混入正文评论。 @since unreleased */
export function annotationCountLabel(counts: ReturnType<typeof projectAnnotationCounts>) {
  if (!counts.loaded) return "批注未完整加载";
  const parts = [`${counts.threadCount}条批注`, `${counts.replyCount}条回复`];
  if (counts.assistantCount) parts.push(`${counts.assistantCount}条AI回复`);
  if (counts.markCount) parts.push(`${counts.markCount}条标记`);
  if (counts.driftCount) parts.push(`${counts.driftCount}条漂流`);
  return parts.join(" · ");
}
