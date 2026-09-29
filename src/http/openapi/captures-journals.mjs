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
const pagination = [
  { $ref: "#/components/parameters/Cursor" },
  { $ref: "#/components/parameters/Limit" }
];
const idempotency = { $ref: "#/components/parameters/IdempotencyKey" };
const ifMatch = { $ref: "#/components/parameters/IfMatch" };
const jsonBody = schema => ({
  required: true,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } }
});

const collection = ({ plural, schema, input }) => ({
  get: {
    operationId: `list${plural}`,
    parameters: pagination,
    responses: {
      "200": { description: `${plural}列表`, ...response({ type: "array", items: { $ref: `#/components/schemas/${schema}` } }) },
      ...errors
    }
  },
  post: {
    operationId: `create${schema}`,
    parameters: [idempotency],
    requestBody: jsonBody(input),
    responses: {
      "200": { description: "幂等请求复用既有资源", ...response({ $ref: `#/components/schemas/${schema}` }) },
      "201": { description: "已创建", ...response({ $ref: `#/components/schemas/${schema}` }) },
      ...errors
    }
  }
});

const resource = ({ schema, input, parameter }) => ({
  parameters: [{ $ref: `#/components/parameters/${parameter}` }],
  get: {
    operationId: `get${schema}`,
    responses: {
      "200": {
        description: "资源详情",
        headers: { ETag: { schema: { type: "string" } } },
        ...response({ $ref: `#/components/schemas/${schema}` })
      },
      ...errors
    }
  },
  patch: {
    operationId: `update${schema}`,
    parameters: [ifMatch],
    requestBody: jsonBody(input),
    responses: {
      "200": {
        description: "已更新",
        headers: { ETag: { schema: { type: "string" } } },
        ...response({ $ref: `#/components/schemas/${schema}` })
      },
      "412": { $ref: "#/components/responses/PreconditionFailed" },
      "428": { $ref: "#/components/responses/PreconditionRequired" },
      ...errors
    }
  },
  delete: {
    operationId: `delete${schema}`,
    parameters: [ifMatch],
    responses: {
      "200": { description: "已移入回收站", ...response({ $ref: "#/components/schemas/TrashReference" }) },
      "412": { $ref: "#/components/responses/PreconditionFailed" },
      "428": { $ref: "#/components/responses/PreconditionRequired" },
      ...errors
    }
  }
});

export const captureJournalPaths = Object.freeze({
  "/captures": collection({ plural: "Captures", schema: "Capture", input: "CaptureCreateInput" }),
  "/captures/{id}": resource({ schema: "Capture", input: "CaptureUpdateInput", parameter: "CaptureId" }),
  "/journal-draft": {
    get: {
      operationId: "getJournalDraft",
      responses: {
        "200": {
          description: "当前草稿；没有草稿时 data 为 null",
          headers: { ETag: { schema: { type: "string" } } },
          ...response({ anyOf: [{ $ref: "#/components/schemas/JournalDraft" }, { type: "null" }] })
        },
        ...errors
      }
    },
    put: {
      operationId: "saveJournalDraft",
      parameters: [idempotency],
      requestBody: jsonBody("JournalDraftInput"),
      responses: {
        "200": {
          description: "草稿已保存",
          headers: { ETag: { schema: { type: "string" } } },
          ...response({ $ref: "#/components/schemas/JournalDraft" })
        },
        ...errors
      }
    }
  },
  "/journals": collection({ plural: "Journals", schema: "Journal", input: "JournalCreateInput" }),
  "/journals/assist": {
    post: {
      operationId: "assistJournal",
      description: "Accept: text/event-stream 时返回阶段、增量及统一完成结果。",
      requestBody: jsonBody("JournalAssistInput"),
      responses: {
        "200": { description: "写作辅助内容", ...response({ $ref: "#/components/schemas/JournalAssistResult" }) },
        ...errors
      }
    }
  },
  "/journals/{id}": resource({ schema: "Journal", input: "JournalUpdateInput", parameter: "JournalId" }),
  "/journals/{id}/reflections": {
    parameters: [{ $ref: "#/components/parameters/JournalId" }],
    post: {
      operationId: "createJournalReflection",
      description: "生成并保存日记回望；Accept: text/event-stream 时返回阶段、增量及统一完成结果。",
      parameters: [idempotency],
      responses: {
        "201": { description: "回望已生成", ...response({ $ref: "#/components/schemas/JournalReflection" }) },
        ...errors
      }
    }
  },
  "/journals/{id}/reflections/{reflectionId}": {
    parameters: [
      { $ref: "#/components/parameters/JournalId" },
      { $ref: "#/components/parameters/JournalReflectionId" }
    ],
    delete: {
      operationId: "deleteJournalReflection",
      parameters: [ifMatch],
      responses: {
        "200": { description: "已移入回收站", ...response({ $ref: "#/components/schemas/TrashReference" }) },
        "412": { $ref: "#/components/responses/PreconditionFailed" },
        "428": { $ref: "#/components/responses/PreconditionRequired" },
        ...errors
      }
    }
  }
});

const eventTimeProperties = {
  occurredAt: { type: "string" },
  occurredOn: { type: "string", format: "date" },
  timeMode: { type: "string", enum: ["now", "manual"] }
};
const tags = { type: "array", maxItems: 8, items: { type: "string", maxLength: 30 } };
const recordFields = {
  id: { type: "string" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
  version: { type: "integer", minimum: 1 }
};

export const captureJournalComponents = Object.freeze({
  parameters: Object.freeze({
    CaptureId: { name: "id", in: "path", required: true, schema: { type: "string", maxLength: 100 } },
    JournalId: { name: "id", in: "path", required: true, schema: { type: "string", maxLength: 100 } },
    JournalReflectionId: { name: "reflectionId", in: "path", required: true, schema: { type: "string", maxLength: 100 } }
  }),
  schemas: Object.freeze({
    CaptureCreateInput: {
      type: "object",
      anyOf: [
        { required: ["content"], properties: { content: { type: "string", minLength: 1 } } },
        { required: ["attachmentPaths"], properties: { attachmentPaths: { type: "array", minItems: 1 } } }
      ],
      properties: {
        ...eventTimeProperties,
        content: { type: "string", maxLength: 12000 },
        attachmentPaths: { type: "array", maxItems: 2, uniqueItems: true, items: { $ref: "#/components/schemas/ContentAttachmentPath" } },
        tags
      },
      additionalProperties: false
    },
    CaptureUpdateInput: {
      type: "object",
      properties: {
        ...eventTimeProperties,
        content: { type: "string", maxLength: 12000 },
        attachmentPaths: { type: "array", maxItems: 2, uniqueItems: true, items: { $ref: "#/components/schemas/ContentAttachmentPath" } },
        tags
      },
      additionalProperties: false
    },
    Capture: {
      type: "object",
      required: ["id", "createdAt", "occurredAt", "occurredOn", "content", "tags", "version"],
      properties: {
        ...eventTimeProperties,
        content: { type: "string", maxLength: 12000 },
        attachmentPaths: { type: "array", maxItems: 2, uniqueItems: true, items: { $ref: "#/components/schemas/ContentAttachmentPath" } },
        tags,
        ...recordFields
      },
      additionalProperties: true
    },
    JournalCreateInput: {
      type: "object",
      required: ["content"],
      properties: {
        ...eventTimeProperties,
        title: { type: "string", maxLength: 120 },
        content: { type: "string", maxLength: 50000 },
        tags
      },
      additionalProperties: false
    },
    JournalUpdateInput: {
      type: "object",
      properties: {
        ...eventTimeProperties,
        title: { type: "string", maxLength: 120 },
        content: { type: "string", maxLength: 50000 },
        tags
      },
      additionalProperties: false
    },
    JournalReflection: {
      type: "object",
      required: ["id", "createdAt", "sourceUpdatedAt", "content", "version"],
      properties: {
        ...recordFields,
        sourceUpdatedAt: { type: "string", format: "date-time" },
        content: { type: "string" },
        reasoningContent: { type: "string" }
      },
      additionalProperties: true
    },
    Journal: {
      type: "object",
      required: ["id", "createdAt", "occurredAt", "occurredOn", "content", "tags", "version", "reflections"],
      properties: {
        ...eventTimeProperties,
        title: { type: "string", maxLength: 120 },
        content: { type: "string", maxLength: 50000 },
        tags,
        ...recordFields,
        reflections: { type: "array", items: { $ref: "#/components/schemas/JournalReflection" } }
      },
      additionalProperties: true
    },
    JournalDraftInput: {
      type: "object",
      properties: {
        journalId: { type: "string", maxLength: 100 },
        title: { type: "string", maxLength: 120 },
        content: { type: "string", maxLength: 50000 }
      },
      additionalProperties: false
    },
    JournalDraft: {
      type: "object",
      required: ["journalId", "title", "content", "updatedAt", "version"],
      properties: {
        journalId: { type: "string", maxLength: 100 },
        title: { type: "string", maxLength: 120 },
        content: { type: "string", maxLength: 50000 },
        updatedAt: { type: "string", format: "date-time" },
        version: { type: "integer", minimum: 1 }
      },
      additionalProperties: true
    },
    JournalAssistInput: {
      type: "object",
      required: ["mode"],
      properties: {
        mode: { type: "string", enum: ["lead", "structure", "topic"] },
        ...eventTimeProperties,
        title: { type: "string", maxLength: 120 },
        content: { type: "string", maxLength: 50000 },
        requestId: { type: "string", maxLength: 100 },
        targetId: { type: "string", maxLength: 100 },
        inputVersion: { type: "integer", minimum: 0 }
      },
      additionalProperties: false
    },
    JournalAssistResult: {
      type: "object",
      required: ["mode", "content"],
      properties: {
        mode: { type: "string", enum: ["lead", "structure", "topic"] },
        content: { type: "string" },
        requestId: { type: "string" },
        targetId: { type: "string" },
        inputVersion: { type: "integer", minimum: 0 }
      }
    }
  })
});

export const capturesJournalsOpenApiFragment = Object.freeze({
  paths: captureJournalPaths,
  components: captureJournalComponents
});
