export const BOOK_FAVORITES = Object.freeze({
  none: Object.freeze({ icon: "☆", label: "无收藏", next: "star" }),
  star: Object.freeze({ icon: "🌟", label: "星标", next: "sprout" }),
  sprout: Object.freeze({ icon: "🌱", label: "萌芽", next: "none" })
});

export const normalizeLibrarySearch = value => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase("zh-CN")
  .replace(/\s+/g, " ")
  .trim();

function searchableText(...values) {
  const parts = [];
  const append = value => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach(append);
      return;
    }
    if (typeof value === "object") {
      Object.values(value).forEach(append);
      return;
    }
    parts.push(String(value));
  };
  values.forEach(append);
  return normalizeLibrarySearch(parts.join(" "));
}

export function bookMatchesSearch(book, query) {
  const normalized = normalizeLibrarySearch(query);
  if (!normalized) return true;
  const text = searchableText(
    book?.title,
    book?.author,
    book?.publisher,
    book?.isbn,
    book?.description,
    book?.notes?.map(note => note.content)
  );
  return normalized.split(" ").every(term => text.includes(term));
}

export function sortedBookNotes(book, eventTimestamp) {
  return [...(book?.notes || [])]
    .sort((left, right) => eventTimestamp(right).localeCompare(eventTimestamp(left)));
}

export function randomBookMemories(books, random = Math.random, limit = 5) {
  return (books || [])
    .flatMap(book => (book.notes || []).map(note => ({ book, note })))
    .map(value => ({ value, order: random() }))
    .sort((left, right) => left.order - right.order)
    .slice(0, limit)
    .map(item => item.value);
}
