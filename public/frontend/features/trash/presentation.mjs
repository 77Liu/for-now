import {
  TRASH_TYPE_LABELS,
  trashDetailRows,
  trashTitleSource
} from "./model.mjs";

function requireFunctions(values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Trash presentation requires ${name}`);
    }
  }
}

export function createTrashPresentation({
  formatDate,
  contentState,
  escapeMarkup,
  plainPreview,
  renderMarkdown,
  renderLatex
} = {}) {
  requireFunctions({
    formatDate,
    contentState,
    escapeMarkup,
    plainPreview,
    renderMarkdown,
    renderLatex
  });

  const html = value => escapeMarkup(value);

  function title(entry) {
    return plainPreview(trashTitleSource(entry)).slice(0, 120) || "无标题记录";
  }

  function detail(entry) {
    const rows = trashDetailRows(entry);
    if (!rows.length) return "<p>这条记录没有可预览的文字内容。</p>";
    return rows.map(row => (
      `<div><b>${html(row.label)}</b><div class="markdown-content">${renderMarkdown(row.value)}</div></div>`
    )).join("");
  }

  function entry(entryValue, selected) {
    const id = String(entryValue?.id || "");
    const type = TRASH_TYPE_LABELS[entryValue?.type] || entryValue?.type || "";
    return `<article class="trash-entry" data-trash-id="${html(id)}"><label class="trash-select"><input type="checkbox" data-trash-select value="${html(id)}" ${selected ? "checked" : ""}><span>选择</span></label><div class="trash-copy"><header><span>${html(type)}</span><time>${html(formatDate(entryValue?.deletedAt))}</time></header><h2>${html(title(entryValue))}</h2><p>保留期标记至 ${html(formatDate(entryValue?.purgeAfter))}；永久清理始终由你确认。</p><details><summary>查看完整内容</summary><div class="trash-detail">${detail(entryValue)}</div></details></div><button class="quiet-button" type="button" data-trash-restore="${html(id)}">恢复</button></article>`;
  }

  function list({ items = [], selectedIds = [] } = {}) {
    if (!items.length) {
      return contentState({
        title: "回收站是空的",
        body: "没有待恢复的记录。删除后的内容会在保留期内出现在这里。",
        action: { view: "mine", label: "返回我的" }
      });
    }
    const selected = new Set(selectedIds);
    return items.map(item => entry(item, selected.has(String(item?.id || "")))).join("");
  }

  function failure() {
    return contentState({
      kind: "failure",
      title: "暂时无法读取回收站",
      body: "已删除的记录仍按原保留期保存。请检查网络后重试。",
      action: { command: "retry-trash", label: "重新读取" }
    });
  }

  return Object.freeze({
    title,
    detail,
    list,
    failure,
    enhance: container => renderLatex(container)
  });
}
