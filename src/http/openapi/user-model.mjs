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
        "candidateCount",
        "staleCandidateCount"
      ],
      properties: {
        readiness: { enum: ["empty", "partial", "usable"] },
        claims: { type: "array", items: { $ref: "#/components/schemas/UserClaim" } },
        unknowns: { type: "array", items: { $ref: "#/components/schemas/ModelUnknown" } },
        activeClaimCount: { type: "integer", minimum: 0 },
        candidateCount: { type: "integer", minimum: 0 },
        staleCandidateCount: { type: "integer", minimum: 0 }
      }
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
