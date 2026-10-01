import crypto from "node:crypto";
import { cleanAttachmentPaths } from "../../shared/attachments/index.mjs";
import { eventTimeFields } from "../../shared/time/index.mjs";
import { nullableNumber, recordVersion, safeIso, safeText } from "../../shared/validation/index.mjs";
import { hasHealthContent, healthDetailsError, normalizeHealthDetails } from "./profile.mjs";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const round = value => value == null ? null : Math.round(value * 100) / 100;
const requestDigest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const priorRequest = (items, trashItems, clientRequestId) => (
  items.find(item => item.clientRequestId === clientRequestId)
  || trashItems.find(item => item.type === "dailyRecord" && item.payload?.clientRequestId === clientRequestId)?.payload
);
const WEIGHT_CLOTHING_MODEL = {
  none: { mean: 0, lower: 0, upper: 0 },
  light: { mean: 0.5, lower: 0.1, upper: 0.9 },
  heavy: { mean: 1.5, lower: 0.5, upper: 2.5 }
};

function idempotencyPayload(input, value) {
  const canonical = { ...value };
  if (!hasOwn(input, "occurredAt")) delete canonical.occurredAt;
  if (!hasOwn(input, "occurredOn")) delete canonical.occurredOn;
  return canonical;
}

function pageOf(items, { afterId = "", limit = 20 } = {}) {
  const start = afterId ? items.findIndex(item => item.id === afterId) + 1 : 0;
  if (afterId && start === 0) return { invalidCursor: true };
  const page = items.slice(start, start + limit);
  return { items: page, nextId: start + page.length < items.length ? page.at(-1)?.id || "" : "" };
}

export function dailyRecordPayload(input, existing = null) {
  const merged = existing ? { ...existing, ...input } : input;
  const type = ["sleep", "heartRate", "weight", "exercise"].includes(merged.type) ? merged.type : existing?.type;
  if (!type) return { error: "记录类型无效" };
  const eventTime = eventTimeFields(input, existing);
  if (!eventTime) return { error: "发生时间格式不正确" };
  const common = {
    type,
    ...eventTime,
    source: merged.source === "screenshot" ? "screenshot" : "manual",
    attachmentPaths: cleanAttachmentPaths(merged.attachmentPaths)
  };
  if (type === "sleep") {
    const bedtime = safeIso(merged.bedtime), wakeTime = safeIso(merged.wakeTime);
    const deepMinutes = nullableNumber(merged.deepMinutes, 0, 1440, true);
    const lightMinutes = nullableNumber(merged.lightMinutes, 0, 1440, true);
    const remMinutes = nullableNumber(merged.remMinutes, 0, 1440, true);
    const totalMinutes = nullableNumber(merged.totalMinutes, 0, 1440, true)
      ?? ([deepMinutes, lightMinutes, remMinutes].every(Number.isFinite) ? deepMinutes + lightMinutes + remMinutes : null);
    if (totalMinutes == null && !bedtime && !wakeTime) return { error: "请填写睡眠总时长或入睡、醒来时间" };
    return {
      value: {
        ...common,
        bedtime,
        wakeTime,
        totalMinutes,
        deepMinutes,
        deepPercent: nullableNumber(merged.deepPercent, 0, 100),
        lightMinutes,
        lightPercent: nullableNumber(merged.lightPercent, 0, 100),
        remMinutes,
        remPercent: nullableNumber(merged.remPercent, 0, 100),
        awakeCount: nullableNumber(merged.awakeCount, 0, 100, true),
        awakeMinutes: nullableNumber(merged.awakeMinutes, 0, 1440, true),
        averageHeartRate: nullableNumber(merged.averageHeartRate, 20, 250),
        averageOxygen: nullableNumber(merged.averageOxygen, 50, 100),
        respiratoryRate: nullableNumber(merged.respiratoryRate, 1, 80)
      }
    };
  }
  if (type === "heartRate") {
    const minimum = nullableNumber(merged.minimum, 20, 250);
    const maximum = nullableNumber(merged.maximum, 20, 250);
    const average = nullableNumber(merged.average, 20, 250);
    if (![minimum, maximum, average].some(Number.isFinite)) return { error: "请至少填写心率范围或平均心率" };
    if (minimum != null && maximum != null && minimum > maximum) return { error: "最低心率不能高于最高心率" };
    return {
      value: {
        ...common,
        minimum,
        maximum,
        average,
        resting: nullableNumber(merged.resting, 20, 250),
        sleepAverage: nullableNumber(merged.sleepAverage, 20, 250),
        trendAnalysis: safeText(merged.trendAnalysis, 1200),
        trendSegments: (Array.isArray(merged.trendSegments) ? merged.trendSegments : []).slice(0, 8).map(item => ({
          period: safeText(item.period, 80),
          direction: safeText(item.direction, 20),
          approximateRange: safeText(item.approximateRange, 80)
        })).filter(item => item.period)
      }
    };
  }
  if (type === "weight") {
    const details = normalizeHealthDetails(type, merged);
    const { measuredWeight } = details;
    const clothing = WEIGHT_CLOTHING_MODEL[merged.clothing] ? merged.clothing : "none";
    const model = WEIGHT_CLOTHING_MODEL[clothing];
    if (!hasHealthContent(type, details)) return { error: "请填写体重、体成分指标或描述" };
    const measuredAt = safeIso(merged.measuredAt);
    if (merged.measuredAt && !measuredAt) return { error: "测量时间格式不正确" };
    return {
      value: {
        ...common,
        ...details,
        measuredAt,
        clothing,
        adjustmentMean: model.mean,
        adjustedWeight: measuredWeight == null ? null : round(measuredWeight - model.mean),
        lower95: measuredWeight == null ? null : round(measuredWeight - model.upper),
        upper95: measuredWeight == null ? null : round(measuredWeight - model.lower)
      }
    };
  }
  const details = normalizeHealthDetails(type, merged);
  if (!hasHealthContent(type, details)) return { error: "请填写运动项目、指标、感受或解析描述" };
  const error = healthDetailsError(type, details);
  if (error) return { error };
  const startedAt = safeIso(merged.startedAt);
  if (merged.startedAt && !startedAt) return { error: "运动开始时间格式不正确" };
  return { value: { ...common, ...details, startedAt } };
}

export function createDailyRecordRecords({
  repository,
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID()
}) {
  return {
    async list(options) {
      return pageOf(await repository.read(), options);
    },

    async get(id) {
      return (await repository.read()).find(item => item.id === id) || null;
    },

    async create(input, { clientRequestId = "" } = {}) {
      const parsed = dailyRecordPayload(input);
      if (parsed.error) return parsed;
      const requestHash = clientRequestId ? requestDigest(idempotencyPayload(input, parsed.value)) : "";
      const createRecord = (items, trashItems = [], useLegacyLookup = true) => {
        if (clientRequestId && useLegacyLookup) {
          const duplicate = priorRequest(items, trashItems, clientRequestId);
          if (duplicate) {
            return duplicate.requestHash === requestHash
              ? { value: duplicate, duplicate: true }
              : { conflict: true };
          }
        }
        const entry = {
          id: createId(),
          createdAt: now(),
          ...parsed.value,
          ...(clientRequestId ? { version: 1, clientRequestId, requestHash } : {})
        };
        items.unshift(entry);
        return { value: entry, duplicate: false };
      };
      if (clientRequestId && typeof repository.executeIdempotent === "function") {
        return repository.executeIdempotent(
          { scope: "dailyRecords.create", key: clientRequestId, requestHash },
          (items, trashItems = []) => createRecord(items, trashItems, false),
          { onReplay: result => ({ ...result, duplicate: true }) }
        );
      }
      return repository.update((items, trashItems = []) => createRecord(items, trashItems));
    },

    update(id, input, { expectedVersion = null } = {}) {
      return repository.update(items => {
        const entry = items.find(item => item.id === id);
        if (!entry) return { missing: true };
        const currentVersion = recordVersion(entry.version);
        if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
          return { versionConflict: true, currentVersion };
        }
        const parsed = dailyRecordPayload(input, entry);
        if (parsed.error) return parsed;
        const next = {
          ...entry,
          ...parsed.value,
          id: entry.id,
          createdAt: entry.createdAt,
          updatedAt: now(),
          ...(expectedVersion != null ? { version: currentVersion + 1 } : {})
        };
        Object.assign(entry, next);
        return { value: entry };
      });
    }
  };
}
