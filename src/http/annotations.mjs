function annotationRoute(pathname) {
  let match = pathname.match(/^\/api\/annotations\/([^/]+)\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (match) return { resourceType: match[1], resourceId: match[2], id: match[3], action: match[4], drift: match[3] === "drift" && Boolean(match[4]) };
  match = pathname.match(/^\/api\/thoughts\/([^/]+)\/annotations(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (match) return { resourceType: "thought", resourceId: match[1], id: match[2], action: match[3] };
  match = pathname.match(/^\/api\/thoughts\/([^/]+)\/annotation-drift\/([^/]+)$/);
  return match ? { resourceType: "thought", resourceId: match[1], id: "drift", action: match[2], drift: true, driftOnly: true } : null;
}

export function createAnnotationHttp({
  commands,
  backgroundAi,
  prepareContentAttachments = async (_targetType, input) => ({ value: input }),
  sendTaskCreation,
  bodyJson,
  sendJson,
  sendTrashResult
}) {
  return async function handle(req, res, url) {
    const route = annotationRoute(url.pathname);
    if (!route) return false;
    const { resourceType, resourceId, id, action } = route;
    if (route.driftOnly && req.method !== "DELETE") return false;
    if (req.method === "POST" && !id) {
      const input = await bodyJson(req);
      let prepared = { value: input };
      if (!input.kind || input.kind === "comment") {
        prepared = await prepareContentAttachments("comment", input);
      }
      if (prepared.forbidden) {
        sendJson(res, 403, { error: prepared.error, code: prepared.code });
        return true;
      }
      if (prepared.error) {
        sendJson(res, 400, { error: prepared.error, code: prepared.code });
        return true;
      }
      const result = await commands.create(resourceType, resourceId, { ...input, ...prepared.value });
      if (result.invalid) sendJson(res, 400, { error: result.error });
      else if (result.missing) sendJson(res, 404, { error: "选中的正文已变化，请重新选择" });
      else sendJson(res, 201, result.value);
    } else if (req.method === "POST" && id && action === "replies") {
      const result = await commands.reply(resourceType, resourceId, id, await bodyJson(req));
      if (result.invalid) sendJson(res, 400, { error: result.error });
      else if (result.missing) sendJson(res, 404, { error: "评论不存在" });
      else sendJson(res, 201, result.value);
    } else if (req.method === "POST" && id && action === "shenji") {
      const input = await bodyJson(req);
      sendTaskCreation(res, await backgroundAi.enqueue({
        kind: "annotationShenji", resourceType, targetId: resourceId, subtargetId: id,
        payload: { message: input.message }, clientRequestId: input.clientRequestId
      }));
    } else if (req.method === "PATCH" && id && action === "convert") {
      if (typeof commands.convert !== "function") {
        sendJson(res, 501, { error: "批注互转尚未接入", code: "ANNOTATION_CONVERSION_NOT_CONFIGURED" });
      } else {
        const result = await commands.convert(resourceType, resourceId, id, await bodyJson(req));
        if (result.invalid) sendJson(res, 400, { error: result.error });
        else if (result.missing) sendJson(res, 404, { error: "批注不存在" });
        else sendJson(res, 200, result.value);
      }
    } else if (req.method === "DELETE" && route.drift) {
      sendTrashResult(res, await commands.remove(resourceType, resourceId, action, true), "漂流批注不存在");
    } else if (req.method === "DELETE" && id && !action) {
      sendTrashResult(res, await commands.remove(resourceType, resourceId, id), "评论不存在");
    } else return false;
    return true;
  };
}
