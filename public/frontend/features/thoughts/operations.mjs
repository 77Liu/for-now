import { THOUGHT_PAGING } from "../../../generated/thought-pagination-config.mjs";
import { seedThoughtWindow, extendThoughtWindow, thoughtWindowProjection, saveThoughtCheckpoint, readThoughtCheckpoint, clearThoughtCheckpoints } from "../../../generated/thought-page-window.mjs";
import { imageRecordPayload } from "../../media/index.mjs";
import { toLocalDateTimeInput } from "../../time/index.mjs";
import { isWaitingForUserModelTask, pendingAiTaskMessage } from "../../shared/ai-task-status.mjs";
import {
  enqueueThoughtAnswer,
  thoughtAnswerOutcomeMessage,
  thoughtAnswerTaskStatusKind,
  THOUGHT_ANSWER_REJECTED_MESSAGE,
  THOUGHT_ANSWER_UNKNOWN_MESSAGE
} from "../../../generated/personalized-ai-task.mjs";

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
  readingState,
  createTicket,
  isCurrent,
  isActive
} = {}) {
  const { document } = platform;
  const snapshot = () => data.getSnapshot();
  let editorTime = null;

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
    const outcome = await enqueueThoughtAnswer({
      ownerId: ticket.owner,
      targetId: question.id,
      inputVersion: question.version || 1,
      createRequestId: platform.createRequestId,
      request: (path, options) => data.request(path, options),
      refreshNotifications: () => data.refresh("notifications"),
      isCurrent: () => isCurrent(ticket)
    });
    if (!isCurrent(ticket)) return false;
    if (outcome.kind === "rejected") {
      setAnswerStatus(question.id, THOUGHT_ANSWER_REJECTED_MESSAGE, "error");
      viewPort.showToast(THOUGHT_ANSWER_REJECTED_MESSAGE, "error");
      return false;
    }
    if (outcome.kind === "unknown") {
      setAnswerStatus(question.id, THOUGHT_ANSWER_UNKNOWN_MESSAGE, "error");
      viewPort.showToast(THOUGHT_ANSWER_UNKNOWN_MESSAGE, "error");
      return false;
    }
    const { task, notificationsRefreshed } = outcome;
    if (!snapshot().aiTasks.some(item => item.id === task.id)) snapshot().aiTasks.unshift(task);
    const status = thoughtAnswerOutcomeMessage(task, notificationsRefreshed);
    const statusKind = thoughtAnswerTaskStatusKind(task);
    setAnswerStatus(question.id, status, statusKind);
    crossDomain.scheduleNotificationPoll();
    viewPort.showToast(status, statusKind);
    return task;
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

  let pagingRequest = 0, restoreSerial = 0;
  let checkpointOwner = "";
  const pendingPages = new Map();
  const pagingConfig = () => data.getThoughtPaging?.();
  const pagingEnabled = () => pagingConfig()?.enabled === true;
  const ownerKey = () => `${data.getAccountId()}|${data.getSessionSerial()}`;
  const positionKey = () => routeIdentity(navigation.currentRoute());
  const positionStorage = () => { try { return platform.window.sessionStorage; } catch { return undefined; } };
  function visiblePosition() {
    const cards = [...document.querySelectorAll("#all-thoughts [data-chain-id]")];
    const visible = cards.find(card => card.getBoundingClientRect?.().bottom > 0) || cards[0];
    return visible ? { anchorId: visible.dataset.chainId, offset: visible.getBoundingClientRect().top } : null;
  }
  function restorePosition(position, onRestored = () => {}) {
    if (!position) return;
    const ticket = createTicket(), expectedRoute = positionKey(), page = snapshot().thoughtPage, serial = ++restoreSerial;
    const expectedGeneration = page?.window?.generation;
    const readingToken = readingState.capture();
    const restore = () => {
      if (!readingState.isCurrent(readingToken) || serial !== restoreSerial || !isCurrent(ticket) || positionKey() !== expectedRoute || snapshot().thoughtPage !== page || page?.window?.generation !== expectedGeneration) return;
      const exact = document.querySelector(`#all-thoughts [data-chain-id="${platform.escapeSelector(position.anchorId)}"]`);
      const card = exact || document.querySelector("#all-thoughts [data-chain-id]");
      if (card?.getBoundingClientRect) {
        platform.window.scrollBy?.({ top: card.getBoundingClientRect().top - (exact ? position.offset : 0), behavior: "instant" });
        onRestored();
      }
    };
    platform.requestFrame(() => { restore(); platform.requestFrame(restore); });
  }
  function captureReadingPosition(root) {
    const candidates = [...root.querySelectorAll("[data-followup-id],[data-thought-block-id],[data-chain-id]")];
    const visible = candidates.filter(item => {
      const rect = item.getBoundingClientRect?.();
      return rect && rect.bottom > 0 && rect.top < (platform.window.innerHeight || Infinity);
    });
    const item = visible.find(item => item.getBoundingClientRect().top >= 0) || visible.at(-1);
    if (!item) return null;
    const rootId = item.closest("[data-chain-id]")?.dataset.chainId || item.dataset.chainId;
    const roots = [...root.querySelectorAll("[data-chain-id]")].map(card => card.dataset.chainId);
    const index = roots.indexOf(rootId);
    return {
      rootId,
      nextRootId: roots[index + 1] || "",
      previousRootId: roots[index - 1] || "",
      followUpId: item.dataset.followupId || "",
      blockId: item.dataset.thoughtBlockId || "",
      offset: item.getBoundingClientRect().top
    };
  }
  function restoreReadingPosition(surface, position, token) {
    if (!position || (restoreNeeded && pagingEnabled() && navigation.currentRoute().kind !== "detail")) return;
    const ticket = createTicket(), expectedRoute = positionKey();
    const restore = () => {
      if (!isCurrent(ticket) || positionKey() !== expectedRoute || !readingState.isCurrent(token)) return;
      if (surface?.isConnected === false) return;
      const findRoot = id => id ? surface.querySelector(`[data-chain-id="${platform.escapeSelector(id)}"]`) : null;
      const root = findRoot(position.rootId);
      const child = position.followUpId
        ? root?.querySelector(`[data-followup-id="${platform.escapeSelector(position.followUpId)}"]`)
        : position.blockId
          ? root?.querySelector(`[data-thought-block-id="${platform.escapeSelector(position.blockId)}"]`)
          : root;
      const target = child || root || findRoot(position.nextRootId) || findRoot(position.previousRootId);
      if (target?.getBoundingClientRect) {
        platform.window.scrollBy?.({ top: target.getBoundingClientRect().top - (child ? position.offset : 0), behavior: "instant" });
      }
    };
    platform.requestFrame(restore);
  }
  function ensurePaging() {
    if (!pagingEnabled() || navigation.currentRoute().kind === "detail" || snapshot().thoughtPage?.kind !== "list") return null;
    const meta = snapshot().thoughtPage;
    const query = navigation.currentRoute().query || {};
    if ((!meta.window || meta.window.routeKey !== positionKey()) && (String(meta.query || "") !== String(query.q || "") || String(meta.tag || "") !== String(query.tag || "") || (meta.sort || "occurred") !== (query.sort || "occurred") || String(meta.requestCursor || "") !== String(query.cursor || "") || (meta.direction || "next") !== (query.direction || "next") || (meta.page || 1) !== Number(query.page || 1))) return null;
    checkpointOwner = String(data.getAccountId() || "");
    if (!meta.window || meta.window.ownerKey !== ownerKey() || meta.window.routeKey !== positionKey()) {
      meta.window = seedThoughtWindow(snapshot().thoughts || [], meta, ownerKey(), positionKey(), pagingConfig());
      meta.window.stale = Boolean(meta.stale);
    }
    return meta.window;
  }
  function capturePosition() {
    const window = ensurePaging(), position = visiblePosition();
    if (pendingPages.size || restoreNeeded) return;
    if (!window || !position) return;
    const page = window.pages.find(item => item.items.some(item => item.id === position.anchorId));
    if (!page) return;
    const written = navigation.replaceQuery({ page: null, cursor: page.requestCursor || null, direction: page.requestCursor ? page.direction : null }, { apply: false, onlyCommitted: true });
    if (written === false) return;
    window.routeKey = positionKey();
    saveThoughtCheckpoint(positionStorage(), checkpointOwner, positionKey(), { ...position, cursor: page.requestCursor, direction: page.direction }, pagingConfig().maxCheckpoints);
  }
  let fallbackRoute = "", restoreNeeded = true;
  function beginPagingRoute() { restoreNeeded = true; cancelPositionRestore(); }
  function synchronizePaging({ restore = true } = {}) {
    const window = ensurePaging();
    if (!pagingEnabled()) {
      const status = document.querySelector("#thought-pagination-status"); if (status && pagingConfig()?.enabled === false) status.textContent = "历史分页尚未启用";
      const route = navigation.currentRoute(), key = positionKey();
      if (pagingConfig()?.enabled === false && (route.query?.cursor || route.query?.direction) && fallbackRoute !== key) {
        fallbackRoute = key; resetPaging(); const ticket = createTicket();
        platform.setTimer(() => { if (pagingConfig()?.enabled === false && isCurrent(ticket) && positionKey() === key) navigation.replaceQuery({ cursor: null, direction: null, page: null }); }, 0);
      }
    }
    const status = document.querySelector("#thought-pagination-status");
    if (window && status?.textContent === "历史分页尚未启用") status.textContent = "";
    if (window?.stale && pendingPages.size) resetPaging();
    if (restore && window && restoreNeeded && data.isRouteDataReady()) {
      const checkpoint = readThoughtCheckpoint(positionStorage(), checkpointOwner, positionKey());
      if (checkpoint) {
        navigation.cancelScrollRestoration?.();
        restorePosition(checkpoint, () => { restoreNeeded = false; });
      } else restoreNeeded = false;
    }
    return window;
  }

  function cancelPositionRestore({ user = false } = {}) {
    restoreSerial += 1;
    if (user) restoreNeeded = false;
  }
  function resetPaging({ logout = false } = {}) {
    cancelPositionRestore();
    pagingRequest += 1;
    for (const pending of pendingPages.values()) pending.controller.abort();
    pendingPages.clear();
    if (logout) clearThoughtCheckpoints(positionStorage(), checkpointOwner);
  }
  async function loadAdjacent(direction = "next") {
    const route = navigation.currentRoute(), page = snapshot().thoughtPage;
    if (route.view !== "thoughts" || route.kind === "detail") return false;
    const window = ensurePaging();
    if (pagingEnabled() && !window) return false;
    if (window?.stale || page?.stale) { viewPort.showToast("内容已变化，请刷新后继续", "error"); return false; }
    const cursor = direction === "prev" ? page?.prevCursor : page?.nextCursor;
    if (!cursor || pendingPages.has(direction)) return false;
    if (!window && (direction === "prev" || (snapshot().thoughts || []).length >= THOUGHT_PAGING.pageSize * THOUGHT_PAGING.maxPages)) return false;
    if (window && !Object.hasOwn(page, "prevCursor")) { viewPort.showToast("服务端尚不支持双向分页，请刷新后重试", "error"); return false; }
    const ticket = createTicket(), expectedRoute = routeIdentity(route), expectedGeneration = window?.generation;
    const controller = new AbortController(), pending = { id: ++pagingRequest, controller };
    pendingPages.set(direction, pending);
    const query = new URLSearchParams({ limit: String(THOUGHT_PAGING.pageSize), cursor, direction });
    for (const key of ["q", "tag", "sort"]) if (route.query?.[key]) query.set(key, route.query[key]);
    const status = document.querySelector("#thought-pagination-status");
    if (status) status.textContent = "正在加载…";
    try {
      const result = await data.requestV1(`/api/v1/thought-chains?${query}`, { signal: controller.signal });
      if (controller.signal.aborted || pendingPages.get(direction) !== pending || !isCurrent(ticket) || routeIdentity(navigation.currentRoute()) !== expectedRoute || snapshot().thoughtPage !== page || window?.generation !== expectedGeneration || window?.stale || page.stale) return false;
      let anchor = visiblePosition();
      const focusChain = document.activeElement?.closest?.("[data-chain-id]")?.dataset.chainId;
      if (window?.pages.length === pagingConfig()?.maxPages) {
        const removed = direction === "prev" ? window.pages.at(-1) : window.pages[0];
        if (focusChain && removed.items.some(item => item.id === focusChain)) throw new Error("请先将焦点移到保留区域，再继续加载");
        if (anchor && removed.items.some(item => item.id === anchor.anchorId)) throw new Error("请先滚动到保留区域，再继续加载");
      }
      if (window) {
        if (!Object.hasOwn(result.meta, "prevCursor")) throw new Error("服务端尚不支持双向分页，请刷新后重试");
        const next = extendThoughtWindow(window, { requestCursor: cursor, direction, items: result.data, nextCursor: result.meta.nextCursor || "", prevCursor: result.meta.prevCursor || "" }, direction, pagingConfig());
        const projection = thoughtWindowProjection(next);
        snapshot().thoughts = projection.items;
        snapshot().thoughtPage = { ...page, window: next, nextCursor: projection.nextCursor, prevCursor: projection.prevCursor };
      } else {
        const known = new Set((snapshot().thoughts || []).map(item => item.id));
        snapshot().thoughts = [...snapshot().thoughts, ...result.data.filter(item => !known.has(item.id))].slice(0, THOUGHT_PAGING.pageSize * THOUGHT_PAGING.maxPages);
        snapshot().thoughtPage = { ...page, page: Math.min(THOUGHT_PAGING.maxPages, (page.page || 1) + 1), nextCursor: snapshot().thoughts.length < THOUGHT_PAGING.pageSize * THOUGHT_PAGING.maxPages ? result.meta.nextCursor : null };
        navigation.replaceQuery({ page: snapshot().thoughtPage.page }, { apply: false });
      }
      thoughtView.render();
      if (focusChain) document.querySelector(`#all-thoughts [data-chain-id="${platform.escapeSelector(focusChain)}"] summary`)?.focus?.({ preventScroll: true });
      pendingPages.delete(direction); capturePosition(); restorePosition(anchor);
      return true;
    } catch (error) {
      if (isCurrent(ticket) && pendingPages.get(direction) === pending && !controller.signal.aborted) { if (status?.isConnected) status.textContent = `继续加载失败：${error.message}`; viewPort.showToast(`继续加载失败：${error.message}`, "error"); }
      return false;
    } finally { if (pendingPages.get(direction) === pending) pendingPages.delete(direction); }
  }
  const loadMore = () => loadAdjacent("next");
  const loadPrevious = () => loadAdjacent("prev");

  function openChainEditor(id) {
    const chain = thoughtView.findChain(id);
    if (!chain) return false;
    document.querySelector("#edit-chain-id").value = id;
    const datetime = document.querySelector("#edit-chain-datetime");
    datetime.value = chain.question.occurredAt ? toLocalDateTimeInput(chain.question.occurredAt) : "";
    editorTime = { id, value: datetime.value };
    datetime.required = Boolean(chain.question.occurredAt);
    datetime.placeholder = chain.question.occurredAt ? "" : `仅日期：${chain.question.occurredOn || "未知"}`;
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
    const ticket = createTicket();
    const createId = form.dataset.followUpRoot;
    const manualId = form.dataset.followupManualAnswer;
    const editId = form.dataset.followupEdit;
    const rootId = createId || form.dataset.rootId;
    const rootVersion = snapshot().thoughts?.find(item => item.id === rootId)?.version;
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
      if (!isCurrent(ticket)) return false;
      thoughtView.applySavedFollowUp(rootId, saved, { kind, followUpId, submitted: body, rootVersion });
      void data.refresh(createId ? ["thoughts", "review"] : "thoughts", {
        chainId: rootId,
        patchOnly: true
      }).catch(error => {
        if (isCurrent(ticket)) viewPort.showToast(
          `${manualId ? "追问回答" : "追问"}已保存，但状态刷新失败：${error.message}`,
          "error"
        );
      });
      viewPort.showToast(createId
        ? (body.answer.trim() ? "追问与回答已保存" : "追问已保存")
        : manualId ? "追问回答已保存" : "追问已更新");
      return true;
    } catch (error) {
      if (!isCurrent(ticket)) return false;
      if (status?.isConnected) status.textContent = error.message;
      else viewPort.showToast(error.message, "error");
      if (button.isConnected) button.disabled = false;
      return false;
    }
  }

  async function removeFollowUp(button) {
    const ticket = createTicket();
    if (!platform.confirm("将这条追问及其回答移入回收站？")) return false;
    button.disabled = true;
    try {
      await data.request(
        `/api/thoughts/${button.dataset.rootId}/follow-ups/${button.dataset.followupDelete}`,
        { method: "DELETE" }
      );
      if (!isCurrent(ticket)) return false;
      await data.refresh("thoughts", { chainId: button.dataset.rootId });
      if (!isCurrent(ticket)) return false;
      viewPort.showToast("追问已移入回收站");
      return true;
    } catch (error) {
      if (isCurrent(ticket)) {
        viewPort.showToast(error.message, "error");
        if (button.isConnected) button.disabled = false;
      }
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
      if (status) status.textContent = pendingAiTaskMessage(task, "回答已进入后台队列，可继续使用其他功能。");
      await data.refresh("notifications");
      if (!isCurrent(ticket)) return false;
      crossDomain.scheduleNotificationPoll();
      viewPort.showToast(isWaitingForUserModelTask(task)
        ? "追问回答等待核心用户模型就绪"
        : "追问回答已在后台排队");
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
    const datetime = document.querySelector("#edit-chain-datetime").value;
    const initialTime = editorTime?.id === id ? editorTime.value
      : root?.occurredAt ? toLocalDateTimeInput(root.occurredAt) : "";
    const payload = {
      ...(datetime && datetime !== initialTime ? { occurredAt: datetime } : {}),
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
    loadPrevious,
    synchronizePaging,
    beginPagingRoute,
    captureReadingPosition,
    restoreReadingPosition,
    capturePosition,
    resetPaging,
    cancelPositionRestore,
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
