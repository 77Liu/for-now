import { escapeHtml, plainPreview, renderMarkdown } from "../../content/index.mjs";
import {
  normalizeTtsGenerationRate,
  TTS_GENERATION_RATE_MAX,
  TTS_GENERATION_RATE_MIN,
  TTS_PLAYBACK_RATES,
  captureAudioPresentation,
  speechAssetForSource,
  speechAudioPath,
  speechSourceIdentity
} from "../../media/index.mjs";
import { eventDate, eventTimestamp, formatDate, formatTime } from "../../time/index.mjs";

export const normalizeFeedSearch = value => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase("zh-CN")
  .replace(/\s+/g, " ")
  .trim();

const feedSearchText = (...values) => {
  const parts = [];
  const append = value => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach(append);
      return;
    }
    if (typeof value === "object") {
      Object.values(value).forEach(append);
      return;
    }
    parts.push(String(value));
  };
  values.forEach(append);
  return normalizeFeedSearch(parts.join(" "));
};

export const matchesFeedSearch = (query, ...values) => {
  const normalized = normalizeFeedSearch(query);
  if (!normalized) return true;
  const text = feedSearchText(...values);
  return normalized.split(" ").every(term => text.includes(term));
};

export const formatAudioDuration = value => {
  const seconds = Math.max(0, Math.round(Number(value) || 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};

export const formatBytes = value => {
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
};

function speechAssetControlsMarkup({ snapshot, appUrl, sourceId, sourceVersion, label }) {
  if (!speechSourceIdentity("capture", sourceId, sourceVersion)) return "";
  const asset = speechAssetForSource(snapshot.speech.assets, {
    sourceType: "capture",
    sourceId,
    sourceVersion
  });
  const path = speechAudioPath(asset);
  const sourceLabel = String(label || "文字朗读");
  const voiceLabel = (snapshot.speech.voices || [])
    .find(item => item.id === asset?.voice)?.label || "";
  const rateOptions = TTS_PLAYBACK_RATES.map(rate => (
    `<option value="${rate}" ${rate === 1 ? "selected" : ""}>${rate.toFixed(1)}×</option>`
  )).join("");
  const generationRate = normalizeTtsGenerationRate(
    asset?.generationRate ?? snapshot.settings?.speech?.generationRate
  );
  const player = asset && path
    ? `<div class="capture-speech-player speech-asset-player"><audio controls preload="none" src="${escapeHtml(appUrl(path))}" data-speech-player="${escapeHtml(asset.id)}" aria-label="${escapeHtml(`${sourceLabel}播放器`)}"></audio><span>${escapeHtml(voiceLabel ? `${sourceLabel} · ${voiceLabel}` : sourceLabel)}</span><button type="button" class="subtle-action" data-capture-speech-retry hidden>重试读取朗读</button></div>`
    : "";
  if (!player && !snapshot.speech?.configured) return "";
  const generator = snapshot.speech?.configured
    ? `<button type="button" data-speech-synthesize data-speech-regenerate="${asset ? "true" : "false"}" aria-label="${escapeHtml(`${asset ? "重新生成" : "生成"}${sourceLabel}`)}">${asset ? "重新生成" : "生成"}</button>`
    : "";
  const generationControl = snapshot.speech?.configured
    ? `<label><span>生成语速</span><input type="range" min="${TTS_GENERATION_RATE_MIN}" max="${TTS_GENERATION_RATE_MAX}" step="1" value="${generationRate}" data-speech-generation-rate aria-label="${escapeHtml(`${sourceLabel}生成语速`)}"><output>${(1 + generationRate / 100).toFixed(2)}×</output></label>`
    : asset ? `<span class="speech-generation-rate-readonly">生成语速 ${(1 + generationRate / 100).toFixed(2)}×</span>` : "";
  return `<section class="speech-asset-controls" data-speech-source-type="capture" data-speech-source-id="${escapeHtml(sourceId)}" data-speech-source-version="${Number(sourceVersion) || 1}">${player}<div class="capture-speech-actions speech-asset-actions">${generator}${player ? `<label><span>播放倍速</span><select data-speech-playback-rate aria-label="${escapeHtml(`${sourceLabel}播放倍速`)}">${rateOptions}</select></label>` : ""}${generationControl}</div><p class="speech-asset-status" role="status" aria-live="polite"></p></section>`;
}

function derivedTranscription(label, text, lines, kind) {
  if (!text) return "";
  return `<section class="capture-transcription ${escapeHtml(kind)} speech-text-layer" data-speech-text-lines="${lines}" data-speech-text-label="${escapeHtml(label)}" style="--speech-text-lines:${lines}"><small>${escapeHtml(label)}</small><div class="speech-text-frame"><div class="markdown-content">${renderMarkdown(text)}</div></div><button type="button" class="speech-text-expand" data-speech-text-expand aria-expanded="false" aria-label="${escapeHtml(`展开${label}`)}" hidden>展开</button></section>`;
}

function captureAudioMarkup(item, snapshot, appUrl) {
  const audio = item.audio;
  const transcription = item.transcription || null;
  const speech = transcription?.condensedText
    || transcription?.polishedText
    || transcription?.rawText
    || plainPreview(item.content || "");
  if (!audio && !speech) return { text: "", controls: "" };
  const presentation = captureAudioPresentation(item, snapshot.speech, snapshot.aiTasks);
  const layers = [
    transcription?.rawText
      ? `<details class="capture-transcription capture-transcription-raw"><summary>原始转写</summary><div class="markdown-content">${escapeHtml(transcription.rawText).replace(/\r\n?|\n/g, "<br>")}</div></details>`
      : "",
    derivedTranscription("AI 整理稿", transcription?.polishedText, 2, "polished"),
    derivedTranscription("AI 凝练压缩总结稿", transcription?.condensedText, 6, "condensed")
  ].join("");
  let transcriptionState = "";
  if (presentation.transcriptionMessage) {
    const action = presentation.canTranscribe
      && ["failed", "unconfigured"].includes(presentation.transcriptionStatus)
      ? `<button type="button" class="subtle-action" data-capture-transcribe="${escapeHtml(item.id)}" data-capture-audio-key="${escapeHtml(presentation.audioKey)}">${presentation.transcriptionStatus === "failed" ? "重试" : "开始转写"}</button>`
      : "";
    transcriptionState = `<p class="capture-transcription-state ${presentation.transcriptionStatus === "failed" ? "error" : ""}" data-transcription-task-id="${escapeHtml(presentation.transcriptionTaskId)}">${escapeHtml(presentation.transcriptionMessage)}${action}</p>`;
  }
  const speechControls = speech ? speechAssetControlsMarkup({
    snapshot,
    appUrl,
    sourceId: item.id,
    sourceVersion: item.version || 1,
    label: "捕念文字朗读"
  }) : "";
  const original = audio
    ? `<div class="capture-audio-source" data-capture-audio-key="${escapeHtml(presentation.audioKey)}"><audio controls preload="none" src="${escapeHtml(appUrl(audio.attachmentPath))}" aria-label="捕念原始录音播放器"></audio><span>${formatAudioDuration(audio.durationMs)} · <b class="capture-audio-playback-state" data-capture-audio-status>${escapeHtml(presentation.audioStatus)}</b> <button type="button" class="subtle-action" data-capture-audio-retry hidden>重试读取</button></span></div>`
    : "";
  const controls = original || transcriptionState || speechControls
    ? `<section class="capture-audio-record" data-capture-audio-key="${escapeHtml(presentation.audioKey)}" data-transcription-task-id="${escapeHtml(presentation.transcriptionTaskId)}">${original}${transcriptionState}${speechControls}</section>`
    : "";
  return {
    text: layers,
    controls
  };
}

export function captureCardMarkup({
  item,
  showDate = true,
  snapshot,
  appUrl,
  contentImagesMarkup
}) {
  const tags = item.tags?.length ? `#${item.tags.map(escapeHtml).join(" #")}` : "未标记";
  const promotedRoot = (snapshot.thoughts || []).find(value => (
    value.type === "question"
    && value.sourceRef?.type === "capture"
    && value.sourceRef.id === item.id
  ));
  const syncing = item._sync?.status;
  const audio = captureAudioMarkup(item, snapshot, appUrl);
  const actions = syncing
    ? `<span class="capture-sync-state ${escapeHtml(syncing)}">${syncing === "pending" ? "待同步" : "正在同步"}</span>`
    : `${promotedRoot ? `<button type="button" class="capture-promoted-link" data-capture-thought="${escapeHtml(promotedRoot.id)}">已展为思考</button>` : `<button type="button" data-capture-promote="${escapeHtml(item.id)}">展开成思考</button>`}<div class="capture-actions-row"><button type="button" data-capture-edit="${escapeHtml(item.id)}">编辑</button><button type="button" class="danger" data-capture-delete="${escapeHtml(item.id)}" aria-label="删除这条捕念">删除</button></div>`;
  return `<article class="capture-timeline-entry${syncing ? " is-syncing" : ""}" data-capture-id="${escapeHtml(item.id)}"><div class="timeline-date capture-date">${showDate ? escapeHtml(eventDate(item)) : ""}</div><header class="capture-meta"><span class="capture-top-tags">${tags}</span><time class="capture-entry-time">${formatTime(eventTimestamp(item))}</time></header><div class="capture-item" data-expand-key="capture:${escapeHtml(item.id)}"><div class="capture-copy"><div class="capture-content-viewport"><div class="record-actions capture-actions">${actions}</div>${item.title ? `<h3 class="capture-title">${escapeHtml(item.title)}</h3>` : ""}${item.content ? `<div class="markdown-content">${renderMarkdown(item.content)}</div>` : ""}${contentImagesMarkup(item, "capture")}${audio.text}</div>${audio.controls}</div><button class="capture-expand" type="button" data-capture-expand aria-expanded="false" aria-label="展开捕念" hidden>⌄</button></div></article>`;
}

function reflectionMarkup(item, reflection, index, contextReceiptMarkup) {
  const stale = reflection.sourceUpdatedAt
    && reflection.sourceUpdatedAt !== (item.updatedAt || item.createdAt);
  return `<details class="journal-reflection" data-reflection-id="${escapeHtml(reflection.id)}" ${index === 0 ? "open" : ""}><summary><span>助手回望${index ? ` ${item.reflections.length - index}` : ""}</span><small>${stale ? "基于修改前版本 · " : ""}${formatDate(reflection.createdAt)}</small></summary><div class="model-answer-content">${contextReceiptMarkup(reflection.contextReceipt, reflection.citations, reflection.citationStatus)}<div class="markdown-content">${renderMarkdown(reflection.content)}</div></div></details>`;
}

export function journalCardMarkup({ item, contextReceiptMarkup }) {
  const title = item.title || `${eventDate(item)} 日记`;
  const reflections = item.reflections || [];
  const tags = item.tags?.length
    ? `<div class="record-tags">${item.tags.map(tag => `<span>#${escapeHtml(tag)}</span>`).join("")}</div>`
    : "";
  const syncing = item._sync?.status;
  const actions = syncing
    ? `<span class="checkin-sync-state ${escapeHtml(syncing)}">${syncing === "pending" ? "待同步" : "正在同步"}</span>`
    : `<button type="button" class="reflect-action" data-journal-reflect="${escapeHtml(item.id)}">✦ ${reflections.length ? "再次回望" : "请助手回望"}</button><button type="button" data-journal-edit="${escapeHtml(item.id)}">编辑</button><button type="button" class="danger" data-journal-delete="${escapeHtml(item.id)}">删除</button>`;
  const reflectionList = reflections.length
    ? `<section class="journal-reflections"><h3>回望记录</h3>${reflections.map((reflection, index) => reflectionMarkup(item, reflection, index, contextReceiptMarkup)).join("")}</section>`
    : "";
  return `<details class="card journal-entry${syncing ? " is-syncing" : ""}" data-journal-id="${escapeHtml(item.id)}"><summary><div><time>${escapeHtml(eventDate(item))}</time><strong>${escapeHtml(title)}</strong><p>${escapeHtml(plainPreview(item.content))}</p></div><span class="expand-mark" aria-hidden="true">⌄</span></summary><div class="journal-entry-body"><div class="markdown-content journal-original">${renderMarkdown(item.content)}</div>${tags}<div class="record-actions">${actions}</div>${reflectionList}</div></details>`;
}
