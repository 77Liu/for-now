export function createStartupTiming({
  document = globalThis.document,
  location = globalThis.location,
  performance = globalThis.performance
} = {}) {
  const enabled = new URLSearchParams(location.search).has("native-performance");
  const marks = {
    navigationStart: 0,
    moduleLoaded: Number(performance.now().toFixed(1))
  };

  const mark = name => {
    marks[name] = Number(performance.now().toFixed(1));
    return marks[name];
  };
  const adopt = value => {
    for (const [name, recorded] of Object.entries(value || {})) {
      if (Number.isFinite(recorded)) marks[name] = recorded;
    }
  };
  const publish = () => {
    if (!enabled && document.documentElement.dataset.nativePerformance !== "1") return false;
    const metric = document.querySelector("#startup-performance-metric");
    if (!metric) return false;
    const ordered = [
      "moduleLoaded",
      "bootstrapStart",
      "authSessionReady",
      "loadStart",
      "coreSnapshotReady",
      "visibleShell",
      "secondaryReady",
      "stableHome"
    ];
    const segments = {};
    let previous = 0;
    for (const name of ordered) {
      const value = marks[name];
      if (!Number.isFinite(value)) continue;
      segments[name] = Number((value - previous).toFixed(1));
      previous = value;
    }
    metric.textContent = `启动分段 ${JSON.stringify({
      marks,
      segments,
      totalMs: marks.stableHome || previous
    })}`;
    return true;
  };

  return Object.freeze({ enabled, marks, mark, adopt, publish });
}
