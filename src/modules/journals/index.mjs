import { promptText, renderPrompt } from "../../shared/prompts/index.mjs";

export {
  createJournalRecords,
  journalDraftPayload,
  journalPayload,
  JOURNAL_REFLECTION_IDEMPOTENCY_SCOPE
} from "./records.mjs";

export const diarySystemPrompt = () => promptText("journal.system.reflection");
export const diaryAssistSystemPrompt = () => promptText("journal.system.assist");
const JOURNAL_ASSIST_MARKERS = { lead: "🗃", structure: "🏷", topic: "💬" };

export function markJournalAssistContent(mode, content) {
  const marker = JOURNAL_ASSIST_MARKERS[mode] || "";
  return String(content || "").trim().split(/\r?\n/).map(line => {
    if (!line.trim() || !marker || line.trimStart().startsWith(marker)) return line;
    return `${marker} ${line.trimStart()}`;
  }).join("\n");
}

export function journalAssistPrompt(activityContext, { mode, title, content }) {
  const task = promptText(`journal.task.${mode}`);
  return renderPrompt("journal.assist.wrapper", {
    activityContext, title: title || "（无标题）", content: content || "（尚未写正文）", task
  });
}

export function journalReflectionInput(journal) {
  return {
    chain: renderPrompt("journal.reflection.context", {
      occurredOn: journal.occurredOn, title: journal.title || "（无标题）",
      content: journal.content, tags: journal.tags.join("、") || "（无）"
    }),
    task: promptText("journal.task.reflection")
  };
}
