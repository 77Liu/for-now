export type TaskTargetInput = {
  kind?: unknown;
  resourceType?: unknown;
  targetId?: unknown;
  subtargetId?: unknown;
  payload?: { targetType?: unknown } | null;
};

export type TaskTargetDescriptor = {
  collection: string;
  targetId: string;
  targetKey: string;
  subtargetId: string;
  subtargetFields: string[];
  subtargetKeys: string[];
  requiresSubtarget: boolean;
};

export const ANNOTATION_TARGET_FIELDS = Object.freeze([
  "annotations",
  "annotationDrift"
] as const);

export const TASK_TARGET_COLLECTIONS: Readonly<Record<string, string>> = Object.freeze({
  thought: "thoughts",
  capture: "captures",
  journal: "journals",
  chat: "chats",
  analysis: "analyses",
  book: "books",
  quote: "quotes"
});
const keyOf = (parts: unknown[]) => JSON.stringify(parts);

export function taskTargetDescriptor(
  task: TaskTargetInput | null | undefined,
  sourceTask: TaskTargetInput | null | undefined = null
): TaskTargetDescriptor | null {
  const kind = String(sourceTask?.kind || task?.kind || "");
  const payload = sourceTask?.payload || task?.payload;
  const resourceType = String(sourceTask?.resourceType || task?.resourceType || "");
  const collection = TASK_TARGET_COLLECTIONS[resourceType]
    || (["thoughtAnswer", "followUpAnswer"].includes(kind) ? "thoughts" : "");
  if (!collection) return null;
  const targetId = String(sourceTask?.targetId || task?.targetId || "");
  const subtargetId = String(sourceTask?.subtargetId || task?.subtargetId || "");
  const subtargetFields = kind === "followUpAnswer"
    ? ["followUps"]
    : kind === "annotationShenji"
      ? ["annotations"]
      : kind === "contentImageUnderstanding" && payload?.targetType === "comment"
        ? [...ANNOTATION_TARGET_FIELDS]
        : [];
  return {
    collection,
    targetId,
    targetKey: keyOf([collection, targetId]),
    subtargetId,
    subtargetFields,
    subtargetKeys: subtargetFields.map(field => (
      keyOf([collection, targetId, field, subtargetId])
    )),
    requiresSubtarget: subtargetFields.length > 0
  };
}

export function locateTaskSubtarget(
  target: Record<string, unknown> | null | undefined,
  descriptor: TaskTargetDescriptor
): { field: string; value: Record<string, unknown> } | null {
  for (const field of descriptor.subtargetFields) {
    const values = target?.[field];
    if (!Array.isArray(values)) continue;
    const value = values.find(item => (
      item && typeof item === "object"
      && String((item as Record<string, unknown>).id || "") === descriptor.subtargetId
    ));
    if (value) return { field, value: value as Record<string, unknown> };
  }
  return null;
}
