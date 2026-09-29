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
