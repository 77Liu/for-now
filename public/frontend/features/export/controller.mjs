import { createDownloadDescriptor } from "./downloads.mjs";

export const EXPORT_ACCOUNT_ENDPOINT = "/api/v1/exports/account";

export const EXPORT_SELECTORS = Object.freeze({
  summary: "#export-summary",
  status: "#export-status",
  retry: '[data-content-action="retry-export"]',
  format: "[data-export-format]"
});

const EXPORT_FORMATS = new Set(["json", "markdown"]);

const escapeHtml = value => String(value ?? "").replace(/[&<>"]/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
}[character]));

function exportRequestPath(format) {
  return `${EXPORT_ACCOUNT_ENDPOINT}?format=${encodeURIComponent(format)}`;
}

function contentStateMarkup({ kind, title, body, retry = false }) {
  const role = kind === "failure" ? ' role="alert"' : ' role="status"';
  const action = retry
    ? '<button class="quiet-button content-state-action" type="button" data-content-action="retry-export">重新读取</button>'
    : "";
  return `<section class="empty content-state ${kind}"${role}><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p>${action}</section>`;
}

function summaryMarkup(manifest) {
  const summary = manifest?.summary || {};
  return `<dl><div><dt>资源</dt><dd>${escapeHtml(summary.resources)}</dd></div><div><dt>附件</dt><dd>${escapeHtml(summary.attachments)}</dd></div><div><dt>附件引用</dt><dd>${escapeHtml(summary.attachmentReferences)}</dd></div><div><dt>待核对引用</dt><dd>${escapeHtml(summary.orphanReferences)}</dd></div></dl><p>快照版本 ${escapeHtml(manifest?.snapshotVersion)} · 默认排除密钥与模型内部推理。</p>`;
}

export function createExportFeatureController({
  requestV1,
  createObjectURL = blob => globalThis.URL.createObjectURL(blob),
  revokeObjectURL = url => globalThis.URL.revokeObjectURL(url),
  schedule = callback => globalThis.setTimeout(callback, 0),
  cancelScheduled = handle => globalThis.clearTimeout(handle),
  createDescriptor = createDownloadDescriptor
} = {}) {
  for (const [name, value] of Object.entries({
    requestV1,
    createObjectURL,
    revokeObjectURL,
    schedule,
    cancelScheduled,
    createDescriptor
  })) {
    if (typeof value !== "function") {
      throw new TypeError(`Export feature controller requires ${name}`);
    }
  }

  let activation = null;
  let root = null;
  let route = null;
  let signal = null;
  let abortListener = null;
  let manifest = null;
  let manifestState = "idle";
  let manifestRequest = null;
  let stateObserved = false;
  let stateRecoveryUsed = false;
  let downloadRequest = null;
  const objectUrls = new Map();
  const sessionRoots = new Set();

  const isCurrentActivation = candidate => (
    candidate !== null
    && activation === candidate
    && root === candidate.root
    && route === candidate.route
    && signal === candidate.signal
  );

  const isActive = candidate => (
    isCurrentActivation(candidate) && !candidate.signal?.aborted
  );

  const query = (candidate, selector) => (
    isActive(candidate) ? candidate.root.querySelector(selector) : null
  );

  const setStatus = (candidate, message) => {
    const element = query(candidate, EXPORT_SELECTORS.status);
    if (element) element.textContent = String(message ?? "");
  };

  const renderCurrent = candidate => {
    const element = query(candidate, EXPORT_SELECTORS.summary);
    if (!element) return false;
    if (manifestState === "ready" && manifest) {
      element.innerHTML = summaryMarkup(manifest);
    } else if (manifestState === "failure") {
      element.innerHTML = contentStateMarkup({
        kind: "failure",
        title: "暂时无法读取导出范围",
        body: "账户中的原始数据没有变化。请检查网络后重试。",
        retry: true
      });
    } else {
      element.innerHTML = contentStateMarkup({
        kind: "loading",
        title: "正在读取导出范围",
        body: "这里只核对可导出的资源，不会修改原始数据。"
      });
    }
    return true;
  };

  const safeRevokeObjectURL = url => {
    try {
      revokeObjectURL(url);
    } catch {}
  };

  const releaseObjectUrls = () => {
    for (const [url, entry] of objectUrls) {
      if (entry.handle !== undefined) {
        try {
          cancelScheduled(entry.handle);
        } catch {}
      }
      safeRevokeObjectURL(url);
    }
    objectUrls.clear();
  };

  const scheduleObjectUrlRelease = url => {
    const entry = { handle: undefined };
    objectUrls.set(url, entry);
    const release = () => {
      if (objectUrls.get(url) !== entry) return;
      objectUrls.delete(url);
      safeRevokeObjectURL(url);
    };
    try {
      entry.handle = schedule(release);
    } catch {
      release();
    }
  };

  const detach = candidate => {
    if (!isCurrentActivation(candidate)) return false;
    candidate.root.removeEventListener("click", handleClick);
    if (abortListener && candidate.signal?.removeEventListener) {
      candidate.signal.removeEventListener("abort", abortListener);
    }
    activation = null;
    root = null;
    route = null;
    signal = null;
    abortListener = null;
    manifest = null;
    manifestState = "idle";
    manifestRequest = null;
    stateObserved = false;
    stateRecoveryUsed = false;
    downloadRequest = null;
    releaseObjectUrls();
    return true;
  };

  const currentManifestRequest = ticket => (
    manifestRequest === ticket && isActive(ticket.activation)
  );

  const loadManifest = async candidate => {
    if (!isActive(candidate)) return false;
    const ticket = { activation: candidate };
    manifestRequest = ticket;
    manifest = null;
    manifestState = "loading";
    setStatus(candidate, "");
    renderCurrent(candidate);
    try {
      const result = await requestV1(exportRequestPath("manifest"), {
        signal: candidate.signal
      });
      if (!currentManifestRequest(ticket)) return false;
      manifest = result?.data || null;
      manifestState = "ready";
      renderCurrent(candidate);
      setStatus(candidate, "");
      return true;
    } catch {
      if (!currentManifestRequest(ticket)) return false;
      manifest = null;
      manifestState = "failure";
      renderCurrent(candidate);
      setStatus(candidate, "");
      if (stateObserved && !stateRecoveryUsed) {
        stateRecoveryUsed = true;
        void loadManifest(candidate);
      }
      return false;
    }
  };

  const appendDownload = (candidate, descriptor, url) => {
    const createElement = candidate.root.ownerDocument?.createElement;
    if (typeof createElement !== "function" || typeof candidate.root.append !== "function") {
      throw new TypeError("Export root must support creating and appending a download link");
    }
    const link = createElement.call(candidate.root.ownerDocument, "a");
    link.href = url;
    link.download = descriptor.filename;
    candidate.root.append(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
  };

  const currentDownloadRequest = ticket => (
    downloadRequest === ticket && isActive(ticket.activation)
  );

  const downloadFormat = async (candidate, format) => {
    if (!isActive(candidate)) return false;
    if (!EXPORT_FORMATS.has(format)) {
      setStatus(candidate, `不支持的导出格式：${format}`);
      return false;
    }
    const ticket = { activation: candidate };
    downloadRequest = ticket;
    setStatus(candidate, "正在生成导出文件…");
    let url = "";
    try {
      const result = await requestV1(exportRequestPath(format), {
        signal: candidate.signal
      });
      if (!currentDownloadRequest(ticket)) return false;
      const descriptor = createDescriptor(result?.data);
      url = createObjectURL(descriptor.blob);
      if (!currentDownloadRequest(ticket)) {
        safeRevokeObjectURL(url);
        return false;
      }
      appendDownload(candidate, descriptor, url);
      scheduleObjectUrlRelease(url);
      url = "";
      setStatus(candidate, `已生成 ${descriptor.filename}`);
      return true;
    } catch (error) {
      if (url) safeRevokeObjectURL(url);
      if (!currentDownloadRequest(ticket)) return false;
      setStatus(candidate, error?.message || "导出失败，请稍后重试");
      return false;
    }
  };

  function closestWithin(candidate, event, selector) {
    if (!isActive(candidate)) return null;
    const element = event?.target?.closest?.(selector) || null;
    if (!element) return null;
    if (typeof candidate.root.contains === "function" && !candidate.root.contains(element)) return null;
    return element;
  }

  function handleClick(event) {
    const candidate = activation;
    if (!isActive(candidate)) return;
    const retry = closestWithin(candidate, event, EXPORT_SELECTORS.retry);
    if (retry) {
      event.preventDefault?.();
      void loadManifest(candidate);
      return;
    }
    const formatButton = closestWithin(candidate, event, EXPORT_SELECTORS.format);
    if (!formatButton) return;
    event.preventDefault?.();
    void downloadFormat(candidate, String(formatButton.dataset?.exportFormat || ""));
  }

  function unmount() {
    if (activation) detach(activation);
    else {
      manifest = null;
      manifestState = "idle";
      manifestRequest = null;
      stateObserved = false;
      stateRecoveryUsed = false;
      downloadRequest = null;
      releaseObjectUrls();
    }
  }

  function mount(context = {}) {
    unmount();
    const nextRoot = context.root;
    if (
      !nextRoot
      || typeof nextRoot.querySelector !== "function"
      || typeof nextRoot.addEventListener !== "function"
      || typeof nextRoot.removeEventListener !== "function"
    ) {
      throw new TypeError("Export feature mount requires a root event target");
    }
    if (context.signal?.aborted) return () => false;
    const candidate = Object.freeze({
      root: nextRoot,
      route: context.route,
      signal: context.signal
    });
    activation = candidate;
    sessionRoots.add(candidate.root);
    root = candidate.root;
    route = candidate.route;
    signal = candidate.signal;
    candidate.root.addEventListener("click", handleClick);
    let disposed = false;
    const dispose = () => {
      if (disposed) return false;
      disposed = true;
      return detach(candidate);
    };
    if (candidate.signal?.addEventListener) {
      abortListener = dispose;
      candidate.signal.addEventListener("abort", abortListener, { once: true });
    }
    void loadManifest(candidate);
    return dispose;
  }

  function render(context = {}) {
    const candidate = activation;
    if (!candidate) return false;
    if (Object.hasOwn(context, "snapshot")) stateObserved = true;
    if (stateObserved && manifestState === "failure" && !stateRecoveryUsed) {
      stateRecoveryUsed = true;
      void loadManifest(candidate);
      return true;
    }
    return renderCurrent(candidate);
  }

  function resetSession() {
    unmount();
    for (const sessionRoot of sessionRoots) {
      const summary = sessionRoot.querySelector?.(EXPORT_SELECTORS.summary);
      const status = sessionRoot.querySelector?.(EXPORT_SELECTORS.status);
      if (summary) summary.innerHTML = "";
      if (status) status.textContent = "";
    }
    sessionRoots.clear();
  }

  return Object.freeze({
    mount,
    render,
    unmount,
    resetSession
  });
}
