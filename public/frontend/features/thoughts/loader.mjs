export function createThoughtsFeatureController(options = {}) {
  let controller = null;
  let moduleRequest = null;

  const ensureController = async () => {
    if (controller) return controller;
    const pending = moduleRequest || import("./controller.mjs");
    moduleRequest = pending;
    try {
      const module = await pending;
      controller ||= module.createThoughtsFeatureController(options);
      return controller;
    } catch (error) {
      if (moduleRequest === pending) moduleRequest = null;
      throw error;
    }
  };

  return Object.freeze({
    async mount(context) {
      const feature = await ensureController();
      return feature.mount(context);
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
    patchTarget(target) {
      return controller?.patchTarget(target) || false;
    },
    reconcileRoute() {
      return controller?.reconcileRoute() || false;
    }
  });
}
