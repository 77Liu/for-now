export const CONTENT_IMAGE_DRAFT_KEYS = Object.freeze(
  ["capture", "thoughtRoot", "thoughtBlock", "comment"]
);

export function copyDraftContext(value) {
  return value == null ? value : structuredClone(value);
}

export function copyDraftItem(item) {
  return {
    ...item,
    ...(item.lastError ? { lastError: { ...item.lastError } } : {})
  };
}

export function emptyContentImageDraft() {
  return {
    items: [],
    uploadRequestId: "",
    context: null,
    revision: 0
  };
}

export function hasContentImageDraft(draft) {
  return Boolean(
    draft
    && (draft.items.length || draft.uploadRequestId || draft.context != null)
  );
}

export function contentImageLeaseIdentity(owner, item, fallbackRequestId = "") {
  const path = String(item?.uploadedPath || "");
  const requestId = String(item?.uploadRequestId || fallbackRequestId || "");
  return path && requestId ? JSON.stringify([owner, path, requestId]) : "";
}

export function isUncertainContentImageSubmission(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  return !status || [408, 425, 429].includes(status) || status >= 500;
}
