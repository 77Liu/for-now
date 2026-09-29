import { safeText } from "../shared/validation/index.mjs";

export function createTrashHttp({ commands, bodyJson, sendJson, logEvent }) {
  const idsFrom = input => [...new Set((Array.isArray(input.ids) ? input.ids : []).map(value => safeText(value, 100)).filter(Boolean))];

  async function sendMoved(res, entry, missingMessage) {
    if (!entry) return sendJson(res, 404, { error: missingMessage });
    await logEvent("operation", "trash.moved", { trashId: entry.id, resourceType: entry.type, resourceId: entry.resourceId });
    return sendJson(res, 200, {
      removed: 1,
      trashId: entry.id,
      deletedAt: entry.deletedAt,
      purgeAfter: entry.purgeAfter,
      lifecycle: entry.lifecycle,
      tombstone: true
    });
  }

  async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/trash") {
      sendJson(res, 200, await commands.list());
    } else if (req.method === "POST" && /^\/api\/trash\/[^/]+\/restore$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3], restored = await commands.restore(id);
      if (restored.missing) sendJson(res, 404, { error: "回收站中没有这条记录" });
      else if (restored.parentMissing) sendJson(res, 409, { error: "请先恢复它所属的上级记录", code: "TRASH_PARENT_MISSING" });
      else if (restored.conflict) sendJson(res, 409, { error: "当前数据中已存在同一条记录，未执行恢复", code: "TRASH_RESTORE_CONFLICT" });
      else if (restored.invalid) sendJson(res, 409, { error: "这条回收记录结构异常，未执行恢复", code: "TRASH_ENTRY_INVALID" });
      else {
        await logEvent("operation", "trash.restored", { trashId: id, resourceType: restored.value.type, resourceId: restored.value.resourceId });
        sendJson(res, 200, { restored: restored.value });
      }
    } else if (req.method === "POST" && url.pathname === "/api/trash/purge-preview") {
      sendJson(res, 200, await commands.preview(idsFrom(await bodyJson(req))));
    } else if (req.method === "POST" && url.pathname === "/api/trash/purge") {
      const input = await bodyJson(req), ids = idsFrom(input);
      if (!ids.length || input.confirmation !== "永久删除") {
        sendJson(res, 400, { error: "永久清理需要选中记录并输入“永久删除”" });
      } else {
        const purged = await commands.purge(ids, safeText(input.planHash, 100));
        if (purged.missing) sendJson(res, 404, { error: "选中的回收记录已不存在" });
        else if (purged.changed) sendJson(res, 409, { error: "回收站内容已变化，请重新确认", code: "TRASH_PLAN_CHANGED", ...purged.plan });
        else {
          await logEvent("operation", "trash.purged", { trashIds: purged.entries.map(item => item.id), resourceCount: purged.entries.length, attachmentCount: purged.attachments.length, attachmentCleanupPending: purged.attachmentCleanupPending, planHash: purged.plan.planHash });
          if (purged.attachmentCleanupPending) await logEvent("system", "trash.attachment_cleanup_pending", { level: "error", pendingCount: purged.attachmentCleanupPending });
          sendJson(res, 200, { purged: purged.entries.length, attachmentsPurged: purged.attachments.length, attachmentCleanupPending: purged.attachmentCleanupPending });
        }
      }
    } else return false;
    return true;
  }

  return { handle, sendMoved };
}
