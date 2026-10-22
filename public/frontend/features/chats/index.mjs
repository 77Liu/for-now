/**
 * Chat result presentation entry.
 * Established: 2026-10-19
 * Status: active
 * Boundary: runtime owns page lifecycle; the chat feature owns result presentation.
 */
import { reasoningDisclosureMarkup } from "../ui/index.mjs";

/** Combines the chat answer with its shared, collapsed reasoning disclosure. @since unreleased */
export function chatAnswerMarkup(item, renderMarkdown) {
  return `<div class="markdown-content">${renderMarkdown(item.answer)}</div>`
    + reasoningDisclosureMarkup(item);
}
