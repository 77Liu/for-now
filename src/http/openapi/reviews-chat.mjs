const response = schema => ({
  content: {
    "application/json": {
      schema: {
        allOf: [
          { $ref: "#/components/schemas/SuccessEnvelope" },
          { properties: { data: schema } }
        ]
      }
    }
  }
});

const errors = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "404": { $ref: "#/components/responses/NotFound" },
  "409": { $ref: "#/components/responses/Conflict" }
};

const listOperation = (operationId, schema, description) => ({
  operationId,
  parameters: [
    { $ref: "#/components/parameters/Cursor" },
    { $ref: "#/components/parameters/Limit" }
  ],
  responses: {
    "200": {
      description,
      ...response({ type: "array", items: { $ref: `#/components/schemas/${schema}` } })
    },
    ...errors
  }
});

const createOperation = (operationId, input, schema, description) => ({
  operationId,
  parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
  ...(input ? {
    requestBody: {
      required: true,
      content: { "application/json": { schema: { $ref: `#/components/schemas/${input}` } } }
    }
  } : {}),
  responses: {
    "200": { description: "幂等请求复用既有记录", ...response({ $ref: `#/components/schemas/${schema}` }) },
    "201": { description, ...response({ $ref: `#/components/schemas/${schema}` }) },
    ...errors
  }
});

const resourcePath = ({
  parameter,
  getOperationId,
  deleteOperationId,
  schema,
  description
}) => ({
  parameters: [{ $ref: `#/components/parameters/${parameter}` }],
  get: {
    operationId: getOperationId,
    responses: {
      "200": {
        description,
        headers: { ETag: { schema: { type: "string" } } },
        ...response({ $ref: `#/components/schemas/${schema}` })
      },
      ...errors
    }
  },
  delete: {
    operationId: deleteOperationId,
    parameters: [{ $ref: "#/components/parameters/IfMatch" }],
    responses: {
      "200": {
        description: "已移入回收站",
        ...response({ $ref: "#/components/schemas/TrashReference" })
      },
      "412": { $ref: "#/components/responses/PreconditionFailed" },
      "428": { $ref: "#/components/responses/PreconditionRequired" },
      ...errors
    }
  }
});

export const reviewsChatPaths = Object.freeze({
  "/chats": {
    get: listOperation("listChats", "Chat", "共参记录列表"),
    post: createOperation("createChat", "ChatInput", "Chat", "已生成并保存共参回答")
  },
  "/chats/{id}": resourcePath({
    parameter: "ChatId",
    getOperationId: "getChat",
    deleteOperationId: "deleteChat",
    schema: "Chat",
    description: "共参记录详情"
  }),
  "/analyses": {
    get: listOperation("listAnalyses", "Analysis", "认知复盘列表"),
    post: createOperation("createAnalysis", "", "Analysis", "已生成并保存认知复盘")
  },
  "/analyses/{id}": {
    ...resourcePath({
      parameter: "AnalysisId",
      getOperationId: "getAnalysis",
      deleteOperationId: "deleteAnalysis",
      schema: "Analysis",
      description: "认知复盘详情"
    }),
    patch: {
      operationId: "reviewAnalysis",
      parameters: [{ $ref: "#/components/parameters/IfMatch" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AnalysisReviewInput" }
          }
        }
      },
      responses: {
        "200": {
          description: "已记录用户对周期回望的核对结果",
          ...response({ $ref: "#/components/schemas/Analysis" })
        },
        "412": { $ref: "#/components/responses/PreconditionFailed" },
        "428": { $ref: "#/components/responses/PreconditionRequired" },
        ...errors
      }
    }
  },
  "/experiments": {
    get: listOperation("listExperiments", "Experiment", "个人实验列表"),
    post: createOperation("createExperiment", "ExperimentInput", "Experiment", "已创建个人实验")
  },
  "/experiments/{id}": resourcePath({
    parameter: "ExperimentId",
    getOperationId: "getExperiment",
    deleteOperationId: "deleteExperiment",
    schema: "Experiment",
    description: "个人实验详情"
  }),
  "/custom-metrics": {
    get: listOperation("listCustomMetrics", "CustomMetric", "自定义指标列表"),
    post: createOperation("createCustomMetric", "CustomMetricInput", "CustomMetric", "已创建自定义指标")
  },
  "/custom-metrics/{id}": resourcePath({
    parameter: "CustomMetricId",
    getOperationId: "getCustomMetric",
    deleteOperationId: "deleteCustomMetric",
    schema: "CustomMetric",
    description: "自定义指标详情"
  }),
  "/statistics": {
    get: {
      operationId: "getStatistics",
      parameters: [
        { name: "from", in: "query", required: false, schema: { type: "string", format: "date" } },
        { name: "to", in: "query", required: false, schema: { type: "string", format: "date" } }
      ],
      responses: {
        "200": {
          description: "记录、AI 用量与服务操作统计",
          ...response({ $ref: "#/components/schemas/StatisticsDashboard" })
        },
        ...errors
      }
    }
  }
});

const versionFields = {
  id: { type: "string" },
  createdAt: { type: "string", format: "date-time" },
  version: { type: "integer", minimum: 1 }
};

export const reviewsChatComponents = Object.freeze({
  parameters: Object.freeze({
    ChatId: { name: "id", in: "path", required: true, schema: { type: "string", maxLength: 100 } },
    AnalysisId: { name: "id", in: "path", required: true, schema: { type: "string", maxLength: 100 } },
    ExperimentId: { name: "id", in: "path", required: true, schema: { type: "string", maxLength: 100 } },
    CustomMetricId: { name: "id", in: "path", required: true, schema: { type: "string", maxLength: 100 } }
  }),
  schemas: Object.freeze({
    ReviewEventTimeInput: {
      type: "object",
      properties: {
        occurredAt: { type: "string" },
        occurredOn: { type: "string", format: "date" }
      }
    },
    ChatInput: {
      allOf: [
        { $ref: "#/components/schemas/ReviewEventTimeInput" },
        {
          type: "object",
          required: ["message"],
          properties: { message: { type: "string", maxLength: 12000 } }
        }
      ]
    },
    Chat: {
      type: "object",
      required: ["id", "createdAt", "occurredAt", "occurredOn", "message", "answer", "version"],
      properties: {
        ...versionFields,
        occurredAt: { type: "string", format: "date-time" },
        occurredOn: { type: "string", format: "date" },
        message: { type: "string" },
        answer: { type: "string" },
        reasoningContent: { type: "string" },
        annotations: { type: "array", items: { type: "object", additionalProperties: true } },
        annotationDrift: { type: "array", items: { type: "object", additionalProperties: true } }
      },
      additionalProperties: true
    },
    Analysis: {
      type: "object",
      required: ["id", "createdAt", "reason", "content", "version"],
      properties: {
        ...versionFields,
        reason: { type: "string" },
        content: { type: "string" },
        reviewStatus: { enum: ["candidate", "confirmed", "rejected", "legacy"] },
        reviewedAt: { type: "string" },
        reviewDisposition: { type: "string" },
        reasoningContent: { type: "string" },
        annotations: { type: "array", items: { type: "object", additionalProperties: true } },
        annotationDrift: { type: "array", items: { type: "object", additionalProperties: true } }
      },
      additionalProperties: true
    },
    AnalysisReviewInput: {
      type: "object",
      required: ["decision"],
      properties: {
        decision: { enum: ["confirm", "reject"] },
        reason: { type: "string", maxLength: 500 }
      },
      additionalProperties: false
    },
    ExperimentInput: {
      type: "object",
      required: ["hypothesis", "factor"],
      properties: {
        hypothesis: { type: "string", maxLength: 500 },
        factor: { type: "string", maxLength: 80 },
        outcome: { type: "string", enum: ["mood", "energy", "stress", "sleep"], default: "mood" },
        duration: { type: "integer", enum: [14, 30, 60], default: 30 }
      },
      additionalProperties: false
    },
    Experiment: {
      allOf: [
        { $ref: "#/components/schemas/ExperimentInput" },
        {
          type: "object",
          required: ["id", "createdAt", "status", "version"],
          properties: {
            ...versionFields,
            status: { type: "string", enum: ["active"] }
          },
          additionalProperties: true
        }
      ]
    },
    CustomMetricInput: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", maxLength: 40 },
        low: { type: "string", maxLength: 60, default: "很低" },
        high: { type: "string", maxLength: 60, default: "很高" }
      },
      additionalProperties: false
    },
    CustomMetric: {
      allOf: [
        { $ref: "#/components/schemas/CustomMetricInput" },
        {
          type: "object",
          required: ["id", "createdAt", "version"],
          properties: versionFields,
          additionalProperties: true
        }
      ]
    },
    StatisticsDashboard: {
      type: "object",
      required: ["records"],
      properties: {
        records: { type: "object", additionalProperties: true },
        ai: {
          type: "object",
          description: "Owner-only AI usage and cost extension",
          additionalProperties: true
        },
        service: {
          type: "object",
          description: "Owner-only service operation extension",
          required: ["completedWrites", "activeDays", "segmentationRequests", "topActions"],
          properties: {
            completedWrites: { type: "integer", minimum: 0 },
            activeDays: { type: "integer", minimum: 0 },
            segmentationRequests: { type: "integer", minimum: 0 },
            topActions: {
              type: "array",
              items: {
                type: "object",
                required: ["action", "count"],
                properties: {
                  action: { type: "string" },
                  count: { type: "integer", minimum: 1 }
                },
                additionalProperties: false
              }
            }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    }
  })
});

export const reviewsChatOpenApiFragment = Object.freeze({
  paths: reviewsChatPaths,
  components: reviewsChatComponents
});
