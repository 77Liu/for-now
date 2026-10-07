const pageOf = (items, { afterId, limit }) => {
  const start = afterId ? items.findIndex(item => item.id === afterId) + 1 : 0;
  if (afterId && start === 0) return { invalidCursor: true };
  const page = items.slice(start, start + limit);
  return { items: page, nextId: start + page.length < items.length ? page.at(-1)?.id || "" : "" };
};

const sendResult = (res, v1, result, { created = false } = {}) => {
  if (result.missing) return v1.error(res, 404, "记录不存在", "RECORD_NOT_FOUND");
  if (result.versionConflict) return v1.error(res, 412, "资源版本已变化，请重新读取后再提交", "PRECONDITION_FAILED", { currentVersion: result.currentVersion });
  if (result.conflict) return v1.error(res, 409, "同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED");
  if (result.invalidState || result.inactive || result.dateConflict) {
    return v1.error(res, 409, result.inactive ? "已暂停的习惯不能打卡" : result.dateConflict ? "该日期已有打卡" : "当前状态不允许该操作", "STATE_CONFLICT");
  }
  if (result.error) return v1.error(res, 400, result.error, result.code || "VALIDATION_ERROR");
  return v1.success(res, created ? (result.duplicate ? 200 : 201) : 200, result.value, {
    etag: result.value?.version ? v1.versionEtag(result.value.version) : ""
  });
};

export function createActionsHttp({ actions, remove, bodyJson }) {
  async function list(res, v1, url, items) {
    const page = pageOf(items, v1.pagination(url));
    if (page.invalidCursor) return v1.error(res, 400, "游标无效或已过期", "INVALID_CURSOR");
    return v1.success(res, 200, page.items, { meta: { nextCursor: v1.nextCursor(page.nextId) } });
  }

  async function handleV1(req, res, url, v1) {
    if (req.method === "GET" && url.pathname === "/api/v1/actions") return list(res, v1, url, await actions.listActions());
    if (req.method === "POST" && url.pathname === "/api/v1/actions") {
      return sendResult(res, v1, await actions.createAction(await bodyJson(req), {
        clientRequestId: v1.idempotencyKey(req)
      }), { created: true });
    }
    if (req.method === "GET" && /^\/api\/v1\/actions\/[^/]+$/.test(url.pathname)) {
      const item = await actions.getAction(url.pathname.split("/")[4]);
      return item
        ? v1.success(res, 200, item, { etag: v1.versionEtag(item.version) })
        : v1.error(res, 404, "行动不存在", "ACTION_NOT_FOUND");
    }
    if (req.method === "PATCH" && /^\/api\/v1\/actions\/[^/]+$/.test(url.pathname)) {
      return sendResult(res, v1, await actions.updateAction(
        url.pathname.split("/")[4],
        await bodyJson(req),
        { expectedVersion: v1.expectedVersion(req) }
      ));
    }
    if (req.method === "POST" && /^\/api\/v1\/actions\/[^/]+\/(?:complete|reopen)$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      const expectedVersion = v1.expectedVersion(req);
      const result = parts[5] === "complete"
        ? await actions.completeAction(parts[4], await bodyJson(req), { expectedVersion })
        : await actions.undoActionCompletion(parts[4], { expectedVersion });
      return sendResult(res, v1, result);
    }
    if (req.method === "DELETE" && /^\/api\/v1\/actions\/[^/]+$/.test(url.pathname)) {
      return sendResult(res, v1, await remove("action", url.pathname.split("/")[4], v1.expectedVersion(req)));
    }

    if (req.method === "GET" && url.pathname === "/api/v1/habits") return list(res, v1, url, await actions.listHabits());
    if (req.method === "POST" && url.pathname === "/api/v1/habits") {
      return sendResult(res, v1, await actions.createHabit(await bodyJson(req), {
        clientRequestId: v1.idempotencyKey(req)
      }), { created: true });
    }
    if (req.method === "GET" && /^\/api\/v1\/habits\/[^/]+$/.test(url.pathname)) {
      const item = await actions.getHabit(url.pathname.split("/")[4]);
      return item
        ? v1.success(res, 200, item, { etag: v1.versionEtag(item.version) })
        : v1.error(res, 404, "习惯不存在", "HABIT_NOT_FOUND");
    }
    if (req.method === "PATCH" && /^\/api\/v1\/habits\/[^/]+$/.test(url.pathname)) {
      return sendResult(res, v1, await actions.updateHabit(
        url.pathname.split("/")[4],
        await bodyJson(req),
        { expectedVersion: v1.expectedVersion(req) }
      ));
    }
    if (req.method === "POST" && /^\/api\/v1\/habits\/[^/]+\/adjustments$/.test(url.pathname)) {
      return sendResult(res, v1, await actions.recordHabitAdjustment(
        url.pathname.split("/")[4],
        await bodyJson(req),
        { expectedVersion: v1.expectedVersion(req) }
      ));
    }
    if (req.method === "DELETE" && /^\/api\/v1\/habits\/[^/]+$/.test(url.pathname)) {
      return sendResult(res, v1, await remove("habit", url.pathname.split("/")[4], v1.expectedVersion(req)));
    }
    if (req.method === "GET" && /^\/api\/v1\/habits\/[^/]+\/checkins$/.test(url.pathname)) {
      const habitId = url.pathname.split("/")[4];
      const items = await actions.listHabitCheckins({ habitId, occurredOn: url.searchParams.get("date") || "" });
      return list(res, v1, url, items);
    }
    if (req.method === "POST" && /^\/api\/v1\/habits\/[^/]+\/checkins$/.test(url.pathname)) {
      return sendResult(res, v1, await actions.checkInHabit(
        url.pathname.split("/")[4],
        await bodyJson(req),
        { clientRequestId: v1.idempotencyKey(req) }
      ), { created: true });
    }
    if (req.method === "PATCH" && /^\/api\/v1\/habit-checkins\/[^/]+$/.test(url.pathname)) {
      return sendResult(res, v1, await actions.updateHabitCheckin(
        url.pathname.split("/")[4],
        await bodyJson(req),
        { expectedVersion: v1.expectedVersion(req) }
      ));
    }
    if (req.method === "DELETE" && /^\/api\/v1\/habit-checkins\/[^/]+$/.test(url.pathname)) {
      return sendResult(res, v1, await remove("habitCheckin", url.pathname.split("/")[4], v1.expectedVersion(req)));
    }
    return false;
  }

  return { handleV1 };
}
