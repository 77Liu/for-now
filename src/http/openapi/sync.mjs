export const syncPaths = {
  "/sync": {
    get: {
      operationId: "getIncrementalSync",
      summary: "按账户变更游标读取增量快照",
      parameters: [
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 0 }
        },
        {
          name: "waitMs",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 0, maximum: 1500, default: 0 }
        }
      ],
      responses: {
        "200": {
          description: "游标、至少一次变更事件与受影响领域快照",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SuccessEnvelope" }
            }
          }
        },
        "409": { $ref: "#/components/responses/Conflict" },
        "410": { description: "游标已超过保留窗口，需要重新读取完整状态" }
      }
    }
  },
  "/sync/operations/{operationId}": {
    get: {
      operationId: "getSyncOperation",
      summary: "查询客户端操作是否已提交",
      parameters: [
        {
          name: "operationId",
          in: "path",
          required: true,
          schema: { type: "string", maxLength: 100 }
        },
        {
          name: "fingerprint",
          in: "query",
          required: true,
          schema: { type: "string", pattern: "^[a-f0-9]{64}$" }
        }
      ],
      responses: {
        "200": {
          description: "操作终态",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SuccessEnvelope" }
            }
          }
        },
        "400": { $ref: "#/components/responses/BadRequest" },
        "409": { $ref: "#/components/responses/Conflict" }
      }
    }
  }
};

export const syncOpenApiFragment = { paths: syncPaths, components: { parameters: {}, schemas: {} } };
