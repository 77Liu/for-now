const error = name => ({ $ref: `#/components/responses/${name}` });
const errorResponse = description => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ErrorEnvelope" }
    }
  }
});
const statusResponse = description => ({
  description,
  headers: {
    ETag: {
      description: "Owner 控制版本；PATCH 时原样传入 If-Match",
      schema: { type: "string", example: "\"1\"" }
    },
    "Cache-Control": {
      description: "预算状态不得缓存",
      schema: { type: "string", const: "no-store" }
    }
  },
  content: {
    "application/json": {
      schema: {
        allOf: [
          { $ref: "#/components/schemas/SuccessEnvelope" },
          {
            type: "object",
            properties: {
              data: { $ref: "#/components/schemas/AiBudgetStatus" }
            }
          }
        ]
      }
    }
  }
});

export const aiBudgetPaths = Object.freeze({
  "/owner/ai-budget": {
    get: {
      operationId: "getOwnerAiBudget",
      summary: "读取全站 AI 预算安全聚合状态",
      responses: {
        "200": statusResponse("当前预算状态"),
        "401": error("Unauthorized"),
        "403": errorResponse("当前账户没有 Owner 权限")
      }
    },
    patch: {
      operationId: "patchOwnerAiBudget",
      summary: "追加临时预算或解除当前周期的预算阻断",
      parameters: [{ $ref: "#/components/parameters/IfMatch" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              oneOf: [
                { $ref: "#/components/schemas/AiBudgetAddTemporaryBudgetCommand" },
                { $ref: "#/components/schemas/AiBudgetRecoverCommand" }
              ],
              discriminator: { propertyName: "command" }
            }
          }
        }
      },
      responses: {
        "200": statusResponse("命令提交后的预算状态"),
        "400": error("BadRequest"),
        "401": error("Unauthorized"),
        "403": errorResponse("当前账户没有 Owner 权限"),
        "412": error("PreconditionFailed"),
        "428": error("PreconditionRequired")
      }
    }
  }
});

export const aiBudgetComponents = Object.freeze({
  parameters: {},
  schemas: {
    AiBudgetPolicy: {
      type: "object",
      additionalProperties: false,
      required: [
        "userDailyKnownCostCny",
        "userDailyCalls",
        "siteDailyKnownCostCny",
        "siteMonthlyKnownCostCny",
        "siteDailyUnknownCalls",
        "dailyAdditionMaxCny",
        "monthlyAdditionMaxCny",
        "alertThresholds"
      ],
      properties: {
        userDailyKnownCostCny: { type: "number", exclusiveMinimum: 0 },
        userDailyCalls: { type: "integer", minimum: 1 },
        siteDailyKnownCostCny: { type: "number", exclusiveMinimum: 0 },
        siteMonthlyKnownCostCny: { type: "number", exclusiveMinimum: 0 },
        siteDailyUnknownCalls: { type: "integer", minimum: 1 },
        dailyAdditionMaxCny: { type: "number", exclusiveMinimum: 0 },
        monthlyAdditionMaxCny: { type: "number", exclusiveMinimum: 0 },
        alertThresholds: {
          type: "array",
          items: { type: "integer", minimum: 1, maximum: 100 }
        }
      }
    },
    AiBudgetBlockedStatus: {
      type: "object",
      additionalProperties: false,
      properties: {
        knownCost: { type: "boolean" },
        unknownCost: { type: "boolean" }
      }
    },
    AiBudgetDayStatus: {
      type: "object",
      additionalProperties: false,
      required: [
        "key",
        "committedKnownCostCny",
        "reservedKnownCostCny",
        "effectiveKnownCostLimitCny",
        "committedUnknownCalls",
        "reservedUnknownCalls",
        "unknownCallLimit",
        "blocked"
      ],
      properties: {
        key: { type: "string", format: "date" },
        committedKnownCostCny: { type: "number", minimum: 0 },
        reservedKnownCostCny: { type: "number", minimum: 0 },
        effectiveKnownCostLimitCny: { type: "number", minimum: 0 },
        committedUnknownCalls: { type: "integer", minimum: 0 },
        reservedUnknownCalls: { type: "integer", minimum: 0 },
        unknownCallLimit: { type: "integer", minimum: 1 },
        blocked: { $ref: "#/components/schemas/AiBudgetBlockedStatus" }
      }
    },
    AiBudgetMonthStatus: {
      type: "object",
      additionalProperties: false,
      required: [
        "key",
        "committedKnownCostCny",
        "reservedKnownCostCny",
        "effectiveKnownCostLimitCny",
        "blocked"
      ],
      properties: {
        key: { type: "string", pattern: "^\\d{4}-\\d{2}$" },
        committedKnownCostCny: { type: "number", minimum: 0 },
        reservedKnownCostCny: { type: "number", minimum: 0 },
        effectiveKnownCostLimitCny: { type: "number", minimum: 0 },
        blocked: { $ref: "#/components/schemas/AiBudgetBlockedStatus" }
      }
    },
    AiBudgetStatus: {
      type: "object",
      additionalProperties: false,
      required: [
        "controlVersion",
        "policy",
        "day",
        "month",
        "activeReservations",
        "eventCount"
      ],
      properties: {
        controlVersion: { type: "integer", minimum: 1 },
        policy: { $ref: "#/components/schemas/AiBudgetPolicy" },
        day: { $ref: "#/components/schemas/AiBudgetDayStatus" },
        month: { $ref: "#/components/schemas/AiBudgetMonthStatus" },
        activeReservations: { type: "integer", minimum: 0 },
        eventCount: { type: "integer", minimum: 0 }
      }
    },
    AiBudgetAddTemporaryBudgetCommand: {
      type: "object",
      additionalProperties: false,
      required: ["command", "scope", "amountCny", "reason"],
      properties: {
        command: { const: "addTemporaryBudget" },
        scope: { type: "string", enum: ["daily", "monthly"] },
        amountCny: { type: "number", exclusiveMinimum: 0 },
        reason: { type: "string", minLength: 1, maxLength: 500 }
      }
    },
    AiBudgetRecoverCommand: {
      type: "object",
      additionalProperties: false,
      required: ["command", "scope", "reason"],
      properties: {
        command: { const: "recover" },
        scope: {
          type: "string",
          enum: ["dailyKnownCost", "monthlyKnownCost", "dailyUnknownCost"]
        },
        reason: { type: "string", minLength: 1, maxLength: 500 }
      }
    }
  }
});

export const aiBudgetOpenApiFragment = Object.freeze({
  paths: aiBudgetPaths,
  components: aiBudgetComponents
});
