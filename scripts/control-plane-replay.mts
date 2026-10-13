/**
 * 控制面差量事件的生成与严格回放。
 * 建立时间：2026-10-13；状态：active。
 * 边界：旧事件原样读取；新格式以必要检查点或已校验状态为基线，不推断缺失值。
 */
/** 首个格式3事件启用六位记录与稳定ID差量；旧格式2仍按原契约读取。 @since unreleased */
export const CONTROL_EVENT_FORMAT = 3;

type Row = Record<string, unknown>;
type Cell = { present: false } | { present: true; value: unknown };
type Selector = { id_key: string; id: string };
type Segment = string | number | Selector;
type Change = { path: Segment[]; before: Cell; after: Cell };
type ItemChange = { kind: "item"; path: Segment[]; id_key: string; id: string; before: Cell; after: Cell };
type OrderChange = { kind: "order"; path: Segment[]; id_key: string; before: string[]; after: string[] };
const row = (value: unknown): value is Row => Boolean(value && typeof value === "object" && !Array.isArray(value));
const stableValue = (value: unknown): unknown => Array.isArray(value) ? value.map(stableValue)
  : row(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])])) : value;
// 旧回放建立字段的顺序可能不同；对象按字段值相等，数组顺序仍有含义。
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
const cell = (present: boolean, value?: unknown): Cell => present ? { present: true, value } : { present: false };

/** 项目记录的哈希缩为六位；协议必需的认证、签名及锁文件字段保持原值。 @since unreleased */
export function shortRecordHashes<T>(value: T): T {
  const visit = (item: unknown, key = "", hashes = false): unknown => {
    if (/^(?:signature|sign|token|secret|password|integrity|protocol_fields)$/iu.test(key)) return structuredClone(item);
    if (typeof item === "string") {
      if ((hashes || /(?:hash|sha(?:256)?|fingerprint|commit|tree)$/iu.test(key)) && /^[a-f0-9]{7,64}$/u.test(item)) return item.slice(0, 6);
      return item.replace(/(git:)([a-f0-9]{7,64})(?=$|[\s#:/])/gu, (_match, prefix: string, hash: string) => prefix + hash.slice(0, 6))
        .replace(/(#)([a-f0-9]{7,64})$/u, (_match, prefix: string, hash: string) => prefix + hash.slice(0, 6));
    }
    if (Array.isArray(item)) return item.map(child => visit(child, key, hashes));
    if (row(item)) return Object.fromEntries(Object.entries(item).map(([name, child]) => [name, visit(child, name, hashes || /hashes$/iu.test(name))]));
    return item;
  };
  return visit(value) as T;
}

function stableIdKey(...arrays: unknown[][]): string | null {
  const values = arrays.flat();
  if (!values.length) return null;
  for (const key of ["id", "key", "requirement_id", "iteration_id"]) {
    if (values.every(item => row(item) && typeof item[key] === "string" && item[key])) {
      for (const items of arrays) {
        if (new Set(items.map(item => (item as Row)[key])).size !== items.length) throw new Error("稳定ID集合存在重复ID");
      }
      return key;
    }
  }
  if (values.every(row) && values.some(item => ["id", "key", "requirement_id", "iteration_id"].some(key => Object.hasOwn(item, key)))) {
    throw new Error("稳定ID集合存在缺失或混合身份");
  }
  return null;
}

/** 稳定ID集合按身份生成内容差量；顺序单独记录，缺失与null保持不同语义。 @since unreleased */
export function stateChanges(before: Row, after: Row): Array<Change | ItemChange | OrderChange> {
  const changes: Array<Change | ItemChange | OrderChange> = [];
  function diff(path: Segment[], left: Cell, right: Cell): void {
    if (equal(left, right)) return;
    if (left.present && right.present && row(left.value) && row(right.value)) {
      for (const key of [...new Set([...Object.keys(left.value), ...Object.keys(right.value)])].sort()) {
        diff([...path, key], cell(Object.hasOwn(left.value, key), left.value[key]), cell(Object.hasOwn(right.value, key), right.value[key]));
      }
      return;
    }
    if (left.present && right.present && Array.isArray(left.value) && Array.isArray(right.value)) {
      const a = left.value, b = right.value;
      const idKey = stableIdKey(a, b);
      if (idKey) {
        const oldItems = new Map(a.map(item => [(item as Row)[idKey] as string, item]));
        const newItems = new Map(b.map(item => [(item as Row)[idKey] as string, item]));
        for (const [id, item] of oldItems) {
          if (!newItems.has(id)) changes.push({ kind: "item", path, id_key: idKey, id, before: cell(true, item), after: cell(false) });
        }
        for (const [id, item] of newItems) {
          if (!oldItems.has(id)) changes.push({ kind: "item", path, id_key: idKey, id, before: cell(false), after: cell(true, item) });
          else diff([...path, { id_key: idKey, id }], cell(true, oldItems.get(id)), cell(true, item));
        }
        const intermediate = [...oldItems.keys()].filter(id => newItems.has(id)).concat([...newItems.keys()].filter(id => !oldItems.has(id)));
        const order = [...newItems.keys()];
        if (!equal(intermediate, order)) changes.push({ kind: "order", path, id_key: idKey, before: intermediate, after: order });
        return;
      }
      for (let i = 0; i < Math.min(a.length, b.length); i += 1) diff([...path, i], cell(true, a[i]), cell(true, b[i]));
      for (let i = a.length - 1; i >= b.length; i -= 1) diff([...path, i], cell(true, a[i]), cell(false));
      for (let i = a.length; i < b.length; i += 1) diff([...path, i], cell(false), cell(true, b[i]));
      return;
    }
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

/** 严格核对前值并恢复身份与顺序；format=2按原位置契约回放旧事件。 @since unreleased */
export function replayChanges(before: Row, value: unknown, format = CONTROL_EVENT_FORMAT): Row {
  if (!Array.isArray(value)) throw new Error("差量changes须为数组");
  const next = structuredClone(before);
  const forbidden = (key: string) => ["__proto__", "constructor", "prototype"].includes(key);
  const selector = (value: unknown): value is Selector => row(value) && Object.keys(value).length === 2
    && typeof value.id_key === "string" && !forbidden(value.id_key) && typeof value.id === "string" && Boolean(value.id);
  const locate = (parent: Row | unknown[], key: Segment): string | number => {
    if (typeof key === "object") {
      if (!Array.isArray(parent) || !selector(key) || stableIdKey(parent) !== key.id_key) throw new Error("差量稳定ID路径无效");
      const index = parent.findIndex(item => (item as Row)[key.id_key] === key.id);
      if (index < 0) throw new Error("差量稳定ID不存在");
      return index;
    }
    if (Array.isArray(parent) && (typeof key !== "number" || key > parent.length)) throw new Error("差量数组路径无效");
    return key;
  };
  const at = (keys: Segment[]): Row | unknown[] => {
    let parent: Row | unknown[] = next;
    for (const segment of keys) {
      const key = locate(parent, segment);
      if (!Object.hasOwn(parent, key)) throw new Error("差量父路径缺失");
      const child: unknown = (parent as Row)[key];
      if (!row(child) && !Array.isArray(child)) throw new Error("差量父路径不是容器");
      parent = child;
    }
    return parent;
  };
  for (const input of value) {
    const special = row(input) && format === CONTROL_EVENT_FORMAT && ["item", "order"].includes(String(input.kind));
    const allowed = special ? ["kind", "path", "id_key", "id", "before", "after"] : ["path", "before", "after"];
    if (!row(input) || Object.keys(input).some(key => !allowed.includes(key))
      || !Array.isArray(input.path) || !input.path.length) throw new Error("差量路径无效");
    const keys = input.path as Segment[];
    if (keys.some(key => typeof key === "string" ? forbidden(key)
      : typeof key === "number" ? !Number.isInteger(key) || key < 0 : format !== CONTROL_EVENT_FORMAT || !selector(key))) throw new Error("差量路径无效");
    const readCell = (raw: unknown, allowItem = false): Cell => {
      if (!row(raw) || typeof raw.present !== "boolean" || Object.keys(raw).some(key => !["present", "value"].includes(key))
        || Object.hasOwn(raw, "value") !== raw.present) throw new Error("差量缺失语义无效");
      if (!allowItem && raw.present && ((row(raw.value) && Object.keys(raw.value).length > 0)
        || (Array.isArray(raw.value) && raw.value.length > 0))) throw new Error("差量容器须按叶子变化记录");
      return raw as Cell;
    };
    if (special) {
      const items = at(keys);
      if (!Array.isArray(items) || typeof input.id_key !== "string" || forbidden(input.id_key)) throw new Error("差量稳定ID集合无效");
      const idKey = input.id_key;
      if (items.length && stableIdKey(items) !== idKey) throw new Error("差量稳定ID集合无效");
      if (input.kind === "order") {
        const oldOrder = items.map(item => (item as Row)[idKey]);
        if (!Array.isArray(input.before) || !Array.isArray(input.after) || !equal(oldOrder, input.before)
          || input.after.some(id => typeof id !== "string") || new Set(input.after).size !== items.length
          || input.after.length !== items.length || input.after.some(id => !oldOrder.includes(id))) throw new Error("差量顺序前值或身份不一致");
        const byId = new Map(items.map(item => [(item as Row)[idKey], item]));
        items.splice(0, items.length, ...input.after.map(id => byId.get(id)));
      } else {
        if (typeof input.id !== "string" || !input.id) throw new Error("差量稳定ID无效");
        const index = items.findIndex(item => (item as Row)[idKey] === input.id);
        const expected = readCell(input.before, true), replacement = readCell(input.after, true);
        if (!equal(cell(index >= 0, items[index]), expected)) throw new Error("差量前值不一致");
        if (expected.present === replacement.present) throw new Error("集合字段修改须按稳定ID叶子记录");
        if (replacement.present) {
          if (!row(replacement.value) || replacement.value[idKey] !== input.id) throw new Error("差量稳定ID值不一致");
          items.push(structuredClone(replacement.value));
        } else items.splice(index, 1);
      }
      continue;
    }
    const expected = readCell(input.before), replacement = readCell(input.after);
    const parent = at(keys.slice(0, -1)), key = locate(parent, keys.at(-1)!);
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
