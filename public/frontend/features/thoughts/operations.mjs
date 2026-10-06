import { imageRecordPayload } from "../../media/index.mjs";
import { toLocalDateTimeInput } from "../../time/index.mjs";

const noop = () => {};
const routeIdentity = route => JSON.stringify([
  route?.view || "",
  route?.kind || "",
  route?.resourceType || "",
  route?.resourceId || "",
  Object.entries(route?.query || {}).sort(([left], [right]) => left.localeCompare(right))
]);

export function createThoughtOperations({
  data,
  navigation,
  media,
  annotations,
  crossDomain,
  viewPort,
  platform,
  thoughtView,
  createTicket,
  isCurrent,
  isActive
} = {}) {
  const { document } = platform;
  const snapshot = () => data.getSnapshot();

  function setAnswerStatus(id, message, kind = "working") {
    document.querySelectorAll(`[data-answer-chain="${platform.escapeSelector(id)}"]`)
      .forEach(button => {
        let status = button.closest(".chain-expanded")?.querySelector(".card-action-status");
        if (!status) {
          status = document.createElement("p");
          status.className = "card-action-status";
          status.setAttribute("role", "status");
          status.setAttribute("aria-live", "polite");
          button.closest(".chain-expanded")?.append(status);
        }
        status.className = `card-action-status ${kind}`;
        status.textContent = message;
      });
  }

  async function startBackgroundAnswer(question) {
    const ticket = createTicket();
    try {
      const task = await data.request("/api/ai-tasks", {
        method: "POST",
        body: JSON.stringify({
          kind: "thoughtAnswer",
          targetId: question.id,
          inputVersion: question.version || 1,
          clientRequestId: platform.createRequestId()
        })
      });
      if (!isCurrent(ticket)) return false;
      if (!snapshot().aiTasks.some(item => item.id === task.id)) snapshot().aiTasks.unshift(task);
      setAnswerStatus(question.id, "回答已进入后台队列。");
      viewPort.showToast("回答已在后台排队");
      await data.refresh("notifications");
      if (isCurrent(ticket)) crossDomain.scheduleNotificationPoll();
      return task;
    } catch (error) {
      if (isCurrent(ticket)) {
        setAnswerStatus(question.id, `回答未能排队：${error.message}`, "error");
        viewPort.showToast("回答未能进入后台队列", "error");
      }
      throw error;
    }
  }

  function reconcileRoute() {
    if (!data.isRouteDataReady()) return false;
    const route = navigation.currentRoute();
    if (route.kind !== "detail" || route.resourceType !== "thought-chain") return false;
    if ((snapshot().thoughts || []).some(item => (
      item.id === route.resourceId && item.type === "question"
    ))) return false;
    navigation.showUnavailable({
      resourceType: "thought-chain",
      resourceId: route.resourceId,
      view: "thoughts"
    }, { view: "thoughts", query: route.query });
    return true;
  }

  async function loadMore() {
    const button = document.querySelector("#thought-load-more");
    const route = navigation.currentRoute();
    const cursor = snapshot().thoughtPage?.nextCursor;
    if (!button || !cursor || route.view !== "thoughts" || route.kind === "detail"
      || (snapshot().thoughts || []).length >= 100) return false;
    const ticket = createTicket(), expectedRoute = routeIdentity(route);
    const query = new URLSearchParams({ limit: "20", cursor });
    if (route.query?.q) query.set("q", route.query.q);
    if (route.query?.tag) query.set("tag", route.query.tag);
    if (route.query?.sort) query.set("sort", route.query.sort);
    button.disabled = true;
    document.querySelector("#thought-pagination-status").textContent = "正在加载…";
    try {
      const result = await data.requestV1(`/api/v1/thought-chains?${query}`);
      if (!isCurrent(ticket) || routeIdentity(navigation.currentRoute()) !== expectedRoute) {
        return false;
      }
      const known = new Set((snapshot().thoughts || []).map(item => item.id));
      snapshot().thoughts = [
        ...(snapshot().thoughts || []),
        ...result.data.filter(item => !known.has(item.id))
      ].slice(0, 100);
      const page = Math.min(5, (Number(route.query?.page) || 1) + 1);
      snapshot().thoughtPage = {
        kind: "list",
        query: route.query?.q || "",
        tag: route.query?.tag || "",
        sort: route.query?.sort === "created" ? "created" : "occurred",
        page,
        nextCursor: snapshot().thoughts.length < 100 ? result.meta.nextCursor || null : null,
        tags: snapshot().thoughtPage?.tags || result.meta.tags || []
      };
      navigation.replaceQuery({ page }, { apply: false });
      thoughtView.render();
      return true;
    } catch (error) {
      if (isCurrent(ticket)) {
        document.querySelector("#thought-pagination-status").textContent =
          `继续加载失败：${error.message}`;
      }
      return false;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  function openChainEditor(id) {
    const chain = thoughtView.findChain(id);
    if (!chain) return false;
    document.querySelector("#edit-chain-id").value = id;
    document.querySelector("#edit-chain-datetime").value =
      toLocalDateTimeInput(chain.question.occurredAt || chain.question.createdAt);
    document.querySelector("#edit-chain-question").value = chain.question.content;
    document.querySelector("#edit-chain-tags").value = (chain.question.tags || []).join(" ");
    document.querySelector("#edit-chain-status").textContent =
      "这里只修改主题。初步想法、回答与记录请在各自内容块上编辑。";
    document.querySelector("#edit-chain-modal").hidden = false;
    document.querySelector("#edit-chain-question").focus();
    return true;
  }

  function openBlockEditor(rootId, type = "record", blockId = "") {
    const item = blockId
      ? (snapshot().thoughts || []).find(value => (
        value.id === blockId && value.relatedTo === rootId
      ))
      : null;
    const modal = document.querySelector("#thought-block-modal");
    const form = document.querySelector("#thought-block-form");
    const select = document.querySelector("#thought-block-type");
    document.querySelector("#thought-block-root-id").value = rootId;
    document.querySelector("#thought-block-id").value = item?.id || "";
    form.dataset.version = String(item?.version || 1);
    delete form.dataset.requestId;
    select.value = item?.type || type;
    select.disabled = Boolean(item);
    viewPort.resetOccurrenceInput(document.querySelector("#thought-block-datetime"), item);
    document.querySelector("#thought-block-content").value = item?.content || "";
    media.resetEditor("thoughtBlock", item?.attachmentPaths || []);
    document.querySelector("#thought-block-title").textContent =
      item ? "编辑内容" : `新增${select.options[select.selectedIndex].text}`;
    document.querySelector("#thought-block-status").textContent = "";
    modal.hidden = false;
    document.querySelector("#thought-block-content").focus();
    return true;
  }

  async function removeBlock(button) {
    if (!platform.confirm("将这条思绪内容移入回收站？")) return false;
    button.disabled = true;
    try {
      await data.request(`/api/thoughts/${button.dataset.thoughtBlockDelete}`, {
        method: "DELETE"
      });
      await data.refresh(["thoughts", "review"], { chainId: button.dataset.rootId });
      viewPort.showToast("思绪内容已移入回收站");
      return true;
    } catch (error) {
      viewPort.showToast(error.message, "error");
      button.disabled = false;
      return false;
    }
  }

  async function submitFollowUp(form) {
    const createId = form.dataset.followUpRoot;
    const manualId = form.dataset.followupManualAnswer;
    const editId = form.dataset.followupEdit;
    const rootId = createId || form.dataset.rootId;
    const followUpId = manualId || editId || "";
    const button = form.querySelector('button[type="submit"]');
    const status = createId
      ? form.querySelector(".followup-status")
      : form.closest(".followup-answer")?.querySelector(".followup-status");
    const kind = createId ? "create" : manualId ? "manual-answer" : "edit";
    const requestId = form.dataset.requestId || platform.createRequestId();
    if (createId) form.dataset.requestId = requestId;
    button.disabled = true;
    if (status) status.textContent = createId
      ? "正在保存追问…"
      : manualId ? "正在保存回答…" : "正在保存修改…";
    try {
      const url = createId
        ? `/api/thoughts/${rootId}/follow-ups`
        : `/api/thoughts/${rootId}/follow-ups/${followUpId}`;
      const body = createId
        ? { question: form.elements.question.value, answer: form.elements.answer.value }
        : manualId
          ? {
            expectedVersion: Number(form.dataset.version) || 1,
            answer: form.querySelector("textarea").value
          }
          : {
            expectedVersion: Number(form.dataset.version) || 1,
            question: form.elements.question.value,
            answer: form.elements.answer.value
          };
      const saved = await data.request(url, {
        method: createId ? "POST" : "PATCH",
        ...(createId ? { headers: { "idempotency-key": requestId } } : {}),
        body: JSON.stringify(body)
      });
      thoughtView.applySavedFollowUp(rootId, saved, { kind, followUpId });
      void data.refresh(createId ? ["thoughts", "review"] : "thoughts", {
        chainId: rootId,
        patchOnly: true
      }).catch(error => viewPort.showToast(
        `${manualId ? "追问回答" : "追问"}已保存，但状态刷新失败：${error.message}`,
        "error"
      ));
      viewPort.showToast(createId
        ? (body.answer.trim() ? "追问与回答已保存" : "追问已保存")
        : manualId ? "追问回答已保存" : "追问已更新");
      return true;
    } catch (error) {
      if (status) status.textContent = error.message;
      else viewPort.showToast(error.message, "error");
      button.disabled = false;
      return false;
    }
  }

  async function removeFollowUp(button) {
    if (!platform.confirm("将这条追问及其回答移入回收站？")) return false;
    button.disabled = true;
    try {
      await data.request(
        `/api/thoughts/${button.dataset.rootId}/follow-ups/${button.dataset.followupDelete}`,
        { method: "DELETE" }
      );
      await data.refresh("thoughts", { chainId: button.dataset.rootId });
      viewPort.showToast("追问已移入回收站");
      return true;
    } catch (error) {
      viewPort.showToast(error.message, "error");
      button.disabled = false;
      return false;
    }
  }

  async function answerFollowUp(button) {
    const root = (snapshot().thoughts || [])
      .find(item => item.id === button.dataset.rootId && item.type === "question");
    const followUp = root?.followUps?.find(item => item.id === button.dataset.followupAnswer);
    if (!root || !followUp) return false;
    const ticket = createTicket();
    button.disabled = true;
    const status = button.closest(".followup-answer")?.querySelector(".followup-status");
    if (status) status.textContent = "正在加入后台队列…";
    try {
      const requestId = button.dataset.requestId || platform.createRequestId();
      button.dataset.requestId = requestId;
      const task = await data.request("/api/ai-tasks", {
        method: "POST",
        body: JSON.stringify({
          kind: "followUpAnswer",
          targetId: root.id,
          subtargetId: followUp.id,
          inputVersion: root.version || 1,
          subtargetVersion: followUp.version || 1,
          clientRequestId: requestId
        })
      });
      if (!isCurrent(ticket)) return false;
      if (!snapshot().aiTasks.some(item => item.id === task.id)) snapshot().aiTasks.unshift(task);
      if (status) status.textContent = "回答已进入后台队列，可继续使用其他功能。";
      await data.refresh("notifications");
      if (isCurrent(ticket)) crossDomain.scheduleNotificationPoll();
      viewPort.showToast("追问回答已在后台排队");
      return true;
    } catch (error) {
      if (isCurrent(ticket)) {
        if (status) status.textContent = `未能排队：${error.message}`;
        viewPort.showToast(error.message, "error");
        button.disabled = false;
      }
      return false;
    }
  }

  async function changeRemark(button, action) {
    const rootId = button.dataset.thoughtId || button.dataset.remark;
    const remarkId = button.dataset.editRemark || button.dataset.deleteRemark || "";
    if (action === "delete") {
      if (!platform.confirm("将这条备注移入回收站？")) return false;
      await data.request(`/api/thoughts/${rootId}/remarks/${remarkId}`, {
        method: "DELETE"
      });
      await data.refresh("thoughts", { chainId: rootId });
      viewPort.showToast("备注已移入回收站");
      return true;
    }
    const remark = action === "edit"
      ? (snapshot().thoughts || []).find(item => item.id === rootId)
        ?.remarks?.find(item => item.id === remarkId)
      : null;
    const text = platform.prompt(
      action === "edit" ? "编辑备注：" : "新增一条备注：",
      remark?.text
    );
    if (!text?.trim()) return false;
    await data.request(
      action === "edit"
        ? `/api/thoughts/${rootId}/remarks/${remarkId}`
        : `/api/thoughts/${rootId}/remarks`,
      { method: action === "edit" ? "PATCH" : "POST", body: JSON.stringify({ text }) }
    );
    await data.refresh("thoughts", { chainId: rootId });
    viewPort.showToast(action === "edit" ? "备注已更新" : "备注已保存");
    return true;
  }

  async function setDisposition(button) {
    await data.request(`/api/thoughts/${button.dataset.disposition}/disposition`, {
      method: "PATCH",
      body: JSON.stringify({ disposition: button.dataset.value })
    });
    await data.refresh(["thoughts", "review"], { chainId: button.dataset.disposition });
    viewPort.showToast(button.dataset.value === "kept" ? "已保留" : "已舍弃");
  }

  async function deleteChain(button) {
    const id = button.dataset.deleteChain;
    const root = (snapshot().thoughts || [])
      .find(item => item.id === id && item.type === "question");
    if (!root || !platform.confirm("将整套思绪及其内容移入回收站？")) return false;
    button.disabled = true;
    try {
      await data.requestV1(`/api/v1/thought-chains/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "if-match": `"${root.version || 1}"` }
      }, {
        resource: `thought-chain:${id}`,
        domains: ["thoughts", "review"],
        recoverCommitted: true,
        projection: { kind: "thought.chain.delete", id },
        onQueued: data.applyPendingProjection
      });
      void data.refresh(["thoughts", "review"])
        .catch(error => viewPort.showToast(
          `思绪已移除，但列表刷新失败：${error.message}`,
          "error"
        ));
      viewPort.showToast("整套思绪已移入回收站");
      return true;
    } catch (error) {
      if (error.syncStatus === "pending") {
        viewPort.showToast("思绪将在网络恢复后移入回收站");
      } else {
        await data.refresh(["thoughts", "review"]).catch(noop);
        viewPort.showToast(error.message, "error");
        button.disabled = false;
      }
      return false;
    }
  }

  async function submitEditChain(form) {
    const button = form.querySelector('[type="submit"]');
    const id = document.querySelector("#edit-chain-id").value;
    const root = (snapshot().thoughts || [])
      .find(item => item.id === id && item.type === "question");
    const payload = {
      occurredAt: document.querySelector("#edit-chain-datetime").value,
      question: document.querySelector("#edit-chain-question").value,
      tags: String(document.querySelector("#edit-chain-tags").value || "")
        .split(/[,，#\s]+/).map(value => value.trim()).filter(Boolean)
    };
    button.disabled = true;
    document.querySelector("#edit-chain-status").textContent = "正在保存…";
    try {
      await data.requestV1(`/api/v1/thought-chains/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "if-match": `"${root?.version || 1}"` },
        body: JSON.stringify(payload)
      }, {
        resource: `thought-chain:${id}`,
        domains: ["thoughts"],
        recoverCommitted: true,
        projection: { kind: "thought.chain.update", id, payload },
        onQueued: data.applyPendingProjection
      });
      document.querySelector("#edit-chain-modal").hidden = true;
      void data.refresh(["thoughts", "review"], { chainId: id });
      viewPort.showToast("思绪主题已更新");
    } catch (error) {
      if (error.syncStatus === "pending") {
        document.querySelector("#edit-chain-modal").hidden = true;
        viewPort.showToast("思绪修改将在网络恢复后同步");
      } else {
        await data.refresh(["thoughts", "review"], { chainId: id }).catch(noop);
        document.querySelector("#edit-chain-status").textContent = error.message;
      }
    } finally {
      button.disabled = false;
    }
  }

  async function submitBlock(form) {
    const button = form.querySelector('[type="submit"]');
    const rootId = document.querySelector("#thought-block-root-id").value;
    const id = document.querySelector("#thought-block-id").value;
    const requestId = form.dataset.requestId || platform.createRequestId();
    let uploadedPaths = [];
    form.dataset.requestId = requestId;
    button.disabled = true;
    document.querySelector("#thought-block-status").textContent = "正在保存…";
    await media.persistDraft("thoughtBlock");
    try {
      const submission = await media.submitDraft("thoughtBlock");
      uploadedPaths = submission.uploadedPaths;
      const original = imageRecordPayload({
        content: document.querySelector("#thought-block-content").value,
        attachmentPaths: submission.attachmentPaths
      });
      const payload = {
        type: document.querySelector("#thought-block-type").value,
        relatedTo: rootId,
        ...viewPort.occurrenceFields(document.querySelector("#thought-block-datetime")),
        ...original,
        ...(id ? { expectedVersion: Number(form.dataset.version) || 1 } : {})
      };
      await data.request(id ? `/api/thoughts/${id}` : "/api/thoughts", {
        method: id ? "PATCH" : "POST",
        headers: { "idempotency-key": requestId },
        body: JSON.stringify(payload)
      });
      if (!isActive()) return false;
      delete form.dataset.requestId;
      document.querySelector("#thought-block-modal").hidden = true;
      await media.completeDraft("thoughtBlock");
      await data.refresh(["thoughts", "review"], { chainId: rootId });
      viewPort.showToast(id ? "内容已更新" : "内容已加入时间线");
      return true;
    } catch (error) {
      if (!media.uncertainSubmission(error)) {
        await media.rollbackDraft("thoughtBlock", uploadedPaths);
      } else {
        await media.persistDraft("thoughtBlock");
      }
      document.querySelector("#thought-block-status").textContent = !Number(error?.status)
        ? "提交状态尚未确认，图片和内容已保留；联网后请再次提交。"
        : error.message;
      return false;
    } finally {
      button.disabled = false;
    }
  }

  return Object.freeze({
    answerFollowUp,
    changeRemark,
    deleteChain,
    loadMore,
    openBlockEditor,
    openChainEditor,
    reconcileRoute,
    removeBlock,
    removeFollowUp,
    setDisposition,
    startBackgroundAnswer,
    submitBlock,
    submitEditChain,
    submitFollowUp,
    openComments: id => annotations.openPanel(annotations.rootKey("thought", id))
  });
}
