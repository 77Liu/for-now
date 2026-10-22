/**
 * 前台思绪回答的幂等接纳事务。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：生成与上下文校验在事务外；仅接纳修订号绑定的纯业务保存。
 */
import type { RecordStore, SourceMutationEffects } from "../../shared/persistence/record-command-types.mjs";
import type { ThoughtServices, ThoughtResult } from "./record-contracts.mjs";
import { commitThoughtCommand, afterThoughtCommandCommit } from "./command-commit.mjs";

type Input = {
  id: string; clientRequestId: string; requestHash: string; expectedRevision: string;
};

/** 回答、内部任务、索引和幂等回执同事务落盘。 @since unreleased */
export function createForegroundAnswerCommand(services: ThoughtServices) {
  return async (input: Input, save: (store: RecordStore) => ThoughtResult) => {
    if (!input.clientRequestId || input.expectedRevision == null) {
      throw new TypeError("Foreground answer requires idempotency and a verified account revision");
    }
    let observation: Awaited<ReturnType<SourceMutationEffects["prepare"]>> | undefined;
    const timestamp = services.now?.() || new Date().toISOString();
    const committed = await services.unitOfWork.run({
      commandId: "thought.foregroundAnswer",
      expectedRevision: input.expectedRevision,
      idempotency: {
        scope: "thoughtAnswers.create", key: input.clientRequestId, requestHash: input.requestHash,
        expiresAt: new Date(new Date(timestamp).getTime() + 90 * 86400000).toISOString()
      }
    }, async ports => {
      const closure = await services.repository.readThoughtClosure(ports.objects, ports.relations, input.id);
      if (!closure) throw Object.assign(new Error("问题已删除，本次回答未写入"), {
        code: "STALE_AI_RESULT", statusCode: 409
      });
      const state = {
        rows: closure.rows,
        store: services.repository.rebuildRecordCollections(closure.rows, ["thoughts", "aiTasks", "notifications"])
      };
      const prepared = await services.effects?.prepare(ports, state);
      const result = save(state.store);
      if (result.stale) throw Object.assign(new Error("问题已修改，本次回答未写入"), {
        code: "STALE_AI_RESULT", statusCode: 409
      });
      if (!result.value) throw new Error("Foreground answer was not saved");
      if (!result.duplicate) {
        await commitThoughtCommand(ports, services.repository, state, input.id, { observation: prepared });
        observation = prepared;
      }
      return result;
    });
    afterThoughtCommandCommit(observation);
    return committed.replayed ? { ...committed.value, duplicate: true } : committed.value;
  };
}
