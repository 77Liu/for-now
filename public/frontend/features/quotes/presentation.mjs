import { eventDate, eventTimestamp, formatTime } from "../../time/index.mjs";

export function selectRotatingQuotes(quotes, index, limit = 3) {
  const items = [...(quotes || [])];
  const tagNames = [...new Set(items.flatMap(item => item.tags || []))];
  const selected = [];
  const selectedIds = new Set();
  if (tagNames.length) {
    for (let offset = 0; offset < tagNames.length && selected.length < limit; offset += 1) {
      const tag = tagNames[(index + offset) % tagNames.length];
      const bucket = items.filter(item => (
        (item.tags || []).includes(tag) && !selectedIds.has(item.id)
      ));
      if (!bucket.length) continue;
      const item = bucket[(index + offset) % bucket.length];
      selected.push(item);
      selectedIds.add(item.id);
    }
  }
  for (let offset = 0; offset < items.length && selected.length < limit; offset += 1) {
    const item = items[(index + offset) % items.length];
    if (!selectedIds.has(item.id)) {
      selected.push(item);
      selectedIds.add(item.id);
    }
  }
  return selected;
}

export const quoteTagsMarkup = (tags, escapeMarkup) => (tags || []).length
  ? `<div class="quote-tags">${tags.map(tag => (
    `<span>#${escapeMarkup(tag)}</span>`
  )).join("")}</div>`
  : "";

export function quoteSkyMarkup({
  quotes,
  index,
  previousIds = new Set(),
  advance = false,
  escapeMarkup,
  emptyState,
  random = Math.random
}) {
  const items = selectRotatingQuotes(quotes, index);
  if (advance && quotes.length > items.length && items.every(item => previousIds.has(item.id))) {
    const alternate = quotes.find(item => !previousIds.has(item.id));
    if (alternate) items[items.length - 1] = alternate;
  }
  if (!items.length) {
    return {
      items,
      markup: emptyState({
        title: "还没有收藏的句子",
        body: "先留下原句和来源，它之后会在这里再次出现。",
        action: { focus: "quote-content", label: "收藏第一句" },
        className: "quote-sky-empty"
      })
    };
  }
  return {
    items,
    markup: items.map(item => {
      const visibleLines = 3 + Math.floor(random() * 3);
      return `<article class="quote-bubble" data-quote-id="${escapeMarkup(item.id)}" data-visible-lines="${visibleLines}" style="--quote-content-max-height:${(visibleLines * 1.72).toFixed(2)}em"><p><span class="quote-scroll-track">“<span class="quote-content">${escapeMarkup(item.content)}</span>”</span></p>${quoteTagsMarkup(item.tags, escapeMarkup)}<small>— ${escapeMarkup(item.source)}</small></article>`;
    }).join("")
  };
}

export function quoteTimelineMarkup({
  items,
  allItems,
  escapeMarkup,
  emptySearchState
}) {
  if (!items.length) return allItems.length ? emptySearchState("拾句") : "";
  return items.map((item, index) => {
    const syncing = item._sync?.status;
    const actions = syncing
      ? `<span class="checkin-sync-state ${escapeMarkup(syncing)}">${syncing === "pending" ? "待同步" : "正在同步"}</span>`
      : `<button class="subtle-action" type="button" data-quote-edit="${escapeMarkup(item.id)}">编辑</button><button class="subtle-action danger" type="button" data-quote-delete="${escapeMarkup(item.id)}">删除</button>`;
    return `<article class="quote-entry${syncing ? " is-syncing" : ""}" data-quote-id="${escapeMarkup(item.id)}">${index === 0 || eventDate(item) !== eventDate(items[index - 1]) ? `<div class="quote-date">${escapeMarkup(eventDate(item))}</div>` : ""}<header class="quote-entry-meta"><cite title="${escapeMarkup(item.source)}">${escapeMarkup(item.source)}</cite><span class="quote-entry-tools"><time>${formatTime(eventTimestamp(item))}</time>${actions}</span></header><div class="quote-entry-card card"><blockquote class="quote-content-viewport" data-expand-key="quote:${escapeMarkup(item.id)}">${escapeMarkup(item.content)}</blockquote><button class="quote-expand" type="button" data-quote-expand aria-expanded="false" hidden>展开</button>${quoteTagsMarkup(item.tags, escapeMarkup)}</div></article>`;
  }).join("");
}
