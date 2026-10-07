let activeCatalog = null;

const placeholderPattern = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;

export function installPromptCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || !catalog.version || !catalog.sha256 || !catalog.prompts) {
    throw new Error("Prompt catalog is invalid");
  }
  activeCatalog = Object.freeze({
    version: String(catalog.version),
    sha256: String(catalog.sha256),
    prompts: Object.freeze({ ...catalog.prompts }),
    rolePromptIds: Object.freeze({ ...(catalog.rolePromptIds || {}) }),
    capabilities: Object.freeze({ ...(catalog.capabilities || {}) })
  });
  return activeCatalog;
}

function current() {
  if (!activeCatalog) throw new Error("Prompt catalog has not been installed");
  return activeCatalog;
}

export function promptText(id) {
  const value = current().prompts[id];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Prompt is missing: ${id}`);
  return value;
}

export function optionalPromptText(id) {
  const value = current().prompts[id];
  return typeof value === "string" ? value : "";
}

export function promptRoleId(role) {
  const id = current().rolePromptIds[role];
  return typeof id === "string" ? id : "";
}

export function renderPrompt(id, values = {}) {
  const template = promptText(id);
  const required = new Set([...template.matchAll(placeholderPattern)].map(match => match[1]));
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`Prompt variable is missing: ${id}.${key}`);
  }
  return template.replace(placeholderPattern, (_, key) => String(values[key] ?? ""));
}

export function promptCatalogMetadata() {
  const { version, sha256 } = current();
  return { version, sha256 };
}

export function promptCatalogCapabilities() {
  const { rolePromptIds, capabilities } = current();
  return {
    rolePromptIds: { ...rolePromptIds },
    capabilities: { ...capabilities }
  };
}
