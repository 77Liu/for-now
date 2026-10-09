import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./prompt-test-setup.mjs";
import { createReviewChatWorkflows } from "../src/app/index.mjs";
import { chatMessage } from "../src/modules/chats/index.mjs";
import { createTaskLifecycle } from "../src/modules/tasks/index.mjs";
import { evidenceSourceKey } from "../src/modules/user-model/index.mjs";

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const accountId = "chat-permission-boundary";
const occurredAt = "2026-10-10T08:00:00.000Z";
const occurredOn = "2026-10-10";

const longMessage = "用户问题".repeat(1_501);
assert.ok(longMessage.length > 6_000);
const parsedLongMessage = chatMessage({ message: longMessage });
assert.equal(parsedLongMessage.value, longMessage);
const normalizedLongTask = createTaskLifecycle({
  createId: () => "long-cold-chat",
  now: () => occurredAt,
  hash
}).create([], {
  kind: "chat",
  targetId: "",
  clientRequestId: "long-cold-chat-request",
  payload: {
    message: parsedLongMessage.value,
    occurredAt,
    occurredOn,
    eventTimeHash: "long-message-time-hash"
  }
}, () => null, { deferTargetInspection: true });
assert.equal(
  normalizedLongTask.task.payload.message,
  parsedLongMessage.value,
  "cold chat intent must retain the same message accepted by the ready path"
);

function emptyStore() {
  return {
    checkins: [],
    dailyRecords: [],
    captures: [],
    journals: [],
    thoughts: [],
    chats: [],
    books: [],
    keepsakes: [],
    quotes: [],
    experiments: [],
    analyses: [],
    customMetrics: [],
    actions: [],
    habits: [],
    habitCheckins: [],
    evidenceSources: [],
    evidencePermissions: [],
    perceptionEvents: [],
    trash: [],
    commercialization: { assumptions: { common: { usdCny: 7.2 } } },
    onboarding: {}
  };
}

function permissionFor(chat, {
  contextAllowed,
  revision
}) {
  return {
    schemaVersion: 1,
    accountId,
    sourceKey: evidenceSourceKey({
      resourceType: "chat",
      resourceId: chat.id,
      rootId: "",
      targetKey: "message",
      version: chat.version || 1
    }),
    contextAllowed,
    learningAllowed: contextAllowed,
    revision,
    updatedAt: occurredAt
  };
}

function makeWorkflow(readStore, {
  generate = async () => ({ content: "生成结果" }),
  save = () => ({ value: { id: "saved-chat" } }),
  getAccountId = () => accountId
} = {}) {
  let saveCount = 0;
  const workflows = createReviewChatWorkflows({
    repository: {
      async read() { return structuredClone(readStore()); },
      async update(operation) { return operation(readStore()); }
    },
    chats: {
      findRequest: async () => null,
      save: async (...args) => {
        saveCount += 1;
        return save(...args);
      },
      saveInStore: (...args) => {
        saveCount += 1;
        return save(...args);
      }
    },
    reviews: {},
    generate,
    hash,
    contextKey: () => accountId,
    getAccountId
  });
  return {
    workflows,
    get saveCount() { return saveCount; }
  };
}

const deniedChat = {
  id: "revoked-chat",
  version: 1,
  message: "不得发送的撤权历史正文",
  answer: "撤权会话中的模型回复",
  occurredAt,
  occurredOn
};
const allowedChat = {
  id: "allowed-chat",
  version: 1,
  message: "仍获准的历史问题",
  answer: "仍获准的历史回复",
  occurredAt,
  occurredOn
};

let syncStore = emptyStore();
syncStore.chats = [deniedChat, allowedChat];
syncStore.evidencePermissions = [
  permissionFor(deniedChat, { contextAllowed: false, revision: 2 }),
  permissionFor(allowedChat, { contextAllowed: true, revision: 1 })
];
let syncHistory;
const syncWorkflow = makeWorkflow(() => syncStore, {
  generate: async (_prompt, options) => {
    syncHistory = options.history;
    return { content: "同步回复" };
  }
});
await syncWorkflow.workflows.answerChat({
  message: "新问题",
  eventTime: { occurredAt, occurredOn }
});
assert.ok(syncHistory.some(item => item.content === allowedChat.message));
assert.ok(syncHistory.some(item => item.content === allowedChat.answer));
assert.ok(!syncHistory.some(item => item.content.includes("撤权")));

let durableStore = emptyStore();
durableStore.chats = [allowedChat];
durableStore.evidencePermissions = [
  permissionFor(allowedChat, { contextAllowed: true, revision: 1 })
];
const durableWorkflow = makeWorkflow(() => durableStore);
const task = {
  kind: "chat",
  clientRequestId: "durable-chat-request",
  payload: { message: "持久任务问题", occurredAt, occurredOn, eventTimeHash: "time-hash" }
};
const generationWork = durableWorkflow.workflows.personalizedTaskHandler.prepare(
  structuredClone(durableStore),
  task
);
assert.ok(generationWork.history.some(item => item.content === allowedChat.message));

durableStore = structuredClone(durableStore);
durableStore.evidencePermissions[0] = permissionFor(allowedChat, {
  contextAllowed: false,
  revision: 2
});
const retryWork = durableWorkflow.workflows.personalizedTaskHandler.prepare(
  structuredClone(durableStore),
  task
);
assert.ok(!retryWork.history.some(item => item.content === allowedChat.message));
assert.notEqual(retryWork.contextFingerprint, generationWork.contextFingerprint);
assert.throws(() => durableWorkflow.workflows.personalizedTaskHandler.save(
  structuredClone(durableStore),
  retryWork,
  task,
  {
    content: "撤权之后不得落库的结果",
    contextReceipt: generationWork.contextReceipt
  }
), error => error.code === "AI_TASK_STALE");
assert.equal(durableWorkflow.saveCount, 0);

let providerRaceStore = emptyStore();
providerRaceStore.chats = [allowedChat];
providerRaceStore.evidencePermissions = [
  permissionFor(allowedChat, { contextAllowed: true, revision: 1 })
];
const providerRaceWorkflow = makeWorkflow(() => providerRaceStore, {
  generate: async () => {
    providerRaceStore.evidencePermissions[0] = permissionFor(allowedChat, {
      contextAllowed: false,
      revision: 2
    });
    return { content: "撤权后返回的结果" };
  }
});
await assert.rejects(providerRaceWorkflow.workflows.answerChat({
  message: "竞态问题",
  eventTime: { occurredAt, occurredOn }
}), error => error.code === "AI_TASK_STALE");
assert.equal(providerRaceWorkflow.saveCount, 0);

let activeAccount = accountId;
let accountRaceStore = emptyStore();
accountRaceStore.chats = [allowedChat];
const accountRaceWorkflow = makeWorkflow(() => accountRaceStore, {
  getAccountId: () => activeAccount
});
const accountWork = accountRaceWorkflow.workflows.personalizedTaskHandler.prepare(
  structuredClone(accountRaceStore),
  task
);
activeAccount = "different-account";
assert.throws(() => accountRaceWorkflow.workflows.personalizedTaskHandler.save(
  structuredClone(accountRaceStore),
  accountWork,
  task,
  {
    content: "账号变化后不得落库的结果",
    contextReceipt: accountWork.contextReceipt
  }
), error => error.code === "AI_TASK_STALE");
assert.equal(accountRaceWorkflow.saveCount, 0);

console.log("Review chat permission boundary regression passed");
