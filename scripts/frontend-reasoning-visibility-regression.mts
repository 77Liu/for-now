/**
 * Verifies shared reasoning presentation and session isolation using the actual public UI entry.
 * Established: 2026-10-19
 * Status: active
 * Boundary: in-memory DOM port; browser evidence remains separately required.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const source = (path: string) => pathToFileURL(`${process.cwd()}/${path}`).href;
const { createReasoningDisclosure, reasoningDisclosureMarkup } =
  await import(source("public/frontend/features/ui/index.mjs"));
const { chatAnswerMarkup } = await import(source("public/frontend/features/chats/index.mjs"));

assert.equal(reasoningDisclosureMarkup({ reasoningContent: "private" }, true), "");
assert.equal(reasoningDisclosureMarkup({
  reasoningContent: "private", reasoningVisibility: "privileged_only"
}, true), "");
assert.equal(reasoningDisclosureMarkup({
  reasoningContent: "", reasoningVisibility: "user_viewable"
}, true), "");
const markup = reasoningDisclosureMarkup({
  reasoningContent: "<script>fail()</script>", reasoningVisibility: "user_viewable"
}, true);
assert.match(markup, /&lt;script&gt;/);
assert.doesNotMatch(markup, /<script| open/);
assert.equal(reasoningDisclosureMarkup({
  reasoningContent: "visible", reasoningVisibility: "user_viewable"
}, false), "");
assert.match(chatAnswerMarkup({ answer: "final" }, (text: string) => text), /final/);

class Element {
  className = "";
  textContent = "";
  open = false;
  children: Element[] = [];
  parent: Element | null = null;
  ownerDocument = { createElement: (_name: string) => new Element() };
  append(...items: Element[]) {
    for (const item of items) {
      item.parent = this;
      this.children.push(item);
    }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this);
    this.parent = null;
  }
}
const host = new Element();
let current = true;
const live = createReasoningDisclosure({
  host, enabled: () => true, isCurrent: () => current
});
live.append("first ");
assert.equal(host.children.length, 1);
assert.equal(host.children[0].open, false);
host.children[0].open = true;
live.append("second");
assert.equal(host.children[0].open, true, "streaming preserves the user's expanded state");
assert.equal(host.children[0].children[1].textContent, "first second");
current = false;
live.append("late account data");
assert.equal(host.children.length, 0);
current = true;
live.append("must remain disposed");
assert.equal(host.children.length, 0);
console.log("Shared reasoning UI passed: collapsed, empty/hidden omitted, escaped, preserved expansion and late-session disposal.");

// Health renders lazily after recognition; a cleared or replaced surface must not
// receive an import completion belonging to the previous recognition/session.
const { createHealthView } = await import(source("public/frontend/features/health/view.mjs"));
const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", { configurable: true, value: {
  documentElement: { dataset: { aiReasoningUiEnabled: "true" } }
} });
try {
  const reasoningHost = { innerHTML: "", textContent: "" };
  const healthForm = { elements: { attachmentPaths: { value: "" } }, querySelectorAll: () => [] };
  const healthView = createHealthView({
    getRoot: () => ({ querySelector: (selector: string) => selector === "#health-recognition-reasoning"
      ? reasoningHost : selector.startsWith("[data-daily-form=") ? healthForm : null })
  });
  const result = (text: string) => ({ reasoningContent: text, reasoningVisibility: "user_viewable" });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  healthView.applyRecognitionResult("sleep", result("old account"));
  healthView.clearReasoning();
  await settle();
  assert.equal(reasoningHost.innerHTML, "", "unmounted/account-cleared reasoning stays empty");
  healthView.applyRecognitionResult("sleep", result("older result"));
  healthView.applyRecognitionResult("sleep", result("latest result"));
  await settle();
  assert.match(reasoningHost.innerHTML, /latest result/);
  assert.doesNotMatch(reasoningHost.innerHTML, /older result/);
  healthView.applyRecognitionResult("sleep", { reasoningContent: "private", reasoningVisibility: "privileged_only" });
  await settle();
  assert.equal(reasoningHost.innerHTML, "", "lazy rendering retains visibility policy");
} finally {
  if (priorDocument) Object.defineProperty(globalThis, "document", priorDocument);
  else Reflect.deleteProperty(globalThis, "document");
}
console.log("Health lazy reasoning passed: latest result, session clearing and visibility policy.");
