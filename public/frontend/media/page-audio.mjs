function requireFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`Page audio coordinator requires ${name}`);
  }
}

function pauseAndRewind(audio) {
  if (!audio) return false;
  try {
    audio.pause();
  } catch {}
  try {
    audio.currentTime = 0;
  } catch {}
  return true;
}

export function createPageAudioCoordinator({
  createAudio = source => new globalThis.Audio(source),
  createObjectURL = blob => globalThis.URL.createObjectURL(blob),
  revokeObjectURL = url => globalThis.URL.revokeObjectURL(url),
  createAbortController = () => new globalThis.AbortController()
} = {}) {
  requireFunction("createAudio", createAudio);
  requireFunction("createObjectURL", createObjectURL);
  requireFunction("revokeObjectURL", revokeObjectURL);
  requireFunction("createAbortController", createAbortController);

  let session = {};
  let activeAudio = null;
  const managedAudio = new Map();
  const pendingLoads = new Set();

  const safeRevoke = url => {
    try {
      revokeObjectURL(url);
    } catch {}
  };

  const clearSource = audio => {
    try {
      audio.removeAttribute?.("src");
      audio.load?.();
    } catch {}
  };

  const releaseManaged = audio => {
    const entry = managedAudio.get(audio);
    if (!entry) return false;
    managedAudio.delete(audio);
    if (activeAudio === audio) activeAudio = null;
    entry.detachSignal?.();
    for (const [type, listener] of entry.listeners) {
      try {
        audio.removeEventListener?.(type, listener);
      } catch {}
    }
    pauseAndRewind(audio);
    clearSource(audio);
    safeRevoke(entry.url);
    return true;
  };

  const stopAudio = audio => {
    if (!audio) return false;
    if (releaseManaged(audio)) return true;
    if (activeAudio === audio) activeAudio = null;
    return pauseAndRewind(audio);
  };

  const detachTicketSignal = ticket => {
    if (!ticket.detachSignal) return;
    ticket.detachSignal();
    ticket.detachSignal = null;
  };

  const finishTicket = ticket => {
    if (!ticket.live) return false;
    ticket.live = false;
    pendingLoads.delete(ticket);
    detachTicketSignal(ticket);
    return true;
  };

  const cancelTicket = ticket => {
    if (!finishTicket(ticket)) return false;
    try {
      ticket.controller.abort();
    } catch {}
    if (ticket.audio) releaseManaged(ticket.audio);
    return true;
  };

  const cancelPendingLoads = except => {
    let cancelled = false;
    for (const ticket of [...pendingLoads]) {
      if (ticket !== except && cancelTicket(ticket)) cancelled = true;
    }
    return cancelled;
  };

  const ticketIsCurrent = ticket => (
    ticket.live
    && ticket.session === session
    && !ticket.controller.signal.aborted
    && !ticket.externalSignal?.aborted
  );

  const claimAudio = (audio, ticket = null) => {
    if (!audio) return false;
    if (activeAudio === audio) return true;
    cancelPendingLoads(ticket);
    const previous = activeAudio;
    activeAudio = null;
    if (previous) stopAudio(previous);
    activeAudio = audio;
    return true;
  };

  const observeManagedAudio = (audio, entry) => {
    for (const type of ["ended", "error"]) {
      const listener = () => releaseManaged(audio);
      try {
        audio.addEventListener?.(type, listener, { once: true });
        entry.listeners.push([type, listener]);
      } catch {}
    }
  };

  const bindManagedSignal = (audio, signal) => {
    if (!signal?.addEventListener || !managedAudio.has(audio)) return;
    const onAbort = () => releaseManaged(audio);
    signal.addEventListener("abort", onAbort, { once: true });
    const entry = managedAudio.get(audio);
    entry.detachSignal = () => {
      try {
        signal.removeEventListener?.("abort", onAbort);
      } catch {}
    };
    if (signal.aborted) releaseManaged(audio);
  };

  async function playBlob(loadBlob, { signal: externalSignal } = {}) {
    requireFunction("playBlob loadBlob", loadBlob);
    if (externalSignal?.aborted) return null;

    cancelPendingLoads();
    if (activeAudio && managedAudio.has(activeAudio)) stopAudio(activeAudio);

    const controller = createAbortController();
    const ticket = {
      audio: null,
      controller,
      detachSignal: null,
      externalSignal,
      live: true,
      session
    };
    pendingLoads.add(ticket);

    if (externalSignal?.addEventListener) {
      const onAbort = () => cancelTicket(ticket);
      externalSignal.addEventListener("abort", onAbort, { once: true });
      ticket.detachSignal = () => {
        try {
          externalSignal.removeEventListener?.("abort", onAbort);
        } catch {}
      };
    }

    let audio = null;
    let unownedUrl = "";
    try {
      const blob = await loadBlob({ signal: controller.signal });
      if (!ticketIsCurrent(ticket)) return null;

      unownedUrl = createObjectURL(blob);
      audio = createAudio(unownedUrl);
      if (!audio || typeof audio.play !== "function") {
        throw new TypeError("Page audio createAudio must return a playable audio object");
      }

      const entry = {
        detachSignal: null,
        listeners: [],
        url: unownedUrl
      };
      managedAudio.set(audio, entry);
      unownedUrl = "";
      ticket.audio = audio;
      observeManagedAudio(audio, entry);
      claimAudio(audio, ticket);

      await audio.play();
      if (!ticketIsCurrent(ticket) || !managedAudio.has(audio)) {
        releaseManaged(audio);
        return null;
      }

      finishTicket(ticket);
      bindManagedSignal(audio, externalSignal);
      return managedAudio.has(audio) ? audio : null;
    } catch (error) {
      const currentFailure = ticketIsCurrent(ticket);
      if (audio) releaseManaged(audio);
      if (unownedUrl) safeRevoke(unownedUrl);
      if (currentFailure) throw error;
      return null;
    } finally {
      finishTicket(ticket);
    }
  }

  function stopAll() {
    let changed = cancelPendingLoads();
    const current = activeAudio;
    activeAudio = null;
    if (current && !managedAudio.has(current)) {
      pauseAndRewind(current);
      changed = true;
    }
    for (const audio of [...managedAudio.keys()]) {
      if (releaseManaged(audio)) changed = true;
    }
    return changed;
  }

  return Object.freeze({
    claim: audio => claimAudio(audio),
    stop: audio => stopAudio(audio || activeAudio),
    stopAll,
    playBlob,
    resetSession() {
      session = {};
      return stopAll();
    }
  });
}
