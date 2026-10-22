import { projectAnnotationCounts, annotationCountLabel } from "../../../generated/annotation-counts.mjs";
import {
  escapeHtml,
  plainPreview,
  renderMarkdown
} from "../../content/index.mjs";
import {
  speechAssetForSource,
  speechAudioPath,
  speechSourceIdentity,
  TTS_PLAYBACK_RATES,
  TTS_GENERATION_RATE_MIN,
  TTS_GENERATION_RATE_MAX,
  normalizeTtsGenerationRate
} from "../../media/index.mjs";
import {
  eventDate,
  eventTimestamp,
  formatDate,
  formatTime
} from "../../time/index.mjs";
import {
  currentUserConclusion,
  initialThoughtIdea,
  isAiThoughtBlock,
  pendingThoughtTask,
  thoughtDate,
  thoughtListPreview,
  thoughtMonthLabel
} from "./model.mjs";
import { pendingAiTaskMessage } from "../../shared/ai-task-status.mjs";
import { reasoningDisclosureMarkup } from "../ui/index.mjs";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Thought presentation requires ${name}`);
  }
  return value;
}

export function createThoughtPresentation({
  getSnapshot,
  isAnnotationRootLoaded,
  getGenerationRate = () => undefined,
  appUrl,
  contextReceiptMarkup,
  contentImagesMarkup
} = {}) {
  for (const [name, value] of Object.entries({
    getSnapshot,
    appUrl,
    contextReceiptMarkup,
    contentImagesMarkup
  })) requireFunction(value, name);

  function thoughtBlockBody(content, expandKey) {
    return `<div class="thought-block-content-frame"><div class="thought-block-content markdown-content">${renderMarkdown(content || "")}</div></div><button class="thought-block-expand" type="button" data-thought-block-expand data-expand-key="${escapeHtml(expandKey)}" aria-expanded="false" hidden><span>展开全文</span><i aria-hidden="true">⌄</i></button>`;
  }

  function speechControlsMarkup({
    sourceType,
    sourceId,
    sourceVersion,
    label
  }) {
    const snapshot = getSnapshot();
    if (!speechSourceIdentity(sourceType, sourceId, sourceVersion)) return "";
    const asset = speechAssetForSource(snapshot.speech?.assets, {
      sourceType,
      sourceId,
      sourceVersion
    });
    const path = speechAudioPath(asset);
    const sourceLabel = String(label || "文字朗读");
    const voiceLabel = (snapshot.speech?.voices || [])
      .find(item => item.id === asset?.voice)?.label || "";
    const rateOptions = TTS_PLAYBACK_RATES
      .map(rate => `<option value="${rate}" ${rate === 1 ? "selected" : ""}>${rate.toFixed(1)}×</option>`)
      .join("");
    const player = asset && path
      ? `<div class="capture-speech-player speech-asset-player"><audio controls preload="none" src="${escapeHtml(appUrl(path))}" data-speech-player="${escapeHtml(asset.id)}" aria-label="${escapeHtml(`${sourceLabel}播放器`)}"></audio><span>${escapeHtml(voiceLabel ? `${sourceLabel} · ${voiceLabel}` : sourceLabel)}</span><button type="button" class="subtle-action" data-capture-speech-retry hidden>重试读取朗读</button></div>`
      : "";
    if (!player && !snapshot.speech?.configured) return "";
    const generationRate = normalizeTtsGenerationRate(asset?.generationRate ?? getGenerationRate());
    const generator = snapshot.speech?.configured
      ? `<button type="button" data-speech-synthesize data-speech-regenerate="${asset ? "true" : "false"}" aria-label="${escapeHtml(`${asset ? "重新生成" : "生成"}${sourceLabel}`)}">${asset ? "重新生成" : "生成"}</button>` : "";
    const generationControl = snapshot.speech?.configured
      ? `<label><span>生成语速</span><input type="range" min="${TTS_GENERATION_RATE_MIN}" max="${TTS_GENERATION_RATE_MAX}" value="${generationRate}" data-speech-generation-rate aria-label="${escapeHtml(`${sourceLabel}生成语速`)}"><output>${(1 + generationRate / 100).toFixed(2)}×</output></label>`
      : `<span>生成语速 ${(1 + generationRate / 100).toFixed(2)}×</span>`;
    return `<section class="speech-asset-controls" data-speech-source-type="${escapeHtml(sourceType)}" data-speech-source-id="${escapeHtml(sourceId)}" data-speech-source-version="${Number(sourceVersion) || 1}">${player}<div class="capture-speech-actions speech-asset-actions">${generator}${player ? `<label><span>播放倍速</span><select data-speech-playback-rate aria-label="${escapeHtml(`${sourceLabel}播放倍速`)}">${rateOptions}</select></label>` : ""}${generationControl}</div><p class="speech-asset-status" role="status" aria-live="polite"></p></section>`;
  }

  function contentBlock(item, question, {
    initialIdeaId = "",
    currentConclusionId = ""
  } = {}) {
    const ai = isAiThoughtBlock(item);
    const current = item.id === currentConclusionId;
    const labels = {
      idea: item.id === initialIdeaId ? "初步想法" : "想法",
      record: "经历",
      answer: ai ? "AI 应答" : "我的结论"
    };
    const identities = {
      idea: "◒",
      record: "▤",
      answer: ai ? "✦" : "✓"
    };
    const speech = ai && item.type === "answer"
      ? speechControlsMarkup({
        sourceType: "thoughtAnswer",
        sourceId: item.id,
        sourceVersion: item.version || 1,
        label: "AI 回答文字朗读"
      })
      : "";
    const answerEvidence = reasoningDisclosureMarkup(item) + contextReceiptMarkup(
      item.contextReceipt,
      item.citations,
      item.citationStatus,
      item.providedReferences
    );
    return `<article class="thought-content-block ${ai ? "ai" : ""} ${current ? "current-conclusion" : ""}" data-thought-kind="${escapeHtml(item.type)}" data-thought-block-id="${escapeHtml(item.id)}"><header><div><span class="thought-identity-icon" aria-hidden="true">${identities[item.type] || "·"}</span><b>${labels[item.type] || "内容"}</b>${current ? "<small>当前</small>" : ""}</div><time>${formatDate(eventTimestamp(item))}</time></header>${answerEvidence}${thoughtBlockBody(item.content || item.modelDraft || "", `thought:${question.id}:block:${item.id}`)}${contentImagesMarkup(item, "thoughtBlock")}${speech}${item.modelDraft && item.editedFromModel ? `<small class="edit-signal">${item.content ? "由 AI 草稿修改后保留" : "未保留 AI 草稿"}</small>` : ""}<footer><span></span><div><button class="subtle-action" type="button" data-thought-block-edit="${escapeHtml(item.id)}" data-root-id="${escapeHtml(question.id)}">编辑</button><button class="subtle-action danger" type="button" data-thought-block-delete="${escapeHtml(item.id)}" data-root-id="${escapeHtml(question.id)}">删除</button></div></footer></article>`;
  }

  function followUpBlock(followUp, question, index) {
    const pending = pendingThoughtTask(
      getSnapshot().aiTasks,
      "followUpAnswer",
      question.id,
      followUp.id
    );
    const answerMarkup = followUp.answer
      ? `<div class="model-answer-content">${contextReceiptMarkup(followUp.contextReceipt, followUp.citations, followUp.citationStatus, followUp.providedReferences)}<div class="markdown-content">${renderMarkdown(followUp.answer)}</div>${reasoningDisclosureMarkup(followUp)}</div>`
      : `<form class="manual-followup-answer" data-followup-manual-answer="${escapeHtml(followUp.id)}" data-root-id="${escapeHtml(question.id)}" data-version="${followUp.version || 1}">
          <textarea rows="3" placeholder="直接写下回答…" aria-label="追问回答" required></textarea>
          <div>
            <button class="quiet-button" type="submit">保存回答</button>
            <button type="button" class="subtle-action answer-action" data-followup-answer="${escapeHtml(followUp.id)}" data-root-id="${escapeHtml(question.id)}" ${pending ? "disabled" : ""}>✦ 给我回答</button>
          </div>
        </form>`;
    const editFormMarkup = `<form class="followup-edit-form" data-followup-edit="${escapeHtml(followUp.id)}" data-root-id="${escapeHtml(question.id)}" data-version="${followUp.version || 1}" hidden>
      <label>追问问题<textarea rows="3" name="question" required>${escapeHtml(followUp.question)}</textarea></label>
      <label>追问回答（可空）<textarea rows="5" name="answer">${escapeHtml(followUp.answer || "")}</textarea></label>
      <div>
        <button class="quiet-button" type="submit">保存修改</button>
        <button class="subtle-action" type="button" data-followup-edit-cancel="${escapeHtml(followUp.id)}">取消</button>
      </div>
    </form>`;
    const pendingMessage = pending
      ? escapeHtml(pendingAiTaskMessage(pending, "回答正在后台生成，可继续使用其他功能。"))
      : "";
    return `<details class="response-entry thought-content-block followup-block" data-followup-id="${escapeHtml(followUp.id)}">
      <summary>
        <div class="response-summary-copy">
          <div class="response-summary-head">
            <strong>追问 ${index + 1}</strong><span>用户原文</span>
            <small>版本 ${followUp.version || 1} · ${formatDate(followUp.updatedAt || followUp.createdAt)}</small>
          </div>
          <p>${escapeHtml(plainPreview(followUp.question))}</p>
        </div>
      </summary>
      <div class="response-entry-body">
        <div class="followup-question"><b>追问问题</b><div class="markdown-content">${renderMarkdown(followUp.question)}</div></div>
        <div class="followup-answer">
          <b>追问回答</b>${answerMarkup}
          <p class="followup-status" role="status" aria-live="polite">${pendingMessage}</p>
        </div>
        <div class="followup-record-actions">
          <button type="button" class="subtle-action" data-followup-edit-toggle="${escapeHtml(followUp.id)}">编辑</button>
          <button type="button" class="subtle-action danger" data-followup-delete="${escapeHtml(followUp.id)}" data-root-id="${escapeHtml(question.id)}">删除</button>
        </div>
        ${editFormMarkup}
      </div>
    </details>`;
  }

  function stream(question, children) {
    const initialIdeaId = initialThoughtIdea(children)?.id || "";
    const currentConclusionId = currentUserConclusion(children)?.id || "";
    const items = [
      ...children.map(item => ({
        time: eventTimestamp(item),
        markup: contentBlock(item, question, { initialIdeaId, currentConclusionId })
      })),
      ...(question.remarks || []).map(remark => ({
        time: remark.updatedAt || remark.createdAt,
        markup: `<article class="thought-content-block remark-block"><header><div><b>备注</b><span>用户原文</span></div><time>${formatDate(remark.updatedAt || remark.createdAt)}</time></header>${thoughtBlockBody(remark.text, `thought:${question.id}:remark:${remark.id}`)}<footer><span>版本 ${remark.version || 1}</span><div><button class="subtle-action" type="button" data-edit-remark="${escapeHtml(remark.id)}" data-thought-id="${escapeHtml(question.id)}">编辑</button><button class="subtle-action danger" type="button" data-delete-remark="${escapeHtml(remark.id)}" data-thought-id="${escapeHtml(question.id)}">删除</button></div></footer></article>`
      })),
      ...(question.followUps || []).map((followUp, index) => ({
        time: followUp.updatedAt || followUp.answeredAt || followUp.createdAt,
        markup: followUpBlock(followUp, question, index)
      }))
    ].sort((left, right) => String(left.time).localeCompare(String(right.time)));
    return `<section class="thought-content-stream">${items.length ? items.map(item => item.markup).join("") : '<p class="missing-part">还没有后续内容。</p>'}</section>`;
  }

  function card({ question, children }, showDate = true, sortMode = "occurred", {
    detail = false,
    compactDate = false
  } = {}) {
    const answers = children.filter(item => item.type === "answer");
    const pendingAnswer = pendingThoughtTask(getSnapshot().aiTasks, "thoughtAnswer", question.id);
    const answerCount = Number.isFinite(Number(question.answerCount))
      ? Number(question.answerCount)
      : answers.length;
    const preview = thoughtListPreview(children, question.preview);
    const annotationCounts = projectAnnotationCounts(question, { complete: isAnnotationRootLoaded?.(question.id) });
    const annotationLabel = annotationCountLabel(annotationCounts);
    const syncing = question._sync?.status;
    const dispositionActions = `${question.disposition !== "kept" ? `<button class="subtle-action" data-disposition="${escapeHtml(question.id)}" data-value="kept">保留</button>` : ""}${question.disposition !== "discarded" ? `<button class="subtle-action" data-disposition="${escapeHtml(question.id)}" data-value="discarded">舍弃</button>` : ""}`;
    const tags = question.tags?.length
      ? `#${question.tags.map(escapeHtml).join(" #")}`
      : "未标记";
    const tracePending = (getSnapshot().insights?.aiOnlyThoughtIds || []).includes(question.id)
      ? '<span class="thought-trace-pending">📫没有你的痕迹⏳</span>'
      : "";
    const answerButton = `<button class="subtle-action answer-action" data-answer-chain="${escapeHtml(question.id)}" ${pendingAnswer ? "disabled" : ""}>✦ ${answerCount ? "重新回答" : "给我回答"}</button>`;
    const pendingAnswerStatus = pendingAnswer
      ? `<p class="card-action-status working" role="status" aria-live="polite">${escapeHtml(pendingAiTaskMessage(pendingAnswer, "回答正在后台生成，可继续使用其他功能。"))}</p>`
      : "";
    const actions = syncing
      ? `<span class="checkin-sync-state ${escapeHtml(syncing)}">${syncing === "pending" ? "待同步" : "正在同步"}</span>`
      : `<span class="thought-action-group thought-action-grow">
          <button class="primary-button" data-thought-block-add="idea" data-root-id="${escapeHtml(question.id)}">＋ 补充</button>
          <button class="subtle-action" data-followup-compose="${escapeHtml(question.id)}" aria-expanded="false">追问 →</button>
          ${answerButton}
        </span>${pendingAnswerStatus}`;
    const chainSpeech = syncing
      ? ""
      : speechControlsMarkup({
        sourceType: "thoughtChain",
        sourceId: question.id,
        sourceVersion: question.version || 1,
        label: "整套思绪朗读"
      });
    const displayedAt = sortMode === "created"
      ? question.createdAt || eventTimestamp(question)
      : eventTimestamp(question);
    const dateLabel = compactDate
      ? eventDate({ occurredAt: displayedAt }).slice(-2)
      : eventDate({ occurredAt: displayedAt });
    const moreActions = `<details class="thought-more-menu"><summary aria-label="更多思绪操作" title="更多思绪操作">•••</summary><div><button class="subtle-action" type="button" data-remark="${escapeHtml(question.id)}">备注</button>${dispositionActions}<button class="subtle-action" type="button" data-edit-chain="${escapeHtml(question.id)}">编辑问题</button><button class="subtle-action danger" type="button" data-delete-chain="${escapeHtml(question.id)}">移入回收站</button></div></details>`;
    const detailHeader = detail
      ? `<header class="thought-detail-header"><div class="thought-detail-nav"><button class="subtle-action" type="button" data-thought-list>‹ 返回</button><div><button class="subtle-action" type="button" data-open-comments="${escapeHtml(question.id)}" data-annotation-count-root="thought:${escapeHtml(question.id)}" data-annotation-count-state="${annotationCounts.loaded ? "loaded" : "unknown"}" >${escapeHtml(annotationLabel)}</button>${moreActions}</div></div><div class="thought-detail-meta"><time>${formatDate(displayedAt)}</time> <span>${tags}</span>${tracePending ? ` ${tracePending}` : ""}</div><div class="thought-detail-title thought-question-content markdown-content" role="heading" aria-level="1">${renderMarkdown(question.content || "图片记录")}</div>${contentImagesMarkup(question, "thoughtRoot")}</header>`
      : "";
    const summary = detail
      ? '<summary hidden aria-hidden="true"></summary>'
      : `<summary class="chain-summary"><div class="summary-content"><strong class="question-preview">${escapeHtml(plainPreview(question.content) || "图片记录")}</strong>${preview ? `<p class="thought-preview ${preview.kind}"><span>${preview.kind === "conclusion" ? "✓" : "◒"} ${preview.label}</span><span class="thought-preview-text">${escapeHtml(preview.text)}</span></p>` : ""}<span class="thought-open-label">打开 ↗</span></div><span class="expand-mark" aria-hidden="true">⌄</span></summary>`;
    return `<article class="thought-timeline-entry${syncing ? " is-syncing" : ""}${detail ? " thought-detail-entry" : ""}">${detail ? "" : `<div class="timeline-date">${showDate ? escapeHtml(dateLabel) : ""}</div><header class="thought-entry-meta"><time>${formatTime(displayedAt)}</time><div class="thought-entry-markers"><span class="thought-entry-tags">${tags}</span>${tracePending}</div></header>`}<details class="thought-card chain-record${detail ? " thought-detail-record" : ""}" data-chain-id="${escapeHtml(question.id)}"${detail ? " open" : ""}>${summary}<div class="chain-expanded">${detailHeader}${stream(question, children)}${syncing ? "" : `<form class="followup-form" data-follow-up-root="${escapeHtml(question.id)}" hidden><label><span>追问问题</span><textarea rows="3" name="question" placeholder="补充一个追问…" required></textarea></label><label><span>回答（可选）</span><textarea rows="3" name="answer" placeholder="已有答案时可一起记下"></textarea></label><button class="quiet-button followup-submit" type="submit">保存追问</button><p class="followup-status" role="status" aria-live="polite"></p></form>`}<div class="thought-actions">${actions}</div></div></details><div class="thought-chain-speech">${chainSpeech}</div></article>`;
  }

  function cardsMarkup(chains, sortMode = "occurred", {
    detail = false,
    groupMonths = false
  } = {}) {
    const displayDate = chain => sortMode === "created"
      ? eventDate({ occurredAt: chain.question.createdAt || eventTimestamp(chain.question) })
      : thoughtDate(chain);
    let previousMonth = "";
    return chains.map((chain, index) => {
      const date = displayDate(chain);
      const month = date.slice(0, 7);
      const heading = groupMonths && month !== previousMonth
        ? `<h2 class="thought-month">${escapeHtml(thoughtMonthLabel(date))}</h2>`
        : "";
      previousMonth = month;
      return `${heading}${card(
        chain,
        index === 0 || date !== displayDate(chains[index - 1]),
        sortMode,
        { detail, compactDate: groupMonths }
      )}`;
    }).join("");
  }

  function filtersMarkup(chains, selected = "all", projected = []) {
    const tags = [...new Set([
      ...(Array.isArray(projected) ? projected : []),
      ...chains.flatMap(({ question, children }) => [
        ...(question.tags || []),
        ...children.flatMap(item => item.tags || [])
      ])
    ])].sort((left, right) => left.localeCompare(right, "zh-CN"));
    if (selected !== "all" && !tags.includes(selected)) tags.unshift(selected);
    return ["all", ...tags].map(tag => (
      `<button class="filter-button ${selected === tag ? "active" : ""}" data-tag-filter="${escapeHtml(tag)}">${tag === "all" ? "全部" : `#${escapeHtml(tag)}`}</button>`
    )).join("");
  }

  function unavailableRouteMarkup(result) {
    const error = result?.error || {};
    const details = error.details || {};
    return `<section class="empty content-state route-unavailable" role="status" data-route-result="unavailable" data-route-error-code="${escapeHtml(error.code || "RESOURCE_UNAVAILABLE")}" data-route-resource-type="${escapeHtml(details.resourceType || "thought-chain")}"><strong>${escapeHtml(error.message || "这条思绪已不可用")}</strong><p>它可能已被删除，或当前账户无法访问。旧内容不会在这里显示，下面仍是当前可用的思绪列表。</p><button class="quiet-button content-state-action" type="button" data-content-action="dismiss-route-result">继续查看思绪列表</button></section>`;
  }

  return Object.freeze({
    card,
    cardsMarkup,
    filtersMarkup,
    speechControlsMarkup,
    unavailableRouteMarkup
  });
}
