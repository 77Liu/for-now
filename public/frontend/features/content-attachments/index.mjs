/**
 * Presents the derived image result beside its source attachment.
 * Established: 2026-10-19
 * Status: active
 * Boundary: no attachment operations; runtime supplies the existing safe content renderer.
 */
import { reasoningDisclosureMarkup } from "../ui/index.mjs";

/** Renders independent image understanding and reasoning sections. @since unreleased */
export function imageUnderstandingMarkup(item, renderMarkdown) {
  return `<div class="content-understanding"><small>AI 图片理解</small>`
    + `<div class="markdown-content">${renderMarkdown(item.content)}</div>`
    + reasoningDisclosureMarkup(item) + "</div>";
}
