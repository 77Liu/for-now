/**
 * 按需重要性评分的现有后台任务适配、版本缓存和显式纠正。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：原文与凭据不写入评分记录；回答选材不等待该异步任务。
 */
import { createImportanceBatches } from "./importance-batches.mjs";
import { IMPORTANCE_BATCH_SIZE, IMPORTANCE_SCORING_VERSION, importanceScoreFor, parseImportanceScores,
  type ImportanceMaterial, type ImportanceScore } from "./importance.mjs";
export { IMPORTANCE_BATCH_SIZE } from "./importance.mjs";
export interface ImportanceSourceRef {
  resourceType: string; resourceId: string; rootId: string; targetKey: string; version: number;
}
type Store = Record<string, unknown> & { importanceScores?: ImportanceScore[] };
type Task = { id: string; targetId: string; clientRequestId?: string; payload: {
  sourceRefs: ImportanceSourceRef[]; model: string; effort: string; fingerprint: string;
} };
interface Ports {
  repository: { read(): Promise<Store>; update(mutate: (store: Store) => unknown): Promise<unknown> };
  resolve(store: Store, sourceRef: ImportanceSourceRef): ImportanceMaterial | null;
  modelChoice(): Promise<{ model: string; effort: string } | null>;
  currentChoice?(): { model: string; effort: string } | null;
  hash(value: string): string;
  promptText(id: string): string;
  renderPrompt(id: string, values: Record<string, string>): string;
  now(): string;
  accountId?(): string;
  createBusinessId?(): string;
  list?(store: Store): (ImportanceMaterial & { sourceRef: ImportanceSourceRef; recordedAt?: string; occurredAt?: string; occurredOn?: string })[];
}

/**
 * 复用现有任务、供应商及预算链；只在显式 enqueue 时登记小批次任务。
 * 模型失败不写模型分，查询自然回退规则；版本/撤权变化令整批任务失效。
 * @since unreleased
 */
export function createImportanceService(ports: Ports) {
  let background: { enqueue(input: Record<string, unknown>): Promise<unknown> } | null = null;
  const materialFor = (store: Store, refs: ImportanceSourceRef[]) => refs.map(ref => ports.resolve(store, ref));
  const fingerprint = (materials: ImportanceMaterial[], model: string, effort: string) => ports.hash(JSON.stringify({
    sources: materials.map(item => [item.accountId, item.sourceKey, item.version, item.contentSha256, item.permissionRevision ?? 0]),
    model, effort, scoringVersion: IMPORTANCE_SCORING_VERSION
  }));
  let batches: ReturnType<typeof createImportanceBatches> | null = null;
  const target = {
    settled: async () => { await batches?.pump(); },
    prepareResult(store: Store, task: Task) {
      return target.prepare(store, task, true);
    },
    prepare(store: Store, task: Task, returnedResult = false) {
      if (task.clientRequestId && batches && !batches.permits(store, task.clientRequestId, returnedResult)) return null;
      if (!task.payload || !Array.isArray(task.payload.sourceRefs)
        || !task.payload.sourceRefs.length || task.payload.sourceRefs.length > IMPORTANCE_BATCH_SIZE) return null;
      if (ports.currentChoice) {
        const choice = ports.currentChoice();
        if (!choice || choice.model !== task.payload.model || choice.effort !== task.payload.effort) return null;
      }
      const resolved = materialFor(store, task.payload.sourceRefs);
      if (!resolved.length || resolved.some(item => !item)) return null;
      const materials = resolved as ImportanceMaterial[];
      const inputHash = fingerprint(materials, task.payload.model, task.payload.effort);
      if (inputHash !== task.payload.fingerprint) return null;
      return {
        kind: "importanceScoring", scene: "importanceScoring", inputVersion: 1, subtargetVersion: 0, inputHash,
        json: true, captureReasoning: false, retryWithoutThinking: false, auditPrompt: false, maxTokens: 1500,
        modelOverride: { model: task.payload.model, effort: task.payload.effort },
        systemPrompt: ports.promptText("importance.system.score"),
        prompt: ports.renderPrompt("importance.task.score", {
          input: JSON.stringify({ scoringVersion: IMPORTANCE_SCORING_VERSION,
            materials: materials.map((item, index) => ({ reference: `r${index + 1}`,
              text: item.text.slice(0, 1000), origin: item.origin, informationType: item.informationType, favorite: item.favorite === true, feedback: item.feedback === true })) })
        }),
        importanceMaterials: materials
      };
    },
    save(store: Store, work: { importanceMaterials: ImportanceMaterial[] }, task: Task, generated: { content: string }) {
      const current = target.prepareResult(store, task);
      if (!current || fingerprint(work.importanceMaterials, task.payload.model, task.payload.effort) !== current.inputHash) {
        throw Object.assign(new Error("评分来源已变化或撤权"), { code: "IMPORTANCE_SOURCE_INVALID" });
      }
      const scores = parseImportanceScores(generated.content, work.importanceMaterials, { model: task.payload.model, effort: task.payload.effort }, ports.now());
      if (scores.length !== work.importanceMaterials.length) throw Object.assign(new Error("重要性评分未覆盖完整请求"), {
        code: "IMPORTANCE_OUTPUT_INVALID"
      });
      store.importanceScores ||= [];
      for (const score of scores) {
        const index = store.importanceScores.findIndex(item => item.kind === "model" && item.accountId === score.accountId
          && item.sourceKey === score.sourceKey && item.sourceVersion === score.sourceVersion
          && item.contentSha256 === score.contentSha256 && item.model === score.model && item.effort === score.effort
          && item.scoringVersion === score.scoringVersion);
        if (index < 0) store.importanceScores.push(score);
        else store.importanceScores[index] = score;
      }
      return task.targetId;
    },
    result(store: Store, task: Task) {
      return materialFor(store, task.payload.sourceRefs).filter((item): item is ImportanceMaterial => Boolean(item))
        .map(item => importanceScoreFor(item, store.importanceScores || [], { model: task.payload.model, effort: task.payload.effort })).filter(Boolean);
    }
  };
  const service = {
    target,
    get batches() {
      return batches;
    },
    attach(value: NonNullable<typeof background>) {
      background = value;
    },
    async enqueue(sourceRefs: ImportanceSourceRef[], clientRequestId: string) {
      if (!background || !clientRequestId || !Array.isArray(sourceRefs) || !sourceRefs.length
        || sourceRefs.length > IMPORTANCE_BATCH_SIZE) return { invalid: true };
      const store = await ports.repository.read();
      const resolved = materialFor(store, sourceRefs);
      if (resolved.some(item => !item)) return { invalid: true, code: "IMPORTANCE_SOURCE_INVALID" };
      let materials = resolved as ImportanceMaterial[];
      if (new Set(materials.map(item => item.sourceKey)).size !== materials.length) return { invalid: true };
      const choice = await ports.modelChoice();
      if (!choice) return { invalid: true, code: "IMPORTANCE_MODEL_UNCONFIGURED" };
      if (materials.every(item => importanceScoreFor(item, store.importanceScores || [], choice))) {
        return { cached: true, scores: materials.map(item => importanceScoreFor(item, store.importanceScores || [], choice)) };
      }
      sourceRefs = sourceRefs.filter((_ref, index) => !importanceScoreFor(materials[index]!, store.importanceScores || [], choice));
      materials = materialFor(store, sourceRefs) as ImportanceMaterial[];
      return background.enqueue({ kind: "importanceScoring", targetId: sourceRefs[0]!.rootId || sourceRefs[0]!.resourceId,
        resourceType: sourceRefs[0]!.resourceType, clientRequestId,
        payload: { sourceRefs, model: choice.model, effort: choice.effort,
          fingerprint: fingerprint(materials, choice.model, choice.effort) } });
    },
    async read(sourceRefs: ImportanceSourceRef[]) {
      if (!Array.isArray(sourceRefs) || !sourceRefs.length || sourceRefs.length > IMPORTANCE_BATCH_SIZE) {
        return { invalid: true };
      }
      const store = await ports.repository.read();
      const materials = materialFor(store, sourceRefs);
      if (materials.some(item => !item)) return { invalid: true, code: "IMPORTANCE_SOURCE_INVALID" };
      const choice = await ports.modelChoice();
      return { tasks: Array.isArray(store.aiTasks) ? store.aiTasks.filter(value => {
        if (!value || typeof value !== "object") return false;
        const task = value as Task & { kind?: string };
        return task.kind === "importanceScoring" && Array.isArray(task.payload?.sourceRefs)
          && task.payload.sourceRefs.some(ref => sourceRefs.some(input => ["resourceType", "resourceId", "rootId", "targetKey", "version"].every(key => ref[key as keyof ImportanceSourceRef] === input[key as keyof ImportanceSourceRef])));
      }).map(value => {
        const task = value as Task & { status?: string; errorCode?: string };
        return { id: task.id, status: task.status, errorCode: task.errorCode || "" };
      }) : [], scores: (materials as ImportanceMaterial[]).map(material => ({
        sourceKey: material.sourceKey,
        version: material.version,
        score: importanceScoreFor(material, store.importanceScores || [], choice || undefined)
      })) };
    },
    async correct(sourceRef: ImportanceSourceRef, score: number) {
      if (!Number.isFinite(score) || score < 0 || score > 100) return { invalid: true };
      return ports.repository.update(store => {
        const material = ports.resolve(store, sourceRef);
        if (!material) return { invalid: true, code: "IMPORTANCE_SOURCE_INVALID" };
        const correction: ImportanceScore = { accountId: material.accountId, sourceKey: material.sourceKey,
          sourceVersion: material.version, contentSha256: material.contentSha256, scoringVersion: IMPORTANCE_SCORING_VERSION,
          permissionRevision: material.permissionRevision ?? 0,
          model: "manual", score, reasons: ["explicit_user_correction"], kind: "correction", generatedAt: ports.now() };
        store.importanceScores = (store.importanceScores || []).filter(item => !(item.kind === "correction"
          && item.accountId === material.accountId && item.sourceKey === material.sourceKey));
        store.importanceScores.push(correction);
        return { score: correction };
      });
    }
  };
  if (ports.accountId && ports.list && ports.createBusinessId) batches = createImportanceBatches({
    repository: ports.repository, accountId: ports.accountId, createBusinessId: ports.createBusinessId, list: ports.list, choice: ports.modelChoice,
    hash: ports.hash, now: ports.now, enqueue: service.enqueue
  });
  return service;
}
