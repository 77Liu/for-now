const envelope = schema => ({
  content: {
    "application/json": {
      schema: {
        allOf: [
          { $ref: "#/components/schemas/SuccessEnvelope" },
          { type: "object", properties: { data: schema } }
        ]
      }
    }
  }
});

const error = description => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ErrorEnvelope" }
    }
  }
});

export const onboardingV2Paths = {
  "/onboarding-v2/schema": {
    get: {
      operationId: "getOnboardingV2Schema",
      summary: "读取稳定的五问配置与输入限制",
      responses: {
        "200": {
          description: "五问配置",
          ...envelope({ $ref: "#/components/schemas/OnboardingV2Schema" })
        },
        "401": { $ref: "#/components/responses/Unauthorized" }
      }
    }
  },
  "/onboarding-v2/session": {
    get: {
      operationId: "getOnboardingV2Session",
      summary: "恢复当前账户的五问会话",
      responses: {
        "200": {
          description: "当前会话，ETag 用于后续条件更新",
          headers: { ETag: { schema: { type: "string" } } },
          ...envelope({ $ref: "#/components/schemas/OnboardingV2State" })
        },
        "401": { $ref: "#/components/responses/Unauthorized" }
      }
    },
    patch: {
      operationId: "updateOnboardingV2Session",
      summary: "部分保存、暂停、跳过或完成五问会话",
      parameters: [
        { $ref: "#/components/parameters/IfMatch" },
        { $ref: "#/components/parameters/IdempotencyKey" }
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/OnboardingV2SessionPatch" }
          }
        }
      },
      responses: {
        "200": {
          description: "会话已保存或幂等重放",
          headers: { ETag: { schema: { type: "string" } } },
          ...envelope({ $ref: "#/components/schemas/OnboardingV2State" })
        },
        "400": { $ref: "#/components/responses/BadRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "409": { $ref: "#/components/responses/Conflict" },
        "422": error("字段校验失败"),
        "428": { $ref: "#/components/responses/PreconditionRequired" }
      }
    }
  }
};

const answerMetadata = {
  occurredAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
  version: { type: "integer", minimum: 1 },
  contextAllowed: { type: "boolean" }
};

const collaborationAxis = {
  type: "object",
  required: ["value", "source"],
  properties: {
    value: { type: "string" },
    source: { enum: ["user", "system_default"] }
  },
  additionalProperties: false
};

export const onboardingV2Components = {
  schemas: {
    OnboardingV2Schema: {
      type: "object",
      required: ["schemaVersion", "questions", "steps", "statuses", "defaults"],
      properties: {
        schemaVersion: { const: 2 },
        questions: {
          type: "array",
          minItems: 5,
          maxItems: 5,
          items: {
            type: "object",
            required: ["questionId", "step", "title", "prompt", "kind", "canSkip", "limits"],
            properties: {
              questionId: {
                enum: ["currentContext", "desiredChanges", "recentObstacles", "dailyRhythm", "collaboration"]
              },
              step: { enum: ["q1", "q2", "q3", "q4", "q5"] },
              title: { type: "string" },
              prompt: { type: "string" },
              kind: { enum: ["text", "list", "collaboration"] },
              canSkip: { const: true },
              limits: { type: "object", additionalProperties: { type: "integer" } },
              horizons: { type: "array", items: { type: "string" } },
              axes: { type: "object", additionalProperties: true }
            }
          }
        },
        steps: { type: "array", items: { type: "string" } },
        statuses: { type: "array", items: { type: "string" } },
        defaults: { type: "object", additionalProperties: { type: "string" } }
      }
    },
    OnboardingV2TextAnswer: {
      type: "object",
      required: ["questionId", "rawText", "occurredAt", "updatedAt", "version", "contextAllowed"],
      properties: {
        questionId: { enum: ["currentContext", "dailyRhythm"] },
        rawText: { type: "string", maxLength: 2000 },
        ...answerMetadata
      }
    },
    OnboardingV2ListItem: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", maxLength: 300 },
        horizon: { enum: ["3m", "6m", "12m", "custom", "unknown"] },
        horizonText: { type: "string", maxLength: 100 }
      },
      additionalProperties: false
    },
    OnboardingV2ListAnswer: {
      type: "object",
      required: ["questionId", "structuredValue", "occurredAt", "updatedAt", "version", "contextAllowed"],
      properties: {
        questionId: { enum: ["desiredChanges", "recentObstacles"] },
        structuredValue: {
          type: "array",
          maxItems: 3,
          items: { $ref: "#/components/schemas/OnboardingV2ListItem" }
        },
        ...answerMetadata
      }
    },
    OnboardingV2Collaboration: {
      type: "object",
      required: [
        "responseLength",
        "suggestionMode",
        "challengeStyle",
        "additionalBoundary",
        "contextAllowed"
      ],
      properties: {
        responseLength: collaborationAxis,
        suggestionMode: collaborationAxis,
        challengeStyle: collaborationAxis,
        additionalBoundary: { type: "string", maxLength: 1000 },
        contextAllowed: { type: "boolean" }
      }
    },
    OnboardingV2Session: {
      type: "object",
      required: [
        "id",
        "schemaVersion",
        "status",
        "step",
        "revision",
        "answers",
        "collaboration",
        "startedAt",
        "pausedAt",
        "completedAt",
        "updatedAt"
      ],
      properties: {
        id: { type: "string" },
        schemaVersion: { const: 2 },
        status: { enum: ["draft", "paused", "completed", "skipped"] },
        step: { enum: ["welcome", "q1", "q2", "q3", "q4", "q5", "review", "candidates", "firstAction"] },
        revision: { type: "integer", minimum: 0 },
        answers: {
          type: "object",
          properties: {
            currentContext: { $ref: "#/components/schemas/OnboardingV2TextAnswer" },
            desiredChanges: { $ref: "#/components/schemas/OnboardingV2ListAnswer" },
            recentObstacles: { $ref: "#/components/schemas/OnboardingV2ListAnswer" },
            dailyRhythm: { $ref: "#/components/schemas/OnboardingV2TextAnswer" }
          },
          additionalProperties: false
        },
        collaboration: { $ref: "#/components/schemas/OnboardingV2Collaboration" },
        startedAt: { type: "string" },
        pausedAt: { type: "string" },
        completedAt: { type: "string" },
        updatedAt: { type: "string" }
      }
    },
    OnboardingV2State: {
      type: "object",
      required: ["schemaVersion", "session", "readiness", "migration"],
      properties: {
        schemaVersion: { const: 2 },
        session: { $ref: "#/components/schemas/OnboardingV2Session" },
        readiness: { enum: ["empty", "partial", "usable"] },
        migration: {
          type: "object",
          required: ["selectedFlow", "entryPolicy", "legacy"],
          properties: {
            selectedFlow: { enum: ["undecided", "legacy", "v2"] },
            entryPolicy: { enum: ["choose", "already_onboarded", "v2"] },
            legacy: { type: "object", additionalProperties: true }
          }
        }
      }
    },
    OnboardingV2TextAnswerPatch: {
      type: ["object", "null"],
      properties: {
        rawText: { type: "string", maxLength: 2000 },
        occurredAt: { type: "string", format: "date-time" },
        contextAllowed: { type: "boolean" }
      },
      required: ["rawText"],
      additionalProperties: false
    },
    OnboardingV2ListAnswerPatch: {
      type: ["object", "null"],
      properties: {
        structuredValue: {
          type: "array",
          maxItems: 3,
          items: { $ref: "#/components/schemas/OnboardingV2ListItem" }
        },
        occurredAt: { type: "string", format: "date-time" },
        contextAllowed: { type: "boolean" }
      },
      required: ["structuredValue"],
      additionalProperties: false
    },
    OnboardingV2SessionPatch: {
      type: "object",
      properties: {
        status: { enum: ["draft", "paused", "completed", "skipped"] },
        step: { enum: ["welcome", "q1", "q2", "q3", "q4", "q5", "review", "candidates", "firstAction"] },
        selectedFlow: { enum: ["legacy", "v2"] },
        answers: {
          type: "object",
          properties: {
            currentContext: { $ref: "#/components/schemas/OnboardingV2TextAnswerPatch" },
            desiredChanges: { $ref: "#/components/schemas/OnboardingV2ListAnswerPatch" },
            recentObstacles: { $ref: "#/components/schemas/OnboardingV2ListAnswerPatch" },
            dailyRhythm: { $ref: "#/components/schemas/OnboardingV2TextAnswerPatch" }
          },
          additionalProperties: false
        },
        collaboration: {
          type: "object",
          properties: {
            responseLength: collaborationAxis,
            suggestionMode: collaborationAxis,
            challengeStyle: collaborationAxis,
            additionalBoundary: { type: "string", maxLength: 1000 },
            contextAllowed: { type: "boolean" }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    }
  }
};

export const onboardingV2OpenApiFragment = Object.freeze({
  paths: onboardingV2Paths,
  components: onboardingV2Components
});
