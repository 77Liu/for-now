import { BOOK_FAVORITES, sortedBookNotes } from "./model.mjs";

export function createLibraryPresentation({
  appUrl,
  contentState,
  escapeMarkup,
  plainPreview,
  renderMarkdown,
  eventDate,
  eventTimestamp,
  formatDate,
  formatDateKey,
  formatTime
} = {}) {
  const readingRange = book => book.readingStartedOn
    ? `${formatDateKey(book.readingStartedOn)} — ${book.readingFinishedOn
      ? formatDateKey(book.readingFinishedOn)
      : "至今"}`
    : "阅读日期未记录";

  const cover = (book, className = "book-cover") => book.imagePath
    ? `<img class="${className}" src="${escapeMarkup(appUrl(book.imagePath))}" alt="${escapeMarkup(book.title)}" loading="lazy">`
    : `<div class="${className} placeholder" aria-hidden="true">书</div>`;

  function feature(note) {
    if (!note) {
      return `<article class="book-feature-note is-empty"><p class="eyebrow">随机精选</p><h3>第一条笔记会出现在这里</h3><p>正文时间线已经就位。写下一条真实的理解，再回来与它偶遇。</p></article>`;
    }
    const type = note.type === "thought" ? "附加思考" : "读书记录";
    const preview = plainPreview(note.content);
    return `<article class="book-feature-note"><p class="eyebrow">随机精选</p><blockquote>${escapeMarkup(preview.slice(0, 220))}${preview.length > 220 ? "…" : ""}</blockquote><footer><span>${type} · ${formatDate(eventTimestamp(note))}</span><button class="text-button" type="button" data-book-feature-note="${escapeMarkup(note.id)}">在时间线中查看 →</button></footer></article>`;
  }

  function entryForm(book) {
    return `<form class="book-entry-form card" data-book-entry-form="${escapeMarkup(book.id)}">
      <div class="book-entry-form-heading"><div><p class="eyebrow">写进这本书</p><h2 data-book-entry-heading>新增记录</h2></div><button class="text-button" type="button" data-book-entry-cancel hidden>取消编辑</button></div>
      <input type="hidden" name="noteId">
      <div class="book-entry-controls">
        <fieldset class="book-segmented"><legend>类型</legend><label><input type="radio" name="type" value="record" checked><span>记录</span></label><label><input type="radio" name="type" value="thought"><span>附加思考</span></label></fieldset>
        <label class="book-entry-time"><span>发生时间</span><input type="datetime-local" step="1" name="occurredAt" required></label>
        <fieldset class="book-segmented favorite-segmented"><legend>收藏</legend><label><input type="radio" name="favorite" value="none" checked><span>无</span></label><label><input type="radio" name="favorite" value="star"><span>🌟</span></label><label><input type="radio" name="favorite" value="sprout"><span>🌱</span></label></fieldset>
      </div>
      <textarea name="content" rows="5" placeholder="记下原文、理解、疑问，或读完后仍在生长的想法…" required></textarea>
      <div class="book-entry-submit"><span>支持 Markdown 与 LaTeX</span><button class="primary-button" type="submit">保存记录</button></div>
      <p class="status" role="status"></p>
    </form>`;
  }

  function timeline(book) {
    const notes = sortedBookNotes(book, eventTimestamp);
    if (!notes.length) {
      return `<div class="book-timeline-empty"><div class="empty">还没有记录。先留下一句真实的理解，之后再慢慢补充。</div></div>`;
    }
    return `<div class="book-timeline">${notes.map((note, index) => {
      const date = eventDate(note);
      const previous = index ? eventDate(notes[index - 1]) : "";
      const favorite = BOOK_FAVORITES[note.favorite] || BOOK_FAVORITES.none;
      const type = note.type === "thought" ? "附加思考" : "记录";
      const syncing = note._sync?.status;
      const actions = syncing
        ? `<span class="checkin-sync-state ${escapeMarkup(syncing)}">${syncing === "pending" ? "待同步" : "正在同步"}</span>`
        : `<button class="book-favorite ${escapeMarkup(note.favorite || "none")}" type="button" data-book-note-favorite="${escapeMarkup(note.id)}" data-next-favorite="${favorite.next}" title="${favorite.label}，点击切换" aria-label="${favorite.label}，点击切换">${favorite.icon}</button><div><button class="subtle-action" type="button" data-book-note-edit="${escapeMarkup(note.id)}">编辑</button><button class="subtle-action danger" type="button" data-book-note-delete="${escapeMarkup(note.id)}">删除</button></div>`;
      return `<article class="book-timeline-entry${syncing ? " is-syncing" : ""}" id="book-note-${escapeMarkup(note.id)}" data-note-id="${escapeMarkup(note.id)}">
        ${date !== previous ? `<time class="book-entry-date">${escapeMarkup(date)}</time>` : ""}
        <div class="book-entry-card card">
          <header><span class="book-entry-type ${note.type === "thought" ? "thought" : ""}">${type}</span><time>${formatTime(eventTimestamp(note))}</time></header>
          <div class="book-note markdown-content">${renderMarkdown(note.content)}</div>
          <footer>${actions}</footer>
        </div>
      </article>`;
    }).join("")}</div>`;
  }

  function detail(book, featuredNote) {
    const notes = sortedBookNotes(book, eventTimestamp);
    const latest = notes[0];
    return `<div class="book-detail-nav"><button class="book-back" type="button" data-book-back>← 返回书架</button><div><button class="quiet-button" type="button" data-book-edit="${escapeMarkup(book.id)}">编辑书目</button><button class="subtle-action danger" type="button" data-book-delete="${escapeMarkup(book.id)}">删除书目</button></div></div>
      <section class="book-detail-overview">
        <div class="book-feature-wrap">${feature(featuredNote)}</div>
        <section class="book-detail-hero">
          ${cover(book, "book-detail-cover")}
          <div class="book-detail-copy"><h2>${escapeMarkup(book.title)}</h2><p class="book-meta">${escapeMarkup(book.author || "作者未填")}${book.publisher ? ` · ${escapeMarkup(book.publisher)}` : ""}${book.isbn ? ` · ${escapeMarkup(book.isbn)}` : ""}</p><p class="book-reading-range">${escapeMarkup(readingRange(book))}</p><div class="book-description markdown-content">${renderMarkdown(book.description || "暂无简介")}</div><div class="book-detail-stats"><span><b>${notes.length}</b> 条记录</span><span>${latest ? `最近记录 ${formatDate(eventTimestamp(latest))}` : "等待第一条记录"}</span></div></div>
        </section>
      </section>
      <section class="book-timeline-section"><div class="book-timeline-heading"><div><p class="eyebrow">阅读时间线</p><h2>我的笔记与思考</h2></div><div><span>${notes.length} 条</span><button class="quiet-button" type="button" data-book-add-note>＋ 新增记录</button></div></div>${timeline(book)}</section>
      ${entryForm(book)}`;
  }

  function memorySky(memories) {
    if (!memories.length) {
      return `<div class="book-memory-placeholder"><b>旧笔记会在这里浮现</b><span>在任一本书中留下记录后，这里会随机回顾。</span></div>`;
    }
    return `<div class="book-memory-title"><p class="eyebrow">偶遇旧笔记</p><span>点击回到原处</span></div>${memories.map(({ book, note }, index) => {
      const preview = plainPreview(note.content);
      return `<button class="book-memory-bubble tone-${index % 5} position-${index % 5}" type="button" data-book-memory="${escapeMarkup(book.id)}" data-book-note="${escapeMarkup(note.id)}" aria-label="打开《${escapeMarkup(book.title)}》中的这条笔记"><span>${escapeMarkup(preview.slice(0, 76))}${preview.length > 76 ? "…" : ""}</span><small>《${escapeMarkup(book.title)}》</small></button>`;
    }).join("")}`;
  }

  function cards(books) {
    return books.map(book => {
      const notes = sortedBookNotes(book, eventTimestamp);
      const latest = notes[0];
      const syncing = book._sync?.status;
      return `<article class="book-card card${syncing ? " is-syncing" : ""}" data-book-id="${escapeMarkup(book.id)}"><button class="book-card-open" type="button" data-open-book="${escapeMarkup(book.id)}" ${syncing ? "disabled" : ""}>${cover(book, "book-gallery-cover")}<span class="book-card-copy"><span class="book-title-frame" data-title="${escapeMarkup(book.title)}" title="${escapeMarkup(book.title)}"><strong class="book-title">${escapeMarkup(book.title)}</strong></span><span>${escapeMarkup(book.author || "作者未填")}</span><small class="book-card-reading">${escapeMarkup(readingRange(book))}</small><small>${syncing ? (syncing === "pending" ? "待同步" : "正在同步") : `${notes.length} 条记录${latest ? ` · ${formatDate(eventTimestamp(latest))}` : ""}`}</small></span><span class="book-card-arrow" aria-hidden="true">→</span></button></article>`;
    }).join("");
  }

  return Object.freeze({
    cards,
    detail,
    memorySky,
    searchEmpty: () => contentState({
      title: "没有匹配的书目",
      body: "换一个关键词，原有记录不会受到影响。"
    })
  });
}
