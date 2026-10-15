const response = schema => ({
  content: {
    "application/json": {
      schema: { allOf: [{ $ref: "#/components/schemas/SuccessEnvelope" }, { properties: { data: schema } }] }
    }
  }
});

const errors = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "404": { $ref: "#/components/responses/NotFound" },
  "409": { $ref: "#/components/responses/Conflict" }
};

export const thoughtPaths = Object.freeze({
  "/thought-chains": {
    get: {
      operationId: "listThoughtChains",
      parameters: [
        { $ref: "#/components/parameters/Cursor" },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 20, default: 20 }
        },
        {
          name: "q",
          in: "query",
          required: false,
          description: "按问题、标签及链内公开内容搜索；多个空格分隔词需全部命中",
          schema: { type: "string", maxLength: 200 }
        },
        {
          name: "tag",
          in: "query",
          required: false,
          description: "按思绪链内标签精确筛选",
          schema: { type: "string", maxLength: 30 }
        },
        {
          name: "sort",
          in: "query",
          required: false,
          description: "列表排序时间口径",
          schema: { type: "string", enum: ["occurred", "created"], default: "occurred" }
        }
      ],
      responses: {
        "200": {
          description: "轻量思绪链摘要列表；完整内容块按详情接口读取",
          ...response({ type: "array", items: { $ref: "#/components/schemas/ThoughtChainSummary" } })
        },
        ...errors
      }
    },
    post: {
      operationId: "createThoughtChain",
      parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/ThoughtChainInput" } } }
      },
      responses: {
        "201": { description: "已创建思绪链", ...response({ $ref: "#/components/schemas/ThoughtChainMutation" }) },
        "412": { $ref: "#/components/responses/PreconditionFailed" },
        ...errors
      }
    }
  },
  "/thought-chains/{id}": {
    parameters: [{ $ref: "#/components/parameters/ThoughtChainId" }],
    get: {
      operationId: "getThoughtChain",
      responses: {
        "200": {
          description: "思绪链；ETag 为根记录版本",
          headers: { ETag: { schema: { type: "string" } } },
          ...response({ $ref: "#/components/schemas/ThoughtChain" })
        },
        ...errors
      }
    },
    patch: {
      operationId: "updateThoughtChain",
      parameters: [{ $ref: "#/components/parameters/IfMatch" }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/ThoughtChainInput" } } }
      },
      responses: {
        "200": {
          description: "已更新思绪链",
          headers: { ETag: { schema: { type: "string" } } },
          ...response({ $ref: "#/components/schemas/Thought" })
        },
        "412": { $ref: "#/components/responses/PreconditionFailed" },
        "428": { $ref: "#/components/responses/PreconditionRequired" },
        ...errors
      }
    },
    delete: {
      operationId: "deleteThoughtChain",
      parameters: [{ $ref: "#/components/parameters/IfMatch" }],
      responses: {
        "200": { description: "已移入回收站", ...response({ $ref: "#/components/schemas/TrashReference" }) },
        "412": { $ref: "#/components/responses/PreconditionFailed" },
        "428": { $ref: "#/components/responses/PreconditionRequired" },
        ...errors
      }
    }
  },
  "/thought-chains/{id}/answers": {
    parameters: [{ $ref: "#/components/parameters/ThoughtChainId" }],
    post: {
      operationId: "generateThoughtAnswer",
      parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
      responses: {
        "200": {
          description: "幂等请求复用既有后台回答任务",
          ...response({ $ref: "#/components/schemas/ThoughtAnswerTask" })
        },
        "202": {
          description: "回答任务已持久化；核心用户模型未就绪时状态为 waiting_for_user_model",
          ...response({ $ref: "#/components/schemas/ThoughtAnswerTask" })
        },
        ...errors
      }
    }
  }
});

export const thoughtComponents = Object.freeze({
  parameters: Object.freeze({
    ThoughtChainId: { name: "id", in: "path", required: true, schema: { type: "string", maxLength: 100 } }
  }),
  schemas: Object.freeze({
    Thought: {
      type: "object",
      required: ["id", "type", "content", "version"],
      properties: {
        id: { type: "string" },
        type: { enum: ["question", "idea", "answer", "record"] },
        content: { type: "string" },
        version: { type: "integer", minimum: 1 },
        occurredAt: { $ref: "#/components/schemas/OccurrenceTimestamp" },
        occurredOn: { type: "string", format: "date" },
        tags: { type: "array", items: { type: "string" } },
        attachmentPaths: { type: "array", maxItems: 2, uniqueItems: true, items: { $ref: "#/components/schemas/ContentAttachmentPath" } },
        relatedTo: { type: ["string", "null"] },
        sourceRef: { $ref: "#/components/schemas/ThoughtSourceRef" }
      },
      additionalProperties: true
    },
    ThoughtAnswerTask: {
      type: "object",
      required: [
        "id", "kind", "resourceType", "targetId", "subtargetId", "inputVersion",
        "subtargetVersion", "status", "createdAt", "startedAt", "completedAt",
        "resultId", "error", "retryOf"
      ],
      properties: {
        id: { type: "string" },
        kind: { const: "thoughtAnswer" },
        resourceType: { const: "thought" },
        targetId: { type: "string" },
        subtargetId: { type: "string" },
        inputVersion: { type: "integer", minimum: 0 },
        subtargetVersion: { type: "integer", minimum: 0 },
        status: { enum: ["queued", "running", "waiting_for_user_model", "succeeded", "failed", "stale", "cancelled"] },
        createdAt: { type: "string", format: "date-time" },
        startedAt: { type: "string" },
        completedAt: { type: "string" },
        resultId: { type: "string" },
        error: { type: "string" },
        errorCode: { type: "string" },
        retryOf: { type: "string" }
      },
      additionalProperties: false
    },
    ThoughtSourceRef: {
      type: "object",
      description: "创建时可选的来源念起引用；创建后不可修改",
      required: ["type", "id", "version"],
      properties: {
        type: { const: "capture" },
        id: { type: "string", minLength: 1, maxLength: 100 },
        version: { type: "integer", minimum: 1 }
      },
      additionalProperties: false
    },
    ThoughtChainSummaryPreview: {
      type: "object",
      required: ["kind", "content", "truncated"],
      properties: {
        kind: { enum: ["conclusion", "idea"] },
        content: { type: "string", maxLength: 400 },
        truncated: { type: "boolean" }
      },
      additionalProperties: false
    },
    ThoughtChainSummary: {
      type: "object",
      description: "列表专用公开投影，不包含完整内容块、模型草稿、推理或上下文收据",
      required: [
        "id",
        "type",
        "content",
        "contentTruncated",
        "version",
        "occurredAt",
        "occurredOn",
        "createdAt",
        "updatedAt",
        "tags",
        "disposition",
        "attachmentCount",
        "blockCount",
        "answerCount",
        "preview"
      ],
      properties: {
        id: { type: "string" },
        type: { const: "question" },
        content: {
          type: "string",
          maxLength: 600,
          description: "问题预览；contentTruncated 为 true 时从详情读取全文"
        },
        contentTruncated: { type: "boolean" },
        version: { type: "integer", minimum: 1 },
        occurredAt: { anyOf: [{ $ref: "#/components/schemas/OccurrenceTimestamp" }, { type: "null" }] },
        occurredOn: { type: ["string", "null"], format: "date" },
        createdAt: { type: ["string", "null"], format: "date-time" },
        updatedAt: { type: ["string", "null"], format: "date-time" },
        tags: {
          type: "array",
          maxItems: 8,
          items: { type: "string", maxLength: 30 }
        },
        disposition: { enum: ["pending", "kept", "discarded"] },
        attachmentCount: { type: "integer", minimum: 0, maximum: 2 },
        blockCount: { type: "integer", minimum: 0 },
        answerCount: { type: "integer", minimum: 0 },
        preview: {
          anyOf: [
            { $ref: "#/components/schemas/ThoughtChainSummaryPreview" },
            { type: "null" }
          ]
        },
        sourceRef: { $ref: "#/components/schemas/ThoughtSourceRef" }
      },
      additionalProperties: false
    },
    ThoughtChain: {
      allOf: [
        { $ref: "#/components/schemas/Thought" },
        {
          type: "object",
          required: ["blocks"],
          properties: { blocks: { type: "array", items: { $ref: "#/components/schemas/Thought" } } }
        }
      ]
    },
    ThoughtChainInput: {
      type: "object",
      anyOf: [
        { required: ["question"], properties: { question: { type: "string", minLength: 1 } } },
        { required: ["attachmentPaths"], properties: { attachmentPaths: { type: "array", minItems: 1 } } }
      ],
      properties: {
        question: { type: "string" },
        attachmentPaths: { type: "array", maxItems: 2, uniqueItems: true, items: { $ref: "#/components/schemas/ContentAttachmentPath" } },
        idea: { type: "string" },
        answer: { type: "string" },
        occurredAt: { type: "string" },
        occurredOn: { type: "string", format: "date" },
        tags: { type: "array", maxItems: 8, items: { type: "string", maxLength: 30 } },
        generateAnswer: { type: "boolean" },
        sourceRef: { $ref: "#/components/schemas/ThoughtSourceRef" }
      },
      additionalProperties: false
    },
    ThoughtChainMutation: {
      type: "object",
      required: ["items", "duplicate"],
      properties: {
        items: { type: "array", items: { $ref: "#/components/schemas/Thought" } },
        duplicate: { type: "boolean" },
        task: { type: ["object", "null"], additionalProperties: true }
      }
    }
  })
});

export const thoughtsOpenApiFragment = Object.freeze({
  paths: thoughtPaths,
  components: thoughtComponents
});
