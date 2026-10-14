/**
 * 日压缩半开窗口、晚到修订与日期精度验证。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：仅合成记录与本地输入构建，不触发模型或生产读取。
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import {
  recordCompressionWindow, recordCompressionWindowFromKey, recordOccurrenceWindow,
  closedRecordCompressionWindows, RECORD_SLOT_INPUT_SCHEMA_VERSION
} from "../src/modules/record-compressions/windows.mjs";

const morning = recordCompressionWindow("2026-10-14", "morning");
const evening = recordCompressionWindow("2026-10-14", "evening");
assert.equal(morning.start, "2026-10-13T10:05:00.000Z");
assert.equal(morning.endExclusive, "2026-10-13T22:00:00.000Z");
assert.equal(evening.start, morning.endExclusive);
assert.equal(evening.endExclusive, "2026-10-14T10:05:00.000Z");
for (const [time, expected] of [
  ["2026-10-13T18:05:00+08:00", morning],
  ["2026-10-14T05:59:59.999+08:00", morning],
  ["2026-10-14T06:00:00+08:00", evening],
  ["2026-10-14T18:04:59.999+08:00", evening],
  ["2026-10-14T18:05:00+08:00", recordCompressionWindow("2026-10-15", "morning")]
] as const) assert.equal(recordOccurrenceWindow({ occurredAt: time })?.window.windowKey, expected.windowKey);
const dayOnly = recordOccurrenceWindow({ occurredOn: "2026-10-14" });
assert.equal(dayOnly?.window.windowKey, evening.windowKey);
assert.equal(dayOnly?.occurredAt, "");
assert.equal(dayOnly?.precision, "date");
assert.equal(recordOccurrenceWindow({}) , null);
assert.equal(recordCompressionWindowFromKey("record-compression-window.v2:2026-02-30:morning"), null);
assert.deepEqual(closedRecordCompressionWindows("2026-10-14T18:05:00+08:00", "2026-10-14"), [evening, morning]);
assert.deepEqual(closedRecordCompressionWindows("2026-10-14T05:59:59+08:00", "2026-10-14"), []);

const moduleUrl = pathToFileURL(path.join(process.cwd(), "src/modules/record-compressions/index.mjs")).href;
const { buildRecordCompressionInput, RECORD_COMPRESSION_PROMPT_VERSION } = await import(moduleUrl);
const store = { captures: [
  { id: "late", content: "晚到的原始记录", authorType: "user", occurredAt: "2026-10-13T20:00:00+08:00", createdAt: "2026-10-15T08:00:00+08:00", version: 1 },
  { id: "date-only", content: "仅日期原始记录", authorType: "user", occurredOn: "2026-10-14", createdAt: "2026-10-15T08:00:00+08:00", version: 1 }
] };
const options = { accountId: "synthetic", timezone: "Asia/Shanghai", asOf: "2026-10-16T00:00:00Z", promptVersion: RECORD_COMPRESSION_PROMPT_VERSION,
  sourcePermission: () => true };
const am = buildRecordCompressionInput(store, { ...options, localDate: morning.localDate, windowKey: morning.windowKey });
const pm = buildRecordCompressionInput(store, { ...options, localDate: evening.localDate, windowKey: evening.windowKey });
assert.equal(am.schemaVersion, RECORD_SLOT_INPUT_SCHEMA_VERSION);
assert.deepEqual(am.userSources.map((row: { recordId: string }) => row.recordId), ["late"]);
assert.deepEqual(pm.userSources.map((row: { recordId: string }) => row.recordId), ["date-only"]);
assert.equal(pm.userSources[0].occurredAt, "");
assert.equal(pm.userSources[0].timePrecision, "date");
store.captures[0].content = "晚到记录的编辑修订";
store.captures[0].version += 1;
const edited = buildRecordCompressionInput(store, { ...options, localDate: morning.localDate, windowKey: morning.windowKey });
assert.notEqual(edited.sourceManifestHash, am.sourceManifestHash);
assert.equal(edited.window.windowKey, morning.windowKey);
console.log("上海半开窗口、日期精度、闭合扫描、晚到归原槽及编辑来源修订通过。");

const { parseRecordCompressionOutput, deriveSevenDayTrend, RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION } = await import(moduleUrl);
const createSummary = (input: typeof am, id: string) => {
  const row = parseRecordCompressionOutput({ schemaVersion: RECORD_COMPRESSION_OUTPUT_SCHEMA_VERSION,
    daily: { observations: [{ text: "合成记录整理", sourceIds: [input.userSources[0].sourceId] }], metricKeys: [], missing: [] },
    thoughtsIdeas: { focus: [], changes: [], openQuestions: [] }, other: { themes: [], collectedQuotes: [] },
    aiReference: [], stableUserCandidates: [], conflicts: [], warnings: []
  }, { input, id, generatedAt: options.asOf });
  return { ...row, localDate: input.window.localDate, sourceRefs: input.sourceManifest };
};
const currentAm = createSummary(edited, "am-summary");
const currentPm = createSummary(pm, "pm-summary");
const legacyInput = buildRecordCompressionInput(store, { ...options, localDate: "2026-10-14" });
const legacySummary = createSummary(legacyInput, "legacy-summary");
const combined = deriveSevenDayTrend({ summaries: [legacySummary, currentAm, currentPm], localDates: ["2026-10-14"],
  timezone: options.timezone, promptVersion: RECORD_COMPRESSION_PROMPT_VERSION, asOf: options.asOf });
assert.deepEqual(combined.days[0].summary.summaryIds, ["am-summary", "pm-summary"]);
assert.equal(combined.days[0].summary.id, undefined);
assert.equal(combined.days[0].summary.windowKey, undefined);
assert.equal(combined.days[0].summary.window.start, morning.start);
assert.equal(combined.days[0].summary.window.endExclusive, evening.endExclusive);
assert.equal(combined.days[0].summary.sourceManifestHashes.length, 2);
assert.equal(combined.days[0].summary.daily.observations.length, 2);
const partial = deriveSevenDayTrend({ summaries: [legacySummary, currentAm], localDates: ["2026-10-14"],
  timezone: options.timezone, promptVersion: RECORD_COMPRESSION_PROMPT_VERSION, asOf: options.asOf });
assert.equal(partial.days[0].completeness, "partial");
assert.deepEqual(partial.days[0].missingSlots, [evening.windowKey]);
assert.equal(partial.days[0].summary.daily.observations.length, 1);

const contextUrl = pathToFileURL(path.join(process.cwd(), "src/app/record-compression-context.mjs")).href;
const { compressionFailureView } = await import(contextUrl);
const hash = (value: unknown) => crypto.createHash("sha256").update(String(value)).digest("hex");
const failed = { id: "old-failed", kind: "recordCompression", status: "failed", error: "保留历史错误", errorCode: "SYNTHETIC_FAILURE",
  completedAt: "2026-10-15T00:00:00Z", payload: { operation: "daily", localDate: "2026-10-14", timezone: options.timezone,
    promptVersion: RECORD_COMPRESSION_PROMPT_VERSION, windowKey: morning.windowKey, sourceManifestHash: am.sourceManifestHash, recordId: "old-summary" },
  requestedInputHash: hash(JSON.stringify({ accountId: am.accountKey, localDate: "2026-10-14", timezone: options.timezone,
    promptVersion: RECORD_COMPRESSION_PROMPT_VERSION, windowKey: morning.windowKey, sourceManifestHash: am.sourceManifestHash })) };
const failedCopy = structuredClone(failed);
const statusStore = { ...store, recordCompressions: [currentAm], aiTasks: [failed] };
const statusOptions = { ...options, hash };
assert.equal(compressionFailureView(statusStore, statusOptions).pendingFaultCount, 0);
assert.equal(compressionFailureView(statusStore, statusOptions).replaced[0].replacementId, currentAm.id);
assert.deepEqual(failed, failedCopy);
assert.equal(compressionFailureView(statusStore, { ...statusOptions, accountId: "other-account" }).replaced.length, 0);
statusStore.captures[0].content = "来源再次发生编辑";
statusStore.captures[0].version += 1;
assert.equal(compressionFailureView(statusStore, statusOptions).pendingFaultCount, 1);
statusStore.recordCompressions = [currentPm];
assert.equal(compressionFailureView(statusStore, statusOptions).pendingFaultCount, 1);
assert.deepEqual(failed, failedCopy);
console.log("两槽派生范围/身份、旧全天不双计、缺槽明示、精确窗口失败替代与失效恢复通过。");

const { historicalSupplementInputFrom } = await import(contextUrl);
const { parseHistoricalUserSupplementOutput, HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION,
  HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION, prepareCompressionSourceAliases, decodeCompressionSourceAliases } = await import(moduleUrl);
const snapshot = historicalSupplementInputFrom(store, { ...statusOptions, windowStart: "2026-10-08", windowEnd: "2026-10-14" });
const source = snapshot.input.input.userSources[0];
assert.ok(source);
const historical = parseHistoricalUserSupplementOutput({ schemaVersion: HISTORICAL_USER_SUPPLEMENT_OUTPUT_SCHEMA_VERSION,
  candidates: [{ statement: source.text.slice(0, 8), exactQuote: source.text.slice(0, 1), sourceId: source.sourceId }] },
{ input: snapshot.input, generatedAt: options.asOf });
const historicalHash = (payload: Record<string, unknown>, start: string, end: string) => hash(JSON.stringify({
  operation: "historicalSupplement", accountId: options.accountId, timezone: options.timezone,
  promptVersion: HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION, windowStart: start, windowEnd: end,
  batchIndex: payload.batchIndex || 0, sourceManifestHash: payload.sourceManifestHash
}));
const oldHistoricalPayload = { operation: "historicalSupplement", localDate: "2026-10-14", timezone: options.timezone,
  promptVersion: HISTORICAL_USER_SUPPLEMENT_PROMPT_VERSION, sourceManifestHash: snapshot.sourceManifestHash };
const failedHistorical = { ...failedCopy, id: "failed-history", payload: oldHistoricalPayload,
  requestedInputHash: historicalHash(oldHistoricalPayload, "2026-10-08", "2026-10-14") };
const candidatePayload = { ...oldHistoricalPayload, windowStart: "2026-10-08", windowEnd: "2026-10-14", batchIndex: 0 };
const replacementHistorical = { id: "replacement-history", kind: "recordCompression", status: "succeeded", payload: candidatePayload,
  requestedInputHash: historicalHash(candidatePayload, "2026-10-08", "2026-10-14"), replacementReceipt: { sources: historical.records.map((record: {
    source: { sourceId: string; sourceHash: string; permissionRevision: number }; exactQuote: string;
  }) => ({ ...record.source, quoteSha256: hash(record.exactQuote) })) } };
const historyState = { ...store, aiTasks: [failedHistorical, replacementHistorical], recordCompressions: [currentPm], historicalUserSupplement: historical };
const oldHistoricalAudit = JSON.stringify(failedHistorical);
assert.equal(compressionFailureView(historyState, statusOptions).pendingFaultCount, 0);
const wrongRangePayload = { ...oldHistoricalPayload, localDate: "2026-10-15" };
historyState.aiTasks[1] = { ...replacementHistorical, payload: wrongRangePayload,
  requestedInputHash: historicalHash(wrongRangePayload, "2026-10-09", "2026-10-15") } as typeof replacementHistorical;
assert.equal(compressionFailureView(historyState, statusOptions).pendingFaultCount, 1);
historyState.aiTasks[1] = { ...replacementHistorical, payload: { ...candidatePayload, batchIndex: 1 },
  requestedInputHash: historicalHash({ ...candidatePayload, batchIndex: 1 }, "2026-10-08", "2026-10-14") };
assert.equal(compressionFailureView(historyState, statusOptions).pendingFaultCount, 1);
historyState.aiTasks = [failedHistorical];
assert.equal(compressionFailureView(historyState, statusOptions).pendingFaultCount, 1, "日摘要不能替代历史补充");
historyState.aiTasks = [failedHistorical, replacementHistorical];
historyState.historicalUserSupplement.records = [];
assert.equal(compressionFailureView(historyState, statusOptions).pendingFaultCount, 1, "实际不可消费的旧缓存不替代故障");
assert.equal(JSON.stringify(failedHistorical), oldHistoricalAudit);

const aliases = prepareCompressionSourceAliases(edited);
assert.ok(aliases.sources.every((row: { alias: string }) => /^r\d+$/.test(row.alias)));
assert.equal(JSON.stringify(aliases.modelInput).includes('"recordId"'), false);
assert.equal(JSON.stringify(aliases.modelInput).includes(edited.sourceManifest[0].sourceId), false);
const decoded = decodeCompressionSourceAliases({ sourceIds: [aliases.sources[0].alias, "r999", edited.sourceManifest[0].sourceId],
  text: "用户原文不应被替换" }, aliases);
assert.equal(decoded.sourceIds[0], edited.sourceManifest[0].sourceId);
assert.notEqual(decoded.sourceIds[1], edited.sourceManifest[0].sourceId);
assert.notEqual(decoded.sourceIds[2], edited.sourceManifest[0].sourceId);
assert.equal(decoded.text, "用户原文不应被替换");
console.log("HUS旧隐式窗口/批次/真实消费重核、不跨能力替代及处理请求短别名编解码通过。");

const timeUrl = pathToFileURL(path.join(process.cwd(), "src/shared/time/index.mjs")).href;
const { eventTimeFields } = await import(timeUrl);
assert.deepEqual(eventTimeFields({ occurredOn: "2026-10-14" }, null, { now: () => new Date(options.asOf) }),
  { occurredAt: "", occurredOn: "2026-10-14", eventTimePrecision: "date" });
const thoughtsUrl = pathToFileURL(path.join(process.cwd(), "src/modules/thoughts/index.mjs")).href;
const { createThoughtService } = await import(thoughtsUrl);
let childClock = "2026-10-13T12:00:00Z";
let childSequence = 0;
const childrenStore = { thoughts: [{ id: "root", type: "question", content: "旧根记录", occurredAt: "2026-09-25T00:00:00Z",
  occurredOn: "2026-09-25", version: 1, remarks: [], followUps: [] }] };
const thoughts = createThoughtService({ repository: { update: async (operation: (store: typeof childrenStore) => unknown) => operation(childrenStore) },
  createId: () => `child-${++childSequence}`, now: () => childClock, recordVersion: (value: number) => value || 1,
  eventTimeFields: (input: unknown, existing: unknown) => eventTimeFields(input, existing, { now: () => childClock }), reanchorAnnotations: () => {} });
const remark = (await thoughts.addRemark({ id: "root", text: "自己的发生时刻" })).value;
const followUp = (await thoughts.addFollowUp({ id: "root", question: "追问", answer: "首次人工答案" })).value;
assert.equal(recordOccurrenceWindow(remark)?.window.windowKey, morning.windowKey);
assert.equal(recordOccurrenceWindow({ occurredAt: followUp.questionOccurredAt })?.window.windowKey, morning.windowKey);
const answerAt = followUp.answerOccurredAt;
childClock = "2026-10-15T12:00:00Z";
await thoughts.updateRemark({ id: "root", remarkId: remark.id, text: "后续编辑" });
await thoughts.updateFollowUp({ id: "root", followUpId: followUp.id, hasAnswer: true, answer: "后续改答", expectedVersion: 1 });
assert.equal(remark.occurredAt, "2026-10-13T12:00:00Z");
assert.equal(followUp.answerOccurredAt, answerAt);
assert.equal(recordOccurrenceWindow({ occurredAt: followUp.answerOccurredAt })?.window.windowKey, morning.windowKey);
const frontendTimeUrl = pathToFileURL(path.join(process.cwd(), "public/frontend/time/index.mjs")).href;
const { eventTimestamp, formatDate } = await import(frontendTimeUrl);
assert.equal(eventTimestamp({ occurredAt: "", occurredOn: "2026-10-14", createdAt: options.asOf }), "2026-10-14");
assert.equal(formatDate("2026-10-14"), "2026年10月14日");
console.log("真实子项生产者独立发生时间、编辑不搬槽及日期精度显示通过。");

const appUrl = pathToFileURL(path.join(process.cwd(), "src/app/index.mjs")).href;
const { createEmptyStore, createStoreNormalizer } = await import(appUrl);
const precisionStore = createEmptyStore();
const dateFields = eventTimeFields({ occurredOn: "2026-10-14" });
const dateRoot = thoughts.createChainInStore(precisionStore, { questionText: "仅日期记录", eventTime: dateFields, tags: [] }).items[0];
const normalize = createStoreNormalizer({ now: () => options.asOf, currentTime: () => Date.parse(options.asOf) });
thoughts.updateChainInStore(precisionStore, { id: dateRoot.id, questionText: "只修改正文", tags: [], changesEventTime: false });
assert.equal(normalize(precisionStore).thoughts[0].eventTimePrecision, "date");
assert.equal(normalize(precisionStore).thoughts[0].occurredAt, "");
thoughts.updateChainInStore(precisionStore, { id: dateRoot.id, questionText: "补填准确时刻", tags: [], changesEventTime: true,
  eventTimeInput: { timeMode: "manual", occurredAt: "2026-10-14T05:00:00+08:00" } });
const precise = normalize(precisionStore).thoughts[0];
assert.equal(precise.eventTimePrecision, "instant");
assert.equal(precise.occurredAt, "2026-10-13T21:00:00.000Z");
assert.equal(recordOccurrenceWindow(precise)?.window.windowKey, morning.windowKey);
Object.assign(dateRoot, { occurredAt: "", occurredOn: "", eventTimePrecision: "unknown" });
assert.deepEqual(eventTimeFields({}, dateRoot), { occurredAt: "", occurredOn: "", eventTimePrecision: "unknown" });
thoughts.updateChainInStore(precisionStore, { id: dateRoot.id, questionText: "明确现在发生", tags: [], changesEventTime: true,
  eventTimeInput: { timeMode: "now" } });
const nowRecord = normalize(precisionStore).thoughts[0];
assert.equal(nowRecord.eventTimePrecision, "instant");
assert.equal(nowRecord.occurredAt, new Date(childClock).toISOString());
assert.equal(recordOccurrenceWindow(nowRecord)?.window.windowKey, recordOccurrenceWindow({ occurredAt: childClock })?.window.windowKey);
console.log("日期/未知记录补填时刻或now后精度更新、真实编辑/normalize/归槽链路通过。");

const operationsUrl = pathToFileURL(path.join(process.cwd(), "public/frontend/features/thoughts/operations.mjs")).href;
const { createThoughtOperations } = await import(operationsUrl);
const fields: Record<string, { value: string; hidden: boolean; required: boolean; placeholder: string; textContent: string; focus: () => void }> = {};
for (const selector of ["id", "datetime", "question", "tags", "status", "modal"]) {
  fields[`#edit-chain-${selector}`] = { value: "", hidden: false, required: false, placeholder: "", textContent: "", focus() {} };
}
const sentBodies: Record<string, unknown>[] = [];
const operations = createThoughtOperations({
  platform: { document: { querySelector: (selector: string) => fields[selector] } },
  thoughtView: { findChain: () => ({ question: dateRoot }) },
  data: { getSnapshot: () => ({ thoughts: [dateRoot] }), refresh() {},
    async requestV1(_url: string, request: { body: string }) {
      const body = JSON.parse(request.body);
      sentBodies.push(body);
      thoughts.updateChainInStore(precisionStore, { id: dateRoot.id, questionText: body.question, tags: body.tags,
        changesEventTime: Object.hasOwn(body, "occurredAt") || Object.hasOwn(body, "occurredOn"), eventTimeInput: body });
      return { data: dateRoot };
    } }, viewPort: { showToast() {} }
});
const form = { querySelector: () => ({ disabled: false }) };
for (const precision of ["date", "unknown"]) {
  Object.assign(dateRoot, { occurredAt: "", occurredOn: precision === "date" ? "2026-10-14" : "", eventTimePrecision: precision });
  operations.openChainEditor(dateRoot.id);
  fields["#edit-chain-question"].value = "只编辑正文";
  await operations.submitEditChain(form);
  assert.equal(Object.hasOwn(sentBodies.at(-1)!, "occurredOn"), false);
  assert.equal(Object.hasOwn(sentBodies.at(-1)!, "occurredAt"), false);
  assert.equal(normalize(precisionStore).thoughts[0].eventTimePrecision, precision);
}
operations.openChainEditor(dateRoot.id);
fields["#edit-chain-datetime"].value = "2026-10-14T05:00:00";
await operations.submitEditChain(form);
assert.equal(sentBodies.at(-1)!.occurredAt, "2026-10-14T05:00:00");
assert.equal(normalize(precisionStore).thoughts[0].eventTimePrecision, "instant");
console.log("实际思考表单：date/unknown正文提交不夹带时间，明确补填才转instant通过。");
