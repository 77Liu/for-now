import assert from "node:assert/strict";
import {
  buildRecordCompressionInput,
  RECORD_COMPRESSION_INPUT_JSON_BUDGET_BYTES,
  RECORD_COMPRESSION_MAX_SOURCE_ITEMS
} from "../src/modules/record-compressions/index.mjs";

const localDate = "2026-10-10";
const accountId = "synthetic-account-a";
const sourceKey = (type, id, rootId = "", targetKey = "") => (
  JSON.stringify([type, id, rootId, targetKey])
);
const store = {
  checkins: [
    {
      id: "before-midnight",
      occurredAt: "2026-10-09T15:59:59.000Z",
      version: 1,
      mood: 1,
      energy: 1,
      stress: 1,
      sleep: 1
    },
    {
      id: "checkin-in-window",
      occurredAt: "2026-10-09T16:00:00.000Z",
      updatedAt: "2026-10-10T01:00:00.000Z",
      version: 2,
      mood: 4,
      energy: 3,
      stress: 2,
      sleep: 4,
      factors: ["散步"],
      notes: { energy: "下午状态稳定" }
    },
    {
      id: "future-same-day",
      occurredAt: "2026-10-10T12:00:00.000Z",
      version: 1,
      mood: 2,
      energy: 2,
      stress: 4,
      sleep: 2
    },
    {
      id: "checkin-after-window",
      occurredAt: "2026-10-10T16:00:00.000Z",
      version: 1,
      mood: 5,
      energy: 5,
      stress: 1,
      sleep: 5
    },
    {
      id: "permission-denied",
      occurredAt: "2026-10-10T02:00:00.000Z",
      version: 1,
      mood: 5,
      energy: 5,
      stress: 1,
      sleep: 5
    }
  ],
  dailyRecords: [
    {
      id: "sleep-a",
      type: "sleep",
      occurredAt: "2026-10-10T00:30:00+08:00",
      createdAt: "2026-10-10T00:35:00+08:00",
      version: 1,
      totalMinutes: 420,
      deepMinutes: 90,
      averageHeartRate: 58
    },
    {
      // A replay of the same imported record retains its durable record ID.
      id: "sleep-a",
      type: "sleep",
      occurredAt: "2026-10-10T00:30:00+08:00",
      version: 1,
      totalMinutes: 420,
      deepMinutes: 90,
      averageHeartRate: 58
    },
    {
      id: "sleep-b",
      type: "sleep",
      occurredAt: "2026-10-10T09:30:00.000Z",
      version: 3,
      totalMinutes: 390
    },
    {
      id: "screen-heart-rate",
      type: "heartRate",
      source: "screenshot",
      occurredAt: "2026-10-10T09:00:00.000Z",
      version: 2,
      minimum: 55,
      maximum: 96,
      average: 72,
      recognitionDescription: "AI 图像解析估计可能为 9999 bpm；仅合成测试"
    },
    {
      id: "callback-denied",
      type: "heartRate",
      occurredAt: "2026-10-10T06:00:00.000Z",
      version: 1,
      average: 201
    },
    {
      id: "discarded-health",
      type: "heartRate",
      occurredAt: "2026-10-10T06:00:00.000Z",
      version: 1,
      average: 202,
      disposition: "discarded"
    },
    {
      id: "invalid-ocr",
      type: "weight",
      occurredAt: "2026-10-10T06:00:00.000Z",
      version: 1,
      measuredWeight: 999,
      validationState: "invalid"
    }
  ],
  thoughts: [
    {
      id: "question-1",
      type: "question",
      content: "我想把长期方向拆成可执行行动",
      occurredAt: "2026-10-10T04:00:00.000Z",
      version: 4,
      authorType: "user",
      remarks: [{
        id: "remark-1",
        text: "先从本周的一件事开始",
        createdAt: "2026-10-10T05:00:00.000Z",
        version: 2
      }],
      followUps: [{
        id: "followup-1",
        question: "这周先做什么？",
        answer: "先完成一份小练习",
        createdAt: "2026-10-10T05:30:00.000Z",
        answeredAt: "2026-10-10T06:30:00.000Z",
        updatedAt: "2026-10-10T06:30:00.000Z",
        version: 2,
        origin: "manual"
      }]
    },
    {
      id: "user-answer-1",
      type: "answer",
      content: "我会先写出最小步骤",
      relatedTo: "question-1",
      occurredAt: "2026-10-10T07:00:00.000Z",
      version: 1,
      authorType: "user"
    },
    {
      id: "ai-answer-1",
      type: "answer",
      content: "模型生成的建议，不是用户事实",
      relatedTo: "question-1",
      occurredAt: "2026-10-10T08:00:00.000Z",
      version: 1,
      authorType: "ai",
      origin: "deepseek",
      sourceTaskId: "synthetic-task"
    },
    {
      id: "unknown-provider-answer",
      type: "answer",
      content: "来源标记为未知模型提供方，不可当作用户表达",
      relatedTo: "question-1",
      occurredAt: "2026-10-10T08:15:00.000Z",
      version: 1,
      origin: "anthropic"
    },
    {
      id: "missing-author-answer",
      type: "answer",
      content: "缺少作者和来源标记，不可默认当作用户表达",
      relatedTo: "question-1",
      occurredAt: "2026-10-10T08:20:00.000Z",
      version: 1
    },
    {
      id: "discarded-thought",
      type: "idea",
      content: "不应出现在压缩材料中",
      occurredAt: "2026-10-10T08:00:00.000Z",
      version: 1,
      authorType: "user",
      disposition: "discarded"
    },
    {
      id: "disabled-thought",
      type: "idea",
      content: "权限已关闭",
      occurredAt: "2026-10-10T08:00:00.000Z",
      version: 1,
      authorType: "user",
      contextAllowed: false
    },
    {
      id: "long-thought",
      type: "idea",
      content: "合成边界文字".repeat(900),
      occurredAt: "2026-10-10T08:30:00.000Z",
      version: 1,
      authorType: "user"
    },
    {
      id: "nested-denied-question",
      type: "question",
      content: "父级权限已关闭",
      occurredAt: "2026-10-10T08:30:00.000Z",
      version: 1,
      authorType: "user",
      remarks: [{
        id: "nested-denied-remark",
        text: "不得进入摘要的反思文字",
        createdAt: "2026-10-10T08:45:00.000Z",
        version: 1
      }],
      followUps: [{
        id: "nested-denied-followup",
        question: "不得进入摘要的追问",
        createdAt: "2026-10-10T08:50:00.000Z",
        version: 1
      }]
    }
  ],
  journals: [{
    id: "journal-1",
    title: "今天",
    content: "完成了重要事项，晚上继续整理。",
    occurredAt: "2026-10-10T07:00:00.000Z",
    version: 1,
    reflections: [{
      id: "reflection-1",
      content: "AI 反思材料独立保存",
      createdAt: "2026-10-10T08:00:00.000Z",
      version: 1,
      origin: "deepseek",
      sourceTaskId: "reflection-task"
    }]
  }, {
    id: "disabled-journal",
    content: "已经撤销授权",
    occurredAt: "2026-10-10T07:00:00.000Z",
    version: 1,
    contextAllowed: false
  }],
  captures: [{
    id: "capture-1",
    content: "想法原文由用户写下",
    tags: ["计划"],
    occurredAt: "2026-10-10T09:00:00.000Z",
    updatedAt: "2026-10-10T10:00:00.000Z",
    version: 2,
    transcription: {
      status: "ready",
      rawText: "机器识别的原始转写",
      polishedText: "机器润色的转写",
      condensedText: "AI 压缩转写",
      updatedAt: "2026-10-10T10:00:00.000Z",
      version: 1
    }
  }],
  quotes: [{
    id: "quote-1",
    content: "第三方引用原文",
    source: "合成作者",
    occurredAt: "2026-10-10T09:30:00.000Z",
    version: 1
  }, {
    id: "quote-callback-denied",
    content: "权限回调拒绝",
    source: "合成作者",
    occurredAt: "2026-10-10T09:30:00.000Z",
    version: 1
  }],
  keepsakes: [{
    id: "keepsake-manual",
    title: "用户留存",
    note: "亲自填写的说明",
    tags: ["旅行"],
    source: "manual",
    occurredAt: "2026-10-10T09:00:00.000Z",
    version: 1
  }, {
    id: "keepsake-auto",
    title: "图像识别候选",
    note: "未经确认的机器文本",
    source: "auto",
    occurredAt: "2026-10-10T09:00:00.000Z",
    version: 1
  }],
  evidencePermissions: [{
    accountId,
    sourceKey: sourceKey("checkin", "permission-denied"),
    contextAllowed: false,
    learningAllowed: false,
    revision: 2
  }, {
    accountId,
    sourceKey: sourceKey(
      "thought",
      "nested-denied-question",
      "nested-denied-question",
      "question:nested-denied-question"
    ),
    contextAllowed: false,
    learningAllowed: false,
    revision: 2
  }]
};

const callbackCalls = [];
const commonOptions = {
  accountId,
  localDate,
  timezone: "Asia/Shanghai",
  asOf: "2026-10-10T10:05:00.000Z",
  promptVersion: "daily-record-compression.v1",
  sourcePermission: input => {
    callbackCalls.push(input);
    return input.sourceRef.resourceId !== "callback-denied"
      && input.sourceRef.resourceId !== "quote-callback-denied";
  }
};

const input = buildRecordCompressionInput(store, commonOptions);
assert.equal(input.schemaVersion, "record-compression-input.v1");
assert.equal(input.promptVersion, commonOptions.promptVersion);
assert.notEqual(input.accountKey, accountId);
assert.deepEqual(input.window, {
  start: "2026-10-09T16:00:00.000Z",
  endExclusive: "2026-10-10T16:00:00.000Z",
  asOf: "2026-10-10T10:05:00.000Z",
  timezone: "Asia/Shanghai",
  localDate,
  completeness: "partial"
});
assert.ok(callbackCalls.every(item => item.accountId === accountId));

const sourceIds = new Set(input.sourceManifest.map(item => item.sourceId));
const sourceFor = id => input.sourceManifest.find(item => item.recordId === id);
assert.equal(Boolean(sourceFor("before-midnight")), false);
assert.equal(Boolean(sourceFor("checkin-after-window")), false);
assert.equal(Boolean(sourceFor("future-same-day")), false);
assert.equal(Boolean(sourceFor("permission-denied")), false);
assert.equal(Boolean(sourceFor("callback-denied")), false);
assert.equal(Boolean(sourceFor("discarded-thought")), false);
assert.equal(Boolean(sourceFor("disabled-thought")), false);
assert.equal(Boolean(sourceFor("disabled-journal")), false);
assert.equal(Boolean(sourceFor("nested-denied-question")), false);
assert.equal(Boolean(sourceFor("nested-denied-remark")), false,
  "a denied question must not expose its nested remarks through inherited permission");
assert.equal(Boolean(sourceFor("nested-denied-followup")), false,
  "a denied question must not expose its nested follow-ups through inherited permission");
assert.equal(Boolean(sourceFor("quote-callback-denied")), false);
assert.equal(sourceFor("checkin-in-window")?.module, "daily");
assert.equal(sourceFor("unknown-provider-answer")?.origin, "unknown_origin");
assert.equal(sourceFor("missing-author-answer")?.origin, "unknown_origin");

const checkinMood = input.metrics.find(item => item.metric === "checkin_mood");
assert.deepEqual(checkinMood && {
  unit: checkinMood.unit,
  count: checkinMood.count,
  days: checkinMood.days,
  min: checkinMood.min,
  max: checkinMood.max,
  sum: checkinMood.sum,
  mean: checkinMood.mean
}, {
  unit: "rating_1_to_5",
  count: 1,
  days: 1,
  min: 4,
  max: 4,
  sum: 4,
  mean: 4
});
const sleepDuration = input.metrics.find(item => item.metric === "sleep_totalMinutes");
assert.deepEqual(sleepDuration && {
  unit: sleepDuration.unit,
  count: sleepDuration.count,
  days: sleepDuration.days,
  min: sleepDuration.min,
  max: sleepDuration.max,
  sum: sleepDuration.sum,
  mean: sleepDuration.mean,
  sourceIds: sleepDuration.sourceIds
}, {
  unit: "minute",
  count: 2,
  days: 1,
  min: 390,
  max: 420,
  sum: 810,
  mean: 405,
  sourceIds: [
    "daily:dailyRecord:sleep-a",
    "daily:dailyRecord:sleep-b"
  ]
});
assert.equal(input.metrics.some(item => item.metric === "heartRate_average"), false,
  "unconfirmed screenshot measurements must not become user metrics");
assert.equal(input.metrics.some(item => item.min === 9999 || item.max === 9999), false);
assert.equal(input.metrics.some(item => item.min === 201 || item.max === 201), false);
assert.ok(input.metrics.every(item => item.sourceIds.every(id => sourceIds.has(id))));

const userTexts = input.userSources.map(item => item.text).join("\n");
const aiTexts = input.aiReferences.map(item => item.text).join("\n");
assert.match(userTexts, /我想把长期方向拆成可执行行动/);
assert.match(userTexts, /我会先写出最小步骤/);
assert.match(userTexts, /想法原文由用户写下/);
assert.doesNotMatch(userTexts, /来源标记为未知模型提供方/);
assert.doesNotMatch(userTexts, /缺少作者和来源标记/);
assert.doesNotMatch(userTexts, /模型生成的建议/);
assert.doesNotMatch(userTexts, /机器识别的原始转写/);
assert.match(aiTexts, /模型生成的建议/);
assert.match(aiTexts, /机器识别的原始转写/);
assert.match(aiTexts, /AI 图像解析估计可能为 9999 bpm/);
assert.match(aiTexts, /图像识别候选/);
assert.doesNotMatch(aiTexts, /来源标记为未知模型提供方/);
assert.doesNotMatch(aiTexts, /缺少作者和来源标记/);
assert.ok(input.aiReferences.every(item => item.origin !== "user_original"));
assert.ok(input.warnings.some(item => item.includes("作者未验证")));

const quote = input.userSources.find(item => item.recordId === "quote-1");
assert.equal(quote?.origin, "quoted_external");
assert.match(quote?.text || "", /第三方引用原文/);
assert.ok(input.sourceManifest.every(item => (
  item.sourceId && item.recordId && Number.isInteger(item.version)
  && item.module && item.origin && item.occurredAt
  && Object.hasOwn(item, "updatedAt")
)));

const smallBudget = buildRecordCompressionInput(store, {
  ...commonOptions,
  maxTextChars: 80
});
assert.equal(smallBudget.coverage.truncated, true);
assert.ok(smallBudget.coverage.total > smallBudget.coverage.included);
assert.ok(smallBudget.userSources.every(item => item.text.length <= 80));
assert.ok(smallBudget.aiReferences.every(item => item.text.length <= 8));
assert.equal(smallBudget.sourceManifest.length, input.sourceManifest.length);

const complete = buildRecordCompressionInput(store, {
  ...commonOptions,
  asOf: "2026-10-10T23:00:00.000Z"
});
assert.equal(complete.window.completeness, "complete");
assert.ok(complete.sourceManifest.some(item => item.recordId === "future-same-day"));
assert.notEqual(complete.sourceManifestHash, input.sourceManifestHash,
  "asOf must change the manifest when a future same-day event becomes eligible");
const differentPrompt = buildRecordCompressionInput(store, {
  ...commonOptions,
  promptVersion: "daily-record-compression.v2"
});
assert.equal(differentPrompt.sourceManifestHash, input.sourceManifestHash);

let customHashCalls = 0;
const customHashed = buildRecordCompressionInput(store, {
  ...commonOptions,
  hash: value => {
    customHashCalls += 1;
    return "custom-" + value.length;
  }
});
assert.ok(customHashCalls > 0);
assert.match(customHashed.sourceManifestHash, /^custom-/);

const swappedMeasurementsStore = structuredClone(store);
swappedMeasurementsStore.dailyRecords.find(item => item.id === "sleep-a").totalMinutes = 390;
swappedMeasurementsStore.dailyRecords.find(item => item.id === "sleep-b").totalMinutes = 420;
const swappedMeasurements = buildRecordCompressionInput(swappedMeasurementsStore, commonOptions);
assert.deepEqual(swappedMeasurements.metrics, input.metrics,
  "replayed records with the same source ID deduplicate while independent records remain distinct");
assert.notEqual(swappedMeasurements.sourceManifestHash, input.sourceManifestHash,
  "manifest hashes must bind each measurement to its source");
assert.notEqual(
  swappedMeasurements.sourceManifest.find(item => item.recordId === "sleep-a")?.sourceHash,
  input.sourceManifest.find(item => item.recordId === "sleep-a")?.sourceHash
);

const repeatedHeartRateInput = buildRecordCompressionInput({
  dailyRecords: [
    { id: "heart-rate-60-a", type: "heartRate", occurredAt: "2026-10-10T03:00:00.000Z", average: 60 },
    { id: "heart-rate-60-b", type: "heartRate", occurredAt: "2026-10-10T04:00:00.000Z", average: 60 },
    { id: "heart-rate-100", type: "heartRate", occurredAt: "2026-10-10T05:00:00.000Z", average: 100 }
  ]
}, {
  ...commonOptions,
  sourcePermission: () => true
});
const repeatedHeartRate = repeatedHeartRateInput.metrics.find(item => item.metric === "heartRate_average");
assert.equal(repeatedHeartRate?.count, 3,
  "equal values from independent same-day measurements must each contribute to the count");
assert.equal(repeatedHeartRate?.sum, 220);
assert.equal(repeatedHeartRate?.mean, 73.333333);

const permissionSource = {
  checkins: [{
    id: "permission-default-deny",
    occurredAt: "2026-10-10T04:00:00.000Z",
    version: 1,
    mood: 4
  }]
};
const withoutPermission = buildRecordCompressionInput(permissionSource, {
  ...commonOptions,
  sourcePermission: undefined
});
assert.equal(withoutPermission.sourceManifest.length, 0,
  "a missing permission decision must fail closed");
const withStoredPermission = buildRecordCompressionInput({
  ...permissionSource,
  evidencePermissions: [{
    accountId,
    sourceKey: sourceKey("checkin", "permission-default-deny"),
    contextAllowed: true,
    revision: 1
  }]
}, {
  ...commonOptions,
  sourcePermission: undefined
});
assert.equal(withStoredPermission.sourceManifest.length, 1,
  "an explicit stored permission may authorize input without a callback");

const highVolumeStore = {
  dailyRecords: Array.from({ length: 5_000 }, (_, index) => ({
    id: `bulk-${String(index).padStart(5, "0")}`,
    type: "weight",
    source: "manual",
    description: `第 ${index} 条用户体重记录，${"保留在有限文本预算内的合成说明。".repeat(3)}`,
    occurredAt: "2026-10-10T04:00:00.000Z",
    version: 1,
    measuredWeight: 40 + index / 100
  }))
};
const highVolumeInput = buildRecordCompressionInput(highVolumeStore, {
  ...commonOptions,
  sourcePermission: () => true
});
assert.equal(highVolumeInput.sourceManifest.length, 5_000);
assert.equal(highVolumeInput.coverage.total, 5_000);
assert.equal(highVolumeInput.coverage.truncated, true);
assert.ok(highVolumeInput.coverage.excluded >= 5_000 - RECORD_COMPRESSION_MAX_SOURCE_ITEMS);
assert.ok(highVolumeInput.sourceManifest.some(source => source.recordId === "bulk-00000"));
assert.ok(highVolumeInput.sourceManifest.some(source => source.recordId === "bulk-04999"));
assert.equal(new Set(highVolumeInput.sourceManifest.map(source => source.sourceId)).size, 5_000);
const highVolumeMetric = highVolumeInput.metrics.find(item => item.metric === "weight_measuredWeight");
assert.equal(highVolumeMetric?.count, 5_000,
  "numeric aggregates must include every permitted structured source, including records beyond the text candidate cap");
assert.equal(highVolumeMetric?.sourceIds.length, 5_000);
assert.ok(highVolumeMetric.sourceIds.every(id => (
  highVolumeInput.sourceManifest.some(source => source.sourceId === id)
)));
assert.equal(highVolumeInput.coverage.text.total, 5_000);
assert.equal(highVolumeInput.coverage.text.completeness, "partial");
assert.ok(highVolumeInput.coverage.text.omitted > 0,
  "text coverage must explicitly report omitted sources");
assert.ok(highVolumeInput.userSources.length <= RECORD_COMPRESSION_MAX_SOURCE_ITEMS);
const promptTextCharacters = [...highVolumeInput.userSources, ...highVolumeInput.aiReferences]
  .reduce((sum, source) => sum + source.text.length, 0);
assert.ok(promptTextCharacters <= highVolumeInput.limits.textCharacters);
const promptInput = JSON.parse(JSON.stringify(highVolumeInput));
assert.equal(Object.hasOwn(promptInput, "sourceManifest"), false,
  "the complete durable source manifest must not be sent to the model");
assert.ok(promptInput.metrics.every(metric => !Object.hasOwn(metric, "sourceIds")),
  "full metric source associations must remain outside the model prompt");
assert.ok(Buffer.byteLength(JSON.stringify(highVolumeInput), "utf8") <= RECORD_COMPRESSION_INPUT_JSON_BUDGET_BYTES);

const changedHighVolumeStore = structuredClone(highVolumeStore);
changedHighVolumeStore.dailyRecords[2_500].measuredWeight += 0.25;
const changedHighVolumeInput = buildRecordCompressionInput(changedHighVolumeStore, {
  ...commonOptions,
  sourcePermission: () => true
});
assert.notEqual(changedHighVolumeInput.sourceManifestHash, highVolumeInput.sourceManifestHash,
  "hashes must bind source changes even when the changed record is outside the text candidate cap");

const permissionChangedHighVolumeStore = structuredClone(highVolumeStore);
permissionChangedHighVolumeStore.evidencePermissions = [{
  accountId,
  sourceKey: sourceKey("dailyRecord", "bulk-02500"),
  contextAllowed: false,
  revision: 1
}];
const permissionChangedHighVolumeInput = buildRecordCompressionInput(permissionChangedHighVolumeStore, {
  ...commonOptions,
  sourcePermission: () => true
});
assert.equal(permissionChangedHighVolumeInput.sourceManifest.length, 4_999);
assert.ok(!permissionChangedHighVolumeInput.sourceManifest.some(source => (
  source.recordId === "bulk-02500"
)));
assert.equal(permissionChangedHighVolumeInput.metrics.find(item => (
  item.metric === "weight_measuredWeight"
))?.count, 4_999);
assert.notEqual(permissionChangedHighVolumeInput.sourceManifestHash, highVolumeInput.sourceManifestHash,
  "hashes must bind permission revocations for sources outside the text candidate cap");

assert.throws(() => buildRecordCompressionInput(store, {
  ...commonOptions,
  timezone: "Invalid/Timezone"
}), /Invalid time zone|time zone/i);
assert.throws(() => buildRecordCompressionInput(store, {
  ...commonOptions,
  localDate: "2026-02-30"
}), /valid YYYY-MM-DD/);

console.log(
  "Record compression input regression passed: timezone window, permission filtering, provenance separation, bounded coverage and unit-aware metric aggregates."
);
