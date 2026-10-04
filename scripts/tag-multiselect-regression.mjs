import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import {
  createTagMultiSelectState,
  handleTagMultiSelectKey,
  normalizeTag,
  normalizeTagList,
  reduceTagMultiSelectState
} from "../public/frontend/components/tag-multiselect/index.mjs";

assert.equal(normalizeTag("  #  修   行  "), "修 行");
assert.equal(normalizeTag("＃文化"), "文化");
assert.equal(normalizeTag(" \n\t "), "");
assert.equal(normalizeTag("123456", { maxLength: 5 }), "12345");
assert.deepEqual(
  normalizeTagList([" 修行 ", "修行", "修   行", "REFLECTION", "reflection", null]),
  ["修行", "修 行", "REFLECTION"]
);
assert.deepEqual(normalizeTagList(["ＡＩ", "AI"]), ["ＡＩ"]);
assert.deepEqual(normalizeTagList(["修行"], { limit: 0 }), []);

const initial = createTagMultiSelectState({
  candidates: [" 修行 ", "行动", "REFLECTION", "reflection", "　文化　"],
  selected: ["行动", " 修行 ", "行动"]
});
assert.deepEqual(initial.candidates, ["修行", "行动", "REFLECTION", "文化"]);
assert.deepEqual(initial.selected, ["行动", "修行"]);
assert.deepEqual(initial.options, [
  { type: "candidate", value: "REFLECTION" },
  { type: "candidate", value: "文化" }
]);
assert.equal(initial.activeIndex, -1);
assert.equal(initial.activeOption, null);
assert.equal(initial.canCreate, false);
assert.equal(initial.atLimit, false);

const initialBeforeInput = structuredClone(initial);
const filtered = reduceTagMultiSelectState(initial, { type: "input", value: "  reflec  " });
assert.deepEqual(initial, initialBeforeInput, "state transitions must not mutate prior state");
assert.equal(filtered.input, "  reflec  ");
assert.equal(filtered.query, "reflec");
assert.deepEqual(filtered.options, [
  { type: "candidate", value: "REFLECTION" },
  { type: "create", value: "reflec" }
]);
assert.deepEqual(filtered.activeOption, { type: "candidate", value: "REFLECTION" });
assert.equal(filtered.canCreate, true);

const exactCandidate = reduceTagMultiSelectState(initial, { type: "input", value: " reflection " });
assert.deepEqual(exactCandidate.options, [{ type: "candidate", value: "REFLECTION" }]);
assert.equal(exactCandidate.canCreate, false);
const compatibilityFiltered = reduceTagMultiSelectState(
  createTagMultiSelectState({ candidates: ["ＡＩ", "文化"] }),
  { type: "input", value: "ai" }
);
assert.deepEqual(compatibilityFiltered.options[0], { type: "candidate", value: "ＡＩ" });

let keyboardState = createTagMultiSelectState({
  candidates: ["旅行", "旅居", "阅读"],
  input: "旅"
});
assert.deepEqual(keyboardState.activeOption, { type: "candidate", value: "旅行" });
let keyResult = handleTagMultiSelectKey(keyboardState, { key: "ArrowDown" });
assert.equal(keyResult.handled, true);
assert.equal(keyResult.intent, "move");
assert.deepEqual(keyResult.state.activeOption, { type: "candidate", value: "旅居" });
keyResult = handleTagMultiSelectKey(keyResult.state, { key: "Enter" });
assert.equal(keyResult.intent, "select");
assert.deepEqual(keyResult.state.selected, ["旅居"]);
assert.equal(keyResult.state.input, "");
assert.equal(keyResult.state.activeIndex, -1);

keyboardState = reduceTagMultiSelectState(keyResult.state, { type: "input", value: "  新   标签 " });
assert.deepEqual(keyboardState.options, [{ type: "create", value: "新 标签" }]);
keyResult = handleTagMultiSelectKey(keyboardState, { key: "Enter" });
assert.equal(keyResult.intent, "create");
assert.deepEqual(keyResult.state.selected, ["旅居", "新 标签"]);
assert.ok(keyResult.state.candidates.includes("新 标签"));

const composingState = reduceTagMultiSelectState(keyResult.state, { type: "input", value: "输入中" });
keyResult = handleTagMultiSelectKey(composingState, { key: "Enter", isComposing: true });
assert.equal(keyResult.handled, false);
assert.equal(keyResult.intent, "none");
assert.equal(keyResult.state, composingState);

keyboardState = reduceTagMultiSelectState(keyResult.state, { type: "input", value: " \t " });
keyResult = handleTagMultiSelectKey(keyboardState, { key: "Backspace" });
assert.equal(keyResult.handled, true);
assert.equal(keyResult.intent, "remove");
assert.deepEqual(keyResult.state.selected, ["旅居"]);
keyboardState = reduceTagMultiSelectState(keyResult.state, { type: "input", value: "待清空" });
keyResult = handleTagMultiSelectKey(keyboardState, { key: "Escape" });
assert.equal(keyResult.intent, "clear");
assert.equal(keyResult.state.input, "");

let navigation = createTagMultiSelectState({ candidates: ["甲", "乙"] });
navigation = handleTagMultiSelectKey(navigation, { key: "ArrowUp" }).state;
assert.deepEqual(navigation.activeOption, { type: "candidate", value: "乙" });
navigation = handleTagMultiSelectKey(navigation, { key: "Home" }).state;
assert.deepEqual(navigation.activeOption, { type: "candidate", value: "甲" });
navigation = handleTagMultiSelectKey(navigation, { key: "End" }).state;
assert.deepEqual(navigation.activeOption, { type: "candidate", value: "乙" });

let removable = createTagMultiSelectState({
  candidates: ["REFLECTION", "文化"],
  selected: ["REFLECTION", "文化"]
});
removable = reduceTagMultiSelectState(removable, { type: "remove", value: "reflection" });
assert.deepEqual(removable.selected, ["文化"]);
assert.ok(removable.options.some(option => option.value === "REFLECTION"));
removable = reduceTagMultiSelectState(removable, { type: "select", value: "  reflection " });
assert.deepEqual(removable.selected, ["文化", "REFLECTION"]);

const selectedAtLimit = Array.from({ length: 8 }, (_, index) => `标签${index + 1}`);
let limited = createTagMultiSelectState({
  candidates: [...selectedAtLimit, "候选"],
  selected: selectedAtLimit,
  input: "新标签"
});
assert.equal(limited.atLimit, true);
assert.equal(limited.canCreate, false);
assert.deepEqual(limited.options, []);
limited = reduceTagMultiSelectState(limited, { type: "remove", value: "标签8" });
limited = reduceTagMultiSelectState(limited, { type: "input", value: "新标签" });
assert.equal(limited.atLimit, false);
assert.deepEqual(limited.options, [{ type: "create", value: "新标签" }]);

const replaced = reduceTagMultiSelectState(limited, {
  type: "set-candidates",
  values: ["新候选", "文化", " 新候选 "]
});
assert.ok(replaced.candidates.includes("新候选"));
assert.ok(replaced.candidates.includes("标签1"), "selected tags remain candidates after replacement");
const reselection = reduceTagMultiSelectState(replaced, {
  type: "set-selected",
  values: [" 新候选 ", "文化", "文化"]
});
assert.deepEqual(reselection.selected, ["新候选", "文化"]);
assert.throws(
  () => reduceTagMultiSelectState(replaced, { type: "unknown" }),
  /Unsupported tag multi-select action/
);

const source = await fs.readFile(
  new URL("../public/frontend/components/tag-multiselect/index.mjs", import.meta.url),
  "utf8"
);
assert.doesNotMatch(
  source,
  /\b(?:document|window|fetch|XMLHttpRequest|HTMLElement|Node)\b/,
  "tag multi-select state must stay independent of DOM globals and network I/O"
);

console.log("Tag multi-select regression passed: normalization, filtering, creation, keyboard selection, removal and limits.");
