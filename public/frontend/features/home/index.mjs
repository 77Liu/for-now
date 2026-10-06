const text = value => typeof value === "string" ? value.trim() : "";
const timestamp = item => text(item?.occurredAt || item?.createdAt);
const typeOrder = ["thought", "book", "quote"];

function dateKey(item) {
  return text(item?.occurredOn) || timestamp(item).slice(0, 10);
}

export function isAiDerivedHomeContent(item = {}) {
  const origin = text(item.origin).toLowerCase();
  const source = text(item.source);
  return item.authorType === "ai"
    || item.sourceType === "ai"
    || item.derivedFromAi === true
    || /^(?:deepseek|codex|openai|model|ai)(?:$|[-_:])/i.test(origin)
    || /^(?:AI|模型|神鸡)(?:生成|总结|回答|整理)/i.test(source);
}

export function createHomeMemoryPool(snapshot = {}) {
  const thoughts = Array.isArray(snapshot.thoughts) ? snapshot.thoughts : [];
  const roots = thoughts.filter(item => (
    item?.type === "question"
    && item.disposition !== "discarded"
    && !isAiDerivedHomeContent(item)
    && text(item.content)
  ));
  const thoughtItems = roots.map(root => {
    const children = thoughts
      .filter(item => (
        item?.relatedTo === root.id
        && item.disposition !== "discarded"
        && ["idea", "record", "answer"].includes(item.type)
        && !isAiDerivedHomeContent(item)
        && text(item.content)
      ))
      .sort((left, right) => timestamp(right).localeCompare(timestamp(left)));
    return {
      key: `thought:${root.id}`,
      id: root.id,
      type: "thought",
      occurredAt: timestamp(root),
      occurredOn: dateKey(root),
      title: children.length ? text(root.content) : "",
      text: text(children[0]?.content || root.content)
    };
  });

  const bookItems = (Array.isArray(snapshot.books) ? snapshot.books : []).flatMap(book => (
    (Array.isArray(book?.notes) ? book.notes : [])
      .filter(note => text(note?.content) && !isAiDerivedHomeContent(note))
      .map(note => ({
        key: `book:${book.id}:${note.id}`,
        id: note.id,
        bookId: book.id,
        noteId: note.id,
        type: "book",
        occurredAt: timestamp(note),
        occurredOn: dateKey(note),
        sourceTitle: text(book.title),
        title: "",
        text: text(note.content)
      }))
  ));

  const quoteItems = (Array.isArray(snapshot.quotes) ? snapshot.quotes : [])
    .filter(item => text(item?.content) && !isAiDerivedHomeContent(item))
    .map(item => ({
      key: `quote:${item.id}`,
      id: item.id,
      type: "quote",
      occurredAt: timestamp(item),
      occurredOn: dateKey(item),
      sourceTitle: text(item.source),
      title: "",
      text: text(item.content)
    }));

  return [...thoughtItems, ...bookItems, ...quoteItems]
    .sort((left, right) => timestamp(right).localeCompare(timestamp(left)) || left.key.localeCompare(right.key));
}

function takeRandom(items, random) {
  if (!items.length) return null;
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)));
  return items[index];
}

export function selectHomeMemories(pool = [], {
  previousKeys = [],
  random = Math.random,
  limit = 3
} = {}) {
  const previous = new Set(previousKeys);
  const selected = [];
  const selectedKeys = new Set();
  const add = item => {
    if (!item || selectedKeys.has(item.key) || selected.length >= limit) return;
    selected.push(item);
    selectedKeys.add(item.key);
  };

  for (const type of typeOrder) {
    const bucket = pool.filter(item => item.type === type);
    add(takeRandom(bucket.filter(item => !previous.has(item.key)), random) || takeRandom(bucket, random));
  }

  const remaining = pool.filter(item => !selectedKeys.has(item.key));
  const alternatives = remaining.filter(item => !previous.has(item.key));
  while (selected.length < limit && (alternatives.length || remaining.length)) {
    const candidates = alternatives.length ? alternatives : remaining;
    const item = takeRandom(candidates, random);
    add(item);
    const alternativeIndex = alternatives.findIndex(value => value.key === item?.key);
    if (alternativeIndex >= 0) alternatives.splice(alternativeIndex, 1);
    const remainingIndex = remaining.findIndex(value => value.key === item?.key);
    if (remainingIndex >= 0) remaining.splice(remainingIndex, 1);
  }

  return selected;
}
