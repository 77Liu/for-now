const ROOT_COLLECTIONS = Object.freeze({
  capture: "captures",
  journal: "journals",
  chat: "chats",
  analysis: "analyses",
  book: "books",
  quote: "quotes"
});

const ROOT_LABELS = Object.freeze({
  thought: "主题思考",
  capture: "捕念",
  journal: "日记",
  chat: "长期对话",
  analysis: "认知复盘",
  book: "读书笔记",
  quote: "善言"
});

export function annotationRootKey(type, id) {
  return `${type}:${id}`;
}

export function parseAnnotationRootKey(value) {
  const divider = String(value || "").indexOf(":");
  return divider < 1
    ? { type: "", id: "" }
    : { type: value.slice(0, divider), id: value.slice(divider + 1) };
}

export function createAnnotationModel({ getSnapshot, getAccountId, storage }) {
  const ui = {
    pendingSelection: null,
    activeRootKey: "",
    activeAnnotationId: "",
    activeAssistantComposer: "",
    panelOpen: false
  };
  let drafts = {};

  const rootFor = value => {
    const { type, id } = parseAnnotationRootKey(value);
    const snapshot = getSnapshot() || {};
    if (type === "thought") {
      return (snapshot.thoughts || [])
        .find(item => item.id === id && item.type === "question") || null;
    }
    return ROOT_COLLECTIONS[type]
      ? (snapshot[ROOT_COLLECTIONS[type]] || []).find(item => item.id === id) || null
      : null;
  };
  const draftStorageKey = () => (
    getAccountId() ? `cike:annotation-drafts:${getAccountId()}` : ""
  );
  const assistantDraftKey = (rootKey, annotationId) => `${rootKey}|${annotationId}`;

  function persistDrafts() {
    const key = draftStorageKey();
    if (!key) return;
    try {
      if (Object.keys(drafts).length) storage.setItem(key, JSON.stringify(drafts));
      else storage.removeItem(key);
    } catch {}
  }
  function stashAssistantDraft(form) {
    if (!form) return;
    const rootKey = form.dataset.commentRoot || ui.activeRootKey;
    const annotationId = form.dataset.shenjiForm;
    const message = form.elements.message?.value || "";
    const requestId = form.dataset.requestId || "";
    const key = assistantDraftKey(rootKey, annotationId);
    if (message.trim() || requestId) {
      drafts[key] = {
        rootKey,
        annotationId,
        message,
        requestId,
        updatedAt: new Date().toISOString()
      };
    } else {
      delete drafts[key];
    }
    persistDrafts();
  }
  function saveAssistantDraft(rootKey, annotationId, message, requestId) {
    drafts[assistantDraftKey(rootKey, annotationId)] = {
      rootKey,
      annotationId,
      message,
      requestId,
      updatedAt: new Date().toISOString()
    };
    persistDrafts();
  }
  function clearAssistantDraft(rootKey, annotationId) {
    delete drafts[assistantDraftKey(rootKey, annotationId)];
    persistDrafts();
  }
  function hydrateAssistantForm(form) {
    const draft = drafts[assistantDraftKey(
      form.dataset.commentRoot,
      form.dataset.shenjiForm
    )];
    if (!draft) return;
    form.elements.message.value = draft.message || "";
    if (draft.requestId) form.dataset.requestId = draft.requestId;
  }
  function restoreDrafts() {
    const key = draftStorageKey();
    drafts = {};
    if (!key) return false;
    try {
      const value = JSON.parse(storage.getItem(key) || "{}");
      if (value && typeof value === "object") drafts = value;
    } catch {}
    const latest = Object.values(drafts)
      .sort((left, right) => String(right.updatedAt || "")
        .localeCompare(String(left.updatedAt || "")))[0];
    const annotation = latest && rootFor(latest.rootKey)?.annotations
      ?.find(item => item.id === latest.annotationId);
    if (!annotation) return false;
    Object.assign(ui, {
      activeRootKey: latest.rootKey,
      activeAnnotationId: latest.annotationId,
      activeAssistantComposer: latest.annotationId,
      panelOpen: true
    });
    return true;
  }
  function pendingTask(kind, targetId, subtargetId = "") {
    return ((getSnapshot() || {}).aiTasks || []).find(task => (
      task.kind === kind
      && task.targetId === targetId
      && (!subtargetId || task.subtargetId === subtargetId)
      && ["queued", "running", "cancelling"].includes(task.status)
    ));
  }
  function endpoint(value, suffix = "") {
    const { type, id } = parseAnnotationRootKey(value);
    return `/api/annotations/${encodeURIComponent(type)}/${encodeURIComponent(id)}${suffix}`;
  }
  function reset() {
    Object.assign(ui, {
      pendingSelection: null,
      activeRootKey: "",
      activeAnnotationId: "",
      activeAssistantComposer: "",
      panelOpen: false
    });
    drafts = {};
  }

  return Object.freeze({
    ui,
    rootFor,
    rootLabel: value => ROOT_LABELS[parseAnnotationRootKey(value).type] || "正文",
    endpoint,
    pendingTask,
    stashAssistantDraft,
    saveAssistantDraft,
    clearAssistantDraft,
    hydrateAssistantForm,
    restoreDrafts,
    findTaskAnnotation: target => (
      rootFor(annotationRootKey(target.resourceType, target.targetId))
        ?.annotations?.find(item => item.id === target.subtargetId) || null
    ),
    reset
  });
}
