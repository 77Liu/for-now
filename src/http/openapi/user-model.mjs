const claimResponse = {
  allOf: [
    { $ref: "#/components/schemas/SuccessEnvelope" },
    {
      type: "object",
      properties: {
        data: {
          type: "object",
          required: ["claim"],
          properties: {
            claim: { $ref: "#/components/schemas/UserClaim" },
            previous: { $ref: "#/components/schemas/UserClaim" }
          }
        }
      }
    }
  ]
};

export const userModelPaths = {
  "/user-model": {
    get: {
      operationId: "getUserModel",
      summary: "读取当前账户的 claim、候选与待了解项",
      responses: {
        "200": {
          description: "当前用户模型",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/SuccessEnvelope" },
                  {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/UserModel" } }
                  }
                ]
              }
            }
          }
        },
        "401": { $ref: "#/components/responses/Unauthorized" }
      }
    }
  },
  "/user-model/evidence-permissions": {
    get: {
      operationId: "listEvidencePermissions",
      summary: "分页读取原始来源的回答与学习许可",
      parameters: [
        { $ref: "#/components/parameters/Cursor" },
        { $ref: "#/components/parameters/Limit" }
      ],
      responses: {
        "200": {
          description: "来源许可列表",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/SuccessEnvelope" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: { $ref: "#/components/schemas/EvidencePermissionView" }
                      }
                    }
                  }
                ]
              }
            }
          }
        },
        "400": { $ref: "#/components/responses/BadRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" }
      }
    },
    patch: {
      operationId: "updateEvidencePermission",
      summary: "更新原始来源的回答与学习许可",
      parameters: [{ $ref: "#/components/parameters/IfMatch" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/EvidencePermissionPatch" }
          }
        }
      },
      responses: {
        "200": {
          description: "更新后的来源许可",
          headers: { ETag: { schema: { type: "string" } } },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EvidencePermissionUpdateResponse" }
            }
          }
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "409": { $ref: "#/components/responses/Conflict" },
        "412": { $ref: "#/components/responses/PreconditionFailed" },
        "422": { description: "来源许可输入无效" },
        "428": { $ref: "#/components/responses/PreconditionRequired" },
        "503": { description: "来源许可服务暂不可用" }
      }
    }
  },
  "/user-model/claims/{id}": {
    patch: {
      operationId: "patchUserClaim",
      summary: "确认、修正、拒绝或撤回一条 claim",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { $ref: "#/components/parameters/IfMatch" }
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/UserClaimPatch" } }
        }
      },
      responses: {
        "200": {
          description: "更新后的 claim",
          headers: { ETag: { schema: { type: "string" } } },
          content: { "application/json": { schema: claimResponse } }
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { $ref: "#/components/responses/Conflict" },
        "412": { $ref: "#/components/responses/PreconditionFailed" },
        "428": { $ref: "#/components/responses/PreconditionRequired" }
      }
    }
  }
};

export const userModelComponents = {
  schemas: {
    UserClaimEvidence: {
      type: "object",
      additionalProperties: false,
      required: ["sourceType", "sourceId", "sourceVersion", "contentSha256", "span"],
      properties: {
        sourceType: { const: "onboardingV2Answer" },
        sourceId: { type: "string" },
        sourceVersion: { type: "integer", minimum: 1 },
        contentSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        span: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "integer", minimum: 0 }
        }
      }
    },
    UserClaim: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "domain",
        "statement",
        "scope",
        "epistemic",
        "lifecycle",
        "confidence",
        "evidenceStrength",
        "evidence",
        "validFrom",
        "validTo",
        "confirmedAt",
        "lastReviewedAt",
        "supersedes",
        "contextAllowed",
        "createdAt",
        "updatedAt",
        "version",
        "sourceTaskId",
        "disposition"
      ],
      properties: {
        id: { type: "string" },
        domain: { enum: ["context", "goals", "state", "behavior", "mind", "values", "relationships", "collaboration"] },
        domainLabel: { type: "string" },
        statement: { type: "string", maxLength: 1000 },
        scope: { type: "string", maxLength: 500 },
        epistemic: { enum: ["known", "hypothesis"] },
        lifecycle: { enum: ["candidate", "active", "disputed", "superseded", "retracted", "stale"] },
        confidence: { type: "null" },
        evidenceStrength: { enum: ["self_report", "single_observation", "multiple_observations", "insufficient"] },
        evidence: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { $ref: "#/components/schemas/UserClaimEvidence" }
        },
        validFrom: { type: "string" },
        validTo: { type: "string" },
        confirmedAt: { type: "string" },
        lastReviewedAt: { type: "string" },
        supersedes: { type: "string" },
        contextAllowed: { type: "boolean" },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
        version: { type: "integer", minimum: 1 },
        sourceTaskId: { type: "string" },
        disposition: { type: "string" }
      }
    },
    ModelUnknown: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "question",
        "domain",
        "reason",
        "relatedEvidence",
        "impactOnNextAnswer",
        "askedAt",
        "snoozedUntil",
        "resolvedBy",
        "createdAt",
        "updatedAt",
        "version",
        "sourceTaskId"
      ],
      properties: {
        id: { type: "string" },
        question: { type: "string" },
        domain: { enum: ["context", "goals", "state", "behavior", "mind", "values", "relationships", "collaboration"] },
        reason: { type: "string" },
        relatedEvidence: { type: "array", items: { type: "string" } },
        impactOnNextAnswer: { type: "string" },
        askedAt: { type: "string" },
        snoozedUntil: { type: "string" },
        resolvedBy: { type: "string" },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
        version: { type: "integer", minimum: 1 },
        sourceTaskId: { type: "string" }
      }
    },
    UserModel: {
      type: "object",
      additionalProperties: false,
      required: [
        "readiness",
        "claims",
        "unknowns",
        "activeClaimCount",
        "disputedClaimCount",
        "candidateCount",
        "staleCandidateCount"
      ],
      properties: {
        readiness: { enum: ["empty", "partial", "usable"] },
        claims: { type: "array", items: { $ref: "#/components/schemas/UserClaim" } },
        unknowns: { type: "array", items: { $ref: "#/components/schemas/ModelUnknown" } },
        activeClaimCount: { type: "integer", minimum: 0 },
        disputedClaimCount: { type: "integer", minimum: 0 },
        candidateCount: { type: "integer", minimum: 0 },
        staleCandidateCount: { type: "integer", minimum: 0 }
      }
    },
    EvidenceSourceRef: {
      type: "object",
      additionalProperties: false,
      required: ["resourceType", "resourceId", "rootId", "targetKey", "version"],
      properties: {
        resourceType: { type: "string", maxLength: 40 },
        resourceId: { type: "string", maxLength: 100 },
        rootId: { type: "string", maxLength: 100 },
        targetKey: { type: "string", maxLength: 120 },
        version: { type: "integer", minimum: 1 }
      }
    },
    EvidencePermissionPatch: {
      type: "object",
      additionalProperties: false,
      required: ["sourceRef", "contextAllowed", "learningAllowed"],
      properties: {
        sourceRef: { $ref: "#/components/schemas/EvidenceSourceRef" },
        contextAllowed: { type: "boolean" },
        learningAllowed: { type: "boolean" }
      }
    },
    EvidencePermissionView: {
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
    EvidencePermissionUpdateResponse: {
      allOf: [
        { $ref: "#/components/schemas/SuccessEnvelope" },
        {
          type: "object",
          properties: {
            data: {
              type: "object",
              required: ["permission", "unchanged", "learningRefreshQueued"],
              properties: {
                permission: { type: "object", additionalProperties: true },
                unchanged: { type: "boolean" },
                learningRefreshQueued: { type: "boolean" }
              }
            }
          }
        }
      ]
    },
    UserClaimPatch: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { enum: ["confirm", "revise", "reject", "retract"] },
        statement: { type: "string", maxLength: 1000 },
        scope: { type: "string", maxLength: 500 },
        epistemic: { enum: ["known", "hypothesis"] },
        contextAllowed: { type: "boolean" },
        reason: { type: "string", maxLength: 80 }
      }
    }
  }
};

export const userModelOpenApiFragment = {
  paths: userModelPaths,
  components: { parameters: {}, schemas: userModelComponents.schemas }
};
