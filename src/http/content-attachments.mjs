const TARGET_ROUTE = /^\/api\/v1\/content-attachments\/([^/]+)\/([^/]+)$/;
const ORIGINAL_ROUTE = /^\/api\/v1\/content-attachments\/([^/]+)\/([^/]+)\/originals\/([^/]+)$/;
const RESTORE_ROUTE = /^\/api\/v1\/content-attachments\/trash\/([^/]+)\/restore$/;

function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function attachmentOwner(url, input = {}) {
  const collection = input.owner?.collection ?? url.searchParams.get("ownerCollection");
  const id = input.owner?.id ?? url.searchParams.get("ownerId");
  if (!collection && !id) return null;
  if (!["thoughts", "captures", "journals", "chats", "analyses", "books", "quotes"].includes(collection)
    || typeof id !== "string" || !id.trim() || id.length > 100) {
    throw Object.assign(new Error("图片批注所属信息无效"), {
      statusCode: 400, code: "INVALID_CONTENT_ATTACHMENT_OWNER"
    });
  }
  return { collection, id };
}

function sendResult(res, v1, result, { status = 200, includeEtag = true } = {}) {
  if (result.missing) return v1.error(res, 404, "图片原文目标不存在", "CONTENT_ATTACHMENT_TARGET_NOT_FOUND");
  if (result.attachmentMissing) return v1.error(res, 404, "原始图片引用不存在", "CONTENT_ATTACHMENT_NOT_FOUND");
  if (result.forbidden) return v1.error(res, 403, result.error, result.code || "ATTACHMENT_NOT_OWNED");
  if (result.parentMissing) return v1.error(res, 409, "请先恢复图片所属的内容记录", "TRASH_PARENT_MISSING");
  if (result.restoreConflict) return v1.error(res, 409, "当前内容已包含同一图片引用，未执行恢复", "TRASH_RESTORE_CONFLICT");
  if (result.invalid) return v1.error(res, 409, "图片回收记录结构异常，未执行恢复", "TRASH_ENTRY_INVALID");
  if (result.versionConflict) {
    return v1.error(res, 412, "资源版本已变化，请重新读取后再提交", "PRECONDITION_FAILED", {
      currentVersion: result.currentVersion
    });
  }
  if (result.stale) {
    return v1.error(res, 409, "图片原文已变化，理解结果未写入", "IMAGE_UNDERSTANDING_STALE", {
      currentVersion: result.currentVersion
    });
  }
  if (result.notConfigured) {
    return v1.error(res, 501, "图片理解任务尚未接入", "IMAGE_UNDERSTANDING_NOT_CONFIGURED");
  }
  if (result.error) return v1.error(res, 400, result.error, result.code || "VALIDATION_ERROR");
  return v1.success(res, status, result.value, {
    etag: includeEtag && result.value?.version ? v1.versionEtag(result.value.version) : "",
    meta: {
      ...(result.trashId ? { trashId: result.trashId } : {}),
      ...(result.unchanged ? { unchanged: true } : {}),
      ...(result.duplicate ? { duplicate: true } : {})
    }
  });
}

export function createContentAttachmentsHttp({ contentAttachments, bodyJson }) {
  if (!contentAttachments || typeof bodyJson !== "function") {
    throw new TypeError("Content attachment HTTP requires a service and body parser");
  }

  async function handleV1(req, res, url, v1) {
    let match;
    if (req.method === "POST" && url.pathname === "/api/v1/content-attachments/understandings") {
      const input = await bodyJson(req);
      return sendResult(res, v1, await contentAttachments.requestUnderstanding({
        targetType: input.targetType,
        targetId: input.targetId,
        owner: attachmentOwner(url, input),
        attachmentPaths: input.attachmentPaths,
        inputVersion: input.inputVersion
      }, {
        clientRequestId: v1.idempotencyKey(req)
      }), { status: 202, includeEtag: false });
    }
    match = url.pathname.match(RESTORE_ROUTE);
    if (req.method === "POST" && match) {
      return sendResult(res, v1, await contentAttachments.restoreOriginalImages(
        decoded(match[1]),
        { expectedVersion: v1.expectedVersion(req) }
      ));
    }
    match = url.pathname.match(ORIGINAL_ROUTE);
    if (req.method === "DELETE" && match) {
      const name = decoded(match[3]);
      return sendResult(res, v1, await contentAttachments.removeOriginalImage(
        decoded(match[1]),
        decoded(match[2]),
        name ? `/attachments/${name}` : "",
        { expectedVersion: v1.expectedVersion(req), owner: attachmentOwner(url) }
      ));
    }
    match = url.pathname.match(TARGET_ROUTE);
    if (req.method === "GET" && match) {
      return sendResult(res, v1, await contentAttachments.get(decoded(match[1]), decoded(match[2]), {
        owner: attachmentOwner(url)
      }));
    }
    if (req.method === "PUT" && match) {
      const input = await bodyJson(req);
      return sendResult(res, v1, await contentAttachments.replaceOriginalImages(
        decoded(match[1]),
        decoded(match[2]),
        input.attachmentPaths,
        { expectedVersion: v1.expectedVersion(req), owner: attachmentOwner(url, input) }
      ));
    }
    return false;
  }

  return { handleV1 };
}
