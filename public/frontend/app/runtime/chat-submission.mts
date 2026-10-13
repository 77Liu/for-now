/**
 * 共参聊天表单的提交、后台结果消费和输入保留。
 * 建立时间：2026-10-13；状态：active。
 * 边界：请求编号绑定账户、会话和输入；旧响应不得修改新会话控件或后来输入。
 */
type Payload = Record<string, unknown> & { message: string };
type Attempt = { owner?: string; session: number; id: string; input: string; payload: Payload; promise?: Promise<void> };
type Failure = Error & { taskId?: string; syncStatus?: string };
type Ports = {
  runtime: { currentUser?: { id?: string } | null; sessionSerial: number };
  $: (selector: string) => HTMLElement;
  occurrenceFields(input: HTMLInputElement): Record<string, unknown>;
  resetOccurrenceInput(input: HTMLInputElement): void;
  requestV1(path: string, options: { method: string; headers: Record<string, string>; body: string }, coordination: { domains: string[] }): Promise<unknown>;
  resolvePersonalizedTask(response: unknown, options: { operationLabel: string; expectedKind: string; onStatus(message: string): void }): Promise<{ abandoned?: boolean; result: Record<string, unknown> }>;
  refreshState(domain: string): Promise<unknown>;
  showToast(message: string, kind: string): void;
};

/** 绑定原聊天入口；未确认请求按相同输入复用完整载荷，终态或修改输入开启新请求。 @since unreleased */
export function installChatSubmission(ports: Ports): void {
  const { runtime, $ } = ports;
  const form = $("#chat-form") as HTMLFormElement;
  let attempt: Attempt | null = null;
  const inputIdentity = () => {
    const date = $("#chat-datetime") as HTMLInputElement;
    return JSON.stringify({ message: ($("#chat-input") as HTMLInputElement).value,
      date: date.value || "", mode: date.dataset?.occurrenceMode || "" });
  };
  const sameSession = (value: Attempt) => value.owner === runtime.currentUser?.id && value.session === runtime.sessionSerial;
  const current = (value: Attempt) => sameSession(value) && attempt === value;
  const clearKey = (value: Attempt) => {
    if (current(value) && form.dataset.requestId === value.id) delete form.dataset.requestId;
  };

  form.addEventListener("reset", () => {
    attempt = null;
    delete form.dataset.requestId;
    const button = form.querySelector<HTMLButtonElement>("button");
    if (button) button.disabled = false;
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (attempt?.promise && sameSession(attempt)) return attempt.promise;
    const owner = runtime.currentUser?.id, session = runtime.sessionSerial;
    const identity = inputIdentity();
    let payload: Payload;
    try {
      payload = { ...ports.occurrenceFields($("#chat-datetime") as HTMLInputElement),
        message: ($("#chat-input") as HTMLInputElement).value };
    } catch (error) {
      if (owner === runtime.currentUser?.id && session === runtime.sessionSerial) {
        $("#chat-status").textContent = (error as Error).message;
      }
      return;
    }
    const reusable = attempt && sameSession(attempt) && attempt.input === identity
      && form.dataset.requestId === attempt.id;
    const selected: Attempt = reusable ? attempt! : {
      owner, session, input: identity, payload,
      id: !attempt && form.dataset.requestId ? form.dataset.requestId : crypto.randomUUID()
    };
    attempt = selected;
    form.dataset.requestId = selected.id;
    const button = form.querySelector<HTMLButtonElement>("button")!;
    button.disabled = true;
    $("#chat-status").textContent = "正在结合你已保存的记录…";
    const work = Promise.resolve().then(async () => {
      try {
        const response = await ports.requestV1("/api/v1/chats", {
          method: "POST", headers: { "idempotency-key": selected.id }, body: JSON.stringify(selected.payload)
        }, { domains: ["chats"] });
        if (!current(selected)) return;
        const settled = await ports.resolvePersonalizedTask(response, {
          operationLabel: "对话回答", expectedKind: "chat",
          onStatus: message => { if (current(selected)) $("#chat-status").textContent = message; }
        });
        if (settled.abandoned || !current(selected)) return;
        const saved = settled.result;
        if (["message", "occurredAt", "occurredOn"].some(key => saved[key] !== selected.payload[key])) {
          throw new Error("后台对话结果与本次问题不匹配，输入已保留。");
        }
        const unchanged = inputIdentity() === selected.input;
        clearKey(selected);
        if (unchanged) {
          ($("#chat-input") as HTMLInputElement).value = "";
          ports.resetOccurrenceInput($("#chat-datetime") as HTMLInputElement);
        }
        void ports.refreshState("chat").catch(error => {
          if (current(selected)) ports.showToast(`回答已保存，但页面刷新失败：${(error as Error).message}`, "error");
        });
        $("#chat-status").textContent = unchanged
          ? "回答已生成并保存。" : "回答已生成；你后来修改的输入已保留。";
      } catch (error) {
        if (!current(selected)) return;
        const failure = error as Failure;
        if (failure.taskId) clearKey(selected);
        $("#chat-status").textContent = failure.syncStatus === "pending"
          ? "问题已留存，网络恢复后自动处理。" : failure.message;
      } finally {
        selected.promise = undefined;
        if (current(selected)) button.disabled = false;
      }
    });
    selected.promise = work;
    return work;
  });
}
