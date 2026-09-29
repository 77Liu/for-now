const jsonBody = schema => ({
  required: true,
  content: { "application/json": { schema } }
});
const response = description => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessEnvelope" } } }
});
const error = name => ({ $ref: `#/components/responses/${name}` });
const id = name => ({ $ref: `#/components/parameters/${name}` });
const query = (name, schema = { type: "string" }) => ({ name, in: "query", required: false, schema });

const listOperation = (operationId, summary, extraParameters = []) => ({
  operationId,
  summary,
  parameters: [id("Cursor"), id("Limit"), ...extraParameters],
  responses: { "200": response("列表"), "400": error("BadRequest") }
});
const createOperation = (operationId, summary, schema) => ({
  operationId,
  summary,
  parameters: [id("IdempotencyKey")],
  requestBody: jsonBody(schema),
  responses: { "200": response("幂等重放"), "201": response("已创建"), "400": error("BadRequest"), "409": error("Conflict") }
});
const getOperation = (operationId, summary, parameter) => ({
  operationId,
  summary,
  parameters: [id(parameter)],
  responses: { "200": response("详情"), "404": error("NotFound") }
});
const versionedOperation = (operationId, summary, parameter, method = "update", hasBody = method !== "delete") => ({
  operationId,
  summary,
  parameters: [id(parameter), id("IfMatch")],
  ...(hasBody ? { requestBody: jsonBody({ type: "object", additionalProperties: true }) } : {}),
  responses: {
    "200": response(method === "delete" ? "已移入回收站" : "已更新"),
    "400": error("BadRequest"),
    "404": error("NotFound"),
    "409": error("Conflict"),
    "412": error("PreconditionFailed"),
    "428": error("PreconditionRequired")
  }
});

export const g2Paths = Object.freeze({
  "/discovery": {
    get: {
      operationId: "searchThoughtDiscovery",
      summary: "跨体裁检索记录",
      parameters: [
        id("Cursor"),
        id("Limit"),
        query("q"),
        query("genre", { type: "array", items: { $ref: "#/components/schemas/DiscoveryGenre" } }),
        query("type", { type: "array", items: { $ref: "#/components/schemas/ThoughtDiscoveryType" } }),
        query("fresh", { type: "string", enum: ["0", "1", "fresh"] })
      ],
      responses: { "200": response("检索结果"), "400": error("BadRequest") }
    }
  },
  "/discovery/random": {
    get: {
      operationId: "openThoughtDiscoveryRandomDoor",
      summary: "随机打开一条思绪链",
      parameters: [
        query("q"),
        query("genre", { type: "array", items: { $ref: "#/components/schemas/DiscoveryGenre" } }),
        query("type", { type: "array", items: { $ref: "#/components/schemas/ThoughtDiscoveryType" } }),
        query("fresh", { type: "string", enum: ["0", "1", "fresh"] })
      ],
      responses: { "200": response("随机结果"), "400": error("BadRequest") }
    }
  },
  "/thought-chains/{id}/discovery": {
    patch: {
      ...versionedOperation("updateThoughtDiscoveryStatus", "更新思绪回访状态", "ThoughtDiscoveryId"),
      requestBody: jsonBody({
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["read", "snooze", "clearSnooze"] },
          until: { type: "string", format: "date-time" }
        },
        additionalProperties: false
      })
    }
  },
  "/exports/account": {
    get: {
      operationId: "exportAccount",
      summary: "导出账户数据",
      parameters: [query("format", { type: "string", enum: ["manifest", "json", "markdown", "md"], default: "manifest" })],
      responses: { "200": response("导出清单或文件描述"), "400": error("BadRequest") }
    }
  },
  "/actions": {
    get: listOperation("listActions", "列出行动"),
    post: createOperation("createAction", "创建行动", { $ref: "#/components/schemas/ActionInput" })
  },
  "/actions/{id}": {
    get: getOperation("getAction", "读取行动", "ActionId"),
    patch: versionedOperation("updateAction", "更新行动", "ActionId"),
    delete: versionedOperation("deleteAction", "删除行动", "ActionId", "delete")
  },
  "/actions/{id}/complete": {
    post: versionedOperation("completeAction", "完成行动", "ActionId", "update", false)
  },
  "/actions/{id}/reopen": {
    post: versionedOperation("reopenAction", "撤销行动完成", "ActionId", "update", false)
  },
  "/habits": {
    get: listOperation("listHabits", "列出习惯"),
    post: createOperation("createHabit", "创建习惯", { $ref: "#/components/schemas/HabitInput" })
  },
  "/habits/{id}": {
    get: getOperation("getHabit", "读取习惯", "HabitId"),
    patch: versionedOperation("updateHabit", "更新习惯", "HabitId"),
    delete: versionedOperation("deleteHabit", "删除习惯及其打卡", "HabitId", "delete")
  },
  "/habits/{id}/adjustments": {
    post: versionedOperation("recordHabitAdjustment", "记录习惯调整", "HabitId")
  },
  "/habits/{id}/checkins": {
    get: listOperation("listHabitCheckins", "列出习惯打卡", [id("HabitId"), query("date", { type: "string", format: "date" })]),
    post: {
      ...createOperation("createHabitCheckin", "创建习惯打卡", { $ref: "#/components/schemas/HabitCheckinInput" }),
      parameters: [id("HabitId"), id("IdempotencyKey")]
    }
  },
  "/habit-checkins/{id}": {
    patch: versionedOperation("updateHabitCheckin", "更新习惯打卡", "HabitCheckinId"),
    delete: versionedOperation("deleteHabitCheckin", "删除习惯打卡", "HabitCheckinId", "delete")
  },
  "/feedback": {
    get: listOperation("listFeedback", "列出产品反馈", [query("status")]),
    post: createOperation("submitFeedback", "提交产品反馈", { $ref: "#/components/schemas/FeedbackInput" })
  },
  "/feedback/{id}": {
    get: getOperation("getFeedback", "读取产品反馈", "FeedbackId")
  },
  "/feedback/{id}/status": {
    patch: versionedOperation("transitionFeedback", "流转产品反馈状态", "FeedbackId")
  },
  "/validation-ledger": {
    get: listOperation("listValidationLedger", "列出付费验证台账", [query("status")]),
    post: createOperation("createValidationPlan", "创建付费验证计划", { $ref: "#/components/schemas/ValidationPlanInput" })
  },
  "/validation-ledger/{id}": {
    get: getOperation("getValidationLedgerEntry", "读取付费验证记录", "ValidationLedgerId")
  },
  "/validation-ledger/{id}/consent": {
    post: versionedOperation("recordValidationConsent", "记录参与同意", "ValidationLedgerId")
  },
  "/validation-ledger/{id}/withdraw": {
    post: versionedOperation("withdrawValidation", "记录参与退出", "ValidationLedgerId")
  },
  "/validation-ledger/{id}/status": {
    post: versionedOperation("transitionValidationStatus", "流转验证状态", "ValidationLedgerId")
  },
  "/validation-ledger/{id}/compensation": {
    post: versionedOperation("recordValidationCompensation", "记录参与补偿", "ValidationLedgerId")
  },
  "/validation-ledger/{id}/rewards": {
    post: versionedOperation("recordValidationReward", "记录验证奖励", "ValidationLedgerId")
  },
  "/validation-ledger/{id}/participation": {
    post: versionedOperation("recordValidationParticipation", "记录真实参与证据", "ValidationLedgerId")
  }
});

export const g2Components = Object.freeze({
  parameters: {
    ThoughtDiscoveryId: { name: "id", in: "path", required: true, schema: { type: "string" } },
    ActionId: { name: "id", in: "path", required: true, schema: { type: "string" } },
    HabitId: { name: "id", in: "path", required: true, schema: { type: "string" } },
    HabitCheckinId: { name: "id", in: "path", required: true, schema: { type: "string" } },
    FeedbackId: { name: "id", in: "path", required: true, schema: { type: "string" } },
    ValidationLedgerId: { name: "id", in: "path", required: true, schema: { type: "string" } }
  },
  schemas: {
    DiscoveryGenre: { type: "string", enum: ["thought", "capture", "journal", "bookExcerpt", "quote"] },
    ThoughtDiscoveryType: { type: "string", enum: ["question", "idea", "answer", "record"] },
    ActionInput: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", maxLength: 120 },
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3", "none"] },
        status: { type: "string", enum: ["todo", "doing", "done"] },
        sourceRef: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              required: ["type", "id"],
              properties: { type: { type: "string" }, id: { type: "string" }, label: { type: "string" } },
              additionalProperties: false
            }
          ]
        }
      },
      additionalProperties: false
    },
    HabitInput: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", maxLength: 120 },
        frequency: {
          type: "object",
          required: ["cadence", "target"],
          properties: {
            cadence: { type: "string", enum: ["daily", "weekly"] },
            target: { type: "integer", minimum: 1, maximum: 7 }
          },
          additionalProperties: false,
          allOf: [
            {
              if: { properties: { cadence: { const: "daily" } }, required: ["cadence"] },
              then: { properties: { target: { const: 1 } } }
            }
          ]
        },
        status: { type: "string", enum: ["active", "paused"] },
        adjustment: { type: "string", maxLength: 2000 }
      },
      additionalProperties: false
    },
    HabitCheckinInput: {
      type: "object",
      properties: {
        occurredOn: { type: "string", format: "date" },
        feeling: { type: "string", maxLength: 1000 },
        adjustment: { type: "string", maxLength: 2000 }
      },
      additionalProperties: false
    },
    FeedbackInput: {
      type: "object",
      required: ["type", "feature", "appVersion", "body"],
      properties: {
        type: { type: "string", enum: ["bug", "feature", "experience", "other"] },
        feature: { type: "string", maxLength: 120 },
        appVersion: { type: "string", maxLength: 40 },
        body: { type: "string", maxLength: 12000 },
        context: {
          type: "object",
          properties: { selected: { type: "boolean" }, summary: { type: "string", maxLength: 2000 } },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    ValidationPlanInput: {
      type: "object",
      required: ["participantRef", "plan"],
      properties: {
        participantRef: { type: "string", maxLength: 120 },
        plan: { type: "object", additionalProperties: true }
      },
      additionalProperties: false
    }
  }
});

export const g2OpenApiFragment = Object.freeze({ paths: g2Paths, components: g2Components });
