export let sessionSerial = 0;
let controller = new AbortController();
export const sessionScope = {
  capture() { return { serial: sessionSerial, signal: controller.signal }; },
  isCurrent(ticket) { return ticket.serial === sessionSerial && !ticket.signal.aborted; },
  assertCurrent(ticket) {
    if (!this.isCurrent(ticket)) throw new DOMException("会话已变化", "AbortError");
  }
};
export function rotateSession() {
  controller.abort();
  controller = new AbortController();
  sessionSerial += 1;
}
