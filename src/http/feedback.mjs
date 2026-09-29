const pageOf = (items, { afterId, limit }) => {
  const start = afterId ? items.findIndex(item => item.id === afterId) + 1 : 0;
  if (afterId && start === 0) return { invalidCursor: true };
  const page = items.slice(start, start + limit);
  return { items: page, nextId: start + page.length < items.length ? page.at(-1)?.id || "" : "" };
};

const sendResult = (res, v1, result, { created = false } = {}) => {
  if (result.missing) return v1.error(res, 404, "记录不存在", "RECORD_NOT_FOUND");
  if (result.versionConflict) return v1.error(res, 412, "资源版本已变化，请重新读取后再提交", "PRECONDITION_FAILED", { currentVersion: result.currentVersion });
  if (result.conflict) return v1.error(res, 409, "幂等标识已用于不同内容", result.code || "IDEMPOTENCY_KEY_REUSED");
  if (result.error) return v1.error(res, 400, result.error, result.code || "VALIDATION_ERROR", result.details);
  const version = result.ledger?.version || result.value?.version;
  return v1.success(res, created ? (result.duplicate ? 200 : 201) : 200, result.value, {
    etag: version ? v1.versionEtag(version) : ""
  });
};

export function createFeedbackHttp({ feedback, bodyJson }) {
  async function list(res, v1, url, result) {
    const page = pageOf(result.items, v1.pagination(url));
    if (page.invalidCursor) return v1.error(res, 400, "游标无效或已过期", "INVALID_CURSOR");
    return v1.success(res, 200, page.items, { meta: { nextCursor: v1.nextCursor(page.nextId) } });
  }

  async function handleV1(req, res, url, v1) {
    if (req.method === "GET" && url.pathname === "/api/v1/feedback") {
      return list(res, v1, url, await feedback.listFeedback({ status: url.searchParams.get("status") || "" }));
    }
    if (req.method === "POST" && url.pathname === "/api/v1/feedback") {
      return sendResult(res, v1, await feedback.submitFeedback(await bodyJson(req), {
        clientRequestId: v1.idempotencyKey(req)
      }), { created: true });
    }
    if (req.method === "GET" && /^\/api\/v1\/feedback\/[^/]+$/.test(url.pathname)) {
      const item = await feedback.getFeedback(url.pathname.split("/")[4]);
      return item
        ? v1.success(res, 200, item, { etag: v1.versionEtag(item.version) })
        : v1.error(res, 404, "反馈不存在", "FEEDBACK_NOT_FOUND");
    }
    if (req.method === "PATCH" && /^\/api\/v1\/feedback\/[^/]+\/status$/.test(url.pathname)) {
      const input = await bodyJson(req);
      return sendResult(res, v1, await feedback.transitionFeedback(
        url.pathname.split("/")[4],
        input.status,
        { expectedVersion: v1.expectedVersion(req) }
      ));
    }

    if (req.method === "GET" && url.pathname === "/api/v1/validation-ledger") {
      return list(res, v1, url, await feedback.listValidation({ status: url.searchParams.get("status") || "" }));
    }
    if (req.method === "POST" && url.pathname === "/api/v1/validation-ledger") {
      return sendResult(res, v1, await feedback.createValidationPlan(await bodyJson(req), {
        clientRequestId: v1.idempotencyKey(req)
      }), { created: true });
    }
    if (req.method === "GET" && /^\/api\/v1\/validation-ledger\/[^/]+$/.test(url.pathname)) {
      const item = await feedback.getValidation(url.pathname.split("/")[4]);
      return item
        ? v1.success(res, 200, item, { etag: v1.versionEtag(item.version) })
        : v1.error(res, 404, "验证记录不存在", "VALIDATION_RECORD_NOT_FOUND");
    }
    const actionMatch = /^\/api\/v1\/validation-ledger\/([^/]+)\/(consent|withdraw|status|compensation|rewards|participation)$/.exec(url.pathname);
    if (req.method === "POST" && actionMatch) {
      const [, id, action] = actionMatch;
      const input = await bodyJson(req);
      const options = { expectedVersion: v1.expectedVersion(req) };
      const result = action === "consent"
        ? await feedback.recordConsent(id, input, options)
        : action === "withdraw"
          ? await feedback.withdrawValidation(id, input, options)
          : action === "status"
            ? await feedback.transitionValidation(id, input.status, options)
            : action === "compensation"
              ? await feedback.recordCompensation(id, input, options)
              : action === "rewards"
                ? await feedback.recordReward(id, input, options)
                : await feedback.recordParticipation(id, input, options);
      return sendResult(res, v1, result);
    }
    return false;
  }

  return { handleV1 };
}
