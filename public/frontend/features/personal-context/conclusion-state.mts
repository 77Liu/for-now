/**
 * 职责：在个人模型重绘间保留结论展开状态和阅读位置。
 * 建立时间：2026-10-13；状态：active。
 * 边界：仅控制器当前账户会话；稳定结论 ID 关联状态，退出账户显式清空。
 */
const SELECTOR = "details[data-context-conclusion-id]";
type Position = { window: Window; x: number; id: string; top: number };

/** 创建结论视图状态；在同步重绘前后使用，reset 不保留旧账户状态。 @since unreleased */
export function createConclusionViewState() {
  const expanded = new Map<string, boolean>();
  let position: Position | null = null;
  return {
    beforePaint(root: HTMLElement): void {
      const window = root.ownerDocument?.defaultView;
      position = null;
      for (const node of root.querySelectorAll?.<HTMLDetailsElement>(SELECTOR) || []) {
        const id = node.dataset.contextConclusionId;
        if (!id) continue;
        expanded.set(id, node.open);
        const rect = node.getBoundingClientRect();
        if (window && !position && rect.bottom > 0 && rect.top < window.innerHeight) {
          position = { window, x: window.scrollX, id, top: rect.top };
        }
      }
    },
    afterPaint(root: HTMLElement): void {
      let anchor: HTMLDetailsElement | null = null;
      for (const node of root.querySelectorAll?.<HTMLDetailsElement>(SELECTOR) || []) {
        const id = node.dataset.contextConclusionId || "";
        if (expanded.has(id)) node.open = expanded.get(id) === true;
        if (id === position?.id) anchor = node;
      }
      if (position && anchor) {
        const delta = anchor.getBoundingClientRect().top - position.top;
        position.window.scrollTo(position.x, position.window.scrollY + delta);
      }
      position = null;
    },
    reset(): void {
      expanded.clear();
      position = null;
    }
  };
}
