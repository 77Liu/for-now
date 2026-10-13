import { eventTimestamp, formatTime } from "../../time/index.mjs";
import { journalCardMarkup, matchesFeedSearch } from "./presentation.mjs";
import { resolveSynchronousPersonalizedResponse } from "../../../generated/personalized-ai-task.mjs";
import { isPendingAiTaskStatus } from "../../shared/ai-task-status.mjs";

const noop = () => {};
const splitTags = value => String(value || "")
  .split(/[,，#\s]+/)
  .map(item => item.trim())
  .filter(Boolean);

function requireFunctions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "function") {
      throw new TypeError(`Journals feature ${group} requires ${name}`);
    }
  }
}

export function createJournalsFeatureController({
  data = {},
  annotations = {},
  assistant = {},
  view = {},
  platform = {}
} = {}) {
  requireFunctions("data port", {
    getSnapshot: data.getSnapshot,
    getAccountId: data.getAccountId,
    getSessionSerial: data.getSessionSerial,
    request: data.request,
    requestV1: data.requestV1,
    requestStream: data.requestStream,
    refresh: data.refresh,
    applyPendingProjection: data.applyPendingProjection,
    publish: data.publish
  });
  requireFunctions("annotation port", {
    markTarget: annotations.markTarget,
    applyAnchors: annotations.applyAnchors,
    rootKey: annotations.rootKey
  });
  requireFunctions("assistant port", {
    runAnswer: assistant.runAnswer
  });
  requireFunctions("view port", {
    contentState: view.contentState,
    contextReceiptMarkup: view.contextReceiptMarkup,
    renderLatex: view.renderLatex,
    showToast: view.showToast,
    presentError: view.presentError,
    resetOccurrenceInput: view.resetOccurrenceInput,
    occurrenceFields: view.occurrenceFields,
    entryKeyIntent: view.entryKeyIntent
  });
  requireFunctions("platform port", {
    createRequestId: platform.createRequestId,
    requestFrame: platform.requestFrame,
    confirm: platform.confirm,
    escapeSelector: platform.escapeSelector
  });
  if (!platform.document) throw new TypeError("Journals feature requires document");

  const { document } = platform;
  const resolvePersonalizedTask = data.resolvePersonalizedTask
    || (async response => resolveSynchronousPersonalizedResponse(response));
  let activation = null;
  let surface = null;
  let submissionPromise = null;
  let draftSavePromise = null;
  let assistPromise = null;
  let session = {};
  let generation = 0;
  let searchQuery = "";
  let draftRestored = false;
  const root = () => activation?.root || surface;
  const query = selector => root()?.querySelector(selector) || null;
  const queryAll = selector => [...(root()?.querySelectorAll(selector) || [])];
  const accountTicket = () => ({
    session,
    owner: String(data.getAccountId() || ""),
    serial: data.getSessionSerial()
  });
  const sameAccount = value => Boolean(
    value
    && value.session === session
    && value.owner === String(data.getAccountId() || "")
    && value.serial === data.getSessionSerial()
  );
  const ticket = () => ({ ...accountTicket(), activation });
  const current = value => Boolean(
    sameAccount(value)
    && value.activation
    && value.activation === activation
    && !value.activation.signal?.aborted
  );
  const publicValidation = callback => {
    try {
      return callback();
    } catch (error) {
      const wrapped = new Error(String(error?.message || "输入不符合要求"), { cause: error });
      wrapped.publicValidation = true;
      throw wrapped;
    }
  };

  function syncFlightControls() {
    const saveButton = query("#journal-draft-save");
    const submitButton = query("#journal-submit");
    if (saveButton) {
      saveButton.disabled = Boolean(draftSavePromise || submissionPromise);
      saveButton.textContent = draftSavePromise ? "正在保存…" : "保存草稿";
    }
    if (submitButton) submitButton.disabled = Boolean(draftSavePromise || submissionPromise);
    queryAll("[data-journal-assist]").forEach(button => {
      button.disabled = Boolean(assistPromise);
    });
  }

  function resetForm() {
    const form = query("#journal-form");
    form?.reset();
    if (query("#journal-id")) query("#journal-id").value = "";
    view.resetOccurrenceInput(query("#journal-date"));
    if (query("#journal-submit")) query("#journal-submit").textContent = "保存日记";
    if (query("#journal-cancel")) query("#journal-cancel").hidden = true;
    if (query("#journal-status")) query("#journal-status").textContent = "";
    if (query("#journal-assist-status")) query("#journal-assist-status").textContent = "";
    return true;
  }

  function restoreDraft(draft) {
    if (!draft) return false;
    const item = (data.getSnapshot().journals || [])
      .find(value => value.id === draft.journalId);
    query("#journal-form")?.reset();
    query("#journal-id").value = item?.id || "";
    query("#journal-title").value = draft.title || "";
    query("#journal-content").value = draft.content || "";
    view.resetOccurrenceInput(query("#journal-date"), item || null);
    query("#journal-tags").value = item
      ? (item.tags || []).map(tag => `#${tag}`).join(" ")
      : "";
    query("#journal-submit").textContent = item ? "保存修改" : "保存日记";
    query("#journal-cancel").hidden = !item;
    query("#journal-assist-status").textContent = "";
    query("#journal-status").textContent =
      `已恢复 ${formatTime(draft.updatedAt)} 保存的草稿。`;
    return true;
  }

  function editJournal(id) {
    const item = (data.getSnapshot().journals || []).find(value => value.id === id);
    if (!item) return false;
    query("#journal-id").value = item.id;
    query("#journal-title").value = item.title || "";
    view.resetOccurrenceInput(query("#journal-date"), item);
    query("#journal-content").value = item.content;
    query("#journal-tags").value = (item.tags || []).map(tag => `#${tag}`).join(" ");
    query("#journal-submit").textContent = "保存修改";
    query("#journal-cancel").hidden = false;
    query("#journal-status").textContent = item.reflections?.length
      ? "修改原文后，已有回望仍会保留并标记为旧版本。"
      : "正在编辑已有日记";
    query("#journal-form").scrollIntoView({ behavior: "smooth", block: "start" });
    query("#journal-content").focus();
    return true;
  }

  function render() {
    if (!root()) return false;
    if (!draftRestored) {
      draftRestored = true;
      restoreDraft(data.getSnapshot().journalDraft);
    }
    const open = new Set(queryAll(".journal-entry[open]")
      .map(item => item.dataset.journalId));
    const allItems = [...(data.getSnapshot().journals || [])]
      .sort((left, right) => eventTimestamp(right).localeCompare(eventTimestamp(left)));
    const items = allItems.filter(item => matchesFeedSearch(
      searchQuery,
      item.title,
      item.content,
      item.tags,
      item.reflections?.map(value => value.content)
    ));
    query("#journal-count").textContent = searchQuery
      ? `${items.length} / ${allItems.length} 篇`
      : `${allItems.length} 篇`;
    const list = query("#journal-list");
    list.innerHTML = items.length
      ? items.map(item => journalCardMarkup({
        item,
        contextReceiptMarkup: view.contextReceiptMarkup
      })).join("")
      : allItems.length
        ? view.contentState({
          title: "没有匹配的日记",
          body: "换一个关键词，原有记录不会受到影响。"
        })
        : view.contentState({
          title: "还没有日记",
          body: "不需要写完整，一句真实的话也可以成为记录。",
          action: { focus: "journal-content", label: "写第一篇" }
        });
    for (const card of queryAll(".journal-entry")) {
      const item = items.find(value => value.id === card.dataset.journalId);
      if (!item) continue;
      if (open.has(item.id)) card.open = true;
      if (item._sync) continue;
      const rootKey = annotations.rootKey("journal", item.id);
      annotations.markTarget(card.querySelector(".journal-original"), rootKey, "content");
      for (const reflection of item.reflections || []) {
        annotations.markTarget(
          card.querySelector(
            `[data-reflection-id="${platform.escapeSelector(reflection.id)}"] .model-answer-content>.markdown-content`
          ),
          rootKey,
          `reflection:${reflection.id}`
        );
      }
    }
    view.renderLatex(list);
    annotations.applyAnchors(list);
    return true;
  }

  async function assist(button) {
    const mode = button.dataset.journalAssist;
    const editor = query("#journal-content");
    const status = query("#journal-assist-status");
    const buttons = queryAll("[data-journal-assist]");
    const labels = { lead: "引子", structure: "结构", topic: "话题" };
    const title = query("#journal-title").value;
    const date = query("#journal-date").value;
    const content = editor.value;
    const journalId = query("#journal-id").value;
    const operation = ticket();
    buttons.forEach(item => { item.disabled = true; });
    status.textContent = `正在生成${labels[mode]}…`;
    try {
      let streamed = "";
      const requestId = platform.createRequestId();
      const targetId = journalId || "journal-draft";
      const inputVersion = Date.now();
      const initialResponse = await data.requestStream(
        "/api/journals/assist",
        {
          method: "POST",
          body: JSON.stringify({
            requestId,
            targetId,
            inputVersion,
            mode,
            occurredAt: date,
            title,
            content
          })
        },
        event => {
          if (current(operation) && event.type === "content") {
            streamed += event.delta || "";
            status.textContent = `正在生成${labels[mode]}… ${streamed.length} 字`;
          }
        }
      );
      const settled = await resolvePersonalizedTask(initialResponse, {
        operationLabel: labels[mode],
        expectedKind: "journalAssist",
        onStatus: message => {
          if (current(operation)) status.textContent = message;
        }
      });
      if (settled.abandoned) return false;
      const result = settled.result;
      const taskMismatch = settled.task && (
        settled.task.targetId !== targetId
        || (Number(settled.task.inputVersion) > 0
          && Number(settled.task.inputVersion) !== Number(inputVersion))
      );
      const resultMismatch = (result.requestId && result.requestId !== requestId)
        || (result.targetId && result.targetId !== targetId)
        || (result.inputVersion != null
          && Number(result.inputVersion) !== Number(inputVersion));
      if (taskMismatch || resultMismatch) {
        if (current(operation)) {
          status.textContent = `${labels[mode]}任务与当前请求不匹配，结果未写入。`;
        }
        return false;
      }
      if (!current(operation)) {
        return false;
      }
      if (query("#journal-date").value !== date
        || query("#journal-title").value !== title
        || editor.value !== content
        || query("#journal-id").value !== journalId) {
        status.textContent = `${labels[mode]}已生成，但当前日记已经变化，未自动追加。结果：${result.content || streamed}`;
        return false;
      }
      const addition = (result.content || streamed).trim();
      if (!addition) return false;
      editor.value += `${editor.value.trim() ? "\n\n" : ""}${addition}`;
      editor.selectionStart = editor.selectionEnd = editor.value.length;
      editor.focus();
      status.textContent = `${labels[mode]}已追加到正文末尾。`;
      view.showToast(`${labels[mode]}已追加`);
      return true;
    } catch (error) {
      if (current(operation)) status.textContent = `生成失败：${error.message}`;
      return false;
    }
  }

  async function saveDraft(button) {
    const operation = ticket();
    const status = query("#journal-status");
    button.disabled = true;
    button.textContent = "正在保存…";
    status.textContent = "正在保存草稿…";
    try {
      const draft = await data.request("/api/journal-draft", {
        method: "PUT",
        body: JSON.stringify({
          journalId: query("#journal-id").value,
          title: query("#journal-title").value,
          content: query("#journal-content").value
        })
      });
      if (!current(operation)) return false;
      data.getSnapshot().journalDraft = draft;
      status.textContent = `草稿已保存于 ${formatTime(draft.updatedAt)}。`;
      view.showToast("日记草稿已保存");
      return true;
    } catch (error) {
      if (current(operation)) status.textContent = view.presentError(error, {
        operation: "保存日记草稿",
        object: "这份日记草稿",
        phase: "日记草稿保存",
        retained: "标题和正文仍保留在当前页面"
      }).message;
      return false;
    }
  }

  async function runAssist(button) {
    if (assistPromise) return false;
    const pending = assist(button);
    assistPromise = pending;
    syncFlightControls();
    try {
      return await pending;
    } finally {
      if (assistPromise === pending) assistPromise = null;
      syncFlightControls();
    }
  }

  async function runDraftSave(button) {
    if (draftSavePromise || submissionPromise) return false;
    const pending = saveDraft(button);
    draftSavePromise = pending;
    syncFlightControls();
    try {
      return await pending;
    } finally {
      if (draftSavePromise === pending) draftSavePromise = null;
      syncFlightControls();
    }
  }

  async function submit(form) {
    const operation = accountTicket();
    const id = query("#journal-id").value;
    const existing = id
      ? (data.getSnapshot().journals || []).find(item => item.id === id)
      : null;
    const button = query("#journal-submit");
    const status = query("#journal-status");
    const requestId = form.dataset.requestId || platform.createRequestId();
    const temporaryId = `pending:${requestId}`;
    let payload;
    if (!id) form.dataset.requestId = requestId;
    button.disabled = true;
    status.textContent = id ? "正在保存修改…" : "正在保存原文…";
    try {
      payload = publicValidation(() => ({
        ...view.occurrenceFields(query("#journal-date")),
        title: query("#journal-title").value,
        content: query("#journal-content").value,
        tags: splitTags(query("#journal-tags").value)
      }));
      if (id) {
        const result = await data.requestV1(
          `/api/v1/journals/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            headers: { "if-match": `"${existing?.version || 1}"` },
            body: JSON.stringify(payload)
          },
          {
            domains: ["journals"],
            recoverCommitted: true,
            projection: { kind: "record.update", domain: "journals", id, payload },
            onQueued: record => data.applyPendingProjection(record)
          }
        );
        if (sameAccount(operation) && result.data) {
          data.getSnapshot().journals = (data.getSnapshot().journals || [])
            .map(item => item.id === id ? result.data : item);
        }
      } else {
        const result = await data.requestV1(
          "/api/v1/journals",
          {
            method: "POST",
            headers: { "idempotency-key": requestId },
            body: JSON.stringify(payload)
          },
          {
            domains: ["journals"],
            projection: {
              kind: "record.create",
              domain: "journals",
              temporaryId,
              payload
            },
            onQueued: record => data.applyPendingProjection(record)
          }
        );
        if (sameAccount(operation)) {
          data.getSnapshot().journals = (data.getSnapshot().journals || [])
            .map(item => item.id === temporaryId ? result.data : item);
        }
      }
      if (!sameAccount(operation)) return false;
      data.publish(["journals"]);
      delete form.dataset.requestId;
      resetForm();
      void data.refresh("journals").catch(error => view.showToast(view.presentError(error, {
        operation: "刷新日记列表",
        object: "日记列表",
        phase: "日记列表刷新",
        retained: "刚才的日记已经保存"
      }).message, "error"));
      view.showToast(id ? "日记已更新" : "日记已保存");
      return true;
    } catch (error) {
      if (!sameAccount(operation)) return false;
      if (error.syncStatus === "pending") {
        resetForm();
        status.textContent = "原文已留存，网络恢复后自动同步。";
        view.showToast("日记已进入待同步队列");
      } else if (error.syncStatus === "conflict") {
        if (id) await data.refresh("journals").catch(noop);
        status.textContent = view.presentError(error, {
          operation: "保存这篇日记",
          object: "这篇日记",
          retained: "当前编辑内容仍保留，已有日记没有被覆盖"
        }).message;
      } else {
        if (id) await data.refresh("journals").catch(noop);
        status.textContent = view.presentError(error, {
          operation: "保存这篇日记",
          object: "这篇日记",
          retained: "标题和正文仍保留在当前页面",
          publicValidation: error?.publicValidation === true
        }).message;
      }
      return false;
    } finally {
      if (sameAccount(operation) && button.isConnected) {
        button.disabled = false;
        form.inert = false;
      }
    }
  }

  async function remove(button) {
    const id = button.dataset.journalDelete;
    const item = (data.getSnapshot().journals || []).find(value => value.id === id);
    if (!item || !platform.confirm("将这篇日记及其助手回望移入回收站？")) return false;
    button.disabled = true;
    try {
      await data.requestV1(
        `/api/v1/journals/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { "if-match": `"${item.version || 1}"` }
        },
        {
          domains: ["journals"],
          recoverCommitted: true,
          projection: { kind: "record.delete", domain: "journals", id },
          onQueued: record => data.applyPendingProjection(record)
        }
      );
      void data.refresh("journals").catch(error => (
        view.showToast(`日记已移除，但列表刷新失败：${error.message}`, "error")
      ));
      view.showToast("日记已移入回收站");
      return true;
    } catch (error) {
      if (error.syncStatus === "pending") view.showToast("日记将在网络恢复后移入回收站");
      else {
        await data.refresh("journals").catch(noop);
        view.showToast(error.message, "error");
        if (button.isConnected) button.disabled = false;
      }
      return false;
    }
  }

  async function reflect(button) {
    const id = button.dataset.journalReflect;
    const operation = ticket();
    const journal = (data.getSnapshot().journals || [])
      .find(item => item.id === id);
    const inputVersion = Math.max(1, Math.round(Number(journal?.version) || 1));
    const activeTask = (data.getSnapshot().aiTasks || []).find(task => (
      task.kind === "journalReflection"
      && task.targetId === id
      && Number(task.inputVersion) === inputVersion
      && isPendingAiTaskStatus(task.status)
    ));
    const requestId = activeTask
      ? ""
      : (button.dataset.requestId || platform.createRequestId());
    if (requestId) button.dataset.requestId = requestId;
    button.disabled = true;
    try {
      await assistant.runAnswer({
        title: "回望这篇日记",
        scene: "diaryReflection",
        expectedTaskKind: "journalReflection",
        expectedTaskTargetId: id,
        isSessionCurrent: () => sameAccount(operation),
        isCurrent: () => current(operation),
        requestCall: onEvent => activeTask
          ? Promise.resolve({ data: activeTask })
          : data.requestStream(
            `/api/journals/${encodeURIComponent(id)}/reflect`,
            {
              method: "POST",
              headers: { "idempotency-key": requestId },
              body: "{}"
            },
            onEvent
          ),
        onDone: () => data.refresh("journals")
      });
      delete button.dataset.requestId;
      if (current(operation)) view.showToast("日记回望已保存");
      return true;
    } catch (error) {
      if (error.taskId) delete button.dataset.requestId;
      if (current(operation)) view.showToast(error.message, "error");
      return false;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  async function handleClick(event) {
    const button = event.target.closest("button");
    if (!button) return false;
    if (button.id === "journal-cancel") return resetForm();
    if (button.id === "journal-draft-save") return runDraftSave(button);
    if (button.dataset.journalPrompt) {
      const editor = query("#journal-content");
      const prefix = editor.value.trim() ? "\n\n" : "";
      editor.setRangeText(
        `${prefix}${button.dataset.journalPrompt}\n`,
        editor.selectionStart,
        editor.selectionEnd,
        "end"
      );
      editor.focus();
      return true;
    }
    if (button.dataset.journalAssist) return runAssist(button);
    if (button.dataset.journalEdit) return editJournal(button.dataset.journalEdit);
    if (button.dataset.journalDelete) return remove(button);
    if (button.dataset.journalReflect) return reflect(button);
    if (button.dataset.contentFocus) {
      const target = document.getElementById(button.dataset.contentFocus);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus();
      return true;
    }
    return false;
  }

  async function unmount() {
    const currentActivation = activation;
    if (!currentActivation) return false;
    if (submissionPromise) currentActivation.root.querySelector("#journal-form").inert = true;
    activation = null;
    currentActivation.unlink();
    return true;
  }

  return Object.freeze({
    async mount(context = {}) {
      await unmount();
      if (!context.root || typeof context.root !== "object") {
        throw new TypeError("Journals feature requires a root");
      }
      if (context.signal?.aborted) {
        throw Object.assign(new Error("Feature activation changed"), { name: "AbortError" });
      }
      const currentActivation = {
        root: context.root,
        route: context.route,
        signal: context.signal,
        listeners: [],
        unlink: noop
      };
      activation = currentActivation;
      surface = context.root;
      generation += 1;
      const listen = (target, type, listener, options) => {
        target?.addEventListener?.(type, listener, options);
        currentActivation.listeners.push([target, type, listener, options]);
      };
      listen(context.root, "click", event => void handleClick(event));
      listen(context.root, "input", event => {
        if (!event.target.matches("[data-feed-search='journals']")) return;
        searchQuery = event.target.value;
        render();
      });
      listen(context.root, "submit", event => {
        if (!event.target.matches("#journal-form")) return;
        event.preventDefault();
        if (submissionPromise || draftSavePromise) return;
        const pending = submit(event.target);
        submissionPromise = pending;
        syncFlightControls();
        void pending.finally(() => {
          if (submissionPromise === pending) submissionPromise = null;
          syncFlightControls();
        });
      });
      listen(context.root, "keydown", event => {
        const field = event.target.closest?.("input,textarea");
        const form = field?.closest?.("#journal-form");
        if (!field || !form) return;
        const inputKind = field.tagName === "TEXTAREA" ? "multiline" : "field";
        const intent = view.entryKeyIntent(event, { inputKind });
        if (intent === "submit") {
          event.preventDefault();
          form.requestSubmit();
        } else if (intent === "block-submit") {
          event.preventDefault();
        }
      });
      const abort = () => {
        if (activation === currentActivation) void unmount();
      };
      context.signal?.addEventListener("abort", abort, { once: true });
      currentActivation.unlink = () => {
        for (const [target, type, listener, options] of currentActivation.listeners) {
          target?.removeEventListener?.(type, listener, options);
        }
        context.signal?.removeEventListener("abort", abort);
      };
      view.resetOccurrenceInput(query("#journal-date"));
      render();
      syncFlightControls();
      return () => activation === currentActivation ? unmount() : false;
    },
    render(context = {}) {
      if (!activation || activation.signal?.aborted) return false;
      const changed = context.changedDomains == null
        ? null
        : new Set(typeof context.changedDomains === "string"
          ? [context.changedDomains]
          : context.changedDomains);
      if (changed === null || changed.has("journals") || changed.has("activeDate")) {
        return render();
      }
      return false;
    },
    unmount,
    async resetSession() {
      session = {};
      generation += 1;
      await unmount();
      draftRestored = false;
      searchQuery = "";
      submissionPromise = null;
      draftSavePromise = null;
      assistPromise = null;
      const form = surface?.querySelector("#journal-form");
      if (form) form.inert = false;
      const submit = surface?.querySelector("#journal-submit");
      if (submit) submit.disabled = false;
      resetForm();
      syncFlightControls();
    }
  });
}
