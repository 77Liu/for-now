import assert from "node:assert/strict";
import { createRecordCompressionScanObserver } from "../src/app/index.mjs";

const events = [];
const loggedContexts = [];
let clock = 10;
const observe = createRecordCompressionScanObserver({
  now: () => clock,
  requestStorage: {
    run(context, callback) {
      loggedContexts.push(context);
      return callback();
    }
  },
  async logEvent(type, event, fields) {
    events.push({ type, event, fields });
  }
});

const result = { queuedCount: 2, userId: "private-user", sourceId: "private-source" };
assert.equal(await observe(async () => {
  clock = 25;
  return {
    result,
    metrics: {
      candidateCount: 4,
      queuedCount: 2,
      waitingCount: 1,
      skippedCount: 1,
      budgetExhaustedCount: 1,
      userId: "private-user",
      sourceText: "private body",
      credential: "private credential"
    }
  };
}), result);
assert.deepEqual(events.map(({ event }) => event), [
  "record_compression.scan_started",
  "record_compression.budget_exhausted",
  "record_compression.scan_finished"
]);
assert.deepEqual(events[2].fields, {
  level: "info",
  candidateCount: 4,
  queuedCount: 2,
  waitingCount: 1,
  skippedCount: 1,
  failureCount: 0,
  budgetExhaustedCount: 1,
  durationMs: 15
});
assert.equal(events[1].fields.budgetExhaustedCount, 1);
assert.equal(JSON.stringify(events).includes("private-user"), false);
assert.equal(JSON.stringify(events).includes("private-source"), false);
assert.equal(JSON.stringify(events).includes("private body"), false);
assert.equal(JSON.stringify(events).includes("private credential"), false);
assert.equal(events.some(event => "userId" in event.fields || "sourceId" in event.fields), false);
assert.equal(loggedContexts.every(context => !context.user && !context.traceId), true);

events.length = 0;
await assert.rejects(observe(async () => {
  throw Object.assign(new Error("private request body and credential"), {
    code: "SYNTHETIC_SCAN_FAILURE"
  });
}), /private request body/);
assert.deepEqual(events.map(({ event }) => event), [
  "record_compression.scan_started",
  "record_compression.scan_failed"
]);
assert.equal(events[1].fields.failureCount, 1);
assert.equal(events[1].fields.error.code, "SYNTHETIC_SCAN_FAILURE");
assert.equal(JSON.stringify(events).includes("private request body"), false);
assert.equal(JSON.stringify(events).includes("credential"), false);

const messages = [];
const stagedObserver = createRecordCompressionScanObserver({
  async logEvent() {},
  async notify(message) { messages.push(message); }
});
await stagedObserver(async () => ({ result: { queuedCount: 1, waitingBudgetCount: 2,
  knownSpentCny: 0.1, reservedCny: 1, knownCalls: 1, reservedCalls: 1 } }));
assert.deepEqual(messages.map(message => message.title), ["日压缩已启动", "日压缩扫描登记完成", "日压缩扫描费用快照"]);
assert.ok(messages[2].lines.some(line => line.includes("扫描时已记录费用：¥0.1000")));
assert.ok(messages[2].lines.some(line => line.includes("任务待执行")));
assert.ok(!messages.some(message => message.title.includes("生成完成")));
await stagedObserver.settled({ status: "succeeded", operation: "daily", localDate: "2026-10-10",
  knownSpentCny: 0.25, knownCalls: 2, unknownCostCalls: 0 });
assert.equal(messages.at(-1).title, "日摘要生成完成");
assert.ok(messages.at(-1).lines.some(line => line.includes("¥0.2500")));
await stagedObserver.settled({ status: "failed", operation: "daily", localDate: "2026-10-10",
  knownSpentCny: 0.3, knownCalls: 3, unknownCostCalls: 1 });
assert.equal(messages.at(-1).title, "日摘要生成失败");
assert.ok(messages.at(-1).lines.some(line => line.includes("费用未知调用：1")));
messages.length = 0;
await stagedObserver(async () => ({ result: { queuedCount: 0, waitingBudgetCount: 0,
  knownSpentCny: 0.3, reservedCny: 0, knownCalls: 3, reservedCalls: 0 } }));
assert.equal(messages.length, 3);
assert.ok(messages.at(-1).lines.includes("本轮无生成任务。"));
await stagedObserver.settled({ status: "succeeded", operation: "daily", localDate: "2026-10-10", costReadFailed: true });
assert.ok(messages.at(-1).lines.some(line => line.includes("调用次数未知")));

console.log("Record compression scheduler observability checks passed: lifecycle, counters, budget exhaustion, exception metadata, and privacy.");
