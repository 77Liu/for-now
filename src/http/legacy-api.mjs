const invokeHandlers = async (handlers, req, res, url) => {
  for (const handler of handlers) {
    if (await handler(req, res, url)) return true;
  }
  return false;
};

export function createLegacyApi({
  beforeStateHandlers,
  afterStateHandlers,
  readMeta,
  readState,
  sendJson,
  beforeHandle = async () => {}
}) {
  for (const [name, handlers] of Object.entries({ beforeStateHandlers, afterStateHandlers })) {
    if (!Array.isArray(handlers) || handlers.some(handler => typeof handler !== "function")) {
      throw new TypeError(`Legacy API requires ${name} functions`);
    }
  }
  for (const [name, dependency] of Object.entries({ readMeta, readState, sendJson })) {
    if (typeof dependency !== "function") throw new TypeError(`Legacy API requires ${name}()`);
  }
  return {
    async handle(req, res, url) {
      if (req.method === "GET" && url.pathname === "/api/meta") {
        return sendJson(res, 200, await readMeta());
      }
      await beforeHandle(req, url);
      if (await invokeHandlers(beforeStateHandlers, req, res, url)) return;
      if (req.method === "GET" && url.pathname === "/api/state") {
        return sendJson(res, 200, await readState());
      }
      if (await invokeHandlers(afterStateHandlers, req, res, url)) return;
      return sendJson(res, 404, { error: "Not found" });
    }
  };
}
