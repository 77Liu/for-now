/**
 * 控制面差量事件的生成与严格回放。
 * 建立时间：2026-10-13；状态：active。
 * 边界：旧事件原样读取；新格式以必要检查点或已校验状态为基线，不推断缺失值。
 */
/** 首个带此版本号的事件即差量格式生效点；旧事件不补写该字段。 @since unreleased */
export const CONTROL_EVENT_FORMAT = 2;

type Row = Record<string, unknown>;
type Cell = { present: false } | { present: true; value: unknown };
type Change = { path: Array<string | number>; before: Cell; after: Cell };
const row = (value: unknown): value is Row => Boolean(value && typeof value === "object" && !Array.isArray(value));
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const cell = (present: boolean, value?: unknown): Cell => present ? { present: true, value } : { present: false };

/** 生成顺序差量；对象/数组按叶子变化记录，null 与不存在有不同语义。 @since unreleased */
export function stateChanges(before: Row, after: Row): Change[] {
  const changes: Change[] = [];
  function diff(path: Change["path"], left: Cell, right: Cell): void {
    if (equal(left, right)) return;
    if (left.present && right.present && row(left.value) && row(right.value)) {
      for (const key of [...new Set([...Object.keys(left.value), ...Object.keys(right.value)])].sort()) {
        diff([...path, key], cell(Object.hasOwn(left.value, key), left.value[key]), cell(Object.hasOwn(right.value, key), right.value[key]));
      }
      return;
    }
    if (left.present && right.present && Array.isArray(left.value) && Array.isArray(right.value)) {
      const a = left.value, b = right.value;
      for (let i = 0; i < Math.min(a.length, b.length); i += 1) diff([...path, i], cell(true, a[i]), cell(true, b[i]));
      for (let i = a.length - 1; i >= b.length; i -= 1) diff([...path, i], cell(true, a[i]), cell(false));
      for (let i = a.length; i < b.length; i += 1) diff([...path, i], cell(false), cell(true, b[i]));
      return;
    }
    // 先拆去旧容器，再逐叶建立新容器，避免把整份嵌套状态藏进单项value。
    if (left.present && (row(left.value) || Array.isArray(left.value))) {
      const empty = Array.isArray(left.value) ? [] : {};
      diff(path, left, cell(true, empty));
      changes.push({ path, before: cell(true, empty), after: cell(false) });
      diff(path, cell(false), right);
      return;
    }
    if (right.present && (row(right.value) || Array.isArray(right.value))) {
      const empty = Array.isArray(right.value) ? [] : {};
      changes.push({ path, before: left, after: cell(true, empty) });
      diff(path, cell(true, empty), right);
      return;
    }
    changes.push({ path, before: left, after: right });
  }
  diff([], cell(true, before), cell(true, after));
  return changes;
}

/** 按顺序核对每个前值再回放；拒绝非法路径、缺失父级与稀疏数组。 @since unreleased */
export function replayChanges(before: Row, value: unknown): Row {
  if (!Array.isArray(value)) throw new Error("差量changes须为数组");
  const next = structuredClone(before);
  for (const input of value) {
    if (!row(input) || Object.keys(input).some(key => !["path", "before", "after"].includes(key))
      || !Array.isArray(input.path) || !input.path.length) throw new Error("差量路径无效");
    const keys = input.path as Array<string | number>;
    if (keys.some(key => typeof key !== "string" && (!Number.isInteger(key) || Number(key) < 0))
      || keys.some(key => ["__proto__", "constructor", "prototype"].includes(String(key)))) throw new Error("差量路径无效");
    const readCell = (raw: unknown): Cell => {
      if (!row(raw) || typeof raw.present !== "boolean" || Object.keys(raw).some(key => !["present", "value"].includes(key))
        || Object.hasOwn(raw, "value") !== raw.present) throw new Error("差量缺失语义无效");
      if (raw.present && ((row(raw.value) && Object.keys(raw.value).length > 0)
        || (Array.isArray(raw.value) && raw.value.length > 0))) throw new Error("差量容器须按叶子变化记录");
      return raw as Cell;
    };
    const expected = readCell(input.before), replacement = readCell(input.after);
    let parent: Row | unknown[] = next;
    for (const key of keys.slice(0, -1)) {
      if (!Object.hasOwn(parent, key)) throw new Error("差量父路径缺失");
      const child: unknown = (parent as Row)[key];
      if (!row(child) && !Array.isArray(child)) throw new Error("差量父路径不是容器");
      parent = child;
    }
    const key = keys.at(-1)!;
    if (Array.isArray(parent) && (typeof key !== "number" || key > parent.length)) throw new Error("差量数组路径无效");
    const present = Object.hasOwn(parent, key);
    if (!equal(cell(present, (parent as Row)[key]), expected)) throw new Error("差量前值不一致");
    if (replacement.present) (parent as Row)[key] = structuredClone(replacement.value);
    else if (Array.isArray(parent)) {
      if (key !== parent.length - 1 || !present) throw new Error("差量数组删除顺序无效");
      parent.pop();
    } else delete (parent as Row)[key];
  }
  return next;
}

/** 仅供已验证的读取消费者使用；重建状态不成为新事件的可序列化全量字段。 @since unreleased */
export function materializeEvent(event: Row, state: Row): void {
  Object.defineProperty(event, "state_after", { value: state, enumerable: false, configurable: true });
}
