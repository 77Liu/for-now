const noop = () => {};

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Home feature requires ${name}`);
  }
  return value;
}

export function createHomeFeatureController({
  coordinator,
  loadWorkspace,
  showToast = noop,
  prompt = (...args) => globalThis.prompt(...args),
  confirm = (...args) => globalThis.confirm(...args)
} = {}) {
  requireFunction(coordinator?.load, "coordinator.load");
  requireFunction(coordinator?.subscribe, "coordinator.subscribe");
  requireFunction(coordinator?.viewModel, "coordinator.viewModel");
  requireFunction(coordinator?.resetSession, "coordinator.resetSession");
  requireFunction(loadWorkspace, "loadWorkspace");
  requireFunction(showToast, "showToast");
  requireFunction(prompt, "prompt");
  requireFunction(confirm, "confirm");

  let activation = null;
  let workspaceController = null;
  let workspaceRequest = null;
  let generation = 0;

  const renderSummary = (root, snapshot) => {
    const summary = root.querySelector?.("#actions-summary");
    if (!summary) return false;
    const view = coordinator.viewModel(snapshot);
    summary.textContent = `${view.summary.openActions} 项待推进 · ${view.summary.checkedToday}/${view.summary.activeHabits} 个习惯已打卡`;
    return true;
  };

  const current = candidate => Boolean(
    candidate
    && activation === candidate
    && !candidate.signal?.aborted
  );

  const ensureWorkspace = async candidate => {
    if (!current(candidate)
        || !candidate.details?.open
        || candidate.mounted
        || candidate.loading) return false;
    candidate.loading = true;
    try {
      const feature = await (workspaceRequest ||= loadWorkspace());
      if (!current(candidate)) return false;
      workspaceController ||= feature.createActionsFeatureController({
        coordinator,
        showToast,
        prompt,
        confirm
      });
      workspaceController.mount(candidate.context);
      candidate.mounted = true;
      workspaceController.render();
      return true;
    } catch (error) {
      workspaceRequest = null;
      if (current(candidate)) showToast(`行动与习惯加载失败：${error.message}`, "error");
      return false;
    } finally {
      if (current(candidate)) candidate.loading = false;
    }
  };

  const unmount = async () => {
    const candidate = activation;
    if (!candidate) return false;
    activation = null;
    candidate.details?.removeEventListener?.("toggle", candidate.toggle);
    candidate.signal?.removeEventListener?.("abort", candidate.abort);
    candidate.unsubscribe?.();
    if (candidate.mounted) await workspaceController?.unmount?.();
    return true;
  };

  return Object.freeze({
    async mount(context = {}) {
      await unmount();
      if (!context.root || typeof context.root !== "object") {
        throw new TypeError("Home feature requires a root");
      }
      if (context.signal?.aborted) {
        throw new DOMException("Feature activation changed", "AbortError");
      }
      const candidate = {
        context,
        root: context.root,
        signal: context.signal,
        generation: ++generation,
        snapshot: {},
        details: context.root.querySelector?.(".home-v02-secondary"),
        mounted: false,
        loading: false,
        unsubscribe: noop,
        toggle: null,
        abort: null
      };
      candidate.toggle = () => void ensureWorkspace(candidate);
      candidate.abort = () => {
        if (activation === candidate) void unmount();
      };
      activation = candidate;
      candidate.details?.addEventListener?.("toggle", candidate.toggle);
      candidate.signal?.addEventListener?.("abort", candidate.abort, { once: true });
      candidate.unsubscribe = coordinator.subscribe(snapshot => {
        candidate.snapshot = snapshot;
        renderSummary(candidate.root, snapshot);
      });
      if (candidate.details?.open) candidate.toggle();
      return unmount;
    },
    render(context = {}) {
      const candidate = activation;
      if (!current(candidate)) return false;
      void coordinator.load({ ensure: true });
      return candidate.mounted
        ? workspaceController?.render?.({ ...context, snapshot: undefined })
        : false;
    },
    unmount,
    async resetSession() {
      generation += 1;
      await unmount();
      await workspaceController?.resetSession?.();
      workspaceController = null;
      workspaceRequest = null;
      coordinator.resetSession();
    }
  });
}
