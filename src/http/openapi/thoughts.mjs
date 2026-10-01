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
        { $ref: "#/components/parameters/Limit" }
      ],
      responses: {
        "200": {
          description: "思绪链列表",
          ...response({ type: "array", items: { $ref: "#/components/schemas/ThoughtChain" } })
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
        "201": {
          description: "生成并保存回答；Accept: text/event-stream 时以 SSE 返回阶段、增量及统一完成结果",
          ...response({ $ref: "#/components/schemas/Thought" })
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
        occurredAt: { type: "string", format: "date-time" },
        occurredOn: { type: "string", format: "date" },
        tags: { type: "array", items: { type: "string" } },
        attachmentPaths: { type: "array", maxItems: 2, uniqueItems: true, items: { $ref: "#/components/schemas/ContentAttachmentPath" } },
        relatedTo: { type: ["string", "null"] },
        sourceRef: { $ref: "#/components/schemas/ThoughtSourceRef" }
      },
      additionalProperties: true
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
