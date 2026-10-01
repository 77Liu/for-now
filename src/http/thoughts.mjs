import { safeText } from "../shared/validation/index.mjs";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const optionalIdempotencyKey = req => {
  const key = String(req.headers?.["idempotency-key"] || "").trim();
  if (key.length > 100 || (key && !/^[A-Za-z0-9_.:-]+$/.test(key))) {
    throw Object.assign(new Error("Idempotency-Key 格式无效"), { statusCode: 400, code: "INVALID_IDEMPOTENCY_KEY" });
  }
  return key;
};

export function createThoughtHttp({
  service, workflows, removeBlock, removeNested, backgroundAi, sendTaskCreation,
  eventTimeFields, bodyJson, sendJson, sendTrashResult, respondModel, createId,
  prepareContentAttachments = async (_targetType, input) => ({ value: input }),
  automaticAnswer = async input => ({ generateAnswer: Boolean(input?.requested) && !input?.hasAnswer })
}) {
  const tags = input => (Array.isArray(input.tags) ? input.tags : []).map(value => safeText(value, 30)).filter(Boolean);
  const sourceReference = input => {
    if (input?.sourceRef == null) return { value: null };
    const id = safeText(input.sourceRef?.id, 100), version = Number(input.sourceRef?.version);
    if (input.sourceRef?.type !== "capture" || !id || !Number.isSafeInteger(version) || version < 1) {
      return { error: "来源念起格式无效" };
    }
    return { value: { type: "capture", id, version } };
  };
  const requestBinding = input => {
    const requestId = safeText(input?.requestId, 100), targetId = safeText(input?.targetId, 100);
    return requestId && targetId
      ? { requestId, targetId, inputVersion: Math.max(0, Math.round(Number(input.inputVersion) || 0)) }
      : {};
  };
  const eventTimeHash = (input, eventTime) => hasOwn(input, "occurredAt")
    ? eventTime.occurredAt
    : hasOwn(input, "occurredOn") ? `date:${input.occurredOn}` : "";

  async function handleV1(req, res, url, v1) {
    if (req.method === "GET" && url.pathname === "/api/v1/thought-chains") {
      const page = await workflows.listChains(v1.pagination(url));
      if (page.invalidCursor) return v1.error(res, 400, "游标无效或已过期", "INVALID_CURSOR");
      return v1.success(res, 200, page.items, { meta: { nextCursor: v1.nextCursor(page.nextId) } });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/thought-chains") {
      const input = await bodyJson(req);
      const prepared = await prepareContentAttachments("thoughtRoot", {
        content: input.question,
        attachmentPaths: input.attachmentPaths || []
      });
      if (prepared.forbidden) return v1.error(res, 403, prepared.error, prepared.code);
      if (prepared.error) return v1.error(res, 400, prepared.error, prepared.code || "VALIDATION_ERROR");
      const questionText = safeText(prepared.value.content);
      const eventTime = eventTimeFields(input);
      if (!eventTime) return v1.error(res, 400, "发生时间格式不正确", "VALIDATION_ERROR");
      const answer = safeText(input.answer);
      const sourceRef = sourceReference(input);
      if (sourceRef.error) return v1.error(res, 400, sourceRef.error, "VALIDATION_ERROR");
      const answerDecision = await automaticAnswer({ requested: input.generateAnswer === true && Boolean(questionText || prepared.value.attachmentPaths.length), hasAnswer: Boolean(answer) });
      const created = await workflows.createChain({
        questionText,
        eventTime,
        eventTimeHash: eventTimeHash(input, eventTime),
        tags: tags(input).slice(0, 8),
        clientRequestId: v1.idempotencyKey(req),
        generateAnswer: answerDecision.generateAnswer,
        attachmentPaths: prepared.value.attachmentPaths,
        idea: safeText(input.idea),
        answer,
        modelDraft: safeText(input.modelDraft),
        modelReasoning: safeText(input.modelReasoning, 50000),
        sourceRef: sourceRef.value
      });
      if (created.invalid) return v1.error(res, 400, created.error, "VALIDATION_ERROR");
      if (created.conflict) return v1.error(res, 409, "同一幂等键不能用于不同内容", "IDEMPOTENCY_KEY_REUSED");
      if (created.sourceMissing) return v1.error(res, 404, "来源念起不存在或已删除", "CAPTURE_SOURCE_NOT_FOUND");
      if (created.sourceVersionConflict) return v1.error(res, 412, "来源念起已变化，请重新打开后再提交", "PRECONDITION_FAILED", { currentVersion: created.currentVersion });
      if (created.sourceConflict) return v1.error(res, 409, "这条念起已经展开为思考", "CAPTURE_ALREADY_PROMOTED", { rootId: created.rootId });
      const root = created.items.find(item => item.type === "question");
      return v1.success(res, created.duplicate ? 200 : 201, created, { etag: v1.versionEtag(root?.version) });
    }
    if (req.method === "GET" && /^\/api\/v1\/thought-chains\/[^/]+$/.test(url.pathname)) {
      const chain = await workflows.getChain(url.pathname.split("/")[4]);
      return chain
        ? v1.success(res, 200, chain, { etag: v1.versionEtag(chain.version) })
        : v1.error(res, 404, "这套思考不存在", "THOUGHT_NOT_FOUND");
    }
    if (req.method === "PATCH" && /^\/api\/v1\/thought-chains\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/")[4], input = await bodyJson(req), current = await workflows.getChain(id);
      if (!current) return v1.error(res, 404, "这套思考不存在", "THOUGHT_NOT_FOUND");
      if (hasOwn(input, "sourceRef")) {
        const sourceRef = sourceReference(input);
        if (sourceRef.error) return v1.error(res, 400, sourceRef.error, "VALIDATION_ERROR");
        const existing = current.sourceRef || null, requested = sourceRef.value;
        if (existing?.type !== requested?.type || existing?.id !== requested?.id || Number(existing?.version) !== Number(requested?.version)) {
          return v1.error(res, 409, "思考的来源念起不可修改", "THOUGHT_SOURCE_IMMUTABLE");
        }
      }
      const prepared = await prepareContentAttachments("thoughtRoot", {
        content: hasOwn(input, "question") ? input.question : current.content,
        attachmentPaths: hasOwn(input, "attachmentPaths") ? input.attachmentPaths : current.attachmentPaths || []
      });
      if (prepared.forbidden) return v1.error(res, 403, prepared.error, prepared.code);
      if (prepared.error) return v1.error(res, 400, prepared.error, prepared.code || "VALIDATION_ERROR");
      const questionText = safeText(prepared.value.content);
      const changesEventTime = hasOwn(input, "occurredAt") || hasOwn(input, "occurredOn");
      if (changesEventTime && !eventTimeFields(input)) return v1.error(res, 400, "日期时间格式不正确", "VALIDATION_ERROR");
      const updated = await workflows.updateChain({
        id,
        questionText,
        tags: tags(input).slice(0, 8),
        changesEventTime,
        eventTimeInput: input,
        idea: safeText(input.idea),
        answer: safeText(input.answer),
        hasIdea: hasOwn(input, "idea"),
        hasAnswer: hasOwn(input, "answer"),
        attachmentPaths: prepared.value.attachmentPaths,
        hasAttachmentPaths: true,
        expectedVersion: v1.expectedVersion(req)
      });
      if (updated?.blocksConflict) return v1.error(res, 409, "这套思考已有多个同类内容，请逐条编辑", "THOUGHT_BLOCKS_REQUIRE_INDIVIDUAL_EDIT");
      if (updated?.versionConflict) return v1.error(res, 412, "资源版本已变化，请重新读取后再提交", "PRECONDITION_FAILED", { currentVersion: updated.currentVersion });
      if (updated?.invalidTime) return v1.error(res, 400, "日期时间格式不正确", "VALIDATION_ERROR");
      if (updated?.invalid) return v1.error(res, 400, updated.error, "VALIDATION_ERROR");
      return updated.missing
        ? v1.error(res, 404, "这套思考不存在", "THOUGHT_NOT_FOUND")
        : v1.success(res, 200, updated.value, { etag: v1.versionEtag(updated.value.version) });
    }
    if (req.method === "DELETE" && /^\/api\/v1\/thought-chains\/[^/]+$/.test(url.pathname)) {
      const entry = await workflows.removeChain(url.pathname.split("/")[4], v1.expectedVersion(req));
      if (entry?.versionConflict) return v1.error(res, 412, "资源版本已变化，请重新读取后再提交", "PRECONDITION_FAILED", { currentVersion: entry.currentVersion });
      return entry
        ? v1.success(res, 200, { trashId: entry.id })
        : v1.error(res, 404, "这套思考不存在", "THOUGHT_NOT_FOUND");
    }
    if (req.method === "POST" && /^\/api\/v1\/thought-chains\/[^/]+\/answers$/.test(url.pathname)) {
      const id = url.pathname.split("/")[4], clientRequestId = v1.idempotencyKey(req);
      await respondModel(req, res, {
        status: 201,
        run: onDelta => workflows.answerRoot({ id, clientRequestId, onDelta }),
        formatResult: value => v1.envelope(value),
        formatError: error => ({ type: "error", ...v1.errorEnvelope(error) })
      });
      return true;
    }
    return false;
  }

  async function handle(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/thought-chains") {
      const input = await bodyJson(req), prepared = await prepareContentAttachments("thoughtRoot", {
        content: input.question,
        attachmentPaths: input.attachmentPaths || []
      });
      if (prepared.forbidden) return sendJson(res, 403, { error: prepared.error, code: prepared.code });
      if (prepared.error) return sendJson(res, 400, { error: prepared.error, code: prepared.code });
      const questionText = safeText(prepared.value.content);
      const eventTime = eventTimeFields(input);
      if (!eventTime) return sendJson(res, 400, { error: "发生时间格式不正确" });
      const answer = safeText(input.answer);
      const answerDecision = await automaticAnswer({ requested: input.generateAnswer === true && Boolean(questionText || prepared.value.attachmentPaths.length), hasAnswer: Boolean(answer) });
      const created = await workflows.createChain({
        questionText,
        eventTime,
        eventTimeHash: eventTimeHash(input, eventTime),
        tags: tags(input),
        clientRequestId: safeText(input.clientRequestId, 100),
        generateAnswer: answerDecision.generateAnswer,
        attachmentPaths: prepared.value.attachmentPaths,
        idea: safeText(input.idea),
        answer,
        modelDraft: safeText(input.modelDraft),
        modelReasoning: safeText(input.modelReasoning, 50000)
      });
      if (created.invalid) return sendJson(res, 400, { error: created.error });
      if (created.conflict) return sendJson(res, 409, { error: "同一请求标识不能用于不同内容", code: "IDEMPOTENCY_KEY_REUSED" });
      sendJson(res, created.duplicate ? 200 : 201, created);
    } else if (req.method === "DELETE" && /^\/api\/thought-chains\/[^/]+$/.test(url.pathname)) {
      await sendTrashResult(res, await workflows.removeChain(url.pathname.split("/")[3]), "这套思考不存在");
    } else if (req.method === "PATCH" && /^\/api\/thought-chains\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3], input = await bodyJson(req), current = await workflows.getChain(id);
      if (!current) return sendJson(res, 404, { error: "这套思考不存在" });
      const prepared = await prepareContentAttachments("thoughtRoot", {
        content: hasOwn(input, "question") ? input.question : current.content,
        attachmentPaths: hasOwn(input, "attachmentPaths") ? input.attachmentPaths : current.attachmentPaths || []
      });
      if (prepared.forbidden) return sendJson(res, 403, { error: prepared.error, code: prepared.code });
      if (prepared.error) return sendJson(res, 400, { error: prepared.error, code: prepared.code });
      const questionText = safeText(prepared.value.content);
      const changesEventTime = hasOwn(input, "occurredAt") || hasOwn(input, "occurredOn");
      if (changesEventTime && !eventTimeFields(input)) return sendJson(res, 400, { error: "日期时间格式不正确" });
      const updated = await workflows.updateChain({
        id,
        questionText,
        tags: tags(input).slice(0, 8),
        changesEventTime,
        eventTimeInput: input,
        idea: safeText(input.idea),
        answer: safeText(input.answer),
        hasIdea: hasOwn(input, "idea"),
        hasAnswer: hasOwn(input, "answer"),
        attachmentPaths: prepared.value.attachmentPaths,
        hasAttachmentPaths: true,
        expectedVersion: hasOwn(input, "expectedVersion") ? input.expectedVersion : null
      });
      if (updated?.blocksConflict) {
        sendJson(res, 409, { error: "这套思考已有多个同类内容，请逐条编辑，未做任何合并", code: "THOUGHT_BLOCKS_REQUIRE_INDIVIDUAL_EDIT" });
      } else if (updated?.versionConflict) {
        sendJson(res, 409, { error: "内容已在其他位置更新，请刷新后重试", code: "VERSION_CONFLICT", currentVersion: updated.currentVersion });
      } else if (updated?.invalidTime) {
        sendJson(res, 400, { error: "日期时间格式不正确" });
      } else if (updated?.invalid) {
        sendJson(res, 400, { error: updated.error });
      } else {
        sendJson(res, updated.missing ? 404 : 200, updated.missing ? { error: "这套思考不存在" } : updated.value);
      }
    } else if (req.method === "POST" && url.pathname === "/api/answer-drafts") {
      const input = await bodyJson(req), question = safeText(input.question), binding = requestBinding(input);
      if (!question) return sendJson(res, 400, { error: "请先填写问题" });
      const requestId = binding.requestId || safeText(input.requestId, 100) || createId();
      await respondModel(req, res, {
        run: onDelta => workflows.createDraft({
          question,
          idea: safeText(input.idea),
          requestId,
          targetId: binding.targetId || safeText(input.targetId, 100) || `legacy-draft:${requestId}`,
          inputVersion: Math.max(0, Math.round(Number(input.inputVersion) || 0)),
          onDelta
        })
      });
    } else if (req.method === "POST" && url.pathname === "/api/thought-prompts") {
      const input = await bodyJson(req), eventTime = eventTimeFields(input);
      if (!eventTime) return sendJson(res, 400, { error: "发生时间格式不正确" });
      await respondModel(req, res, {
        run: onDelta => workflows.createStarter({ eventTime, binding: requestBinding(input), onDelta })
      });
    } else if (req.method === "POST" && /^\/api\/thoughts\/[^/]+\/answer$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3], input = await bodyJson(req), clientRequestId = safeText(input.clientRequestId, 100);
      if (!clientRequestId) return sendJson(res, 400, { error: "回答请求缺少幂等标识", code: "IDEMPOTENCY_KEY_REQUIRED" });
      await respondModel(req, res, {
        status: 201,
        run: onDelta => workflows.answerRoot({ id, clientRequestId, onDelta })
      });
    } else if (req.method === "POST" && url.pathname === "/api/thoughts") {
      const input = await bodyJson(req), prepared = await prepareContentAttachments("thoughtBlock", input);
      if (prepared.forbidden) return sendJson(res, 403, { error: prepared.error, code: prepared.code });
      if (prepared.error) return sendJson(res, 400, { error: prepared.error, code: prepared.code });
      const content = safeText(prepared.value.content), eventTime = eventTimeFields(input);
      if (!eventTime) return sendJson(res, 400, { error: "发生时间格式不正确" });
      const created = await service.createBlock({
        content, eventTime,
        type: ["question", "idea", "answer", "record"].includes(input.type) ? input.type : "question",
        relatedTo: safeText(input.relatedTo, 80) || null,
        tags: tags(input).slice(0, 8),
        attachmentPaths: prepared.value.attachmentPaths,
        clientRequestId: optionalIdempotencyKey(req)
      });
      if (created.invalid) sendJson(res, 400, { error: created.error });
      else sendJson(res, created.missing ? 404 : 201, created.missing ? { error: "所属思绪不存在" } : created.value);
    } else if (req.method === "PATCH" && /^\/api\/thoughts\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3], input = await bodyJson(req), current = await service.getBlock(id);
      if (!current) return sendJson(res, 404, { error: "内容块不存在" });
      const prepared = await prepareContentAttachments("thoughtBlock", {
        content: hasOwn(input, "content") ? input.content : current.content,
        attachmentPaths: hasOwn(input, "attachmentPaths") ? input.attachmentPaths : current.attachmentPaths || []
      });
      if (prepared.forbidden) return sendJson(res, 403, { error: prepared.error, code: prepared.code });
      if (prepared.error) return sendJson(res, 400, { error: prepared.error, code: prepared.code });
      const content = safeText(prepared.value.content);
      const updated = await service.updateBlock({
        id, content, eventTimeInput: input,
        attachmentPaths: prepared.value.attachmentPaths,
        expectedVersion: hasOwn(input, "expectedVersion") ? input.expectedVersion : null
      });
      if (updated?.conflict) sendJson(res, 409, { error: "内容已在其他位置更新，请刷新后重试", code: "VERSION_CONFLICT", currentVersion: updated.currentVersion });
      else if (updated?.invalidTime) sendJson(res, 400, { error: "发生时间格式不正确" });
      else if (updated?.invalid) sendJson(res, 400, { error: updated.error });
      else sendJson(res, updated.missing ? 404 : 200, updated.missing ? { error: "内容块不存在" } : updated.value);
    } else if (req.method === "DELETE" && /^\/api\/thoughts\/[^/]+$/.test(url.pathname)) {
      await sendTrashResult(res, await removeBlock(url.pathname.split("/")[3]), "内容块不存在");
    } else if (req.method === "PATCH" && /^\/api\/thoughts\/[^/]+\/disposition$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3], input = await bodyJson(req);
      if (!["pending", "kept", "discarded"].includes(input.disposition)) return sendJson(res, 400, { error: "状态无效" });
      const updated = await service.setDisposition({ id, disposition: input.disposition });
      sendJson(res, updated.missing ? 404 : 200, updated.missing ? { error: "记录不存在" } : updated.value);
    } else if (req.method === "POST" && /^\/api\/thoughts\/[^/]+\/remarks$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3], text = safeText((await bodyJson(req)).text, 1000);
      if (!text) return sendJson(res, 400, { error: "备注不能为空" });
      const created = await service.addRemark({ id, text });
      sendJson(res, created.missing ? 404 : 201, created.missing ? { error: "记录不存在" } : created.value);
    } else if (req.method === "PATCH" && /^\/api\/thoughts\/[^/]+\/remarks\/[^/]+$/.test(url.pathname)) {
      const [, , , id, , remarkId] = url.pathname.split("/"), text = safeText((await bodyJson(req)).text, 1000);
      if (!text) return sendJson(res, 400, { error: "备注不能为空" });
      const updated = await service.updateRemark({ id, remarkId, text });
      sendJson(res, updated.missing ? 404 : 200, updated.missing ? { error: "备注不存在" } : updated.value);
    } else if (req.method === "DELETE" && /^\/api\/thoughts\/[^/]+\/remarks\/[^/]+$/.test(url.pathname)) {
      const [, , , id, , remarkId] = url.pathname.split("/");
      await sendTrashResult(res, await removeNested({
        parentCollection: "thoughts", parentId: id, field: "remarks", type: "thoughtRemark", id: remarkId
      }), "备注不存在");
    } else if (req.method === "POST" && /^\/api\/thoughts\/[^/]+\/follow-ups$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3], input = await bodyJson(req);
      const question = safeText(input.question, 6000), answer = safeText(input.answer, 20000);
      if (!question) return sendJson(res, 400, { error: "请先写下追问" });
      const created = await service.addFollowUp({ id, question, answer });
      sendJson(res, created.missing ? 404 : 201, created.missing ? { error: "问题不存在" } : created.value);
    } else if (req.method === "PATCH" && /^\/api\/thoughts\/[^/]+\/follow-ups\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split("/"), id = parts[3], followUpId = parts[5], input = await bodyJson(req);
      const hasQuestion = hasOwn(input, "question"), hasAnswer = hasOwn(input, "answer");
      const question = hasQuestion ? safeText(input.question, 6000) : null, answer = hasAnswer ? safeText(input.answer, 20000) : null;
      if (!hasQuestion && !hasAnswer) return sendJson(res, 400, { error: "没有需要更新的内容" });
      if (hasQuestion && !question) return sendJson(res, 400, { error: "追问问题不能为空" });
      const updated = await service.updateFollowUp({
        id, followUpId, hasQuestion, question, hasAnswer, answer,
        expectedVersion: hasOwn(input, "expectedVersion") ? input.expectedVersion : null
      });
      if (updated?.conflict) sendJson(res, 409, { error: "追问已在其他位置更新，请刷新后重试", code: "VERSION_CONFLICT" });
      else sendJson(res, updated.missing ? 404 : 200, updated.missing ? { error: "追问不存在" } : updated.value);
    } else if (req.method === "DELETE" && /^\/api\/thoughts\/[^/]+\/follow-ups\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split("/"), parentId = parts[3], id = parts[5];
      await sendTrashResult(res, await removeNested({
        parentCollection: "thoughts", parentId, field: "followUps", type: "thoughtFollowUp", id,
        annotationTargetKeys: [`followup-question:${id}`, `followup-answer:${id}`]
      }), "追问不存在");
    } else if (req.method === "POST" && /^\/api\/thoughts\/[^/]+\/follow-ups\/[^/]+\/answer$/.test(url.pathname)) {
      const parts = url.pathname.split("/"), input = await bodyJson(req);
      sendTaskCreation(res, await backgroundAi.enqueue({
        kind: "followUpAnswer", targetId: parts[3], subtargetId: parts[5],
        inputVersion: input.inputVersion, subtargetVersion: input.subtargetVersion,
        clientRequestId: input.clientRequestId
      }));
    } else return false;
    return true;
  }
  return { handle, handleV1 };
}
