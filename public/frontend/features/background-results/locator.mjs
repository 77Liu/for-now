const DESTINATIONS = Object.freeze({
  thought: Object.freeze({ view: "thoughts", domain: "thoughts" }),
  capture: Object.freeze({ view: "captures", domain: "captures" }),
  journal: Object.freeze({ view: "journals", domain: "journals" }),
  chat: Object.freeze({ view: "together", domain: "chat" }),
  analysis: Object.freeze({ view: "review", domain: "review" }),
  book: Object.freeze({ view: "books", domain: "books" }),
  quote: Object.freeze({ view: "quotes", domain: "quotes" })
});

const text = value => typeof value === "string" ? value : "";

function thoughtRootId(task, targetId, snapshot) {
  if (task?.kind !== "contentImageUnderstanding") return targetId;
  if (task.contentTargetType === "thoughtRoot") return text(task.contentTargetId) || targetId;
  if (task.contentTargetType !== "thoughtBlock") return targetId;
  const block = (Array.isArray(snapshot?.thoughts) ? snapshot.thoughts : [])
    .find(item => item?.id === task.contentTargetId && item.type !== "question");
  return text(block?.relatedTo) || targetId;
}

export function backgroundNavigationTarget(task, notification, snapshot = {}) {
  const resourceType = text(task?.resourceType)
    || text(notification?.resourceType)
    || "thought";
  const targetId = text(task?.targetId) || text(notification?.targetId);
  if (!targetId) return null;
  const destination = DESTINATIONS[resourceType] || DESTINATIONS.thought;
  const kind = text(task?.kind) || "thoughtAnswer";
  const subtargetId = text(task?.subtargetId) || text(notification?.subtargetId);
  const contentTargetType = text(task?.contentTargetType);
  const contentTargetId = text(task?.contentTargetId);
  const annotationId = kind === "contentImageUnderstanding" && contentTargetType === "comment"
    ? contentTargetId || subtargetId
    : kind === "annotationShenji"
      ? subtargetId
      : "";
  const rootId = resourceType === "thought"
    ? thoughtRootId(task, targetId, snapshot)
    : targetId;
  const focusId = kind === "contentImageUnderstanding" && contentTargetType === "capture"
    ? contentTargetId || targetId
    : rootId;
  return Object.freeze({
    kind,
    resourceType,
    targetId,
    subtargetId,
    contentTargetType,
    contentTargetId,
    annotationId,
    rootId,
    focusId,
    view: destination.view,
    domain: destination.domain
  });
}

export function backgroundTargetSelector(target, escapeSelector = value => value) {
  if (!target?.focusId) return "";
  const id = escapeSelector(target.focusId);
  return {
    thought: `[data-chain-id="${id}"]`,
    capture: `[data-capture-id="${id}"]`,
    journal: `[data-journal-id="${id}"]`,
    chat: `[data-chat-id="${id}"]`,
    analysis: `[data-analysis-id="${id}"]`,
    book: `[data-book-id="${id}"]`,
    quote: `[data-quote-id="${id}"]`
  }[target.resourceType] || "";
}
