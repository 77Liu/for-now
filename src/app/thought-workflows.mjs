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
  thoughtPromptContext,
  userAnswerContext
} from "./personal-context.mjs";
import { compileWorkingContextPrompt } from "./prompt-context.mjs";
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
  materializeAttachmentFiles = async () => [],
  contextKey,
  now = () => new Date().toISOString()
}) {
  const activeAnswers = new Map();
  const answerContextOptions = (store, root) => ({
    accountId: getAccountId(),
    scene: "thoughtAnswer",
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
      scene: "thoughtAnswer"
    })
  });
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
      contextReceipt: compactPersonalContextReceipt(contextReceipt)
    });
    if (!saved.value || saved.duplicate) return saved;
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

  return {
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
      const result = await generate(userPrompt({
        context: userAnswerContext(store),
        ...thoughtDraftInput(question, idea)
      }), { scene: "thoughtDraft", captureReasoning: true, onDelta });
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
      const context = thoughtPromptContext(store, eventTime.occurredOn);
      const result = await generate(thoughtStarterPrompt(eventTime.occurredOn, context), {
        scene: "thoughtPrompt",
        systemPrompt: thoughtPromptSystem(),
        maxTokens: 400,
        retryWithoutThinking: true,
        timeoutMs: 30000,
        captureReasoning: true,
        onDelta
      });
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
            const workingContext = workingContextProjection(
              store,
              answerContextOptions(store, question)
            );
            const imagePaths = workingContext.attachmentPaths.length
              ? await materializeAttachmentFiles(workingContext.attachmentPaths)
              : [];
            let result;
            try {
              result = await generate(workingContext.prompt, {
                scene: "thoughtAnswer",
                captureReasoning: true,
                contextReceipt: workingContext.receipt,
                imagePaths,
                onDelta: event => {
                  for (const listener of entry.listeners) listener(event);
                }
              });
            } finally {
              await cleanupTemporaryFiles(imagePaths);
            }
            const saved = await save({ sourceVersion, result, contextReceipt: workingContext.receipt });
            if (saved.stale) {
              throw failure("问题已被修改或删除，本次回答未写入", "STALE_AI_RESULT", 409);
            }
            return saved.value;
          };
          if (typeof repository.executeIdempotent === "function") {
            const store = await repository.read();
            return generateAndSave(store, ({ sourceVersion, result, contextReceipt }) => repository.executeIdempotent(
              ledgerRequest,
              current => {
                const currentQuestion = current.thoughts.find(item => item.id === id && item.type === "question");
                if (!currentQuestion || !workingContextReceiptMatches(
                  current,
                  contextReceipt,
                  answerContextOptions(current, currentQuestion)
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
          return generateAndSave(store, ({ sourceVersion, result, contextReceipt }) => repository.update(current => {
            const currentQuestion = current.thoughts.find(item => item.id === id && item.type === "question");
            if (!currentQuestion || !workingContextReceiptMatches(
              current,
              contextReceipt,
              answerContextOptions(current, currentQuestion)
            )) {
              throw failure("个人语境已变化，本次回答未写入", "STALE_PERSONAL_CONTEXT", 409);
            }
            return saveForegroundAnswer(current, {
              id,
              clientRequestId,
              requestHash,
              sourceVersion,
              result,
              contextReceipt
            });
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
