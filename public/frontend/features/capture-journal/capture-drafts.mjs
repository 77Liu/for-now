function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Capture draft store requires ${name}`);
  }
  return value;
}

const formIdentity = index => `form:${index}`;
const fieldIdentity = (field, index) => (
  field.type === "radio" && field.name
    ? `name:${field.name}:value:${field.value}`
    : field.name ? `name:${field.name}` : field.id ? `id:${field.id}` : `field:${index}`
);

function captureForms(forms) {
  const active = forms[0]?.ownerDocument?.activeElement;
  return [...forms].map((form, index) => ({
    key: formIdentity(index),
    hidden: form.hidden,
    requestId: form.dataset.requestId || "",
    fields: [...form.querySelectorAll("input,textarea,select")].flatMap(
      (field, fieldIndex) => field.type === "file" ? [] : [{
        key: fieldIdentity(field, fieldIndex),
        value: field.value,
        checked: ["checkbox", "radio"].includes(field.type) ? field.checked : null,
        focused: field === active,
        selectionStart: typeof field.selectionStart === "number" ? field.selectionStart : null,
        selectionEnd: typeof field.selectionEnd === "number" ? field.selectionEnd : null
      }]
    )
  }));
}

function restoreForms(forms, drafts) {
  let focused = null;
  for (const [index, form] of [...forms].entries()) {
    const draft = drafts.find(item => item.key === formIdentity(index));
    if (!draft) continue;
    form.hidden = draft.hidden;
    if (draft.requestId) form.dataset.requestId = draft.requestId;
    const fields = [...form.querySelectorAll("input,textarea,select")];
    for (const [fieldIndex, field] of fields.entries()) {
      if (field.type === "file") continue;
      const saved = draft.fields.find(item => item.key === fieldIdentity(field, fieldIndex));
      if (!saved) continue;
      if (saved.checked !== null) field.checked = saved.checked;
      else field.value = saved.value;
      if (saved.focused) focused = { field, saved };
    }
  }
  if (focused) {
    focused.field.focus({ preventScroll: true });
    if (focused.saved.selectionStart !== null
      && typeof focused.field.setSelectionRange === "function") {
      focused.field.setSelectionRange(
        focused.saved.selectionStart,
        focused.saved.selectionEnd
      );
    }
  }
  return focused?.field || null;
}

export function createCaptureDraftStore({
  storage,
  getAccountId
} = {}) {
  requireFunction(storage?.getItem, "storage.getItem");
  requireFunction(storage?.setItem, "storage.setItem");
  requireFunction(storage?.removeItem, "storage.removeItem");
  requireFunction(getAccountId, "getAccountId");

  const key = () => {
    const accountId = String(getAccountId() || "");
    return accountId ? `cike:session-drafts:${accountId}` : "";
  };
  const read = () => {
    const storageKey = key();
    if (!storageKey) return null;
    try {
      return JSON.parse(storage.getItem(storageKey) || "null");
    } catch {
      return null;
    }
  };
  const write = payload => {
    const storageKey = key();
    if (!storageKey) return false;
    try {
      storage.setItem(storageKey, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    captureForm(form) {
      return form ? captureForms([form])[0] : null;
    },
    restoreForm(form, draft) {
      return form && draft
        ? restoreForms([form], [{ ...draft, key: formIdentity(0) }])
        : false;
    },
    save(form, tags, { editing = false } = {}) {
      if (!key() || !form) return false;
      const payload = read() || {};
      if (!editing) {
        payload.captureForm = { ...captureForms([form])[0], key: formIdentity(0) };
        payload.captureDraftTags = [...tags];
      }
      return write(payload);
    },
    restore(form) {
      if (!key() || !form) return null;
      const payload = read();
      if (!payload) return null;
      const legacy = (payload.forms || []).find(item => item.key === "form:2");
      const draft = payload.captureForm || legacy;
      if (draft) restoreForms([form], [{ ...draft, key: formIdentity(0) }]);
      return {
        restored: Boolean(draft),
        tags: Array.isArray(payload.captureDraftTags) ? payload.captureDraftTags : []
      };
    },
    clear() {
      const payload = read();
      if (!payload) return false;
      delete payload.captureForm;
      delete payload.captureDraftTags;
      payload.forms = (payload.forms || []).filter(item => item.key !== "form:2");
      return write(payload);
    }
  });
}
