// Values are transcribed observations, not inferred measurements or diagnoses.
import { promptText, renderPrompt } from "../../shared/prompts/index.mjs";
import { nullableNumber, safeText } from "../../shared/validation/index.mjs";

const weightFields = {
  measuredWeight: ["秤上体重", "kg", 20, 400],
  bmi: ["BMI", "", 1, 150],
  bodyFatMass: ["脂肪量", "kg", 0, 400],
  bodyFatPercent: ["体脂率", "%", 0, 100],
  bodyWaterMass: ["体水分", "kg", 0, 400],
  bodyWaterPercent: ["水分比例", "%", 0, 100],
  proteinMass: ["蛋白质量", "kg", 0, 400],
  proteinPercent: ["蛋白质比例", "%", 0, 100],
  boneMineralMass: ["骨盐量", "kg", 0, 100],
  boneMineralPercent: ["骨盐比例", "%", 0, 100],
  muscleMass: ["肌肉量", "kg", 0, 400],
  musclePercent: ["肌肉比例", "%", 0, 100],
  skeletalMuscleMass: ["骨骼肌量", "kg", 0, 400],
  visceralFatLevel: ["内脏脂肪等级", "", 0, 100],
  basalMetabolism: ["基础代谢", "kcal/日", 0, 10000],
  waistHipRatio: ["腰臀比", "", 0, 5],
  bodyAge: ["身体年龄", "岁", 1, 150]
};
const exerciseFields = {
  durationSeconds: ["运动时长", "秒", 0, 604800, true],
  activeCalories: ["活动热量", "kcal", 0, 100000],
  totalCalories: ["总热量", "kcal", 0, 100000],
  averageHeartRate: ["平均心率", "bpm", 20, 250],
  maximumHeartRate: ["最大心率", "bpm", 20, 250],
  distanceKm: ["距离", "km", 0, 10000],
  warmUpSeconds: ["热身", "秒", 0, 604800, true],
  fatBurnSeconds: ["燃脂", "秒", 0, 604800, true],
  aerobicSeconds: ["有氧", "秒", 0, 604800, true],
  anaerobicSeconds: ["无氧", "秒", 0, 604800, true],
  extremeSeconds: ["极限", "秒", 0, 604800, true]
};
const fieldsFor = kind => kind === "weight" ? weightFields : exerciseFields;
const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const number = (value, [, , min, max, integer]) => {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max && (!integer || Number.isInteger(parsed)) ? parsed : null;
};
function localTimestamp(value) {
  const raw = text(value, 40).replace(" ", "T");
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!match || !validDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59) return "";
  return `${match[1]}T${match[2]}:${match[3]}:${match[4] || "00"}`;
}
function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function recognizedDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : "";
}
function recognizedLocalDateTime(value) {
  const normalized = safeText(value, 40).replace(" ", "T");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?/.exec(normalized);
  return match ? `${match[1]}:${match[2] || "00"}` : "";
}

export function normalizeHealthDetails(kind, value = {}) {
  const result = Object.fromEntries(Object.entries(fieldsFor(kind)).map(([key, config]) => [key, number(value[key], config)]));
  return {
    ...result,
    ...(kind === "exercise" ? {
      exerciseType: text(value.exerciseType, 100),
      recognitionDescription: text(value.recognitionDescription, 5000)
    } : {}),
    description: text(value.description, 5000),
    verification: text(value.verification, 800)
  };
}

export function normalizeHealthImage(kind, value = {}) {
  if (kind === "sleep") {
    const deepMinutes = nullableNumber(value.deepMinutes, 0, 1440, true);
    const lightMinutes = nullableNumber(value.lightMinutes, 0, 1440, true);
    const remMinutes = nullableNumber(value.remMinutes, 0, 1440, true);
    const stageTotal = [deepMinutes, lightMinutes, remMinutes].every(Number.isFinite)
      ? deepMinutes + lightMinutes + remMinutes
      : null;
    return {
      date: recognizedDate(value.date),
      bedtime: recognizedLocalDateTime(value.bedtime),
      wakeTime: recognizedLocalDateTime(value.wakeTime),
      totalMinutes: nullableNumber(value.totalMinutes, 0, 1440, true) ?? stageTotal,
      deepMinutes,
      deepPercent: nullableNumber(value.deepPercent, 0, 100),
      lightMinutes,
      lightPercent: nullableNumber(value.lightPercent, 0, 100),
      remMinutes,
      remPercent: nullableNumber(value.remPercent, 0, 100),
      awakeCount: nullableNumber(value.awakeCount, 0, 100, true),
      awakeMinutes: nullableNumber(value.awakeMinutes, 0, 1440, true),
      averageHeartRate: nullableNumber(value.averageHeartRate, 20, 250),
      averageOxygen: nullableNumber(value.averageOxygen, 50, 100),
      respiratoryRate: nullableNumber(value.respiratoryRate, 1, 80),
      verification: safeText(value.verification, 500)
    };
  }
  if (kind === "heartRate") {
    return {
      date: recognizedDate(value.date),
      minimum: nullableNumber(value.minimum, 20, 250),
      maximum: nullableNumber(value.maximum, 20, 250),
      average: nullableNumber(value.average, 20, 250),
      resting: nullableNumber(value.resting, 20, 250),
      sleepAverage: nullableNumber(value.sleepAverage, 20, 250),
      trendAnalysis: safeText(value.trendAnalysis, 1200),
      trendSegments: (Array.isArray(value.trendSegments) ? value.trendSegments : [])
        .slice(0, 8)
        .map(item => ({
          period: safeText(item?.period, 80),
          direction: ["下降", "上升", "平稳", "波动"].includes(item?.direction)
            ? item.direction
            : "波动",
          approximateRange: safeText(item?.approximateRange, 80)
        }))
        .filter(item => item.period),
      verification: safeText(value.verification, 500)
    };
  }
  const timeKey = kind === "weight" ? "measuredAt" : "startedAt";
  const details = normalizeHealthDetails(kind, value);
  if (kind === "exercise") {
    details.recognitionDescription ||= details.description;
    details.description = details.recognitionDescription;
  }
  return {
    ...details,
    date: validDate(value.date) ? value.date : "",
    [timeKey]: localTimestamp(value[timeKey])
  };
}

export function hasHealthContent(kind, value) {
  return Boolean(value.description || (kind === "exercise" && (value.exerciseType || value.recognitionDescription))
    || Object.keys(fieldsFor(kind)).some(key => Number.isFinite(value[key])));
}

export function healthDetailsError(kind, value) {
  if (kind !== "exercise") return "";
  if (value.averageHeartRate != null && value.maximumHeartRate != null && value.averageHeartRate > value.maximumHeartRate) return "平均心率不能高于最大心率";
  if (value.activeCalories != null && value.totalCalories != null && value.activeCalories > value.totalCalories) return "活动热量不能高于总热量，请核对截图";
  const zones = ["warmUpSeconds", "fatBurnSeconds", "aerobicSeconds", "anaerobicSeconds", "extremeSeconds"];
  if (value.durationSeconds != null && zones.reduce((sum, key) => sum + (value[key] ?? 0), 0) > value.durationSeconds) return "心率区间时长合计不能超过运动时长";
  return "";
}

export function describeHealthDetails(kind, item, { includeDerived = false } = {}) {
  const values = Object.entries(fieldsFor(kind)).filter(([key]) => Number.isFinite(item[key]))
    .map(([key, [label, unit]]) => `${label}${item[key]}${unit}`);
  if (kind === "exercise" && item.exerciseType) values.unshift(item.exerciseType);
  if (kind === "weight") {
    if (item.measuredWeight == null) values.unshift("总重量未填写");
    if (Number.isFinite(item.adjustedWeight)) values.push(`衣物校正后${item.adjustedWeight}kg${item.clothing !== "none" ? `（95%估计区间${item.lower95}～${item.upper95}kg）` : ""}`);
  }
  if (kind === "exercise" && item.description) values.push(`感受或历史描述：${item.description}`);
  else if (item.description) values.push(item.description);
  if (kind === "exercise" && includeDerived && item.recognitionDescription) values.push(`AI解析：${item.recognitionDescription}`);
  return `${kind === "weight" ? "体重/体成分" : "运动"}：${values.join("；")}`;
}

export function describeDailyRecord(item) {
  if (item.type === "sleep") return `睡眠：${item.totalMinutes == null ? "时长未填" : `${item.totalMinutes}分钟`}；深睡${item.deepMinutes ?? "?"} / 浅睡${item.lightMinutes ?? "?"} / REM${item.remMinutes ?? "?"}分钟；睡眠心率${item.averageHeartRate ?? "?"}；血氧${item.averageOxygen ?? "?"}%`;
  if (item.type === "heartRate") return `心率：范围${item.minimum ?? "?"}～${item.maximum ?? "?"}，平均${item.average ?? "?"}，静息${item.resting ?? "?"}，睡眠平均${item.sleepAverage ?? "?"} bpm${item.trendAnalysis ? `；趋势：${item.trendAnalysis}` : ""}`;
  return describeHealthDetails(item.type, item);
}

const schemaFor = kind => JSON.stringify({
  date: null,
  [kind === "weight" ? "measuredAt" : "startedAt"]: null,
  ...(kind === "exercise" ? { exerciseType: null } : {}),
  ...Object.fromEntries(Object.keys(fieldsFor(kind)).map(key => [key, null])),
  description: "",
  verification: ""
});
const unitsFor = kind => Object.entries(fieldsFor(kind)).map(([key, [label, unit]]) => `${key}=${label}${unit ? `（${unit}）` : ""}`).join("；");
export function createHealthImageConfig() {
  const common = promptText("health.image.common");
  return {
    sleep: {
      scene: "healthRecognition",
      maxImages: 2,
      prompt: promptText("health.image.sleep")
    },
    heartRate: {
      scene: "healthRecognition",
      maxImages: 1,
      prompt: promptText("health.image.heartRate")
    },
    weight: {
      scene: "healthRecognition",
      maxImages: 1,
      prompt: renderPrompt("health.image.weight", { common, units: unitsFor("weight"), schema: schemaFor("weight") })
    },
    exercise: {
      scene: "healthRecognition",
      maxImages: 1,
      prompt: renderPrompt("health.image.exercise", { common, units: unitsFor("exercise"), schema: schemaFor("exercise") })
    }
  };
}
