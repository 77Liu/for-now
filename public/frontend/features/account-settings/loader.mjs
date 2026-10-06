export function createAccountSettingsFeatureController({ view, ...options } = {}) {
  let controller = null;
  let moduleRequest = null;
  const ensureController = async () => {
    if (controller) return controller;
    if (!["account", "settings"].includes(view)) {
      throw new TypeError(`Unknown account settings view: ${view}`);
    }
    const pending = moduleRequest || import("./index.mjs");
    moduleRequest = pending;
    try {
      const module = await pending;
      controller ||= view === "account"
        ? module.createAccountFeatureController({
          ...options,
          request: options.request?.json
        })
        : module.createSettingsFeatureController(options);
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
    stopAudio() {
      return controller?.stopAudio?.() || false;
    }
  });
}
