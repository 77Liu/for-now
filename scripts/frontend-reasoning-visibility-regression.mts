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
