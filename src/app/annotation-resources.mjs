import crypto from "node:crypto";
import { markdownText } from "../shared/content/index.mjs";

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
    if (type === "idea" || type === "answer") return markdownText(store.thoughts.find(item => item.id === id && item.relatedTo === root.id)?.content || "");
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

export function createAnnotationCommands({ repository, annotations, moveNestedItemToTrash }) {
  return {
    create(resourceType, resourceId, input, { clientRequestId = "" } = {}) {
      const parsed = annotations.creationInput(input);
      if (parsed.invalid) return parsed;
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
      return repository.update(store => annotations.reply(annotationResource(store, resourceType, resourceId), annotationId, parsed.value));
    },
    convert(resourceType, resourceId, annotationId, input) {
      return repository.update(store => annotations.convert(
        annotationResource(store, resourceType, resourceId),
        annotationId,
        input
      ));
    },
    remove(resourceType, resourceId, id, drift = false) {
      const parentCollection = annotationCollection(resourceType);
      if (!parentCollection) return null;
      const field = drift ? "annotationDrift" : "annotations", type = drift ? "annotationDrift" : "annotation";
      return repository.update(store => moveNestedItemToTrash(store, { parentCollection, parentId: resourceId, field, type, id }));
    }
  };
}
