// @ts-expect-error Generated config has no declaration file yet.
import { THOUGHT_PAGING } from "../../../generated/thought-pagination-config.mjs";
// @ts-expect-error Generated state facade has no declaration file yet.
import { recordEntityKey } from "../../../generated/state/record-sync.mjs";
// @ts-expect-error Existing thoughts model remains JavaScript-owned.
import { applyThoughtWindowSync, applyThoughtDetailSync } from "../../features/thoughts/model.mjs";
// @ts-expect-error Existing session facade remains JavaScript-owned.
import { sessionScope } from "../../session/index.mjs";
// @ts-expect-error Existing state facade remains JavaScript-owned.
import { mergeStateSnapshot, publishDomains, state } from "../../state/index.mjs";
import type { SyncStatusEvent } from "../../shared/incremental-sync.mjs";

type DataSyncRuntimeOptions = {
  runtime: any;
  requestCoordinator: any;
  getActionsCoordinator(): any;
  requestV1(url: string, options?: any): Promise<any>;
  syncScope(): string;
  syncWorkspace(): string;
  captureDataScope(): any;
  restorePendingProjections(consumer: any): Promise<unknown>;
  refreshState(domains: string[], options: { isCurrent(): boolean }): Promise<unknown>;
  createIncrementalSync(options: any): any;
  createRecordSyncLoop(options: any): any;
  applyRecordBatch(batch: any, context: any): any;
  rebaseRecordScopes(payload: any, context: any): any;
};

/** 组装 v1/v2 同步控制器；调用方继续拥有请求、恢复和页面渲染语义。 */
export function createDataSyncRuntime({
  runtime,
  requestCoordinator,
  getActionsCoordinator,
  requestV1,
  syncScope,
  syncWorkspace,
  captureDataScope,
  restorePendingProjections,
  refreshState,
  createIncrementalSync,
  createRecordSyncLoop,
  applyRecordBatch,
  rebaseRecordScopes
}: DataSyncRuntimeOptions) {
  const syncErrors = { v1: "", v2: "" };
  async function applyIncrementalSnapshot(snapshot: any, changes: any[], consumer = captureDataScope()) {
    if (!consumer.isCurrent()) return false;
    let incoming = snapshot;
    let thoughtWindowInvalidated = false;
    if (runtime.featureFlags?.recordSyncV2 && Object.hasOwn(incoming || {}, "thoughts")) {
      const { thoughts: _recordOwnedThoughts, ...legacyOnly } = incoming;
      incoming = legacyOnly;
    }
    if (!runtime.featureFlags?.recordSyncV2
      && runtime.featureFlags?.thoughtPaging?.enabled
      && Object.hasOwn(snapshot || {}, "thoughts")) {
      const { thoughts: _fullThoughts, ...other } = snapshot;
      const route = runtime.pageRouter?.currentRoute();
      if (route?.view === "thoughts" && route.kind !== "detail" && state.thoughtPage?.kind === "list") {
        thoughtWindowInvalidated = applyThoughtWindowSync(state, snapshot.thoughts, route, THOUGHT_PAGING, (id: string) => {
          const card = document.querySelector(`#all-thoughts [data-chain-id="${CSS.escape(id)}"]`);
          if (runtime.annotationsController?.isActiveRoot?.(`thought:${id}`)) return false;
          if (!card) return true;
          if (card.contains(document.activeElement)) return false;
          const selection = document.getSelection();
          if (selection && !selection.isCollapsed
            && (card.contains(selection.anchorNode) || card.contains(selection.focusNode))) return false;
          const rect = card.getBoundingClientRect();
          return rect.bottom <= 0 || rect.top >= window.innerHeight;
        }, changes);
        incoming = other;
      } else if (route?.view === "thoughts" && route.kind === "detail") {
        incoming = {
          ...other,
          thoughts: applyThoughtDetailSync(state.thoughts || [], snapshot.thoughts, route.resourceId)
        };
      } else incoming = other;
    }
    const domains = mergeStateSnapshot(incoming);
    getActionsCoordinator().applyIncrementalSnapshot(snapshot, { sessionTicket: sessionScope.capture() });
    const rendered = new Set([...domains].filter(domain => !["actions", "habits", "habitCheckins"].includes(domain)));
    if (thoughtWindowInvalidated || domains.has("thoughtPage")) rendered.add("thoughts");
    if (domains.has("clusters") || domains.has("insights")) rendered.add("review");
    if (rendered.size) publishDomains(rendered);
    if (!consumer.isCurrent()) return false;
    await restorePendingProjections(consumer);
    return consumer.isCurrent() ? changes.length : false;
  }

  async function updateSyncHealth(event: SyncStatusEvent) {
    const consumer = captureDataScope();
    if (!consumer.owner || event.owner && event.owner !== consumer.owner
      || event.workspace != null && event.workspace !== consumer.workspace
      || event.scope != null && event.scope !== syncScope()) return;
    if (event.type === "operation") getActionsCoordinator().applyOperationStatus(event);
    if (event.type === "error") syncErrors.v1 = event.code || "SYNC_FAILED";
    else if (event.type === "record-error") syncErrors.v2 = event.code || "SYNC_V2_FAILED";
    else if (["pull", "resnapshot"].includes(event.type)) syncErrors.v1 = "";
    else if (["record-pull", "record-rebase"].includes(event.type)) syncErrors.v2 = "";
    const metrics = await requestCoordinator.metrics(consumer.owner);
    if (!consumer.isCurrent()) return;
    const oldest = metrics.oldestPendingAt
      ? Math.max(0, Date.now() - new Date(metrics.oldestPendingAt).getTime())
      : 0;
    runtime.syncHealth = {
      status: event.type === "disabled"
        ? "disabled"
        : metrics.conflicts
          ? "conflict"
          : syncErrors.v1 || syncErrors.v2 || metrics.failed
            ? "error"
            : metrics.pending
              ? "pending"
              : metrics.durable ? "synced" : "degraded",
      pending: metrics.pending,
      conflicts: metrics.conflicts,
      failed: metrics.failed,
      oldestAgeMs: oldest,
      enqueueToAckP95Ms: metrics.enqueueToAckP95Ms,
      lastPullMs: ["pull", "record-pull"].includes(event.type)
        ? event.durationMs
        : runtime.syncHealth.lastPullMs,
      lastError: syncErrors.v2 || syncErrors.v1
    };
    runtime.runtimeFeatureRegistry?.notifyState(state, new Set(["syncHealth"]));
  }

  const legacySyncController = createIncrementalSync({
    coordinator: requestCoordinator,
    request: (url: string, options: any) => requestV1(url, options),
    getScope: syncScope,
    getWorkspace: syncWorkspace,
    getSignal: () => sessionScope.capture().signal,
    applySnapshot: applyIncrementalSnapshot,
    resnapshot: async (consumer: any) => {
      if (!consumer.isCurrent()) return false;
      const domains = [
        "checkins", "dailyRecords", "captures", "journals", "chat", "review",
        "books", "keepsakes", "quotes", "notifications", "onboardingV2", "feedback"
      ];
      if (!runtime.featureFlags?.recordSyncV2) domains.splice(4, 0, "thoughts");
      const applied = await refreshState(domains, { isCurrent: consumer.isCurrent });
      if (!consumer.isCurrent()) return false;
      if (applied === false) throw new Error("同步重读尚未应用");
      const actionsApplied = await getActionsCoordinator().load({ isCurrent: consumer.isCurrent });
      if (actionsApplied === false && consumer.isCurrent()) throw new Error("行动同步重读尚未应用");
      return consumer.isCurrent();
    },
    onStatus: (event: SyncStatusEvent) => void updateSyncHealth(event)
  });

  function activeRecordScopes() {
    const route = runtime.pageRouter?.currentRoute() || { view: "today", query: {} };
    if (route.view === "thoughts" && route.kind === "detail" && route.resourceId) {
      const scopeKey = `thoughtDetail:${route.resourceId}`;
      return { activeScopeKey: scopeKey, scopes: [{ scopeKey, kind: "thoughtDetail", id: route.resourceId }] };
    }
    const scopeKey = route.view === "thoughts" ? "thoughtPage:active" : "thoughtPage:home";
    return {
      activeScopeKey: scopeKey,
      scopes: [{
        scopeKey,
        kind: "thoughtPage",
        query: route.query?.q || "",
        tag: route.query?.tag || "",
        sort: route.query?.sort === "created" ? "created" : "occurred",
        cursor: route.view === "thoughts" ? route.query?.cursor || "" : "",
        direction: route.view === "thoughts" ? route.query?.direction || "next" : "next"
      }]
    };
  }

  const recordSyncContext = (consumer: any) => ({
    accountId: consumer.owner,
    workspace: consumer.workspace,
    generation: consumer.generation
  });
  function hydrateRecordScopes(cursor: number, consumer: any) {
    if (!consumer.isCurrent()) return false;
    const request = activeRecordScopes();
    const scope = request.scopes[0];
    if (!scope) return false;
    const detail = scope.kind === "thoughtDetail";
    if (detail && state.thoughtPage?.kind !== "detail") return false;
    if (!detail && state.thoughtPage?.kind !== "list") return false;
    const rootId = detail ? (scope as { id?: string }).id : "";
    const values = (state.thoughts || []).filter((item: any) => !item?._sync && (detail
      ? item.id === rootId || item.relatedTo === rootId
      : item.type === "question"));
    const entities = values.map((item: any) => {
      const block = detail && item.id !== rootId;
      const key = {
        entityType: block ? "thoughtBlock" : "thoughtChain",
        entityId: item.id,
        parentType: block ? "thoughtChain" : null,
        parentId: block ? rootId : null
      };
      return {
        key,
        version: Math.max(1, Number(item.version) || 1),
        deliveryCursor: cursor,
        projection: structuredClone(item),
        tombstone: false
      };
    });
    rebaseRecordScopes({
      highWaterCursor: cursor,
      activeScopeKey: request.activeScopeKey,
      scopes: [{
        scopeKey: scope.scopeKey,
        descriptorVersion: 1,
        kind: scope.kind,
        entities,
        orderedEntityKeys: entities.map((entity: any) => recordEntityKey(entity.key)),
        metadata: { ...(state.thoughtPage || {}) }
      }]
    }, recordSyncContext(consumer));
    return consumer.isCurrent();
  }

  const recordSyncController = createRecordSyncLoop({
    request: (url: string, options: any) => requestV1(url, options),
    getScope: syncScope,
    getWorkspace: syncWorkspace,
    getRouteGeneration: () => runtime.routeDataRequestSerial,
    getSignal: () => sessionScope.capture().signal,
    getScopes: activeRecordScopes,
    hydrateScopes: hydrateRecordScopes,
    applyBatch: async (batch: any, consumer: any) => {
      if (!consumer.isCurrent()) return { committed: false, staleScopeKeys: [] };
      const result = applyRecordBatch(batch, recordSyncContext(consumer));
      if (!consumer.isCurrent()) return { committed: false, staleScopeKeys: [] };
      if (Array.isArray(batch.changes) && batch.changes.length) publishDomains(new Set(["thoughts"]));
      await restorePendingProjections(consumer);
      return result;
    },
    rebaseScopes: async (payload: any, consumer: any) => {
      if (!consumer.isCurrent()) return false;
      const result = rebaseRecordScopes(payload, recordSyncContext(consumer));
      if (!consumer.isCurrent()) return false;
      const domains = new Set(["thoughts"]);
      if (payload?.speech && typeof payload.speech === "object") {
        mergeStateSnapshot({ speech: payload.speech });
        domains.add("speech");
      }
      publishDomains(domains);
      await restorePendingProjections(consumer);
      return result;
    },
    onStatus: (event: SyncStatusEvent) => void updateSyncHealth(event)
  });

  runtime.syncController = {
    async start(owner: string, options: Record<string, unknown> = {}) {
      syncErrors.v1 = "";
      syncErrors.v2 = "";
      const [legacy, records] = await Promise.all([
        legacySyncController.start(owner, options),
        recordSyncController.start(owner, { recordSync: runtime.featureFlags?.recordSyncV2 === true })
      ]);
      return Boolean(legacy || records);
    },
    stop() {
      legacySyncController.stop();
      recordSyncController.stop();
      syncErrors.v1 = "";
      syncErrors.v2 = "";
    },
    async pull() {
      return Promise.all([legacySyncController.pull(), recordSyncController.pull()]);
    },
    async drain(options: Record<string, unknown>) {
      return legacySyncController.drain(options);
    },
    rebaseRecords() {
      return recordSyncController.rebase();
    },
    cursor: () => ({ v1: legacySyncController.cursor(), v2: recordSyncController.cursor() })
  };

  return { applyIncrementalSnapshot, updateSyncHealth };
}
