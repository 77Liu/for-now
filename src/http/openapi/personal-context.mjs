export const personalContextPaths = {
  "/personal-context": {
    get: {
      operationId: "getPersonalContext",
      summary: "查看当前账户的个人概要、可纠正理解与来源许可",
      responses: {
        "200": {
          description: "结构化个人概要、时间窗、预算和来源",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/SuccessEnvelope" },
                  {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/PersonalContextOverview" } }
                  }
                ]
              }
            }
          }
        },
        "401": { $ref: "#/components/responses/Unauthorized" }
      }
    }
  }
};

export const personalContextComponents = {
  schemas: {
    PersonalContextSource: {
      type: "object",
      required: [
        "id",
        "resourceType",
        "resourceId",
        "recordType",
        "informationType",
        "occurredAt",
        "occurredOn",
        "version",
        "permissionRevision",
        "excerpt",
        "location"
      ],
      properties: {
        id: { type: "string" },
        resourceType: { type: "string" },
        resourceId: { type: "string" },
        recordType: { type: "string" },
        informationType: { enum: ["user_fact", "user_viewpoint", "model_summary"] },
        informationTypeLabel: { type: "string" },
        occurredAt: { type: "string" },
        occurredOn: { type: "string" },
        version: { type: "integer", minimum: 1 },
        permissionRevision: { type: "integer", minimum: 0 },
        excerpt: { type: "string" },
        evidence: {
          type: "array",
          items: { $ref: "#/components/schemas/UserClaimEvidence" }
        },
        epistemic: { enum: ["known", "hypothesis"] },
        lifecycle: { enum: ["active"] },
        location: {
          type: "object",
          required: ["view", "targetId", "rootId", "targetKey", "occurredOn"],
          properties: {
            view: { type: "string" },
            targetId: { type: "string" },
            rootId: { type: "string" },
            targetKey: { type: "string" },
            occurredOn: { type: "string" },
            dailyType: { type: "string" }
          }
        }
      }
    },
    PersonalContextConclusion: {
      type: "object",
      required: ["id", "informationType", "informationTypeLabel", "title", "text", "sourceIds", "sampleNote"],
      properties: {
        id: { type: "string" },
        informationType: { enum: ["user_fact", "user_viewpoint", "model_summary"] },
        informationTypeLabel: { type: "string" },
        title: { type: "string" },
        text: { type: "string" },
        sourceIds: { type: "array", items: { type: "string" } },
        sampleNote: { type: "string" }
      }
    },
    PersonalContextSourcePermission: {
      type: "object",
      additionalProperties: false,
      required: [
        "sourceKey",
        "sourceRef",
        "recordType",
        "excerpt",
        "status",
        "contextAllowed",
        "learningAllowed",
        "learningStatus",
        "revision",
        "updatedAt",
        "occurredAt"
      ],
      properties: {
        sourceKey: { type: "string" },
        sourceRef: { $ref: "#/components/schemas/EvidenceSourceRef" },
        recordType: { type: "string" },
        excerpt: { type: "string" },
        status: { enum: ["active", "deleted", "unavailable"] },
        contextAllowed: { type: "boolean" },
        learningAllowed: { type: "boolean" },
        learningStatus: { type: "string" },
        revision: { type: "integer", minimum: 0 },
        updatedAt: { type: "string" },
        occurredAt: { type: "string" }
      }
    },
    PersonalContextPeriodicSynthesis: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "content",
        "reason",
        "reviewStatus",
        "reviewedAt",
        "reviewDisposition",
        "createdAt",
        "version"
      ],
      properties: {
        id: { type: "string" },
        content: { type: "string" },
        reason: { enum: ["manual", "weekly-background"] },
        reviewStatus: { enum: ["candidate", "confirmed", "rejected", "stale", "legacy"] },
        reviewedAt: { type: "string" },
        reviewDisposition: { type: "string" },
        createdAt: { type: "string" },
        version: { type: "integer", minimum: 1 }
      }
    },
    RecordCompressionTrendSource: {
      type: "object",
      required: ["id", "resourceType", "resourceId", "recordType", "informationType", "occurredOn", "version", "excerpt", "location"],
      properties: {
        id: { type: "string" },
        resourceType: { type: "string" },
        resourceId: { type: "string" },
        recordType: { type: "string" },
        informationType: { const: "user_original" },
        occurredOn: { type: "string", format: "date" },
        version: { type: "integer", minimum: 1 },
        excerpt: { type: "string" },
        location: {
          type: "object",
          required: ["view", "targetId", "rootId", "targetKey", "occurredOn"],
          properties: {
            view: { enum: ["today", "daily", "thoughts", "journals", "captures", "quotes", "keepsakes"] },
            targetId: { type: "string" },
            rootId: { type: "string" },
            targetKey: { type: "string" },
            occurredOn: { type: "string", format: "date" }
          }
        }
      }
    },
    RecordCompressionTrendRow: {
      type: "object",
      required: ["text", "sources"],
      properties: {
        text: { type: "string" },
        sources: { type: "array", items: { $ref: "#/components/schemas/RecordCompressionTrendSource" } }
      }
    },
    RecordCompressionTrendDay: {
      type: "object",
      required: ["localDate", "status", "completeness", "daily", "thoughts", "themes", "metrics"],
      properties: {
        localDate: { type: "string", format: "date" },
        status: { enum: ["ready", "missing"] },
        completeness: { type: "string" },
        daily: { type: "array", items: { $ref: "#/components/schemas/RecordCompressionTrendRow" } },
        thoughts: { type: "array", items: { $ref: "#/components/schemas/RecordCompressionTrendRow" } },
        themes: { type: "array", items: { $ref: "#/components/schemas/RecordCompressionTrendRow" } },
        metrics: { type: "array", items: { $ref: "#/components/schemas/RecordCompressionTrendMetric" } }
      }
    },
    RecordCompressionTrendMetric: {
      type: "object",
      required: ["name", "value", "unit", "sources"],
      properties: {
        name: { type: "string" },
        value: {},
        unit: { type: "string" },
        sources: { type: "array", items: { $ref: "#/components/schemas/RecordCompressionTrendSource" } }
      }
    },
    RecordCompressionTrend: {
      type: "object",
      required: ["timezone", "localDates", "coverage", "disclosure", "days"],
      properties: {
        timezone: { type: "string" },
        localDates: { type: "array", items: { type: "string", format: "date" } },
        coverage: {
          type: "object",
          required: ["windowDays", "summaryDays", "missingDays", "missingDates", "partialDays", "truncatedDays"],
          properties: {
            windowDays: { type: "integer", minimum: 0 },
            summaryDays: { type: "integer", minimum: 0 },
            missingDays: { type: "integer", minimum: 0 },
            missingDates: { type: "array", items: { type: "string", format: "date" } },
            partialDays: { type: "integer", minimum: 0 },
            truncatedDays: { type: "integer", minimum: 0 }
          }
        },
        disclosure: { type: "string" },
        days: { type: "array", items: { $ref: "#/components/schemas/RecordCompressionTrendDay" } }
      }
    },
    PersonalContextOverview: {
      type: "object",
      required: [
        "version",
        "generatedAt",
        "promptSha256",
        "timeWindow",
        "tokenBudget",
        "sourceCount",
        "sources",
        "conclusions",
        "userModel",
        "periodicSyntheses",
        "recordCompressionTrend",
        "disclosure",
        "readOnly"
      ],
      properties: {
        version: { type: "string" },
        generatedAt: { type: "string", format: "date-time" },
        promptSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        timeWindow: {
          type: "object",
          required: ["from", "to"],
          properties: { from: { type: "string" }, to: { type: "string" } }
        },
        tokenBudget: {
          type: "object",
          required: ["limit", "estimatedUsed", "remaining", "estimation"],
          properties: {
            limit: { type: "integer", minimum: 1 },
            estimatedUsed: { type: "integer", minimum: 0 },
            remaining: { type: "integer", minimum: 0 },
            estimation: { type: "string" }
          }
        },
        sourceCount: { type: "integer", minimum: 0 },
        sources: { type: "array", items: { $ref: "#/components/schemas/PersonalContextSource" } },
        conclusions: { type: "array", items: { $ref: "#/components/schemas/PersonalContextConclusion" } },
        userModel: { $ref: "#/components/schemas/UserModel" },
        periodicSyntheses: {
          type: "array",
          items: { $ref: "#/components/schemas/PersonalContextPeriodicSynthesis" }
        },
        recordCompressionTrend: {
          anyOf: [
            { $ref: "#/components/schemas/RecordCompressionTrend" },
            { type: "null" }
          ]
        },
        disclosure: { type: "string" },
        readOnly: { const: true }
      }
    }
  }
};

export const personalContextOpenApiFragment = {
  paths: personalContextPaths,
  components: { parameters: {}, schemas: personalContextComponents.schemas }
};
