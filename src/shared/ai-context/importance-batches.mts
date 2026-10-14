/**
 * 显式历史范围的重要性评分进度；复用既有异步任务，不自动扩大付费范围。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：只保存来源坐标与执行状态，原文和凭据不进入批次账。
 */
import { IMPORTANCE_BATCH_SIZE, importanceScoreFor, type ImportanceMaterial, type ImportanceScore } from "./importance.mjs";
import type { ImportanceSourceRef } from "./importance-runtime.mjs";
interface Source extends ImportanceMaterial { sourceRef: ImportanceSourceRef; recordedAt?: string; occurredAt?: string; occurredOn?: string }
interface Batch { refs: ImportanceSourceRef[]; requestId: string; taskId: string; status: string }
interface Job {
  id: string; requestKey: string; accountId: string; from: string; to: string; dateBasis: "recorded" | "occurred"; model: string; effort: string;
  initialMaxCalls: number; maxCalls: number; requests: { id: string; hash: string }[]; cursor: number; refs: ImportanceSourceRef[]; batches: Batch[];
  status: "running" | "paused" | "completed" | "partial" | "limit" | "configuration_changed";
  skipped: number; invalid: number; attempt: number; createdAt: string; updatedAt: string;
}
type Store = Record<string, unknown> & { importanceJobs?: Job[]; importanceScores?: ImportanceScore[] };
interface Ports {
  repository: { read(): Promise<Store>; update(mutate: (store: Store) => unknown): Promise<unknown> };
  accountId(): string; createBusinessId(): string; list(store: Store): Source[];
  choice(): Promise<{ model: string; effort: string } | null>;
  hash(value: string): string; now(): string;
  enqueue(refs: ImportanceSourceRef[], requestId: string): Promise<unknown>;
}
const coordinate = (ref: ImportanceSourceRef) => JSON.stringify([ref.resourceType, ref.resourceId, ref.rootId, ref.targetKey]);
const dateValid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const tasksIn = (store: Store) => Array.isArray(store.aiTasks) ? store.aiTasks as {
  id: string; clientRequestId: string; status: string; errorCode?: string;
}[] : [];

/** 持久范围与确定性批次键允许重启重接任务；终态失败继续下一批，补打需显式恢复。
 * @since unreleased
 */
export function createImportanceBatches(ports: Ports) {
  const progress = (job: Job, store: Store, choice: { model: string; effort: string } = job) => {
    const sources = new Map(ports.list(store).map(source => [coordinate(source.sourceRef), source]));
    let scored = 0;
    let invalid = 0;
    let failed = 0;
    const latestStatus = new Map<string, string>();
    for (const batch of job.batches) {
      const status = tasksIn(store).find(task => task.id === batch.taskId || task.clientRequestId === batch.requestId)?.status || batch.status;
      for (const ref of batch.refs) latestStatus.set(coordinate(ref), status);
    }
    for (const ref of job.refs) {
      const source = sources.get(coordinate(ref));
      if (!source) invalid += 1;
      else if (importanceScoreFor(source, store.importanceScores || [], choice)) scored += 1;
      else if (["failed", "cancelled", "stale"].includes(latestStatus.get(coordinate(ref)) || "")) failed += 1;
    }
    return { failedSources: failed, scoredSources: scored, invalidSources: invalid, pendingSources: job.refs.length - scored - invalid };
  };
  const publicJob = (job: Job, store: Store, choice: { model: string; effort: string }) => {
    const counts = progress(job, store, choice);
    return { ...job, refs: undefined, requestKey: undefined, requests: undefined, ...counts,
      status: ["completed", "partial"].includes(job.status)
        ? counts.pendingSources || counts.invalidSources ? "partial" : "completed" : job.status,
      total: job.refs.length, remaining: job.refs.length - job.cursor, rangeScanned: job.cursor === job.refs.length,
      allSourcesScored: counts.scoredSources === job.refs.length,
      resumeAction: counts.pendingSources > 0 ? { action: "resume", requiresMaxCalls: true } : null,
      succeededBatches: job.batches.filter(batch => tasksIn(store).find(task => task.id === batch.taskId)?.status === "succeeded").length,
      failedBatches: job.batches.filter(batch => ["failed", "cancelled", "stale"].includes(tasksIn(store).find(task => task.id === batch.taskId)?.status || batch.status)).length,
      batches: job.batches.map(batch => ({ ...batch, refs: undefined,
        count: batch.refs.length, status: tasksIn(store).find(task => task.id === batch.taskId)?.status || batch.status })) };
  };
  let pumping = false;
  const service = {
    permits(store: Store, requestId: string, returnedResult = false) {
      const job = store.importanceJobs?.find(item => item.batches.some(batch => batch.requestId === requestId));
      return !job || job.accountId === ports.accountId() && (job.status === "running" || returnedResult && job.status === "paused");
    },
    async read(id: string) {
      const store = await ports.repository.read();
      const job = store.importanceJobs?.find(item => item.id === id && item.accountId === ports.accountId());
      return job ? publicJob(job, store, await ports.choice() || { model: "", effort: "" }) : { missing: true };
    },
    async start(input: { from: string; to: string; maxCalls: number; dateBasis?: "recorded" | "occurred" }, requestId: string) {
      if (!requestId || !dateValid(input.from) || !dateValid(input.to) || input.from > input.to
        || !Number.isSafeInteger(input.maxCalls) || input.maxCalls < 1 || input.maxCalls > 100) return { invalid: true };
      const dateBasis = input.dateBasis === undefined ? "recorded" : input.dateBasis;
      if (!["recorded", "occurred"].includes(dateBasis)) return { invalid: true };
      const choice = await ports.choice();
      if (!choice) return { invalid: true, code: "IMPORTANCE_MODEL_UNCONFIGURED" };
      const requestKey = ports.hash(JSON.stringify([ports.accountId(), requestId]));
      const result = await ports.repository.update(store => {
        store.importanceJobs ||= [];
        const existing = store.importanceJobs.find(item => item.requestKey === requestKey);
        if (existing) return existing.from === input.from && existing.to === input.to
          && existing.initialMaxCalls === input.maxCalls && existing.dateBasis === dateBasis ? { id: existing.id } : { conflict: true };
        const refs = ports.list(store).filter(source => {
          const instant = dateBasis === "recorded" ? source.recordedAt : source.occurredAt;
          const date = instant && Number.isFinite(Date.parse(instant))
            ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant))
            : dateBasis === "occurred" ? source.occurredOn || "" : "";
          return date >= input.from && date <= input.to;
        }).sort((a, b) => coordinate(a.sourceRef).localeCompare(coordinate(b.sourceRef))).map(source => source.sourceRef);
        const id = ports.createBusinessId();
        store.importanceJobs.push({ id, requestKey, dateBasis, accountId: ports.accountId(),
          from: input.from, to: input.to, maxCalls: input.maxCalls, ...choice, refs,
          initialMaxCalls: input.maxCalls, requests: [{ id: requestId, hash: ports.hash(JSON.stringify(input)) }],
          cursor: 0, batches: [], status: "running", skipped: 0, invalid: 0, attempt: 0,
          createdAt: ports.now(), updatedAt: ports.now() });
        return { id };
      }) as { id?: string; conflict?: boolean };
      if (result.id) await service.pump();
      return result.id ? service.read(result.id) : result;
    },
    async control(id: string, action: "pause" | "resume", maxCalls?: number, requestId = "") {
      if (!["pause", "resume"].includes(action)
        || action === "resume" && (!Number.isSafeInteger(maxCalls) || Number(maxCalls) < 1 || Number(maxCalls) > 100)) return { invalid: true };
      const choice = action === "resume" ? await ports.choice() : null;
      if (action === "resume" && !choice) return { invalid: true, code: "IMPORTANCE_MODEL_UNCONFIGURED" };
      const result = await ports.repository.update(store => {
        const job = store.importanceJobs?.find(item => item.id === id && item.accountId === ports.accountId());
        if (!job) return { missing: true };
        const requestHash = ports.hash(JSON.stringify([id, action, maxCalls]));
        const previousRequest = job.requests.find(item => item.id === requestId);
        if (requestId && previousRequest) return previousRequest.hash === requestHash ? { id } : { conflict: true };
        if (action === "pause") job.status = "paused";
        else {
          // 已排队或正在执行的批次仍归原请求；不重排同一来源造成双重调用。
          if (job.batches.some(batch => tasksIn(store).some(task => (task.clientRequestId === batch.requestId || task.id === batch.taskId)
            && ["queued", "running", "waitingBudget", "waiting_for_user_model"].includes(task.status)))) {
            if (job.model !== choice!.model || job.effort !== choice!.effort) return { conflict: true };
            job.status = "running";
            job.maxCalls = Math.max(job.maxCalls, job.batches.length + Number(maxCalls));
            job.updatedAt = ports.now();
            if (requestId) job.requests.push({ id: requestId, hash: requestHash });
            return { id };
          }
          job.status = "running";
          job.cursor = 0;
          job.skipped = 0;
          job.invalid = 0;
          job.attempt += 1;
          job.maxCalls = job.batches.length + Number(maxCalls);
          job.model = choice!.model;
          job.effort = choice!.effort;
        }
        job.updatedAt = ports.now();
        if (requestId) job.requests.push({ id: requestId, hash: requestHash });
        return { id };
      }) as { id?: string };
      if (result.id && action === "resume") await service.pump();
      return result.id ? service.read(id) : result;
    },
    async pump() {
      if (pumping) return;
      pumping = true;
      let continueImmediately = false;
      try {
        const choice = await ports.choice();
        const pending = await ports.repository.update(store => {
          const requests: Batch[] = [];
          for (const job of store.importanceJobs || []) {
            if (job.accountId !== ports.accountId() || job.status !== "running") continue;
            if (!choice || choice.model !== job.model || choice.effort !== job.effort) {
              job.status = "configuration_changed";
              continue;
            }
            const previous = job.batches.at(-1);
            if (previous) {
              const task = tasksIn(store).find(item => item.clientRequestId === previous.requestId || item.id === previous.taskId);
              if (task) {
                previous.taskId = task.id;
                previous.status = task.status;
                if (!["succeeded", "failed", "cancelled", "stale"].includes(task.status)) continue;
              } else if (previous.status === "reserved") {
                requests.push(previous);
                continue;
              }
            }
            const sources = new Map(ports.list(store).map(source => [coordinate(source.sourceRef), source]));
            const startCursor = job.cursor;
            const previousSkipped = job.skipped;
            const previousInvalid = job.invalid;
            const refs: ImportanceSourceRef[] = [];
            while (job.cursor < job.refs.length && refs.length < IMPORTANCE_BATCH_SIZE) {
              const ref = job.refs[job.cursor++]!;
              const source = sources.get(coordinate(ref));
              if (!source) job.invalid += 1;
              else if (importanceScoreFor(source, store.importanceScores || [], choice)) job.skipped += 1;
              else refs.push(source.sourceRef);
            }
            if (!refs.length) {
              const counts = progress(job, store, choice);
              job.status = counts.pendingSources || counts.invalidSources ? "partial" : "completed";
            }
            else if (job.batches.length >= job.maxCalls) {
              job.cursor = startCursor;
              job.skipped = previousSkipped;
              job.invalid = previousInvalid;
              job.status = "limit";
            } else {
              const batch: Batch = { refs, taskId: "", status: "reserved",
                requestId: `importance-range:${job.id}:${job.attempt}:${job.batches.length}` };
              job.batches.push(batch);
              requests.push(batch);
            }
            job.updatedAt = ports.now();
          }
          return requests;
        }) as Batch[];
        for (const batch of pending) {
          const result = await ports.enqueue(batch.refs, batch.requestId) as { task?: { id: string; status: string }; cached?: boolean };
          continueImmediately ||= !result.task || ["succeeded", "failed", "cancelled", "stale"].includes(result.task.status);
          await ports.repository.update(store => {
            const saved = store.importanceJobs?.flatMap(job => job.batches).find(item => item.requestId === batch.requestId);
            if (saved) {
              saved.taskId = result.task?.id || "";
              const task = tasksIn(store).find(item => item.clientRequestId === batch.requestId || item.id === saved.taskId);
              saved.status = task?.status || result.task?.status || (result.cached ? "succeeded" : "failed");
              continueImmediately ||= ["succeeded", "failed", "cancelled", "stale"].includes(saved.status);
            }
          });
        }
      } finally {
        pumping = false;
      }
      if (continueImmediately) await service.pump();
    }
  };
  return service;
}

/** 校验持久进度结构；损坏的游标或批次账不能被当成已完成范围。
 * @since unreleased
 */
export function isImportanceJob(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as Job;
  const validRef = (ref: ImportanceSourceRef) => Boolean(ref && typeof ref === "object"
    && [ref.resourceType, ref.resourceId, ref.rootId, ref.targetKey].every(item => typeof item === "string")
    && ref.resourceType && ref.resourceId && Number.isSafeInteger(ref.version) && ref.version > 0);
  return /^[A-Za-z0-9_-]{16}$/.test(job.id) && /^[a-f0-9]{64}$/.test(job.requestKey)
    && ["recorded", "occurred"].includes(job.dateBasis)
    && [job.id, job.accountId, job.model, job.effort, job.createdAt, job.updatedAt].every(item => typeof item === "string" && Boolean(item))
    && dateValid(job.from) && dateValid(job.to) && job.from <= job.to
    && ["running", "paused", "completed", "partial", "limit", "configuration_changed"].includes(job.status)
    && [job.initialMaxCalls, job.maxCalls, job.cursor, job.skipped, job.invalid, job.attempt].every(item => Number.isSafeInteger(item) && item >= 0)
    && Array.isArray(job.requests) && job.requests.every(item => item && typeof item.id === "string"
      && Boolean(item.id) && typeof item.hash === "string" && /^[a-f0-9]{64}$/.test(item.hash))
    && Array.isArray(job.refs) && job.refs.every(validRef) && job.cursor <= job.refs.length
    && Array.isArray(job.batches) && job.batches.every(batch => batch && typeof batch.requestId === "string"
      && Boolean(batch.requestId) && typeof batch.taskId === "string" && typeof batch.status === "string"
      && Array.isArray(batch.refs) && batch.refs.length > 0 && batch.refs.length <= IMPORTANCE_BATCH_SIZE && batch.refs.every(validRef));
}
