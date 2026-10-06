import {
  createOccurrenceDraft,
  entryKeyIntent,
  occurrenceSubmission
} from "../../time/index.mjs";

export function createOccurrenceControls({
  document = globalThis.document,
  getActiveDate
} = {}) {
  if (typeof getActiveDate !== "function") {
    throw new TypeError("Occurrence controls require getActiveDate");
  }
  const selector = [
    "#chain-datetime",
    "#checkin-datetime",
    "#chat-datetime",
    "#capture-date",
    "#journal-date",
    '[data-daily-form] [name="occurredAt"]',
    '[data-book-entry-form] [name="occurredAt"]',
    "#keepsake-datetime",
    "#quote-datetime",
    "#selection-quote-datetime",
    "#thought-block-datetime"
  ].join(",");
  const host = input => input?.closest("label") || input?.parentElement;

  const setMode = (input, mode, { refreshValue = false } = {}) => {
    if (!input) return;
    const next = mode === "manual" ? "manual" : "now";
    input.dataset.occurrenceMode = next;
    if (refreshValue || !input.value) {
      input.value = createOccurrenceDraft({
        selectedDate: getActiveDate(),
        now: new Date()
      }).manualValue;
    }
    input.disabled = next === "now";
    input.hidden = next === "now";
    host(input)?.querySelectorAll("[data-occurrence-mode]").forEach(button => {
      const active = button.dataset.occurrenceMode === next;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  };

  const install = (input, { existing = null } = {}) => {
    if (!input) return;
    const container = host(input);
    if (!container) return;
    let controls = container.querySelector(".occurrence-mode");
    if (!controls) {
      controls = document.createElement("span");
      controls.className = "segmented-control occurrence-mode";
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", "发生时间方式");
      controls.innerHTML = '<button type="button" data-occurrence-mode="now">现在</button><button type="button" data-occurrence-mode="manual">手动指定</button>';
      container.insertBefore(controls, input);
      controls.addEventListener("click", event => {
        const button = event.target.closest("[data-occurrence-mode]");
        if (!button) return;
        event.preventDefault();
        setMode(input, button.dataset.occurrenceMode, {
          refreshValue: button.dataset.occurrenceMode === "manual"
            && input.dataset.occurrenceMode !== "manual"
        });
        if (button.dataset.occurrenceMode === "manual") input.focus();
      });
    }
    const draft = createOccurrenceDraft({
      selectedDate: getActiveDate(),
      existing,
      now: new Date()
    });
    input.value = draft.manualValue;
    setMode(input, draft.mode);
  };

  return Object.freeze({
    install,
    installAll(root = document) {
      root.querySelectorAll(selector).forEach(input => {
        if (!input.dataset.occurrenceMode) install(input);
      });
    },
    fields(input) {
      return occurrenceSubmission({
        mode: input?.dataset.occurrenceMode || "manual",
        manualValue: input?.value || ""
      }, { now: new Date() });
    },
    reset(input, existing = null) {
      install(input, { existing });
    },
    keyboardSubmit(event, form, inputKind = "multiline") {
      const intent = entryKeyIntent(event, { inputKind });
      if (intent !== "submit") return false;
      event.preventDefault();
      form.requestSubmit();
      return true;
    },
    setMode
  });
}
