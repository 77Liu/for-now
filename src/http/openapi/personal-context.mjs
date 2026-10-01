export const personalContextPaths = {
  "/personal-context": {
    get: {
      operationId: "getPersonalContext",
      summary: "查看当前账户的只读个人概要与来源",
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
        excerpt: { type: "string" },
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
