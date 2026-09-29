import { safeText } from "../shared/validation/index.mjs";
import { shiftDateKey } from "../shared/time/index.mjs";
import { renderPrompt } from "../shared/prompts/index.mjs";
import { onboardingContext } from "../modules/onboarding/index.mjs";
import { describeDailyRecord } from "../modules/health/index.mjs";
import { thoughtPersonalContext, thoughtChainContext, thoughtTask } from "../modules/thoughts/index.mjs";
import { userPrompt } from "../modules/ai/index.mjs";

export function diaryActivityContext(store, occurredOn) {
  const previousDate = shiftDateKey(occurredOn, -1);
  const describeDate = date => {
    const checkins = store.checkins.filter(item => item.occurredOn === date).slice(0, 5).map(item => `状态：情绪${item.mood}/精力${item.energy}/压力状态${item.stress}/睡眠${item.sleep}${item.factors?.length ? `；因素：${item.factors.join("、")}` : ""}`);
    const dailyRecords = store.dailyRecords.filter(item => item.occurredOn === date).slice(0, 8).map(describeDailyRecord);
    const captures = store.captures.filter(item => item.occurredOn === date).slice(0, 8).map(item => `捕念：${item.content}`);
    const journals = store.journals.filter(item => item.occurredOn === date).slice(0, 3).map(item => `日记${item.title ? `《${item.title}》` : ""}：${item.content}`);
    const thoughts = store.thoughts.filter(item => item.type === "question" && item.occurredOn === date).slice(0, 8).map(item => `思绪：${item.content}`);
    return [...checkins, ...dailyRecords, ...captures, ...journals, ...thoughts].join("\n") || "（暂无记录）";
  };
  const recent = [
    ...store.captures.map(item => ({ date: item.occurredOn, text: `捕念：${item.content}` })),
    ...store.journals.map(item => ({ date: item.occurredOn, text: `日记${item.title ? `《${item.title}》` : ""}：${item.content}` })),
    ...store.thoughts.filter(item => item.type === "question").map(item => ({ date: item.occurredOn, text: `思绪：${item.content}` }))
  ].filter(item => item.date <= occurredOn).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 16).map(item => `${item.date} ${item.text}`).join("\n");
  return renderPrompt("context.diaryActivity", {
    selectedDate: occurredOn, todayRecords: describeDate(occurredOn), previousDate,
    previousDayRecords: describeDate(previousDate), recentRecords: recent || "（暂无记录）"
  });
}

export function thoughtPromptContext(store, occurredOn) {
  const entries = [
    ...store.captures.map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `捕念：${safeText(item.content, 500)}` })),
    ...store.journals.map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `日记${item.title ? `《${safeText(item.title, 80)}》` : ""}：${safeText(item.content, 700)}` })),
    ...store.thoughts.filter(item => item.type === "question").map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `曾经的问题：${safeText(item.content, 500)}` })),
    ...store.chats.map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `长期对话中的提问：${safeText(item.message, 500)}` })),
    ...store.checkins.map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `状态：情绪${item.mood}/精力${item.energy}/压力状态${item.stress}/睡眠${item.sleep}${item.factors?.length ? `；因素：${item.factors.map(value => safeText(value, 40)).join("、")}` : ""}` })),
    ...store.dailyRecords.map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: describeDailyRecord(item) }))
  ].filter(item => item.date && item.date <= occurredOn).sort((a, b) => b.time.localeCompare(a.time)).slice(0, 12);
  return {
    hasHistory: entries.length > 0,
    text: entries.length ? entries.map((item, index) => `${index + 1}. ${item.date} ${item.text}`).join("\n") : "（没有历史记录）"
  };
}

export function userAnswerContext(store) {
  const { focus, recent } = thoughtPersonalContext(store.thoughts);
  const recentCheckins = store.checkins.slice(0, 30).map(item => `${item.occurredOn} 情绪${item.mood}/精力${item.energy}/压力状态${item.stress}/睡眠${item.sleep}${item.factors?.length ? `；因素：${item.factors.join("、")}` : ""}`).join("\n");
  const recentDailyRecords = store.dailyRecords.slice(0, 40).map(item => `${item.occurredOn} ${describeDailyRecord(item)}`).join("\n");
  const recentCaptures = store.captures.slice(0, 30).map(item => `${item.occurredOn}：${item.content}${item.tags?.length ? `（${item.tags.join("、")}）` : ""}`).join("\n");
  const recentJournals = store.journals.slice(0, 12).map(item => `${item.occurredOn}${item.title ? `《${item.title}》` : ""}：${item.content}`).join("\n\n");
  return renderPrompt("context.personal", {
    onboarding: onboardingContext(store.onboarding), focus: focus.length ? focus.join("、") : "尚未形成",
    checkins: recentCheckins || "（暂无）", dailyRecords: recentDailyRecords || "（暂无）",
    captures: recentCaptures || "（暂无）", journals: recentJournals || "（暂无）", thoughts: recent || "（暂无）"
  });
}

export function thoughtAnswerPrompt(context, chain, followUp = false) {
  return userPrompt({ context, chain, task: thoughtTask(followUp ? "followUp" : "answer") });
}

export function prepareThoughtAnswer(store, root, currentFollowUpId = "") {
  const chain = thoughtChainContext(store.thoughts, root, currentFollowUpId);
  return thoughtAnswerPrompt(userAnswerContext(store), chain, Boolean(currentFollowUpId));
}
