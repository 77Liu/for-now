import { ownerRootConnected } from "./presentation.mjs";

const noop = () => {};

export function createOwnerLifecycle({ name, requiredCapability, capability }) {
  let activation = null;
  let session = {};
  let generation = 0;
  let revision = 0;
  const roots = new Set();

  const context = candidate => Object.freeze({
    activation: candidate,
    session,
    revision,
    accountId: candidate?.accountId ?? String(capability.accountId() || ""),
    sessionGeneration: candidate?.sessionGeneration ?? capability.sessionGeneration(),
    routeGeneration: candidate?.generation || 0
  });

  const sameSession = ticket => Boolean(
    ticket
    && ticket.session === session
    && ticket.accountId === String(capability.accountId() || "")
    && ticket.sessionGeneration === capability.sessionGeneration()
  );

  const active = ticket => Boolean(
    ticket
    && activation === ticket.activation
    && ticket.routeGeneration === activation?.generation
    && ticket.revision === revision
    && sameSession(ticket)
    && !activation.signal?.aborted
    && ownerRootConnected(activation.root)
    && capability.has(requiredCapability)
  );

  function detach(candidate = activation) {
    if (!candidate || activation !== candidate) return false;
    activation = null;
    revision += 1;
    candidate.signal?.removeEventListener?.("abort", candidate.dispose);
    for (const [type, listener] of candidate.listeners) {
      candidate.root.removeEventListener(type, listener);
    }
    candidate.listeners.length = 0;
    for (const cleanup of candidate.cleanups.splice(0)) cleanup();
    return true;
  }

  function mount({ root, route, signal } = {}) {
    detach();
    if (!root || !["querySelector", "addEventListener", "removeEventListener"]
      .every(method => typeof root[method] === "function")) {
      throw new TypeError(`${name} mount requires a root event target`);
    }
    let disposed = false;
    const candidate = {
      root,
      route,
      signal,
      generation: ++generation,
      accountId: String(capability.accountId() || ""),
      sessionGeneration: capability.sessionGeneration(),
      listeners: [],
      cleanups: [],
      dispose: noop
    };
    const dispose = () => disposed ? false : (disposed = true, detach(candidate));
    candidate.dispose = dispose;
    activation = candidate;
    roots.add(root);
    if (signal?.aborted) {
      dispose();
      return { candidate, dispose, ready: false };
    }
    signal?.addEventListener?.("abort", dispose, { once: true });
    return {
      candidate,
      dispose,
      ready: ownerRootConnected(root) && capability.has(requiredCapability)
    };
  }

  function listen(candidate, type, listener) {
    if (activation !== candidate) return false;
    candidate.root.addEventListener(type, listener);
    candidate.listeners.push([type, listener]);
    return true;
  }

  function cleanup(candidate, operation) {
    if (activation !== candidate || typeof operation !== "function") return false;
    candidate.cleanups.push(operation);
    return true;
  }

  function invalidate() {
    revision += 1;
    return revision;
  }

  function reset(clearRoot) {
    detach();
    session = {};
    revision += 1;
    for (const root of roots) clearRoot(root);
    roots.clear();
  }

  return Object.freeze({
    mount,
    listen,
    cleanup,
    detach,
    invalidate,
    reset,
    context,
    active,
    sameSession,
    currentActivation: () => activation,
    roots
  });
}
