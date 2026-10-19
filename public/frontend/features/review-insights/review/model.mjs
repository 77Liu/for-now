export const REVIEW_DOMAINS = Object.freeze(new Set([
  "review",
  "insights",
  "clusters",
  "experiments",
  "customMetrics",
  "analyses",
  "checkins",
  "dailyRecords",
  "captures",
  "journals",
  "thoughts"
]));

export function reviewDomainsChanged(changedDomains) {
  if (changedDomains == null) return true;
  const values = typeof changedDomains === "string"
    ? [changedDomains]
    : changedDomains;
  try {
    return [...values].some(domain => REVIEW_DOMAINS.has(domain));
  } catch {
    return false;
  }
}

export function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + Number(value), 0) / values.length
    : null;
}

export function hasReviewSource(snapshot = {}) {
  if (Number(snapshot.reviewSourceCount) > 0) return true;
  return [
    snapshot.checkins,
    snapshot.dailyRecords,
    snapshot.captures,
    snapshot.journals,
    snapshot.thoughts
  ].some(collection => Array.isArray(collection) && collection.length > 0);
}

export function sanitizeAnalysisRecord(value, clone = structuredClone) {
  const item = clone(value || {});
  if (item.reasoningVisibility !== "user_viewable") {
    delete item.reasoningContent;
    delete item.reasoningVisibility;
  }
  delete item.contentTruncated;
  for (const annotation of [
    ...(item.annotations || []),
    ...(item.annotationDrift || [])
  ]) {
    for (const exchange of annotation.shenji || []) {
      if (exchange.reasoningVisibility !== "user_viewable") {
        delete exchange.reasoningContent;
        delete exchange.reasoningVisibility;
      }
    }
  }
  return item;
}

export function experimentViewModel(item, checkins, {
  now = Date.now(),
  metricLabel = key => key
} = {}) {
  const start = new Date(item.createdAt);
  const elapsed = Math.max(
    1,
    Math.floor((now - start.getTime()) / 86400000) + 1
  );
  const relevant = (checkins || []).filter(checkin => (
    new Date(checkin.occurredAt || checkin.createdAt) >= start
  ));
  const withFactor = relevant.filter(checkin => (
    (checkin.factors || []).includes(item.factor)
  ));
  const withoutFactor = relevant.filter(checkin => (
    !(checkin.factors || []).includes(item.factor)
  ));
  const metric = ["mood", "energy", "stress", "sleep"].includes(item.outcome)
    ? item.outcome
    : "mood";
  const withAverage = average(withFactor
    .map(checkin => checkin[metric])
    .filter(Number.isFinite));
  const withoutAverage = average(withoutFactor
    .map(checkin => checkin[metric])
    .filter(Number.isFinite));
  const enough = withFactor.length >= 3 && withoutFactor.length >= 3;
  return {
    elapsed: Math.min(elapsed, Number(item.duration) || 30),
    duration: Number(item.duration) || 30,
    metric,
    metricLabel: metricLabel(metric),
    result: enough
      ? `有因素 ${withAverage.toFixed(1)} / 无因素 ${withoutAverage.toFixed(1)}，差值 ${(withAverage - withoutAverage).toFixed(1)}`
      : `有因素 ${withFactor.length} 次 / 无因素 ${withoutFactor.length} 次；两边各满 3 次后开始显示线索`
  };
}
