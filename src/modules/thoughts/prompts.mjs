import { promptText, renderPrompt } from "../../shared/prompts/index.mjs";

export const thoughtTask = kind => promptText(`thought.task.${kind}`);
export const thoughtPromptSystem = () => promptText("thought.system.starter");

export const stripThoughtAnswerLead = value => String(value ?? "").replace(/^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:核心判断|给我判断|给你(?:一个)?判断|我的判断|结论)(?:\*\*|__)?(?:\s*[：:]|\s*\n+)\s*/u, "").trimStart();

export function thoughtPersonalContext(thoughts) {
  const roots = thoughts.filter(item => item.type === "question").slice(0, 40);
  const tagCounts = new Map();
  for (const item of thoughts.filter(item => item.authorType !== "ai")) for (const tag of item.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  const focus = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag]) => tag);
  const recent = roots.map((root, index) => {
    const ideas = thoughts.filter(item => item.relatedTo === root.id && item.type === "idea").map(item => item.content).join("\n");
    const records = thoughts.filter(item => item.relatedTo === root.id && item.type === "record").map(item => item.content).join("\n");
    const userAnswers = thoughts.filter(item => item.relatedTo === root.id && item.type === "answer" && item.authorType === "user").map(item => item.content).join("\n");
    return `${index + 1}. 用户问题：${root.content}\n用户初步想法：${ideas || "（无）"}\n用户后续记录：${records || "（无）"}\n用户亲自写下的回答：${userAnswers || "（无）"}\n标签：${(root.tags || []).join("、") || "（无）"}`;
  }).join("\n\n");
  return { focus, recent };
}

export function thoughtChainContext(thoughts, root, currentFollowUpId = "") {
  const ideas = thoughts.filter(item => item.relatedTo === root.id && item.type === "idea").map(item => item.content);
  const answers = thoughts.filter(item => item.relatedTo === root.id && item.type === "answer").map(item => item.content || item.modelDraft || "");
  const followUps = (root.followUps || []).map((item, index) => renderPrompt("thought.chain.followUp", {
    index: index + 1, id: item.id, current: item.id === currentFollowUpId ? ' current="true"' : "",
    question: item.question, answer: item.answer || "（尚未回答）"
  })).join("\n");
  return renderPrompt("thought.chain", {
    question: root.content,
    ideas: ideas.length ? ideas.join("\n\n") : "（暂无）",
    answers: answers.filter(Boolean).length ? answers.filter(Boolean).join("\n\n") : "（暂无）",
    followUps: followUps || "（无）"
  });
}

export function thoughtDraftInput(question, idea) {
  return { chain: renderPrompt("thought.draft.context", { question, idea: idea || "（暂无）" }), task: thoughtTask("draft") };
}

export function thoughtStarterPrompt(occurredOn, context) {
  const task = promptText(`thought.starter.${context.hasHistory ? "history" : "empty"}`);
  return renderPrompt("thought.starter.wrapper", { occurredOn, hasHistory: context.hasHistory, context: context.text, task });
}
