export function createThoughtDraftTagComposer({
  $,
  getState,
  escapeHtml,
  splitTags,
  getDraftTags,
  addDraftTag
} = {}) {
  function commitDraftTags() {
    const input = $("#chain-tags");
    for (const tag of splitTags(input.value)) addDraftTag(tag);
    input.value = "";
    renderTagComposer();
  }

  function renderTagComposer() {
    const tags = getDraftTags();
    const list = $("#chain-tag-list");
    if (!list) return;

    list.innerHTML = tags.map(tag =>
      `<span class="tag-chip">#${escapeHtml(tag)}<button type="button" data-remove-draft-tag="${escapeHtml(tag)}" aria-label="移除标签 ${escapeHtml(tag)}">×</button></span>`
    ).join("");
    const knownTags = [...new Set(getState().thoughts.flatMap(item => item.tags || []))]
      .filter(tag => !tags.includes(tag));
    $("#tag-suggestions").innerHTML = knownTags.map(tag =>
      `<option value="${escapeHtml(tag)}"></option>`
    ).join("");
  }

  return Object.freeze({ commitDraftTags, renderTagComposer });
}
