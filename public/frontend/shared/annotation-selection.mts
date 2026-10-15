/**
 * 统一批注正文的UTF-16片段、原生选区偏移与锚点文本。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：排除交互控件；公式以既有data-tex原文占位，不伪造视觉公式的选中文字。
 */
type Segment = { node: Node; text: string; atomic: boolean };

/** 正文按既有Markdown消费者拼接；公式只读取data-tex，不重复计入KaTeX隐藏/视觉节点。 @since unreleased */
export function annotationTextSegments(container: Node): Segment[] {
  const segments: Segment[] = [];
  function visit(node: Node) {
    if (node.nodeType === 3) {
      if (node.nodeValue) segments.push({ node, text: node.nodeValue, atomic: false });
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.matches('button,textarea,input,select,script,style,[aria-hidden="true"]')) return;
    if (element.hasAttribute("data-tex")) {
      try {
        segments.push({ node, text: decodeURIComponent(element.getAttribute("data-tex") || ""), atomic: true });
      } catch { /* 非法编码不可伪造公式源。 */ }
      return;
    }
    for (const child of node.childNodes) visit(child);
  }
  visit(container);
  return segments;
}

/** 与选区/锚点共用正文规范；不插入呈现布局中的额外分隔符。 @since unreleased */
export function annotationText(container: Node): string {
  return annotationTextSegments(container).map(segment => segment.text).join("");
}

/**
 * 从同一宿主原生Range得到UTF-16左闭右开范围；不支持视觉公式内部/跨公式选区，返回null要求重新选择。
 * 原生跨段布局换行不作为正文字符；按钮等不属于正文。既有1000字符上限保持。
 * @since unreleased
 */
export function annotationRangeValue(document: Document, host: Element, range: Range) {
  const segments = annotationTextSegments(host);
  const offsetAt = (node: Node, offset: number): number | null => {
    const prefix = document.createRange();
    prefix.selectNodeContents(host);
    prefix.setEnd(node, offset);
    let total = 0;
    for (const segment of segments) {
      const parent = segment.node.parentNode;
      const index = parent ? Array.prototype.indexOf.call(parent.childNodes, segment.node) : -1;
      const boundaryNode = segment.atomic && parent ? parent : segment.node;
      const boundaryStart = segment.atomic ? index : 0;
      const boundaryEnd = segment.atomic ? index + 1 : segment.text.length;
      if (prefix.comparePoint(boundaryNode, boundaryEnd) === 0) {
        total += segment.text.length;
      } else if (prefix.comparePoint(boundaryNode, boundaryStart) === 0) {
        if (!segment.atomic && segment.node === node) return total + offset;
        return segment.atomic && segment.node.contains(node) ? null : total;
      } else {
        return total;
      }
    }
    return total;
  };
  const startOffset = offsetAt(range.startContainer, range.startOffset);
  const endOffset = offsetAt(range.endContainer, range.endOffset);
  if (startOffset === null || endOffset === null || endOffset <= startOffset) return null;
  let offset = 0;
  for (const segment of segments) {
    const end = offset + segment.text.length;
    if (segment.atomic && endOffset > offset && startOffset < end) return null;
    offset = end;
  }
  const source = segments.map(segment => segment.text).join("");
  const raw = source.slice(startOffset, endOffset), quote = raw.trim();
  if (!quote || quote.length > 1000) return null;
  const start = startOffset + raw.length - raw.trimStart().length;
  return { start, end: start + quote.length, quote };
}

/** 优先既有rawStart/start，其次唯一的精确上下文；歧义重复词不猜首条，不改变持久锚点。 @since unreleased */
export function annotationAnchorOffset(source: string, annotation: {
  quote?: string; rawStart?: number; start?: number; contextBefore?: string; contextAfter?: string;
}) {
  const quote = annotation.quote || "";
  if (!quote) return null;
  for (const prior of [annotation.rawStart, annotation.start]) {
    if (Number.isInteger(prior) && Number(prior) >= 0 && source.slice(Number(prior), Number(prior) + quote.length) === quote) return Number(prior);
  }
  const candidates: number[] = [];
  for (let start = source.indexOf(quote); start >= 0; start = source.indexOf(quote, start + 1)) candidates.push(start);
  if (candidates.length === 1) return candidates[0];
  const matches = candidates.filter(start => (annotation.contextBefore || annotation.contextAfter)
    && (!annotation.contextBefore || source.slice(0, start).endsWith(annotation.contextBefore))
    && (!annotation.contextAfter || source.slice(start + quote.length).startsWith(annotation.contextAfter)));
  return matches.length === 1 ? matches[0] : null;
}
