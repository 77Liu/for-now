/**
 * 本机模拟测试的视图数据加载适配器。
 * 建立时间：2026-10-13；状态：active。
 * 边界：仅模拟模式加载；退出账户清空在途归属，旧请求不覆盖新会话或清理新请求。
 */
type Control = { mode?: string; loadedScopes?: string[] } | null;
type Panel = { setAttribute(name: string, value: string): void; removeAttribute(name: string): void } | null;
type Ports = {
  getControl(): Control;
  getOwner(): string | undefined;
  getSession(): number;
  getPanel(view: string): Panel;
  request(path: string, options: { method: string; body: string }): Promise<{ control: Control; state: Record<string, unknown> }>;
  setControl(control: Control): void;
  replaceSnapshot(state: Record<string, unknown>): void;
  publishSnapshot(state: Record<string, unknown>, source: string): void;
  setUnreadCount(value: number): void;
  markRouteLoaded(): void;
  render(): void;
  fail(error: unknown): void;
};
const VIEW_SCOPES: Readonly<Record<string, string>> = Object.freeze({
  today: "today", daily: "daily", captures: "captures", books: "books", quotes: "quotes",
  keepsakes: "keepsakes", journals: "journals", thoughts: "thoughts", discovery: "discovery",
  together: "together", review: "review", statistics: "statistics", "ai-cost": "statistics",
  commercialization: "statistics", "personal-context": "personal-context", feedback: "feedback",
  export: "export", trash: "trash"
});

/** 加载尚未进入本机会话的合成数据；同scope在途请求复用，reset使旧结果失效。 @since unreleased */
export function createViewScopeSupport(ports: Ports) {
  const pending = new Map<string, { work: Promise<boolean>; panel: Panel }>();
  let epoch = 0;
  return {
    ensureView(view: string): Promise<boolean> {
      const scope = VIEW_SCOPES[view], control = ports.getControl();
      if (!scope || control?.mode !== "simulation" || control.loadedScopes?.includes(scope)) return Promise.resolve(true);
      const existing = pending.get(scope);
      if (existing) return existing.work;
      const owner = ports.getOwner(), session = ports.getSession(), generation = epoch;
      const panel = ports.getPanel(view);
      const current = () => owner === ports.getOwner() && session === ports.getSession()
        && generation === epoch && ports.getControl()?.mode === "simulation";
      panel?.setAttribute("aria-busy", "true");
      const work = Promise.resolve().then(async () => {
        try {
          const result = await ports.request("/api/local-test-mode/hydrate", {
            method: "POST", body: JSON.stringify({ scope })
          });
          if (!current()) return false;
          ports.setControl(result.control);
          ports.replaceSnapshot(result.state);
          ports.publishSnapshot(result.state, "local-test-hydrate");
          ports.setUnreadCount(Number(result.state.notificationUnread) || 0);
          ports.markRouteLoaded();
          ports.render();
          return true;
        } catch (error) {
          if (current()) ports.fail(error);
          return false;
        } finally {
          if (pending.get(scope)?.work === work) {
            panel?.removeAttribute("aria-busy");
            pending.delete(scope);
          }
        }
      });
      pending.set(scope, { work, panel });
      return work;
    },
    reset(): void {
      epoch += 1;
      for (const entry of pending.values()) entry.panel?.removeAttribute("aria-busy");
      pending.clear();
    }
  };
}
