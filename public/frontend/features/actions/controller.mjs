export const ACTIONS_SELECTORS = Object.freeze({
  summary: "#actions-summary",
  actionForm: "#action-form",
  actionStatus: "#action-status",
  actionColumns: "#action-columns",
  habitForm: "#habit-form",
  habitStatus: "#habit-status",
  habitList: "#habit-list",
  submit: '[type="submit"]',
  command: [
    "[data-action-start]",
    "[data-action-complete]",
    "[data-action-reopen]",
    "[data-action-edit]",
    "[data-action-delete]",
    "[data-habit-checkin]",
    "[data-habit-uncheck]",
    "[data-habit-toggle]",
    "[data-habit-adjust]",
    "[data-habit-delete]"
  ].join(",")
});

const emptyActionDraft = () => ({ title: "", priority: "none" });
const emptyHabitDraft = () => ({
  title: "",
  cadence: "daily",
  target: "1"
});

const escapeHtml = value => String(value ?? "").replace(/[&<>"]/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
})[character]);

function formControl(form, name) {
  return form?.elements?.[name] || form?.elements?.namedItem?.(name) || null;
}

function readActionDraft(form) {
  return {
    title: String(formControl(form, "title")?.value ?? ""),
    priority: String(formControl(form, "priority")?.value ?? "none")
  };
}

function writeActionDraft(form, draft) {
  const title = formControl(form, "title");
  const priority = formControl(form, "priority");
  if (title) title.value = draft.title;
  if (priority) priority.value = draft.priority;
}

function readHabitDraft(form) {
  return {
    title: String(formControl(form, "title")?.value ?? ""),
    cadence: String(formControl(form, "cadence")?.value ?? "daily"),
    target: String(formControl(form, "target")?.value ?? "1")
  };
}

function writeHabitDraft(form, draft) {
  const title = formControl(form, "title");
  const cadence = formControl(form, "cadence");
  const target = formControl(form, "target");
  if (title) title.value = draft.title;
  if (cadence) cadence.value = draft.cadence;
  if (target) {
    target.value = draft.cadence === "daily" ? "1" : draft.target;
    target.disabled = draft.cadence === "daily";
  }
}

function sameDraft(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formContains(form, target) {
  if (!form || !target) return false;
  if (target === form || target.form === form) return true;
  return Object.values(form.elements || {}).includes(target);
}

function actionSyncMarkup(sync) {
  if (!sync) return "";
  const label = sync.status === "pending"
    ? "待同步"
    : sync.status === "committed"
      ? "已保存"
      : "正在同步";
  return `<span class="checkin-sync-state ${escapeHtml(sync.status)}">${label}</span>`;
}

function actionButtons(item) {
  if (item.sync) return actionSyncMarkup(item.sync);
  const primary = item.status === "todo"
    ? `<button class="quiet-button" type="button" data-action-start="${escapeHtml(item.id)}" data-version="${item.version}">开始</button>`
    : item.status === "doing"
      ? `<button class="quiet-button" type="button" data-action-complete="${escapeHtml(item.id)}" data-version="${item.version}">完成</button>`
      : `<button class="subtle-action" type="button" data-action-reopen="${escapeHtml(item.id)}" data-version="${item.version}">撤销完成</button>`;
  return `${primary}<button class="subtle-action" type="button" data-action-edit="${escapeHtml(item.id)}" data-version="${item.version}">编辑</button><button class="subtle-action danger" type="button" data-action-delete="${escapeHtml(item.id)}" data-version="${item.version}" aria-label="删除行动">删除</button>`;
}

function habitButtons(item) {
  if (item.sync) return actionSyncMarkup(item.sync);
  const checkin = item.checkedToday
    ? `<button class="quiet-button" type="button" data-habit-uncheck="${escapeHtml(item.todayCheckin.id)}" data-version="${item.todayCheckin.version}">撤销打卡</button>`
    : `<button class="quiet-button" type="button" data-habit-checkin="${escapeHtml(item.id)}" ${item.canCheckIn ? "" : "disabled"}>今日打卡</button>`;
  return `${checkin}<button class="subtle-action" type="button" data-habit-toggle="${escapeHtml(item.id)}" data-enabled="${String(item.enabled)}" data-version="${item.version}">${item.enabled ? "暂停" : "启用"}</button><button class="subtle-action" type="button" data-habit-adjust="${escapeHtml(item.id)}" data-version="${item.version}">调整</button><button class="subtle-action danger" type="button" data-habit-delete="${escapeHtml(item.id)}" data-version="${item.version}">删除</button>`;
}

function renderColumns(view) {
  return view.actionColumns.map(column => (
    `<section class="action-column"><header><b>${column.label}</b><span>${column.count}</span></header>${column.items.length
      ? column.items.map(item => `<article class="action-entry${item.sync ? " is-syncing" : ""}"><div><span class="action-priority priority-${item.priority.toLowerCase()}">${item.priorityLabel}</span><h3>${escapeHtml(item.title)}</h3><small>${escapeHtml(item.sourceLabel)}</small></div><div class="action-entry-buttons">${actionButtons(item)}</div></article>`).join("")
      : '<div class="empty">暂无</div>'}</section>`
  )).join("");
}

function renderHabits(view) {
  if (!view.habits.length) return '<div class="empty">还没有习惯。</div>';
  return view.habits.map(item => (
    `<article class="habit-entry${item.sync ? " is-syncing" : ""}"><header><div><h3>${escapeHtml(item.title)}</h3><span>${escapeHtml(item.frequencyLabel)} · ${item.period.count}/${item.period.target}</span></div><b class="${item.period.complete ? "complete" : ""}">${item.period.complete ? "已达成" : item.statusLabel}</b></header><div class="habit-progress"><i style="width:${Math.min(100, item.period.count / item.period.target * 100)}%"></i></div>${item.latestFeeling ? `<p>${escapeHtml(item.latestFeeling)}</p>` : ""}<footer>${habitButtons(item)}</footer></article>`
  )).join("");
}

function requireCoordinator(value) {
  for (const method of [
    "snapshot",
    "load",
    "runCommand",
    "applyIncrementalSnapshot",
    "resetSession",
    "subscribe",
    "createRequestId",
    "viewModel"
  ]) {
    if (typeof value?.[method] !== "function") {
      throw new TypeError(`Actions feature controller requires coordinator.${method}`);
    }
  }
  return value;
}

export function createActionsFeatureController(deps = {}) {
  const coordinator = requireCoordinator(deps.coordinator);
  const commands = coordinator.commands;
  for (const name of [
    "createAction",
    "createHabit",
    "setActionStatus",
    "completeAction",
    "undoActionCompletion",
    "updateAction",
    "deleteAction",
    "checkInHabit",
    "deleteHabitCheckin",
    "setHabitEnabled",
    "recordHabitAdjustment",
    "deleteHabit"
  ]) {
    if (typeof commands?.[name] !== "function") {
      throw new TypeError(`Actions feature controller requires coordinator.commands.${name}`);
    }
  }
  const showToast = typeof deps.showToast === "function" ? deps.showToast : () => {};
  const promptUser = typeof deps.prompt === "function"
    ? deps.prompt
    : typeof deps.promptUser === "function"
      ? deps.promptUser
      : null;
  const confirmUser = typeof deps.confirm === "function"
    ? deps.confirm
    : typeof deps.confirmUser === "function"
      ? deps.confirmUser
      : null;
  const createRequestId = coordinator.createRequestId;
  if (typeof promptUser !== "function") {
    throw new TypeError("Actions feature controller requires prompt");
  }
  if (typeof confirmUser !== "function") {
    throw new TypeError("Actions feature controller requires confirm");
  }
  if (typeof createRequestId !== "function") {
    throw new TypeError("Actions feature controller requires createRequestId");
  }

  let activation = null;
  let activationSerial = 0;
  let session = {};
  let actionDraft = emptyActionDraft();
  let habitDraft = emptyHabitDraft();
  let actionDraftReady = false;
  let habitDraftReady = false;
  let actionMessage = "";
  let habitMessage = "";
  let actionRequest = { id: "", fingerprint: "" };
  let habitRequest = { id: "", fingerprint: "" };
  let actionSubmit = null;
  let habitSubmit = null;
  const checkinRequests = new Map();
  const sessionRoots = new Set();

  const queryRoot = (root, selector) => root?.querySelector?.(selector) || null;
  const isCurrentSession = ticket => ticket?.session === session;
  const isActive = candidate => (
    candidate !== null
    && activation === candidate
    && candidate.session === session
    && !candidate.signal?.aborted
  );
  const query = (candidate, selector) => (
    isActive(candidate) ? queryRoot(candidate.root, selector) : null
  );

  const actionCommand = draft => commands.createAction({
    title: draft.title,
    priority: draft.priority
  });
  const habitCommand = draft => {
    const target = draft.cadence === "daily" ? 1 : Number(draft.target);
    return commands.createHabit({
      title: draft.title,
      frequency: { cadence: draft.cadence, target }
    });
  };
  const fingerprint = command => JSON.stringify(command);

  const clearFormRequest = (kind, form) => {
    if (kind === "action") actionRequest = { id: "", fingerprint: "" };
    else habitRequest = { id: "", fingerprint: "" };
    if (form?.dataset) delete form.dataset.requestId;
  };

  const updateDraft = (kind, form) => {
    if (kind === "action") {
      actionDraft = readActionDraft(form);
      actionDraftReady = true;
      if (!actionSubmit && actionRequest.id) {
        try {
          if (fingerprint(actionCommand(actionDraft)) !== actionRequest.fingerprint) {
            clearFormRequest(kind, form);
          }
        } catch {
          clearFormRequest(kind, form);
        }
      } else if (actionSubmit && form?.dataset) {
        delete form.dataset.requestId;
      }
      return;
    }
    habitDraft = readHabitDraft(form);
    habitDraftReady = true;
    if (!habitSubmit && habitRequest.id) {
      try {
        if (fingerprint(habitCommand(habitDraft)) !== habitRequest.fingerprint) {
          clearFormRequest(kind, form);
        }
      } catch {
        clearFormRequest(kind, form);
      }
    } else if (habitSubmit && form?.dataset) {
      delete form.dataset.requestId;
    }
  };

  const formMessage = (kind, snapshot) => {
    const own = kind === "action" ? actionMessage : habitMessage;
    if (own) return own;
    if (kind === "action" && snapshot.loadState === "loading") return "正在同步行动…";
    if (kind === "action" && snapshot.loadState === "failure") return snapshot.loadError;
    return "";
  };

  const syncForm = (candidate, kind, { restore = false } = {}) => {
    const selector = kind === "action"
      ? ACTIONS_SELECTORS.actionForm
      : ACTIONS_SELECTORS.habitForm;
    const form = query(candidate, selector);
    if (!form) return false;
    if (kind === "action") {
      if (!actionDraftReady) {
        actionDraft = readActionDraft(form);
        actionDraftReady = true;
      } else if (restore) {
        writeActionDraft(form, actionDraft);
      }
    } else if (!habitDraftReady) {
      habitDraft = readHabitDraft(form);
      habitDraftReady = true;
    } else if (restore) {
      writeHabitDraft(form, habitDraft);
    }
    const pending = kind === "action" ? actionSubmit : habitSubmit;
    const request = kind === "action" ? actionRequest : habitRequest;
    const button = form.querySelector?.(ACTIONS_SELECTORS.submit) || null;
    if (button) button.disabled = Boolean(pending);
    if (form.dataset) {
      let matches = false;
      if (request.id) {
        try {
          const draft = kind === "action" ? actionDraft : habitDraft;
          const command = kind === "action" ? actionCommand(draft) : habitCommand(draft);
          matches = fingerprint(command) === request.fingerprint;
        } catch {}
      }
      if (matches) form.dataset.requestId = request.id;
      else delete form.dataset.requestId;
    }
    const status = query(
      candidate,
      kind === "action" ? ACTIONS_SELECTORS.actionStatus : ACTIONS_SELECTORS.habitStatus
    );
    if (status) status.textContent = formMessage(kind, coordinator.snapshot());
    return true;
  };

  const renderSnapshot = (candidate, snapshot) => {
    if (!isActive(candidate)) return false;
    const columns = query(candidate, ACTIONS_SELECTORS.actionColumns);
    const habits = query(candidate, ACTIONS_SELECTORS.habitList);
    const summary = query(candidate, ACTIONS_SELECTORS.summary);
    const view = coordinator.viewModel(snapshot);
    if (summary) {
      summary.textContent = `${view.summary.openActions} 项待推进 · ${view.summary.checkedToday}/${view.summary.activeHabits} 个习惯已打卡`;
    }
    if (columns) columns.innerHTML = renderColumns(view);
    if (habits) habits.innerHTML = renderHabits(view);
    syncForm(candidate, "action");
    syncForm(candidate, "habit");
    return Boolean(columns || habits);
  };

  const nextRequest = (kind, command) => {
    const value = kind === "action" ? actionRequest : habitRequest;
    const nextFingerprint = fingerprint(command);
    if (!value.id || value.fingerprint !== nextFingerprint) {
      const next = {
        id: String(createRequestId() || ""),
        fingerprint: nextFingerprint
      };
      if (!next.id) throw new TypeError("无法创建行动请求标识");
      if (kind === "action") actionRequest = next;
      else habitRequest = next;
      return next;
    }
    return value;
  };

  const submitForm = async (candidate, kind, form) => {
    if (!isActive(candidate)) return false;
    if (kind === "action" ? actionSubmit : habitSubmit) return false;
    updateDraft(kind, form);
    const submitted = {
      ...(kind === "action" ? actionDraft : habitDraft)
    };
    let command;
    let request;
    try {
      command = kind === "action" ? actionCommand(submitted) : habitCommand(submitted);
      request = nextRequest(kind, command);
    } catch (error) {
      if (kind === "action") actionMessage = error?.message || "行动添加失败";
      else habitMessage = error?.message || "习惯添加失败";
      syncForm(candidate, kind);
      return false;
    }

    const ticket = {
      session,
      activation: candidate,
      kind,
      submitted,
      requestId: request.id,
      fingerprint: request.fingerprint
    };
    if (kind === "action") {
      actionSubmit = ticket;
      actionMessage = "正在添加…";
    } else {
      habitSubmit = ticket;
      habitMessage = "正在添加…";
    }
    if (form.dataset) form.dataset.requestId = request.id;
    syncForm(candidate, kind);

    try {
      await coordinator.runCommand(command, { idempotencyKey: request.id });
      const pending = kind === "action" ? actionSubmit : habitSubmit;
      if (!isCurrentSession(ticket) || pending !== ticket) return false;
      const currentDraft = kind === "action" ? actionDraft : habitDraft;
      const unchanged = sameDraft(currentDraft, ticket.submitted);
      clearFormRequest(kind, isActive(ticket.activation) ? form : null);
      if (kind === "action") {
        actionSubmit = null;
        if (unchanged) {
          actionDraft = emptyActionDraft();
          actionDraftReady = true;
          const currentForm = query(activation, ACTIONS_SELECTORS.actionForm);
          if (currentForm) writeActionDraft(currentForm, actionDraft);
        }
        actionMessage = unchanged
          ? ""
          : "提交时的行动已保存；等待期间的新输入已保留。";
      } else {
        habitSubmit = null;
        if (unchanged) {
          habitDraft = emptyHabitDraft();
          habitDraftReady = true;
          const currentForm = query(activation, ACTIONS_SELECTORS.habitForm);
          if (currentForm) writeHabitDraft(currentForm, habitDraft);
        }
        habitMessage = unchanged
          ? ""
          : "提交时的习惯已保存；等待期间的新输入已保留。";
      }
      const current = activation;
      if (isActive(current)) syncForm(current, kind);
      if (isActive(ticket.activation)) {
        showToast(kind === "action" ? "行动已添加" : "习惯已添加");
      }
      return true;
    } catch (error) {
      const pending = kind === "action" ? actionSubmit : habitSubmit;
      if (!isCurrentSession(ticket) || pending !== ticket) return false;
      if (kind === "action") actionSubmit = null;
      else habitSubmit = null;
      const currentDraft = kind === "action" ? actionDraft : habitDraft;
      let unchanged = false;
      try {
        const currentCommand = kind === "action"
          ? actionCommand(currentDraft)
          : habitCommand(currentDraft);
        unchanged = fingerprint(currentCommand) === ticket.fingerprint;
      } catch {}
      if (!unchanged) clearFormRequest(kind, null);
      if (kind === "action") actionMessage = error?.message || "行动添加失败";
      else habitMessage = error?.message || "习惯添加失败";
      const current = activation;
      if (isActive(current)) syncForm(current, kind);
      return false;
    }
  };

  function closestWithin(candidate, event, selector) {
    if (!isActive(candidate)) return null;
    const element = event?.target?.closest?.(selector) || null;
    if (!element) return null;
    return candidate.root.contains(element) ? element : null;
  }

  function handleInput(event) {
    const candidate = activation;
    if (!isActive(candidate) || !candidate.root.contains(event?.target)) return;
    const actionForm = query(candidate, ACTIONS_SELECTORS.actionForm);
    const habitForm = query(candidate, ACTIONS_SELECTORS.habitForm);
    if (formContains(actionForm, event.target)) updateDraft("action", actionForm);
    if (formContains(habitForm, event.target)) updateDraft("habit", habitForm);
  }

  function handleChange(event) {
    const candidate = activation;
    if (!isActive(candidate) || !candidate.root.contains(event?.target)) return;
    const habitForm = query(candidate, ACTIONS_SELECTORS.habitForm);
    if (!formContains(habitForm, event.target)) return;
    const cadence = formControl(habitForm, "cadence");
    const target = formControl(habitForm, "target");
    if (event.target === cadence && target) {
      const daily = cadence.value === "daily";
      target.disabled = daily;
      if (daily) target.value = "1";
      else if (Number(target.value) < 1) target.value = "3";
    }
    updateDraft("habit", habitForm);
  }

  function handleSubmit(event) {
    const candidate = activation;
    if (!isActive(candidate)) return;
    const actionForm = query(candidate, ACTIONS_SELECTORS.actionForm);
    const habitForm = query(candidate, ACTIONS_SELECTORS.habitForm);
    const kind = event?.target === actionForm
      ? "action"
      : event?.target === habitForm
        ? "habit"
        : "";
    if (!kind) return;
    event.preventDefault?.();
    void submitForm(candidate, kind, event.target);
  }

  const setButtonBusy = (candidate, button, busy) => {
    if (isActive(candidate) && candidate.root.contains(button)) button.disabled = busy;
  };

  async function runButtonCommand(candidate, button) {
    const data = button.dataset || {};
    const state = coordinator.snapshot();
    let command;
    let idempotencyKey = "";
    if (data.actionStart) {
      command = commands.setActionStatus(data.actionStart, "doing", data.version);
    } else if (data.actionComplete) {
      command = commands.completeAction(data.actionComplete, data.version);
    } else if (data.actionReopen) {
      command = commands.undoActionCompletion(data.actionReopen, data.version);
    } else if (data.actionEdit) {
      const item = state.actions.find(value => value.id === data.actionEdit);
      const title = promptUser("修改行动：", item?.title || "");
      if (!title?.trim()) return false;
      const priority = promptUser(
        "优先级：P0 / P1 / P2 / P3 / none",
        item?.priority || "none"
      );
      if (!priority) return false;
      command = commands.updateAction(
        data.actionEdit,
        { title, priority },
        data.version
      );
    } else if (data.actionDelete) {
      if (!confirmUser("将这项行动移入回收站？")) return false;
      command = commands.deleteAction(data.actionDelete, data.version);
    } else if (data.habitCheckin) {
      const key = `habit:${data.habitCheckin}`;
      let request = checkinRequests.get(key);
      if (!request) {
        const feeling = promptUser("今天完成时的感受（可留空）：", "");
        if (feeling === null) return false;
        request = {
          id: String(createRequestId() || ""),
          feeling: String(feeling)
        };
        if (!request.id) throw new TypeError("无法创建习惯打卡请求标识");
        checkinRequests.set(key, request);
      }
      idempotencyKey = request.id;
      command = commands.checkInHabit(data.habitCheckin, {
        occurredOn: state.today,
        feeling: request.feeling
      });
    } else if (data.habitUncheck) {
      if (!confirmUser("撤销今天的习惯打卡？")) return false;
      command = commands.deleteHabitCheckin(data.habitUncheck, data.version);
    } else if (data.habitToggle) {
      command = commands.setHabitEnabled(
        data.habitToggle,
        data.enabled !== "true",
        data.version
      );
    } else if (data.habitAdjust) {
      const habit = state.habits.find(value => value.id === data.habitAdjust);
      const note = promptUser("记录这次调整：");
      if (!note?.trim() || !habit) return false;
      const cadence = promptUser(
        "频次：daily（每天）或 weekly（每周）",
        habit.frequency?.cadence || "daily"
      );
      if (!["daily", "weekly"].includes(cadence)) {
        showToast("频次只能是 daily 或 weekly", "error");
        return false;
      }
      const target = cadence === "weekly"
        ? Number(promptUser(
          "新的每周目标天数：",
          String(habit.frequency?.target || 3)
        ))
        : 1;
      if (!Number.isInteger(target) || target < 1 || target > 7) {
        showToast("目标天数必须是 1 到 7", "error");
        return false;
      }
      command = commands.recordHabitAdjustment(
        data.habitAdjust,
        { note, frequency: { cadence, target } },
        data.version
      );
    } else if (data.habitDelete) {
      if (!confirmUser("将这个习惯及其打卡记录移入回收站？")) return false;
      command = commands.deleteHabit(data.habitDelete, data.version);
    }
    if (!command) return false;

    setButtonBusy(candidate, button, true);
    try {
      await coordinator.runCommand(command, { idempotencyKey });
      if (data.habitCheckin) checkinRequests.delete(`habit:${data.habitCheckin}`);
      if (isActive(candidate)) showToast("已更新");
      return true;
    } catch (error) {
      if (isActive(candidate)) {
        showToast(
          error?.message || "暂时无法更新",
          error?.syncStatus === "pending" ? "success" : "error"
        );
      }
      return false;
    } finally {
      setButtonBusy(candidate, button, false);
    }
  }

  function handleClick(event) {
    const candidate = activation;
    const button = closestWithin(candidate, event, ACTIONS_SELECTORS.command);
    if (!button) return;
    event.preventDefault?.();
    void runButtonCommand(candidate, button);
  }

  const listeners = Object.freeze({
    input: handleInput,
    change: handleChange,
    submit: handleSubmit,
    click: handleClick
  });

  const detach = (candidate, { preserveDraft = true } = {}) => {
    if (activation !== candidate) return false;
    if (preserveDraft) {
      const actionForm = queryRoot(candidate.root, ACTIONS_SELECTORS.actionForm);
      const habitForm = queryRoot(candidate.root, ACTIONS_SELECTORS.habitForm);
      if (actionForm) updateDraft("action", actionForm);
      if (habitForm) updateDraft("habit", habitForm);
    }
    candidate.signal?.removeEventListener?.("abort", candidate.dispose);
    for (const [type, listener] of Object.entries(listeners)) {
      candidate.root.removeEventListener(type, listener);
    }
    candidate.unsubscribe?.();
    activation = null;
    return true;
  };

  const scrubRoot = root => {
    const actionForm = queryRoot(root, ACTIONS_SELECTORS.actionForm);
    const habitForm = queryRoot(root, ACTIONS_SELECTORS.habitForm);
    for (const [form, draft, writer] of [
      [actionForm, emptyActionDraft(), writeActionDraft],
      [habitForm, emptyHabitDraft(), writeHabitDraft]
    ]) {
      if (!form) continue;
      try {
        form.reset?.();
      } catch {}
      writer(form, draft);
      if (form.dataset) delete form.dataset.requestId;
      const button = form.querySelector?.(ACTIONS_SELECTORS.submit) || null;
      if (button) button.disabled = false;
    }
    for (const selector of [
      ACTIONS_SELECTORS.summary,
      ACTIONS_SELECTORS.actionStatus,
      ACTIONS_SELECTORS.actionColumns,
      ACTIONS_SELECTORS.habitStatus,
      ACTIONS_SELECTORS.habitList
    ]) {
      const element = queryRoot(root, selector);
      if (!element) continue;
      if (selector === ACTIONS_SELECTORS.actionColumns || selector === ACTIONS_SELECTORS.habitList) {
        element.innerHTML = "";
      } else {
        element.textContent = "";
      }
    }
  };

  function mount(context = {}) {
    unmount();
    const root = context.root;
    if (
      !root
      || typeof root.querySelector !== "function"
      || typeof root.contains !== "function"
      || typeof root.addEventListener !== "function"
      || typeof root.removeEventListener !== "function"
    ) {
      throw new TypeError("Actions feature mount requires a root event target");
    }
    let disposed = false;
    let candidate = null;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (candidate) detach(candidate);
    };
    if (context.signal?.aborted) return dispose;

    candidate = {
      id: ++activationSerial,
      root,
      route: context.route,
      signal: context.signal,
      session,
      dispose,
      unsubscribe: null,
      firstStateRender: true
    };
    activation = candidate;
    sessionRoots.add(root);
    for (const [type, listener] of Object.entries(listeners)) {
      root.addEventListener(type, listener);
    }
    candidate.signal?.addEventListener?.("abort", dispose, { once: true });
    syncForm(candidate, "action", { restore: true });
    syncForm(candidate, "habit", { restore: true });
    candidate.unsubscribe = coordinator.subscribe(snapshot => {
      renderSnapshot(candidate, snapshot);
    });
    void coordinator.load();
    return dispose;
  }

  function render({ snapshot, changedDomains } = {}) {
    const candidate = activation;
    if (!isActive(candidate)) return false;
    if (candidate.firstStateRender) {
      candidate.firstStateRender = false;
      void coordinator.load({ ensure: true });
    }
    const relevant = changedDomains == null
      || (typeof changedDomains === "string"
        ? ["*", "actions", "habits", "habitCheckins"].includes(changedDomains)
        : [...changedDomains].some(domain => (
          ["*", "actions", "habits", "habitCheckins"].includes(domain)
        )));
    if (!relevant) return false;
    if (snapshot && ["actions", "habits", "habitCheckins"].some(domain => (
      Array.isArray(snapshot[domain])
    ))) {
      coordinator.applyIncrementalSnapshot(snapshot);
    } else {
      renderSnapshot(candidate, coordinator.snapshot());
    }
    return true;
  }

  function unmount() {
    if (activation) detach(activation);
  }

  function resetSession() {
    if (activation) detach(activation, { preserveDraft: false });
    session = {};
    actionDraft = emptyActionDraft();
    habitDraft = emptyHabitDraft();
    actionDraftReady = false;
    habitDraftReady = false;
    actionMessage = "";
    habitMessage = "";
    actionRequest = { id: "", fingerprint: "" };
    habitRequest = { id: "", fingerprint: "" };
    actionSubmit = null;
    habitSubmit = null;
    checkinRequests.clear();
    coordinator.resetSession();
    for (const root of sessionRoots) scrubRoot(root);
    sessionRoots.clear();
  }

  return Object.freeze({
    mount,
    render,
    unmount,
    resetSession
  });
}
