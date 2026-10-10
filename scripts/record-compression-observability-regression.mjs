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

console.log("Record compression scheduler observability checks passed: lifecycle, counters, budget exhaustion, exception metadata, and privacy.");
