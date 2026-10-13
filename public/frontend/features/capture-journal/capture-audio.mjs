import {
  AUDIO_MAX_DURATION_MS,
  preferredRecorderMime,
  uploadOriginalAudio,
  validatedAudioBlob
} from "../../media/index.mjs";

const emptyAudio = () => ({
  blob: null,
  preview: "",
  path: "",
  mimeType: "",
  bytes: 0,
  durationMs: 0,
  uploadRequestId: "",
  uploadedPath: "",
  lastError: null,
  notice: "",
  recorder: null,
  stream: null,
  chunks: [],
  startedAt: 0,
  pausedAt: 0,
  pausedTotal: 0,
  timer: 0,
  stopPromise: null,
  resolveStop: null
});

const requireFunction = (value, name) => {
  if (typeof value !== "function") {
    throw new TypeError(`Capture audio draft requires ${name}`);
  }
  return value;
};

const abortFailure = () => {
  const error = new Error("Capture audio operation changed");
  error.name = "AbortError";
  return error;
};

export function createCaptureAudioDraft({
  store,
  request,
  getAccountId,
  isEditing,
  presentError,
  onChange = () => {},
  encodeAudio,
  readDuration,
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderConstructor = globalThis.MediaRecorder,
  BlobConstructor = globalThis.Blob,
  objectUrls = globalThis.URL,
  createId = () => crypto.randomUUID(),
  now = () => Date.now(),
  setTimer = globalThis.setInterval,
  clearTimer = globalThis.clearInterval,
  confirmReplace = message => globalThis.confirm(message)
} = {}) {
  requireFunction(store?.get, "store.get");
  requireFunction(store?.put, "store.put");
  requireFunction(store?.delete, "store.delete");
  for (const [name, value] of Object.entries({
    request,
    getAccountId,
    isEditing,
    presentError,
    onChange,
    encodeAudio,
    readDuration,
    createId,
    now,
    setTimer,
    clearTimer,
    confirmReplace
  })) requireFunction(value, name);
  requireFunction(objectUrls?.createObjectURL, "objectUrls.createObjectURL");
  requireFunction(objectUrls?.revokeObjectURL, "objectUrls.revokeObjectURL");

  const draftKey = "capture-audio";
  let generation = 0;
  let revision = 0;
  let recordingSerial = 0;
  let startPending = false;
  let uploadFlight = null;
  let storageMutation = Promise.resolve();
  let value = emptyAudio();
  const submissionTicket = Symbol("captureAudioSubmissionTicket");

  const owner = () => String(getAccountId() || "");
  const snapshot = () => Object.freeze({
    ...value,
    chunks: Object.freeze([...value.chunks]),
    startPending,
    recordingState: value.recorder?.state || "",
    active: ["recording", "paused"].includes(value.recorder?.state || "")
  });
  const emit = () => {
    onChange(snapshot());
    return snapshot();
  };
  const sessionTicket = () => ({ generation, owner: owner() });
  const intentTicket = () => ({
    ...sessionTicket(),
    revision
  });
  const contentTicket = () => ({
    ...intentTicket(),
    blob: value.blob,
    uploadRequestId: value.uploadRequestId
  });
  const sameSession = ticket => Boolean(
    ticket
    && ticket.generation === generation
    && ticket.owner === owner()
  );
  const sameIntent = ticket => Boolean(
    sameSession(ticket)
    && ticket.revision === revision
  );
  const sameContent = ticket => Boolean(
    sameIntent(ticket)
    && ticket.blob === value.blob
    && ticket.uploadRequestId === value.uploadRequestId
  );
  const enqueueStorageMutation = operation => {
    const pending = storageMutation.then(operation, operation);
    storageMutation = pending.catch(() => {});
    return pending;
  };
  const stopTracks = stream => {
    stream?.getTracks?.().forEach(track => track.stop());
    if (!stream || value.stream === stream) value.stream = null;
  };
  const revokePreview = preview => {
    if (!preview) return;
    try { objectUrls.revokeObjectURL(preview); } catch {}
  };
  const replaceValue = next => {
    const previousPreview = value.preview;
    value = { ...emptyAudio(), ...next };
    if (previousPreview && previousPreview !== value.preview) revokePreview(previousPreview);
    revision += 1;
    return emit();
  };
  const normalizedResult = (result, ticket = contentTicket()) => Object.freeze({
    attachmentPath: result.attachmentPath,
    mimeType: result.mimeType,
    bytes: result.bytes,
    durationMs: result.durationMs,
    [submissionTicket]: ticket
  });

  async function discardUpload(
    attachmentPath = value.uploadedPath,
    uploadRequestId = value.uploadRequestId
  ) {
    if (!attachmentPath || !uploadRequestId) return false;
    try {
      const result = await request("/api/audio/discard", {
        method: "POST",
        body: JSON.stringify({ attachmentPath, uploadRequestId })
      });
      return result.discarded?.includes(attachmentPath) === true;
    } catch {
      return false;
    }
  }

  async function persist() {
    const accountId = owner();
    if (!accountId || isEditing()) return false;
    const ticket = contentTicket();
    const hasAudio = value.blob || value.path || value.uploadedPath;
    if (!hasAudio) {
      await enqueueStorageMutation(() => store.delete(accountId, draftKey));
      return sameIntent(ticket);
    }
    const audio = value.path ? {
      path: value.path,
      mimeType: value.mimeType,
      bytes: value.bytes,
      durationMs: value.durationMs
    } : {
      blob: value.blob,
      mimeType: value.mimeType,
      bytes: value.bytes,
      durationMs: value.durationMs,
      uploadRequestId: value.uploadRequestId,
      uploadedPath: value.uploadedPath,
      lastError: value.lastError
    };
    const record = {
      owner: accountId,
      id: draftKey,
      updatedAt: new Date(now()).toISOString(),
      audio
    };
    return enqueueStorageMutation(async () => {
      if (!sameContent(ticket)) return false;
      await store.put(record);
      return sameContent(ticket);
    });
  }

  async function restore(accountId) {
    const ticket = intentTicket();
    if (!accountId || accountId !== owner() || value.blob || value.path) return false;
    await storageMutation;
    const stored = await store.get(accountId, draftKey);
    if (!sameIntent(ticket)) return false;
    const audio = stored?.audio;
    if (!audio || (stored.owner && stored.owner !== accountId)) return false;
    if (audio.path) {
      replaceValue({
        path: audio.path,
        mimeType: audio.mimeType || "",
        bytes: Number(audio.bytes) || 0,
        durationMs: Number(audio.durationMs) || 0,
        notice: "已恢复待提交语音。"
      });
      return true;
    }
    if (!audio.blob) return false;
    const normalized = validatedAudioBlob(audio.blob, audio.durationMs);
    replaceValue({
      blob: normalized.blob,
      preview: objectUrls.createObjectURL(normalized.blob),
      mimeType: normalized.mimeType,
      bytes: normalized.bytes,
      durationMs: normalized.durationMs,
      uploadRequestId: audio.uploadRequestId || "",
      uploadedPath: audio.uploadedPath || "",
      lastError: audio.lastError
        ? "上次处理录音未完成。原音草稿仍保存在本机，请重试。"
        : null,
      notice: "已恢复待提交语音。"
    });
    return true;
  }

  async function clear({ forget = true, preserveStored = false } = {}) {
    recordingSerial += 1;
    startPending = false;
    clearTimer(value.timer);
    const recorder = value.recorder;
    const resolveStop = value.resolveStop;
    const stalePath = forget ? value.uploadedPath : "";
    const staleRequestId = value.uploadRequestId;
    if (["recording", "paused"].includes(recorder?.state)) {
      try { recorder.stop(); } catch {}
    }
    stopTracks(value.stream);
    replaceValue({});
    resolveStop?.();
    const accountId = owner();
    if (forget) {
      await Promise.all([
        stalePath ? discardUpload(stalePath, staleRequestId) : Promise.resolve(false),
        accountId && !preserveStored
          ? enqueueStorageMutation(() => store.delete(accountId, draftKey))
          : Promise.resolve(false)
      ]);
    }
    return true;
  }

  async function setBlob(blob, durationMs, { notice = "", ticket = null } = {}) {
    if (ticket && !sameIntent(ticket)) throw abortFailure();
    const audio = validatedAudioBlob(blob, durationMs);
    const stalePath = value.uploadedPath;
    const staleRequestId = value.uploadRequestId;
    replaceValue({
      blob: audio.blob,
      preview: objectUrls.createObjectURL(audio.blob),
      mimeType: audio.mimeType,
      bytes: audio.bytes,
      durationMs: audio.durationMs,
      notice
    });
    await persist();
    if (stalePath) await discardUpload(stalePath, staleRequestId);
    return snapshot();
  }

  async function importFile(file) {
    revision += 1;
    const ticket = intentTicket();
    const durationMs = await readDuration(file);
    if (!sameIntent(ticket)) return false;
    await setBlob(file, durationMs, {
      notice: "音频已保存在本机，提交后同步。",
      ticket
    });
    return true;
  }

  function recordingError(error) {
    const name = String(error?.name || "");
    if (["NotAllowedError", "SecurityError"].includes(name)) {
      return "麦克风权限未开启。当前捕念正文和原有录音没有变化。请开启权限，或改为上传音频。";
    }
    if (name === "NotFoundError") {
      return "没有找到可用的麦克风。当前捕念正文和原有录音没有变化。请连接设备，或改为上传音频。";
    }
    return presentError(error, {
      operation: "开始录音",
      object: "这次录音",
      retained: "当前捕念正文和原有录音没有变化"
    }).message;
  }

  async function start() {
    if (typeof MediaRecorderConstructor !== "function" || !mediaDevices?.getUserMedia) {
      value.lastError = "当前浏览器不支持直接录音，可改为导入音频。";
      emit();
      return false;
    }
    if (startPending || ["recording", "paused"].includes(value.recorder?.state)) return false;
    if ((value.blob || value.path || value.uploadedPath)
      && !confirmReplace("用新录音替换当前语音？")) return false;
    let ticket = intentTicket();
    const serial = ++recordingSerial;
    let stream = null;
    startPending = true;
    value.lastError = null;
    value.notice = "";
    emit();
    try {
      stream = await mediaDevices.getUserMedia({ audio: true });
      if (!sameIntent(ticket) || serial !== recordingSerial) {
        stopTracks(stream);
        return false;
      }
      revision += 1;
      ticket = intentTicket();
      const mimeType = preferredRecorderMime(MediaRecorderConstructor);
      const recorder = mimeType
        ? new MediaRecorderConstructor(stream, { mimeType })
        : new MediaRecorderConstructor(stream);
      let resolveStop;
      let recordingTimer = 0;
      const stopPromise = new Promise(resolve => { resolveStop = resolve; });
      Object.assign(value, {
        stream,
        recorder,
        chunks: [],
        startedAt: now(),
        pausedAt: 0,
        pausedTotal: 0,
        lastError: null,
        stopPromise,
        resolveStop
      });
      recorder.addEventListener("dataavailable", event => {
        if (serial === recordingSerial && event.data?.size) value.chunks.push(event.data);
      });
      recorder.addEventListener("stop", async () => {
        try {
          clearTimer(recordingTimer);
          if (value.timer === recordingTimer) {
            value.timer = 0;
          }
          stopTracks(stream);
          if (!sameIntent(ticket) || serial !== recordingSerial) return;
          const durationMs = Math.min(
            AUDIO_MAX_DURATION_MS,
            now() - value.startedAt - value.pausedTotal
          );
          const blob = new BlobConstructor(value.chunks, {
            type: recorder.mimeType || mimeType
          });
          value.recorder = null;
          try {
            await setBlob(blob, durationMs, {
              notice: "录音已保存在本机，提交后同步。",
              ticket
            });
          } catch (error) {
            value.lastError = presentError(error, {
              operation: "添加录音",
              object: "这段录音",
              retained: "当前捕念正文和已有录音仍保留在页面",
              publicValidation: true
            }).message;
            emit();
          }
        } finally {
          if (value.stopPromise === stopPromise) {
            value.stopPromise = null;
            value.resolveStop = null;
          }
          resolveStop();
        }
      }, { once: true });
      recorder.start(1000);
      recordingTimer = setTimer(() => {
        if (serial !== recordingSerial) return;
        const paused = value.recorder?.state === "paused";
        const elapsed = now() - value.startedAt - value.pausedTotal
          - (paused ? now() - value.pausedAt : 0);
        if (elapsed >= AUDIO_MAX_DURATION_MS) void stop();
        else emit();
      }, 250);
      value.timer = recordingTimer;
      emit();
      return true;
    } catch (error) {
      if (stream) stopTracks(stream);
      if (sameIntent(ticket) && serial === recordingSerial) {
        value.recorder = null;
        value.lastError = recordingError(error);
      }
      emit();
      return false;
    } finally {
      if (serial === recordingSerial) startPending = false;
      emit();
    }
  }

  function togglePause() {
    const recorder = value.recorder;
    if (!recorder) return false;
    if (recorder.state === "recording") {
      recorder.pause();
      value.pausedAt = now();
    } else if (recorder.state === "paused") {
      value.pausedTotal += now() - value.pausedAt;
      value.pausedAt = 0;
      recorder.resume();
    }
    emit();
    return true;
  }

  function stop() {
    const recorder = value.recorder;
    if (recorder?.state === "paused") {
      value.pausedTotal += now() - value.pausedAt;
      value.pausedAt = 0;
    }
    if (recorder && ["recording", "paused"].includes(recorder.state)) recorder.stop();
    return value.stopPromise || Promise.resolve();
  }

  async function cancel() {
    if (!value.stopPromise
      && !["recording", "paused"].includes(value.recorder?.state)) return clear();
    recordingSerial += 1;
    revision += 1;
    clearTimer(value.timer);
    value.timer = 0;
    try { value.recorder.stop(); } catch {}
    stopTracks(value.stream);
    const resolveStop = value.resolveStop;
    Object.assign(value, {
      recorder: null,
      stream: null,
      chunks: [],
      startedAt: 0,
      pausedAt: 0,
      pausedTotal: 0,
      lastError: null,
      stopPromise: null,
      resolveStop: null
    });
    resolveStop?.();
    emit();
    return true;
  }

  async function prepareSubmission() {
    if (startPending) {
      recordingSerial += 1;
      startPending = false;
    }
    await stop();
    revision += 1;
    emit();
    return snapshot();
  }

  async function forSubmission() {
    let ticket = contentTicket();
    if (value.path) {
      return normalizedResult({
        attachmentPath: value.path,
        mimeType: value.mimeType,
        bytes: value.bytes,
        durationMs: value.durationMs
      }, ticket);
    }
    if (!value.blob) return null;
    const valid = validatedAudioBlob(value.blob, value.durationMs);
    if (value.uploadedPath) {
      return normalizedResult({
        attachmentPath: value.uploadedPath,
        mimeType: value.mimeType,
        bytes: value.bytes,
        durationMs: value.durationMs
      }, ticket);
    }
    if (uploadFlight
      && uploadFlight.generation === generation
      && uploadFlight.owner === owner()
      && uploadFlight.blob === value.blob) {
      return uploadFlight.promise;
    }
    value.uploadRequestId ||= createId();
    value.lastError = null;
    value.notice = "";
    revision += 1;
    emit();
    ticket = contentTicket();
    const pending = (async () => {
      await persist();
      if (!sameContent(ticket)) throw abortFailure();
      try {
        const encodedAudio = await encodeAudio(valid.blob);
        if (!sameContent(ticket)) throw abortFailure();
        const result = await uploadOriginalAudio({
          request,
          audio: encodedAudio,
          durationMs: valid.durationMs,
          idempotencyKey: ticket.uploadRequestId
        });
        if (!sameContent(ticket)) {
          await discardUpload(result.attachmentPath, ticket.uploadRequestId);
          throw abortFailure();
        }
        Object.assign(value, {
          uploadedPath: result.attachmentPath,
          mimeType: result.mimeType,
          bytes: result.bytes,
          durationMs: result.durationMs,
          lastError: null
        });
        revision += 1;
        emit();
        ticket = contentTicket();
        await persist();
        return normalizedResult(result, ticket);
      } catch (error) {
        if (sameContent(ticket) && error.name !== "AbortError") {
          value.lastError = presentError(error, {
            operation: "上传捕念语音",
            object: "这段语音",
            phase: "捕念语音上传",
            retained: "原音草稿仍保存在本机"
          }).message;
          emit();
          await persist();
        }
        throw error;
      }
    })();
    uploadFlight = { ...ticket, promise: pending };
    try {
      return await pending;
    } finally {
      if (uploadFlight?.promise === pending) uploadFlight = null;
    }
  }

  async function rollback(attachmentPath) {
    const ticket = contentTicket();
    const staleRequestId = value.uploadRequestId;
    if (!attachmentPath || attachmentPath !== value.uploadedPath) return false;
    if (!await discardUpload(attachmentPath, staleRequestId)) return false;
    if (!sameContent(ticket)) return false;
    value.uploadedPath = "";
    value.uploadRequestId = "";
    revision += 1;
    emit();
    await persist();
    return true;
  }

  function setExisting(audio, { preserveStored = false } = {}) {
    const cleanup = clear({ forget: !preserveStored, preserveStored });
    if (audio) {
      replaceValue({
        path: audio.attachmentPath || "",
        mimeType: audio.mimeType || "",
        bytes: Number(audio.bytes) || 0,
        durationMs: Number(audio.durationMs) || 0
      });
    }
    return Promise.resolve(cleanup).then(() => true);
  }

  function exportDraft() {
    return Object.fromEntries([
      "blob",
      "path",
      "mimeType",
      "bytes",
      "durationMs",
      "uploadRequestId",
      "uploadedPath",
      "lastError"
    ].map(key => [key, value[key]]));
  }

  function replaceDraft(draft) {
    const cleanup = clear({ forget: false, preserveStored: true });
    const next = { ...(draft || {}) };
    if (next.blob) next.preview = objectUrls.createObjectURL(next.blob);
    replaceValue(next);
    return Promise.resolve(cleanup).then(() => true);
  }

  async function complete() {
    await clear({ forget: false, preserveStored: true });
    const accountId = owner();
    if (accountId) {
      await enqueueStorageMutation(() => store.delete(accountId, draftKey));
    }
    return true;
  }

  return Object.freeze({
    snapshot,
    restore,
    persist,
    start,
    togglePause,
    stop,
    cancel,
    prepareSubmission,
    importFile,
    forSubmission,
    isCurrentSubmission(result) {
      const ticket = result?.[submissionTicket];
      return Boolean(ticket && sameContent(ticket));
    },
    rollback,
    clear,
    complete,
    setExisting,
    exportDraft,
    replaceDraft,
    invalidatePendingStart() {
      if (!startPending) return false;
      recordingSerial += 1;
      startPending = false;
      uploadFlight = null;
      emit();
      return true;
    },
    resetSession() {
      generation += 1;
      recordingSerial += 1;
      startPending = false;
      clearTimer(value.timer);
      const resolveStop = value.resolveStop;
      try {
        if (["recording", "paused"].includes(value.recorder?.state)) value.recorder.stop();
      } catch {}
      stopTracks(value.stream);
      replaceValue({});
      resolveStop?.();
      return true;
    }
  });
}
