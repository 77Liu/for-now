export function createCaptureJournalFeatureController({ page, ...options } = {}) {
  let controller = null;
  let moduleRequest = null;

  const ensureController = async () => {
    if (controller) return controller;
    const pending = moduleRequest || (
      page === "captures"
        ? import("./captures.mjs")
        : page === "journals"
          ? import("./journals.mjs")
          : Promise.reject(new TypeError(`Unknown capture/journal view: ${page}`))
    );
    moduleRequest = pending;
    try {
      const module = await pending;
      controller ||= page === "captures"
        ? module.createCapturesFeatureController(options)
        : module.createJournalsFeatureController(options);
      return controller;
    } catch (error) {
      if (moduleRequest === pending) moduleRequest = null;
      throw error;
    }
  };

  return Object.freeze({
    async mount(context) {
      return (await ensureController()).mount(context);
    },
    render(context) {
      return controller?.render(context) || false;
    },
    unmount() {
      return controller?.unmount() || false;
    },
    resetSession() {
      return controller?.resetSession();
    },
    openComposer(trigger) {
      return controller?.openComposer?.(trigger) || false;
    },
    openQuickVoice(trigger) {
      return controller?.openQuickVoice?.(trigger) || false;
    },
    clearLocalDraft() {
      return controller?.clearLocalDraft?.() || false;
    },
    syncOverflow() {
      return controller?.syncOverflow?.() || false;
    }
  });
}
