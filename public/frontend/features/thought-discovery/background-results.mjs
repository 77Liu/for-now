const RESOURCE_COLLECTIONS = Object.freeze({
  capture: "captures",
  journal: "journals",
  chat: "chats",
  analysis: "analyses",
  book: "books",
  quote: "quotes"
});

const text = value => typeof value === "string" ? value : "";

export function backgroundTaskTarget(task) {
  if (!task || task.status !== "succeeded" || !text(task.id) || !text(task.resultId)) return null;
  if (task.kind === "thoughtAnswer") {
    return {
      kind: "thoughtAnswer",
      resourceType: "thought",
      targetId: text(task.targetId),
      resultId: text(task.resultId)
    };
  }
  if (task.kind === "followUpAnswer" && text(task.subtargetId)) {
    return {
      kind: "followUpAnswer",
      resourceType: "thought",
      targetId: text(task.targetId),
      subtargetId: text(task.subtargetId),
      resultId: text(task.resultId)
    };
  }
  if (task.kind === "captureTranscription" && text(task.targetId)) {
    return {
      kind: "captureTranscription",
      resourceType: "capture",
      targetId: text(task.targetId),
      resultId: text(task.resultId)
    };
  }
  if (task.kind === "annotationShenji" && text(task.resourceType) && text(task.subtargetId)) {
    return {
      kind: "annotationShenji",
      resourceType: text(task.resourceType),
      targetId: text(task.targetId),
      subtargetId: text(task.subtargetId),
      resultId: text(task.resultId)
    };
  }
  if (task.kind === "contentImageUnderstanding" && text(task.contentTargetType) && text(task.contentTargetId)) {
    return {
      kind: "contentImageUnderstanding",
      resourceType: text(task.resourceType),
      targetId: text(task.targetId),
      subtargetId: text(task.subtargetId),
      contentTargetType: text(task.contentTargetType),
      contentTargetId: text(task.contentTargetId),
      resultId: text(task.resultId)
    };
  }
  return null;
}

export function backgroundResultFromSnapshot(snapshot, task) {
  const target = backgroundTaskTarget(task);
  if (!target) return null;
  if (task.kind === "thoughtAnswer") {
    return (Array.isArray(snapshot?.thoughts) ? snapshot.thoughts : []).find(item => (
      item?.id === task.resultId
      && item.type === "answer"
      && item.relatedTo === task.targetId
      && item.sourceTaskId === task.id
    )) || null;
  }
  if (task.kind === "followUpAnswer") {
    const root = (Array.isArray(snapshot?.thoughts) ? snapshot.thoughts : [])
      .find(item => item?.id === task.targetId && item.type === "question");
    const followUp = root?.followUps?.find(item => item?.id === task.subtargetId);
    return followUp?.id === task.resultId && followUp.sourceTaskId === task.id ? followUp : null;
  }
  if (task.kind === "captureTranscription") {
    const capture = (Array.isArray(snapshot?.captures) ? snapshot.captures : [])
      .find(item => item?.id === task.targetId);
    return capture?.id === task.resultId && capture.transcription?.status === "ready" ? capture : null;
  }
  if (task.kind === "contentImageUnderstanding") {
    const targetType = text(task.contentTargetType), targetId = text(task.contentTargetId);
    let resource = null;
    if (targetType === "capture") {
      resource = (Array.isArray(snapshot?.captures) ? snapshot.captures : []).find(item => item?.id === targetId);
    } else if (targetType === "thoughtRoot") {
      resource = (Array.isArray(snapshot?.thoughts) ? snapshot.thoughts : []).find(item => item?.id === targetId && item.type === "question");
    } else if (targetType === "thoughtBlock") {
      resource = (Array.isArray(snapshot?.thoughts) ? snapshot.thoughts : []).find(item => item?.id === targetId && item.type !== "question");
    } else if (targetType === "comment") {
      const collection = task.resourceType === "thought" ? "thoughts" : RESOURCE_COLLECTIONS[task.resourceType];
      const parent = (collection && Array.isArray(snapshot?.[collection]) ? snapshot[collection] : [])
        .find(item => item?.id === task.targetId);
      resource = parent?.annotations?.find(item => item?.id === targetId);
    }
    return resource?.imageUnderstandings?.find(item => (
      item?.id === task.resultId && item.sourceTaskId === task.id
    )) || null;
  }
  const collection = task.resourceType === "thought" ? "thoughts" : RESOURCE_COLLECTIONS[task.resourceType];
  const root = (collection && Array.isArray(snapshot?.[collection]) ? snapshot[collection] : [])
    .find(item => item?.id === task.targetId && (task.resourceType !== "thought" || item.type === "question"));
  const annotation = root?.annotations?.find(item => item?.id === task.subtargetId);
  return annotation?.shenji?.find(item => item?.id === task.resultId && item.sourceTaskId === task.id) || null;
}

function upsert(items, value, taskId) {
  const index = items.findIndex(item => item?.id === value.id || (taskId && item?.sourceTaskId === taskId));
  if (index < 0) return [value, ...items];
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...value } : item);
}

const matchesTaskResult = (task, result) => Boolean(
  result?.id === task.resultId
  && (!result.sourceTaskId || result.sourceTaskId === task.id)
);

function mergeThoughtAnswer(snapshot, task, result) {
  if (!matchesTaskResult(task, result) || result.relatedTo !== task.targetId || result.type !== "answer") {
    return { value: snapshot, changed: false };
  }
  const thoughts = Array.isArray(snapshot?.thoughts) ? snapshot.thoughts : [];
  if (!thoughts.some(item => item?.id === task.targetId && item.type === "question")) {
    return { value: snapshot, changed: false };
  }
  return {
    value: { ...snapshot, thoughts: upsert(thoughts, { ...result }, task.id) },
    changed: true,
    target: backgroundTaskTarget(task)
  };
}

function mergeFollowUpAnswer(snapshot, task, result) {
  if (!matchesTaskResult(task, result) || result.id !== task.subtargetId) {
    return { value: snapshot, changed: false };
  }
  const thoughts = Array.isArray(snapshot?.thoughts) ? snapshot.thoughts : [];
  let changed = false;
  const nextThoughts = thoughts.map(item => {
    if (item?.id !== task.targetId || item.type !== "question") return item;
    const followUps = Array.isArray(item.followUps) ? item.followUps : [];
    if (!followUps.some(followUp => followUp?.id === task.subtargetId)) return item;
    changed = true;
    return {
      ...item,
      followUps: followUps.map(followUp => followUp.id === task.subtargetId
        ? { ...followUp, ...result }
        : followUp)
    };
  });
  return changed ? {
    value: { ...snapshot, thoughts: nextThoughts },
    changed: true,
    target: backgroundTaskTarget(task)
  } : { value: snapshot, changed: false };
}

function mergeCaptureTranscription(snapshot, task, result) {
  if (result?.id !== task.targetId || result?.id !== task.resultId || result.transcription?.status !== "ready") {
    return { value: snapshot, changed: false };
  }
  const captures = Array.isArray(snapshot?.captures) ? snapshot.captures : [];
  if (!captures.some(item => item?.id === task.targetId)) return { value: snapshot, changed: false };
  return {
    value: {
      ...snapshot,
      captures: captures.map(item => item.id === task.targetId ? { ...item, ...result } : item)
    },
    changed: true,
    target: backgroundTaskTarget(task)
  };
}

function mergeAnnotationReply(snapshot, task, result) {
  if (!matchesTaskResult(task, result)) return { value: snapshot, changed: false };
  const collection = task.resourceType === "thought" ? "thoughts" : RESOURCE_COLLECTIONS[task.resourceType];
  const records = collection && Array.isArray(snapshot?.[collection]) ? snapshot[collection] : null;
  if (!records) return { value: snapshot, changed: false };
  let changed = false;
  const nextRecords = records.map(record => {
    const isTarget = task.resourceType === "thought"
      ? record?.id === task.targetId && record.type === "question"
      : record?.id === task.targetId;
    if (!isTarget) return record;
    const annotations = Array.isArray(record.annotations) ? record.annotations : [];
    if (!annotations.some(annotation => annotation?.id === task.subtargetId)) return record;
    changed = true;
    return {
      ...record,
      annotations: annotations.map(annotation => annotation.id === task.subtargetId
        ? {
            ...annotation,
            shenji: upsert(Array.isArray(annotation.shenji) ? annotation.shenji : [], { ...result }, task.id)
          }
        : annotation)
    };
  });
  return changed ? {
    value: { ...snapshot, [collection]: nextRecords },
    changed: true,
    target: backgroundTaskTarget(task)
  } : { value: snapshot, changed: false };
}

function withUnderstanding(resource, task, result) {
  return {
    ...resource,
    version: Math.max(Number(resource?.version) || 1, (Number(result.sourceVersion) || 1) + 1),
    imageUnderstandings: upsert(Array.isArray(resource?.imageUnderstandings) ? resource.imageUnderstandings : [], { ...result }, task.id)
  };
}

function mergeContentImageUnderstanding(snapshot, task, result) {
  if (!matchesTaskResult(task, result)) return { value: snapshot, changed: false };
  const targetType = text(task.contentTargetType), targetId = text(task.contentTargetId);
  if (targetType === "capture") {
    const captures = Array.isArray(snapshot?.captures) ? snapshot.captures : [];
    if (!captures.some(item => item?.id === targetId)) return { value: snapshot, changed: false };
    return {
      value: { ...snapshot, captures: captures.map(item => item.id === targetId ? withUnderstanding(item, task, result) : item) },
      changed: true,
      target: backgroundTaskTarget(task)
    };
  }
  if (targetType === "thoughtRoot" || targetType === "thoughtBlock") {
    const thoughts = Array.isArray(snapshot?.thoughts) ? snapshot.thoughts : [];
    const matched = thoughts.find(item => item?.id === targetId && (targetType === "thoughtRoot" ? item.type === "question" : item.type !== "question"));
    if (!matched) return { value: snapshot, changed: false };
    return {
      value: {
        ...snapshot,
        thoughts: thoughts.map(item => {
          if (item.id === targetId) return withUnderstanding(item, task, result);
          if (targetType === "thoughtBlock" && item.id === matched.relatedTo && item.type === "question") {
            return { ...item, version: (Number(item.version) || 1) + 1 };
          }
          return item;
        })
      },
      changed: true,
      target: backgroundTaskTarget(task)
    };
  }
  if (targetType !== "comment") return { value: snapshot, changed: false };
  const collection = task.resourceType === "thought" ? "thoughts" : RESOURCE_COLLECTIONS[task.resourceType];
  const records = collection && Array.isArray(snapshot?.[collection]) ? snapshot[collection] : null;
  if (!records) return { value: snapshot, changed: false };
  let changed = false;
  const nextRecords = records.map(record => {
    if (record?.id !== task.targetId) return record;
    const annotations = Array.isArray(record.annotations) ? record.annotations : [];
    if (!annotations.some(annotation => annotation?.id === targetId)) return record;
    changed = true;
    return {
      ...record,
      version: (Number(record.version) || 1) + 1,
      annotations: annotations.map(annotation => annotation.id === targetId
        ? withUnderstanding(annotation, task, result)
        : annotation)
    };
  });
  return changed ? {
    value: { ...snapshot, [collection]: nextRecords },
    changed: true,
    target: backgroundTaskTarget(task)
  } : { value: snapshot, changed: false };
}

export function mergeBackgroundTaskResult(snapshot, task, result) {
  if (!backgroundTaskTarget(task)) return { value: snapshot, changed: false };
  if (task.kind === "thoughtAnswer") return mergeThoughtAnswer(snapshot, task, result);
  if (task.kind === "followUpAnswer") return mergeFollowUpAnswer(snapshot, task, result);
  if (task.kind === "captureTranscription") return mergeCaptureTranscription(snapshot, task, result);
  if (task.kind === "contentImageUnderstanding") return mergeContentImageUnderstanding(snapshot, task, result);
  return mergeAnnotationReply(snapshot, task, result);
}

export function createBackgroundResultController({
  loadResult,
  applyResult,
  captureViewState = () => null,
  restoreViewState = () => {},
  onError = () => {}
}) {
  if (typeof loadResult !== "function" || typeof applyResult !== "function") {
    throw new TypeError("Background result controller requires loadResult and applyResult");
  }
  let epoch = 0;
  const applied = new Set();
  const inFlight = new Set();

  async function applyTask(task, generation) {
    const target = backgroundTaskTarget(task);
    if (!target) return false;
    const fingerprint = `${task.id}:${task.resultId}`;
    if (applied.has(fingerprint) || inFlight.has(fingerprint)) return false;
    inFlight.add(fingerprint);
    try {
      const result = await loadResult(task, target);
      if (generation !== epoch) return false;
      if (result == null) throw new Error("Background task result is not available");
      const viewState = captureViewState(target);
      let resultApplied;
      try {
        resultApplied = await applyResult({ task, target, result });
      } finally {
        if (generation === epoch) restoreViewState(viewState, target);
      }
      if (generation !== epoch || resultApplied === false) return false;
      applied.add(fingerprint);
      return true;
    } catch (error) {
      if (generation === epoch) onError(error, task, target);
      return false;
    } finally {
      inFlight.delete(fingerprint);
    }
  }

  return Object.freeze({
    async sync(tasks = []) {
      const generation = epoch;
      let changed = false;
      for (const task of Array.isArray(tasks) ? tasks : []) {
        if (await applyTask(task, generation)) changed = true;
        if (generation !== epoch) return false;
      }
      return changed;
    },
    forget(taskId) {
      const prefix = `${taskId}:`;
      for (const fingerprint of applied) if (fingerprint.startsWith(prefix)) applied.delete(fingerprint);
    },
    reset() {
      epoch += 1;
      applied.clear();
      inFlight.clear();
    }
  });
}
