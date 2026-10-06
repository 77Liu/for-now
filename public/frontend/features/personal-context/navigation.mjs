export const CONTEXT_DESTINATION_SELECTORS = Object.freeze({
  thoughts: id => `[data-chain-id="${id}"]`,
  captures: id => `[data-capture-id="${id}"]`,
  journals: id => `[data-journal-id="${id}"]`,
  together: id => `[data-chat-id="${id}"]`,
  daily: id => `[data-daily-record-id="${id}"]`,
  today: id => `[data-checkin-id="${id}"]`
});

const DAILY_TYPES = new Set(["sleep", "heartRate", "weight", "exercise"]);

export function contextSourceTarget(button) {
  const dataset = button?.dataset || {};
  return Object.freeze({
    view: String(dataset.contextView || ""),
    targetId: String(dataset.contextTarget || ""),
    rootId: String(dataset.contextRoot || ""),
    targetKey: String(dataset.contextKey || ""),
    date: String(dataset.contextDate || ""),
    dailyType: String(dataset.contextDailyType || "")
  });
}

export function openContextSource(button, {
  activateDate,
  switchView,
  openThoughtDetail,
  requestFrame,
  queryDestination,
  escapeSelector,
  isDetailsElement
}) {
  const target = contextSourceTarget(button);
  if (target.date) {
    activateDate(
      target.date,
      DAILY_TYPES.has(target.dailyType) ? target.dailyType : ""
    );
  }
  if (target.view === "thoughts") {
    openThoughtDetail(target.rootId || target.targetId);
  } else {
    switchView(target.view);
  }

  requestFrame(() => {
    const selectorFactory = CONTEXT_DESTINATION_SELECTORS[target.view];
    if (!selectorFactory) return;
    const identity = target.view === "thoughts"
      ? target.rootId || target.targetId
      : target.targetId;
    const element = queryDestination(selectorFactory(escapeSelector(identity)));
    const chain = element?.closest?.("[data-chain-id]") || element;
    if (isDetailsElement(chain)) chain.open = true;
    let destination = element;
    if (target.view === "thoughts" && element) {
      if (target.targetKey.startsWith("question:")) {
        destination = element.querySelector?.(".thought-question-content") || element;
      } else if (/^(?:idea|record|answer):/.test(target.targetKey)) {
        const blockId = target.targetKey.split(":").slice(1).join(":");
        destination = element.querySelector?.(
          `[data-thought-block-id="${escapeSelector(blockId)}"]`
        ) || element;
      }
    }
    destination?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  });
  return true;
}
