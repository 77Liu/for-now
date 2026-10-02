export const emptyClientState = { checkins: [], dailyRecords: [], captures: [], journals: [], journalDraft: null, thoughts: [], chats: [], books: [], keepsakes: [], quotes: [], experiments: [], analyses: [], customMetrics: [], aiTasks: [], notifications: [], notificationUnread: 0, speech: { configured: false, defaultVoice: "", voices: [], supportedAsrMimeTypes: [] }, vision: { configured: false }, onboarding: { status: "pending", questionnaireMode: "quick", answers: {}, profile: {}, interests: [], material: "", understanding: "" }, onboardingV2: null, clusters: [], insights: { trends: [], associations: [], aiOnlyThoughtIds: [], weekly: {} } };
export let state = structuredClone(emptyClientState);
const subscribers = new Set();
export function replaceState(value) { state = value; }
export function mergeStateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return new Set();
  const domains = new Set(Object.keys(snapshot));
  state = { ...state, ...structuredClone(snapshot) };
  return domains;
}
export function resetState() { state = structuredClone(emptyClientState); }
export function subscribeState(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}
export function publishDomains(domains, options = {}) {
  for (const listener of subscribers) listener(state, domains, options);
}

// Requests can overlap; only the newest response commits, carrying all pending domains.
export function createRefreshCoordinator({ session, requestState, afterReplace = async () => {} }) {
  let serial = 0, pending = new Set(), pendingOptions = {};
  return {
    reset() { serial += 1; pending.clear(); pendingOptions = {}; },
    async refresh(domains, options = {}) {
      for (const domain of Array.isArray(domains) ? domains : [domains]) pending.add(domain);
      if (options.chainId) pendingOptions = { ...pendingOptions, ...options };
      const requestSerial = ++serial, ticket = session.capture(), next = await requestState();
      if (requestSerial !== serial || !session.isCurrent(ticket)) return false;
      replaceState(next);
      await afterReplace();
      if (requestSerial !== serial || !session.isCurrent(ticket)) return false;
      const wanted = new Set(pending), renderOptions = pendingOptions;
      pending.clear();
      pendingOptions = {};
      publishDomains(wanted, renderOptions);
      return true;
    }
  };
}
