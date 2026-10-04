const legacyServer = [{ url: "/api" }];
const audioResponse = description => ({
  description,
  headers: {
    "X-Speech-Provider": { schema: { type: "string" } },
    "X-Speech-Voice": { schema: { type: "string" } },
    "X-Speech-Asset-Id": { schema: { type: "string" } },
    "X-Speech-Cache": { schema: { type: "string", enum: ["hit", "miss"] } }
  },
  content: {
    "audio/mpeg": {
      schema: { type: "string", format: "binary" }
    }
  }
});
const errorResponse = description => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["error", "code"],
        properties: {
          error: { type: "string" },
          code: { type: "string" }
        },
        additionalProperties: true
      }
    }
  }
});

export const speechPaths = Object.freeze({
  "/speech/voices": {
    get: {
      operationId: "listSpeechVoices",
      servers: legacyServer,
      responses: {
        "200": {
          description: "官方白名单音色",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["configured", "defaultVoice", "voices"],
                properties: {
                  configured: { type: "boolean" },
                  defaultVoice: { type: "string" },
                  voices: {
                    type: "array",
                    items: { $ref: "#/components/schemas/SpeechVoice" }
                  }
                }
              }
            }
          }
        },
        "401": errorResponse("未登录")
      }
    }
  },
  "/speech/preview": {
    post: {
      operationId: "previewSpeechVoice",
      servers: legacyServer,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["voice"],
              properties: { voice: { type: "string" } },
              additionalProperties: false
            }
          }
        }
      },
      responses: {
        "200": audioResponse("固定示例文案的官方音色试听"),
        "400": errorResponse("音色或请求字段无效"),
        "401": errorResponse("未登录"),
        "429": errorResponse("AI 预算不足"),
        "503": errorResponse("语音服务不可用")
      }
    }
  },
  "/speech/synthesize": {
    post: {
      operationId: "synthesizeSpeech",
      servers: legacyServer,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SpeechSynthesisInput" }
          }
        }
      },
      responses: {
        "200": audioResponse("缓存或新生成的朗读音频"),
        "400": errorResponse("朗读来源无效"),
        "401": errorResponse("未登录"),
        "404": errorResponse("朗读来源不存在"),
        "409": errorResponse("朗读来源版本已变化"),
        "429": errorResponse("AI 预算不足"),
        "503": errorResponse("语音服务不可用")
      }
    }
  },
  "/speech/audio": {
    get: {
      operationId: "readSpeechAudio",
      servers: legacyServer,
      parameters: [{
        name: "id",
        in: "query",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 160 }
      }],
      responses: {
        "200": audioResponse("已存在的朗读缓存音频；不会触发生成"),
        "400": errorResponse("asset id 无效"),
        "401": errorResponse("未登录"),
        "404": errorResponse("asset 或音频文件不存在"),
        "410": errorResponse("asset 已过期或来源已变化")
      }
    }
  }
});

export const speechComponents = Object.freeze({
  schemas: Object.freeze({
    SpeechVoice: {
      type: "object",
      required: ["id", "label", "gender", "age", "sampleText"],
      properties: {
        id: { type: "string" },
        label: { type: "string" },
        gender: { type: "string", enum: ["male", "female"] },
        age: { type: "string", enum: ["young", "mature"] },
        sampleText: { type: "string" }
      },
      additionalProperties: false
    },
    SpeechSynthesisInput: {
      type: "object",
      required: ["sourceVersion"],
      anyOf: [
        { required: ["sourceType", "sourceId"] },
        { required: ["captureId"] }
      ],
      properties: {
        sourceType: { type: "string", enum: ["capture", "thoughtAnswer"] },
        sourceId: { type: "string", minLength: 1, maxLength: 160 },
        sourceVersion: { type: "integer", minimum: 1 },
        regenerate: { type: "boolean", default: false },
        captureId: {
          type: "string",
          minLength: 1,
          maxLength: 160,
          deprecated: true,
          description: "旧捕念朗读请求兼容字段；等价于 sourceType=capture 与 sourceId。"
        }
      },
      additionalProperties: true
    },
    SpeechAsset: {
      type: "object",
      required: [
        "id",
        "sourceType",
        "sourceId",
        "sourceVersion",
        "voice",
        "generationRate",
        "mimeType",
        "bytes",
        "createdAt",
        "expiresAt"
      ],
      properties: {
        id: { type: "string" },
        sourceType: { type: "string", enum: ["capture", "thoughtAnswer"] },
        sourceId: { type: "string" },
        sourceVersion: { type: "integer", minimum: 1 },
        voice: { type: "string" },
        generationRate: { type: "integer", minimum: -50, maximum: 100 },
        mimeType: { type: "string", enum: ["audio/mpeg"] },
        bytes: { type: "integer", minimum: 0 },
        createdAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" }
      },
      additionalProperties: false
    }
  })
});

export const speechOpenApiFragment = Object.freeze({
  paths: speechPaths,
  components: speechComponents
});
