export function createKeepsakeFeatureController(options = {}) {
  let controller = null;
  let moduleRequest = null;

  const ensureController = async () => {
    if (controller) return controller;
    const pending = moduleRequest || import("./controller.mjs");
    moduleRequest = pending;
    try {
      const module = await pending;
      controller ||= module.createKeepsakeFeatureController(options);
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
    openItem(id) {
      return controller?.openItem(id) || false;
    }
  });
}
