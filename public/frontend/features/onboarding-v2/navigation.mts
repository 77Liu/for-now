/**
 * 职责：把问答结束动作接到今日、提问或记录入口。
 * 边界：不保存问答、不发起整理，仅消费已经允许离开问答的动作。
 * 建立日期：2026-10-13；状态：active。
 */
interface NavigationPorts {
  showToday(): void;
  openQuestion(): void;
  openRecord(): void;
}

/** 显式区分今日与记录动作，未知动作不触发导航。 @since unreleased */
export function navigateAfterOnboarding(action: string, ports: NavigationPorts): void {
  if (action === "today" || action === "question") {
    ports.showToday();
  }
  if (action === "question") {
    ports.openQuestion();
  } else if (action === "record") {
    ports.openRecord();
  }
}
