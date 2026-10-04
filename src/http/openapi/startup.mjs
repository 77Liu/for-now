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
