import { createReasoningDisclosure } from "../../features/ui/index.mjs";
import { sessionScope } from "../../session/index.mjs";

export function createAnswerModalRuntime({
  $,
  $$,
  renderMarkdown,
  renderLatex,
  showToast,
  resolvePersonalizedTask,
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = id => cancelAnimationFrame(id)
} = {}) {
  let taskSerial = 0;
  let activeTaskId = 0;
  let liveReasoning = null;
  function resetSession() {
    activeTaskId = ++taskSerial;
    liveReasoning?.dispose();
    liveReasoning = null;
    const modal = $("#ai-answer-modal");
    modal.hidden = true;
    modal.dataset.busy = "false";
    $("#ai-answer-result").innerHTML = "";
  }

  function setStep(step) {
    const order = ["context", "thinking", "answer", "done"];
    const current = order.indexOf(step);
    $$("#ai-answer-progress li").forEach((item, index) => {
      item.classList.toggle("active", index === current);
      item.classList.toggle("done", index < current || (step === "done" && index === current));
    });
  }

  function close() {
    const modal = $("#ai-answer-modal");
    const busy = modal.dataset.busy === "true";
    modal.hidden = true;
    liveReasoning?.dispose();
    liveReasoning = null;
    if (busy) showToast("回答继续在后台生成，完成后会提醒。");
  }

  async function run({
    title,
    requestCall,
    onDone,
    isCurrent = () => true,
    expectedTaskKind = "",
    expectedTaskTargetId = "",
    expectedTaskInputVersion = null,
    expectedTaskRequestId = "",
    isSessionCurrent = () => true
  } = {}) {
    const taskId = ++taskSerial;
    const session = sessionScope.capture();
    const sessionCurrent = () => sessionScope.isCurrent(session) && isSessionCurrent();
    session.signal.addEventListener("abort", resetSession, { once: true });
    const modal = $("#ai-answer-modal");
    const resultElement = $("#ai-answer-result");
    const output = $("#ai-answer-output");
    const status = $("#ai-answer-status");

    activeTaskId = taskId;
    liveReasoning?.dispose();
    modal.hidden = false;
    modal.dataset.busy = "true";
    $("#ai-answer-title").textContent = title;
    output.hidden = true;
    resultElement.innerHTML = "";
    status.className = "status answer-modal-status";
    status.textContent = "正在整理个人语境与完整问答链…";
    setStep("context");
    const currentUi = () => activeTaskId === taskId && sessionCurrent() && !modal.hidden;
    const disclosure = createReasoningDisclosure({ host: output, isCurrent: currentUi });
    liveReasoning = disclosure;

    await new Promise(resolve => requestFrame(() => requestFrame(resolve)));
    if (currentUi()) {
      setStep("thinking");
      status.textContent = "正在整理回答…";
    }

    let answer = "";
    let renderFrame = 0;
    let answerStarted = false;
    const renderAnswer = () => {
      renderFrame = 0;
      if (!currentUi()) return;
      resultElement.innerHTML = renderMarkdown(answer);
      renderLatex(resultElement);
    };
    const scheduleAnswerRender = () => {
      if (!renderFrame) renderFrame = requestFrame(renderAnswer);
    };
    const onEvent = event => {
      if (!currentUi()) {
        disclosure.dispose();
        return;
      }
      if (event.type === "reasoning") {
        disclosure.append(event.delta || "");
        output.hidden = false;
        setStep("thinking");
        status.textContent = "正在整理回答…";
        return;
      }
      if (event.type !== "content") return;
      answer += event.delta || "";
      if (!answerStarted) {
        answerStarted = true;
        output.hidden = false;
        setStep("answer");
        status.textContent = "正在生成回答…";
      }
      scheduleAnswerRender();
    };

    try {
      const initialResponse = await requestCall(onEvent);
      const settled = await resolvePersonalizedTask(initialResponse, {
        operationLabel: title,
        expectedKind: expectedTaskKind,
        onStatus: message => {
          if (!currentUi()) return;
          status.textContent = message;
          if (message.includes("正在处理")) setStep("thinking");
        }
      });
      if (settled.abandoned || !sessionCurrent()) {
        disclosure.dispose();
        if (activeTaskId === taskId) {
          modal.hidden = true;
          modal.dataset.busy = "false";
        }
        return null;
      }
      if (settled.task && expectedTaskTargetId
        && settled.task.targetId !== expectedTaskTargetId) {
        throw new Error("后台任务目标与当前输入不匹配，结果未写入。");
      }
      if (settled.task && expectedTaskInputVersion != null
        && Number(settled.task.inputVersion) !== Number(expectedTaskInputVersion)) {
        throw new Error("后台任务使用了旧输入版本，结果未写入。");
      }

      const response = settled.result;
      if (expectedTaskRequestId && response.requestId
        && response.requestId !== expectedTaskRequestId) {
        throw new Error("后台任务请求标识与当前输入不匹配，结果未写入。");
      }
      if (expectedTaskTargetId && response.targetId
        && response.targetId !== expectedTaskTargetId) {
        throw new Error("后台任务结果目标与当前输入不匹配，结果未写入。");
      }
      if (expectedTaskInputVersion != null && response.inputVersion != null
        && Number(response.inputVersion) !== Number(expectedTaskInputVersion)) {
        throw new Error("后台任务结果版本与当前输入不匹配，结果未写入。");
      }
      answer = response.draft || response.content || response.answer || answer;
      if (renderFrame) cancelFrame(renderFrame);
      if (activeTaskId === taskId && sessionCurrent()) {
        if (!modal.hidden) {
          disclosure.replace(response);
          renderAnswer();
          output.hidden = !answer;
        }
        if (isCurrent() && onDone) await onDone(response);
        if (activeTaskId !== taskId || !sessionCurrent()) {
          disclosure.dispose();
          return null;
        }
        if (!modal.hidden) {
          setStep("done");
          status.textContent = isCurrent()
            ? "回答已生成并保存。"
            : "回答已生成，但目标输入已经变化，未自动写入。";
        }
        modal.dataset.busy = "false";
      }
      return response;
    } catch (error) {
      if (activeTaskId === taskId && sessionCurrent()) {
        status.className = "status answer-modal-status error";
        status.textContent = `未能生成：${error.message}`;
        modal.dataset.busy = "false";
      }
      throw error;
    } finally {
      session.signal.removeEventListener("abort", resetSession);
    }
  }

  return Object.freeze({ close, run, resetSession });
}
