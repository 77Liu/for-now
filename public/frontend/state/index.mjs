import { createRecordState } from "../../generated/state/record-sync.mjs";

export const emptyClientState = { checkins: [], dailyRecords: [], captures: [], journals: [], journalDraft: null, thoughts: [], thoughtPage: { kind: "list", nextCursor: null, query: "", tag: "", sort: "occurred", page: 1, tags: [] }, chats: [], books: [], keepsakes: [], quotes: [], quoteTags: [], experiments: [], analyses: [], analysisPage: { nextCursor: null, total: 0 }, customMetrics: [], aiTasks: [], notifications: [], notificationUnread: 0, speech: { configured: false, defaultVoice: "", voices: [], supportedAsrMimeTypes: [], assets: [] }, vision: { configured: false }, onboarding: { status: "pending", questionnaireMode: "quick", answers: {}, profile: {}, interests: [], material: "", understanding: "" }, onboardingV2: null, clusters: [], insights: { trends: [], associations: [], aiOnlyThoughtIds: [], weekly: {} }, reviewSourceCount: 0 };
export let state = structuredClone(emptyClientState);
const recordState = createRecordState();
const subscribers = new Set();
export function replaceState(value) { state = value; }
export function mergeStateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return new Set();
  const domains = new Set(Object.keys(snapshot));
  state = { ...state, ...structuredClone(snapshot) };
  return domains;
}
function projectRecordThoughts() {
  const projected = recordState.selectLegacyDomain("thoughts");
  const pending = (state.thoughts || []).filter(item => item?._sync);
  const identities = new Set(projected.map(item => item.id));
  const scope = recordState.selectActiveScope();
  const { window: _oldWindow, ...previousPage } = state.thoughtPage || {};
  const thoughtPage = scope?.kind === "thoughtPage"
    ? { ...previousPage, ...scope.metadata, kind: "list", page: 1, stale: scope.stale }
    : scope?.kind === "thoughtDetail"
      ? { ...previousPage, ...scope.metadata, kind: "detail", page: 1, stale: scope.stale }
      : state.thoughtPage;
  state = {
    ...state,
    thoughts: [...projected, ...pending.filter(item => !identities.has(item.id))],
    thoughtPage
  };
}
/** v2 batches merge only here; transport persists the cursor after this returns. */
export function applyRecordBatch(batch, context) {
  const result = recordState.applyRecordBatch(batch, context);
  projectRecordThoughts();
  return result;
}
/** Rebase replaces only requested memberships and preserves drafts, queues and other domains. */
export function rebaseRecordScopes(payload, context) {
  const result = recordState.rebaseScopes(payload, context);
  projectRecordThoughts();
  return result;
}
export function inspectRecordState() { return recordState.inspect(); }
export function resetState() {
  recordState.reset();
  state = structuredClone(emptyClientState);
}
export function subscribeState(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}
export function publishDomains(domains, options = {}) {
  for (const listener of subscribers) listener(state, domains, options);
}

// Requests can overlap; only the newest response commits, carrying all pending domains.
/** 可选options.isCurrent自unreleased起限定本次消费；guard只传给afterReplace，不进入渲染选项。 */
export function createRefreshCoordinator({ session, requestState, afterReplace = async () => {} }) {
  let serial = 0, pending = new Set(), pendingOptions = {};
  return {
    reset() { serial += 1; pending.clear(); pendingOptions = {}; },
    async refresh(domains, options = {}) {
      const { isCurrent: consumerCurrent = () => true, ...renderOnlyOptions } = options;
      if (!consumerCurrent()) return false;
      for (const domain of Array.isArray(domains) ? domains : [domains]) pending.add(domain);
      if (renderOnlyOptions.chainId) pendingOptions = { ...pendingOptions, ...renderOnlyOptions };
      const requestSerial = ++serial, ticket = session.capture(), next = await requestState();
      const current = () => requestSerial === serial && session.isCurrent(ticket) && consumerCurrent();
      if (!current()) return false;
      replaceState(next);
      if (!current()) return false;
      await afterReplace({ isCurrent: current });
      if (!current()) return false;
      const wanted = new Set(pending), renderOptions = pendingOptions;
      pending.clear();
      pendingOptions = {};
      publishDomains(wanted, renderOptions);
      return true;
    }
  };
}
