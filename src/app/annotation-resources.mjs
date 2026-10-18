import crypto from "node:crypto";
import { markdownText } from "../shared/content/index.mjs";
import { createThoughtAnnotationCommands } from "../../.build/typescript/backend/modules/thoughts/annotation-commands.mjs";
import { createThoughtRecordRepository } from "../../.build/typescript/backend/shared/persistence/thought-record-repository.mjs";
import { canonicalJson, mapStoreObjects, rebuildStoreObjects } from "../shared/persistence/index.mjs";

const collections = { thought: "thoughts", capture: "captures", journal: "journals", chat: "chats", analysis: "analyses", book: "books", quote: "quotes" };
const requestDigest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const annotationCollection = resourceType => collections[resourceType] || null;

export function annotationResource(store, resourceType, resourceId) {
  if (resourceType === "thought") return store.thoughts.find(item => item.id === resourceId && item.type === "question");
  const collection = annotationCollection(resourceType);
  return collection ? store[collection].find(item => item.id === resourceId) : null;
}

export function annotationResourceSource(store, resourceType, root, targetKey) {
  if (!root) return "";
  if (resourceType === "thought") {
    if (targetKey === `question:${root.id}`) return markdownText(root.content);
    const [type, id] = String(targetKey || "").split(":");
    if (["idea", "record", "answer"].includes(type)) {
      return markdownText(store.thoughts.find(item => item.id === id && item.relatedTo === root.id)?.content || "");
    }
    const followUp = (root.followUps || []).find(item => item.id === id);
    if (type === "followup-question") return markdownText(followUp?.question || "");
    if (type === "followup-answer") return markdownText(followUp?.answer || "");
    return "";
  }
  if (resourceType === "capture" || resourceType === "analysis" || resourceType === "quote") return targetKey === "content" ? markdownText(root.content) : "";
  if (resourceType === "chat") return targetKey === "message" ? markdownText(root.message) : targetKey === "answer" ? markdownText(root.answer) : "";
  if (resourceType === "journal") {
    if (targetKey === "content") return markdownText(root.content);
    const [type, id] = String(targetKey || "").split(":");
    return type === "reflection" ? markdownText((root.reflections || []).find(item => item.id === id)?.content || "") : "";
  }
  if (resourceType === "book") {
    if (targetKey === "description") return markdownText(root.description);
    const [type, id] = String(targetKey || "").split(":");
    return type === "note" ? markdownText((root.notes || []).find(item => item.id === id)?.content || "") : "";
  }
  return "";
}

export function annotationResourceContext(resourceType, root) {
  if (resourceType === "thought") return { label: "主题思考", title: root.content };
  if (resourceType === "capture") return { label: "捕念", title: root.content };
  if (resourceType === "journal") return { label: "日记", title: root.title || root.content };
  if (resourceType === "chat") return { label: "长期对话", title: root.message };
  if (resourceType === "analysis") return { label: "认知复盘", title: root.content };
  if (resourceType === "book") return { label: "读书笔记", title: root.title };
  if (resourceType === "quote") return { label: "善言", title: root.source };
  return { label: "正文", title: "" };
}

export function createAnnotationCommands({ repository, annotations, moveNestedItemToTrash, now = () => new Date().toISOString() }) {
  const thoughtCommands = repository.accountUnitOfWork?.run
    ? createThoughtAnnotationCommands({
        unitOfWork: repository.accountUnitOfWork,
        repository: createThoughtRecordRepository({ canonicalJson, mapStoreObjects, rebuildStoreObjects }),
        effects: repository.sourceMutationEffects,
        annotations,
        source: (store, root, input) => annotationResourceSource(store, "thought", root, input.targetKey),
        remove: (store, input) => moveNestedItemToTrash(store, {
          parentCollection: "thoughts",
          parentId: input.rootId,
          field: input.drift ? "annotationDrift" : "annotations",
          type: input.drift ? "annotationDrift" : "annotation",
          id: input.annotationId
        }),
        now
      })
    : null;
  return {
    create(resourceType, resourceId, input, { clientRequestId = "" } = {}) {
      const parsed = annotations.creationInput(input);
      if (parsed.invalid) return parsed;
      if (resourceType === "thought" && thoughtCommands) return thoughtCommands.create({
        rootId: resourceId,
        value: parsed.value,
        clientRequestId,
        requestHash: requestDigest(parsed.value)
      });
      const createInStore = store => {
        const root = annotationResource(store, resourceType, resourceId);
        const source = annotationResourceSource(store, resourceType, root, parsed.value.targetKey);
        return annotations.create(root, source, parsed.value);
      };
      if (!clientRequestId || typeof repository.executeIdempotent !== "function") {
        return repository.update(createInStore);
      }
      return repository.executeIdempotent({
        scope: `annotations.create:${resourceType}:${resourceId}`,
        key: clientRequestId,
        requestHash: requestDigest(parsed.value)
      }, createInStore);
    },
    reply(resourceType, resourceId, annotationId, input) {
      const parsed = annotations.replyInput(input);
      if (parsed.invalid) return parsed;
      if (resourceType === "thought" && thoughtCommands) return thoughtCommands.reply({
        rootId: resourceId,
        annotationId,
        value: parsed.value
      });
      return repository.update(store => annotations.reply(annotationResource(store, resourceType, resourceId), annotationId, parsed.value));
    },
    convert(resourceType, resourceId, annotationId, input) {
      if (resourceType === "thought" && thoughtCommands) return thoughtCommands.convert({
        rootId: resourceId,
        annotationId,
        value: input
      });
      return repository.update(store => annotations.convert(
        annotationResource(store, resourceType, resourceId),
        annotationId,
        input
      ));
    },
    remove(resourceType, resourceId, id, drift = false) {
      if (resourceType === "thought" && thoughtCommands) return thoughtCommands.remove({
        rootId: resourceId,
        annotationId: id,
        drift
      });
      const parentCollection = annotationCollection(resourceType);
      if (!parentCollection) return null;
      const field = drift ? "annotationDrift" : "annotations", type = drift ? "annotationDrift" : "annotation";
      return repository.update(store => moveNestedItemToTrash(store, { parentCollection, parentId: resourceId, field, type, id }));
    }
  };
}
