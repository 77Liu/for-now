import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { safeText } from "../shared/validation/index.mjs";
import { shiftDateKey } from "../shared/time/index.mjs";
import { renderPrompt } from "../shared/prompts/index.mjs";
import {
  onboardingContext,
  onboardingV2Context,
  onboardingV2ContextEntries
} from "../modules/onboarding/index.mjs";
import { evidenceSourceKey } from "../modules/user-model/index.mjs";
import { describeDailyRecord } from "../modules/health/index.mjs";
import { thoughtChainContext, thoughtTask } from "../modules/thoughts/index.mjs";
import { userPrompt } from "../modules/ai/index.mjs";
import { activeUserModelEntries } from "./user-model.mjs";

export const PERSONAL_CONTEXT_PROJECTION_VERSION = "2026.10.02.2";
export const PERSONAL_CONTEXT_TOKEN_BUDGET = 20_000;

const INFORMATION_TYPE_LABELS = Object.freeze({
  user_fact: "用户事实",
  user_viewpoint: "用户观点",
  model_summary: "模型摘要"
});
const CONTEXT_SECTION_LIMITS = Object.freeze({
  checkins: 30,
  dailyRecords: 40,
  captures: 30,
  journals: 12,
  thoughts: 40
});
const CONTEXT_REMOVAL_ORDER = ["journals", "thoughts", "captures", "dailyRecords", "checkins"];
const PROFILE_LABELS = Object.freeze({
  gender: "性别",
  region: "地区",
  occupation: "职业",
  major: "专业",
  school: "学校",
  introduction: "自我介绍",
  works: "代表作品或材料"
});

const list = value => Array.isArray(value) ? value : [];
const legacyContextAllowed = item => item
  && item.contextAllowed !== false
  && item.allowInContext !== false
  && item.disposition !== "discarded";
const modelAuthored = item => (
  item?.authorType === "ai"
  || /^(?:deepseek|codex|openai|model|ai)(?:$|[-_:])/i.test(String(item?.origin || ""))
  || Boolean(item?.modelDraft)
  || Boolean(item?.sourceTaskId)
  || Boolean(item?.contextReceipt)
);
const contextAllowed = (store, item, sourceRef, purpose = "context") => {
  if (!legacyContextAllowed(item)) return false;
  const sourceKey = evidenceSourceKey(sourceRef);
  if (!sourceKey) return purpose === "context";
  const permissions = list(store?.evidencePermissions)
    .filter(permission => permission?.sourceKey === sourceKey);
  if (permissions.length === 0) return purpose === "context";
  if (permissions.length !== 1) return false;
  return purpose === "learning"
    ? permissions[0].learningAllowed === true
    : permissions[0].contextAllowed === true;
};
const eventTime = item => safeText(item?.occurredAt || item?.createdAt || item?.updatedAt, 100);
const eventDate = item => safeText(item?.occurredOn || eventTime(item).slice(0, 10), 10);
const sourceRef = (resourceType, item, {
  rootId = "",
  targetKey = ""
} = {}) => ({
  resourceType,
  resourceId: safeText(item?.id, 100),
  rootId: safeText(rootId, 100),
  targetKey: safeText(targetKey, 120),
  version: Math.max(1, Math.round(Number(item?.version) || 1))
});
const excerpt = value => {
  const text = safeText(value, 240).replace(/\s+/g, " ").trim();
  return String(value ?? "").replace(/\s+/g, " ").trim().length > text.length ? `${text}…` : text;
};

export function estimatePersonalContextTokens(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function contextSource(item, {
  id = item?.id,
  resourceType,
  recordType,
  informationType,
  text,
  view,
  rootId = "",
  targetId = id,
  targetKey = "",
  evidence = [],
  epistemic = "",
  lifecycle = ""
}) {
  const resourceId = safeText(id, 100);
  const sourceText = String(text ?? "");
  return {
    id: `${resourceType}:${resourceId}${targetKey ? `:${targetKey}` : ""}`,
    resourceType,
    resourceId,
    recordType,
    informationType,
    informationTypeLabel: INFORMATION_TYPE_LABELS[informationType],
    occurredAt: eventTime(item),
    occurredOn: eventDate(item),
    version: Math.max(1, Math.round(Number(item?.version) || 1)),
    contentSha256: crypto.createHash("sha256").update(sourceText).digest("hex"),
    excerpt: excerpt(sourceText),
    ...(evidence.length ? { evidence: structuredClone(evidence) } : {}),
    ...(epistemic ? { epistemic } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    location: {
      view,
      targetId: safeText(targetId || resourceId, 100),
      rootId: safeText(rootId, 100),
      targetKey: safeText(targetKey, 120),
      occurredOn: eventDate(item),
      ...(resourceType === "dailyRecord" ? { dailyType: safeText(item?.type, 40) } : {})
    }
  };
}

function userModelContextProjection(store) {
  const entries = activeUserModelEntries(store);
  if (!entries.length) return { prompt: "", sources: [], conclusions: [] };
  const sources = entries.map(entry => contextSource(entry, {
    resourceType: "userClaim",
    recordType: `${entry.title} · 已确认理解`,
    informationType: entry.informationType,
    text: entry.text,
    view: "personal-context",
    targetKey: `claim:${entry.id}`,
    evidence: entry.evidence,
    epistemic: entry.epistemic,
    lifecycle: entry.lifecycle
  }));
  return {
    prompt: `用户逐项确认的理解：\n${entries.map(entry => `- ${entry.title}：${entry.text}`).join("\n")}`,
    sources,
    conclusions: entries.map((entry, index) => ({
      id: `user-claim-${entry.id}`,
      informationType: entry.informationType,
      informationTypeLabel: INFORMATION_TYPE_LABELS[entry.informationType],
      title: `${entry.title} · 已确认`,
      text: entry.text,
      sourceIds: [sources[index].id],
      sampleNote: entry.epistemic === "known"
        ? "由你的原话整理并经你确认，可撤回或修正。"
        : "这是由你的原话整理并经你确认的待验证理解，不是客观定论。"
    }))
  };
}

function onboardingV2Projection(store) {
  const entries = onboardingV2ContextEntries(store?.onboardingV2);
  if (!entries.length) return { prompt: "", sources: [], conclusions: [] };
  const sources = entries.map(entry => contextSource({
    id: entry.id,
    version: entry.version,
    occurredAt: entry.occurredAt,
    updatedAt: entry.updatedAt
  }, {
    resourceType: "onboardingV2",
    recordType: entry.title,
    informationType: entry.informationType,
    text: entry.text,
    view: "personal-context",
    targetKey: `answer:${entry.id}`
  }));
  return {
    prompt: safeText(onboardingV2Context(store.onboardingV2), 6000),
    sources,
    conclusions: entries.map((entry, index) => ({
      id: `onboarding-v2-${entry.id}`,
      informationType: entry.informationType,
      informationTypeLabel: INFORMATION_TYPE_LABELS[entry.informationType],
      title: entry.title,
      text: entry.text,
      sourceIds: [sources[index].id],
      sampleNote: "来自你在五问中保留的原文，可随时修改或排除。"
    }))
  };
}

function onboardingProjection(store) {
  const onboarding = store?.onboarding || {};
  const v2 = onboardingV2Projection(store);
  if (onboarding.status !== "completed") {
    return {
      prompt: v2.prompt || onboardingContext(onboarding),
      sources: v2.sources,
      conclusions: v2.conclusions
    };
  }
  const sources = [], conclusions = [];
  const profile = Object.entries(PROFILE_LABELS)
    .map(([key, label]) => onboarding.profile?.[key] ? `${label}：${safeText(onboarding.profile[key], key === "works" ? 2000 : 1200)}` : "")
    .filter(Boolean);
  if (list(onboarding.interests).length) profile.push(`用户选择的兴趣：${onboarding.interests.map(value => safeText(value, 80)).filter(Boolean).join("、")}`);
  if (profile.length) {
    const source = contextSource(onboarding, {
      id: "onboarding",
      resourceType: "onboarding",
      recordType: "初始资料",
      informationType: "user_fact",
      text: profile.join("\n"),
      view: "personal-context",
      targetKey: "profile"
    });
    sources.push(source);
    conclusions.push({
      id: "onboarding-profile",
      informationType: source.informationType,
      informationTypeLabel: source.informationTypeLabel,
      title: "你主动提供的资料",
      text: profile.join("\n"),
      sourceIds: [source.id],
      sampleNote: "仅呈现你主动填写的内容，不据此推断稳定特征。"
    });
  }
  const viewpoints = [
    Object.keys(onboarding.answers || {}).length
      ? `已完成${onboarding.questionnaireMode === "detailed" ? "详细版" : "快速版"}初始问卷，共 ${Object.keys(onboarding.answers).length} 项选择。`
      : "",
    onboarding.material ? `导入材料：${safeText(onboarding.material, 2000)}` : ""
  ].filter(Boolean);
  if (viewpoints.length) {
    const source = contextSource(onboarding, {
      id: "onboarding",
      resourceType: "onboarding",
      recordType: "问卷与材料",
      informationType: "user_viewpoint",
      text: viewpoints.join("\n"),
      view: "personal-context",
      targetKey: "viewpoints"
    });
    sources.push(source);
    conclusions.push({
      id: "onboarding-viewpoints",
      informationType: source.informationType,
      informationTypeLabel: source.informationTypeLabel,
      title: "初始问卷与自述",
      text: viewpoints.join("\n"),
      sourceIds: [source.id],
      sampleNote: "这些选择只代表填写时的表达，可随真实记录变化。"
    });
  }
  if (onboarding.understanding) {
    const source = contextSource(onboarding, {
      id: "onboarding",
      resourceType: "onboarding",
      recordType: "初始理解",
      informationType: "model_summary",
      text: onboarding.understanding,
      view: "personal-context",
      targetKey: "understanding"
    });
    sources.push(source);
    conclusions.push({
      id: "onboarding-understanding",
      informationType: source.informationType,
      informationTypeLabel: source.informationTypeLabel,
      title: "系统的初始理解",
      text: safeText(onboarding.understanding, 3000),
      sourceIds: [source.id],
      sampleNote: "这是模型摘要，不是用户事实，也不会自动写成长期记忆。"
    });
  }
  return {
    prompt: [safeText(onboardingContext(onboarding), 6000), v2.prompt].filter(Boolean).join("\n"),
    sources: [...sources, ...v2.sources],
    conclusions: [...conclusions, ...v2.conclusions]
  };
}

function confirmedSynthesisProjection(store) {
  const entries = list(store?.analyses)
    .filter(item => (
      ["manual", "weekly-background"].includes(item?.reason)
      && item?.reviewStatus === "confirmed"
      && item?.contextReceipt?.permissionPurpose === "learning"
      && safeText(item?.content, 3000)
    ))
    .slice(0, 5)
    .filter(item => personalContextReceiptMatches(store, item.contextReceipt))
    .slice(0, 3);
  if (!entries.length) return { prompt: "", sources: [], conclusions: [] };
  const sources = entries.map(item => contextSource(item, {
    resourceType: "analysis",
    recordType: "已确认周期回望",
    informationType: "model_summary",
    text: safeText(item.content, 3000),
    view: "reviews",
    targetKey: "content"
  }));
  return {
    prompt: `用户确认保留的周期回望（模型摘要，不是用户事实）：\n${
      entries.map(item => `- ${safeText(item.content, 3000)}`).join("\n")
    }`,
    sources,
    conclusions: entries.map((item, index) => ({
      id: `confirmed-analysis-${safeText(item.id, 100)}`,
      informationType: "model_summary",
      informationTypeLabel: INFORMATION_TYPE_LABELS.model_summary,
      title: "已确认周期回望",
      text: safeText(item.content, 3000),
      sourceIds: [sources[index].id],
      sampleNote: "这是经你确认保留的模型综合，不会被当作用户原话或客观事实。"
    }))
  };
}

export function learningThoughtSelection(store) {
  const selected = [];
  const add = (item, ref, content, recordType, type = item.type) => {
    if (selected.length >= 80 || !safeText(content, 4000)) return;
    selected.push({
      ...item,
      type,
      content,
      tags: type === "question" ? item.tags : [],
      modelDraft: "",
      followUps: [],
      relatedTo: ref.rootId,
      _learningSourceRef: ref,
      _learningRecordType: recordType
    });
  };
  for (const item of list(store?.thoughts)) {
    if (selected.length >= 80) break;
    if (!legacyContextAllowed(item) || modelAuthored(item)) continue;
    if (item?.type !== "question") {
      const ref = sourceRef("thought", item, {
        rootId: item.relatedTo,
        targetKey: `${item.type}:${item.id}`
      });
      if (contextAllowed(store, item, ref, "learning")) {
        add(
          item,
          ref,
          item.content,
          item.type === "idea" ? "初步想法" : item.type === "record" ? "思绪记录" : "用户回答"
        );
      }
      continue;
    }
    const rootRef = sourceRef("thought", item, {
      rootId: item.id,
      targetKey: `question:${item.id}`
    });
    if (contextAllowed(store, item, rootRef, "learning")) {
      add(item, rootRef, item.content, "思绪问题", "question");
    }
    for (const followUp of list(item.followUps)) {
      if (selected.length >= 80) break;
      if (!legacyContextAllowed(followUp)) continue;
      const questionRef = sourceRef("thought", followUp, {
        rootId: item.id,
        targetKey: `followup-question:${followUp.id}`
      });
      if (contextAllowed(store, followUp, questionRef, "learning")) {
        add(followUp, questionRef, followUp.question, "思绪追问", "followUpQuestion");
      }
      if (selected.length >= 80) break;
      const answerRef = sourceRef("thought", followUp, {
        rootId: item.id,
        targetKey: `followup-answer:${followUp.id}`
      });
      if (!modelAuthored(followUp)
        && contextAllowed(store, followUp, answerRef, "learning")) {
        add(followUp, answerRef, followUp.answer, "追问回答", "followUpAnswer");
      }
    }
  }
  return selected;
}

function learningReceiptSources(store) {
  const sources = list(store?.thoughts).flatMap(item => {
    const ref = item?._learningSourceRef || sourceRef("thought", item, {
      rootId: item.type === "question" ? item.id : item.relatedTo,
      targetKey: `${item.type}:${item.id}`
    });
    return item?.content ? [contextSource(item, {
      id: ref.resourceId,
      resourceType: "thought",
      recordType: item._learningRecordType
        || (item.type === "question" ? "思绪问题" : "思绪记录"),
      informationType: "user_viewpoint",
      text: item.content,
      view: "thoughts",
      rootId: ref.rootId,
      targetKey: ref.targetKey
    })] : [];
  });
  const feedbackSources = [];
  for (const action of list(store?.actions)) {
    const validFeedback = feedback => (
      feedback
      && feedback.learningAllowed === true
      && (
        ["helpful", "mixed", "unhelpful", "unsure"].includes(feedback.outcome)
        || safeText(feedback.note, 1000)
      )
    );
    const completions = list(action.statusHistory)
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry?.to === "done" && validFeedback(entry.feedback));
    const feedbackEntries = completions.length
      ? completions.map(({ entry, index }) => ({
          feedback: entry.feedback,
          completedAt: entry.changedAt || action.completedAt,
          key: `completion-feedback:${index}`
        }))
      : validFeedback(action.completionFeedback)
        ? [{
            feedback: action.completionFeedback,
            completedAt: action.completionFeedback.recordedAt || action.completedAt,
            key: "completion-feedback:current"
          }]
        : [];
    for (const entry of feedbackEntries) {
      feedbackSources.push(contextSource({
        ...action,
        occurredAt: entry.completedAt,
        occurredOn: safeText(entry.completedAt, 100).slice(0, 10)
      }, {
        id: action.id,
        resourceType: "action",
        recordType: "行动完成反馈",
        informationType: "user_viewpoint",
        text: JSON.stringify({
          title: safeText(action.title, 120),
          outcome: entry.feedback.outcome,
          note: safeText(entry.feedback.note, 1000)
        }),
        view: "actions",
        targetId: action.id,
        targetKey: entry.key
      }));
    }
  }
  sources.push(...feedbackSources.slice(0, 40));
  return sources;
}

function contextEntries(store, purpose = "context") {
  const sections = {
    checkins: list(store?.checkins).filter(item => (
      contextAllowed(store, item, sourceRef("checkin", item), purpose)
    )).slice(0, CONTEXT_SECTION_LIMITS.checkins).map((item, index) => {
      const text = `${item.occurredOn} 情绪${item.mood}/精力${item.energy}/压力状态${item.stress}/睡眠${item.sleep}${item.factors?.length ? `；因素：${item.factors.join("、")}` : ""}`;
      return {
        text,
        sources: [contextSource(item, {
          id: item.id || `checkin-${index + 1}`,
          resourceType: "checkin",
          recordType: "此刻状态",
          informationType: "user_fact",
          text,
          view: "today"
        })]
      };
    }),
    dailyRecords: list(store?.dailyRecords).filter(item => (
      contextAllowed(store, item, sourceRef("dailyRecord", item), purpose)
    )).slice(0, CONTEXT_SECTION_LIMITS.dailyRecords).map((item, index) => {
      const description = describeDailyRecord(item), text = `${item.occurredOn} ${description}`;
      return {
        text,
        sources: [contextSource(item, {
          id: item.id || `daily-record-${index + 1}`,
          resourceType: "dailyRecord",
          recordType: "健康记录",
          informationType: "user_fact",
          text: description,
          view: "daily"
        })]
      };
    }),
    captures: list(store?.captures).filter(item => (
      contextAllowed(store, item, sourceRef("capture", item), purpose)
    )).slice(0, CONTEXT_SECTION_LIMITS.captures).map((item, index) => {
      const text = `${item.occurredOn}：${safeText(item.content, 500)}${item.tags?.length ? `（${item.tags.join("、")}）` : ""}`;
      return {
        text,
        sources: [contextSource(item, {
          id: item.id || `capture-${index + 1}`,
          resourceType: "capture",
          recordType: "念起",
          informationType: "user_viewpoint",
          text: item.content,
          view: "captures"
        })]
      };
    }),
    journals: list(store?.journals).filter(item => (
      contextAllowed(store, item, sourceRef("journal", item), purpose)
    )).slice(0, CONTEXT_SECTION_LIMITS.journals).map((item, index) => {
      const text = `${item.occurredOn}${item.title ? `《${safeText(item.title, 80)}》` : ""}：${safeText(item.content, 700)}`;
      return {
        text,
        sources: [contextSource(item, {
          id: item.id || `journal-${index + 1}`,
          resourceType: "journal",
          recordType: "日记",
          informationType: "user_viewpoint",
          text: `${item.title ? `${item.title}：` : ""}${item.content}`,
          view: "journals"
        })]
      };
    }),
    thoughts: list(store?.thoughts)
      .filter(item => item.type === "question"
        && item.authorType !== "ai"
        && contextAllowed(store, item, sourceRef("thought", item, {
          rootId: item.id,
          targetKey: `question:${item.id}`
        }), purpose))
      .slice(0, CONTEXT_SECTION_LIMITS.thoughts)
      .map((root, index) => {
        const children = list(store?.thoughts).filter(item => (
          item.relatedTo === root.id
          && item.authorType !== "ai"
          && contextAllowed(store, item, sourceRef("thought", item, {
            rootId: root.id,
            targetKey: `${item.type}:${item.id}`
          }), purpose)
        ));
        const ideas = children.filter(item => item.type === "idea");
        const records = children.filter(item => item.type === "record");
        const answers = children.filter(item => item.type === "answer");
        const text = `${index + 1}. 用户问题：${safeText(root.content, 500)}\n用户初步想法：${ideas.map(item => safeText(item.content, 500)).join("\n") || "（无）"}\n用户后续记录：${records.map(item => safeText(item.content, 500)).join("\n") || "（无）"}\n用户亲自写下的回答：${answers.map(item => safeText(item.content, 500)).join("\n") || "（无）"}\n标签：${(root.tags || []).join("、") || "（无）"}`;
        return {
          text,
          sources: [
            contextSource(root, {
              resourceType: "thought",
              recordType: "思绪问题",
              informationType: "user_viewpoint",
              text: root.content,
              view: "thoughts",
              rootId: root.id,
              targetKey: `question:${root.id}`
            }),
            ...children.map(item => contextSource(item, {
              resourceType: "thought",
              recordType: item.type === "idea" ? "初步想法" : item.type === "record" ? "思绪记录" : "用户回答",
              informationType: "user_viewpoint",
              text: item.content,
              view: "thoughts",
              rootId: root.id,
              targetKey: `${item.type}:${item.id}`
            }))
          ]
        };
      })
  };
  return sections;
}

function renderPersonalPrompt(onboarding, sections) {
  const originalThoughts = sections.thoughts.map(entry => entry.text).join("\n\n");
  const focus = [...new Set(sections.thoughts.flatMap(entry => {
    const match = entry.text.match(/\n标签：(.*)$/);
    return match && match[1] !== "（无）" ? match[1].split("、") : [];
  }))].slice(0, 8);
  return renderPrompt("context.personal", {
    onboarding: onboarding.prompt,
    focus: focus.length ? focus.join("、") : "尚未形成",
    checkins: sections.checkins.map(entry => entry.text).join("\n") || "（暂无）",
    dailyRecords: sections.dailyRecords.map(entry => entry.text).join("\n") || "（暂无）",
    captures: sections.captures.map(entry => entry.text).join("\n") || "（暂无）",
    journals: sections.journals.map(entry => entry.text).join("\n\n") || "（暂无）",
    thoughts: originalThoughts || "（暂无）"
  });
}

function receiptFor(prompt, sources, generatedAt, tokenLimit, permissionPurpose) {
  const dates = sources.map(source => source.occurredOn).filter(Boolean).sort();
  const estimatedUsed = estimatePersonalContextTokens(prompt);
  return {
    version: PERSONAL_CONTEXT_PROJECTION_VERSION,
    ...(permissionPurpose === "learning" ? { permissionPurpose } : {}),
    generatedAt,
    promptSha256: crypto.createHash("sha256").update(prompt).digest("hex"),
    timeWindow: { from: dates[0] || "", to: dates.at(-1) || "" },
    tokenBudget: {
      limit: tokenLimit,
      estimatedUsed,
      remaining: Math.max(0, tokenLimit - estimatedUsed),
      estimation: "utf8-byte-upper-bound-v1"
    },
    sourceCount: sources.length,
    sources
  };
}

function permissionRevisionFor(store, source) {
  const sourceKey = evidenceSourceKey({
    resourceType: source?.resourceType,
    resourceId: source?.resourceId,
    rootId: source?.location?.rootId || "",
    targetKey: source?.location?.targetKey || "",
    version: Math.max(1, Math.round(Number(source?.version) || 1))
  });
  if (!sourceKey) return 0;
  const permissions = list(store?.evidencePermissions)
    .filter(permission => permission?.sourceKey === sourceKey);
  return permissions.length === 1
    ? Math.max(0, Math.round(Number(permissions[0].revision) || 0))
    : 0;
}

export function personalContextReceiptFingerprint(receipt) {
  return JSON.stringify({
    version: receipt?.version || "",
    ...(receipt?.permissionPurpose === "learning"
      ? { permissionPurpose: "learning" }
      : {}),
    tokenLimit: receipt?.tokenBudget?.limit || 0,
    promptSha256: receipt?.promptSha256 || "",
    sources: list(receipt?.sources).map(source => ({
      id: source.id,
      version: Math.max(1, Math.round(Number(source.version) || 1)),
      contentSha256: safeText(source.contentSha256, 64),
      permissionRevision: Math.max(0, Math.round(Number(source.permissionRevision) || 0))
    }))
  });
}

export function compactPersonalContextReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  return {
    ...structuredClone(receipt),
    sources: list(receipt.sources).map(({ excerpt: _excerpt, ...source }) => source)
  };
}

export function personalContextReceiptMatches(store, receipt) {
  if (!receipt || typeof receipt !== "object") return false;
  const current = personalContextProjection(store, {
    tokenLimit: receipt.tokenBudget?.limit || PERSONAL_CONTEXT_TOKEN_BUDGET,
    permissionPurpose: receipt.permissionPurpose || "context"
  }).receipt;
  return personalContextReceiptFingerprint(current) === personalContextReceiptFingerprint(receipt);
}

function recentConclusions(sources) {
  const groups = [
    {
      id: "recent-viewpoints",
      title: "近期留下的思考",
      informationType: "user_viewpoint",
      records: sources.filter(source => source.informationType === "user_viewpoint" && source.resourceType !== "onboarding").slice(0, 6),
      note: "逐条呈现近期原文，不把重复主题自动提升为人格判断。"
    },
    {
      id: "recent-facts",
      title: "近期状态与健康记录",
      informationType: "user_fact",
      records: sources.filter(source => source.informationType === "user_fact" && source.resourceType !== "onboarding").slice(0, 6),
      note: "只描述已记录的数据；缺失记录不代表没有发生。"
    }
  ];
  return groups.filter(group => group.records.length).map(group => ({
    id: group.id,
    informationType: group.informationType,
    informationTypeLabel: INFORMATION_TYPE_LABELS[group.informationType],
    title: group.title,
    text: group.records.map(source => `${source.occurredOn || "时间未记"} · ${source.recordType}：${source.excerpt}`).join("\n"),
    sourceIds: group.records.map(source => source.id),
    sampleNote: group.note
  }));
}

export function personalContextProjection(store, {
  generatedAt = new Date().toISOString(),
  tokenLimit = PERSONAL_CONTEXT_TOKEN_BUDGET,
  permissionPurpose = "context"
} = {}) {
  permissionPurpose = permissionPurpose === "learning" ? "learning" : "context";
  tokenLimit = Math.max(1200, Math.round(Number(tokenLimit) || PERSONAL_CONTEXT_TOKEN_BUDGET));
  const onboarding = permissionPurpose === "learning"
    ? { prompt: "", sources: [], conclusions: [] }
    : onboardingProjection(store);
  const userModel = permissionPurpose === "learning"
    ? { prompt: "", sources: [], conclusions: [] }
    : userModelContextProjection(store);
  const syntheses = permissionPurpose === "learning"
    ? { prompt: "", sources: [], conclusions: [] }
    : confirmedSynthesisProjection(store);
  onboarding.prompt = [
    onboarding.prompt,
    userModel.prompt,
    syntheses.prompt
  ].filter(Boolean).join("\n");
  onboarding.sources.push(...userModel.sources);
  onboarding.sources.push(...syntheses.sources);
  onboarding.conclusions.push(...userModel.conclusions);
  onboarding.conclusions.push(...syntheses.conclusions);
  const projectionStore = permissionPurpose === "learning"
    ? { ...store, thoughts: learningThoughtSelection(store) }
    : store;
  const sections = contextEntries(projectionStore, permissionPurpose);
  let prompt = renderPersonalPrompt(onboarding, sections);
  while (estimatePersonalContextTokens(prompt) > tokenLimit) {
    const removable = CONTEXT_REMOVAL_ORDER.find(key => sections[key].length);
    if (removable) sections[removable].pop();
    else if (onboarding.prompt.length) onboarding.prompt = onboarding.prompt.slice(0, Math.max(0, onboarding.prompt.length - 500));
    else break;
    prompt = renderPersonalPrompt(onboarding, sections);
  }
  const sourceCandidates = [
    ...onboarding.sources,
    ...Object.values(sections).flatMap(entries => entries.flatMap(entry => entry.sources)),
    ...(permissionPurpose === "learning" ? learningReceiptSources(projectionStore) : [])
  ];
  const sources = [...new Map(sourceCandidates.map(source => [source.id, source])).values()]
    .map(source => ({
      ...source,
      permissionRevision: permissionRevisionFor(store, source)
    }));
  const receipt = receiptFor(prompt, sources, generatedAt, tokenLimit, permissionPurpose);
  return {
    prompt,
    receipt,
    overview: {
      ...receipt,
      conclusions: [...onboarding.conclusions, ...recentConclusions(sources)],
      disclosure: "概要由当前账户内仍有效的记录实时投影；用于 AI 回答时，这些摘录会发送给当前配置的模型供应商。",
      readOnly: true
    }
  };
}

export function diaryActivityContext(store, occurredOn) {
  const previousDate = shiftDateKey(occurredOn, -1);
  const describeDate = date => {
    const checkins = list(store?.checkins).filter(item => (
      item.occurredOn === date
      && contextAllowed(store, item, sourceRef("checkin", item))
    )).slice(0, 5).map(item => `状态：情绪${item.mood}/精力${item.energy}/压力状态${item.stress}/睡眠${item.sleep}${item.factors?.length ? `；因素：${item.factors.join("、")}` : ""}`);
    const dailyRecords = list(store?.dailyRecords).filter(item => (
      item.occurredOn === date
      && contextAllowed(store, item, sourceRef("dailyRecord", item))
    )).slice(0, 8).map(describeDailyRecord);
    const captures = list(store?.captures).filter(item => (
      item.occurredOn === date
      && contextAllowed(store, item, sourceRef("capture", item))
    )).slice(0, 8).map(item => `捕念：${item.content}`);
    const journals = list(store?.journals).filter(item => (
      item.occurredOn === date
      && contextAllowed(store, item, sourceRef("journal", item))
    )).slice(0, 3).map(item => `日记${item.title ? `《${item.title}》` : ""}：${item.content}`);
    const thoughts = list(store?.thoughts).filter(item => (
      item.type === "question"
      && item.occurredOn === date
      && contextAllowed(store, item, sourceRef("thought", item, {
        rootId: item.id,
        targetKey: `question:${item.id}`
      }))
    )).slice(0, 8).map(item => `思绪：${item.content}`);
    return [...checkins, ...dailyRecords, ...captures, ...journals, ...thoughts].join("\n") || "（暂无记录）";
  };
  const recent = [
    ...list(store?.captures).filter(item => (
      contextAllowed(store, item, sourceRef("capture", item))
    )).map(item => ({ date: item.occurredOn, text: `捕念：${item.content}` })),
    ...list(store?.journals).filter(item => (
      contextAllowed(store, item, sourceRef("journal", item))
    )).map(item => ({ date: item.occurredOn, text: `日记${item.title ? `《${item.title}》` : ""}：${item.content}` })),
    ...list(store?.thoughts).filter(item => (
      item.type === "question"
      && contextAllowed(store, item, sourceRef("thought", item, {
        rootId: item.id,
        targetKey: `question:${item.id}`
      }))
    )).map(item => ({ date: item.occurredOn, text: `思绪：${item.content}` }))
  ].filter(item => item.date <= occurredOn).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 16).map(item => `${item.date} ${item.text}`).join("\n");
  return renderPrompt("context.diaryActivity", {
    selectedDate: occurredOn, todayRecords: describeDate(occurredOn), previousDate,
    previousDayRecords: describeDate(previousDate), recentRecords: recent || "（暂无记录）"
  });
}

export function thoughtPromptContext(store, occurredOn) {
  const entries = [
    ...list(store?.captures).filter(item => (
      contextAllowed(store, item, sourceRef("capture", item))
    )).map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `捕念：${safeText(item.content, 500)}` })),
    ...list(store?.journals).filter(item => (
      contextAllowed(store, item, sourceRef("journal", item))
    )).map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `日记${item.title ? `《${safeText(item.title, 80)}》` : ""}：${safeText(item.content, 700)}` })),
    ...list(store?.thoughts).filter(item => (
      item.type === "question"
      && contextAllowed(store, item, sourceRef("thought", item, {
        rootId: item.id,
        targetKey: `question:${item.id}`
      }))
    )).map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `曾经的问题：${safeText(item.content, 500)}` })),
    ...list(store?.chats).map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `长期对话中的提问：${safeText(item.message, 500)}` })),
    ...list(store?.checkins).filter(item => (
      contextAllowed(store, item, sourceRef("checkin", item))
    )).map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: `状态：情绪${item.mood}/精力${item.energy}/压力状态${item.stress}/睡眠${item.sleep}${item.factors?.length ? `；因素：${item.factors.map(value => safeText(value, 40)).join("、")}` : ""}` })),
    ...list(store?.dailyRecords).filter(item => (
      contextAllowed(store, item, sourceRef("dailyRecord", item))
    )).map(item => ({ date: item.occurredOn, time: item.occurredAt || item.createdAt, text: describeDailyRecord(item) }))
  ].filter(item => item.date && item.date <= occurredOn).sort((a, b) => b.time.localeCompare(a.time)).slice(0, 12);
  return {
    hasHistory: entries.length > 0,
    text: entries.length ? entries.map((item, index) => `${index + 1}. ${item.date} ${item.text}`).join("\n") : "（没有历史记录）"
  };
}

export function userAnswerContext(store) {
  return personalContextProjection(store).prompt;
}

export function thoughtAnswerPrompt(context, chain, followUp = false) {
  return userPrompt({ context, chain, task: thoughtTask(followUp ? "followUp" : "answer") });
}

export function prepareThoughtAnswer(store, root, currentFollowUpId = "") {
  const chain = thoughtChainContext(store.thoughts, root, currentFollowUpId);
  return thoughtAnswerPrompt(userAnswerContext(store), chain, Boolean(currentFollowUpId));
}
