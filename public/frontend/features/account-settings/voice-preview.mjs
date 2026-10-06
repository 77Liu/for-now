import {
  accountTtsVoice,
  speechPreviewPayload
} from "./model.mjs";
import { SETTINGS_SELECTORS } from "./presentation.mjs";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Voice preview controller requires ${name}`);
  }
}

export function createVoicePreviewController({
  requestBlob,
  getSpeech,
  pageAudio,
  createAbortController = () => new AbortController()
} = {}) {
  for (const [name, value] of Object.entries({
    requestBlob,
    getSpeech,
    createAbortController,
    playBlob: pageAudio?.playBlob,
    stopAudio: pageAudio?.stop,
    stopAllAudio: pageAudio?.stopAll
  })) requireFunction(value, name);

  let activation = null;
  let session = {};
  let pending = null;
  let audio = null;
  let playingVoice = "";
  let detachAudio = () => {};
  const roots = new Set();

  const current = candidate => Boolean(
    candidate
    && activation === candidate
    && candidate.session === session
    && !candidate.signal?.aborted
  );
  const query = (candidate, selector) => (
    current(candidate) ? candidate.root.querySelector(selector) : null
  );

  function render(candidate = activation) {
    if (!current(candidate)) return false;
    const button = query(candidate, SETTINGS_SELECTORS.voicePreview);
    if (!button) return false;
    const voice = query(candidate, SETTINGS_SELECTORS.voice)?.value || "";
    const selected = (getSpeech()?.voices || []).find(item => item?.id === voice);
    button.disabled = Boolean(pending) || !Boolean(selected?.samplePath || getSpeech()?.configured);
    const label = audio ? "停止官方音色试音" : "播放所选官方音色试音";
    button.setAttribute?.("aria-label", label);
    button.title = label;
    const icon = button.querySelector?.("[aria-hidden]");
    if (icon) icon.textContent = audio ? "■" : "▶";
    return true;
  }

  function clearAudioListeners() {
    detachAudio();
    detachAudio = () => {};
  }

  function stop({ clearStatus = false } = {}) {
    clearAudioListeners();
    if (pending) {
      pending.controller.abort();
      pending = null;
      pageAudio.stopAll();
    } else if (audio) {
      pageAudio.stop(audio);
    }
    audio = null;
    playingVoice = "";
    const candidate = activation;
    const status = query(candidate, SETTINGS_SELECTORS.voiceStatus);
    if (clearStatus && status) status.textContent = "";
    render(candidate);
  }

  async function toggle(candidate = activation) {
    if (!current(candidate)) return false;
    const control = query(candidate, SETTINGS_SELECTORS.voice);
    const status = query(candidate, SETTINGS_SELECTORS.voiceStatus);
    const voice = String(control?.value || "");
    if (audio && playingVoice === voice) {
      stop({ clearStatus: true });
      return true;
    }
    stop({ clearStatus: true });

    let payload;
    try {
      payload = speechPreviewPayload(voice);
    } catch (error) {
      if (status) status.textContent = error.message;
      return false;
    }

    const controller = createAbortController();
    const ticket = { activation: candidate, controller, session, voice };
    pending = ticket;
    playingVoice = voice;
    if (status) status.textContent = "正在加载官方试音…";
    render(candidate);
    try {
      const selected = (getSpeech()?.voices || []).find(item => item?.id === voice);
      const samplePath = String(selected?.samplePath || "");
      const nextAudio = await pageAudio.playBlob(
        ({ signal }) => samplePath
          ? requestBlob(samplePath, { signal }, { fallback: "试音暂时不可用" })
          : requestBlob("/api/speech/preview", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal
          }, { fallback: "试音暂时不可用" }),
        { signal: controller.signal }
      );
      if (
        !current(candidate)
        || ticket.session !== session
        || pending !== ticket
        || control?.value !== voice
      ) {
        if (nextAudio) pageAudio.stop(nextAudio);
        return false;
      }
      pending = null;
      if (!nextAudio) {
        playingVoice = "";
        if (status) status.textContent = "试音暂时不可用，请稍后再试。";
        render(candidate);
        return false;
      }
      audio = nextAudio;
      const finish = failed => {
        if (audio !== nextAudio) return;
        clearAudioListeners();
        audio = null;
        playingVoice = "";
        const nextStatus = query(candidate, SETTINGS_SELECTORS.voiceStatus);
        if (nextStatus) {
          nextStatus.textContent = failed ? "试音暂时无法播放，请稍后再试。" : "";
        }
        render(candidate);
      };
      const onEnded = () => finish(false);
      const onError = () => finish(true);
      nextAudio.addEventListener?.("ended", onEnded, { once: true });
      nextAudio.addEventListener?.("error", onError, { once: true });
      detachAudio = () => {
        nextAudio.removeEventListener?.("ended", onEnded);
        nextAudio.removeEventListener?.("error", onError);
      };
      if (status) status.textContent = "";
      render(candidate);
      return true;
    } catch {
      if (current(candidate) && pending === ticket) {
        pending = null;
        playingVoice = "";
        if (status) status.textContent = "试音暂时不可用，请稍后再试。";
        render(candidate);
      }
      return false;
    } finally {
      if (pending === ticket) {
        pending = null;
        playingVoice = "";
        render(candidate);
      }
    }
  }

  function closest(candidate, event, selector) {
    if (!current(candidate)) return null;
    const element = event?.target?.closest?.(selector) || null;
    return element && (
      typeof candidate.root.contains !== "function" || candidate.root.contains(element)
    ) ? element : null;
  }

  function handleClick(event) {
    const candidate = activation;
    if (!closest(candidate, event, SETTINGS_SELECTORS.voicePreview)) return;
    event.preventDefault?.();
    void toggle(candidate);
  }

  function handleChange(event) {
    const candidate = activation;
    if (!closest(candidate, event, SETTINGS_SELECTORS.voice)) return;
    stop({ clearStatus: true });
  }

  function detach(candidate) {
    if (activation !== candidate) return false;
    candidate.signal?.removeEventListener?.("abort", candidate.dispose);
    candidate.root.removeEventListener("click", handleClick);
    candidate.root.removeEventListener("change", handleChange);
    stop({ clearStatus: true });
    activation = null;
    return true;
  }

  function mount({ root, signal } = {}) {
    unmount();
    if (!root || !["querySelector", "addEventListener", "removeEventListener"]
      .every(name => typeof root[name] === "function")) {
      throw new TypeError("Voice preview mount requires a root event target");
    }
    let disposed = false;
    let candidate;
    const dispose = () => disposed ? false : (disposed = true, detach(candidate));
    if (signal?.aborted) return dispose;
    candidate = { root, signal, session, dispose };
    activation = candidate;
    roots.add(root);
    root.addEventListener("click", handleClick);
    root.addEventListener("change", handleChange);
    signal?.addEventListener?.("abort", dispose, { once: true });
    render(candidate);
    return dispose;
  }

  function unmount() {
    return activation ? detach(activation) : false;
  }

  function resetSession() {
    unmount();
    session = {};
    stop();
    for (const root of roots) {
      const status = root.querySelector?.(SETTINGS_SELECTORS.voiceStatus);
      if (status) status.textContent = "";
    }
    roots.clear();
  }

  return Object.freeze({ mount, render, toggle, stop, unmount, resetSession });
}
