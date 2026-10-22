/**
 * 思绪批注、回复、标记转换和删除的公开有界命令。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：批注规则由 annotations 服务提供；思绪负责聚合版本与同步变化。
 */
import type {
  AccountUnitOfWork, RecordEntity, RecordStore, SourceMutationEffects
} from "../../shared/persistence/record-command-types.mjs";
import { AFTER_COMMIT } from "../../shared/persistence/record-command-types.mjs";
import type { ThoughtRecordRepository } from "../../shared/persistence/thought-record-repository.mjs";
import type { TrashEntry } from "./record-contracts.mjs";
import { commitThoughtCommand } from "./command-commit.mjs";

type Result = { value?: RecordEntity; missing?: boolean; invalid?: boolean } | TrashEntry | null;
type Input = {
  rootId: string;
  annotationId?: string;
  value?: unknown;
  clientRequestId?: string;
  requestHash?: string;
  drift?: boolean;
};
type Services = {
  unitOfWork: AccountUnitOfWork;
  repository: ThoughtRecordRepository;
  effects?: SourceMutationEffects | null;
  now(): string;
  annotations: {
    create(root: RecordEntity, source: string, input: unknown): Result;
    reply(root: RecordEntity, annotationId: string, input: unknown): Result;
    convert(root: RecordEntity, annotationId: string, input: unknown): Result;
  };
  source(store: RecordStore, root: RecordEntity, input: unknown): string;
  remove(store: RecordStore, input: Input): TrashEntry | null;
};
const commandIds = {
  create: "thought.annotation.create",
  reply: "thought.annotation.reply",
  convert: "thought.annotation.convert",
  remove: "thought.annotation.delete"
} as const;
type Operation = keyof typeof commandIds;

/** 批注只通过思绪公开聚合命令维护正文投影、根版本与父身份。 @since unreleased */
export function createThoughtAnnotationCommands(services: Services) {
  const { unitOfWork, repository, effects, annotations, source, remove, now } = services;
  const bind = (operation: Operation) => async (input: Input) => {
    let afterCommit: (() => void) | undefined;
    const committed = await unitOfWork.run({
      commandId: commandIds[operation],
      idempotency: operation === "create" && input.clientRequestId ? {
        scope: `annotations.create:thought:${input.rootId}`,
        key: input.clientRequestId,
        requestHash: input.requestHash || "",
        expiresAt: new Date(Date.parse(now()) + 90 * 86400000).toISOString()
      } : null
    }, async ports => {
      const closure = operation === "remove"
        ? await repository.readThoughtDeleteClosure(ports, input.rootId)
        : await repository.readThoughtTargetClosure(ports, input.rootId);
      if (!closure) return { missing: true };
      const root = closure.store.thoughts.find(item => item.id === input.rootId && item.type === "question");
      if (!root) return { missing: true };
      const state = { rows: closure.rows, store: closure.store };
      const observation = await effects?.prepare(ports, state);
      const result = operation === "create"
        ? annotations.create(root, source(state.store, root, input.value), input.value)
        : operation === "reply"
          ? annotations.reply(root, input.annotationId || "", input.value)
          : operation === "convert"
            ? annotations.convert(root, input.annotationId || "", input.value)
            : remove(state.store, input);
      if (!result || (!("value" in result) && !("id" in result)) || result.missing || result.invalid) return result;
      if (operation !== "remove") {
        root.version = (Number(root.version) || 1) + 1;
        root.updatedAt = now();
      }
      await commitThoughtCommand(ports, repository, state, root.id, {
        observation,
        trashEntries: operation === "remove" && "id" in result ? [result as TrashEntry] : []
      });
      afterCommit = observation?.afterCommit;
      return result;
    });
    afterCommit?.();
    const value = committed.value;
    if (value && AFTER_COMMIT in value) (value as TrashEntry)[AFTER_COMMIT]?.();
    return committed.replayed && value ? { ...value, duplicate: true } : value;
  };
  return {
    create: bind("create"),
    reply: bind("reply"),
    convert: bind("convert"),
    remove: bind("remove")
  };
}
