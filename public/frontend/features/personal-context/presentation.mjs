import { contextSourceMarkup } from "./sources.mjs";

export const PERSONAL_CONTEXT_SELECTORS = Object.freeze({
  status: "#personal-context-status",
  meta: "#personal-context-meta",
  disclosure: "#personal-context-disclosure",
  summary: "#personal-context-summary",
  recordTrend: "#personal-context-record-trend",
  recordTrendDisclosure: "#personal-context-record-trend-disclosure",
  claims: "#personal-context-claims",
  permissions: "#personal-context-permissions",
  permissionsMore: "#personal-context-permissions-more",
  syntheses: "#personal-context-syntheses",
  synthesisStatus: "#personal-context-synthesis-status",
  runSynthesis: "#personal-context-run-synthesis",
  sourceCount: "#personal-context-source-count",
  sourceList: "#personal-context-source-list",
  retry: '[data-content-action="retry-personal-context"]',
  source: "[data-context-source]",
  claimAction: "[data-claim-action]",
  claimForm: "[data-claim-form]",
  permissionToggle: "[data-permission-field]",
  synthesisAction: "[data-synthesis-action]"
});

const query = (root, selector) => root.querySelector?.(selector) || null;

function sourceMarkup(source, options) {
  return contextSourceMarkup(source, {
    snapshot: options.snapshot,
    escapeMarkup: options.escapeMarkup,
    plainPreview: options.plainPreview
  });
}

const CLAIM_LIFECYCLE_LABELS = Object.freeze({
  candidate: "待确认",
  active: "正在使用",
  disputed: "来源已变化",
  stale: "来源已变化"
});

function claimMarkup(claim, escapeMarkup) {
  const id = escapeMarkup(claim?.id || "");
  const version = Number(claim?.version) || 1;
  const lifecycle = claim?.lifecycle || "candidate";
  const label = CLAIM_LIFECYCLE_LABELS[lifecycle] || lifecycle;
  const editable = ["candidate", "active"].includes(lifecycle);
  const primaryAction = lifecycle === "candidate" ? "confirm" : "revise";
  const primaryLabel = lifecycle === "candidate" ? "确认采用" : "保存修正";
  const secondaryAction = lifecycle === "candidate" ? "reject" : "retract";
  const secondaryLabel = lifecycle === "candidate" ? "不用这条" : "撤回";
  return `<article class="personal-context-governance-item" data-claim-id="${id}" data-claim-lifecycle="${
    escapeMarkup(lifecycle)
  }" data-claim-version="${version}"><header><span>${escapeMarkup(claim?.domainLabel || claim?.domain || "理解")}</span><b>${
    escapeMarkup(label)
  }</b></header>${editable
    ? `<form data-claim-form="${id}" data-claim-primary-action="${primaryAction}"><label><span>理解内容</span><textarea name="statement" maxlength="1000" required>${escapeMarkup(
      claim?.statement || ""
    )}</textarea></label><label><span>适用范围</span><input name="scope" maxlength="500" value="${
      escapeMarkup(claim?.scope || "")
    }"></label><label><span>认识状态</span><select name="epistemic"><option value="known"${
      claim?.epistemic === "known" ? " selected" : ""
    }>我确认的事实</option><option value="hypothesis"${
      claim?.epistemic === "hypothesis" ? " selected" : ""
    }>待验证理解</option></select></label><label class="personal-context-toggle"><input name="contextAllowed" type="checkbox"${
      claim?.contextAllowed === false ? "" : " checked"
    }><span>用于后续回答</span></label><footer><button class="primary-button" type="submit" data-claim-action="${
      primaryAction
    }" data-version="${version}">${primaryLabel}</button><button class="subtle-action danger" type="button" data-claim-action="${
      secondaryAction
    }" data-version="${version}">${secondaryLabel}</button></footer><p class="status" data-claim-status role="status" aria-live="polite"></p></form>`
    : `<p>${lifecycle === "disputed"
      ? "对应原文已经变化，这条理解不会继续用于回答。"
      : "对应原文已经变化，请重新整理后再确认。"
    }</p>${["disputed", "stale"].includes(lifecycle)
      ? `<button class="subtle-action danger" type="button" data-claim-action="${
        lifecycle === "stale" ? "reject" : "retract"
      }" data-version="${version}">${lifecycle === "stale" ? "不用这条" : "撤回"}</button>`
      : ""
    }<p class="status" data-claim-status role="status" aria-live="polite"></p>`
  }</article>`;
}

function permissionMarkup(permission, index, escapeMarkup) {
  const disabled = permission?.status !== "active";
  const state = permission?.status === "deleted"
    ? "记录在回收站中，恢复后仍保持关闭"
    : permission?.status === "active"
      ? permission?.learningStatus === "failed"
        ? "学习更新失败，可重新关闭后再开启"
        : "许可更改会立即使旧派生依据失效"
      : "来源当前不可用";
  return `<article class="personal-context-governance-item" data-permission-index="${index}"><header><span>${
    escapeMarkup(permission?.recordType || "原始记录")
  }</span><b>版本 ${Number(permission?.sourceRef?.version) || 1}</b></header><p>${
    escapeMarkup(permission?.excerpt || state)
  }</p><fieldset ${disabled ? "disabled" : ""}><legend>允许范围</legend><label class="personal-context-toggle"><input type="checkbox" data-permission-field="contextAllowed"${
    permission?.contextAllowed ? " checked" : ""
  }><span>用于后续回答</span></label><label class="personal-context-toggle"><input type="checkbox" data-permission-field="learningAllowed"${
    permission?.learningAllowed ? " checked" : ""
  }><span>允许形成或更新理解</span></label></fieldset><small>${escapeMarkup(state)}</small><p class="status" data-permission-status role="status" aria-live="polite"></p></article>`;
}

function synthesisMarkup(item, escapeMarkup, plainPreview, formatDate) {
  const id = escapeMarkup(item?.id || "");
  const version = Number(item?.version) || 1;
  const status = item?.reviewStatus === "confirmed"
    ? "已确认"
    : item?.reviewStatus === "rejected"
      ? "已拒绝"
      : item?.reviewStatus === "stale"
        ? "来源已变化"
        : item?.reviewStatus === "candidate"
          ? "待确认"
          : "历史复盘";
  const actions = item?.reviewStatus === "candidate"
    ? `<footer><button class="quiet-button" type="button" data-synthesis-action="confirm" data-synthesis-id="${id}" data-version="${version}">确认已核对</button><button class="subtle-action danger" type="button" data-synthesis-action="reject" data-synthesis-id="${id}" data-version="${version}">拒绝</button></footer>`
    : "";
  return `<article class="personal-context-governance-item" data-synthesis-id="${id}"><header><time>${
    escapeMarkup(formatDate(item?.createdAt))
  }</time><b>${escapeMarkup(status)}</b></header><p>${escapeMarkup(
    plainPreview(item?.content || "")
  )}</p>${actions}<p class="status" data-synthesis-item-status role="status" aria-live="polite"></p></article>`;
}

function recordTrendMarkup(trend, options) {
  if (!trend || !Array.isArray(trend.days) || !trend.days.length) {
    return options.contentState({
      title: "近七日整理暂不可用",
      body: "当前账户还没有可核验的七日窗口。"
    });
  }
  const sourceMarkup = source => contextSourceMarkup(source, {
    snapshot: options.snapshot,
    escapeMarkup: options.escapeMarkup,
    plainPreview: options.plainPreview
  });
  const rowMarkup = (row, label) => `<div class="personal-context-conclusion-body"><p><b>${
    options.escapeMarkup(label)
  }：</b>${options.escapeMarkup(row.text)}</p><div class="context-source-list">${
    row.sources.map(sourceMarkup).join("")
  }</div></div>`;
  const coverage = trend.coverage || {};
  return `<div class="record-compression-coverage"><strong>${
    Number(coverage.summaryDays) || 0
  } / ${Number(coverage.windowDays) || trend.days.length} 天有有效整理 · ${
    options.escapeMarkup(trend.timezone || "记录时区未设置")
  }</strong><span>缺失日期：${
    coverage.missingDates.length
      ? coverage.missingDates.map(options.escapeMarkup).join("、")
      : "无"
  } · ${
    Number(coverage.partialDays) || 0
  } 天部分覆盖 · ${Number(coverage.truncatedDays) || 0} 天达到输入上限</span></div>${
    trend.days.map(day => {
      const missing = day.status !== "ready";
      const sections = [
        ...day.daily.map(row => rowMarkup(row, "当日记录")),
        ...day.thoughts.map(row => rowMarkup(row, "思绪")),
        ...day.themes.map(row => rowMarkup(row, "其他主题")),
        ...day.metrics.map(metric => rowMarkup({
          text: `${metric.name}：${metric.value}${metric.unit ? ` ${metric.unit}` : ""}`,
          sources: metric.sources
        }, "记录指标"))
      ].join("");
      return `<details class="personal-context-conclusion record-compression-day" data-record-compression-date="${
        options.escapeMarkup(day.localDate)
      }"><summary><div><span>${options.escapeMarkup(day.localDate)}</span><strong>${
        missing ? "暂无有效整理" : day.completeness === "partial" ? "部分覆盖" : "已整理"
      }</strong></div><small>${missing ? "缺失日期" : sections ? "查看整理与来源" : "没有可展示的获准条目"}</small></summary>${
        missing
          ? `<p class="personal-context-conclusion-body">这一天没有当前有效且获准使用的日摘要。</p>`
          : sections
      }</details>`;
    }).join("")
  }`;
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
  const recordTrend = query(root, PERSONAL_CONTEXT_SELECTORS.recordTrend);
  const recordTrendDisclosure = query(root, PERSONAL_CONTEXT_SELECTORS.recordTrendDisclosure);
  if (!summary) return false;
  const status = query(root, PERSONAL_CONTEXT_SELECTORS.status);
  const meta = query(root, PERSONAL_CONTEXT_SELECTORS.meta);
  const disclosure = query(root, PERSONAL_CONTEXT_SELECTORS.disclosure);
  const claims = query(root, PERSONAL_CONTEXT_SELECTORS.claims);
  const permissions = query(root, PERSONAL_CONTEXT_SELECTORS.permissions);
  const permissionsMore = query(root, PERSONAL_CONTEXT_SELECTORS.permissionsMore);
  const syntheses = query(root, PERSONAL_CONTEXT_SELECTORS.syntheses);
  const runSynthesis = query(root, PERSONAL_CONTEXT_SELECTORS.runSynthesis);
  const sourceCount = query(root, PERSONAL_CONTEXT_SELECTORS.sourceCount);
  const sourceList = query(root, PERSONAL_CONTEXT_SELECTORS.sourceList);
  const sources = Array.isArray(data?.sources) ? data.sources : [];

  if (!data) {
    if (meta) meta.innerHTML = "";
    if (disclosure) disclosure.textContent = "";
    if (claims) claims.innerHTML = "";
    if (permissions) permissions.innerHTML = "";
    if (permissionsMore) permissionsMore.hidden = true;
    if (syntheses) syntheses.innerHTML = "";
    if (runSynthesis) runSynthesis.disabled = loadState === "loading";
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
    if (recordTrend) recordTrend.innerHTML = loadState === "failure"
      ? contentState({
        kind: "failure",
        title: "暂时无法读取七日日摘要",
        body: "请重新核对当前账户的权限与来源。",
        action: { command: "retry-personal-context", label: "重新核对" }
      })
      : contentState({
        kind: "loading",
        title: "正在核对七日日摘要",
        body: "只显示当前账户中来源仍有效且获准使用的整理。"
      });
    if (recordTrendDisclosure) recordTrendDisclosure.textContent = "";
    return true;
  }

  const sourceById = new Map(sources.map(source => [source?.id, source]));
  const userClaims = (Array.isArray(data?.userModel?.claims) ? data.userModel.claims : [])
    .filter(claim => ["candidate", "active", "disputed", "stale"].includes(claim?.lifecycle));
  const sourcePermissions = Array.isArray(data?.sourcePermissions)
    ? data.sourcePermissions
    : [];
  const periodicSyntheses = Array.isArray(data?.periodicSyntheses)
    ? data.periodicSyntheses
    : [];
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
  if (claims) {
    claims.innerHTML = userClaims.length
      ? userClaims.map(claim => claimMarkup(claim, escapeMarkup)).join("")
      : contentState({
        title: "还没有待确认的长期理解",
        body: "系统不会把自动整理直接当作关于你的事实。"
      });
  }
  if (permissions) {
    permissions.innerHTML = sourcePermissions.length
      ? sourcePermissions.map((permission, index) => (
        permissionMarkup(permission, index, escapeMarkup)
      )).join("")
      : contentState({
        title: "还没有可单独设置的来源",
        body: "新的念起、日记和思绪会默认允许用于回答，学习保持关闭。"
      });
  }
  if (permissionsMore) {
    permissionsMore.hidden = !data.sourcePermissionNextCursor;
    permissionsMore.disabled = false;
  }
  if (syntheses) {
    syntheses.innerHTML = periodicSyntheses.length
      ? periodicSyntheses.map(item => (
        synthesisMarkup(item, escapeMarkup, plainPreview, formatDate)
      )).join("")
      : contentState({
        title: "还没有周期回望",
        body: "需要时手动生成；系统不会在后台自动开启。"
      });
  }
  if (runSynthesis) runSynthesis.disabled = false;

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
  if (recordTrendDisclosure) {
    recordTrendDisclosure.textContent = data.recordCompressionTrend?.disclosure || "";
  }
  if (recordTrend) {
    recordTrend.innerHTML = recordTrendMarkup(data.recordCompressionTrend, {
      contentState,
      escapeMarkup,
      plainPreview,
      snapshot
    });
  }
  if (status) status.textContent = "";
  return true;
}

export function scrubPersonalContextSurface(root) {
  const status = query(root, PERSONAL_CONTEXT_SELECTORS.status);
  const meta = query(root, PERSONAL_CONTEXT_SELECTORS.meta);
  const disclosure = query(root, PERSONAL_CONTEXT_SELECTORS.disclosure);
  const summary = query(root, PERSONAL_CONTEXT_SELECTORS.summary);
  const recordTrend = query(root, PERSONAL_CONTEXT_SELECTORS.recordTrend);
  const recordTrendDisclosure = query(root, PERSONAL_CONTEXT_SELECTORS.recordTrendDisclosure);
  const claims = query(root, PERSONAL_CONTEXT_SELECTORS.claims);
  const permissions = query(root, PERSONAL_CONTEXT_SELECTORS.permissions);
  const permissionsMore = query(root, PERSONAL_CONTEXT_SELECTORS.permissionsMore);
  const syntheses = query(root, PERSONAL_CONTEXT_SELECTORS.syntheses);
  const synthesisStatus = query(root, PERSONAL_CONTEXT_SELECTORS.synthesisStatus);
  const runSynthesis = query(root, PERSONAL_CONTEXT_SELECTORS.runSynthesis);
  const sourceCount = query(root, PERSONAL_CONTEXT_SELECTORS.sourceCount);
  const sourceList = query(root, PERSONAL_CONTEXT_SELECTORS.sourceList);
  if (status) status.textContent = "";
  if (meta) meta.innerHTML = "";
  if (disclosure) disclosure.textContent = "";
  if (summary) summary.innerHTML = "";
  if (recordTrend) recordTrend.innerHTML = "";
  if (recordTrendDisclosure) recordTrendDisclosure.textContent = "";
  if (claims) claims.innerHTML = "";
  if (permissions) permissions.innerHTML = "";
  if (permissionsMore) {
    permissionsMore.hidden = true;
    permissionsMore.disabled = false;
  }
  if (syntheses) syntheses.innerHTML = "";
  if (synthesisStatus) synthesisStatus.textContent = "";
  if (runSynthesis) runSynthesis.disabled = false;
  if (sourceCount) sourceCount.textContent = "0 条";
  if (sourceList) sourceList.innerHTML = "";
}
