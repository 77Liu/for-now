import {
  renderMineSurface,
  renderPermissionSurface,
  scrubMineSurface,
  scrubPermissionSurface
} from "./presentation.mjs";

export const MINE_SHELL_VIEWS = Object.freeze(["mine", "permission", "about"]);

const VIEW_SET = new Set(MINE_SHELL_VIEWS);
const noop = () => {};

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Mine shell feature requires ${name}`);
  }
  return value;
}

export function createMineShellFeatureController({
  view,
  getUser,
  getSnapshot,
  getNotificationUnreadCount,
  getSyncHealth,
  getGovernanceUrl,
  getReleaseVersion,
  setShellVersion,
  getDeniedAccess = () => ({})
} = {}) {
  if (!VIEW_SET.has(view)) {
    throw new TypeError(`Unknown mine shell view: ${view}`);
  }
  if (view === "mine") {
    for (const [name, value] of Object.entries({
      getUser,
      getSnapshot,
      getNotificationUnreadCount,
      getSyncHealth,
      getGovernanceUrl,
      getReleaseVersion,
      setShellVersion
    })) {
      requireFunction(value, name);
    }
  } else if (view === "permission") {
    requireFunction(getDeniedAccess, "getDeniedAccess");
  }

  let activation = null;
  let generation = 0;
  const sessionRoots = new Set();

  const isCurrent = candidate => Boolean(
    candidate
    && activation === candidate
    && candidate.generation === generation
  );
  const isActive = candidate => Boolean(
    isCurrent(candidate)
    && !candidate.signal?.aborted
  );

  const paint = (candidate, context = {}) => {
    if (!isActive(candidate)) return false;
    if (view === "mine") {
      const release = renderMineSurface({
        root: candidate.root,
        user: getUser(),
        snapshot: context.snapshot || getSnapshot(),
        notificationFallback: getNotificationUnreadCount(),
        syncHealth: getSyncHealth(),
        governanceUrl: getGovernanceUrl(),
        releaseVersion: getReleaseVersion()
      });
      setShellVersion(release);
    } else if (view === "permission") {
      const denied = getDeniedAccess(candidate.route) || {};
      if (denied.view || denied.capability) {
        renderPermissionSurface(candidate.root, denied);
      } else {
        scrubPermissionSurface(candidate.root);
      }
    }
    return true;
  };

  const detach = candidate => {
    if (!isCurrent(candidate)) return false;
    activation = null;
    candidate.unlink();
    return true;
  };

  const unmount = () => activation ? detach(activation) : false;

  const mount = ({ root, route, signal } = {}) => {
    unmount();
    if (!root || typeof root !== "object") {
      throw new TypeError(`Mine shell "${view}" requires a root`);
    }
    if (view !== "about" && typeof root.querySelector !== "function") {
      throw new TypeError(`Mine shell "${view}" root must support querySelector`);
    }
    if (signal?.aborted) return () => false;

    const candidate = {
      root,
      route,
      signal,
      generation: ++generation,
      unlink: noop
    };
    const abort = () => {
      if (activation === candidate) detach(candidate);
    };
    if (signal?.addEventListener) {
      signal.addEventListener("abort", abort, { once: true });
      candidate.unlink = () => signal.removeEventListener?.("abort", abort);
    }
    activation = candidate;
    sessionRoots.add(root);
    paint(candidate);

    let disposed = false;
    return () => {
      if (disposed) return false;
      disposed = true;
      return detach(candidate);
    };
  };

  const resetSession = () => {
    generation += 1;
    if (activation) {
      activation.unlink();
      activation = null;
    }
    for (const root of sessionRoots) {
      if (view === "mine") scrubMineSurface(root);
      else if (view === "permission") scrubPermissionSurface(root);
    }
    sessionRoots.clear();
    if (view === "mine") setShellVersion("");
  };

  return Object.freeze({
    mount,
    render(context = {}) {
      return paint(activation, context);
    },
    unmount,
    resetSession
  });
}

export function createMineFeatureController(ports = {}) {
  return createMineShellFeatureController({ ...ports, view: "mine" });
}

export function createPermissionFeatureController(ports = {}) {
  return createMineShellFeatureController({ ...ports, view: "permission" });
}

export function createAboutFeatureController() {
  return createMineShellFeatureController({ view: "about" });
}
