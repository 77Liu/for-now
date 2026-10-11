import { keepsakeMediaSources } from "../keepsakes-media/index.mjs";
import { keepsakeDerivativeLabel } from "./model.mjs";

// 相同媒体源只更新周边文字，保留已有图片节点以避免重新解码造成闪烁。
export function setKeepsakeMarkup(node, markup) {
  if (!node || node.__keepsakeMarkup === markup) return false;
  const document = node.ownerDocument;
  if (document?.createElement && typeof node.replaceChildren === "function") {
    const template = document.createElement("template");
    template.innerHTML = markup;
    const previousImages = new Map(
      [...(node.querySelectorAll?.("img[data-keepsake-image-key]") || [])]
        .map(image => [image.dataset.keepsakeImageKey, image])
    );
    for (const image of template.content.querySelectorAll(
      "img[data-keepsake-image-key]"
    )) {
      const previous = previousImages.get(image.dataset.keepsakeImageKey);
      if (previous && previous.getAttribute("src") === image.getAttribute("src")) {
        image.replaceWith(previous);
      }
    }
    node.replaceChildren(...template.content.childNodes);
  } else {
    node.innerHTML = markup;
  }
  node.__keepsakeMarkup = markup;
  return true;
}

export function clearKeepsakeMarkup(node) {
  if (!node || node.__keepsakeMarkup === "") return;
  node.innerHTML = "";
  node.__keepsakeMarkup = "";
}

export function createKeepsakeMarkup({ state, view } = {}) {
  const escape = value => view.escapeMarkup(value ?? "");

  function imageMarkup(item, className = "", loading = "lazy", mode = "list") {
    let imagePath = "";
    let backgroundPath = "";
    try {
      ({ imagePath, backgroundPath = "" } = keepsakeMediaSources(item, mode));
    } catch {
      const status = item.media?.status || item.derivativeState;
      const label = status === "pending"
        ? "正在生成"
        : status === "failed" ? "生成失败" : "暂无图片";
      return `<span class="keepsake-image-stack ${className} is-unavailable" `
        + `data-keepsake-media="${escape(item.id || "")}">`
        + `<span class="keepsake-media-placeholder">${label}</span></span>`;
    }
    if (mode === "home") backgroundPath = "";
    const opacity = Math.max(
      0,
      Math.min(30, Number(item.backgroundOpacityPct ?? 15))
    ) / 100;
    return `<span class="keepsake-image-stack ${className}" `
      + `data-keepsake-media="${escape(item.id || imagePath)}" `
      + `style="--keepsake-background-opacity:${opacity}">`
      + (backgroundPath
        ? `<img class="keepsake-image-background" data-keepsake-image-key="${escape(item.id || imagePath)}:background" `
          + `src="${escape(view.appUrl(backgroundPath))}" alt="" loading="${loading}">`
        : "")
      + `<img class="keepsake-image-cutout" data-keepsake-image-key="${escape(item.id || imagePath)}:cutout" `
      + `src="${escape(view.appUrl(imagePath))}" `
      + `alt="${escape(item.title)}" loading="${loading}"></span>`;
  }

  const tagsMarkup = tags => (tags || []).length
    ? `<span class="keepsake-tags">${tags.map(tag => (
        `<span>#${escape(tag)}</span>`
      )).join("")}</span>`
    : "";

  function cardMarkup(item, loading = "lazy") {
    const derivative = keepsakeDerivativeLabel(item);
    return `<article class="keepsake-card" data-keepsake-id="${escape(item.id)}">`
      + `<button class="keepsake-card-open" type="button" `
      + `data-keepsake-open="${escape(item.id)}" aria-label="查看 ${escape(item.title)} 详情">`
      + imageMarkup(item, "keepsake-card-image", loading)
      + `<span class="keepsake-card-copy"><span class="keepsake-card-meta">`
      + `<time>${view.formatDate(view.eventTimestamp(item))}</time></span>`
      + `<strong>${escape(item.title)}</strong>`
      + (derivative ? `<span class="keepsake-derivative-state">${derivative}</span>` : "")
      + (item.note ? `<span class="keepsake-card-note">${escape(item.note)}</span>` : "")
      + `${tagsMarkup(item.tags)}</span></button><div class="keepsake-card-actions">`
      + (item.derivativeState === "failed"
        ? `<button type="button" data-keepsake-derive="${escape(item.id)}">重试清晰图</button>`
        : "")
      + `<button type="button" data-keepsake-edit="${escape(item.id)}">编辑</button>`
      + `<button type="button" class="danger" data-keepsake-delete="${escape(item.id)}">删除</button>`
      + "</div></article>";
  }

  function detailMarkup(item) {
    const original = state.activeView === "original";
    const derivative = keepsakeDerivativeLabel(item);
    const presented = original
      ? { ...item, originalPath: state.activeOriginalPath }
      : item;
    return `<nav class="keepsake-detail-nav"><button class="book-back" type="button" `
      + `data-keepsake-back>← 返回陈列</button><div class="keepsake-detail-actions">`
      + (item.derivativeState === "failed"
        ? `<button class="text-button" type="button" data-keepsake-derive="${escape(item.id)}">重试清晰图</button>`
        : "")
      + `<button class="text-button" type="button" data-keepsake-edit="${escape(item.id)}">编辑</button>`
      + `<button class="text-button danger" type="button" data-keepsake-delete="${escape(item.id)}">删除</button>`
      + `</div></nav><div class="keepsake-detail-layout"><section class="keepsake-detail-media">`
      + `<div class="keepsake-detail-viewbar"><span>${original
        ? "原始照片"
        : derivative || `主体清晰 · 环境 ${Math.max(0, Math.min(30, Number(item.backgroundOpacityPct ?? 15)))}%`
      }</span><div class="segmented-control" aria-label="图片显示方式">`
      + `<button type="button" data-keepsake-view="presentation" `
      + `aria-pressed="${String(!original)}" class="${original ? "" : "active"}">呈现</button>`
      + `<button type="button" data-keepsake-view="original" `
      + `aria-pressed="${String(original)}" class="${original ? "active" : ""}">原图</button>`
      + `</div></div><div class="keepsake-detail-image-wrap">`
      + imageMarkup(
        presented,
        "keepsake-detail-image",
        "eager",
        original ? "original" : "detail"
      )
      + `</div></section><section class="keepsake-detail-copy"><p class="eyebrow">小物留存</p>`
      + `<h2>${escape(item.title)}</h2><time datetime="${escape(view.eventTimestamp(item))}">`
      + `${escape(view.formatDateKey(view.eventDate(item)))} · ${view.formatTime(view.eventTimestamp(item))}`
      + `</time>${tagsMarkup(item.tags)}<p class="keepsake-detail-note">`
      + `${item.note ? escape(item.note) : "没有留下文字备注。"}</p></section></div>`;
  }

  return Object.freeze({ imageMarkup, cardMarkup, detailMarkup, tagsMarkup });
}
