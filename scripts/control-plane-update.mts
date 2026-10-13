/**
 * 协调控制面的事件优先更新、收口与未收口版本衔接入口。
 * 建立时间：2026-10-13
 * 状态：active
 * 边界：协调者单写；跨版本交接保留来源事件哈希与待处理状态引用，不代替人工发布授权。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { CONTROL_EVENT_FORMAT, stateChanges, replayChanges, materializeEvent } from "./control-plane-replay.mjs";

type ObjectValue = Record<string, unknown>;
const CURRENT = "reports/requirement-coordination-current.json";
const KEYS = new Set([
  "schema_version", "revision", "updated_at", "canonical_path", "coordinator", "rule_baseline",
  "work_mode", "iteration", "scope", "active_tasks", "candidate", "authorization", "blockers",
  "next_action", "evidence", "records", "runtime", "display_summary", "held_iterations"
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
  if (state.held_iterations !== undefined && !Array.isArray(state.held_iterations)) throw new Error("held_iterations须为引用数组");
  const held = (state.held_iterations ?? []) as unknown[];
  const heldKeys = new Set<string>();
  for (const value of held) {
    const reference = object(value, "未收口版本引用");
    const sourceVersion = versionName(reference.iteration_id);
    text(reference.event_id, "未收口版本事件ID");
    text(reference.status, "未收口版本状态");
    if (!/^reports\/iterations\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/events\.jsonl$/u.test(String(reference.events))) {
      throw new Error("未收口版本事件路径不一致");
    }
    if (!/^[a-f0-9]{64}$/u.test(String(reference.state_after_hash))) throw new Error("未收口版本状态摘要无效");
    if (!Object.hasOwn(reference, "candidate_sha")
      || (reference.candidate_sha !== null && !/^[a-f0-9]{40}$/u.test(String(reference.candidate_sha)))) {
      throw new Error("未收口版本候选SHA无效");
    }
    if (!/^[a-f0-9]{64}$/u.test(String(reference.authorization_sha256))) throw new Error("未收口版本授权摘要无效");
    const key = `${sourceVersion}:${reference.event_id}`;
    if (heldKeys.has(key)) throw new Error("未收口版本引用重复");
    heldKeys.add(key);
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
function verifyChain(events: ObjectValue[], anchor: ObjectValue | null = null): void {
  let base = anchor ? object(anchor.state_after, "交接锚点状态") : null;
  for (const [index, event] of events.entries()) {
    let after: ObjectValue;
    const checkpoint = event.event_format === CONTROL_EVENT_FORMAT && event.type === "control_checkpoint";
    if (event.event_format === undefined) after = object(event.state_after, "事件状态");
    else if (event.event_format === CONTROL_EVENT_FORMAT) {
      const allowed = new Set(["event_format", "id", "iteration_id", "type", "phase", "reason", "evidence", "details",
        "recorded_at", "occurred_at", "actor", "request_hash", "state_before_revision", "state_before_hash",
        "action_before_hash", "action_after_hash", "state_after_hash", "changes", "checkpoint_state", "trigger_event_id",
        "chain_anchor", "terminal"]);
      if (Object.keys(event).some(key => !allowed.has(key)) || !["plan", "decision", "result"].includes(String(event.phase))) {
        throw new Error("新事件字段或阶段无效");
      }
      if (Object.prototype.propertyIsEnumerable.call(event, "state_after")) throw new Error("新事件禁止全量state_after");
      if (checkpoint) {
        after = object(event.checkpoint_state, "恢复检查点状态");
        if (event.phase !== "result" || event.changes !== undefined || event.terminal !== undefined
          || event.state_before_hash !== digest(after) || event.action_before_hash !== digest(actionState(after))
          || Number(event.state_before_revision) !== Number(after.revision)
          || !String(event.trigger_event_id).startsWith(`${event.iteration_id}-`)) throw new Error("恢复检查点契约无效");
        if (base && digest(base) === digest(after)) throw new Error("无需重复完整恢复检查点");
      } else {
        if (event.checkpoint_state !== undefined || !base) throw new Error("差量事件缺少合法回放基线");
        if (digest(base) !== event.state_before_hash || Number(base.revision) !== Number(event.state_before_revision)) {
          throw new Error("差量事件前状态摘要不一致");
        }
        after = replayChanges(base, event.changes);
      }
      materializeEvent(event, after);
    } else throw new Error("未知事件格式");
    if (digest(after) !== event.state_after_hash || digest(actionState(after)) !== event.action_after_hash
      || Number(after.revision) !== Number(event.state_before_revision) + (checkpoint ? 0 : 1)) throw new Error("事件状态摘要或修订损坏");
    const previous = events[index - 1];
    if (previous && (event.action_before_hash !== previous.action_after_hash
      || Number(event.state_before_revision) < Number(object(previous.state_after, "前一事件状态").revision))) {
      throw new Error("事件链分叉，先恢复现场");
    }
    if (index === 0 && anchor) {
      const anchorRevision = Number(object(anchor.state_after, "交接锚点状态").revision);
      if (event.action_before_hash !== anchor.action_after_hash
        || Number(event.state_before_revision) < anchorRevision
        || (Number(event.state_before_revision) === anchorRevision && event.state_before_hash !== anchor.state_after_hash)) {
        throw new Error("跨版本事件锚点不一致，先恢复现场");
      }
    }
    base = after;
    if (event.terminal && (event.type !== "iteration_closed" || event.phase !== "result")) throw new Error("非收口事件不能创建快照");
    if (["iteration_handoff", "held_iteration_restored"].includes(String(event.type))) {
      const details = object(event.details, "版本交接详情");
      const targetVersion = versionName(details.target_iteration_id);
      const sourceVersion = versionName(event.iteration_id);
      if (event.phase !== "decision" || !String(event.id).startsWith(`${sourceVersion}-`)
        || object(after.iteration, "交接目标迭代").id !== targetVersion
        || object(object(after.iteration, "交接目标迭代").started_by, "交接来源").event_id !== event.id
        || (event.type === "iteration_handoff" && object(object(after.iteration, "交接目标迭代").started_by, "交接来源").iteration_id !== sourceVersion)) {
        throw new Error("版本转移事件与目标控制面不一致");
      }
    }
  }
}

async function eventFileAnchor(root: string, version: string, events: ObjectValue[], seen = new Set<string>()): Promise<ObjectValue | null> {
  if (!events.length) return null;
  if (events[0].iteration_id !== version) throw new Error("事件文件首事件版本不一致");
  if (events[0].chain_anchor !== undefined) {
    const marker = object(events[0].chain_anchor, "首事件恢复锚点");
    return iterationAnchor(root, { id: version, started_by: { iteration_id: marker.iteration_id, event_id: marker.event_id } }, seen);
  }
  const firstState = object(events[0].event_format === CONTROL_EVENT_FORMAT ? events[0].checkpoint_state : events[0].state_after, "版本首事件状态");
  if (firstState.iteration === null) return null;
  const iteration = object(firstState.iteration, "版本首事件迭代");
  if (iteration.id !== version) return null;
  return await iterationAnchor(root, iteration, seen);
}

async function iterationAnchor(root: string, iteration: ObjectValue, seen = new Set<string>()): Promise<ObjectValue | null> {
  if (iteration.started_by === undefined) return null;
  const startedBy = object(iteration.started_by, "版本交接来源");
  const sourceVersion = versionName(startedBy.iteration_id);
  const targetVersion = versionName(iteration.id);
  const eventId = text(startedBy.event_id, "版本交接事件ID");
  const key = `${sourceVersion}:${eventId}`;
  if (seen.has(key)) throw new Error("版本交接锚点循环");
  const nextSeen = new Set(seen).add(key);
  const sourceEvents = await readEvents(path.join(directory(root, sourceVersion), "events.jsonl"));
  const eventIndex = sourceEvents.findIndex(event => event.id === eventId);
  if (eventIndex < 0) throw new Error("版本转移来源事件缺失");
  const prefix = sourceEvents.slice(0, eventIndex + 1);
  await verifyVersionEvents(root, sourceVersion, prefix, nextSeen);
  const anchor = prefix.at(-1)!;
  if (anchor.iteration_id !== sourceVersion
    || !["iteration_handoff", "held_iteration_restored"].includes(String(anchor.type))
    || object(anchor.details, "版本转移详情").target_iteration_id !== targetVersion
    || digest(object(anchor.state_after, "交接状态")) !== anchor.state_after_hash) {
    throw new Error("版本转移来源事件摘要或目标不一致");
  }
  return anchor;
}

async function verifyVersionEvents(root: string, version: string, events: ObjectValue[], seen = new Set<string>()): Promise<void> {
  if (!events.length) return;
  const initialAnchor = await eventFileAnchor(root, version, events, seen);
  let segment: ObjectValue[] = [];
  let anchor = initialAnchor;
  for (const event of events) {
    if (event.chain_anchor !== undefined) {
      if (segment.length) verifyChain(segment, anchor);
      const marker = object(event.chain_anchor, "事件段锚点");
      const targetVersion = versionName(marker.iteration_id);
      const targetEventId = text(marker.event_id, "事件段锚点ID");
      const targetEvents = await readEvents(path.join(directory(root, targetVersion), "events.jsonl"));
      const targetEventIndex = targetEvents.findIndex(row => row.id === targetEventId);
      if (targetEventIndex < 0) throw new Error("事件段锚点引用缺失");
      anchor = await iterationAnchor(root, {
        id: version,
        started_by: { iteration_id: targetVersion, event_id: targetEventId }
      }, seen);
      segment = [];
    }
    segment.push(event);
  }
  verifyChain(segment, anchor);
}

async function verifyHeldIterations(root: string, state: ObjectValue): Promise<void> {
  for (const value of (state.held_iterations ?? []) as unknown[]) {
    const reference = object(value, "未收口版本引用");
    const version = versionName(reference.iteration_id);
    const expectedPath = String(reference.events);
    const ownerMatch = /^reports\/iterations\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})\/events\.jsonl$/u.exec(expectedPath);
    if (!ownerMatch) throw new Error("未收口版本事件路径无效");
    const eventOwner = versionName(ownerMatch[1]);
    const events = await readEvents(path.join(directory(root, eventOwner), "events.jsonl"));
    const eventIndex = events.findIndex(row => row.id === reference.event_id);
    if (eventIndex < 0) throw new Error("未收口版本引用事件缺失");
    await verifyVersionEvents(root, eventOwner, events.slice(0, eventIndex + 1));
    const event = events[eventIndex];
    const following = events[eventIndex + 1];
    const heldState = object(event.state_after, "未收口版本完整状态");
    const isDirectSnapshot = event.iteration_id === version && heldState.iteration !== null
      && object(heldState.iteration, "未收口版本迭代").id === version
      && event.state_after_hash === reference.state_after_hash
      && following !== undefined && ["iteration_handoff", "held_iteration_restored"].includes(String(following.type))
      && following.state_before_hash === reference.state_after_hash;
    let isTransitionAnchorSnapshot = event.iteration_id === eventOwner
      && heldState.iteration !== null && object(heldState.iteration, "锚点保存状态").id === version
      && event.state_after_hash === reference.state_after_hash;
    if (isTransitionAnchorSnapshot) {
      const targetEvents = await readEvents(path.join(directory(root, version), "events.jsonl"));
      await verifyVersionEvents(root, version, targetEvents);
      isTransitionAnchorSnapshot = targetEvents.some(row => row.type === "held_iteration_restored"
        && row.state_before_hash === reference.state_after_hash
        && row.chain_anchor !== undefined
        && object(row.chain_anchor, "恢复锚点").iteration_id === eventOwner
        && object(row.chain_anchor, "恢复锚点").event_id === event.id);
    }
    if (!isDirectSnapshot && !isTransitionAnchorSnapshot) throw new Error("未收口版本引用未由不可变状态事件或转移锚定");
    if (object(heldState.iteration, "未收口版本迭代").id !== version
      || object(heldState.iteration, "未收口版本迭代").status !== reference.status
      || (heldState.candidate === null ? reference.candidate_sha !== null
        : object(heldState.candidate, "未收口版本候选").sha !== reference.candidate_sha)
      || digest(heldState.authorization) !== reference.authorization_sha256) {
      throw new Error("未收口版本候选或授权与事件引用不一致");
    }
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
  delete archived.display_summary;
  archived.revision = Number(current.revision) + 1;
  archived.updated_at = now;
  archived.iteration = { ...object(current.iteration, "收口迭代"), status: closure.status };
  if (closure.status === "completed" && (current.active_tasks as unknown[]).length) throw new Error("仍有活动任务，不能记为版本完成");
  return { schema_version: 1, closed_at: now, control_plane: archived, result: closure };
}

/** 只在缺少精确回放基线时保存恢复检查点；它不推进控制面修订。 */
async function ensureCheckpoint(file: string, current: ObjectValue, baseline: ObjectValue | null,
  version: string, eventId: string, requestHash: string, now: string, chainAnchor?: ObjectValue): Promise<boolean> {
  if (baseline && digest(baseline) === digest(current)) return false;
  const checkpoint = {
    event_format: CONTROL_EVENT_FORMAT, id: `${version}-checkpoint-${eventId}`, iteration_id: version,
    type: "control_checkpoint", phase: "result", recorded_at: now, occurred_at: now,
    reason: baseline ? "历史无事件元数据修订的精确恢复基线" : "首个差量事件的必要恢复基线",
    evidence: ["control-plane:replay-baseline"], trigger_event_id: eventId, request_hash: requestHash,
    state_before_revision: current.revision, state_before_hash: digest(current),
    action_before_hash: digest(actionState(current)), action_after_hash: digest(actionState(current)),
    state_after_hash: digest(current), checkpoint_state: current,
    ...(chainAnchor ? { chain_anchor: chainAnchor } : {})
  };
  await appendEvent(file, checkpoint);
  return true;
}

function eventInput(input: ObjectValue): ObjectValue {
  const { id, type, phase, reason, evidence, occurred_at } = input;
  const details = ["iteration_handoff", "held_iteration_restored"].includes(String(type))
    ? object(input.details, "版本转移详情") : null;
  return { id, type, phase, reason, evidence, ...(occurred_at !== undefined ? { occurred_at } : {}),
    ...(details ? { details: Object.fromEntries(Object.entries(details).filter(([key]) =>
      ["target_iteration_id", "held_event_id", "held_state_after_hash"].includes(key))) } : {}) };
}
/** 协调者声明身份、预期修订与完整状态一起提交；先持久化事件，再替换当前状态。 */
async function update(root: string, request: ObjectValue, mode: "apply" | "close" | "handoff" = "apply"): Promise<ObjectValue> {
  const close = mode === "close";
  const requestedVersion = versionName(request.iteration_id);
  const sourceVersion = mode === "handoff" ? versionName(request.from_iteration_id) : requestedVersion;
  const lockFile = path.join(root, "reports/iterations/.control-plane.lock");
  const lock = await fs.open(lockFile, "wx", 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const currentFile = path.join(root, CURRENT);
    const current = await readJson(currentFile);
    if (!Number.isInteger(current.revision) || Number(current.revision) < 0) throw new Error("当前revision无效");
    if (current.schema_version === 3) validateState(current, root);
    else if (![1, 2].includes(Number(current.schema_version))
      || object(request.event, "迁移事件").type !== "control_migrated") throw new Error("旧状态只能经明确迁移事件升级");
    const currentIteration = current.iteration === null ? null : object(current.iteration, "当前迭代");
    if (mode === "handoff") {
      const retryEventId = request.event && object(request.event, "交接重试事件").id;
      const startedBy = currentIteration?.started_by === undefined ? null : object(currentIteration.started_by, "当前版本交接来源");
      const retryingCommittedHandoff = currentIteration?.id === requestedVersion
        && startedBy?.iteration_id === sourceVersion && startedBy.event_id === retryEventId;
      if (!retryingCommittedHandoff && (!currentIteration || currentIteration.id !== sourceVersion)) {
        throw new Error("版本交接来源不是当前活动迭代");
      }
      if (sourceVersion === requestedVersion) throw new Error("版本交接目标必须是新版本");
    } else if (currentIteration && currentIteration.id !== requestedVersion) {
      throw new Error("先收口当前版本，不能覆盖活动迭代");
    }
    const desired = { ...object(request.state, "新当前状态") };
    delete desired.display_summary;
    validateState(desired, root);
    if (!close && object(desired.iteration, "目标迭代").id !== requestedVersion) throw new Error("更新版本不一致");
    if (mode !== "handoff" && canonical(desired.held_iterations ?? []) !== canonical(current.held_iterations ?? [])) {
      throw new Error("当前更新不能丢弃或改写未收口版本引用");
    }
    const actor = text(request.actor, "协调者");
    const currentActor = object(current.coordinator, "当前协调者").thread_id;
    if (actor !== (currentActor ?? object(desired.coordinator, "协调者").thread_id)) throw new Error("非当前协调者声明，拒绝更新");
    if (object(desired.coordinator, "协调者").thread_id !== actor) throw new Error("不能隐含转移控制面维护者");
    const version = mode === "handoff" ? sourceVersion : requestedVersion;
    const dir = directory(root, version);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "events.jsonl");
    const events = await readEvents(file);
    await verifyVersionEvents(root, version, events);
    const activeAnchor = currentIteration ? await iterationAnchor(root, currentIteration) : null;
    await verifyHeldIterations(root, current);
    const inputEvent = request.event === undefined ? null : object(request.event, "事件输入");
    if (inputEvent) for (const key of Object.keys(inputEvent)) if (!EVENT_KEYS.has(key)) throw new Error(`事件禁止内部字段：${key}`);
    if (inputEvent?.type === "control_checkpoint") throw new Error("control_checkpoint是入口保留类型");
    if (mode === "handoff" && (!inputEvent || inputEvent.type !== "iteration_handoff" || inputEvent.phase !== "decision")) {
      throw new Error("版本交接须使用decision阶段的iteration_handoff事件");
    }
    if (mode !== "handoff" && inputEvent?.type === "iteration_handoff") throw new Error("版本交接必须使用handoff动作");
    const requestHash = digest(request);
    const existing = inputEvent && events.find(event => event.id === inputEvent.id);
    const pendingCheckpoint = inputEvent && events.find(event => event.trigger_event_id === inputEvent.id);
    if (pendingCheckpoint && pendingCheckpoint.request_hash !== requestHash) throw new Error("同事件ID的请求不同，拒绝重试");
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
    const matchesLatest = latest && Number(object(latest.state_after, "事件状态").revision) <= Number(current.revision)
      && digest(actionState(current)) === digest(actionState(object(latest.state_after, "事件状态")));
    const matchesActiveAnchor = activeAnchor && digest(actionState(current)) === activeAnchor.action_after_hash
      && Number(current.revision) >= Number(object(activeAnchor.state_after, "跨版本锚点").revision);
    if (!matchesLatest && !matchesActiveAnchor && (latest || activeAnchor)) {
      throw new Error("当前状态与最新事件或恢复锚点不一致，先按原事件恢复");
    }
    if (mode === "handoff") {
      const sourceIteration = object(current.iteration, "交接来源迭代");
      const candidate = object(current.candidate, "待发布候选");
      const gates = object(candidate.quality_gate, "候选验证门");
      const requiredGates = candidate.required_gates;
      const matrixReference = text(candidate.test_matrix_ref, "候选测试矩阵引用");
      if (!Array.isArray(requiredGates) || !requiredGates.length
        || new Set(requiredGates).size !== requiredGates.length
        || requiredGates.some(gate => typeof gate !== "string" || !/^[a-z][a-z0-9_]*$/u.test(gate))
        || !matrixReference.startsWith("knowledge/test-impact-matrix.md")) {
        throw new Error("候选须冻结唯一必需门清单及测试影响矩阵引用");
      }
      if (sourceIteration.status !== "READY_WAIT_OWNER" || candidate.release_frozen !== true
        || candidate.status !== "READY_FOR_RELEASE_WAIT_OWNER"
        || !/^[a-f0-9]{40}$/u.test(String(candidate.sha))
        || !/^[a-f0-9]{40}$/u.test(String(candidate.tree))
        || requiredGates.some(key => gates[key] !== "PASS")) {
        throw new Error("只能从候选已声明的必需验证门全部通过、且等待Owner信号的冻结版本启动交接");
      }
      if ((current.active_tasks as unknown[]).length) throw new Error("仍有在途实施任务，不能交接版本");
      if (!latest || latest.state_after_hash !== digest(current)) throw new Error("来源完整状态未由最新版本事件保存，不能交接");
      if (object(desired.iteration, "目标迭代").id !== requestedVersion || desired.candidate !== null
        || (desired.active_tasks as unknown[]).length) throw new Error("新版本交接状态必须指定目标迭代、空候选且无活动任务");
      if (object(inputEvent!.details, "版本交接详情").target_iteration_id !== requestedVersion) throw new Error("交接事件未指向请求目标版本");
      if (inputEvent!.id && !String(inputEvent!.id).startsWith(`${sourceVersion}-`)) throw new Error("交接事件ID须属于来源版本");
      if (desired.held_iterations !== undefined
        && canonical(desired.held_iterations) !== canonical(current.held_iterations ?? [])) {
        throw new Error("目标状态不能丢弃或改写既有未收口版本引用");
      }
      if (object(desired.iteration, "目标迭代").started_by !== undefined) throw new Error("目标交接来源只能由入口生成");
      const targetDir = directory(root, requestedVersion);
      await fs.mkdir(targetDir, { recursive: true });
      const targetEvents = await readEvents(path.join(targetDir, "events.jsonl"));
      if (targetEvents.length) throw new Error("目标版本已有事件，拒绝覆盖或复用版本");
      try {
        await fs.access(path.join(targetDir, "terminal.json"));
        throw new Error("目标版本已有收口快照，拒绝复用版本");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const now = new Date().toISOString();
    let target = desired;
    if (mode === "handoff") {
      const heldReference = {
        iteration_id: sourceVersion,
        events: `reports/iterations/${sourceVersion}/events.jsonl`,
        event_id: latest!.id,
        state_after_hash: latest!.state_after_hash,
        status: object(current.iteration, "交接来源迭代").status,
        candidate_sha: object(current.candidate, "待发布候选").sha,
        authorization_sha256: digest(object(current.authorization, "交接来源授权"))
      };
      target = {
        ...desired,
        held_iterations: [...((current.held_iterations ?? []) as unknown[]), heldReference],
        iteration: { ...object(desired.iteration, "目标迭代"), started_by: { iteration_id: sourceVersion, event_id: inputEvent!.id } }
      };
      validateState(target, root);
    }
    const next: ObjectValue = { ...target, revision: Number(current.revision) + 1, updated_at: now };
    if (!inputEvent) {
      if (close || digest(actionState(current)) !== digest(actionState(next))) throw new Error("行动状态变化必须提供事件");
      return { status: "unchanged", revision: current.revision };
    }
    const id = text(inputEvent.id, "事件ID");
    if (!id.startsWith(`${version}-`) || !/^[A-Za-z0-9._-]+$/u.test(id)) throw new Error("事件ID须以所属版本为前缀且不可含路径");
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
    const chainAnchor = !matchesLatest && activeAnchor ? {
      iteration_id: object(currentIteration!.started_by, "版本转移来源").iteration_id,
      event_id: object(currentIteration!.started_by, "版本转移来源").event_id
    } : undefined;
    const changes = stateChanges(current, next);
    if (digest(replayChanges(current, changes)) !== digest(next)) throw new Error("差量不能精确恢复新状态");
    const checkpointWritten = await ensureCheckpoint(file, current,
      matchesLatest ? object(latest!.state_after, "最新回放状态") : activeAnchor ? object(activeAnchor.state_after, "回放锚点") : null,
      version, id, requestHash, now, chainAnchor);
    const event = {
      ...eventInput(inputEvent), event_format: CONTROL_EVENT_FORMAT, iteration_id: version, recorded_at: now, occurred_at: inputEvent.occurred_at ?? now,
      actor, request_hash: requestHash, state_before_hash: digest(current), state_before_revision: current.revision,
      action_before_hash: digest(actionState(current)), action_after_hash: digest(actionState(next)),
      state_after_hash: digest(next), changes,
      ...(!checkpointWritten && chainAnchor ? { chain_anchor: chainAnchor } : {}),
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

/** 从不可变的未收口事件恢复版本状态；始终保留最新全局规则和运行观测。 */
async function restoreHeld(root: string, request: ObjectValue): Promise<ObjectValue> {
  const sourceVersion = versionName(request.from_iteration_id);
  const targetVersion = versionName(request.iteration_id);
  const lockFile = path.join(root, "reports/iterations/.control-plane.lock");
  const lock = await fs.open(lockFile, "wx", 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const currentFile = path.join(root, CURRENT);
    const current = await readJson(currentFile);
    validateState(current, root);
    if (!Number.isInteger(current.revision) || Number(current.revision) < 0) throw new Error("当前revision无效");
    const currentIteration = current.iteration === null ? null : object(current.iteration, "当前迭代");
    const requestedEventId = request.event && object(request.event, "恢复事件").id;
    const restoredRetry = currentIteration?.id === targetVersion
      && currentIteration.started_by !== undefined
      && object(currentIteration.started_by, "当前恢复来源").iteration_id === sourceVersion
      && object(currentIteration.started_by, "当前恢复来源").event_id === requestedEventId;
    if (currentIteration && currentIteration.id !== sourceVersion && !restoredRetry) throw new Error("恢复来源不是当前活动版本");
    if (!currentIteration && (current.records as ObjectValue).events !== null) throw new Error("无活动版本时记录入口须清空");
    if ((current.active_tasks as unknown[]).length) throw new Error("仍有活动任务，不能恢复未收口版本");
    const actor = text(request.actor, "协调者");
    if (actor !== object(current.coordinator, "当前协调者").thread_id) throw new Error("非当前协调者声明，拒绝恢复");
    const inputEvent = object(request.event, "恢复事件");
    for (const key of Object.keys(inputEvent)) if (!EVENT_KEYS.has(key)) throw new Error(`事件禁止内部字段：${key}`);
    if (inputEvent.type !== "held_iteration_restored" || inputEvent.phase !== "decision") {
      throw new Error("恢复必须使用decision阶段的held_iteration_restored事件");
    }
    const requestHash = digest(request);
    const dir = directory(root, sourceVersion);
    const file = path.join(dir, "events.jsonl");
    const events = await readEvents(file);
    await verifyVersionEvents(root, sourceVersion, events);
    const eventId = text(inputEvent.id, "事件ID");
    const existing = events.find(event => event.id === eventId);
    const pendingCheckpoint = events.find(event => event.trigger_event_id === eventId);
    if (pendingCheckpoint && pendingCheckpoint.request_hash !== requestHash) throw new Error("同事件ID的请求不同，拒绝重试");
    if (existing) {
      if (existing.request_hash !== requestHash) throw new Error("同事件ID的请求不同，拒绝重试");
      if (digest(current) === existing.state_before_hash) {
        await atomicJson(currentFile, existing.state_after);
        return { status: "recovered", revision: object(existing.state_after, "恢复状态").revision, event_id: eventId };
      }
      if (digest(actionState(current)) === existing.action_after_hash) {
        return { status: "deduplicated", revision: current.revision, event_id: eventId };
      }
      throw new Error("恢复事件已落盘但当前状态不一致");
    }
    const details = object(inputEvent.details, "恢复详情");
    if (details.target_iteration_id !== targetVersion) throw new Error("恢复事件未指向请求目标版本");
    if (!eventId.startsWith(`${sourceVersion}-`) || !/^[A-Za-z0-9._-]+$/u.test(eventId)) throw new Error("恢复事件ID须以来源版本为前缀");
    text(inputEvent.reason, "恢复原因");
    if (!Array.isArray(inputEvent.evidence) || !inputEvent.evidence.length) throw new Error("恢复事件缺少Owner信号或当前授权证据引用");
    const references = (current.held_iterations ?? []) as unknown[];
    const reference = references.map(value => object(value, "未收口版本引用"))
      .find(value => value.iteration_id === targetVersion && value.event_id === details.held_event_id);
    if (!reference) throw new Error("目标版本不在当前未收口版本引用中");
    await verifyHeldIterations(root, current);
    const heldOwner = /^reports\/iterations\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})\/events\.jsonl$/u.exec(String(reference.events))![1];
    const heldEvents = await readEvents(path.join(directory(root, versionName(heldOwner)), "events.jsonl"));
    await verifyVersionEvents(root, versionName(heldOwner), heldEvents);
    const heldEvent = heldEvents.find(event => event.id === reference.event_id)!;
    const heldState = object(heldEvent.state_after, "未收口版本完整状态");
    if (details.held_state_after_hash !== reference.state_after_hash
      || heldEvent.state_after_hash !== reference.state_after_hash) throw new Error("恢复事件引用的未收口状态摘要不一致");
    const heldAuth = heldState.authorization;
    const currentAuth = current.authorization;
    if (heldAuth !== null && object(heldAuth, "未收口版本授权").execution_enabled === true
      && digest(heldAuth) !== digest(currentAuth)) throw new Error("历史版本授权已不在当前授权中，恢复不得重新授予权限");

    await verifyVersionEvents(root, sourceVersion, events);
    if (request.expected_revision !== current.revision) throw new Error("预期revision过期");
    let outgoingSnapshot: ObjectValue | null = null;
    if (currentIteration) {
      const latest = events.at(-1);
      const sameBranch = latest && digest(actionState(current)) === digest(actionState(object(latest.state_after, "最新事件状态")));
      if (sameBranch) outgoingSnapshot = latest;
      else {
        const activeAnchor = await iterationAnchor(root, currentIteration);
        if (!activeAnchor || digest(actionState(current)) !== activeAnchor.action_after_hash) {
          throw new Error("恢复来源当前状态与事件链不一致");
        }
        outgoingSnapshot = activeAnchor;
      }
    }
    const now = new Date().toISOString();
    const priorHeld = references.filter(value => value !== reference);
    let next: ObjectValue = {
      ...heldState,
      schema_version: current.schema_version,
      canonical_path: current.canonical_path,
      coordinator: current.coordinator,
      ...(Object.hasOwn(current, "rule_baseline") ? { rule_baseline: current.rule_baseline } : {}),
      ...(Object.hasOwn(current, "work_mode") ? { work_mode: current.work_mode } : {}),
      ...(Object.hasOwn(current, "runtime") ? { runtime: current.runtime } : {}),
      iteration: {
        ...object(heldState.iteration, "恢复目标迭代"),
        started_by: { iteration_id: sourceVersion, event_id: eventId }
      },
      records: { events: `reports/iterations/${targetVersion}/events.jsonl`, terminal: `reports/iterations/${targetVersion}/terminal.json` },
      held_iterations: priorHeld,
      revision: Number(current.revision) + 1,
      updated_at: now
    };
    if (currentIteration) {
      const snapshotEvent = outgoingSnapshot!;
      const outgoing = {
        iteration_id: sourceVersion,
        events: `reports/iterations/${snapshotEvent.iteration_id}/events.jsonl`,
        event_id: snapshotEvent.id,
        state_after_hash: snapshotEvent.state_after_hash,
        status: currentIteration.status,
        candidate_sha: current.candidate === null ? null : object(current.candidate, "当前候选").sha,
        authorization_sha256: digest(current.authorization)
      };
      next.held_iterations = [...priorHeld, outgoing];
    }
    delete next.display_summary;
    validateState(next, root);
    const targetDir = directory(root, targetVersion);
    try {
      await fs.access(path.join(targetDir, "terminal.json"));
      throw new Error("已收口版本不能恢复为活动版本");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const chainAnchor = currentIteration?.started_by && outgoingSnapshot?.id !== events.at(-1)?.id ? {
      iteration_id: object(currentIteration.started_by, "当前版本转移来源").iteration_id,
      event_id: object(currentIteration.started_by, "当前版本转移来源").event_id
    } : undefined;
    const latestState = events.at(-1)?.state_after;
    const baseline = latestState && digest(actionState(object(latestState, "恢复来源状态"))) === digest(actionState(current))
      ? object(latestState, "恢复来源状态") : outgoingSnapshot ? object(outgoingSnapshot.state_after, "恢复来源锚点") : null;
    const changes = stateChanges(current, next);
    if (digest(replayChanges(current, changes)) !== digest(next)) throw new Error("差量不能精确恢复新状态");
    const checkpointWritten = await ensureCheckpoint(file, current, baseline, sourceVersion, eventId, requestHash, now, chainAnchor);
    const transition = {
      ...eventInput(inputEvent), event_format: CONTROL_EVENT_FORMAT, iteration_id: sourceVersion, recorded_at: now, occurred_at: inputEvent.occurred_at ?? now,
      actor, request_hash: requestHash, state_before_hash: digest(current), state_before_revision: current.revision,
      action_before_hash: digest(actionState(current)), action_after_hash: digest(actionState(next)),
      state_after_hash: digest(next), changes,
      ...(!checkpointWritten && chainAnchor ? { chain_anchor: chainAnchor } : {})
    };
    await appendEvent(file, transition);
    await atomicJson(currentFile, next);
    return { status: "restored", revision: next.revision, event_id: eventId, iteration_id: targetVersion };
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
  await verifyVersionEvents(root, version, events);
  const anchor = await iterationAnchor(root, object(current.iteration, "当前迭代"));
  await verifyHeldIterations(root, current);
  if (!events.length) {
    if (!anchor) throw new Error("当前迭代没有事件或有效交接锚点");
    if (digest(actionState(current)) !== anchor.action_after_hash
      || Number(current.revision) < Number(object(anchor.state_after, "交接锚点状态").revision)) {
      throw new Error("当前状态与跨版本交接锚点不一致");
    }
    return { status: "PASS", revision: current.revision, events: 0, handoff_anchor: anchor.id, limitation: "只核对结构与持久化一致性，不证明证据真实或全部语义覆盖" };
  }
  const last = events.at(-1)!;
  if (Number(object(last.state_after, "事件状态").revision) > Number(current.revision)) throw new Error("事件已落盘，当前状态更新未完成");
  if (digest(actionState(current)) !== digest(actionState(object(last.state_after, "事件状态")))) {
    if (!anchor || digest(actionState(current)) !== anchor.action_after_hash
      || Number(current.revision) < Number(object(anchor.state_after, "恢复锚点状态").revision)) {
      throw new Error("当前状态与最新事件或恢复锚点不一致");
    }
  }
  return { status: "PASS", revision: current.revision, events: events.length, limitation: "只核对结构与持久化一致性，不证明证据真实或全部语义覆盖" };
}

// 夹具分别检查业务事件与必要基线检查点，不把检查点伪装成业务更新。
async function testEvents(file: string): Promise<ObjectValue[]> {
  return (await readEvents(file)).filter(event => event.type !== "control_checkpoint");
}

async function selfTest(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "control-plane-update-"));
  try {
    await fs.mkdir(path.join(root, "reports/iterations"), { recursive: true });
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
    assert.equal((await testEvents(eventsFile)).length, 1);
    await assert.rejects(update(root, { ...request, expected_revision: 2, event: { ...request.event, id: "fixture-injected-checkpoint", type: "control_checkpoint" } }), /保留类型/u);
    const firstRawEvents = await readEvents(eventsFile);
    assert.equal(firstRawEvents.length, 2, "仅首次缺基线时生成独立检查点");
    assert.equal(firstRawEvents[0].type, "control_checkpoint");
    assert.ok(firstRawEvents[0].checkpoint_state);
    assert.equal(firstRawEvents[1].event_format, 2);
    assert.equal(Object.hasOwn(firstRawEvents[1], "state_after"), false);
    assert.equal(Object.hasOwn(firstRawEvents[1], "checkpoint_state"), false);
    assert.ok(Array.isArray(firstRawEvents[1].changes));
    assert.equal((await update(root, request)).status, "deduplicated");
    const goodCurrent = await readJson(path.join(root, CURRENT));
    await atomicJson(path.join(root, CURRENT), { ...goodCurrent, revision: 99, scope: { fork: true } });
    await assert.rejects(update(root, request), /状态不一致/u);
    await atomicJson(path.join(root, CURRENT), goodCurrent);
    await assert.rejects(update(root, { ...request, event: { ...request.event, reason: "不同请求" } }), /请求不同/u);
    // 模拟事件成功、状态尚未保存的崩溃窗口；重放不增加事件。
    await atomicJson(path.join(root, CURRENT), state);
    assert.equal((await update(root, request)).status, "recovered");
    assert.equal((await testEvents(eventsFile)).length, 1);
    const current = await readJson(path.join(root, CURRENT));
    const closedState = { ...current, iteration: null, scope: null, candidate: null, active_tasks: [], records: { events: null, terminal: null } };
    const closeRequest = { actor: "coordinator", expected_revision: 2, iteration_id: "fixture", state: closedState,
      event: { id: "fixture-close", type: "iteration_closed", phase: "result", reason: "夹具完成", evidence: ["fixture"] },
      closure: { status: "cancelled", result: "夹具取消", checks: {} } };
    await assert.rejects(update(root, closeRequest, "close"), /须为对象/u);
    closeRequest.closure.checks = Object.fromEntries(CHECKS.map(key => [key, { status: "not_applicable", reason: "隔离夹具", evidence: [], event_ids: [] }]));
    await update(root, closeRequest, "close");
    assert.equal((await update(root, closeRequest, "close")).status, "deduplicated");
    assert.equal((await testEvents(eventsFile)).length, 2);
    assert.equal((await fs.stat(path.join(directory(root, "fixture"), "terminal.json"))).mode & 0o222, 0);

    const beforeValue = { a: null, list: [{ old: "value" }, 2], missing: { inner: true } };
    const afterValue = { a: { new: [1, null] }, list: [{ next: "value" }], absentBefore: null };
    const diff = stateChanges(beforeValue, afterValue);
    assert.deepEqual(replayChanges(beforeValue, diff), afterValue);
    assert.deepEqual(beforeValue, { a: null, list: [{ old: "value" }, 2], missing: { inner: true } });
    assert.throws(() => replayChanges(beforeValue, [{ path: ["__proto__"], before: { present: false }, after: { present: true, value: {} } }]), /路径无效/u);
    assert.throws(() => replayChanges(beforeValue, [{ path: ["a"], before: { present: false }, after: { present: true, value: 1 } }]), /前值不一致/u);
    assert.throws(() => replayChanges({}, [{ path: ["hidden"], before: { present: false }, after: { present: true, value: { whole: "state" } } }]), /按叶子/u);
    assert.throws(() => replayChanges({}, [{ path: ["x"], before: { present: false, value: null }, after: { present: true, value: 1 } }]), /缺失语义/u);

    const legacyRoot = path.join(root, "legacy");
    await fs.mkdir(directory(legacyRoot, "fixture"), { recursive: true });
    const legacyBefore = { ...state, canonical_path: path.join(legacyRoot, CURRENT), display_summary: "旧手工摘要" };
    const legacyAfter = { ...legacyBefore, revision: 2, updated_at: "2026-10-13T00:00:00Z", scope: { legacy: true } };
    const legacyFile = path.join(directory(legacyRoot, "fixture"), "events.jsonl");
    const legacy = { id: "fixture-legacy", iteration_id: "fixture", type: "scope_changed", phase: "decision",
      state_before_revision: 1, state_before_hash: digest(legacyBefore), state_after_hash: digest(legacyAfter),
      action_before_hash: digest(actionState(legacyBefore)), action_after_hash: digest(actionState(legacyAfter)), state_after: legacyAfter };
    await appendEvent(legacyFile, legacy);
    const originalBytes = await fs.readFile(legacyFile);
    await atomicJson(path.join(legacyRoot, CURRENT), legacyAfter);
    const compatibleRequest = { actor: "coordinator", expected_revision: 2, iteration_id: "fixture",
      state: { ...legacyAfter, scope: { legacy: true, delta: null }, display_summary: "新的手工摘要应移除" },
      event: { id: "fixture-new-format", type: "scope_changed", phase: "decision", reason: "新格式生效", evidence: ["fixture"] } };
    await update(legacyRoot, compatibleRequest);
    assert.deepEqual((await fs.readFile(legacyFile)).subarray(0, originalBytes.length), originalBytes);
    const mixedEvents = await readEvents(legacyFile);
    assert.equal(mixedEvents.length, 2, "旧全量状态可直接作为新差量基线，不多造检查点");
    assert.equal(mixedEvents[0].event_format, undefined, "旧事件不要求新字段");
    assert.equal(mixedEvents[1].event_format, 2);
    assert.equal(Object.hasOwn(await readJson(path.join(legacyRoot, CURRENT)), "display_summary"), false);
    assert.equal((await audit(legacyRoot)).status, "PASS");
    await atomicJson(path.join(legacyRoot, CURRENT), legacyAfter);
    assert.equal((await update(legacyRoot, compatibleRequest)).status, "recovered");
    const mixedBytes = await fs.readFile(legacyFile);
    const corrupt = await readEvents(legacyFile);
    (object((corrupt[1].changes as ObjectValue[])[0].after, "篡改差量")).value = "tampered";
    await fs.writeFile(legacyFile, corrupt.map(event => JSON.stringify(event)).join("\n") + "\n");
    await assert.rejects(audit(legacyRoot), /摘要|差量/u);
    await fs.writeFile(legacyFile, mixedBytes);
    const metadataOnly = await readJson(path.join(legacyRoot, CURRENT));
    assert.equal((await update(legacyRoot, { actor: "coordinator", expected_revision: metadataOnly.revision, iteration_id: "fixture", state: metadataOnly })).status, "unchanged");
    assert.deepEqual(await readJson(path.join(legacyRoot, CURRENT)), metadataOnly);
    // 只模拟旧入口曾允许的无事件元数据修订，不让新入口制造这种基线缺口。
    const afterMetadata = { ...metadataOnly, revision: Number(metadataOnly.revision) + 1, updated_at: new Date().toISOString() };
    await atomicJson(path.join(legacyRoot, CURRENT), afterMetadata);
    await update(legacyRoot, { actor: "coordinator", expected_revision: afterMetadata.revision, iteration_id: "fixture",
      state: { ...afterMetadata, scope: { metadataBridge: true } },
      event: { id: "fixture-after-wording", type: "scope_changed", phase: "decision", reason: "无事件元数据之后", evidence: ["fixture"] } });
    assert.equal((await readEvents(legacyFile)).filter(event => event.type === "control_checkpoint").length, 1);
    assert.equal((await audit(legacyRoot)).status, "PASS");

    const directCloseRoot = path.join(root, "direct-close");
    const directVersion = "direct-close";
    const directState: ObjectValue = {
      schema_version: 3, revision: 1, canonical_path: path.join(directCloseRoot, CURRENT),
      coordinator: { thread_id: "coordinator" }, iteration: { id: directVersion, status: "ACTIVE" },
      scope: { description: "直接收口夹具" }, active_tasks: [], candidate: null, blockers: [], evidence: [],
      records: { events: `reports/iterations/${directVersion}/events.jsonl`, terminal: `reports/iterations/${directVersion}/terminal.json` }
    };
    await fs.mkdir(directory(directCloseRoot, directVersion), { recursive: true });
    await atomicJson(path.join(directCloseRoot, CURRENT), directState);
    const directClose: ObjectValue = {
      actor: "coordinator", expected_revision: 1, iteration_id: directVersion,
      state: { ...directState, iteration: null, scope: null, active_tasks: [], records: { events: null, terminal: null } },
      event: { id: `${directVersion}-close-first`, type: "iteration_closed", phase: "result", reason: "无前置事件直接收口", evidence: ["fixture"] },
      closure: { status: "cancelled", result: "直接取消", checks: Object.fromEntries(CHECKS.map(key => [key, {
        status: "not_applicable", reason: "无前置事件夹具", evidence: [], event_ids: []
      }])) }
    };
    assert.equal((await update(directCloseRoot, directClose, "close")).status, "closed");
    assert.equal((await update(directCloseRoot, directClose, "close")).status, "deduplicated");
    assert.equal((await audit(directCloseRoot)).status, "IDLE");

    const prepareHandoff = async (fixtureRoot: string, options: { status?: string; activeTasks?: unknown[]; gate?: string; requiredGates?: string[] } = {}) => {
      await fs.mkdir(path.join(fixtureRoot, "reports/iterations"), { recursive: true });
      const sourceVersion = "v0.5.13";
      const targetVersion = "v0.5.14";
      const requiredGates = options.requiredGates ?? ["snapshot", "runtime_start"];
      const gates = Object.fromEntries(requiredGates.map(key => [key, "PASS"]));
      gates.isolated_online = "PARTIAL";
      if (options.gate) gates[options.gate] = "NOT_RUN";
      const baseState: ObjectValue = {
        schema_version: 3, revision: 1, canonical_path: path.join(fixtureRoot, CURRENT),
        coordinator: { thread_id: "coordinator" }, iteration: { id: sourceVersion, status: "ACTIVE" },
        scope: { description: "旧版本范围" }, active_tasks: [], candidate: null, blockers: [], evidence: [],
        authorization: { version: sourceVersion, execution_enabled: false }, held_iterations: [],
        records: { events: `reports/iterations/${sourceVersion}/events.jsonl`, terminal: `reports/iterations/${sourceVersion}/terminal.json` }
      };
      await atomicJson(path.join(fixtureRoot, CURRENT), baseState);
      const readyState = {
        ...baseState,
        iteration: { id: sourceVersion, status: options.status ?? "READY_WAIT_OWNER" },
        active_tasks: options.activeTasks ?? [],
        candidate: {
          sha: "a".repeat(40), tree: "b".repeat(40), status: "READY_FOR_RELEASE_WAIT_OWNER", release_frozen: true,
          release_reference: { name: "release/v0.5.13", status: "LOCAL_FROZEN" },
          required_gates: requiredGates, test_matrix_ref: "knowledge/test-impact-matrix.md#候选级最小门", quality_gate: gates
        }
      };
      await update(fixtureRoot, {
        actor: "coordinator", expected_revision: 1, iteration_id: sourceVersion, state: readyState,
        event: { id: `${sourceVersion}-ready`, type: "candidate_frozen", phase: "decision", reason: "隔离夹具候选已验证冻结", evidence: ["fixture"] }
      });
      const sourceState = await readJson(path.join(fixtureRoot, CURRENT));
      const targetState: ObjectValue = {
        ...sourceState,
        iteration: { id: targetVersion, status: "PLANNING", phase: "需求事实核对" },
        scope: null, active_tasks: [], candidate: null, blockers: [], evidence: [],
        authorization: null, rule_baseline: { revision: "2.1" }, runtime: { observed_release: "v0.5.13" },
        next_action: { owner: "coordinator", action: "刷新需求", status: "PLANNED" },
        records: { events: `reports/iterations/${targetVersion}/events.jsonl`, terminal: `reports/iterations/${targetVersion}/terminal.json` }
      };
      const handoffRequest = {
        actor: "coordinator", expected_revision: sourceState.revision,
        from_iteration_id: sourceVersion, iteration_id: targetVersion, state: targetState,
        event: {
          id: `${sourceVersion}-handoff`, type: "iteration_handoff", phase: "decision", reason: "交接未收口版本并启动需求规划",
          evidence: ["fixture"], details: { target_iteration_id: targetVersion }
        }
      };
      return { sourceVersion, targetVersion, sourceState, handoffRequest };
    };
    const checkpointRoot = path.join(root, "checkpoint-window");
    await fs.mkdir(directory(checkpointRoot, "fixture"), { recursive: true });
    const checkpointState = { ...state, canonical_path: path.join(checkpointRoot, CURRENT) };
    await atomicJson(path.join(checkpointRoot, CURRENT), checkpointState);
    const checkpointRequest = { ...request, state: { ...checkpointState, scope: { changed: true } } };
    const checkpointFile = path.join(directory(checkpointRoot, "fixture"), "events.jsonl");
    await ensureCheckpoint(checkpointFile, checkpointState, null, "fixture", request.event.id, digest(checkpointRequest), new Date().toISOString());
    await assert.rejects(update(checkpointRoot, { ...checkpointRequest, event: { ...request.event, reason: "换请求" } }), /请求不同/u);
    assert.equal((await update(checkpointRoot, checkpointRequest)).status, "updated");
    assert.equal((await readEvents(checkpointFile)).length, 2, "仅检查点落盘后重试不重复生成基线");
    assert.equal((await audit(checkpointRoot)).status, "PASS");
    const beforeInvalid = await fs.readFile(checkpointFile);
    const latestValid = await readJson(path.join(checkpointRoot, CURRENT));
    await assert.rejects(update(checkpointRoot, { actor: "coordinator", expected_revision: latestValid.revision, iteration_id: "fixture",
      state: { ...latestValid, scope: JSON.parse('{"__proto__":{"unexpected":true}}') },
      event: { id: "fixture-invalid-path", type: "scope_changed", phase: "decision", reason: "非法差量路径", evidence: ["fixture"] } }), /路径无效/u);
    assert.deepEqual(await fs.readFile(checkpointFile), beforeInvalid, "无法回放的请求不得先落检查点或事件");

    const oldHandoffRoot = path.join(root, "legacy-handoff");
    const oldHandoff = await prepareHandoff(oldHandoffRoot);
    const oldFile = path.join(directory(oldHandoffRoot, oldHandoff.sourceVersion), "events.jsonl");
    const oldRows = await readEvents(oldFile);
    await verifyVersionEvents(oldHandoffRoot, oldHandoff.sourceVersion, oldRows);
    const oldReady = oldRows.find(event => event.type === "candidate_frozen")!;
    const { event_format, changes, ...oldMetadata } = oldReady;
    await fs.writeFile(oldFile, JSON.stringify({ ...oldMetadata, state_after: oldReady.state_after }) + "\n");
    const oldPrefix = await fs.readFile(oldFile);
    await update(oldHandoffRoot, oldHandoff.handoffRequest, "handoff");
    assert.deepEqual((await fs.readFile(oldFile)).subarray(0, oldPrefix.length), oldPrefix);
    assert.equal((await audit(oldHandoffRoot)).status, "PASS", "旧全量来源与新差量交接可跨版本审计");

    const revokedRoot = path.join(root, "no-authorization-revival");
    const revoked = await prepareHandoff(revokedRoot);
    await update(revokedRoot, { actor: "coordinator", expected_revision: revoked.sourceState.revision, iteration_id: revoked.sourceVersion,
      state: { ...revoked.sourceState, authorization: { execution_enabled: true, grant: "old-only" } },
      event: { id: `${revoked.sourceVersion}-old-grant`, type: "authorization_changed", phase: "decision", reason: "历史授权夹具", evidence: ["fixture"] } });
    const granted = await readJson(path.join(revokedRoot, CURRENT));
    await update(revokedRoot, { ...revoked.handoffRequest, expected_revision: granted.revision }, "handoff");
    const withoutGrant = await readJson(path.join(revokedRoot, CURRENT));
    const oldGrantReference = (withoutGrant.held_iterations as ObjectValue[])[0];
    await assert.rejects(restoreHeld(revokedRoot, { actor: "coordinator", expected_revision: withoutGrant.revision,
      from_iteration_id: revoked.targetVersion, iteration_id: revoked.sourceVersion,
      event: { id: `${revoked.targetVersion}-cannot-revive`, type: "held_iteration_restored", phase: "decision", reason: "拒绝恢复已不在当前授权的权限", evidence: ["fixture"],
        details: { target_iteration_id: revoked.sourceVersion, held_event_id: oldGrantReference.event_id, held_state_after_hash: oldGrantReference.state_after_hash } } }), /不得重新授予权限/u);

    const handoffRoot = path.join(root, "handoff");
    const handoff = await prepareHandoff(handoffRoot);
    assert.equal((await update(handoffRoot, handoff.handoffRequest, "handoff")).status, "updated");
    const sourceEventsFile = path.join(directory(handoffRoot, handoff.sourceVersion), "events.jsonl");
    const sourceEvents = await testEvents(sourceEventsFile);
    assert.equal(sourceEvents.length, 2);
    const handoffEvent = sourceEvents.at(-1)!;
    assert.equal(handoffEvent.iteration_id, handoff.sourceVersion);
    assert.equal(handoffEvent.state_after_hash, digest(await readJson(path.join(handoffRoot, CURRENT))));
    assert.equal(await fs.stat(path.join(directory(handoffRoot, handoff.sourceVersion), "terminal.json")).then(() => true).catch(() => false), false);
    let targetState = await readJson(path.join(handoffRoot, CURRENT));
    assert.deepEqual(targetState.held_iterations, [{
      iteration_id: handoff.sourceVersion,
      events: `reports/iterations/${handoff.sourceVersion}/events.jsonl`,
      event_id: sourceEvents[0].id,
      state_after_hash: sourceEvents[0].state_after_hash,
      status: "READY_WAIT_OWNER",
      candidate_sha: "a".repeat(40),
      authorization_sha256: digest(handoff.sourceState.authorization)
    }]);
    assert.equal(object(targetState.iteration, "夹具目标迭代").started_by && object(object(targetState.iteration, "夹具目标迭代").started_by, "夹具交接来源").event_id, handoffEvent.id);
    assert.equal((await audit(handoffRoot)).status, "PASS");
    await atomicJson(path.join(handoffRoot, CURRENT), handoff.sourceState);
    assert.equal((await update(handoffRoot, handoff.handoffRequest, "handoff")).status, "recovered");
    assert.equal((await testEvents(sourceEventsFile)).length, 2);
    assert.equal((await update(handoffRoot, handoff.handoffRequest, "handoff")).status, "deduplicated");
    targetState = await readJson(path.join(handoffRoot, CURRENT));
    const droppedHeldRequest = {
      actor: "coordinator", expected_revision: targetState.revision, iteration_id: handoff.targetVersion,
      state: { ...targetState, held_iterations: [] },
      event: { id: `${handoff.targetVersion}-drop-held`, type: "scope_changed", phase: "decision", reason: "无效丢弃引用", evidence: ["fixture"] }
    };
    await assert.rejects(update(handoffRoot, droppedHeldRequest), /不能丢弃或改写未收口版本引用/u);
    assert.equal((await readJson(path.join(handoffRoot, CURRENT))).revision, targetState.revision);
    // 即使目标版本尚无本地事件，恢复时也须引用handoff锚点保存的真实目标状态。
    assert.equal((await audit(handoffRoot)).status, "PASS");
    assert.equal(((await readJson(path.join(handoffRoot, CURRENT))).held_iterations as unknown[]).length, 1);

    const beforeRestore = await readJson(path.join(handoffRoot, CURRENT));
    const held13 = object((beforeRestore.held_iterations as unknown[])[0], "夹具待恢复版本");
    const restore13Request = {
      actor: "coordinator", expected_revision: beforeRestore.revision,
      from_iteration_id: handoff.targetVersion, iteration_id: handoff.sourceVersion,
      event: {
        id: `${handoff.targetVersion}-restore-13`, type: "held_iteration_restored", phase: "decision",
        reason: "Owner信号要求返回前版处理收口", evidence: ["fixture-owner-signal"],
        details: { target_iteration_id: handoff.sourceVersion, held_event_id: held13.event_id, held_state_after_hash: held13.state_after_hash }
      }
    };
    await assert.rejects(restoreHeld(handoffRoot, {
      ...restore13Request,
      event: { ...restore13Request.event, details: { ...restore13Request.event.details, held_event_id: "missing" } }
    }), /不在当前未收口版本引用中/u);
    const restoreWindowRoot = path.join(root, "restore-checkpoint-window");
    const restoreWindow = await prepareHandoff(restoreWindowRoot);
    await update(restoreWindowRoot, restoreWindow.handoffRequest, "handoff");
    const windowBefore = await readJson(path.join(restoreWindowRoot, CURRENT));
    const windowMetadata: ObjectValue = { ...windowBefore, revision: Number(windowBefore.revision) + 1, updated_at: new Date().toISOString() };
    await atomicJson(path.join(restoreWindowRoot, CURRENT), windowMetadata);
    const windowHeld = (windowMetadata.held_iterations as ObjectValue[])[0];
    const windowRequest = { actor: "coordinator", expected_revision: windowMetadata.revision,
      from_iteration_id: restoreWindow.targetVersion, iteration_id: restoreWindow.sourceVersion,
      event: { id: `${restoreWindow.targetVersion}-window-restore`, type: "held_iteration_restored", phase: "decision",
        reason: "恢复中断夹具", evidence: ["fixture"], details: { target_iteration_id: restoreWindow.sourceVersion,
          held_event_id: windowHeld.event_id, held_state_after_hash: windowHeld.state_after_hash } } };
    const windowAnchor = (await iterationAnchor(restoreWindowRoot, object(windowMetadata.iteration, "夹具当前版本")))!;
    const windowFile = path.join(directory(restoreWindowRoot, restoreWindow.targetVersion), "events.jsonl");
    await ensureCheckpoint(windowFile, windowMetadata, object(windowAnchor.state_after, "窗口基线"), restoreWindow.targetVersion,
      windowRequest.event.id, digest(windowRequest), new Date().toISOString(), object(windowMetadata.iteration, "夹具当前版本").started_by as ObjectValue);
    await assert.rejects(restoreHeld(restoreWindowRoot, { ...windowRequest, event: { ...windowRequest.event, reason: "同ID换请求" } }), /请求不同/u);
    assert.equal((await restoreHeld(restoreWindowRoot, windowRequest)).status, "restored");
    assert.equal((await readEvents(windowFile)).length, 2);
    assert.equal((await audit(restoreWindowRoot)).status, "PASS");

    assert.equal((await restoreHeld(handoffRoot, restore13Request)).status, "restored");
    await atomicJson(path.join(handoffRoot, CURRENT), beforeRestore);
    assert.equal((await restoreHeld(handoffRoot, restore13Request)).status, "recovered");
    assert.equal((await restoreHeld(handoffRoot, restore13Request)).status, "deduplicated");
    let restored13 = await readJson(path.join(handoffRoot, CURRENT));
    assert.equal(object(restored13.iteration, "恢复的前版").id, handoff.sourceVersion);
    assert.deepEqual(restored13.candidate, handoff.sourceState.candidate);
    assert.deepEqual(restored13.authorization, handoff.sourceState.authorization);
    assert.deepEqual(restored13.rule_baseline, beforeRestore.rule_baseline);
    assert.deepEqual(restored13.runtime, beforeRestore.runtime);
    assert.equal((await audit(handoffRoot)).status, "PASS");

    const close13State = {
      ...restored13, iteration: null, scope: null, candidate: null, active_tasks: [],
      records: { events: null, terminal: null }
    };
    const close13Request: ObjectValue = {
      actor: "coordinator", expected_revision: restored13.revision, iteration_id: handoff.sourceVersion,
      state: close13State,
      event: { id: `${handoff.sourceVersion}-close-after-restore`, type: "iteration_closed", phase: "result", reason: "前版已完成Owner要求的收口", evidence: ["fixture-owner-signal"] },
      closure: { status: "cancelled", result: "恢复后按Owner信号取消", checks: Object.fromEntries(CHECKS.map(key => [key, {
        status: "not_applicable", reason: "隔离夹具", evidence: [], event_ids: []
      }])) }
    };
    assert.equal((await update(handoffRoot, close13Request, "close")).status, "closed");
    const terminal13Before = await fs.readFile(path.join(directory(handoffRoot, handoff.sourceVersion), "terminal.json"), "utf8");
    assert.equal((await audit(handoffRoot)).status, "IDLE");

    const closed13 = await readJson(path.join(handoffRoot, CURRENT));
    const held14 = (closed13.held_iterations as unknown[]).map(value => object(value, "夹具待恢复版本"))
      .find(value => value.iteration_id === handoff.targetVersion)!;
    const restore14Request = {
      actor: "coordinator", expected_revision: closed13.revision,
      from_iteration_id: handoff.sourceVersion, iteration_id: handoff.targetVersion,
      event: {
        id: `${handoff.sourceVersion}-restore-14`, type: "held_iteration_restored", phase: "decision",
        reason: "恢复之前规划版本继续工作", evidence: ["fixture-owner-signal"],
        details: { target_iteration_id: handoff.targetVersion, held_event_id: held14.event_id, held_state_after_hash: held14.state_after_hash }
      }
    };
    assert.equal((await restoreHeld(handoffRoot, restore14Request)).status, "restored");
    const restored14 = await readJson(path.join(handoffRoot, CURRENT));
    assert.equal(object(restored14.iteration, "恢复的后版").id, handoff.targetVersion);
    assert.equal(restored14.authorization, null);
    assert.deepEqual(restored14.rule_baseline, beforeRestore.rule_baseline);
    assert.deepEqual(restored14.runtime, beforeRestore.runtime);
    assert.equal(await fs.readFile(path.join(directory(handoffRoot, handoff.sourceVersion), "terminal.json"), "utf8"), terminal13Before);
    assert.equal((await audit(handoffRoot)).status, "PASS");

    const handoffRejections: Array<[string, { status?: string; activeTasks?: unknown[]; gate?: string; requiredGates?: string[] }, RegExp]> = [
      ["active", { activeTasks: [{ id: "still-running" }] }, /在途实施任务/u],
      ["unverified", { gate: "runtime_start", requiredGates: ["snapshot", "runtime_start"] }, /必需验证门/u],
      ["not-ready", { status: "ACTIVE" }, /冻结版本/u]
    ];
    for (const [name, options, expected] of handoffRejections) {
      const rejectedRoot = path.join(root, `handoff-${name}`);
      const rejected = await prepareHandoff(rejectedRoot, options);
      await assert.rejects(update(rejectedRoot, rejected.handoffRequest, "handoff"), expected);
      assert.equal(object((await readJson(path.join(rejectedRoot, CURRENT))).iteration, "拒绝夹具迭代").id, rejected.sourceVersion);
      assert.equal((await testEvents(path.join(directory(rejectedRoot, rejected.sourceVersion), "events.jsonl"))).length, 1);
    }
    console.log("更新入口夹具通过：旧全量/新差量混合回放、缺失值与篡改拒绝、事件/检查点中断恢复、幂等、跨版本held往返及授权不复活。");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

const [command, flag, file] = process.argv.slice(2);
if (command === "self-test") await selfTest();
else {
  const root = process.cwd();
  if (command === "audit") console.log(JSON.stringify(await audit(root)));
  else if (command === "restore-held" && flag === "--input" && file) {
    console.log(JSON.stringify(await restoreHeld(root, await readJson(path.resolve(file)))));
  }
  else if (["apply", "close", "handoff"].includes(command) && flag === "--input" && file) {
    console.log(JSON.stringify(await update(root, await readJson(path.resolve(file)), command as "apply" | "close" | "handoff")));
  } else throw new Error("使用apply/close/handoff/restore-held --input JSON文件、audit或self-test");
}
