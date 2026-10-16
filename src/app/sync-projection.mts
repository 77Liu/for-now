/**
 * 声明同步按域投影的实际读取依赖；不表示一份完整业务仓库。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：未知域由仓储在同一快照全读回退，缺失依赖不得当空集合。
 */
const insightDomains = new Set(["checkins", "dailyRecords", "captures", "journals", "thoughts", "books", "quotes", "experiments", "analyses"]);
const insightFields = ["checkins", "dailyRecords", "captures", "journals", "thoughts", "chats", "quotes", "books", "keepsakes", "analyses"];
// 感知生产者的权限与事件按各自正式normalizer校验；公共投影显式剥离它们，但不能丢弃游标变化。
const internalDomains = ["evidencePermissions", "perceptionEvents"];
const supported = new Set([...insightDomains, ...internalDomains, "journalDraft", "chats", "keepsakes", "customMetrics", "aiTasks", "notifications", "actions", "habits", "habitCheckins", "feedback", "validationLedger", "userClaims", "modelUnknowns", "onboarding", "onboardingV2", "commercialization", "trash", "speechCache"]);

/** 同步域是否要求既有统计与思绪聚类；输出含其全部真实来源。 @since unreleased */
export function syncNeedsInsights(domains: Iterable<string>): boolean {
  return [...domains].some(domain => insightDomains.has(domain));
}

/** 返回投影与规范化的完整字段闭包；内部域保留真实集合参与校验，不进入公共输出。
 * 未知域返回null，明确要求同一快照原完整读取。 @since unreleased
 */
export function syncProjectionFields(domains: string[]): string[] | null {
  if (domains.some(domain => !supported.has(domain))) return null;
  const fields = new Set(["version", ...domains]);
  if (syncNeedsInsights(domains)) for (const field of insightFields) fields.add(field);
  if (fields.has("journalDraft")) fields.add("journals");
  if (fields.has("onboardingV2")) fields.add("onboarding");
  if (fields.has("notifications") || fields.has("aiTasks")) { fields.add("notifications"); fields.add("aiTasks"); }
  if (fields.has("speechCache")) { fields.add("captures"); fields.add("thoughts"); fields.add("trash"); }
  return [...fields];
}
