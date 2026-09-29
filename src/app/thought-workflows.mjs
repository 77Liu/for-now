import { safeText, recordVersion } from "../shared/validation/index.mjs";
import { userPrompt } from "../modules/ai/index.mjs";
import {
  stripThoughtAnswerLead,
  thoughtDraftInput,
  thoughtPromptSystem,
  thoughtStarterPrompt
} from "../modules/thoughts/index.mjs";
import { prepareThoughtAnswer, thoughtPromptContext, userAnswerContext } from "./personal-context.mjs";

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
  contextKey
}) {
  const activeAnswers = new Map();

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
            const result = await generate(prepareThoughtAnswer(store, question), {
              scene: "thoughtAnswer",
              captureReasoning: true,
              onDelta: event => {
                for (const listener of entry.listeners) listener(event);
              }
            });
            const saved = await save({ sourceVersion, result });
            if (saved.stale) {
              throw failure("问题已被修改或删除，本次回答未写入", "STALE_AI_RESULT", 409);
            }
            return saved.value;
          };
          if (typeof repository.executeIdempotent === "function") {
            const store = await repository.read();
            return generateAndSave(store, ({ sourceVersion, result }) => repository.executeIdempotent(
              ledgerRequest,
              current => {
                const saved = thoughts.saveGeneratedAnswerInStore(current, {
                  id,
                  clientRequestId,
                  sourceVersion,
                  content: stripThoughtAnswerLead(result.content),
                  reasoningContent: result.reasoningContent
                });
                if (saved.stale) {
                  throw failure("问题已被修改或删除，本次回答未写入", "STALE_AI_RESULT", 409);
                }
                return saved;
              }
            ));
          }
          const store = await repository.read();
          return generateAndSave(store, ({ sourceVersion, result }) => repository.update(current => thoughts.saveGeneratedAnswerInStore(current, {
            id,
            clientRequestId,
            sourceVersion,
            content: stripThoughtAnswerLead(result.content),
            reasoningContent: result.reasoningContent
          })));
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
