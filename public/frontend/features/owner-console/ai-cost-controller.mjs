import {
  calibrateAiCostPlan,
  copyOwnerValue,
  OWNER_CONSOLE_CAPABILITIES
} from "./model.mjs";
import { createOwnerLifecycle } from "./lifecycle.mjs";
import {
  closestOwnerTarget,
  OWNER_CONSOLE_SELECTORS
} from "./presentation.mjs";
import { ownerRequestOptions } from "./ports.mjs";

const PLAN_ENDPOINT = "/api/ai-cost-plan";
const BUDGET_ENDPOINT = "/api/v1/owner/ai-budget";

const budgetData = response => response?.data?.data || null;

export function createAiCostOwnerController({ ports, presentation }) {
  const lifecycle = createOwnerLifecycle({
    name: "AI cost owner controller",
    requiredCapability: OWNER_CONSOLE_CAPABILITIES["ai-cost"],
    capability: ports.capability
  });
  let plan = null;
  let statistics = null;
  let budget = null;
  let budgetEtag = "";
  let loadSerial = 0;
  let planSaveSerial = 0;
  let budgetSerial = 0;
  let savingPlan = null;
  const pendingBudget = new Map();

  const statisticsEndpoint = () => {
    const to = String(ports.settings.currentDate() || "");
    const from = ports.format.shiftDateKey(to, -29);
    return `/api/statistics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  };
  const currentLoad = ticket => lifecycle.active(ticket)
    && ticket.loadSerial === loadSerial;
  const currentPlanSave = ticket => lifecycle.active(ticket)
    && ticket.planSaveSerial === planSaveSerial;
  const currentBudget = ticket => lifecycle.active(ticket)
    && ticket.budgetSerial === budgetSerial;

  function paint(candidate, options) {
    if (!candidate || !plan || !statistics
      || !lifecycle.active(lifecycle.context(candidate))) return false;
    const cost = presentation.renderAiCost(candidate.root, plan, statistics, options);
    presentation.renderAiBudget(candidate.root, budget);
    return cost;
  }

  async function load(candidate = lifecycle.currentActivation()) {
    if (!candidate || !lifecycle.active(lifecycle.context(candidate))) return false;
    const ticket = {
      ...lifecycle.context(candidate),
      loadSerial: ++loadSerial,
      budgetSerial
    };
    presentation.setAiStatus(
      candidate.root,
      "正在读取成本方案与近 30 天账本…"
    );
    try {
      const [nextPlan, nextStatistics, budgetResponse] = await Promise.all([
        ports.request(PLAN_ENDPOINT, ownerRequestOptions(candidate.signal)),
        ports.request(statisticsEndpoint(), ownerRequestOptions(candidate.signal)),
        ports.requestWithMetadata(
          BUDGET_ENDPOINT,
          ownerRequestOptions(candidate.signal)
        )
      ]);
      if (!currentLoad(ticket)) return false;
      plan = nextPlan;
      statistics = nextStatistics;
      if (ticket.budgetSerial === budgetSerial) {
        budget = budgetData(budgetResponse);
        budgetEtag = budgetResponse.etag || "";
      }
      presentation.renderAiBudget(candidate.root, budget);
      presentation.renderAiCost(candidate.root, plan, statistics);
      presentation.setAiStatus(candidate.root, "");
      return true;
    } catch (error) {
      if (currentLoad(ticket)) {
        presentation.setAiStatus(
          candidate.root,
          error?.message || "AI 成本读取失败"
        );
      }
      return false;
    }
  }

  async function refreshBudget(candidate, ticket) {
    const response = await ports.requestWithMetadata(
      BUDGET_ENDPOINT,
      ownerRequestOptions(candidate.signal)
    );
    if (!currentBudget(ticket)) return false;
    budget = budgetData(response);
    budgetEtag = response.etag || "";
    presentation.renderAiBudget(candidate.root, budget);
    return true;
  }

  async function submitBudget(candidate, form, command, successMessage, toastMessage) {
    if (pendingBudget.has(form)) return false;
    const ticket = {
      ...lifecycle.context(candidate),
      budgetSerial: ++budgetSerial
    };
    pendingBudget.set(form, ticket);
    const button = form?.querySelector?.('[type="submit"]');
    if (button) button.disabled = true;
    presentation.setBudgetStatus(
      candidate.root,
      command.command === "recover" ? "正在解除阻断…" : "正在追加临时额度…"
    );
    try {
      if (!budgetEtag && !await refreshBudget(candidate, ticket)) return false;
      const response = await ports.requestWithMetadata(
        BUDGET_ENDPOINT,
        ownerRequestOptions(candidate.signal, {
          method: "PATCH",
          headers: { "if-match": budgetEtag },
          body: JSON.stringify(command)
        })
      );
      if (!currentBudget(ticket)) return false;
      budget = budgetData(response);
      budgetEtag = response.etag || "";
      presentation.renderAiBudget(candidate.root, budget);
      form?.reset?.();
      presentation.setBudgetStatus(candidate.root, successMessage);
      ports.toast(toastMessage);
      return true;
    } catch (error) {
      if (!currentBudget(ticket)) return false;
      if (Number(error?.status) === 412) {
        try {
          await refreshBudget(candidate, ticket);
        } catch (refreshError) {
          if (currentBudget(ticket)) {
            presentation.setBudgetStatus(
              candidate.root,
              refreshError?.message || "预算状态重新读取失败"
            );
          }
          return false;
        }
        if (!currentBudget(ticket)) return false;
        error = Object.assign(
          new Error("预算状态已被其他 Owner 更新，已重新读取。"),
          { code: error?.code, status: 412 }
        );
      }
      presentation.setBudgetStatus(
        candidate.root,
        error?.message || "全站预算更新失败"
      );
      return false;
    } finally {
      if (pendingBudget.get(form) === ticket) pendingBudget.delete(form);
      if (lifecycle.active(ticket) && button) button.disabled = false;
    }
  }

  async function savePlan(candidate, form) {
    if (!plan || savingPlan) return false;
    loadSerial += 1;
    plan = presentation.readAiCostPlan(candidate.root, plan);
    const ticket = {
      ...lifecycle.context(candidate),
      planSaveSerial: ++planSaveSerial
    };
    savingPlan = ticket;
    const button = form?.querySelector?.('[type="submit"]');
    if (button) button.disabled = true;
    presentation.setAiStatus(candidate.root, "正在保存成本方案…");
    try {
      const saved = await ports.request(
        PLAN_ENDPOINT,
        ownerRequestOptions(candidate.signal, {
          method: "PATCH",
          body: JSON.stringify(plan)
        })
      );
      if (!currentPlanSave(ticket)) return false;
      plan = saved;
      presentation.renderAiCost(candidate.root, plan, statistics);
      presentation.setAiStatus(candidate.root, "AI 成本方案已保存。");
      ports.toast("AI 成本方案已更新");
      return true;
    } catch (error) {
      if (currentPlanSave(ticket)) {
        presentation.setAiStatus(
          candidate.root,
          error?.message || "AI 成本方案保存失败"
        );
      }
      return false;
    } finally {
      if (savingPlan === ticket) savingPlan = null;
      if (currentPlanSave(ticket) && button) button.disabled = false;
    }
  }

  function calibrate(candidate) {
    if (!plan || !statistics) return false;
    plan = presentation.readAiCostPlan(candidate.root, plan);
    plan = calibrateAiCostPlan(plan, statistics, ports.settings.snapshot());
    presentation.renderAiCost(candidate.root, plan, statistics);
    presentation.setAiStatus(
      candidate.root,
      "已按近 30 天实测调用与当前模型配置校准，保存后生效。"
    );
    return true;
  }

  function handleClick(candidate, event) {
    if (!lifecycle.active(lifecycle.context(candidate))) return;
    const view = closestOwnerTarget(candidate.root, event, "[data-view]");
    if (view) {
      event.preventDefault?.();
      ports.navigation.openView(String(view.dataset.view || ""));
      return;
    }
    const button = closestOwnerTarget(
      candidate.root,
      event,
      OWNER_CONSOLE_SELECTORS.aiCost.calibrate
    );
    if (button) {
      event.preventDefault?.();
      calibrate(candidate);
    }
  }

  function handleInput(candidate, event) {
    if (!plan || !statistics || !lifecycle.active(lifecycle.context(candidate))) return;
    const form = closestOwnerTarget(
      candidate.root,
      event,
      OWNER_CONSOLE_SELECTORS.aiCost.form
    );
    if (!form) return;
    plan = presentation.readAiCostPlan(candidate.root, plan);
    presentation.renderAiCost(candidate.root, plan, statistics, { syncRows: false });
  }

  function handleSubmit(candidate, event) {
    if (!lifecycle.active(lifecycle.context(candidate))) return;
    const form = event?.target;
    if (form?.matches?.(OWNER_CONSOLE_SELECTORS.aiCost.form)) {
      event.preventDefault?.();
      void savePlan(candidate, form);
      return;
    }
    if (form?.matches?.(OWNER_CONSOLE_SELECTORS.aiCost.budgetAddForm)) {
      event.preventDefault?.();
      void submitBudget(candidate, form, {
        command: "addTemporaryBudget",
        scope: candidate.root.querySelector("#ai-budget-add-scope")?.value,
        amountCny: Number(candidate.root.querySelector("#ai-budget-add-amount")?.value),
        reason: String(candidate.root.querySelector("#ai-budget-add-reason")?.value || "").trim()
      }, "临时额度已追加。", "全站预算已更新");
      return;
    }
    if (form?.matches?.(OWNER_CONSOLE_SELECTORS.aiCost.budgetRecoverForm)) {
      event.preventDefault?.();
      void submitBudget(candidate, form, {
        command: "recover",
        scope: candidate.root.querySelector("#ai-budget-recover-scope")?.value,
        reason: String(candidate.root.querySelector("#ai-budget-recover-reason")?.value || "").trim()
      }, "当前周期阻断已解除。", "预算阻断已解除");
    }
  }

  function mount(context = {}) {
    const mounted = lifecycle.mount(context);
    const { candidate, dispose } = mounted;
    if (!mounted.ready) return dispose;
    lifecycle.cleanup(candidate, () => {
      loadSerial += 1;
      planSaveSerial += 1;
      budgetSerial += 1;
      savingPlan = null;
      pendingBudget.clear();
      presentation.cleanupAiCost(candidate.root);
    });
    lifecycle.listen(candidate, "click", event => handleClick(candidate, event));
    lifecycle.listen(candidate, "input", event => handleInput(candidate, event));
    lifecycle.listen(candidate, "submit", event => handleSubmit(candidate, event));
    void load(candidate);
    return dispose;
  }

  function resetSession() {
    plan = null;
    statistics = null;
    budget = null;
    budgetEtag = "";
    loadSerial += 1;
    planSaveSerial += 1;
    budgetSerial += 1;
    savingPlan = null;
    pendingBudget.clear();
    lifecycle.reset(root => presentation.resetAiCost(root));
  }

  return Object.freeze({
    mount,
    render: () => paint(lifecycle.currentActivation()),
    unmount: () => lifecycle.detach(),
    resetSession,
    reload: () => load(),
    snapshot: () => Object.freeze({
      plan: copyOwnerValue(plan),
      statistics: copyOwnerValue(statistics),
      budget: copyOwnerValue(budget),
      budgetEtag
    })
  });
}
