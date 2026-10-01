import { safeText } from "../shared/validation/index.mjs";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const legacyTags = input => Array.isArray(input.tags) ? input.tags : [];
const requestBinding = input => {
  const requestId = safeText(input?.requestId, 100);
  const targetId = safeText(input?.targetId, 100);
  return requestId && targetId
    ? { requestId, targetId, inputVersion: Math.max(0, Math.round(Number(input.inputVersion) || 0)) }
    : {};
};

export function createCaptureJournalHttp({
  captures,
  journals,
  workflows,
  prepareContentAttachments = async (_targetType, input) => ({ value: input }),
  prepareCaptureAudio = async input => ({ value: { audio: input.audio ?? null } }),
  requestCaptureTranscription = async () => null,
  removeCapture,
  removeJournal,
  removeReflection,
  sendTrashResult,
  bodyJson,
  sendJson,
  respondModel
}) {
  async function prepareCapture(input) {
    const audioOnly = input.audio
      && !safeText(input.content, 12000)
      && (!input.attachmentPaths || (Array.isArray(input.attachmentPaths) && !input.attachmentPaths.length));
    const content = audioOnly
      ? { value: { content: "", attachmentPaths: [] } }
      : await prepareContentAttachments("capture", input);
    if (content.forbidden || content.error) return content;
    const audio = await prepareCaptureAudio(input);
    if (audio.forbidden || audio.error) return audio;
    return { value: { ...content.value, ...audio.value } };
  }

  async function withTranscription(result) {
    if (!result?.value?.audio?.attachmentPath || result.value.transcription?.status === "ready") return result;
    await requestCaptureTranscription(result.value);
    return { ...result, value: await captures.get(result.value.id) || result.value };
  }

  async function handleV1(req, res, url, v1) {
    if (req.method === "GET" && url.pathname === "/api/v1/captures") {
      const page = await captures.list(v1.pagination(url));
      if (page.invalidCursor) return v1.error(res, 400, "游标无效或已过期", "INVALID_CURSOR");
      return v1.success(res, 200, page.items, { meta: { nextCursor: v1.nextCursor(page.nextId) } });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/captures") {
      const input = await bodyJson(req);
      const prepared = await prepareCapture(input);
      if (prepared.forbidden) return v1.error(res, 403, prepared.error, prepared.code);
      if (prepared.error) return v1.error(res, 400, prepared.error, prepared.code || "VALIDATION_ERROR");
      let result = await captures.create({ ...input, ...prepared.value }, { clientRequestId: v1.idempotencyKey(req) });
      if (result.error) return v1.error(res, 400, result.error, result.code || "VALIDATION_ERROR");
      if (result.conflict) return v1.error(res, 409, "同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED");
      result = await withTranscription(result);
      return v1.success(res, result.duplicate ? 200 : 201, result.value, {
        etag: v1.versionEtag(result.value.version)
      });
    }
    if (req.method === "GET" && /^\/api\/v1\/captures\/[^/]+$/.test(url.pathname)) {
      const capture = await captures.get(url.pathname.split("/")[4]);
      return capture
        ? v1.success(res, 200, capture, { etag: v1.versionEtag(capture.version) })
        : v1.error(res, 404, "这条捕念不存在", "CAPTURE_NOT_FOUND");
    }
    if (req.method === "PATCH" && /^\/api\/v1\/captures\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/")[4], input = await bodyJson(req), current = await captures.get(id);
      if (!current) return v1.error(res, 404, "这条捕念不存在", "CAPTURE_NOT_FOUND");
      const prepared = await prepareCapture({
        content: hasOwn(input, "content") ? input.content : current.content,
        attachmentPaths: hasOwn(input, "attachmentPaths") ? input.attachmentPaths : current.attachmentPaths || [],
        audio: hasOwn(input, "audio") ? input.audio : current.audio || null
      });
      if (prepared.forbidden) return v1.error(res, 403, prepared.error, prepared.code);
      if (prepared.error) return v1.error(res, 400, prepared.error, prepared.code || "VALIDATION_ERROR");
      let result = await captures.update(
        id,
        { ...input, ...prepared.value },
        { expectedVersion: v1.expectedVersion(req) }
      );
      if (result.missing) return v1.error(res, 404, "这条捕念不存在", "CAPTURE_NOT_FOUND");
      if (result.versionConflict) return v1.error(res, 412, "资源版本已变化，请重新读取后再提交", "PRECONDITION_FAILED", { currentVersion: result.currentVersion });
      if (result.error) return v1.error(res, 400, result.error, result.code || "VALIDATION_ERROR");
      result = await withTranscription(result);
      return v1.success(res, 200, result.value, { etag: v1.versionEtag(result.value.version) });
    }
    if (req.method === "POST" && /^\/api\/v1\/captures\/[^/]+\/transcription$/.test(url.pathname)) {
      const capture = await captures.get(url.pathname.split("/")[4]);
      if (!capture) return v1.error(res, 404, "这条捕念不存在", "CAPTURE_NOT_FOUND");
      if (!capture.audio?.attachmentPath) return v1.error(res, 409, "这条捕念没有语音原件", "CAPTURE_AUDIO_MISSING");
      const task = await requestCaptureTranscription(capture, { force: true });
      return task
        ? v1.success(res, 202, task)
        : v1.error(res, 503, "火山语音服务尚未配置", "SPEECH_NOT_CONFIGURED");
    }
    if (req.method === "DELETE" && /^\/api\/v1\/captures\/[^/]+$/.test(url.pathname)) {
      const entry = await removeCapture(url.pathname.split("/")[4], v1.expectedVersion(req));
      if (entry?.versionConflict) return v1.error(res, 412, "资源版本已变化，请重新读取后再提交", "PRECONDITION_FAILED", { currentVersion: entry.currentVersion });
      return entry
        ? v1.success(res, 200, { trashId: entry.id })
        : v1.error(res, 404, "这条捕念不存在", "CAPTURE_NOT_FOUND");
    }
    if (req.method === "GET" && url.pathname === "/api/v1/journal-draft") {
      const draft = await journals.getDraft();
      return v1.success(res, 200, draft, draft ? { etag: v1.versionEtag(draft.version) } : {});
    }
    if (req.method === "PUT" && url.pathname === "/api/v1/journal-draft") {
      const result = await journals.saveDraft(await bodyJson(req), { clientRequestId: v1.idempotencyKey(req) });
      if (result.error) return v1.error(res, 400, result.error, "VALIDATION_ERROR");
      if (result.conflict) return v1.error(res, 409, "同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED");
      return v1.success(res, 200, result.value, { etag: v1.versionEtag(result.value.version) });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/journals") {
      const page = await journals.list(v1.pagination(url));
      if (page.invalidCursor) return v1.error(res, 400, "游标无效或已过期", "INVALID_CURSOR");
      return v1.success(res, 200, page.items, { meta: { nextCursor: v1.nextCursor(page.nextId) } });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/journals") {
      const result = await journals.create(await bodyJson(req), { clientRequestId: v1.idempotencyKey(req) });
      if (result.error) return v1.error(res, 400, result.error, "VALIDATION_ERROR");
      if (result.conflict) return v1.error(res, 409, "同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED");
      return v1.success(res, result.duplicate ? 200 : 201, result.value, {
        etag: v1.versionEtag(result.value.version)
      });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/journals/assist") {
      const input = await bodyJson(req);
      if (!["lead", "structure", "topic"].includes(input.mode)) {
        return v1.error(res, 400, "日记辅助类型无效", "VALIDATION_ERROR");
      }
      await respondModel(req, res, {
        run: onDelta => workflows.assist(input, { binding: requestBinding(input), onDelta }),
        formatResult: value => v1.envelope(value),
        formatError: error => ({ type: "error", ...v1.errorEnvelope(error) })
      });
      return true;
    }
    if (req.method === "GET" && /^\/api\/v1\/journals\/[^/]+$/.test(url.pathname)) {
      const journal = await journals.get(url.pathname.split("/")[4]);
      return journal
        ? v1.success(res, 200, journal, { etag: v1.versionEtag(journal.version) })
        : v1.error(res, 404, "这篇日记不存在", "JOURNAL_NOT_FOUND");
    }
    if (req.method === "PATCH" && /^\/api\/v1\/journals\/[^/]+$/.test(url.pathname)) {
      const result = await journals.update(
        url.pathname.split("/")[4],
        await bodyJson(req),
        { expectedVersion: v1.expectedVersion(req) }
      );
      if (result.missing) return v1.error(res, 404, "这篇日记不存在", "JOURNAL_NOT_FOUND");
      if (result.versionConflict) return v1.error(res, 412, "资源版本已变化，请重新读取后再提交", "PRECONDITION_FAILED", { currentVersion: result.currentVersion });
      if (result.error) return v1.error(res, 400, result.error, "VALIDATION_ERROR");
      return v1.success(res, 200, result.value, { etag: v1.versionEtag(result.value.version) });
    }
    if (req.method === "DELETE" && /^\/api\/v1\/journals\/[^/]+$/.test(url.pathname)) {
      const entry = await removeJournal(url.pathname.split("/")[4], v1.expectedVersion(req));
      if (entry?.versionConflict) return v1.error(res, 412, "资源版本已变化，请重新读取后再提交", "PRECONDITION_FAILED", { currentVersion: entry.currentVersion });
      return entry
        ? v1.success(res, 200, { trashId: entry.id })
        : v1.error(res, 404, "这篇日记不存在", "JOURNAL_NOT_FOUND");
    }
    if (req.method === "POST" && /^\/api\/v1\/journals\/[^/]+\/reflections$/.test(url.pathname)) {
      const id = url.pathname.split("/")[4];
      if (!await journals.get(id)) return v1.error(res, 404, "这篇日记不存在", "JOURNAL_NOT_FOUND");
      const clientRequestId = v1.idempotencyKey(req);
      await respondModel(req, res, {
        status: 201,
        run: onDelta => workflows.reflect({ id, clientRequestId, onDelta }),
        formatResult: value => v1.envelope(value),
        formatError: error => ({ type: "error", ...v1.errorEnvelope(error) })
      });
      return true;
    }
    if (req.method === "DELETE" && /^\/api\/v1\/journals\/[^/]+\/reflections\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      const entry = await removeReflection(parts[4], parts[6], v1.expectedVersion(req));
      if (entry?.versionConflict) return v1.error(res, 412, "资源版本已变化，请重新读取后再提交", "PRECONDITION_FAILED", { currentVersion: entry.currentVersion });
      return entry
        ? v1.success(res, 200, { trashId: entry.id })
        : v1.error(res, 404, "这条日记回望不存在", "JOURNAL_REFLECTION_NOT_FOUND");
    }
    return false;
  }

  async function handle(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/captures") {
      const input = await bodyJson(req), prepared = await prepareCapture(input);
      if (prepared.forbidden) sendJson(res, 403, { error: prepared.error, code: prepared.code });
      else if (prepared.error) sendJson(res, 400, { error: prepared.error, code: prepared.code });
      else {
        let result = await captures.create({ ...input, ...prepared.value });
        if (!result.error) result = await withTranscription(result);
        sendJson(res, result.error ? 400 : 201, result.error ? { error: result.error } : result.value);
      }
    } else if (req.method === "POST" && /^\/api\/captures\/[^/]+\/transcription$/.test(url.pathname)) {
      const capture = await captures.get(url.pathname.split("/")[3]);
      if (!capture) sendJson(res, 404, { error: "这条捕念不存在", code: "CAPTURE_NOT_FOUND" });
      else if (!capture.audio?.attachmentPath) sendJson(res, 409, { error: "这条捕念没有语音原件", code: "CAPTURE_AUDIO_MISSING" });
      else {
        const task = await requestCaptureTranscription(capture, { force: true });
        if (task) sendJson(res, 202, task);
        else sendJson(res, 503, { error: "火山语音服务尚未配置", code: "SPEECH_NOT_CONFIGURED" });
      }
    } else if (req.method === "PATCH" && /^\/api\/captures\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3], input = await bodyJson(req), current = await captures.get(id);
      if (!current) {
        sendJson(res, 404, { error: "这条捕念不存在" });
      } else {
        const prepared = await prepareCapture({
          content: hasOwn(input, "content") ? input.content : current.content,
          attachmentPaths: hasOwn(input, "attachmentPaths") ? input.attachmentPaths : current.attachmentPaths || [],
          audio: hasOwn(input, "audio") ? input.audio : current.audio || null
        });
        if (prepared.forbidden) sendJson(res, 403, { error: prepared.error, code: prepared.code });
        else if (prepared.error) sendJson(res, 400, { error: prepared.error, code: prepared.code });
        else {
          let result = await captures.update(id, { ...input, ...prepared.value, tags: legacyTags(input) });
          if (result.missing) sendJson(res, 404, { error: "这条捕念不存在" });
          else if (result.error) sendJson(res, 400, { error: result.error });
          else {
            result = await withTranscription(result);
            sendJson(res, 200, result.value);
          }
        }
      }
    } else if (req.method === "DELETE" && /^\/api\/captures\/[^/]+$/.test(url.pathname)) {
      await sendTrashResult(res, await removeCapture(url.pathname.split("/")[3]), "这条捕念不存在");
    } else if (req.method === "PUT" && url.pathname === "/api/journal-draft") {
      const result = await journals.saveDraft(await bodyJson(req));
      sendJson(res, result.error ? 400 : 200, result.error ? { error: result.error } : result.value);
    } else if (req.method === "POST" && url.pathname === "/api/journals") {
      const result = await journals.create(await bodyJson(req));
      sendJson(res, result.error ? 400 : 201, result.error ? { error: result.error } : result.value);
    } else if (req.method === "PATCH" && /^\/api\/journals\/[^/]+$/.test(url.pathname)) {
      const input = await bodyJson(req);
      if (!safeText(input.content, 50000)) {
        sendJson(res, 400, { error: "日记内容不能为空" });
      } else {
        const result = await journals.update(url.pathname.split("/")[3], {
          ...input,
          title: hasOwn(input, "title") ? input.title : undefined,
          tags: legacyTags(input)
        });
        if (result.missing) sendJson(res, 404, { error: "这篇日记不存在" });
        else if (result.error) sendJson(res, 400, { error: result.error });
        else sendJson(res, 200, result.value);
      }
    } else if (req.method === "DELETE" && /^\/api\/journals\/[^/]+$/.test(url.pathname)) {
      await sendTrashResult(res, await removeJournal(url.pathname.split("/")[3]), "这篇日记不存在");
    } else if (req.method === "DELETE" && /^\/api\/journals\/[^/]+\/reflections\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      await sendTrashResult(res, await removeReflection(parts[3], parts[5]), "这条日记回望不存在");
    } else if (req.method === "POST" && url.pathname === "/api/journals/assist") {
      const input = await bodyJson(req);
      if (!["lead", "structure", "topic"].includes(input.mode)) {
        sendJson(res, 400, { error: "日记辅助类型无效" });
      } else {
        await respondModel(req, res, {
          run: onDelta => workflows.assist(input, { binding: requestBinding(input), onDelta })
        });
      }
    } else if (req.method === "POST" && /^\/api\/journals\/[^/]+\/reflect$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      if (!await journals.get(id)) {
        sendJson(res, 404, { error: "这篇日记不存在" });
      } else {
        await respondModel(req, res, {
          status: 201,
          run: onDelta => workflows.reflect({ id, onDelta })
        });
      }
    } else return false;
    return true;
  }

  return { handle, handleV1 };
}
