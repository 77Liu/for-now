import { state } from "../../state/index.mjs";

export function installOnboardingEvents({
  $, $$, runtime, collectOnboardingAnswers, renderOnboardingQuestions,
  onboardingPayload, onboardingV2Controller, load, request, showToast, switchView
} = {}) {
  $$("[data-onboarding-mode]").forEach(button => button.addEventListener("click", () => {
    collectOnboardingAnswers();
    runtime.onboardingMode = button.dataset.onboardingMode === "detailed" ? "detailed" : "quick";
    $("#onboarding-understanding").closest("label").hidden = true;
    $("#onboarding-status").textContent = runtime.onboardingMode === "detailed"
      ? "详细版共 18 题，全部作答后才能完成。"
      : "快速版共 8 题，全部作答后才能完成。";
    renderOnboardingQuestions();
  }));

  $$("[data-onboarding-sample]").forEach(button => button.addEventListener("click", () => {
    $("#onboarding-material").value = button.dataset.onboardingSample;
    $("#onboarding-understanding").closest("label").hidden = true;
  }));

  $("#onboarding-file").addEventListener("change", async event => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      $("#onboarding-status").textContent = "导入文件不能超过 1 MB。";
      input.value = "";
      return;
    }
    try {
      $("#onboarding-material").value = await file.text();
      $("#onboarding-status").textContent = `已读取 ${file.name}，确认前仍可修改。`;
    } catch {
      $("#onboarding-status").textContent = "文件读取失败，请重试。";
    }
  });

  $("#onboarding-preview").addEventListener("click", async () => {
    const form = $("#onboarding-form");
    const status = $("#onboarding-status");
    if (!form.reportValidity()) {
      status.textContent = "请先完成当前版本的全部题目。";
      return;
    }
    status.textContent = "正在整理初始认知…";
    try {
      const result = await request("/api/onboarding/preview", {
        method: "POST",
        body: JSON.stringify(onboardingPayload())
      });
      const understanding = $("#onboarding-understanding");
      understanding.value = result.understanding;
      understanding.closest("label").hidden = false;
      understanding.focus();
      status.textContent = "这是可修改的初步理解，后续真实记录优先。";
    } catch (error) {
      status.textContent = error.message;
    }
  });

  $("#onboarding-skip").addEventListener("click", () => {
    for (const key of ["gender", "region", "occupation", "major", "school", "introduction", "works"]) {
      const field = $(`#onboarding-${key}`);
      if (field) field.value = "";
    }
    $$("#onboarding-interests input[type=\"checkbox\"]").forEach(input => input.checked = false);
    $("#onboarding-material").value = "";
    $("#onboarding-file").value = "";
    $("#onboarding-understanding").value = "";
    $("#onboarding-understanding").closest("label").hidden = true;
    $("#onboarding-optional").open = false;
    $("#onboarding-status").textContent = "已略过可选资料；完成全部题目后即可开始。";
  });

  $("#onboarding-legacy-back").addEventListener("click", () => onboardingV2Controller.backFromLegacy());
  $("#onboarding-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    const status = $("#onboarding-status");
    if (!form.reportValidity()) {
      status.textContent = "请完成当前版本的全部题目。";
      return;
    }
    button.disabled = true;
    try {
      state.onboarding = await request("/api/onboarding", {
        method: "PATCH",
        body: JSON.stringify(onboardingPayload())
      });
      await load();
      showToast("旧版问卷已保存，原始选择继续保留");
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $("#onboarding-v2-reopen").addEventListener("click", () => {
    switchView("today");
    requestAnimationFrame(() => onboardingV2Controller.reopen());
  });
}
