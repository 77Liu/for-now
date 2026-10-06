function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Owner console requires ${name}`);
  }
  return value;
}

export function normalizeOwnerConsolePorts({
  request,
  requestWithMetadata,
  settings,
  capability,
  format,
  navigation,
  toast,
  confirm,
  timer
} = {}) {
  const normalized = {
    request: requireFunction(request, "request"),
    requestWithMetadata: requireFunction(requestWithMetadata, "requestWithMetadata"),
    settings: Object.freeze({
      snapshot: requireFunction(settings?.snapshot, "settings.snapshot"),
      currentDate: requireFunction(settings?.currentDate, "settings.currentDate")
    }),
    capability: Object.freeze({
      has: requireFunction(capability?.has, "capability.has"),
      accountId: requireFunction(capability?.accountId, "capability.accountId"),
      sessionGeneration: requireFunction(
        capability?.sessionGeneration,
        "capability.sessionGeneration"
      )
    }),
    format: Object.freeze({
      escapeMarkup: requireFunction(format?.escapeMarkup, "format.escapeMarkup"),
      escapeSelector: requireFunction(format?.escapeSelector, "format.escapeSelector"),
      cny: requireFunction(format?.cny, "format.cny"),
      compactNumber: requireFunction(format?.compactNumber, "format.compactNumber"),
      date: requireFunction(format?.date, "format.date"),
      shiftDateKey: requireFunction(format?.shiftDateKey, "format.shiftDateKey")
    }),
    navigation: Object.freeze({
      openView: requireFunction(navigation?.openView, "navigation.openView"),
      openSource: requireFunction(navigation?.openSource, "navigation.openSource")
    }),
    toast: requireFunction(toast, "toast"),
    confirm: requireFunction(confirm, "confirm"),
    timer: Object.freeze({
      schedule: requireFunction(timer?.schedule, "timer.schedule"),
      cancel: requireFunction(timer?.cancel, "timer.cancel")
    })
  };
  return Object.freeze(normalized);
}

export function ownerRequestOptions(signal, options = {}) {
  return signal ? { ...options, signal } : options;
}
