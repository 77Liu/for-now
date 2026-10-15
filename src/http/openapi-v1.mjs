import { thoughtsOpenApiFragment } from "./openapi/thoughts.mjs";
import { recordsOpenApiFragment } from "./openapi/records.mjs";
import { g2OpenApiFragment } from "./openapi/g2.mjs";
import { capturesJournalsOpenApiFragment } from "./openapi/captures-journals.mjs";
import { libraryOpenApiFragment } from "./openapi/library.mjs";
import { reviewsChatOpenApiFragment } from "./openapi/reviews-chat.mjs";
import { contentAttachmentsOpenApiFragment } from "./openapi/content-attachments.mjs";
import { syncOpenApiFragment } from "./openapi/sync.mjs";
import { personalContextOpenApiFragment } from "./openapi/personal-context.mjs";
import { onboardingV2OpenApiFragment } from "./openapi/onboarding-v2.mjs";
import { userModelOpenApiFragment } from "./openapi/user-model.mjs";
import { aiBudgetOpenApiFragment } from "./openapi/ai-budget.mjs";
import { speechOpenApiFragment } from "./openapi/speech.mjs";
import { startupOpenApiFragment } from "./openapi/startup.mjs";
import { isBusinessCreationPath } from "../../.build/typescript/backend/shared/business-identifiers/index.mjs";

export const openApiV1 = Object.freeze({
  openapi: "3.1.0",
  info: {
    title: "个人成长追踪 API",
    version: "1.0.0",
    description: "v1 公共契约。业务响应使用 data/error/meta，写入使用 ETag、If-Match 与 Idempotency-Key。"
  },
  servers: [{ url: "." }],
  paths: {
    "/openapi.json": {
      get: { operationId: "getOpenApiV1", responses: { "200": { description: "OpenAPI 文档" } } }
    },
    ...startupOpenApiFragment.paths,
    ...thoughtsOpenApiFragment.paths,
    ...recordsOpenApiFragment.paths,
    ...g2OpenApiFragment.paths,
    ...capturesJournalsOpenApiFragment.paths,
    ...libraryOpenApiFragment.paths,
    ...reviewsChatOpenApiFragment.paths,
    ...contentAttachmentsOpenApiFragment.paths,
    ...syncOpenApiFragment.paths,
    ...personalContextOpenApiFragment.paths,
    ...onboardingV2OpenApiFragment.paths,
    ...userModelOpenApiFragment.paths,
    ...aiBudgetOpenApiFragment.paths,
    ...speechOpenApiFragment.paths
  },
  components: {
    securitySchemes: {
      cookieAuth: { type: "apiKey", in: "cookie", name: "for_now_session" }
    },
    parameters: {
      IdempotencyKey: { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", maxLength: 100 } },
      ClientProvisionalId: { name: "X-Client-Provisional-Id", in: "header", required: false,
        description: "创建操作临时业务身份；需同时提供不可变客户端操作 ID 和请求指纹。提交与恢复回执返回正式映射。",
        schema: { type: "string", pattern: "^[A-Za-z0-9_-]{16}$" } },
      IfMatch: { name: "If-Match", in: "header", required: true, schema: { type: "string", example: "\"3\"" } },
      Cursor: { name: "cursor", in: "query", required: false, schema: { type: "string" } },
      Limit: { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      ...thoughtsOpenApiFragment.components.parameters,
      ...recordsOpenApiFragment.components.parameters,
      ...g2OpenApiFragment.components.parameters,
      ...capturesJournalsOpenApiFragment.components.parameters,
      ...libraryOpenApiFragment.components.parameters,
      ...reviewsChatOpenApiFragment.components.parameters,
      ...contentAttachmentsOpenApiFragment.components.parameters,
      ...syncOpenApiFragment.components.parameters,
      ...personalContextOpenApiFragment.components.parameters,
      ...onboardingV2OpenApiFragment.components.parameters,
      ...userModelOpenApiFragment.components.parameters,
      ...aiBudgetOpenApiFragment.components.parameters,
      ...(speechOpenApiFragment.components.parameters || {})
    },
    schemas: {
      OccurrenceTimestamp: {
        description: "可靠发生时刻；仅日期时为空字符串，并由 occurredOn 与 eventTimePrecision=date 表达，不以创建/更新时间补造。",
        anyOf: [{ type: "string", format: "date-time" }, { type: "string", const: "" }]
      },
      EventTimePrecision: { type: "string", enum: ["instant", "date", "unknown"] },
      OccurrenceDate: { description: "发生日期；历史精度未知时为空，不以登记日期伪回填。",
        anyOf: [{ type: "string", format: "date" }, { type: "string", const: "" }] },
      Meta: {
        type: "object",
        required: ["traceId"],
        properties: {
          traceId: { type: "string" },
          nextCursor: { type: ["string", "null"] }
        },
        additionalProperties: true
      },
      ApiError: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          details: { type: "object", additionalProperties: true }
        }
      },
      SuccessEnvelope: {
        type: "object",
        required: ["data", "error", "meta"],
        properties: {
          data: {},
          error: { type: "null" },
          meta: { $ref: "#/components/schemas/Meta" }
        }
      },
      ErrorEnvelope: {
        type: "object",
        required: ["data", "error", "meta"],
        properties: {
          data: { type: "null" },
          error: { $ref: "#/components/schemas/ApiError" },
          meta: { $ref: "#/components/schemas/Meta" }
        }
      },
      TrashReference: {
        type: "object",
        required: ["trashId"],
        properties: { trashId: { type: "string" } }
      },
      PersonalizedAiTask: {
        type: "object",
        required: [
          "id", "kind", "resourceType", "targetId", "subtargetId", "inputVersion",
          "subtargetVersion", "status", "createdAt", "startedAt", "completedAt",
          "resultId", "error", "retryOf"
        ],
        properties: {
          id: { type: "string" },
          kind: { enum: ["thoughtDraft", "thoughtPrompt", "journalAssist", "journalReflection", "chat", "analysis"] },
          resourceType: { enum: ["thought", "journal", "chat", "analysis"] },
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
      ...thoughtsOpenApiFragment.components.schemas,
      ...recordsOpenApiFragment.components.schemas,
      ...g2OpenApiFragment.components.schemas,
      ...capturesJournalsOpenApiFragment.components.schemas,
      ...libraryOpenApiFragment.components.schemas,
      ...reviewsChatOpenApiFragment.components.schemas,
      ...contentAttachmentsOpenApiFragment.components.schemas,
      ...syncOpenApiFragment.components.schemas,
      ...personalContextOpenApiFragment.components.schemas,
      ...onboardingV2OpenApiFragment.components.schemas,
      ...userModelOpenApiFragment.components.schemas,
      ...aiBudgetOpenApiFragment.components.schemas,
      ...speechOpenApiFragment.components.schemas
    },
    responses: {
      BadRequest: { description: "请求无效", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
      Unauthorized: { description: "未登录", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
      NotFound: { description: "资源不存在", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
      Conflict: { description: "幂等键或业务状态冲突", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
      PreconditionFailed: { description: "ETag 已过期", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
      PreconditionRequired: { description: "缺少 If-Match", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } }
    }
  },
  security: [{ cookieAuth: [] }]
});

// 创建路径和浏览器/服务端校验共用同一策略，避免逐领域维护头部清单。
for (const [pathname, pathItem] of Object.entries(openApiV1.paths)) {
  if (pathItem.post && isBusinessCreationPath("POST", `/api/v1${pathname}`)) {
    pathItem.post.parameters = [...(pathItem.post.parameters || []), { $ref: "#/components/parameters/ClientProvisionalId" }];
  }
}
for (const schema of Object.values(openApiV1.components.schemas)) {
  if (schema.properties?.occurredAt && schema.properties?.occurredOn) {
    schema.properties.eventTimePrecision = { $ref: "#/components/schemas/EventTimePrecision" };
    const nullable = Array.isArray(schema.properties.occurredOn.type) && schema.properties.occurredOn.type.includes("null");
    schema.properties.occurredOn = nullable ? { anyOf: [{ $ref: "#/components/schemas/OccurrenceDate" }, { type: "null" }] }
      : { $ref: "#/components/schemas/OccurrenceDate" };
  }
}
