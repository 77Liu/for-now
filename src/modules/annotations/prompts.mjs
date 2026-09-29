import { promptText, renderPrompt } from "../../shared/prompts/index.mjs";

export const shenjiSystemPrompt = () => promptText("annotation.system.shenji");

export function annotationPrompt({ personalContext, rootContext, annotation, excerpt, previousItems, message }) {
  const previous = previousItems.map((item, index) => renderPrompt("annotation.turn", {
    index: index + 1, message: item.message || "（未追加问题，直接询问标记内容）", answer: item.answer
  })).join("\n");
  const kind = annotation.kind === "highlight"
    ? "划线"
    : annotation.kind === "emphasis"
      ? "加重"
      : "评论";
  return renderPrompt("annotation.user", {
    personalContext, rootContext, kind,
    before: excerpt.before, focus: excerpt.focus, after: excerpt.after, comment: annotation.text || "（无）",
    previous: previous || "（无）", message: message || promptText("annotation.task.default")
  });
}
