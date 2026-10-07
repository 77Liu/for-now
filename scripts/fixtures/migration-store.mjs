import crypto from "node:crypto";

const claimText = "正在适应新的工作节奏";
const claimHash = crypto.createHash("sha256").update(claimText).digest("hex");

export function migrationStore(accountId = "fixture-account") {
  const captureSourceKey = JSON.stringify(["capture", "shared-id", "", ""]);
  const claimSourceKey = JSON.stringify(["userClaim", "claim-1", "", ""]);
  return {
    version: 17,
    checkins: [{ id: "shared-id", mood: 4, custom: { calm: 3 }, notes: { mood: "原始心情" } }],
    dailyRecords: [{ id: "health-1", type: "exercise", duration: 30, attachmentPaths: ["/attachments/run.png"] }],
    captures: [{
      id: "shared-id", content: "原始捕念", version: 3, futureFlag: { nested: [null, ""] },
      annotations: [{
        id: "annotation-1", text: "用户批注", targetKey: "content",
        replies: [{ id: "reply-1", text: "用户回复" }],
        shenji: [{ id: "exchange-1", message: "@神鸡", answer: "派生回答", sourceTaskId: "expired-task" }]
      }], annotationDrift: []
    }],
    journals: [{
      id: "journal-1", content: "日记原文", reflections: [{ id: "reflection-1", content: "回望", authorType: "ai" }],
      annotations: [], annotationDrift: [{ id: "drift-1", text: "漂移批注", originalTargetKey: "content", replies: [] }]
    }],
    journalDraft: { journalId: "journal-1", title: "", content: "未保存草稿" },
    thoughts: [
      {
        id: "root-1", type: "question", authorType: "user", content: "原始问题", version: 2,
        occurredAt: "2026-09-28T03:00:00.000Z", occurredOn: "2026-09-28",
        remarks: [{ id: "remark-1", text: "原始备注" }],
        followUps: [{ id: "follow-1", question: "追问", answer: "", version: 1 }],
        annotations: [{ id: "thought-annotation-1", text: "问题批注", shenji: [] }], annotationDrift: []
      },
      { id: "answer-1", type: "answer", relatedTo: "root-1", content: "AI 回答", authorType: "ai", sourceTaskId: "task-1" }
    ],
    chats: [{ id: "chat-1", message: "用户", answer: "模型", reasoningContent: "推理", annotations: [] }],
    books: [{ id: "book-1", title: "书", notes: [{ id: "note-1", content: "笔记", type: "record" }], annotations: [] }],
    keepsakes: [{ id: "keepsake-1", originalPath: "/attachments/original.png", cutoutPath: "/attachments/cutout.png" }],
    quotes: [{ id: "quote-1", content: "善言", source: "出处", annotations: [] }],
    experiments: [{ id: "experiment-1", title: "实验", metrics: ["calm"] }],
    analyses: [{ id: "analysis-1", content: "认知复盘", authorType: "ai" }],
    customMetrics: [{ id: "calm", name: "平静", options: [1, 2, 3] }],
    trash: [{
      id: "trash-1", type: "capture", resourceId: "deleted-1", location: { collection: "captures", index: 2 },
      payload: { id: "deleted-1", content: "已删原文", attachmentPaths: ["/attachments/trash.png"], annotations: [] }
    }],
    attachmentCleanup: [{ path: "/attachments/orphan.png", attempts: 2, errorCode: "RETRY" }],
    aiTasks: [
      { id: "task-1", kind: "thoughtAnswer", resourceType: "thought", targetId: "root-1", resultId: "answer-1", status: "succeeded", inputVersion: 2 },
      { id: "task-old", kind: "thoughtAnswer", targetId: "deleted-root", status: "stale", retryOf: "task-1" },
      { id: "task-follow", kind: "followUpAnswer", targetId: "root-1", subtargetId: "follow-1", status: "queued" },
      { id: "task-annotation", kind: "annotationShenji", resourceType: "capture", targetId: "shared-id", subtargetId: "annotation-1", resultId: "exchange-1", status: "succeeded" },
      { id: "task-onboarding-claims", kind: "onboardingClaimExtraction", resourceType: "onboardingV2", targetId: "onboarding-v2", resultId: "task-onboarding-claims", status: "succeeded", inputVersion: 1 }
    ],
    notifications: [{ id: "notification-1", taskId: "task-1", resourceType: "thought", targetId: "root-1", readAt: "" }],
    actions: [{ id: "action-1", title: "后续行动", status: "active", priority: "high", sourceRef: { type: "thought", id: "root-1" } }],
    habits: [{ id: "habit-1", title: "每日复盘", frequency: { kind: "daily" }, status: "active" }],
    habitCheckins: [{ id: "habit-checkin-1", habitId: "habit-1", occurredOn: "2026-09-29", feeling: "稳定" }],
    feedback: [{ id: "feedback-1", body: "反馈原文", status: "submitted", appVersion: "0.2.0" }],
    validationLedger: [{ id: "validation-1", participantRef: "成员-01", status: "invited", consent: false }],
    onboarding: { answers: { worldview: "A" }, profile: { introduction: "可修改初始资料" } },
    onboardingV2: {
      schemaVersion: 2,
      session: {
        id: "onboarding-v2",
        schemaVersion: 2,
        status: "completed",
        step: "firstAction",
        revision: 1,
        answers: {
          currentContext: {
            questionId: "currentContext",
            rawText: claimText,
            occurredAt: "2026-10-02T01:00:00.000Z",
            updatedAt: "2026-10-02T01:00:00.000Z",
            version: 1,
            contextAllowed: true
          }
        },
        collaboration: {},
        startedAt: "2026-10-02T01:00:00.000Z",
        pausedAt: "",
        completedAt: "2026-10-02T01:00:00.000Z",
        updatedAt: "2026-10-02T01:00:00.000Z"
      },
      readiness: "partial",
      migration: { selectedFlow: "v2", entryPolicy: "v2", legacy: {} }
    },
    userClaims: [{
      id: "claim-1",
      domain: "context",
      statement: claimText,
      scope: "最近",
      epistemic: "known",
      lifecycle: "active",
      confidence: null,
      evidenceStrength: "self_report",
      evidence: [{
        sourceType: "onboardingV2Answer",
        sourceId: "currentContext",
        sourceVersion: 1,
        contentSha256: claimHash,
        span: [0, claimText.length]
      }],
      validFrom: "2026-10-02",
      validTo: null,
      confirmedAt: "2026-10-02T01:02:00.000Z",
      lastReviewedAt: "2026-10-02T01:02:00.000Z",
      supersedes: null,
      contextAllowed: true,
      createdAt: "2026-10-02T01:01:00.000Z",
      updatedAt: "2026-10-02T01:02:00.000Z",
      version: 2,
      sourceTaskId: "task-onboarding-claims"
    }],
    modelUnknowns: [{
      id: "unknown-1",
      question: "怎样减少频繁切换？",
      domain: "behavior",
      reason: "下一步建议需要知道可调整的边界",
      relatedEvidence: ["claim-1"],
      impactOnNextAnswer: "影响行动建议的粒度",
      resolvedBy: "claim-1",
      createdAt: "2026-10-02T01:03:00.000Z",
      updatedAt: "2026-10-02T01:03:00.000Z",
      version: 1,
      sourceTaskId: "task-onboarding-claims"
    }],
    evidenceSources: [{
      schemaVersion: 1,
      id: "evidence-capture-1",
      accountId,
      sourceRef: {
        resourceType: "capture",
        resourceId: "shared-id",
        rootId: "",
        targetKey: "",
        version: 3
      },
      eventId: "event-shared-1",
      origin: "user",
      informationType: "user_viewpoint",
      contentSha256: crypto.createHash("sha256").update("原始捕念").digest("hex"),
      contentLength: "原始捕念".length,
      span: [0, "原始捕念".length],
      occurredAt: "2026-09-29T01:00:00.000Z",
      recordedAt: "2026-09-29T01:00:01.000Z",
      permissionRevision: 2,
      derivedFrom: []
    }, {
      schemaVersion: 1,
      id: "evidence-claim-1",
      accountId,
      sourceRef: {
        resourceType: "userClaim",
        resourceId: "claim-1",
        rootId: "",
        targetKey: "",
        version: 2
      },
      eventId: "event-shared-1",
      origin: "ai",
      informationType: "model_derived",
      contentSha256: claimHash,
      contentLength: claimText.length,
      span: null,
      occurredAt: "2026-10-02T01:00:00.000Z",
      recordedAt: "2026-10-02T01:03:00.000Z",
      permissionRevision: 1,
      derivedFrom: [{
        sourceKey: captureSourceKey,
        version: 3,
        contentSha256: crypto.createHash("sha256").update("原始捕念").digest("hex"),
        permissionRevision: 2
      }]
    }],
    evidencePermissions: [{
      schemaVersion: 1,
      accountId,
      sourceKey: captureSourceKey,
      contextAllowed: true,
      learningAllowed: true,
      revision: 2,
      updatedAt: "2026-09-29T01:00:01.000Z"
    }, {
      schemaVersion: 1,
      accountId,
      sourceKey: claimSourceKey,
      contextAllowed: true,
      learningAllowed: false,
      revision: 1,
      updatedAt: "2026-10-02T01:03:00.000Z"
    }],
    perceptionEvents: [{
      schemaVersion: 1,
      id: "perception-event-1",
      accountId,
      kind: "created",
      sourceRef: {
        resourceType: "capture",
        resourceId: "shared-id",
        rootId: "",
        targetKey: "",
        version: 3
      },
      eventId: "event-shared-1",
      contentSha256: crypto.createHash("sha256").update("原始捕念").digest("hex"),
      occurredAt: "2026-09-29T01:00:00.000Z",
      recordedAt: "2026-09-29T01:00:01.000Z",
      permissionRevision: 2,
      perceptionVersion: "perception-v1"
    }],
    commercialization: { model: "subscription", parameters: { price: 12.5 } },
    unknownExtension: JSON.parse('{"__proto__":{"keep":true},"values":[null,false,0,""],"path":"/attachments/extension.png"}')
  };
}
