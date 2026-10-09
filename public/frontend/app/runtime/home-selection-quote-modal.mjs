export function createHomeSelectionQuoteModal({
  runtime,
  $,
  commentRoot,
  commentRootLabel,
  parseCommentRootKey,
  plainPreview,
  setQuoteTagPicker,
  resetOccurrenceInput
} = {}) {
  function selectionQuoteSource(rootKey) {
    const root = commentRoot(rootKey);
    const label = commentRootLabel(rootKey);
    const { type } = parseCommentRootKey(rootKey);
    const titles = {
      book: root?.title,
      journal: root?.title || root?.content,
      quote: root?.source,
      chat: root?.message
    };
    const title = Object.prototype.hasOwnProperty.call(titles, type)
      ? titles[type]
      : root?.content;
    return `${label}${title ? ` · ${plainPreview(title).slice(0, 60)}` : ""}`;
  }

  function closeSelectionQuoteModal() {
    const modal = $("#selection-quote-modal");
    modal.hidden = true;
    $("#selection-quote-form").reset();
    setQuoteTagPicker("selectionQuote");
    $("#selection-quote-status").textContent = "";
  }

  function openSelectionQuoteModal(selection) {
    const label = runtime.annotationsController.rootLabel(selection.rootKey);
    $("#selection-quote-content").value = selection.quote;
    $("#selection-quote-source").value = selectionQuoteSource(selection.rootKey);
    setQuoteTagPicker("selectionQuote", [label]);
    resetOccurrenceInput($("#selection-quote-datetime"));
    $("#selection-quote-status").textContent = "";
    $("#selection-quote-modal").hidden = false;
    $("#selection-quote-content").focus();
  }

  return Object.freeze({ closeSelectionQuoteModal, openSelectionQuoteModal });
}
