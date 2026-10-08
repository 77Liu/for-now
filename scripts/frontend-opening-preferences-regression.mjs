import assert from "node:assert/strict";
import { createOpeningPreferencesController } from "../public/frontend/features/account-settings/index.mjs";
import { RAIN_LIMITS, openingPreferences } from "../public/frontend/shared/opening/index.mjs";
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
  const fields = ["enabled", "showBrand", "protectBrand", ...Object.keys(RAIN_LIMITS)]
    .map(name => ({ name, value: "", checked: false, disabled: false }));
  for (const field of fields) fields[field.name] = field;
  const submit = { disabled: false }; fields.push(submit);
  const form = { elements: fields, contains: target => fields.includes(target) || target.action,
    querySelector: () => submit };
  const status = { textContent: "" }, listeners = new Map();
  const root = { querySelector: selector => selector === "#opening-preferences-form" ? form : status,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type) };
  const dispatch = (type, target) => listeners.get(type)?.({ target, preventDefault() {} });
  const click = action => dispatch("click", { action, dataset: { openingAction: action }, closest() { return this; } });
  return { root, form, fields, status, submit, dispatch, click, listeners };
}
const storage = { values: new Map(), getItem(k) { return this.values.get(k); }, setItem(k, v) { this.values.set(k, v); }, removeItem(k) { this.values.delete(k); } };
let user = { id: "owner-a", role: "owner" }, calls = [], queue = [];
const request = { json: (url, options = {}) => { calls.push({ url, ...options }); const result = queue.shift(); assert.ok(result, "unexpected request"); return result.promise; } };
const controller = createOpeningPreferencesController({ request, currentUser: { get: () => user }, hasCapability: () => user?.role === "owner", storage });
const first = fixture(), initial = deferred(); queue.push(initial);
controller.mount({ root: first.root }); assert.equal(calls.length, 1); assert.equal(first.fields.density.disabled, true);
initial.resolve(openingPreferences()); await flush(); assert.equal(first.fields.density.disabled, false);
first.fields.density.value = "8"; first.dispatch("input", first.fields.density);
assert.equal(JSON.parse(storage.getItem("cike:opening-draft:owner-a")).config.density, 8);
controller.unmount();
const next = fixture(), loaded = deferred(); queue.push(loaded);
controller.mount({ root: next.root }); loaded.resolve({ ...openingPreferences(), revision: 1 }); await flush();
assert.equal(next.fields.density.value, 8); assert.match(next.status.textContent, /恢复草稿.*别处更新/);
const conflict = deferred(); queue.push(conflict); next.dispatch("submit", next.form);
assert.equal(calls.at(-1).headers["if-match"], '"opening-0"');
conflict.reject(Object.assign(new Error("conflict"), { status: 409 })); await flush();
assert.equal(next.fields.density.value, 8); assert.match(next.status.textContent, /草稿已保留/);
const latest = deferred(); queue.push(latest); next.click("reload"); latest.resolve({ ...openingPreferences(), revision: 1 }); await flush();
assert.equal(next.fields.density.value, 8);
const saved = deferred(); queue.push(saved); next.dispatch("submit", next.form);
const payload = JSON.parse(calls.at(-1).body); assert.equal(payload.revision, 1); assert.equal(payload.config.density, 8);
saved.resolve({ ...payload, revision: 2 }); await flush();
assert.equal(storage.getItem("cike:opening-draft:owner-a"), undefined); assert.match(next.status.textContent, /已保存/);
next.click("reset"); assert.equal(next.fields.density.value, 3.5);
// Logout/reset clears private controls and draft even after route unmount.
controller.unmount(); next.root.querySelector = () => null;
controller.resetSession(); assert.equal(next.fields.density.value, 3.5);
assert.equal(storage.getItem("cike:opening-draft:owner-a"), undefined);
const ordinary = fixture(); user = { id: "ordinary", role: "user" }; const before = calls.length;
controller.mount({ root: ordinary.root }); assert.equal(calls.length, before); assert.equal(ordinary.listeners.size, 0);
user = null; controller.mount({ root: ordinary.root }); assert.equal(calls.length, before);
// Late reads cannot cross accounts; switching clears the previous owner cache.
user = { id: "owner-a", role: "owner" }; const late = deferred(); queue.push(late); const old = fixture(); controller.mount({ root: old.root });
user = { id: "owner-b", role: "owner" }; const fresh = deferred(); queue.push(fresh); const other = fixture(); controller.mount({ root: other.root });
late.resolve({ ...openingPreferences(), config: { density: 9 }, revision: 22 }); await flush(); assert.equal(other.fields.density.value, 3.5);
fresh.reject(new Error("network failure")); await flush(); assert.equal(other.fields.density.value, 3.5);
assert.match(other.status.textContent, /network failure/); const noSave = calls.length;
other.dispatch("submit", other.form); assert.equal(calls.length, noSave, "load failure cannot overwrite unknown server revision");
// Late successful saves after a session reset never restore prior private state.
const retry = deferred(); queue.push(retry); other.click("reload"); retry.resolve(openingPreferences()); await flush();
other.fields.speed.value = "100"; other.dispatch("input", other.fields.speed); const saving = deferred(); queue.push(saving); other.dispatch("submit", other.form);
controller.resetSession(); user = null; saving.resolve({ ...openingPreferences(), config: { speed: 100 }, revision: 1 }); await flush();
assert.equal(other.fields.speed.value, 85); assert.equal(other.status.textContent, "");
assert.equal(storage.getItem("cike:opening-draft:owner-b"), undefined);
console.log("Opening frontend preferences passed: Owner-only loading, durable account drafts, explicit conflict recovery, network fallback, reset and late read/save isolation.");
