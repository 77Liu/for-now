const success = (description, schema) => ({
  description,
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

const error = name => ({ $ref: `#/components/responses/${name}` });
const parameter = name => ({ $ref: `#/components/parameters/${name}` });
const inlineError = description => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ErrorEnvelope" }
    }
  }
});

const commonErrors = {
  "400": error("BadRequest"),
  "401": error("Unauthorized"),
  "403": inlineError("附件不属于当前账户"),
  "404": error("NotFound"),
  "409": error("Conflict")
};

export const contentAttachmentPaths = Object.freeze({
  "/content-attachments/{targetType}/{targetId}": {
    parameters: [
      parameter("ContentAttachmentTargetType"),
      parameter("ContentAttachmentTargetId"),
      parameter("ContentAttachmentOwnerCollection"),
      parameter("ContentAttachmentOwnerId")
    ],
    get: {
      operationId: "getContentAttachments",
      summary: "读取评论、捕念或思绪内容的原始图片与派生理解",
      responses: {
        "200": success("图片原文详情", { $ref: "#/components/schemas/ContentAttachments" }),
        ...commonErrors
      }
    },
    put: {
      operationId: "replaceContentAttachments",
      summary: "替换内容记录的原始图片引用",
      parameters: [parameter("IfMatch")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ContentAttachmentReplaceInput" }
          }
        }
      },
      responses: {
        "200": success("已更新图片原文", { $ref: "#/components/schemas/ContentAttachments" }),
        "412": error("PreconditionFailed"),
        "428": error("PreconditionRequired"),
        ...commonErrors
      }
    }
  },
  "/content-attachments/{targetType}/{targetId}/originals/{name}": {
    delete: {
      operationId: "deleteContentOriginalImage",
      summary: "将单张原始图片引用及其派生理解移入回收站",
      parameters: [
        parameter("ContentAttachmentTargetType"),
        parameter("ContentAttachmentTargetId"),
        parameter("ContentAttachmentName"),
        parameter("ContentAttachmentOwnerCollection"),
        parameter("ContentAttachmentOwnerId"),
        parameter("IfMatch")
      ],
      responses: {
        "200": success("图片引用已移入回收站", { $ref: "#/components/schemas/ContentAttachments" }),
        "412": error("PreconditionFailed"),
        "428": error("PreconditionRequired"),
        ...commonErrors
      }
    }
  },
  "/content-attachments/trash/{trashId}/restore": {
    post: {
      operationId: "restoreContentOriginalImage",
      summary: "恢复原始图片引用及其派生理解",
      parameters: [
        parameter("ContentAttachmentTrashId"),
        parameter("IfMatch")
      ],
      responses: {
        "200": success("图片引用已恢复", { $ref: "#/components/schemas/ContentAttachments" }),
        "412": error("PreconditionFailed"),
        "428": error("PreconditionRequired"),
        ...commonErrors
      }
    }
  },
  "/content-attachments/understandings": {
    post: {
      operationId: "requestContentImageUnderstanding",
      summary: "显式请求理解已保存的原始图片",
      parameters: [parameter("IdempotencyKey")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ContentImageUnderstandingRequest" }
          }
        }
      },
      responses: {
        "202": success("图片理解请求已接收", { type: "object", additionalProperties: true }),
        "501": inlineError("图片理解任务尚未接入"),
        ...commonErrors
      }
    }
  }
});

export const contentAttachmentComponents = Object.freeze({
  parameters: {
    ContentAttachmentOwnerCollection: {
      name: "ownerCollection", in: "query", required: false,
      description: "批注的所属集合；与 ownerId 一起提供。同名批注必须指定所属。",
      schema: { type: "string", enum: ["thoughts", "captures", "journals", "chats", "analyses", "books", "quotes"] }
    },
    ContentAttachmentOwnerId: {
      name: "ownerId", in: "query", required: false,
      schema: { type: "string", minLength: 1, maxLength: 100 }
    },
    ContentAttachmentTargetType: {
      name: "targetType",
      in: "path",
      required: true,
      schema: { $ref: "#/components/schemas/ContentAttachmentTargetType" }
    },
    ContentAttachmentTargetId: {
      name: "targetId",
      in: "path",
      required: true,
      schema: { type: "string", maxLength: 100 }
    },
    ContentAttachmentName: {
      name: "name",
      in: "path",
      required: true,
      schema: { type: "string", pattern: "^[A-Za-z0-9_.-]+$" }
    },
    ContentAttachmentTrashId: {
      name: "trashId",
      in: "path",
      required: true,
      schema: { type: "string", maxLength: 100 }
    }
  },
  schemas: {
    ContentAttachmentOwner: {
      type: "object", required: ["collection", "id"], additionalProperties: false,
      properties: {
        collection: { type: "string", enum: ["thoughts", "captures", "journals", "chats", "analyses", "books", "quotes"] },
        id: { type: "string", minLength: 1, maxLength: 100 }
      }
    },
    ContentAttachmentTargetType: {
      type: "string",
      enum: ["comment", "capture", "thoughtRoot", "thoughtBlock"]
    },
    ContentAttachmentPath: {
      type: "string",
      pattern: "^/attachments/[A-Za-z0-9_.-]+$"
    },
    ContentOriginalImage: {
      type: "object",
      required: ["path", "state"],
      properties: {
        path: { $ref: "#/components/schemas/ContentAttachmentPath" },
        state: { type: "string", enum: ["verified", "missing"] },
        bytes: { type: "integer", minimum: 0 },
        sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }
      },
      additionalProperties: false
    },
    ContentImageUnderstanding: {
      type: "object",
      required: [
        "id",
        "kind",
        "content",
        "sourceAttachmentPaths",
        "createdAt",
        "origin",
        "sourceVersion"
      ],
      properties: {
        id: { type: "string" },
        kind: { const: "imageUnderstanding" },
        content: { type: "string" },
        reasoningContent: { type: "string" },
        reasoningVisibility: { const: "user_viewable" },
        sourceAttachmentPaths: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: { $ref: "#/components/schemas/ContentAttachmentPath" }
        },
        createdAt: { type: "string", format: "date-time" },
        origin: { const: "ai-derived" },
        sourceVersion: { type: "integer", minimum: 1 },
        model: { type: "string" },
        sourceTaskId: { type: "string" },
        clientRequestId: { type: "string" }
      },
      additionalProperties: false
    },
    ContentAttachments: {
      type: "object",
      required: ["targetType", "targetId", "version", "originalImages", "imageUnderstandings"],
      properties: {
        targetType: { $ref: "#/components/schemas/ContentAttachmentTargetType" },
        targetId: { type: "string" },
        version: { type: "integer", minimum: 1 },
        originalImages: {
          type: "array",
          maxItems: 2,
          items: { $ref: "#/components/schemas/ContentOriginalImage" }
        },
        imageUnderstandings: {
          type: "array",
          items: { $ref: "#/components/schemas/ContentImageUnderstanding" }
        }
      },
      additionalProperties: false
    },
    ContentAttachmentReplaceInput: {
      type: "object",
      required: ["attachmentPaths"],
      properties: {
        owner: { $ref: "#/components/schemas/ContentAttachmentOwner" },
        attachmentPaths: {
          type: "array",
          maxItems: 2,
          uniqueItems: true,
          items: { $ref: "#/components/schemas/ContentAttachmentPath" }
        }
      },
      additionalProperties: false
    },
    ContentImageUnderstandingRequest: {
      type: "object",
      required: ["targetType", "targetId", "inputVersion", "attachmentPaths"],
      properties: {
        owner: { $ref: "#/components/schemas/ContentAttachmentOwner" },
        targetType: { $ref: "#/components/schemas/ContentAttachmentTargetType" },
        targetId: { type: "string", maxLength: 100 },
        inputVersion: { type: "integer", minimum: 1 },
        attachmentPaths: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
          items: { $ref: "#/components/schemas/ContentAttachmentPath" }
        }
      },
      additionalProperties: false
    }
  }
});

export const contentAttachmentsOpenApiFragment = Object.freeze({
  paths: contentAttachmentPaths,
  components: contentAttachmentComponents
});
