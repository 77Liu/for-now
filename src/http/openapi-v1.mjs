import { thoughtsOpenApiFragment } from "./openapi/thoughts.mjs";
import { recordsOpenApiFragment } from "./openapi/records.mjs";
import { g2OpenApiFragment } from "./openapi/g2.mjs";
import { capturesJournalsOpenApiFragment } from "./openapi/captures-journals.mjs";
import { libraryOpenApiFragment } from "./openapi/library.mjs";
import { reviewsChatOpenApiFragment } from "./openapi/reviews-chat.mjs";
import { contentAttachmentsOpenApiFragment } from "./openapi/content-attachments.mjs";

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
    ...thoughtsOpenApiFragment.paths,
    ...recordsOpenApiFragment.paths,
    ...g2OpenApiFragment.paths,
    ...capturesJournalsOpenApiFragment.paths,
    ...libraryOpenApiFragment.paths,
    ...reviewsChatOpenApiFragment.paths,
    ...contentAttachmentsOpenApiFragment.paths
  },
  components: {
    securitySchemes: {
      cookieAuth: { type: "apiKey", in: "cookie", name: "for_now_session" }
    },
    parameters: {
      IdempotencyKey: { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", maxLength: 100 } },
      IfMatch: { name: "If-Match", in: "header", required: true, schema: { type: "string", example: "\"3\"" } },
      Cursor: { name: "cursor", in: "query", required: false, schema: { type: "string" } },
      Limit: { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      ...thoughtsOpenApiFragment.components.parameters,
      ...recordsOpenApiFragment.components.parameters,
      ...g2OpenApiFragment.components.parameters,
      ...capturesJournalsOpenApiFragment.components.parameters,
      ...libraryOpenApiFragment.components.parameters,
      ...reviewsChatOpenApiFragment.components.parameters,
      ...contentAttachmentsOpenApiFragment.components.parameters
    },
    schemas: {
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
      ...thoughtsOpenApiFragment.components.schemas,
      ...recordsOpenApiFragment.components.schemas,
      ...g2OpenApiFragment.components.schemas,
      ...capturesJournalsOpenApiFragment.components.schemas,
      ...libraryOpenApiFragment.components.schemas,
      ...reviewsChatOpenApiFragment.components.schemas,
      ...contentAttachmentsOpenApiFragment.components.schemas
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
