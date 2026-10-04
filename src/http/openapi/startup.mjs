export const startupPaths = {
  "/startup": {
    get: {
      operationId: "getStartup",
      summary: "读取轻量账户启动信息",
      responses: {
        "200": {
          description: "启动信息",
          content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessEnvelope" } } }
        },
        "401": { $ref: "#/components/responses/Unauthorized" }
      }
    }
  },
  "/route-state": {
    get: {
      operationId: "getRouteState",
      summary: "读取当前路由状态投影",
      parameters: [
        {
          name: "view",
          in: "query",
          required: true,
          schema: { type: "string" }
        },
        {
          name: "resourceId",
          in: "query",
          required: false,
          schema: { type: "string" }
        },
        {
          name: "q",
          in: "query",
          required: false,
          description: "思绪列表的服务端搜索词",
          schema: { type: "string", maxLength: 200 }
        },
        {
          name: "tag",
          in: "query",
          required: false,
          description: "思绪列表的标签筛选",
          schema: { type: "string", maxLength: 30 }
        },
        {
          name: "sort",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["occurred", "created"], default: "occurred" }
        },
        {
          name: "page",
          in: "query",
          required: false,
          description: "恢复已加载的思绪页数，最多 5 页",
          schema: { type: "integer", minimum: 1, maximum: 5, default: 1 }
        }
      ],
      responses: {
        "200": {
          description: "当前路由状态",
          content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessEnvelope" } } }
        },
        "400": { $ref: "#/components/responses/BadRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" }
      }
    }
  }
};

export const startupOpenApiFragment = Object.freeze({
  paths: startupPaths,
  components: { parameters: {}, schemas: {} }
});
