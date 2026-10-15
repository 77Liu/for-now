import { safeText, recordVersion } from "../shared/validation/index.mjs";
import { cleanupTemporaryFiles } from "../shared/attachments/index.mjs";
import { userPrompt } from "../modules/ai/index.mjs";
import {
  stripThoughtAnswerLead,
  thoughtDraftInput,
  thoughtPromptSystem,
  thoughtStarterPrompt
} from "../modules/thoughts/index.mjs";
import {
  compactPersonalContextReceipt,
  personalContextProjection,
  personalContextReceiptMatches,
  personalContextReceiptFingerprint,
  thoughtPromptContext
} from "./personal-context.mjs";
import { compileWorkingContextPrompt } from "./prompt-context.mjs";
import { assertCoreModelReady } from "../shared/core-model-gate.mjs";
import { answerCitationSources, prepareReferenceRequest, verifyReferenceAnswer } from "./answer-citations.mjs";
import {
  coreUserModelProjection,
  userModelRequiresCoreReady
} from "./user-model.mjs";
import {
  thoughtTaskCurrentMaterial,
  workingContextProjection,
  workingContextReceiptFingerprint,
  workingContextReceiptMatches
} from "./task-context.mjs";

const failure = (message, code, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

export function createThoughtWorkflows({
  repository,
  thoughts,
  backgroundAi,
  removeChain,
  removeBlock,
  generate,
  hash,
  publicTask,
  getAccountId = () => "local",
  coreModelReadiness = () => ({ ready: true }),
  getRecentTrend = () => null,
  getImportanceModelSnapshot = () => null,
  materializeAttachmentFiles = async () => [],
  contextKey,
  now = () => new Date().toISOString()
}) {
  const activeAnswers = new Map();
  const escapedPromptJson = value => JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const coreUserModelContext = model => {
    if (!model) return "";
    return `<core_user_model fingerprint="${model.fingerprint}">\n${escapedPromptJson(model)}\n</core_user_model>`;
  };
  const serializedContextSection = (name, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    return `<${name}>\n${escapedPromptJson(value)}\n</${name}>`;
  };
  const personalizedContextText = (coreUserModel, trend, dynamicContext) => [
    coreUserModelContext(coreUserModel),
    serializedContextSection("historical_user_supplement", trend?.historicalUserSupplement),
    serializedContextSection("seven_day_trend", trend?.payload),
    String(dynamicContext || "")
  ].filter(Boolean).join("\n\n");
  const trendFingerprint = trend => String(trend?.fingerprint || "");
  const currentCoreModel = store => {
    return coreUserModelProjection(store);
  };
  const assertContextCurrent = (store, modelFingerprint, receipt = null) => {
    const currentModel = coreUserModelProjection(store);
    if ((currentModel?.fingerprint || "") !== modelFingerprint
      || (receipt && !personalContextReceiptMatches(store, receipt))) {
      throw failure("个人语境已变化，本次结果未提供", "STALE_PERSONAL_CONTEXT", 409);
    }
  };
  const assertThoughtModelReady = store => {
    if (userModelRequiresCoreReady(store)) assertCoreModelReady(coreModelReadiness(store));
  };
  const replayBufferedDeltas = (onDelta, deltas) => {
    if (!onDelta) return;
    for (const event of deltas) onDelta(event);
  };
  const replayVerifiedAnswerDeltas = (listeners, deltas, content) => {
    const contentCount = deltas.filter(event => event.type === "content").length;
    const chunkCount = Math.min(content.length, Math.max(1, contentCount));
    const chunkSize = Math.ceil(content.length / chunkCount);
    const chunks = [];
    for (let start = 0; start < content.length; start += chunkSize) {
      chunks.push(content.slice(start, start + chunkSize));
    }
    let nextContent = 0;
    for (const event of deltas) {
      if (event.type === "reasoning") {
        for (const listener of listeners) listener(event);
      } else if (event.type === "content") {
        const delta = chunks[nextContent++];
        if (delta) {
          for (const listener of listeners) listener({ type: "content", delta });
        }
      }
    }
    while (nextContent < chunks.length) {
      const delta = chunks[nextContent++];
      for (const listener of listeners) listener({ type: "content", delta });
    }
  };
  const answerContextOptions = (store, root, generatedAt = now()) => {
    const coreUserModel = currentCoreModel(store);
    const recentTrend = getRecentTrend(store, generatedAt);
    return {
      accountId: getAccountId(),
      scene: "thoughtAnswer",
      importanceChoice: getImportanceModelSnapshot(),
      generatedAt,
      coreUserModel,
      recentTrend,
      task: {
        kind: "thoughtAnswer",
        text: root.content || "请结合当前图片回答。",
        targetId: root.id,
        subtargetId: ""
      },
      currentMaterial: thoughtTaskCurrentMaterial(store, root, {
        accountId: getAccountId()
      }),
      compilePrompt: sections => compileWorkingContextPrompt({
        ...sections,
        scene: "thoughtAnswer",
        coreUserModel,
        historicalUserSupplement: recentTrend?.historicalUserSupplement || null,
        recentTrend: recentTrend?.payload || null,
          referenceEvidence: recentTrend?.citationSources || []
      })
    };
  };
  const saveForegroundAnswer = (store, {
    id,
    clientRequestId,
    requestHash,
    sourceVersion,
    result,
    contextReceipt
  }) => {
    const contextFingerprint = workingContextReceiptFingerprint(contextReceipt);
    if (!contextFingerprint) {
      throw failure("本次回答缺少可验证的上下文凭据", "INVALID_CONTEXT_RECEIPT", 500);
    }
    const sourceTaskId = `foreground:${hash(JSON.stringify({
      kind: "thoughtAnswer",
      id,
      clientRequestId,
      requestHash,
      contextFingerprint
    })).slice(0, 64)}`;
    const saved = thoughts.saveGeneratedAnswerInStore(store, {
      id,
      clientRequestId,
      sourceVersion,
      sourceTaskId,
      content: stripThoughtAnswerLead(result.content),
      reasoningContent: result.reasoningContent,
      contextReceipt: { ...compactPersonalContextReceipt(contextReceipt),
        ...(result.referenceReceipt ? { referenceRequest: structuredClone(result.referenceReceipt) } : {}) }
    });
    if (!saved.value || saved.duplicate) return saved;
    saved.value.citations = structuredClone(result.citations || []);
    saved.value.citationStatus = result.citationStatus || "none";
    saved.value.providedReferences = structuredClone(result.providedReferences || []);
    saved.value.rejectedReferences = structuredClone(result.rejectedReferences || []);
    const completedAt = now();
    store.aiTasks.unshift({
      id: sourceTaskId,
      kind: "thoughtAnswer",
      resourceType: "thought",
      targetId: id,
      subtargetId: "",
      inputVersion: sourceVersion,
      subtargetVersion: 0,
      inputHash: requestHash,
      payload: {},
      clientRequestId,
      requestHash,
      status: "succeeded",
      createdAt: contextReceipt.generatedAt,
      startedAt: contextReceipt.generatedAt,
      completedAt,
      updatedAt: completedAt,
      attempt: 1,
      resultId: saved.value.id,
      contextFingerprint,
      internal: true
    });
    return saved;
  };
  const thoughtIntentHash = task => hash(JSON.stringify({
    kind: task.kind,
    targetId: task.targetId || "",
    payload: task.payload || {}
  }));
  const queueColdTask = async (kind, targetId, payload, clientRequestId) => {
    const store = await repository.read();
    if (!userModelRequiresCoreReady(store)) return null;
    return backgroundAi.enqueue({
      kind,
      targetId,
      payload,
      clientRequestId
    });
  };
  const personalizedTaskHandler = {
    inspectIntent(_store, task) {
      if (!task || !["thoughtDraft", "thoughtPrompt"].includes(task.kind)) return false;
      return {
        inputVersion: Math.max(0, Number(task.payload?.binding?.inputVersion) || 0),
        subtargetVersion: 0,
        inputHash: thoughtIntentHash(task)
      };
    },
    prepare(store, task) {
      if (task.kind === "thoughtDraft") {
        const payload = task.payload;
        const coreUserModel = currentCoreModel(store);
        const generatedAt = task.contextGeneratedAt || task.createdAt || now();
        const recentTrend = getRecentTrend(store, generatedAt);
        const personalContext = personalContextProjection(store);
        const context = personalizedContextText(coreUserModel, recentTrend, personalContext.prompt);
        return {
          kind: task.kind,
          inputVersion: Math.max(0, Number(payload.binding?.inputVersion) || 0),
          subtargetVersion: 0,
          inputHash: thoughtIntentHash(task),
          prompt: userPrompt({
            context,
            ...thoughtDraftInput(payload.question, payload.idea)
          }),
          contextFingerprint: hash(JSON.stringify({
            coreUserModelFingerprint: coreUserModel?.fingerprint || "",
            recentTrendFingerprint: trendFingerprint(recentTrend),
            receipt: personalContextReceiptFingerprint(personalContext.receipt),
            prompt: context
          })),
          scene: "thoughtDraft",
          maxTokens: 16000,
          taskOutput: {
            requestId: payload.binding?.requestId || task.clientRequestId,
            targetId: payload.binding?.targetId || task.targetId || "",
            inputVersion: Math.max(0, Number(payload.binding?.inputVersion) || 0)
          }
        };
      }
      if (task.kind === "thoughtPrompt") {
        const payload = task.payload;
        const coreUserModel = currentCoreModel(store);
        const generatedAt = task.contextGeneratedAt || task.createdAt || now();
        const recentTrend = getRecentTrend(store, generatedAt);
        const context = thoughtPromptContext(store, payload.occurredOn);
        const contextText = personalizedContextText(coreUserModel, recentTrend, context.text);
        return {
          kind: task.kind,
          inputVersion: Math.max(0, Number(payload.binding?.inputVersion) || 0),
          subtargetVersion: 0,
          inputHash: thoughtIntentHash(task),
          prompt: thoughtStarterPrompt(payload.occurredOn, { ...context, text: contextText }),
          contextFingerprint: hash(JSON.stringify({
            coreUserModelFingerprint: coreUserModel?.fingerprint || "",
            thoughtContextFingerprint: context.contextFingerprint,
            recentTrendFingerprint: trendFingerprint(recentTrend)
          })),
          scene: "thoughtPrompt",
          systemPrompt: thoughtPromptSystem(),
          maxTokens: 400,
          taskOutput: {
            hasHistory: context.hasHistory,
            requestId: payload.binding?.requestId || task.clientRequestId,
            targetId: payload.binding?.targetId || task.targetId || "",
            inputVersion: Math.max(0, Number(payload.binding?.inputVersion) || 0)
          }
        };
      }
      return null;
    },
    save(_store, work, task, result) {
      if (task.kind === "thoughtDraft") {
        task.output = {
          ...work.taskOutput,
          draft: stripThoughtAnswerLead(result.content),
          reasoningContent: result.reasoningContent || ""
        };
      } else {
        task.output = {
          ...work.taskOutput,
          prompt: safeText(result.content, 160).replace(/\s+/g, " ")
        };
      }
      return task.id;
    },
    result(_store, task) {
      return task.output || null;
    }
  };

  return {
    personalizedTaskHandler,
    async queueDraftIfCold({ question, idea, requestId, targetId, inputVersion }) {
      return queueColdTask("thoughtDraft", targetId || requestId, {
        question,
        idea,
        binding: { requestId, targetId, inputVersion }
      }, requestId);
    },
    async queueStarterIfCold({ eventTime, binding = {}, requestId }) {
      const clientRequestId = requestId || binding.requestId;
      return queueColdTask("thoughtPrompt", binding.targetId || clientRequestId, {
        occurredOn: eventTime.occurredOn,
        binding: {
          requestId: clientRequestId,
          targetId: binding.targetId || "",
          inputVersion: Math.max(0, Number(binding.inputVersion) || 0)
        }
      }, clientRequestId);
    },
    async queueAnswerIfCold({ id, clientRequestId }) {
      const store = await repository.read();
      if (!userModelRequiresCoreReady(store, "thoughtAnswer")) return null;
      return backgroundAi.enqueue({
        kind: "thoughtAnswer",
        targetId: id,
        clientRequestId
      });
    },
    async createChain(input) {
      const requestHash = hash(JSON.stringify({
        question: input.questionText,
        idea: input.idea,
        answer: input.answer,
        modelDraft: input.modelDraft,
        occurredAt: input.eventTimeHash,
        tags: input.tags,
        attachmentPaths: input.attachmentPaths,
        sourceRef: input.sourceRef,
        generateAnswer: input.generateAnswer
      }));
      const createInStore = store => {
        const result = thoughts.createChainInStore(store, { ...input, requestHash });
        if (result.conflict) return result;
        if (result.duplicate) {
          return {
            ...result,
            task: store.aiTasks.find(item => item.clientRequestId === `${input.clientRequestId}:answer`) || null
          };
        }
        const taskResult = input.generateAnswer
          ? backgroundAi.createInStore(store, {
              kind: "thoughtAnswer",
              targetId: result.items[0].id,
              inputVersion: result.items[0].version,
              clientRequestId: `${input.clientRequestId || result.items[0].id}:answer`
            })
          : null;
        return { ...result, task: taskResult?.task || null };
      };
      const created = input.clientRequestId && typeof repository.executeIdempotent === "function"
        ? await repository.executeIdempotent(
            { scope: "thoughtChains.create", key: input.clientRequestId, requestHash },
            createInStore,
            { onReplay: result => ({ ...result, duplicate: true }) }
          )
        : await repository.update(store => createInStore(store));
      if (!created.duplicate && created.task) backgroundAi.schedule(created.task.id);
      return { ...created, task: created.task ? publicTask(created.task) : null };
    },

    updateChain(input) {
      return repository.update(store => thoughts.updateChainInStore(store, {
        ...input,
        removeBlock
      }));
    },

    removeChain(id, expectedVersion = null) {
      return repository.update(store => {
        const root = store.thoughts.find(item => item.id === id && item.type === "question");
        if (!root) return removeChain(store, id);
        const currentVersion = recordVersion(root.version);
        if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
          return { versionConflict: true, currentVersion };
        }
        return removeChain(store, id);
      });
    },

    getChain: id => thoughts.getChain(id),
    listChains: options => thoughts.listChains(options),

    async createDraft({ question, idea, requestId, targetId, inputVersion, onDelta }) {
      const store = await repository.read();
      assertThoughtModelReady(store);
      const coreUserModel = currentCoreModel(store);
      const generatedAt = now();
      const recentTrend = getRecentTrend(store, generatedAt);
      const personalContext = personalContextProjection(store);
      const context = personalizedContextText(coreUserModel, recentTrend, personalContext.prompt);
      const deltas = [];
      const result = await generate(userPrompt({
        context,
        ...thoughtDraftInput(question, idea)
      }), {
        scene: "thoughtDraft",
        captureReasoning: true,
        onDelta: onDelta ? event => deltas.push(event) : null
      });
      const latestStore = await repository.read();
      assertContextCurrent(latestStore, coreUserModel?.fingerprint || "", personalContext.receipt);
      if (trendFingerprint(getRecentTrend(latestStore, generatedAt)) !== trendFingerprint(recentTrend)) {
        throw failure("个人趋势已变化，本次结果未提供", "STALE_PERSONAL_CONTEXT", 409);
      }
      replayBufferedDeltas(onDelta, deltas);
      return {
        requestId,
        targetId,
        inputVersion,
        draft: stripThoughtAnswerLead(result.content),
        reasoningContent: result.reasoningContent
      };
    },

    async createStarter({ eventTime, binding, onDelta }) {
      const store = await repository.read();
      assertThoughtModelReady(store);
      const coreUserModel = currentCoreModel(store);
      const generatedAt = now();
      const recentTrend = getRecentTrend(store, generatedAt);
      const context = thoughtPromptContext(store, eventTime.occurredOn);
      const contextText = personalizedContextText(coreUserModel, recentTrend, context.text);
      const deltas = [];
      const result = await generate(thoughtStarterPrompt(eventTime.occurredOn, {
        ...context,
        text: contextText
      }), {
        scene: "thoughtPrompt",
        systemPrompt: thoughtPromptSystem(),
        maxTokens: 400,
        retryWithoutThinking: true,
        timeoutMs: 30000,
        captureReasoning: true,
        onDelta: onDelta ? event => deltas.push(event) : null
      });
      const latestStore = await repository.read();
      assertContextCurrent(latestStore, coreUserModel?.fingerprint || "");
      const latestContext = thoughtPromptContext(latestStore, eventTime.occurredOn);
      if (latestContext.contextFingerprint !== context.contextFingerprint
        || trendFingerprint(getRecentTrend(latestStore, generatedAt)) !== trendFingerprint(recentTrend)) {
        throw failure("个人语境已变化，本次结果未提供", "STALE_PERSONAL_CONTEXT", 409);
      }
      replayBufferedDeltas(onDelta, deltas);
      return {
        prompt: safeText(result.content, 160).replace(/\s+/g, " "),
        hasHistory: context.hasHistory,
        ...binding
      };
    },

    async answerRoot({ id, clientRequestId, onDelta }) {
      const requestHash = hash(JSON.stringify({ id }));
      const key = `${contextKey()}:thoughtAnswer:${clientRequestId}`;
      let entry = activeAnswers.get(key);
      if (entry && entry.requestHash !== requestHash) {
        throw failure("同一请求标识不能用于不同内容", "IDEMPOTENCY_KEY_REUSED", 409);
      }
      if (!entry) {
        entry = { requestHash, listeners: new Set() };
        entry.promise = Promise.resolve().then(async () => {
          const ledgerRequest = {
            scope: "thoughtAnswers.create",
            key: clientRequestId,
            requestHash
          };
          if (typeof repository.readIdempotent === "function") {
            const persisted = await repository.readIdempotent(ledgerRequest);
            if (persisted !== undefined) return persisted.value || persisted;
          }
          const generateAndSave = async (store, save) => {
            assertThoughtModelReady(store);
            const duplicate = store.thoughts.find(item => item.type === "answer" && item.clientRequestId === clientRequestId);
            if (duplicate) {
              if (duplicate.relatedTo !== id) {
                throw failure("同一请求标识不能用于不同内容", "IDEMPOTENCY_KEY_REUSED", 409);
              }
              return duplicate;
            }
            const question = store.thoughts.find(item => item.id === id && item.type === "question");
            if (!question) throw failure("问题不存在", "THOUGHT_NOT_FOUND", 404);
            const sourceVersion = recordVersion(question.version);
            const contextOptions = answerContextOptions(store, question);
            const workingContext = workingContextProjection(
              store,
              { ...contextOptions, selectionSeed: hash(JSON.stringify([clientRequestId, contextOptions.coreUserModel])) }
            );
            const imagePaths = workingContext.attachmentPaths.length
              ? await materializeAttachmentFiles(workingContext.attachmentPaths)
              : [];
            const assertWorkingContextCurrent = async () => {
              const current = await repository.read();
              const currentQuestion = current.thoughts.find(item => item.id === id && item.type === "question");
              const currentContextOptions = currentQuestion
                ? answerContextOptions(current, currentQuestion, workingContext.receipt.generatedAt)
                : null;
              if (!currentQuestion || trendFingerprint(currentContextOptions.recentTrend)
                  !== trendFingerprint(contextOptions.recentTrend)
                || !workingContextReceiptMatches(
                current,
                workingContext.receipt,
                currentContextOptions
              )) {
                throw failure("个人语境已变化，本次回答未提供", "STALE_PERSONAL_CONTEXT", 409);
              }
            };
            let result;
            const bufferedDeltas = [];
            try {
              await assertWorkingContextCurrent();
              const referenceRequest = prepareReferenceRequest(workingContext.prompt,
                answerCitationSources(contextOptions.coreUserModel, [
                  ...(workingContext.citationSources || []),
                  ...(contextOptions.recentTrend?.historicalUserSupplementCitationSources || []),
                  ...(contextOptions.recentTrend?.citationSources || [])
                ]), JSON.stringify([getAccountId(), workingContext.receipt]), workingContext.receipt);
              const generated = await generate(referenceRequest.prompt, {
                scene: "thoughtAnswer",
                json: true,
                captureReasoning: true,
                contextReceipt: { ...workingContext.receipt, referenceRequest: referenceRequest.receipt },
                imagePaths,
                onDelta: event => bufferedDeltas.push(event)
              });
              result = verifyReferenceAnswer(generated.content, referenceRequest);
              result.reasoningContent = generated.reasoningContent || "";
            } finally {
              await cleanupTemporaryFiles(imagePaths);
            }
            await assertWorkingContextCurrent();
            const saved = await save({
              sourceVersion,
              result,
              contextReceipt: workingContext.receipt,
              recentTrendFingerprint: trendFingerprint(contextOptions.recentTrend)
            });
            if (saved.stale) {
              throw failure("问题已被修改或删除，本次回答未写入", "STALE_AI_RESULT", 409);
            }
            if (!saved.duplicate && saved.value) {
              replayVerifiedAnswerDeltas(entry.listeners, bufferedDeltas, saved.value.content);
            }
            return saved.value;
          };
          if (typeof repository.executeIdempotent === "function") {
            const store = await repository.read();
            return generateAndSave(store, ({ sourceVersion, result, contextReceipt, recentTrendFingerprint }) => repository.executeIdempotent(
              ledgerRequest,
              current => {
                const currentQuestion = current.thoughts.find(item => item.id === id && item.type === "question");
                const currentContextOptions = currentQuestion
                  ? answerContextOptions(current, currentQuestion, contextReceipt.generatedAt)
                  : null;
                if (!currentQuestion || trendFingerprint(currentContextOptions.recentTrend)
                    !== recentTrendFingerprint
                  || !workingContextReceiptMatches(
                  current,
                  contextReceipt,
                  currentContextOptions
                )) {
                  throw failure("个人语境已变化，本次回答未写入", "STALE_PERSONAL_CONTEXT", 409);
                }
                const saved = saveForegroundAnswer(current, {
                  id,
                  clientRequestId,
                  requestHash,
                  sourceVersion,
                  result,
                  contextReceipt
                });
                if (saved.stale) {
                  throw failure("问题已被修改或删除，本次回答未写入", "STALE_AI_RESULT", 409);
                }
                return saved;
              }
            ));
          }
          const store = await repository.read();
          return generateAndSave(store, ({ sourceVersion, result, contextReceipt, recentTrendFingerprint }) => repository.update(current => {
            const currentQuestion = current.thoughts.find(item => item.id === id && item.type === "question");
            const currentContextOptions = currentQuestion
              ? answerContextOptions(current, currentQuestion, contextReceipt.generatedAt)
              : null;
            if (!currentQuestion || trendFingerprint(currentContextOptions.recentTrend)
                !== recentTrendFingerprint
              || !workingContextReceiptMatches(
              current,
              contextReceipt,
              currentContextOptions
            )) {
              throw failure("个人语境已变化，本次回答未写入", "STALE_PERSONAL_CONTEXT", 409);
            }
            const saved = saveForegroundAnswer(current, {
              id,
              clientRequestId,
              requestHash,
              sourceVersion,
              result,
              contextReceipt
            });
            if (saved.stale) {
              throw failure("问题已被修改或删除，本次回答未写入", "STALE_AI_RESULT", 409);
            }
            return saved;
          }));
        });
        activeAnswers.set(key, entry);
        entry.promise.finally(() => {
          if (activeAnswers.get(key) === entry) activeAnswers.delete(key);
        }).catch(() => {});
      }
      if (onDelta) entry.listeners.add(onDelta);
      try {
        return await entry.promise;
      } finally {
        if (onDelta) entry.listeners.delete(onDelta);
      }
    }
  };
}
