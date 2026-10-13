const formIdentity = (form, index) => `form:${index}`;

function formFieldIdentity(field, index) {
  if (field instanceof HTMLInputElement && field.type === "radio" && field.name) {
    return `name:${field.name}:value:${field.value}`;
  }
  return field.name ? `name:${field.name}` : field.id ? `id:${field.id}` : `field:${index}`;
}

function captureForms(forms, document) {
  const active = document.activeElement;
  return [...forms].map((form, index) => ({
    key: formIdentity(form, index),
    hidden: form.hidden,
    requestId: form.dataset.requestId || "",
    fields: [...form.querySelectorAll("input,textarea,select")].map((field, fieldIndex) => ({
      key: formFieldIdentity(field, fieldIndex),
      value: field.value,
      checked: field instanceof HTMLInputElement
        && ["checkbox", "radio"].includes(field.type)
        ? field.checked
        : null,
      focused: field === active,
      selectionStart: typeof field.selectionStart === "number" ? field.selectionStart : null,
      selectionEnd: typeof field.selectionEnd === "number" ? field.selectionEnd : null,
      ...(field.dataset?.occurrenceMode
        ? { occurrenceMode: field.dataset.occurrenceMode }
        : {})
    }))
  }));
}

function restoreForms(forms, drafts) {
  let focusedField = null;
  let selectionStart = null;
  let selectionEnd = null;
  for (const [index, form] of forms.entries()) {
    const draft = drafts.find(item => item.key === formIdentity(form, index));
    if (!draft) continue;
    form.hidden = draft.hidden;
    if (draft.requestId) form.dataset.requestId = draft.requestId;
    const fields = [...form.querySelectorAll("input,textarea,select")];
    for (const [fieldIndex, field] of fields.entries()) {
      const key = formFieldIdentity(field, fieldIndex);
      const saved = draft.fields.find(item => item.key === key);
      if (!saved) continue;
      if (saved.checked !== null) field.checked = saved.checked;
      else field.value = saved.value;
      if (field.dataset && ["now", "manual"].includes(saved.occurrenceMode)) {
        field.dataset.occurrenceMode = saved.occurrenceMode;
      }
      if (saved.focused) {
        focusedField = field;
        selectionStart = saved.selectionStart;
        selectionEnd = saved.selectionEnd;
      }
    }
  }
  if (focusedField) {
    focusedField.focus({ preventScroll: true });
    if (selectionStart !== null && typeof focusedField.setSelectionRange === "function") {
      focusedField.setSelectionRange(selectionStart, selectionEnd);
    }
  }
  return focusedField;
}

export function createDurableFormDrafts({
  document = globalThis.document,
  storage = globalThis.sessionStorage,
  formIds = [],
  getOwner,
  getDraftTags,
  setDraftTags,
  onRestore
} = {}) {
  const storageKey = () => {
    const owner = getOwner?.();
    return owner ? `cike:session-drafts:${owner}` : "";
  };
  const forms = () => formIds.map(id => document.getElementById(id)).filter(Boolean);

  const save = () => {
    const key = storageKey();
    if (!key) return false;
    let previous = null;
    try { previous = JSON.parse(storage.getItem(key) || "null"); } catch {}
    const payload = {
      ...(previous || {}),
      forms: captureForms(forms(), document),
      draftTags: getDraftTags?.() || []
    };
    try {
      storage.setItem(key, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };
  const restore = () => {
    const key = storageKey();
    if (!key) return false;
    try {
      const payload = JSON.parse(storage.getItem(key) || "null");
      if (!payload) return false;
      restoreForms(forms(), payload.forms || []);
      setDraftTags?.(Array.isArray(payload.draftTags) ? payload.draftTags : []);
      onRestore?.();
      return true;
    } catch {
      return false;
    }
  };
  const clear = (formId = "") => {
    const key = storageKey();
    if (!key) return false;
    if (!formId) {
      storage.removeItem(key);
      return true;
    }
    save();
    try {
      const payload = JSON.parse(storage.getItem(key) || "null");
      if (!payload) return false;
      payload.forms = (payload.forms || [])
        .filter(item => item.key !== `form:${formIds.indexOf(formId)}`);
      storage.setItem(key, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };

  return Object.freeze({ save, restore, clear });
}
