const PRESENTATION = Object.freeze({
  comment: Object.freeze({
    kind: "comment",
    label: "评论",
    tone: "comment",
    className: "comment-anchor"
  }),
  highlight: Object.freeze({
    kind: "highlight",
    label: "绿色划线",
    tone: "green",
    className: "highlight-anchor"
  }),
  emphasis: Object.freeze({
    kind: "emphasis",
    label: "红色加重",
    tone: "red",
    className: "emphasis-anchor"
  })
});

export function annotationPresentation(annotation) {
  return { ...(PRESENTATION[annotation?.kind] || PRESENTATION.comment) };
}

export function sortAnnotationItemsByPosition(items, targetOrder = []) {
  const order = new Map(targetOrder.map((targetKey, index) => [targetKey, index]));
  const rank = item => order.has(item?.targetKey) ? order.get(item.targetKey) : targetOrder.length;
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => (
    rank(left) - rank(right)
    || String(left?.targetKey || "").localeCompare(String(right?.targetKey || ""))
    || (Number(left?.start) || 0) - (Number(right?.start) || 0)
    || (Number(left?.end) || 0) - (Number(right?.end) || 0)
    || String(left?.createdAt || "").localeCompare(String(right?.createdAt || ""))
    || String(left?.id || "").localeCompare(String(right?.id || ""))
  ));
}

export function commentSubmissionIntent(value, assistantName = "神鸡") {
  const text = String(value || "").trim();
  const escapedName = String(assistantName || "神鸡").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(`[@＠]\\s*${escapedName}`, "u");
  const asksAssistant = mention.test(text);
  const message = asksAssistant
    ? text.replace(mention, "").replace(/^[\s,，:：。！？!?、-]+/u, "").trim()
    : "";
  return { text, asksAssistant, message };
}

export async function submitAnnotationAssistantTask({
  clientRequestId = "",
  createRequestId,
  persistDraft,
  submitTask,
  refreshNotifications = async () => {},
  scheduleNotificationPoll = () => {}
}) {
  if (typeof createRequestId !== "function"
    || typeof persistDraft !== "function"
    || typeof submitTask !== "function"
    || typeof refreshNotifications !== "function"
    || typeof scheduleNotificationPoll !== "function") {
    throw new TypeError("Annotation assistant submission requires request, draft and notification handlers");
  }
  const requestId = String(clientRequestId || createRequestId());
  await persistDraft(requestId);
  const task = await submitTask(requestId);
  let notificationRefreshError = null;
  try {
    await refreshNotifications();
  } catch (error) {
    notificationRefreshError = error;
  }
  try {
    scheduleNotificationPoll();
  } catch (error) {
    notificationRefreshError ||= error;
  }
  return { task, clientRequestId: requestId, notificationRefreshError };
}

export function groupAnnotationLineCounts(entries, tolerance = 3) {
  const normalized = (Array.isArray(entries) ? entries : []).flatMap(entry => {
    const rects = Array.isArray(entry?.rects) ? entry.rects : [];
    const first = rects
      .filter(rect => Number.isFinite(Number(rect?.top)) && Number(rect?.height) > 0)
      .sort((left, right) => Number(left.top) - Number(right.top) || Number(left.left) - Number(right.left))[0];
    return entry?.annotationId && entry?.hostKey && first
      ? [{ annotationId: String(entry.annotationId), hostKey: String(entry.hostKey), top: Number(first.top) }]
      : [];
  }).sort((left, right) => left.hostKey.localeCompare(right.hostKey) || left.top - right.top || left.annotationId.localeCompare(right.annotationId));
  const groups = [];
  for (const entry of normalized) {
    const current = groups.at(-1);
    if (current && current.hostKey === entry.hostKey && Math.abs(current.top - entry.top) <= tolerance) {
      current.annotationIds.push(entry.annotationId);
      current.count += 1;
      continue;
    }
    groups.push({ hostKey: entry.hostKey, top: entry.top, count: 1, annotationIds: [entry.annotationId] });
  }
  return groups;
}

export function annotationMenuItems(annotation) {
  const kind = PRESENTATION[annotation?.kind] ? annotation.kind : "comment";
  return [
    { id: "copy-quote", label: "复制引文" },
    ...(annotation?.text ? [{ id: "copy-comment", label: "复制评论" }] : []),
    ...(kind === "comment" ? [] : [{ id: "to-comment", label: "转为评论" }]),
    ...(kind === "highlight" ? [] : [{ id: "to-highlight", label: "转为绿色划线" }]),
    ...(kind === "emphasis" ? [] : [{ id: "to-emphasis", label: "转为红色加重" }]),
    { id: "delete", label: kind === "comment" ? "删除评论" : "删除标记", destructive: true }
  ];
}

export async function copyAnnotationContent(annotation, part, writeText) {
  if (typeof writeText !== "function") throw new TypeError("copyAnnotationContent requires a clipboard writer");
  const value = part === "comment"
    ? annotation?.text
    : part === "answer"
      ? annotation?.shenji?.at(-1)?.answer
      : annotation?.quote;
  if (typeof value !== "string" || !value) return false;
  await writeText(value);
  return true;
}
