/**
 * 内容块、备注、追问和处置状态的账户内有界命令。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：只访问目标思绪闭包，业务记录、索引与 ChangeDraft 同事务提交。
 */
import type { AccountUnitOfWork, SourceMutationEffects } from "../../shared/persistence/record-command-types.mjs";
import { AFTER_COMMIT } from "../../shared/persistence/record-command-types.mjs";
import type { ThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import { commitThoughtCommand } from "./command-commit.mjs";
import type { LocalThoughtInput, LocalThoughtMutations } from "./local-mutations.mjs";

type Services = {
  unitOfWork: AccountUnitOfWork;
  repository: ThoughtRecordRepository;
  mutations: LocalThoughtMutations;
  effects?: SourceMutationEffects | null;
  now(): string;
};
const definitions = {
  createBlock: { commandId: "thought.block.create" },
  updateBlock: { commandId: "thought.block.update" },
  setDisposition: { commandId: "thought.disposition" },
  addRemark: { commandId: "thought.remark.create" },
  updateRemark: { commandId: "thought.remark.update" },
  addFollowUp: { commandId: "thought.followUp.create" },
  updateFollowUp: { commandId: "thought.followUp.update" }
} as const;
type Operation = keyof typeof definitions;

function idempotency(input: LocalThoughtInput, operation: Operation, now: string) {
  if (operation !== "createBlock" || !input.clientRequestId) return null;
  return {
    scope: `thoughtBlocks.create:${input.relatedTo || "root"}`,
    key: input.clientRequestId,
    requestHash: input.requestHash || "",
    expiresAt: new Date(new Date(now).getTime() + 90 * 86400000).toISOString()
  };
}

/** 将纯领域规则封装为公开 typed command，不以文档 updater 作为失败回退。 @since unreleased */
export function createThoughtLocalCommands({ unitOfWork, repository, mutations, effects, now }: Services) {
  const bind = (operation: Operation) => async (input: LocalThoughtInput) => {
    const definition = definitions[operation];
    let afterCommit: (() => void) | undefined;
    const committed = await unitOfWork.run({
      commandId: definition.commandId,
      idempotency: idempotency(input, operation, now())
    }, async ports => {
      const id = operation === "createBlock" ? input.relatedTo : input.id;
      const closure = id ? await repository.readThoughtTargetClosure(ports, id, {
        forDeletion: operation === "updateBlock" && input.attachmentPaths !== undefined
      }) : null;
      if (id && !closure) return { missing: true };
      const state = {
        store: closure?.store || { thoughts: [] },
        rows: closure?.rows || []
      };
      const observation = await effects?.prepare(ports, state);
      const { store } = state;
      const result = mutations[operation](store, input);
      if (!result.value || result.duplicate) return result;
      const rootId = closure ? JSON.parse(closure.rootKey)[1] : result.value.id;
      const rows = await commitThoughtCommand(ports, repository, state, rootId, { observation });
      const persisted = rows.find(row => row.id === result.value!.id);
      if (persisted) result.value.version = persisted.version;
      afterCommit = observation?.afterCommit;
      return result;
    });
    afterCommit?.();
    committed.value[AFTER_COMMIT]?.();
    return committed.replayed ? { ...committed.value, duplicate: true } : committed.value;
  };
  return {
    createBlock: bind("createBlock"),
    updateBlock: bind("updateBlock"),
    setDisposition: bind("setDisposition"),
    addRemark: bind("addRemark"),
    updateRemark: bind("updateRemark"),
    addFollowUp: bind("addFollowUp"),
    updateFollowUp: bind("updateFollowUp")
  };
}
export type ThoughtLocalCommands = ReturnType<typeof createThoughtLocalCommands>;
