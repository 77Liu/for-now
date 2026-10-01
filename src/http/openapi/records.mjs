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

const collection = ({ operation, schema, input }) => ({
  get: {
    operationId: `list${operation}`,
    parameters: [
      { $ref: "#/components/parameters/Cursor" },
      { $ref: "#/components/parameters/Limit" }
    ],
    responses: {
      "200": { description: `${operation}列表`, ...response({ type: "array", items: { $ref: `#/components/schemas/${schema}` } }) },
      ...errors
    }
  },
  post: {
    operationId: `create${operation.slice(0, -1)}`,
    parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
    requestBody: {
      required: true,
      content: { "application/json": { schema: { $ref: `#/components/schemas/${input}` } } }
    },
    responses: {
      "200": { description: "幂等请求复用既有记录", ...response({ $ref: `#/components/schemas/${schema}` }) },
      "201": { description: "已创建", ...response({ $ref: `#/components/schemas/${schema}` }) },
      ...errors
    }
  }
});

const resource = ({ operation, schema, input, idParameter }) => ({
  parameters: [{ $ref: `#/components/parameters/${idParameter}` }],
  get: {
    operationId: `get${operation}`,
    responses: {
      "200": {
        description: "记录详情",
        headers: { ETag: { schema: { type: "string" } } },
        ...response({ $ref: `#/components/schemas/${schema}` })
      },
      ...errors
    }
  },
  patch: {
    operationId: `update${operation}`,
    parameters: [{ $ref: "#/components/parameters/IfMatch" }],
    requestBody: {
      required: true,
      content: { "application/json": { schema: { $ref: `#/components/schemas/${input}` } } }
    },
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
    operationId: `delete${operation}`,
    parameters: [{ $ref: "#/components/parameters/IfMatch" }],
    responses: {
      "200": { description: "已移入回收站", ...response({ $ref: "#/components/schemas/TrashReference" }) },
      "412": { $ref: "#/components/responses/PreconditionFailed" },
      "428": { $ref: "#/components/responses/PreconditionRequired" },
      ...errors
    }
  }
});

export const recordPaths = Object.freeze({
  "/checkins": collection({ operation: "Checkins", schema: "Checkin", input: "CheckinInput" }),
  "/checkins/{id}": resource({ operation: "Checkin", schema: "Checkin", input: "CheckinInput", idParameter: "CheckinId" }),
  "/daily-records": collection({ operation: "DailyRecords", schema: "DailyRecord", input: "DailyRecordInput" }),
  "/daily-records/{id}": resource({ operation: "DailyRecord", schema: "DailyRecord", input: "DailyRecordInput", idParameter: "DailyRecordId" })
});

export const recordComponents = Object.freeze({
  parameters: Object.freeze({
    CheckinId: { name: "id", in: "path", required: true, schema: { type: "string", maxLength: 100 } },
    DailyRecordId: { name: "id", in: "path", required: true, schema: { type: "string", maxLength: 100 } }
  }),
  schemas: Object.freeze({
    EventTimeInput: {
      type: "object",
      properties: {
        occurredAt: { type: "string" },
        occurredOn: { type: "string", format: "date" }
      }
    },
    CheckinInput: {
      allOf: [
        { $ref: "#/components/schemas/EventTimeInput" },
        {
          type: "object",
          properties: {
            mood: { type: "number", minimum: 1, maximum: 5 },
            energy: { type: "number", minimum: 1, maximum: 5 },
            stress: { type: "number", minimum: 1, maximum: 5 },
            sleep: { type: "number", minimum: 1, maximum: 5 },
            factors: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
            custom: { type: "object", additionalProperties: { type: "number", minimum: 1, maximum: 5 } },
            notes: { type: "object", additionalProperties: { type: "string", maxLength: 800 } }
          }
        }
      ]
    },
    Checkin: {
      allOf: [
        { $ref: "#/components/schemas/CheckinInput" },
        {
          type: "object",
          required: ["id", "createdAt", "occurredAt", "occurredOn", "version"],
          properties: {
            id: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            version: { type: "integer", minimum: 1 }
          },
          additionalProperties: true
        }
      ]
    },
    DailyRecordInput: {
      allOf: [
        { $ref: "#/components/schemas/EventTimeInput" },
        {
          type: "object",
          required: ["type"],
          properties: {
            type: { enum: ["sleep", "heartRate", "weight", "exercise"] },
            source: { enum: ["manual", "screenshot"] },
            attachmentPaths: { type: "array", items: { type: "string" } },
            description: {
              type: "string",
              maxLength: 5000,
              description: "用户填写的感受；历史客户端也可能将未区分来源的描述保存在此字段"
            },
            recognitionDescription: {
              type: "string",
              maxLength: 5000,
              description: "截图识别生成的可编辑解析描述，不代表用户感受"
            }
          },
          additionalProperties: true
        }
      ]
    },
    DailyRecord: {
      allOf: [
        { $ref: "#/components/schemas/DailyRecordInput" },
        {
          type: "object",
          required: ["id", "createdAt", "occurredAt", "occurredOn", "version"],
          properties: {
            id: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            version: { type: "integer", minimum: 1 }
          },
          additionalProperties: true
        }
      ]
    }
  })
});

export const recordsOpenApiFragment = Object.freeze({
  paths: recordPaths,
  components: recordComponents
});
