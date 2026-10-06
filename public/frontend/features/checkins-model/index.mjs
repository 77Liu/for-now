const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export const BASE_CHECKIN_METRICS = Object.freeze({
  mood: Object.freeze({
    label: "情绪",
    anchors: Object.freeze(["非常难受", "有些低落", "平稳、无明显起伏", "感觉不错", "轻盈而愉快"])
  }),
  energy: Object.freeze({
    label: "精力",
    anchors: Object.freeze(["几乎耗尽", "勉强支撑", "够用，但有限", "精力较好", "充沛、想行动"])
  }),
  stress: Object.freeze({
    label: "压力",
    anchors: Object.freeze(["快要撑不住", "很紧绷", "压力明显但可应对", "有一点紧绷", "身心松弛"])
  }),
  sleep: Object.freeze({
    label: "睡眠",
    anchors: Object.freeze(["几乎没休息好", "明显不足", "基本够用", "睡得不错", "充分恢复"])
  })
});

const text = value => typeof value === "string" ? value.trim() : "";
const timestamp = item => text(item?.occurredAt || item?.createdAt);
const round = value => Math.round(value * 100) / 100;

function dateKey(item) {
  return text(item?.occurredOn) || timestamp(item).slice(0, 10);
}

function shiftDateKey(value, offset) {
  if (!DATE_KEY.test(value)) return "";
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
}

function mean(items, select) {
  const values = items.map(select).map(Number).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function createCheckinMetricConfig(customMetrics = []) {
  const custom = Object.fromEntries((Array.isArray(customMetrics) ? customMetrics : []).map(metric => [
    metric.id,
    {
      label: metric.name,
      anchors: [metric.low, "偏低", "居中", "偏高", metric.high],
      custom: true
    }
  ]));
  return { ...BASE_CHECKIN_METRICS, ...custom };
}

export function checkinMetricValue(checkin, key, custom = false) {
  return custom ? checkin?.custom?.[key] : checkin?.[key];
}

export function buildHomeMoodSeries(checkins = [], endDate, days = 7) {
  if (!DATE_KEY.test(endDate) || !Number.isInteger(days) || days < 1) return [];
  const dates = Array.from({ length: days }, (_, index) => shiftDateKey(endDate, index - days + 1));
  const groups = new Map(dates.map(date => [date, []]));
  for (const item of checkins) {
    const date = dateKey(item);
    const mood = Number(item?.mood);
    if (groups.has(date) && Number.isFinite(mood) && mood >= 1 && mood <= 5) {
      groups.get(date).push(mood);
    }
  }
  return dates.map(date => {
    const values = groups.get(date);
    return {
      date,
      count: values.length,
      value: values.length ? mean(values, value => value) : null
    };
  });
}

export function buildCheckinTrend(checkins = [], customMetrics = [], {
  endDate,
  days = 30
} = {}) {
  if (!DATE_KEY.test(endDate)) {
    return { available: [], eligible: [], daily: [], series: [], current: null };
  }
  const range = Number(days);
  const safeDays = Number.isInteger(range) && range > 0 ? range : 30;
  const cutoff = shiftDateKey(endDate, -(safeDays - 1));
  const available = (Array.isArray(checkins) ? checkins : [])
    .filter(item => dateKey(item) <= endDate)
    .sort((left, right) => timestamp(right).localeCompare(timestamp(left)));
  const eligible = available.filter(item => dateKey(item) >= cutoff);
  const groups = new Map();
  for (const item of eligible) {
    const date = dateKey(item);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(item);
  }
  const daily = [...groups.keys()].sort().map(date => {
    const entries = groups.get(date);
    const mood = mean(entries, item => item.mood);
    const energy = mean(entries, item => item.energy);
    const stress = mean(entries, item => item.stress);
    const sleep = mean(entries, item => item.sleep);
    const composite = [mood, energy, stress, sleep].every(Number.isFinite)
      ? 0.3 * mood + 0.3 * energy + 0.25 * sleep + 0.15 * stress
      : null;
    return {
      date,
      entries: entries.length,
      mood,
      energy,
      stress,
      sleep,
      composite,
      score: composite == null ? null : Math.round((composite - 1) * 25),
      custom: Object.fromEntries((Array.isArray(customMetrics) ? customMetrics : []).map(metric => [
        metric.id,
        mean(entries, item => item.custom?.[metric.id])
      ]))
    };
  });
  const palette = ["#7885c8", "#70a68c", "#d39a78", "#a990c8", "#7aa8b8", "#b2a56b", "#cb87a1"];
  const series = [
    { key: "mood", label: "情绪", color: palette[0] },
    { key: "energy", label: "精力", color: palette[1] },
    { key: "stress", label: "压力", color: palette[2] },
    { key: "sleep", label: "睡眠", color: palette[3] },
    ...(Array.isArray(customMetrics) ? customMetrics : []).map((metric, index) => ({
      key: `custom.${metric.id}`,
      label: metric.name,
      color: palette[(index + 4) % palette.length]
    }))
  ];
  return {
    available,
    eligible,
    daily,
    series,
    current: daily.at(-1) || null,
    round
  };
}
