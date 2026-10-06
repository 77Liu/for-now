import { contextSourceMarkup } from "./sources.mjs";

export const PERSONAL_CONTEXT_SELECTORS = Object.freeze({
  status: "#personal-context-status",
  meta: "#personal-context-meta",
  disclosure: "#personal-context-disclosure",
  summary: "#personal-context-summary",
  sourceCount: "#personal-context-source-count",
  sourceList: "#personal-context-source-list",
  retry: '[data-content-action="retry-personal-context"]',
  source: "[data-context-source]"
});

const query = (root, selector) => root.querySelector?.(selector) || null;

function sourceMarkup(source, options) {
  return contextSourceMarkup(source, {
    snapshot: options.snapshot,
    escapeMarkup: options.escapeMarkup,
    plainPreview: options.plainPreview
  });
}

export function renderPersonalContextSurface({
  root,
  data,
  loadState,
  snapshot,
  contentState,
  escapeMarkup,
  plainPreview,
  formatDate
}) {
  const summary = query(root, PERSONAL_CONTEXT_SELECTORS.summary);
  if (!summary) return false;
  const status = query(root, PERSONAL_CONTEXT_SELECTORS.status);
  const meta = query(root, PERSONAL_CONTEXT_SELECTORS.meta);
  const disclosure = query(root, PERSONAL_CONTEXT_SELECTORS.disclosure);
  const sourceCount = query(root, PERSONAL_CONTEXT_SELECTORS.sourceCount);
  const sourceList = query(root, PERSONAL_CONTEXT_SELECTORS.sourceList);
  const sources = Array.isArray(data?.sources) ? data.sources : [];

  if (!data) {
    if (meta) meta.innerHTML = "";
    if (disclosure) disclosure.textContent = "";
    if (sourceCount) sourceCount.textContent = "0 条";
    if (sourceList) sourceList.innerHTML = "";
    summary.innerHTML = loadState === "failure"
      ? contentState({
        kind: "failure",
        title: "暂时无法核对个人概要",
        body: "原始记录没有被修改。请检查网络后重试。",
        action: {
          command: "retry-personal-context",
          label: "重新核对"
        }
      })
      : contentState({
        kind: "loading",
        title: "正在核对个人概要",
        body: "只读取当前账户中仍然有效的来源。"
      });
    return true;
  }

  const sourceById = new Map(sources.map(source => [source?.id, source]));
  const budget = data.tokenBudget;
  const windowLabel = data.timeWindow?.from
    ? `${data.timeWindow.from}${
      data.timeWindow.to && data.timeWindow.to !== data.timeWindow.from
        ? ` 至 ${data.timeWindow.to}`
        : ""
    }`
    : "尚无记录";
  if (meta) {
    meta.innerHTML = [
      ["版本", data.version || "未标记"],
      ["时间窗", windowLabel],
      ["来源", `${Number(data.sourceCount) || 0} 条`],
      [
        "Token 上界",
        budget
          ? `${Number(budget.estimatedUsed) || 0} / ${Number(budget.limit) || 0}`
          : "未估算"
      ]
    ].map(([label, value]) => (
      `<div><span>${escapeMarkup(label)}</span><strong>${escapeMarkup(value)}</strong></div>`
    )).join("");
  }
  if (disclosure) disclosure.textContent = data.disclosure || "";
  if (sourceCount) {
    sourceCount.textContent = `${sources.length} 条 · 生成于 ${formatDate(data.generatedAt)}`;
  }
  if (sourceList) {
    sourceList.innerHTML = sources.length
      ? `<div class="context-source-list">${
        sources.map(source => sourceMarkup(source, {
          snapshot,
          escapeMarkup,
          plainPreview
        })).join("")
      }</div>`
      : contentState({
        title: "还没有可用来源",
        body: "先留下记录并明确允许使用，来源才会出现在这里。",
        action: { view: "captures", label: "留一条记录" }
      });
  }

  const conclusions = Array.isArray(data.conclusions) ? data.conclusions : [];
  summary.innerHTML = conclusions.length
    ? conclusions.map(item => {
      const evidence = item?.sourceIds
        ?.map(id => sourceById.get(id))
        .filter(Boolean) || [];
      return `<details class="personal-context-conclusion" data-context-type="${
        escapeMarkup(item?.informationType || "")
      }"><summary><div><span>${
        escapeMarkup(item?.informationTypeLabel || "")
      }</span><strong>${
        escapeMarkup(item?.title || "")
      }</strong></div><small>${
        evidence.length
      } 条来源</small></summary><div class="personal-context-conclusion-body"><p>${
        escapeMarkup(item?.text || "").replace(/\n/g, "<br>")
      }</p><small>${
        escapeMarkup(item?.sampleNote || "")
      }</small>${
        evidence.length
          ? `<div class="context-source-list">${
            evidence.map(source => sourceMarkup(source, {
              snapshot,
              escapeMarkup,
              plainPreview
            })).join("")
          }</div>`
          : ""
      }</div></details>`;
    }).join("")
    : contentState({
      title: "记录还不足以形成概要",
      body: "这很正常，概要会随已确认的来源逐步更新。",
      action: { view: "captures", label: "继续记录" }
    });
  if (status) status.textContent = "";
  return true;
}

export function scrubPersonalContextSurface(root) {
  const status = query(root, PERSONAL_CONTEXT_SELECTORS.status);
  const meta = query(root, PERSONAL_CONTEXT_SELECTORS.meta);
  const disclosure = query(root, PERSONAL_CONTEXT_SELECTORS.disclosure);
  const summary = query(root, PERSONAL_CONTEXT_SELECTORS.summary);
  const sourceCount = query(root, PERSONAL_CONTEXT_SELECTORS.sourceCount);
  const sourceList = query(root, PERSONAL_CONTEXT_SELECTORS.sourceList);
  if (status) status.textContent = "";
  if (meta) meta.innerHTML = "";
  if (disclosure) disclosure.textContent = "";
  if (summary) summary.innerHTML = "";
  if (sourceCount) sourceCount.textContent = "0 条";
  if (sourceList) sourceList.innerHTML = "";
}
