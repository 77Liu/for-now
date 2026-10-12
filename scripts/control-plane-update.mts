import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";

type ObjectValue = Record<string, unknown>;
const CURRENT = "reports/requirement-coordination-current.json";
const KEYS = new Set([
  "schema_version", "revision", "updated_at", "canonical_path", "coordinator", "rule_baseline",
  "work_mode", "iteration", "scope", "active_tasks", "candidate", "authorization", "blockers",
  "next_action", "evidence", "records", "runtime", "display_summary"
]);
const CHECKS = ["scope_decisions", "task_handoffs", "candidate_changes", "key_validation", "release_actions"];
const EVENT_KEYS = new Set(["id", "type", "phase", "reason", "evidence", "occurred_at", "details", "coverage"]);
const RESERVED_HISTORY = new Set(["history", "completed_task_receipts", "execution_receipts", "write_set_amendments"]);

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}须为对象`);
  return value as ObjectValue;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as ObjectValue;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const actionState = (value: ObjectValue) => Object.fromEntries(Object.entries(value)
  .filter(([key]) => !["revision", "updated_at", "display_summary"].includes(key)));
function versionName(value: unknown): string {
  const version = text(value, "版本");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(version)) throw new Error("版本路径无效");
  return version;
}
const directory = (root: string, version: string) => path.join(root, "reports/iterations", version);

function validateState(state: ObjectValue, root: string): void {
  for (const key of Object.keys(state)) if (!KEYS.has(key)) throw new Error(`当前状态不允许字段：${key}`);
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (RESERVED_HISTORY.has(key)) throw new Error("历史过程不能嵌入当前状态");
        visit(item);
      }
    }
  };
  visit(state);
  if (state.schema_version !== 3) throw new Error("当前控制面须使用schema 3");
  if (state.canonical_path !== path.join(root, CURRENT)) throw new Error("控制面位置不一致");
  text(object(state.coordinator, "协调者").thread_id, "协调者身份");
  for (const key of ["active_tasks", "blockers", "evidence"]) {
    if (!Array.isArray(state[key])) throw new Error(`${key}须为数组`);
  }
  const records = object(state.records, "记录入口");
  if (state.iteration !== null) {
    const version = versionName(object(state.iteration, "当前迭代").id);
    if (records.events !== `reports/iterations/${version}/events.jsonl`
      || records.terminal !== `reports/iterations/${version}/terminal.json`) throw new Error("版本记录入口不一致");
  } else if (records.events !== null || records.terminal !== null) {
    throw new Error("无活动迭代时记录入口须清空，历史引用放evidence");
  }
}

async function readJson(file: string): Promise<ObjectValue> {
  return object(JSON.parse(await fs.readFile(file, "utf8")), "JSON");
}
async function readEvents(file: string): Promise<ObjectValue[]> {
  const content = await fs.readFile(file, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  if (content && !content.endsWith("\n")) throw new Error("事件文件尾部不完整，先恢复现场");
  const rows = content.split("\n").filter(Boolean).map(line => object(JSON.parse(line), "事件"));
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("事件ID重复，先恢复现场");
  return rows;
}
function verifyChain(events: ObjectValue[]): void {
  for (const [index, event] of events.entries()) {
    const after = object(event.state_after, "事件状态");
    if (digest(after) !== event.state_after_hash || digest(actionState(after)) !== event.action_after_hash
      || Number(after.revision) !== Number(event.state_before_revision) + 1) throw new Error("事件状态摘要或修订损坏");
    const previous = events[index - 1];
    if (previous && (event.action_before_hash !== previous.action_after_hash
      || Number(event.state_before_revision) < Number(object(previous.state_after, "前一事件状态").revision))) {
      throw new Error("事件链分叉，先恢复现场");
    }
    if (event.terminal && (event.type !== "iteration_closed" || event.phase !== "result")) throw new Error("非收口事件不能创建快照");
  }
}
async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp.${randomUUID()}`;
  try {
    const handle = await fs.open(temporary, "wx", 0o644);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await fs.rm(temporary, { force: true }); }
}
async function appendEvent(file: string, event: ObjectValue): Promise<void> {
  const handle = await fs.open(file, "a", 0o644);
  try { await handle.writeFile(`${JSON.stringify(event)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}
async function saveTerminal(file: string, snapshot: ObjectValue): Promise<void> {
  // 先完整写临时文件，硬链接以独占创建方式安装；崩溃不会留下半份正式快照。
  const temporary = `${file}.tmp.${randomUUID()}`;
  try {
    const handle = await fs.open(temporary, "wx", 0o444);
    try { await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.link(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (digest(await readJson(file)) !== digest(snapshot)) throw new Error("已有收口快照不同，禁止覆盖");
    }
    await fs.chmod(file, 0o444);
    await syncDirectory(path.dirname(file));
  } finally { await fs.rm(temporary, { force: true }); }
}

function closureSnapshot(request: ObjectValue, current: ObjectValue, events: ObjectValue[], now: string): ObjectValue {
  const closure = object(request.closure, "收口核对");
  if (!["completed", "cancelled"].includes(String(closure.status))) throw new Error("只允许完成或明确取消收口");
  text(closure.result, "实际收口结果");
  const checks = object(closure.checks, "五类收口核对");
  const ids = new Set(events.map(event => event.id));
  for (const category of CHECKS) {
    const item = object(checks[category], category);
    if (!["confirmed", "unknown", "failed", "partial", "not_applicable"].includes(String(item.status))) {
      throw new Error("收口核对结论无效");
    }
    text(item.reason, "收口核对原因");
    if (!Array.isArray(item.event_ids) || !Array.isArray(item.evidence)) throw new Error("收口核对须提供事件和证据引用");
    if (item.status === "confirmed" && (!item.event_ids.length || !item.evidence.length)) throw new Error("已确认收口项缺事件或证据");
    if (item.event_ids.some(id => !ids.has(id))) throw new Error("收口引用了不存在的事件");
  }
  const archived = structuredClone(current);
  archived.revision = Number(current.revision) + 1;
  archived.updated_at = now;
  archived.iteration = { ...object(current.iteration, "收口迭代"), status: closure.status };
  if (closure.status === "completed" && (current.active_tasks as unknown[]).length) throw new Error("仍有活动任务，不能记为版本完成");
  return { schema_version: 1, closed_at: now, control_plane: archived, result: closure };
}

/** 协调者声明身份、预期修订与完整状态一起提交；先持久化事件，再替换当前状态。 */
async function update(root: string, request: ObjectValue, close = false): Promise<ObjectValue> {
  const currentFile = path.join(root, CURRENT);
  const version = versionName(request.iteration_id);
  const dir = directory(root, version);
  await fs.mkdir(dir, { recursive: true });
  const lockFile = path.join(root, "reports/iterations/.control-plane.lock");
  const lock = await fs.open(lockFile, "wx", 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const current = await readJson(currentFile);
    if (!Number.isInteger(current.revision) || Number(current.revision) < 0) throw new Error("当前revision无效");
    if (current.schema_version === 3) validateState(current, root);
    else if (![1, 2].includes(Number(current.schema_version))
      || object(request.event, "迁移事件").type !== "control_migrated") throw new Error("旧状态只能经明确迁移事件升级");
    const desired = object(request.state, "新当前状态");
    validateState(desired, root);
    if (current.schema_version === 3 && current.iteration !== null
      && object(current.iteration, "当前迭代").id !== version) throw new Error("先收口当前版本，不能覆盖活动迭代");
    if (!close && object(desired.iteration, "目标迭代").id !== version) throw new Error("更新版本不一致");
    const actor = text(request.actor, "协调者");
    const currentActor = object(current.coordinator, "当前协调者").thread_id;
    if (actor !== (currentActor ?? object(desired.coordinator, "协调者").thread_id)) throw new Error("非当前协调者声明，拒绝更新");
    if (object(desired.coordinator, "协调者").thread_id !== actor) throw new Error("不能隐含转移控制面维护者");
    const file = path.join(dir, "events.jsonl");
    const events = await readEvents(file);
    verifyChain(events);
    const inputEvent = request.event === undefined ? null : object(request.event, "事件输入");
    if (inputEvent) for (const key of Object.keys(inputEvent)) if (!EVENT_KEYS.has(key)) throw new Error(`事件禁止内部字段：${key}`);
    const requestHash = digest(request);
    const existing = inputEvent && events.find(event => event.id === inputEvent.id);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new Error("同事件ID的请求不同，拒绝重试");
      if (existing.terminal) await saveTerminal(path.join(dir, "terminal.json"), object(existing.terminal, "收口快照"));
      if (digest(current) === existing.state_before_hash) {
        await atomicJson(currentFile, existing.state_after);
        return { status: "recovered", revision: object(existing.state_after, "事件状态").revision, event_id: existing.id };
      }
      const latest = events.at(-1)!;
      if (digest(actionState(current)) === latest.action_after_hash
        && Number(current.revision) >= Number(object(latest.state_after, "事件状态").revision)) {
        return { status: "deduplicated", revision: current.revision, event_id: existing.id };
      }
      throw new Error("事件已落盘但状态不一致，先恢复现场");
    }
    if (request.expected_revision !== current.revision) throw new Error("预期revision过期");
    const latest = events.at(-1);
    if (latest && (Number(object(latest.state_after, "事件状态").revision) > Number(current.revision)
      || digest(actionState(current)) !== digest(actionState(object(latest.state_after, "事件状态"))))) {
      throw new Error("有未完成或无事件状态更新，先按原事件恢复");
    }
    const now = new Date().toISOString();
    const next: ObjectValue = { ...desired, revision: Number(current.revision) + 1, updated_at: now };
    if (!inputEvent) {
      if (close || digest(actionState(current)) !== digest(actionState(next))) throw new Error("行动状态变化必须提供事件");
      await atomicJson(currentFile, next);
      return { status: "wording_only", revision: next.revision };
    }
    const id = text(inputEvent.id, "事件ID");
    if (!id.startsWith(`${version}-`) || !/^[A-Za-z0-9._-]+$/u.test(id)) throw new Error("事件ID须以本版本为前缀且不可含路径");
    text(inputEvent.type, "事件类型"); text(inputEvent.reason, "事件原因");
    if (!["plan", "decision", "result"].includes(String(inputEvent.phase))) throw new Error("区分计划、决定与实际结果");
    if (close && (inputEvent.phase !== "result" || inputEvent.type !== "iteration_closed")) throw new Error("收口必须为实际收口结果事件");
    if (inputEvent.occurred_at !== undefined && !Number.isFinite(Date.parse(String(inputEvent.occurred_at)))) throw new Error("事件发生时间无效");
    if (!Array.isArray(inputEvent.evidence) || !inputEvent.evidence.length || inputEvent.evidence.some(item => typeof item !== "string" || !item.trim())) {
      throw new Error("事件缺证据引用");
    }
    const terminal = close ? closureSnapshot(request, current, events, now) : null;
    if (close && (next.iteration !== null || next.scope !== null || next.candidate !== null || (next.active_tasks as unknown[]).length)) {
      throw new Error("收口后当前状态须清空旧范围、候选、活动任务和迭代");
    }
    const event = {
      ...inputEvent, iteration_id: version, recorded_at: now, occurred_at: inputEvent.occurred_at ?? now,
      actor, request_hash: requestHash, state_before_hash: digest(current), state_before_revision: current.revision,
      action_before_hash: digest(actionState(current)), action_after_hash: digest(actionState(next)),
      state_after_hash: digest(next), state_after: next,
      ...(terminal ? { terminal } : {})
    };
    // 事件失败不得推进状态；事件成功而状态失败，使用同ID请求重放此已持久化结果。
    await appendEvent(file, event);
    if (terminal) await saveTerminal(path.join(dir, "terminal.json"), terminal);
    await atomicJson(currentFile, next);
    return { status: close ? "closed" : "updated", revision: next.revision, event_id: id };
  } finally {
    await lock.close();
    await fs.unlink(lockFile);
  }
}

async function audit(root: string): Promise<ObjectValue> {
  const current = await readJson(path.join(root, CURRENT)); validateState(current, root);
  if (current.iteration === null) return { status: "IDLE", revision: current.revision };
  const version = versionName(object(current.iteration, "当前迭代").id);
  const events = await readEvents(path.join(directory(root, version), "events.jsonl"));
  verifyChain(events);
  if (!events.length) throw new Error("当前迭代没有事件");
  const last = events.at(-1)!;
  if (Number(object(last.state_after, "事件状态").revision) > Number(current.revision)) throw new Error("事件已落盘，当前状态更新未完成");
  if (digest(actionState(current)) !== digest(actionState(object(last.state_after, "事件状态")))) {
    throw new Error("当前状态与最新事件不一致");
  }
  return { status: "PASS", revision: current.revision, events: events.length, limitation: "只核对结构与持久化一致性，不证明证据真实或全部语义覆盖" };
}

async function selfTest(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "control-plane-update-"));
  try {
    await fs.mkdir(path.join(root, "reports"));
    const state: ObjectValue = {
      schema_version: 3, revision: 1, canonical_path: path.join(root, CURRENT), coordinator: { thread_id: "coordinator" },
      iteration: { id: "fixture" }, scope: {}, active_tasks: [], candidate: null, blockers: [], evidence: [],
      records: { events: "reports/iterations/fixture/events.jsonl", terminal: "reports/iterations/fixture/terminal.json" }
    };
    await atomicJson(path.join(root, CURRENT), state);
    const request = { actor: "coordinator", expected_revision: 1, iteration_id: "fixture", state: { ...state, scope: { changed: true } },
      event: { id: "fixture-one", type: "scope_changed", phase: "decision", reason: "夹具验证", evidence: ["fixture"] } };
    await assert.rejects(update(root, { ...request, event: undefined }), /必须提供事件/u);
    await assert.rejects(update(root, { ...request, event: { ...request.event, terminal: {} } }), /禁止内部字段/u);
    await update(root, request);
    const eventsFile = path.join(directory(root, "fixture"), "events.jsonl");
    assert.equal((await readEvents(eventsFile)).length, 1);
    assert.equal((await update(root, request)).status, "deduplicated");
    const goodCurrent = await readJson(path.join(root, CURRENT));
    await atomicJson(path.join(root, CURRENT), { ...goodCurrent, revision: 99, scope: { fork: true } });
    await assert.rejects(update(root, request), /状态不一致/u);
    await atomicJson(path.join(root, CURRENT), goodCurrent);
    await assert.rejects(update(root, { ...request, event: { ...request.event, reason: "不同请求" } }), /请求不同/u);
    // 模拟事件成功、状态尚未保存的崩溃窗口；重放不增加事件。
    await atomicJson(path.join(root, CURRENT), state);
    assert.equal((await update(root, request)).status, "recovered");
    assert.equal((await readEvents(eventsFile)).length, 1);
    const current = await readJson(path.join(root, CURRENT));
    const closedState = { ...current, iteration: null, scope: null, candidate: null, active_tasks: [], records: { events: null, terminal: null } };
    const closeRequest = { actor: "coordinator", expected_revision: 2, iteration_id: "fixture", state: closedState,
      event: { id: "fixture-close", type: "iteration_closed", phase: "result", reason: "夹具完成", evidence: ["fixture"] },
      closure: { status: "cancelled", result: "夹具取消", checks: {} } };
    await assert.rejects(update(root, closeRequest, true), /须为对象/u);
    closeRequest.closure.checks = Object.fromEntries(CHECKS.map(key => [key, { status: "not_applicable", reason: "隔离夹具", evidence: [], event_ids: [] }]));
    await update(root, closeRequest, true);
    assert.equal((await update(root, closeRequest, true)).status, "deduplicated");
    assert.equal((await readEvents(eventsFile)).length, 2);
    assert.equal((await fs.stat(path.join(directory(root, "fixture"), "terminal.json"))).mode & 0o222, 0);
    console.log("更新入口夹具通过：必需事件、先事件后状态、去重、中断恢复、收口核对与只读快照。");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

const [command, flag, file] = process.argv.slice(2);
if (command === "self-test") await selfTest();
else {
  const root = process.cwd();
  if (command === "audit") console.log(JSON.stringify(await audit(root)));
  else if (["apply", "close"].includes(command) && flag === "--input" && file) {
    console.log(JSON.stringify(await update(root, await readJson(path.resolve(file)), command === "close")));
  } else throw new Error("使用apply/close --input JSON文件、audit或self-test");
}
