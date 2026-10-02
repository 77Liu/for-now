const QUESTION_IDS = ["currentContext", "desiredChanges", "recentObstacles", "dailyRhythm", "collaboration"];
const QUESTION_STEPS = ["q1", "q2", "q3", "q4", "q5"];
const STEP_TITLES = ["现在的生活", "希望的变化", "最近的困扰", "日常节奏", "怎么帮助"];
const DOMAIN_LABELS = {
  context: "处境",
  goals: "目标",
  state: "状态",
  behavior: "行为",
  mind: "认知",
  values: "价值",
  relationships: "关系",
  collaboration: "协作"
};
const HORIZONS = [
  ["unknown", "期限未定"],
  ["3m", "未来 3 个月"],
  ["6m", "未来 6 个月"],
  ["12m", "未来 12 个月"],
  ["custom", "自定义"]
];
const AXES = {
  responseLength: {
    title: "回答长度",
    values: [["concise", "简洁"], ["balanced", "适中"], ["expanded", "展开"]]
  },
  suggestionMode: {
    title: "建议形式",
    values: [["actionFirst", "先给行动"], ["reasonFirst", "先理清原因"]]
  },
  challengeStyle: {
    title: "讨论方式",
    values: [["gentle", "温和讨论"], ["direct", "直接指出疑点"]]
  }
};

const clone = value => structuredClone(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
})[character]);
const resourceVersion = value => Math.max(0, Number(value?.session?.revision) || 0) + 1;
const currentIso = () => new Date().toISOString();
const newId = () => globalThis.crypto?.randomUUID?.()
  || `onboarding-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function defaultCollaboration() {
  return {
    responseLength: { value: "balanced", source: "system_default" },
    suggestionMode: { value: "actionFirst", source: "system_default" },
    challengeStyle: { value: "gentle", source: "system_default" },
    additionalBoundary: "",
    contextAllowed: true
  };
}

function answerInput(answer) {
  if (!answer) return null;
  return {
    ...(own(answer, "rawText") ? { rawText: answer.rawText } : {}),
    ...(own(answer, "structuredValue") ? { structuredValue: clone(answer.structuredValue) } : {}),
    ...(answer.occurredAt ? { occurredAt: answer.occurredAt } : {}),
    contextAllowed: answer.contextAllowed !== false
  };
}

function collaborationInput(collaboration = {}) {
  const result = {
    additionalBoundary: String(collaboration.additionalBoundary || ""),
    contextAllowed: collaboration.contextAllowed !== false
  };
  for (const [key, definition] of Object.entries(AXES)) {
    const axis = collaboration[key];
    result[key] = axis?.source === "user" && definition.values.some(([value]) => value === axis.value)
      ? { value: axis.value, source: "user" }
      : null;
  }
  return result;
}

export function onboardingV2DraftFromState(value, { owner = "" } = {}) {
  const session = value?.session || {};
  return {
    id: "onboarding-v2",
    owner,
    baseRevision: Math.max(0, Number(session.revision) || 0),
    status: ["draft", "paused", "completed", "skipped"].includes(session.status) ? session.status : "draft",
    step: QUESTION_STEPS.includes(session.step) || ["welcome", "review", "firstAction"].includes(session.step)
      ? session.step
      : "welcome",
    answers: clone(session.answers || {}),
    collaboration: { ...defaultCollaboration(), ...clone(session.collaboration || {}) },
    localDirty: false,
    pendingSync: false,
    updatedAt: String(session.updatedAt || "")
  };
}

export function onboardingV2PatchFromDraft(draft, {
  questionId = "",
  status = draft?.status || "draft",
  step = draft?.step || "welcome",
  full = false
} = {}) {
  const patch = { selectedFlow: "v2", status, step };
  if (full) {
    patch.answers = Object.fromEntries(QUESTION_IDS.slice(0, 4).map(id => [
      id,
      answerInput(draft?.answers?.[id])
    ]));
    patch.collaboration = collaborationInput(draft?.collaboration);
  } else if (questionId === "collaboration") {
    patch.collaboration = collaborationInput(draft?.collaboration);
  } else if (QUESTION_IDS.includes(questionId)) {
    patch.answers = { [questionId]: answerInput(draft?.answers?.[questionId]) };
  }
  return patch;
}

function answerText(id, draft) {
  if (id === "collaboration") {
    const collaboration = draft?.collaboration || defaultCollaboration();
    const selected = Object.entries(AXES).map(([key, definition]) => {
      const axis = collaboration[key];
      const label = definition.values.find(([value]) => value === axis?.value)?.[1] || "";
      return axis?.source === "user" ? label : "";
    }).filter(Boolean);
    return [
      selected.length ? selected.join(" · ") : "暂用系统默认：适中 · 先给行动 · 温和讨论",
      collaboration.additionalBoundary || ""
    ].filter(Boolean).join("\n");
  }
  const answer = draft?.answers?.[id];
  if (own(answer, "rawText")) return answer.rawText || "";
  return (answer?.structuredValue || []).map(item => {
    const horizon = HORIZONS.find(([value]) => value === item.horizon)?.[1];
    const suffix = item.horizon === "custom" ? item.horizonText : item.horizon !== "unknown" ? horizon : "";
    return suffix ? `${item.text}（${suffix}）` : item.text;
  }).join("\n");
}

export function onboardingV2ConflictRows(serverState, deviceDraft) {
  const serverDraft = onboardingV2DraftFromState(serverState, { owner: deviceDraft?.owner || "" });
  return QUESTION_IDS.map((questionId, index) => ({
    questionId,
    title: STEP_TITLES[index],
    serverText: answerText(questionId, serverDraft),
    deviceText: answerText(questionId, deviceDraft),
    equal: answerText(questionId, serverDraft) === answerText(questionId, deviceDraft)
  }));
}

function onboardingContentMatches(serverState, deviceDraft) {
  const serverDraft = onboardingV2DraftFromState(serverState, { owner: deviceDraft?.owner || "" });
  return JSON.stringify(onboardingV2PatchFromDraft(serverDraft, {
    status: serverDraft.status,
    step: serverDraft.step,
    full: true
  })) === JSON.stringify(onboardingV2PatchFromDraft(deviceDraft, {
    status: deviceDraft.status,
    step: deviceDraft.step,
    full: true
  }));
}

export function mergeOnboardingV2Conflict(serverState, deviceDraft, choices = {}) {
  const serverDraft = onboardingV2DraftFromState(serverState, { owner: deviceDraft?.owner || "" });
  const merged = clone(deviceDraft);
  merged.baseRevision = serverDraft.baseRevision;
  for (const questionId of QUESTION_IDS) {
    const source = choices[questionId] === "server" ? serverDraft : deviceDraft;
    if (questionId === "collaboration") merged.collaboration = clone(source.collaboration);
    else if (source.answers?.[questionId]) merged.answers[questionId] = clone(source.answers[questionId]);
    else delete merged.answers[questionId];
  }
  merged.status = "draft";
  merged.pendingSync = false;
  merged.localDirty = true;
  merged.updatedAt = currentIso();
  return merged;
}

function textAnswerMarkup(questionId, draft, { placeholder, maxLength = 2000 }) {
  const value = draft.answers?.[questionId]?.rawText || "";
  return `<label class="onboarding-v2-answer" for="onboarding-v2-answer">
    <span>你的原话</span>
    <textarea id="onboarding-v2-answer" data-onboarding-answer="${questionId}" maxlength="${maxLength}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>
  </label>`;
}

function desiredChangesMarkup(draft) {
  const values = draft.answers?.desiredChanges?.structuredValue || [];
  return `<div class="onboarding-v2-lines">${[0, 1, 2].map(index => {
    const item = values[index] || {}, horizon = item.horizon || "unknown";
    return `<div class="onboarding-v2-line">
      <label for="onboarding-change-${index}">${index + 1} · 一个方向</label>
      <input id="onboarding-change-${index}" data-onboarding-list="desiredChanges" data-index="${index}" maxlength="300" value="${escapeHtml(item.text || "")}" placeholder="${index ? "可以留空" : "例如：恢复规律作息"}">
      <select data-onboarding-horizon data-index="${index}" aria-label="第 ${index + 1} 项期限">${HORIZONS.map(([value, label]) => `<option value="${value}" ${horizon === value ? "selected" : ""}>${label}</option>`).join("")}</select>
      <input class="onboarding-v2-custom-horizon" data-onboarding-horizon-text data-index="${index}" maxlength="100" value="${escapeHtml(item.horizonText || "")}" placeholder="写下你使用的期限" ${horizon === "custom" ? "" : "hidden"}>
    </div>`;
  }).join("")}</div>`;
}

function obstaclesMarkup(draft) {
  const values = draft.answers?.recentObstacles?.structuredValue || [];
  return `<div class="onboarding-v2-lines">${[0, 1, 2].map(index => `<label class="onboarding-v2-line simple" for="onboarding-obstacle-${index}">
    <span>${index + 1} · 一件困扰</span>
    <input id="onboarding-obstacle-${index}" data-onboarding-list="recentObstacles" data-index="${index}" maxlength="300" value="${escapeHtml(values[index]?.text || "")}" placeholder="${index ? "可以留空" : "例如：工作任务挤占休息时间"}">
  </label>`).join("")}</div>`;
}

function collaborationMarkup(draft) {
  const collaboration = draft.collaboration || defaultCollaboration();
  const axes = Object.entries(AXES).map(([key, definition]) => `<fieldset class="onboarding-v2-axis">
    <legend>${definition.title}</legend>
    <div>${definition.values.map(([value, label]) => `<label>
      <input type="radio" name="onboarding-${key}" data-onboarding-axis="${key}" value="${value}" ${collaboration[key]?.source === "user" && collaboration[key].value === value ? "checked" : ""}>
      <span>${label}</span>
    </label>`).join("")}</div>
  </fieldset>`).join("");
  return `${axes}<label class="onboarding-v2-answer compact" for="onboarding-boundary">
    <span>还希望怎样配合你 <i>可留空</i></span>
    <textarea id="onboarding-boundary" data-onboarding-boundary maxlength="1000" placeholder="例如：先指出关键矛盾，再给我一个今天能执行的小步骤。">${escapeHtml(collaboration.additionalBoundary || "")}</textarea>
  </label><p class="onboarding-v2-default-note">没有选择的项目会使用清楚标注的系统默认，不会冒充你的偏好。</p>`;
}

function reviewMarkup(draft, { extracting = false } = {}) {
  const hasAnswer = QUESTION_IDS.slice(0, 4).some(questionId => Boolean(answerText(questionId, draft)))
    || Object.keys(AXES).some(key => draft.collaboration?.[key]?.source === "user")
    || Boolean(draft.collaboration?.additionalBoundary);
  return `<span class="eyebrow">回看 · 原文</span>
    <h1>这就是目前的起点。</h1>
    <p class="onboarding-v2-lead">你的原话可以直接帮助回答，不必先生成一份画像。</p>
    <div class="onboarding-v2-review">${QUESTION_IDS.map((questionId, index) => {
      const allowed = questionId === "collaboration"
        ? draft.collaboration?.contextAllowed !== false
        : draft.answers?.[questionId]?.contextAllowed !== false;
      const hasAnswer = Boolean(answerText(questionId, draft));
      return `<article>
        <header><div><span>${String(index + 1).padStart(2, "0")}</span><h2>${STEP_TITLES[index]}</h2></div><button type="button" data-onboarding-action="edit" data-step="${QUESTION_STEPS[index]}">修改</button></header>
        <p>${escapeHtml(answerText(questionId, draft) || "这部分先留空，以后可以补充。")}</p>
        <label class="onboarding-v2-permission"><input type="checkbox" data-onboarding-allow="${questionId}" ${allowed ? "checked" : ""} ${hasAnswer ? "" : "disabled"}><span>用于后续回答</span></label>
      </article>`;
    }).join("")}</div>
    <div class="onboarding-v2-actions">
      <button class="primary-button" type="button" data-onboarding-action="complete">按原文开始使用</button>
      <button class="quiet-button" type="button" data-onboarding-action="extract" ${hasAnswer && !extracting ? "" : "disabled"}>${extracting ? "正在整理…" : "整理成可确认的候选"}</button>
      <button class="subtle-action" type="button" data-onboarding-action="back">返回修改</button>
    </div>
    <p class="onboarding-v2-help">不会自动创建目标、任务、习惯或提醒。之后仍可回看和修改。</p>`;
}

function candidatesMarkup(task, userModel, error = "") {
  const claims = (userModel?.claims || []).filter(item => (
    item.sourceTaskId === task?.id && ["candidate", "stale"].includes(item.lifecycle)
  ));
  const unknowns = (userModel?.unknowns || []).filter(item => item.sourceTaskId === task?.id);
  const pending = claims.filter(item => item.lifecycle === "candidate");
  if (error || ["failed", "stale", "cancelled"].includes(task?.status)) {
    return `<span class="eyebrow">原文已保留 · 整理未完成</span>
      <h1>这次没有生成可确认的候选。</h1>
      <p class="onboarding-v2-lead">${escapeHtml(error || task?.error || "原文已变化，可以回看后重试。")}</p>
      <div class="onboarding-v2-actions">
        <button class="primary-button" type="button" data-onboarding-action="complete">按原文开始使用</button>
        <button class="quiet-button" type="button" data-onboarding-action="retry-extraction">稍后重试</button>
        <button class="subtle-action" type="button" data-onboarding-action="review">返回原文</button>
      </div>`;
  }
  if (!task || ["queued", "running"].includes(task.status)) {
    return `<span class="eyebrow">可选整理 · 原文已经保存</span>
      <h1>正在从原话中整理候选。</h1>
      <p class="onboarding-v2-lead">候选尚未成为记忆。无需等待，也可以直接按原文开始使用。</p>
      <div class="onboarding-v2-actions">
        <button class="primary-button" type="button" data-onboarding-action="complete">不等整理，按原文开始</button>
        <button class="quiet-button" type="button" data-onboarding-action="cancel-extraction">取消整理</button>
        <button class="subtle-action" type="button" data-onboarding-action="review">返回原文</button>
      </div>`;
  }
  if (!claims.length) {
    return `<span class="eyebrow">可选整理 · 没有可靠候选</span>
      <h1>原文已经足够。</h1>
      <p class="onboarding-v2-lead">这次没有从原话中整理出需要单独确认的内容，不影响继续使用。</p>
      <div class="onboarding-v2-actions"><button class="primary-button" type="button" data-onboarding-action="complete">按原文开始使用</button><button class="subtle-action" type="button" data-onboarding-action="review">返回原文</button></div>`;
  }
  return `<span class="eyebrow">逐项确认 · ${pending.length} 条待处理</span>
    <h1>只留下你认同的理解。</h1>
    <p class="onboarding-v2-lead">这些内容从原话整理而来，尚未成为记忆。可修改、保留或不用，不会默认全选。</p>
    <div class="onboarding-v2-candidates">${claims.map(claim => `<article data-claim-id="${escapeHtml(claim.id)}" class="${claim.lifecycle === "stale" ? "stale" : ""}">
      <header><span>${escapeHtml(DOMAIN_LABELS[claim.domain] || claim.domain)}</span><small>${claim.lifecycle === "stale" ? "原文已变化" : claim.epistemic === "known" ? "原文直接表达" : "待验证理解"}</small></header>
      <label><span>候选理解</span><textarea data-claim-statement maxlength="1000" ${claim.lifecycle === "stale" ? "disabled" : ""}>${escapeHtml(claim.statement)}</textarea></label>
      <label><span>适用范围</span><input data-claim-scope maxlength="500" value="${escapeHtml(claim.scope || "")}" ${claim.lifecycle === "stale" ? "disabled" : ""}></label>
      <div class="onboarding-v2-candidate-options">
        <select data-claim-epistemic aria-label="认识状态" ${claim.lifecycle === "stale" ? "disabled" : ""}><option value="known" ${claim.epistemic === "known" ? "selected" : ""}>原文直接表达</option><option value="hypothesis" ${claim.epistemic === "hypothesis" ? "selected" : ""}>仍需验证</option></select>
        <label><input type="checkbox" data-claim-context ${claim.contextAllowed !== false ? "checked" : ""} ${claim.lifecycle === "stale" ? "disabled" : ""}>用于后续回答</label>
      </div>
      <footer>${claim.lifecycle === "stale" ? `<button class="subtle-action" type="button" data-onboarding-action="review">回看修改后的原文</button>` : `<button class="primary-button" type="button" data-claim-action="confirm" data-version="${claim.version}">确认</button><button class="subtle-action" type="button" data-claim-action="reject" data-version="${claim.version}">不用</button>`}</footer>
    </article>`).join("")}</div>
    ${unknowns.length ? `<div class="onboarding-v2-unknown"><b>以后可能值得了解</b><p>${escapeHtml(unknowns[0].question)}</p><small>不会自动追问，也不影响开始使用。</small></div>` : ""}
    <div class="onboarding-v2-actions">
      <button class="primary-button" type="button" data-onboarding-action="complete">${pending.length ? "保留未处理项，先开始使用" : "开始使用"}</button>
      <button class="subtle-action" type="button" data-onboarding-action="review">返回原文</button>
    </div>`;
}

function firstActionMarkup() {
  return `<span class="eyebrow">从真实交互继续</span>
    <h1>不必一次说完自己。</h1>
    <p class="onboarding-v2-lead">现在可以提一个真实问题，或记下此刻的想法。新的记录会继续修正旧理解。</p>
    <div class="onboarding-v2-first-actions">
      <button class="primary-button" type="button" data-onboarding-action="first-question"><span aria-hidden="true">＋</span><b>提一个真实问题</b><small>从一件正在发生的事开始</small></button>
      <button class="quiet-button" type="button" data-onboarding-action="first-record"><span aria-hidden="true">◇</span><b>留一条记录</b><small>先保存此刻，不要求完整</small></button>
    </div>
    <button class="subtle-action" type="button" data-onboarding-action="review">回看与修改原文</button>`;
}

function conflictMarkup(serverState, draft, choices) {
  const rows = onboardingV2ConflictRows(serverState, draft);
  const unresolved = rows.filter(row => !row.equal && !choices[row.questionId]).length;
  return `<span class="eyebrow">需要处理 · 多端内容有差异</span>
    <h1>逐项选择要保留的原文。</h1>
    <p class="onboarding-v2-lead">服务器和此设备的内容都还在，不会自动用最后一次写入覆盖。</p>
    <div class="onboarding-v2-conflicts">${rows.map(row => {
      const choice = row.equal ? "device" : choices[row.questionId] || "";
      return `<article>
        <h2>${row.title}${row.equal ? "<small>内容相同</small>" : ""}</h2>
        <div>
          <button type="button" data-onboarding-conflict="${row.questionId}" data-choice="server" class="${choice === "server" ? "selected" : ""}" ${row.equal ? "disabled" : ""}><span>服务器版本</span><p>${escapeHtml(row.serverText || "留空")}</p></button>
          <button type="button" data-onboarding-conflict="${row.questionId}" data-choice="device" class="${choice === "device" ? "selected" : ""}" ${row.equal ? "disabled" : ""}><span>此设备草稿</span><p>${escapeHtml(row.deviceText || "留空")}</p></button>
        </div>
      </article>`;
    }).join("")}</div>
    <div class="onboarding-v2-actions">
      <button class="primary-button" type="button" data-onboarding-action="merge-conflict" ${unresolved ? "disabled" : ""}>合并并继续</button>
      <span>${unresolved ? `还有 ${unresolved} 项需要选择` : "已可以合并"}</span>
    </div>`;
}

export function createOnboardingV2Controller({
  query = selector => document.querySelector(selector),
  requestV1,
  draftStore,
  owner = () => "",
  updateState = () => {},
  onLegacy = () => {},
  onFirstAction = () => {},
  toast = () => {}
}) {
  if (typeof requestV1 !== "function" || !draftStore) {
    throw new TypeError("Onboarding v2 controller requires request and draft storage");
  }
  let schema = null;
  let serverState = null;
  let draft = null;
  let uiStep = "welcome";
  let dismissed = false;
  let forceVisible = false;
  let showFirstAction = false;
  let legacyMode = false;
  let conflict = null;
  let conflictChoices = {};
  let saving = false;
  let syncing = false;
  let persistSerial = 0;
  let extractionTask = null;
  let userModel = null;
  let extractionError = "";
  let extractionPoll = 0;

  const panel = () => query("#onboarding-workspace");
  const content = () => query("#onboarding-v2-content");
  const status = message => {
    const element = query("#onboarding-v2-save-status");
    if (element) element.textContent = message;
  };
  const localStatus = () => draftStore.durable === false
    ? "暂未保存，请先复制内容"
    : draft?.pendingSync
      ? "已保存在此设备 · 等待同步"
      : "已保存在此设备";
  const persist = async () => {
    if (!draft || !owner()) return false;
    const serial = ++persistSerial;
    draft.owner = owner();
    draft.updatedAt = currentIso();
    await draftStore.put(clone(draft));
    if (serial === persistSerial) status(localStatus());
    return draftStore.durable !== false;
  };
  const clearLocal = async () => {
    if (owner()) await draftStore.delete(owner(), "onboarding-v2");
  };
  const setServerState = value => {
    serverState = clone(value);
    updateState(clone(value));
  };
  const clearExtractionPoll = () => {
    if (extractionPoll) clearTimeout(extractionPoll);
    extractionPoll = 0;
  };
  const loadUserModel = async () => {
    const result = await requestV1("/api/v1/user-model");
    userModel = clone(result.data);
    return userModel;
  };
  const pollExtraction = async () => {
    clearExtractionPoll();
    if (!extractionTask?.id) return;
    try {
      const result = await requestV1(`/api/v1/onboarding-v2/extractions/${encodeURIComponent(extractionTask.id)}`);
      extractionTask = clone(result.data.task);
      if (extractionTask.status === "succeeded") await loadUserModel();
      else if (["queued", "running"].includes(extractionTask.status)) {
        extractionPoll = setTimeout(() => void pollExtraction(), 700);
      } else extractionError = extractionTask.error || "原文已保留，可以直接开始使用或稍后重试。";
    } catch (error) {
      extractionError = error.message || "原文已保留，可以直接开始使用或稍后重试。";
    }
    render();
  };
  const startExtraction = async ({ retry = false } = {}) => {
    extractionError = "";
    const synced = await saveCurrent("review", { status: "draft", full: true });
    if (!synced && draft?.pendingSync) {
      extractionError = "原文仍在等待同步；同步完成后再整理，或直接按原文开始使用。";
      uiStep = "candidates";
      forceVisible = true;
      return render();
    }
    saving = true;
    uiStep = "candidates";
    forceVisible = true;
    extractionTask = null;
    userModel = null;
    render();
    try {
      const revision = Number(serverState?.session?.revision) || 0;
      const result = await requestV1("/api/v1/onboarding-v2/extractions", {
        method: "POST",
        headers: {
          "idempotency-key": retry
            ? `onboarding-claims:${revision}:${newId()}`
            : `onboarding-claims:${revision}`
        },
        body: JSON.stringify({ sourceRevision: revision })
      }, {
        resource: "onboarding-v2:onboarding-v2",
        domains: ["aiTasks", "notifications"],
        recoverCommitted: true
      });
      extractionTask = clone(result.data);
      status("原文已保存 · 候选正在整理");
      void pollExtraction();
    } catch (error) {
      extractionError = error.message || "原文已保留，可以直接开始使用或稍后重试。";
      status("原文已保存 · 整理未完成");
    } finally {
      saving = false;
      render();
    }
  };
  const updateClaim = async (button, action) => {
    const article = button.closest("[data-claim-id]");
    const claimId = article?.dataset.claimId;
    if (!claimId) return;
    const body = action === "confirm" ? {
      action,
      statement: String(article.querySelector("[data-claim-statement]")?.value || "").trim(),
      scope: String(article.querySelector("[data-claim-scope]")?.value || "").trim(),
      epistemic: article.querySelector("[data-claim-epistemic]")?.value || "hypothesis",
      contextAllowed: article.querySelector("[data-claim-context]")?.checked !== false
    } : { action: "reject" };
    saving = true;
    render();
    try {
      await requestV1(`/api/v1/user-model/claims/${encodeURIComponent(claimId)}`, {
        method: "PATCH",
        headers: { "if-match": `"${Number(button.dataset.version) || 1}"` },
        body: JSON.stringify(body)
      }, {
        resource: `userClaims:${claimId}`,
        domains: ["userClaims"],
        recoverCommitted: true
      });
      await loadUserModel();
      status(action === "confirm" ? "这条理解已确认，可随时撤回或修改" : "这条候选不会用于后续回答");
    } catch (error) {
      extractionError = error.message || "候选暂未更新，请刷新后重试。";
      await loadUserModel().catch(() => {});
      status(`候选暂未更新：${extractionError}`);
    } finally {
      saving = false;
      render();
    }
  };
  const cancelExtraction = async () => {
    if (!extractionTask?.id) return;
    saving = true;
    try {
      clearExtractionPoll();
      const result = await requestV1(`/api/v1/onboarding-v2/extractions/${encodeURIComponent(extractionTask.id)}`, {
        method: "DELETE"
      }, {
        resource: `aiTasks:${extractionTask.id}`,
        domains: ["aiTasks", "notifications"],
        recoverCommitted: true
      });
      extractionTask = clone(result.data);
      extractionError = "整理已取消，原文仍然保留。";
      status("原文已保存 · 整理已取消");
    } catch (error) {
      extractionError = error.message || "暂时无法取消整理。";
      status(extractionError);
    } finally {
      saving = false;
      render();
    }
  };

  function captureVisibleStep() {
    if (!draft) return;
    const occurredAt = draft.answers?.[QUESTION_IDS[QUESTION_STEPS.indexOf(uiStep)]]?.occurredAt || currentIso();
    if (uiStep === "q1" || uiStep === "q4") {
      const questionId = uiStep === "q1" ? "currentContext" : "dailyRhythm";
      const rawText = String(query("#onboarding-v2-answer")?.value || "").trim();
      if (rawText) {
        draft.answers[questionId] = {
          questionId,
          rawText,
          occurredAt,
          contextAllowed: draft.answers?.[questionId]?.contextAllowed !== false
        };
      } else delete draft.answers[questionId];
    }
    if (uiStep === "q2") {
      const structuredValue = [...document.querySelectorAll('[data-onboarding-list="desiredChanges"]')].map(input => {
        const index = Number(input.dataset.index), text = input.value.trim();
        let horizon = query(`[data-onboarding-horizon][data-index="${index}"]`)?.value || "unknown";
        const horizonText = query(`[data-onboarding-horizon-text][data-index="${index}"]`)?.value.trim() || "";
        if (horizon === "custom" && !horizonText) horizon = "unknown";
        return text ? { text, horizon, ...(horizon === "custom" && horizonText ? { horizonText } : {}) } : null;
      }).filter(Boolean);
      if (structuredValue.length) {
        draft.answers.desiredChanges = {
          questionId: "desiredChanges",
          structuredValue,
          occurredAt,
          contextAllowed: draft.answers?.desiredChanges?.contextAllowed !== false
        };
      } else delete draft.answers.desiredChanges;
    }
    if (uiStep === "q3") {
      const structuredValue = [...document.querySelectorAll('[data-onboarding-list="recentObstacles"]')]
        .map(input => input.value.trim() ? { text: input.value.trim() } : null)
        .filter(Boolean);
      if (structuredValue.length) {
        draft.answers.recentObstacles = {
          questionId: "recentObstacles",
          structuredValue,
          occurredAt,
          contextAllowed: draft.answers?.recentObstacles?.contextAllowed !== false
        };
      } else delete draft.answers.recentObstacles;
    }
    if (uiStep === "q5") {
      for (const key of Object.keys(AXES)) {
        const selected = document.querySelector(`[data-onboarding-axis="${key}"]:checked`);
        draft.collaboration[key] = selected
          ? { value: selected.value, source: "user" }
          : { value: defaultCollaboration()[key].value, source: "system_default" };
      }
      draft.collaboration.additionalBoundary = String(query("#onboarding-boundary")?.value || "").trim();
    }
    draft.status = "draft";
    draft.step = uiStep;
    draft.localDirty = true;
  }

  function captureReviewPermissions() {
    if (uiStep !== "review" || !draft) return;
    for (const input of document.querySelectorAll("[data-onboarding-allow]")) {
      const questionId = input.dataset.onboardingAllow;
      if (questionId === "collaboration") draft.collaboration.contextAllowed = input.checked;
      else if (draft.answers[questionId]) draft.answers[questionId].contextAllowed = input.checked;
    }
    draft.localDirty = true;
  }

  async function sendPatch(patch, { hide = false, firstAction = false } = {}) {
    if (saving || !serverState) return false;
    saving = true;
    render();
    try {
      const result = await requestV1("/api/v1/onboarding-v2/session", {
        method: "PATCH",
        headers: {
          "if-match": `"${resourceVersion(serverState)}"`,
          "idempotency-key": newId()
        },
        body: JSON.stringify(patch)
      }, {
        resource: "onboarding-v2:onboarding-v2",
        domains: ["onboardingV2"],
        recoverCommitted: true
      });
      setServerState(result.data);
      draft = onboardingV2DraftFromState(result.data, { owner: owner() });
      await clearLocal();
      status(draftStore.durable === false ? "已同步" : "已保存在此设备 · 已同步");
      conflict = null;
      conflictChoices = {};
      if (firstAction) {
        showFirstAction = true;
        forceVisible = true;
        uiStep = "firstAction";
      }
      if (hide) {
        dismissed = true;
        forceVisible = false;
      }
      return true;
    } catch (error) {
      if (error?.code === "ONBOARDING_SESSION_CONFLICT" && error.details?.currentSession) {
        serverState = {
          ...serverState,
          session: clone(error.details.currentSession),
          readiness: serverState.readiness
        };
        conflict = clone(serverState);
        conflictChoices = {};
        uiStep = "conflict";
        forceVisible = true;
        draft.pendingSync = false;
        draft.baseRevision = Number(error.details.currentRevision) || draft.baseRevision;
        await persist();
        status("两端内容有差异，请逐项选择");
      } else if (error?.syncStatus === "pending") {
        draft.pendingSync = true;
        draft.localDirty = true;
        await persist();
        status(localStatus());
        if (hide) dismissed = true;
        if (firstAction) {
          showFirstAction = true;
          forceVisible = true;
          uiStep = "firstAction";
        }
      } else {
        status(`暂未同步：${error.message}`);
      }
      return false;
    } finally {
      saving = false;
      render();
    }
  }

  async function saveCurrent(nextStep, {
    status: nextStatus = "draft",
    clear = false,
    full = false,
    hide = false,
    firstAction = false
  } = {}) {
    if (QUESTION_STEPS.includes(uiStep)) captureVisibleStep();
    if (uiStep === "review") captureReviewPermissions();
    const questionId = QUESTION_IDS[QUESTION_STEPS.indexOf(uiStep)] || "";
    if (clear && questionId) {
      if (questionId === "collaboration") draft.collaboration = defaultCollaboration();
      else delete draft.answers[questionId];
    }
    draft.step = nextStep;
    draft.status = nextStatus;
    draft.localDirty = true;
    uiStep = nextStep;
    await persist();
    if (draft.pendingSync) {
      if (hide) dismissed = true;
      if (firstAction) showFirstAction = true;
      render();
      return false;
    }
    const patch = onboardingV2PatchFromDraft(draft, {
      questionId,
      status: nextStatus,
      step: nextStep,
      full
    });
    return sendPatch(patch, { hide, firstAction });
  }

  async function flushPending() {
    if (!draft?.pendingSync || syncing || !serverState) return false;
    syncing = true;
    draft.baseRevision = Number(serverState.session?.revision) || 0;
    draft.pendingSync = false;
    await persist();
    const result = await sendPatch(onboardingV2PatchFromDraft(draft, {
      status: draft.status,
      step: draft.step,
      full: true
    }), {
      hide: draft.status === "paused" || draft.status === "skipped",
      firstAction: draft.status === "completed"
    });
    syncing = false;
    return result;
  }

  function renderSteps() {
    const steps = query("#onboarding-v2-steps");
    if (!steps) return;
    steps.innerHTML = `<p>五个问题<br><span>约 3–5 分钟，可随时略过</span></p>${STEP_TITLES.map((title, index) => `<button type="button" data-onboarding-action="goto" data-step="${QUESTION_STEPS[index]}" class="${uiStep === QUESTION_STEPS[index] ? "active" : ""}" ${["welcome", "resume", "firstAction", "conflict"].includes(uiStep) ? "disabled" : ""}><span>${String(index + 1).padStart(2, "0")}</span>${title}</button>`).join("")}<p>原文属于你。<br><span>整理与推测可以不同意。</span></p>`;
  }

  function renderQuestion() {
    const index = QUESTION_STEPS.indexOf(uiStep), question = schema?.questions?.[index];
    if (!question) return "";
    const bodies = [
      textAnswerMarkup("currentContext", draft, { placeholder: "例如：最近一边学习一边实习，时间比较紧。" }),
      desiredChangesMarkup(draft),
      obstaclesMarkup(draft),
      textAnswerMarkup("dailyRhythm", draft, { placeholder: "例如：工作日比较忙，周末会散步。" }),
      collaborationMarkup(draft)
    ];
    const hints = [
      "不必从身份开始，写下此刻最重要的处境就好。",
      "最多三件，期限还没想清楚也没关系。",
      "最多三件，不想谈的部分可以留空。",
      "作息、工作学习、运动或独处，挑与你有关的说。",
      "这些选择会影响回答方式，也可以随时调整。"
    ];
    return `<span class="eyebrow">${index + 1} / 5 · ${STEP_TITLES[index]}</span>
      <h1>${escapeHtml(question.prompt)}</h1>
      <p class="onboarding-v2-lead">${hints[index]}</p>
      ${bodies[index]}
      <div class="onboarding-v2-actions">
        <button class="subtle-action" type="button" data-onboarding-action="back">上一步</button>
        <button class="primary-button" type="button" data-onboarding-action="next">${index === 4 ? "回看我的回答" : "下一步"}</button>
        <button class="subtle-action" type="button" data-onboarding-action="skip">这题先跳过</button>
      </div>
      <p class="onboarding-v2-help">不会把留空解释成你的性格或态度。无需填写完整才可使用。</p>`;
  }

  function renderContent() {
    if (uiStep === "welcome") {
      const resumable = draft?.step && draft.step !== "welcome";
      const legacy = serverState?.migration?.legacy;
      return `<div class="onboarding-v2-welcome">
        <span class="eyebrow">不从标签开始</span>
        <h1>先认识此刻的你。</h1>
        <p>你在哪里，想往哪里去，<br>又希望怎样被帮助。</p>
        <p class="onboarding-v2-lead">五个生活问题，建立一点足够有用的了解。每题都可以跳过，之后再慢慢补充。</p>
        <div class="onboarding-v2-actions">
          <button class="primary-button" type="button" data-onboarding-action="start">${resumable ? "继续上次填写" : "开始了解"}</button>
          <button class="quiet-button" type="button" data-onboarding-action="use">先用起来</button>
          ${legacy?.status === "pending" ? `<button class="subtle-action" type="button" data-onboarding-action="legacy">${legacy.answerCount ? "继续旧版问卷" : "填写旧版价值问卷"}</button>` : ""}
        </div>
        <p class="onboarding-v2-help">输入先保存在当前账户的此设备空间；同步失败也不会清空原文。</p>
      </div>`;
    }
    if (uiStep === "resume") {
      return `<span class="eyebrow">已暂停</span><h1>先把这一点留下。</h1>
        <p class="onboarding-v2-lead">稍后可以从第 ${Math.max(1, QUESTION_STEPS.indexOf(draft.step) + 1)} 问继续，不必重新填写。</p>
        <div class="onboarding-v2-actions"><button class="primary-button" type="button" data-onboarding-action="resume">继续填写</button><button class="quiet-button" type="button" data-onboarding-action="use">先用起来</button></div>`;
    }
    if (QUESTION_STEPS.includes(uiStep)) return renderQuestion();
    if (uiStep === "review") return reviewMarkup(draft, {
      extracting: ["queued", "running"].includes(extractionTask?.status)
    });
    if (uiStep === "candidates") return candidatesMarkup(extractionTask, userModel, extractionError);
    if (uiStep === "firstAction") return firstActionMarkup();
    if (uiStep === "conflict" && conflict) return conflictMarkup(conflict, draft, conflictChoices);
    return "";
  }

  function render() {
    const root = panel();
    if (!root || !schema || !serverState || !draft) {
      if (root) root.hidden = true;
      return;
    }
    const terminal = ["completed", "skipped"].includes(serverState.session?.status);
    const visible = legacyMode || showFirstAction || forceVisible || Boolean(draft.localDirty || draft.pendingSync) || (!dismissed && !terminal);
    root.hidden = !visible;
    if (!visible) return;
    query("#onboarding-v2-shell").hidden = legacyMode;
    query("#onboarding-form").hidden = !legacyMode;
    root.classList.toggle("legacy", legacyMode);
    if (legacyMode) {
      onLegacy();
      return;
    }
    renderSteps();
    const target = content();
    target.innerHTML = renderContent();
    const back = query("#onboarding-v2-back");
    back.hidden = !QUESTION_STEPS.includes(uiStep) && uiStep !== "review";
    const exit = query("#onboarding-v2-exit");
    exit.hidden = ["firstAction", "conflict", "candidates"].includes(uiStep);
    back.disabled = saving;
    exit.disabled = saving;
    const heading = target.querySelector("h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    target.querySelectorAll("[data-onboarding-horizon]").forEach(select => {
      const custom = target.querySelector(`[data-onboarding-horizon-text][data-index="${select.dataset.index}"]`);
      if (custom) custom.hidden = select.value !== "custom";
    });
    root.querySelectorAll("button,input,textarea,select").forEach(control => {
      if (saving && !control.closest(".onboarding-legacy-form")) control.disabled = true;
    });
  }

  async function handleAction(action, button) {
    if (!draft || saving) return;
    if (action === "start") {
      const next = QUESTION_STEPS.includes(draft.step) || draft.step === "review" ? draft.step : "q1";
      return saveCurrent(next, { status: "draft" });
    }
    if (action === "resume") {
      const next = QUESTION_STEPS.includes(draft.step) || draft.step === "review" ? draft.step : "q1";
      return saveCurrent(next, { status: "draft" });
    }
    if (action === "use") return saveCurrent("firstAction", { status: "skipped", full: true, hide: true });
    if (action === "next") {
      const index = QUESTION_STEPS.indexOf(uiStep);
      return saveCurrent(index === 4 ? "review" : QUESTION_STEPS[index + 1]);
    }
    if (action === "skip") {
      const index = QUESTION_STEPS.indexOf(uiStep);
      return saveCurrent(index === 4 ? "review" : QUESTION_STEPS[index + 1], { clear: true });
    }
    if (action === "back") {
      if (uiStep === "review") return saveCurrent("q5");
      const index = QUESTION_STEPS.indexOf(uiStep);
      return saveCurrent(index <= 0 ? "welcome" : QUESTION_STEPS[index - 1]);
    }
    if (action === "goto" || action === "edit") {
      if (QUESTION_STEPS.includes(uiStep)) captureVisibleStep();
      if (uiStep === "review") captureReviewPermissions();
      draft.step = button.dataset.step;
      uiStep = button.dataset.step;
      await persist();
      return render();
    }
    if (action === "extract") return startExtraction();
    if (action === "retry-extraction") return startExtraction({ retry: true });
    if (action === "cancel-extraction") return cancelExtraction();
    if (action === "complete") {
      return saveCurrent("firstAction", { status: "completed", full: true, firstAction: true });
    }
    if (action === "review") {
      showFirstAction = false;
      forceVisible = true;
      uiStep = "review";
      return render();
    }
    if (action === "first-question" || action === "first-record") {
      showFirstAction = false;
      forceVisible = false;
      dismissed = true;
      render();
      return onFirstAction(action === "first-question" ? "question" : "record");
    }
    if (action === "legacy") {
      legacyMode = true;
      return render();
    }
    if (action === "merge-conflict") {
      const rows = onboardingV2ConflictRows(conflict, draft);
      if (rows.some(row => !row.equal && !conflictChoices[row.questionId])) return;
      draft = mergeOnboardingV2Conflict(conflict, draft, conflictChoices);
      serverState = clone(conflict);
      conflict = null;
      conflictChoices = {};
      uiStep = draft.step === "firstAction" ? "review" : draft.step;
      await persist();
      return sendPatch(onboardingV2PatchFromDraft(draft, {
        status: "draft",
        step: uiStep,
        full: true
      }));
    }
  }

  const click = event => {
    const claimButton = event.target.closest("[data-claim-action]");
    if (claimButton) {
      void updateClaim(claimButton, claimButton.dataset.claimAction);
      return;
    }
    const conflictButton = event.target.closest("[data-onboarding-conflict]");
    if (conflictButton) {
      conflictChoices[conflictButton.dataset.onboardingConflict] = conflictButton.dataset.choice;
      render();
      return;
    }
    const button = event.target.closest("[data-onboarding-action]");
    if (button) void handleAction(button.dataset.onboardingAction, button);
  };
  const input = event => {
    if (!event.target.closest("#onboarding-v2-content") || !draft) return;
    if (uiStep === "review") captureReviewPermissions();
    else if (QUESTION_STEPS.includes(uiStep)) captureVisibleStep();
    if (event.target.matches("[data-onboarding-horizon]")) {
      const custom = query(`[data-onboarding-horizon-text][data-index="${event.target.dataset.index}"]`);
      if (custom) custom.hidden = event.target.value !== "custom";
    }
    void persist();
  };

  query("#onboarding-v2-content")?.addEventListener("click", click);
  query("#onboarding-v2-content")?.addEventListener("input", input);
  query("#onboarding-v2-content")?.addEventListener("change", input);
  query("#onboarding-v2-steps")?.addEventListener("click", click);
  query("#onboarding-v2-back")?.addEventListener("click", () => void handleAction("back", query("#onboarding-v2-back")));
  query("#onboarding-v2-exit")?.addEventListener("click", () => {
    void saveCurrent(draft?.step || "welcome", { status: "paused", full: true, hide: true });
  });

  return {
    async hydrate({ schema: nextSchema, state: nextState }) {
      clearExtractionPoll();
      schema = clone(nextSchema);
      serverState = clone(nextState);
      dismissed = false;
      forceVisible = false;
      showFirstAction = false;
      legacyMode = false;
      conflict = null;
      conflictChoices = {};
      extractionTask = null;
      userModel = null;
      extractionError = "";
      const saved = owner() ? await draftStore.get(owner(), "onboarding-v2") : null;
      draft = saved?.owner === owner()
        ? { ...onboardingV2DraftFromState(nextState, { owner: owner() }), ...clone(saved) }
        : onboardingV2DraftFromState(nextState, { owner: owner() });
      if (draft.pendingSync && Number(nextState.session?.revision) > Number(draft.baseRevision)) {
        if (onboardingContentMatches(nextState, draft)) {
          draft = onboardingV2DraftFromState(nextState, { owner: owner() });
          await clearLocal();
        } else {
          draft.baseRevision = Number(nextState.session.revision);
          void flushPending();
        }
      }
      uiStep = draft.pendingSync || draft.localDirty
        ? draft.step
        : nextState.session?.status === "paused"
          ? "resume"
          : nextState.session?.step || "welcome";
      if (uiStep === "firstAction" && ["completed", "skipped"].includes(nextState.session?.status)) uiStep = "welcome";
      render();
    },
    render,
    reconcile(nextState) {
      setServerState(nextState);
      if (draft?.pendingSync && Number(nextState.session?.revision) > Number(draft.baseRevision)) {
        if (onboardingContentMatches(nextState, draft)) {
          draft = onboardingV2DraftFromState(nextState, { owner: owner() });
          void clearLocal();
          status(draftStore.durable === false ? "已同步" : "已保存在此设备 · 已同步");
        } else void flushPending();
      } else if (!draft?.localDirty && !draft?.pendingSync) {
        draft = onboardingV2DraftFromState(nextState, { owner: owner() });
      }
      render();
    },
    reopen() {
      if (!serverState) return;
      dismissed = false;
      forceVisible = true;
      showFirstAction = false;
      legacyMode = false;
      draft = onboardingV2DraftFromState(serverState, { owner: owner() });
      uiStep = "review";
      render();
      panel()?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    backFromLegacy() {
      legacyMode = false;
      uiStep = "welcome";
      render();
    },
    hasUnsynced() {
      return Boolean(draft?.localDirty || draft?.pendingSync);
    },
    async clearOwner(accountId) {
      if (accountId) await draftStore.clear(accountId);
    },
    reset() {
      clearExtractionPoll();
      schema = null;
      serverState = null;
      draft = null;
      dismissed = false;
      forceVisible = false;
      showFirstAction = false;
      legacyMode = false;
      conflict = null;
      conflictChoices = {};
      extractionTask = null;
      userModel = null;
      extractionError = "";
      const root = panel();
      if (root) root.hidden = true;
    },
    getState() {
      return {
        uiStep,
        draft: clone(draft),
        serverState: clone(serverState),
        legacyMode,
        conflict: clone(conflict),
        extractionTask: clone(extractionTask),
        userModel: clone(userModel),
        extractionError
      };
    }
  };
}
