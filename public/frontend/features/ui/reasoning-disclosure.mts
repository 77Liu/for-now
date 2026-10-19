/**
 * Shared, collapsed disclosure for actual supplier reasoning.
 * Established: 2026-10-19
 * Status: active
 * Boundary: product DTOs establish permission; this component owns presentation and live buffers only.
 */
type ReasoningResult = {
  reasoningContent?: string;
  reasoningVisibility?: string;
};

const escapeText = (value: string): string => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character] || character);

/** Reads the deployment feature switch already delivered with authenticated startup metadata. @since unreleased */
export function reasoningUiEnabled(): boolean {
  return typeof document !== "undefined"
    && document.documentElement.dataset.aiReasoningUiEnabled === "true";
}

/** Renders a durable result beside its answer, folded on first display and safe as text. @since unreleased */
export function reasoningDisclosureMarkup(
  result: ReasoningResult,
  enabled = reasoningUiEnabled()
): string {
  const text = result.reasoningVisibility === "user_viewable"
    ? String(result.reasoningContent || "").trim()
    : "";
  if (!enabled || !text) return "";
  return `<details class="reasoning-disclosure"><summary>推理</summary>`
    + `<div class="reasoning-text">${escapeText(text)}</div></details>`;
}

/** Owns one live disclosure; closing or invalidating its session releases the buffer. @since unreleased */
export function createReasoningDisclosure({
  host,
  isCurrent,
  enabled = reasoningUiEnabled
}: {
  host: HTMLElement;
  isCurrent: () => boolean;
  enabled?: () => boolean;
}) {
  let text = "";
  let disposed = false;
  let details: HTMLDetailsElement | null = null;
  let body: HTMLDivElement | null = null;
  const clear = () => {
    disposed = true;
    text = "";
    details?.remove();
    details = null;
    body = null;
  };
  const render = () => {
    if (disposed || !isCurrent()) return clear();
    if (!enabled() || !text.trim()) return;
    if (!details) {
      details = host.ownerDocument.createElement("details");
      details.className = "reasoning-disclosure";
      const summary = host.ownerDocument.createElement("summary");
      summary.textContent = "推理";
      body = host.ownerDocument.createElement("div");
      body.className = "reasoning-text";
      details.append(summary, body);
      host.append(details);
    }
    if (body) body.textContent = text;
  };
  return Object.freeze({
    append(delta: string) {
      if (disposed || !isCurrent()) return clear();
      text += delta;
      render();
    },
    replace(result: ReasoningResult) {
      if (disposed || !isCurrent()) return clear();
      text = result.reasoningVisibility === "user_viewable"
        ? String(result.reasoningContent || "")
        : "";
      if (!text) {
        details?.remove();
        details = null;
        body = null;
      }
      render();
    },
    dispose: clear
  });
}
