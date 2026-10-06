const SOURCE_COLLECTIONS = Object.freeze({
  capture: "captures",
  journal: "journals",
  thought: "thoughts",
  checkin: "checkins",
  dailyRecord: "dailyRecords"
});

export function currentContextSource(source, snapshot = {}) {
  const type = source?.resourceType;
  const id = source?.resourceId;
  const key = source?.location?.targetKey || "";
  if (type === "onboarding") {
    const onboarding = snapshot?.onboarding;
    if (!onboarding || onboarding.status !== "completed") {
      return { exists: false, text: "" };
    }
    const base = {
      exists: true,
      version: Number(source?.version) || 1,
      occurredAt: onboarding.updatedAt || ""
    };
    if (key === "understanding") {
      return {
        ...base,
        exists: Boolean(onboarding.understanding),
        text: onboarding.understanding || ""
      };
    }
    if (key === "viewpoints") {
      return {
        ...base,
        text: [
          Object.keys(onboarding.answers || {}).length
            ? `初始问卷 ${Object.keys(onboarding.answers || {}).length} 项`
            : "",
          onboarding.material || ""
        ].filter(Boolean).join(" · ")
      };
    }
    return {
      ...base,
      text: [
        ...Object.values(onboarding.profile || {}),
        ...(onboarding.interests || [])
      ].filter(Boolean).join(" · ")
    };
  }

  const collection = SOURCE_COLLECTIONS[type];
  const item = collection && Array.isArray(snapshot?.[collection])
    ? snapshot[collection].find(value => value?.id === id)
    : null;
  if (!item) return { exists: false, text: "" };
  const base = {
    exists: true,
    version: Number(item.version) || 1,
    occurredAt: item.occurredAt || item.createdAt || item.updatedAt || ""
  };
  if (type === "capture") {
    return { ...base, text: item.content || "图片或语音捕念" };
  }
  if (type === "journal") {
    return {
      ...base,
      text: `${item.title ? `${item.title}：` : ""}${item.content || ""}`
    };
  }
  if (type === "thought") {
    return { ...base, text: item.content || item.modelDraft || "" };
  }
  if (type === "checkin") {
    return {
      ...base,
      text: `情绪 ${item.mood} · 精力 ${item.energy} · 压力 ${item.stress} · 睡眠 ${item.sleep}`
    };
  }
  return {
    ...base,
    text: item.description || item.exerciseType || `${item.type || "健康"}记录`
  };
}

export function contextSourceView(source, snapshot = {}) {
  const location = source?.location || {};
  const hasExcerpt = Boolean(source?.excerpt);
  const live = hasExcerpt
    ? { exists: true, text: source.excerpt }
    : currentContextSource(source, snapshot);
  const matches = hasExcerpt || Boolean(
    live.exists
    && live.version === (Number(source?.version) || 1)
    && (
      source?.resourceType !== "onboarding"
      || !source?.occurredAt
      || live.occurredAt === source.occurredAt
    )
  );
  const canOpen = Boolean(
    live.exists
    && location.view
    && location.view !== "personal-context"
  );
  const copy = !live.exists
    ? "来源已删除或当前不可用"
    : matches
      ? live.text
      : "来源当前版本已变化；旧摘录未保留";
  return Object.freeze({ location, live, matches, canOpen, copy });
}

export function contextSourceMarkup(source, {
  snapshot,
  escapeMarkup,
  plainPreview
}) {
  const view = contextSourceView(source, snapshot);
  const location = view.location;
  return `<article class="context-source-item${
    view.live.exists && view.matches ? "" : " unavailable"
  }"><div><b>${escapeMarkup(source?.recordType || "记录")}</b><small>${
    escapeMarkup(source?.occurredOn || "时间未记")
  } · 版本 ${Number(source?.version) || 1}</small></div><p>${
    escapeMarkup(plainPreview(view.copy))
  }</p>${
    view.canOpen
      ? `<button class="subtle-action" type="button" data-context-source data-context-view="${
        escapeMarkup(location.view)
      }" data-context-target="${
        escapeMarkup(location.targetId || source?.resourceId || "")
      }" data-context-root="${
        escapeMarkup(location.rootId || "")
      }" data-context-key="${
        escapeMarkup(location.targetKey || "")
      }" data-context-date="${
        escapeMarkup(location.occurredOn || source?.occurredOn || "")
      }" data-context-daily-type="${
        escapeMarkup(location.dailyType || "")
      }">查看${view.matches ? "原记录" : "当前版本"}</button>`
      : ""
  }</article>`;
}
