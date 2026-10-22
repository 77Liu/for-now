/**
 * 思绪索引启用前的实际生产者装配检查。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：检查公开命令与仓库维护端口；不把声明或开关当作执行证据。
 */
export type RecordCommandConfig = { enabled(name: string): boolean };
export type ThoughtProducerCommands = Record<string, unknown> | null | undefined;
export type ThoughtProducerBindings = {
  roots: ThoughtProducerCommands;
  local: ThoughtProducerCommands;
  annotations: ThoughtProducerCommands;
  trash: ThoughtProducerCommands;
  attachments: ThoughtProducerCommands;
  contentAi: ThoughtProducerCommands;
  taskCreation: ThoughtProducerCommands;
  taskTransitions: ThoughtProducerCommands;
};

const requiredFlags = [
  "thought.create", "thought.update", "thought.delete", "thought.aiWriteback", "task.status"
] as const;
const requiredCommands = {
  roots: ["create", "update", "remove", "saveForegroundAnswer", "writeback", "failWriteback"],
  local: ["createBlock", "updateBlock", "setDisposition", "addRemark", "updateRemark", "addFollowUp", "updateFollowUp"],
  annotations: ["create", "reply", "convert", "remove"],
  trash: ["removeBlock", "removeNested", "restore"],
  attachments: ["run"],
  contentAi: ["writeback", "failWriteback"],
  taskCreation: ["supports", "prepareSnapshot", "create"],
  taskTransitions: ["supports", "prepareSnapshot", "transition", "cleanup"]
} as const;

export function incompleteThoughtProducers(missing: string[]) {
  return Object.assign(new Error("思绪索引生产者装配不完整，禁止启用"), {
    code: "THOUGHT_INDEX_PRODUCER_COVERAGE_INCOMPLETE",
    missing
  });
}

/** 分页开启时根写入、AI 写回与用户取消必须选择实际记录命令。 @since unreleased */
export function assertThoughtProducerFlags(config?: RecordCommandConfig | null) {
  const missing = requiredFlags.filter(name => config?.enabled(name) !== true);
  if (missing.length) throw incompleteThoughtProducers(missing.map(name => `flag:${name}`));
}

/** 完整运行时装配后核对各生产者族实际使用的命令函数。 @since unreleased */
export function assertThoughtProducerBindings(bindings: ThoughtProducerBindings) {
  const missing: string[] = [];
  for (const family of Object.keys(requiredCommands) as Array<keyof ThoughtProducerBindings>) {
    for (const command of requiredCommands[family]) {
      if (typeof bindings[family]?.[command] !== "function") missing.push(`${family}.${command}`);
    }
  }
  if (missing.length) throw incompleteThoughtProducers(missing);
  return Object.freeze(Object.fromEntries(
    Object.entries(requiredCommands).map(([family, commands]) => [family, Object.freeze([...commands])])
  ));
}
