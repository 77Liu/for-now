import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const parseJson = (text, file) => {
  try { return JSON.parse(text); }
  catch { throw new Error(`Prompt catalog JSON is invalid: ${file}`); }
};
const REQUIRED_ROLE_NAMES = Object.freeze([
  "perception",
  "modelUpdate",
  "periodicSynthesis",
  "contextPlanning",
  "answer",
  "answerCheck"
]);

export async function loadPromptCatalog({
  rootDir,
  requestedVersion = "",
  requiredCapabilities = [],
  allowHistorical = false
}) {
  const directory = path.join(rootDir, "prompts");
  const manifestFile = path.join(directory, "manifest.json");
  const manifest = parseJson(await fs.readFile(manifestFile, "utf8"), manifestFile);
  if (![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.versions)) {
    throw new Error("Prompt manifest schema is unsupported");
  }
  const version = String(requestedVersion || manifest.activeVersion || "");
  const selectedIndex = manifest.versions.findIndex(item => item.version === version);
  const selected = manifest.versions[selectedIndex];
  if (!selected || !/^[a-zA-Z0-9._-]+\.json$/.test(selected.file || "")) throw new Error(`Prompt catalog version is unavailable: ${version}`);
  const versionFile = path.join(directory, "versions", selected.file);
  const raw = await fs.readFile(versionFile);
  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  if (sha256 !== selected.sha256) throw new Error(`Prompt catalog hash mismatch: ${version}`);
  const document = parseJson(raw.toString("utf8"), versionFile);
  if (document.schemaVersion !== 1 || document.version !== version || !document.prompts || Array.isArray(document.prompts)) {
    throw new Error(`Prompt catalog content is invalid: ${version}`);
  }
  const prompts = {};
  for (const [id, value] of Object.entries(document.prompts)) {
    if (!/^[a-z][a-z0-9]*(?:\.[a-zA-Z0-9]+)+$/.test(id) || typeof value !== "string" || !value.trim()) {
      throw new Error(`Prompt entry is invalid: ${id}`);
    }
    prompts[id] = value;
    const placeholders = [...new Set([...value.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g)].map(match => match[1]))].sort();
    if (value.replace(/\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g, "").includes("{{") || value.replace(/\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g, "").includes("}}")) {
      throw new Error(`Prompt placeholder is malformed: ${id}`);
    }
    const expected = manifest.promptVariables?.[id];
    if (placeholders.length || expected) {
      if (!Array.isArray(expected) || JSON.stringify([...expected].sort()) !== JSON.stringify(placeholders)) {
        throw new Error(`Prompt variables do not match manifest: ${id}`);
      }
    }
  }
  for (const id of manifest.requiredPromptIds || []) {
    const introducedIn = manifest.promptIntroducedIn?.[id];
    if (introducedIn) {
      const introducedIndex = manifest.versions.findIndex(item => item.version === introducedIn);
      if (introducedIndex < 0) throw new Error(`Prompt introduction version is unavailable: ${id}`);
      if (selectedIndex < introducedIndex) continue;
    }
    if (!prompts[id]) throw new Error(`Required prompt is missing: ${id}`);
  }
  const rolePromptIds = manifest.rolePromptIds;
  if (manifest.schemaVersion >= 2 || rolePromptIds != null) {
    if (typeof rolePromptIds !== "object"
      || Array.isArray(rolePromptIds)
      || JSON.stringify(Object.keys(rolePromptIds).sort())
        !== JSON.stringify([...REQUIRED_ROLE_NAMES].sort())
      || new Set(Object.values(rolePromptIds)).size !== REQUIRED_ROLE_NAMES.length) {
      throw new Error("Prompt role contracts are invalid");
    }
    for (const id of Object.values(rolePromptIds)) {
      if (typeof id !== "string" || !manifest.requiredPromptIds.includes(id)) {
        throw new Error(`Prompt role is not required: ${id}`);
      }
      const introducedIn = manifest.promptIntroducedIn?.[id];
      const introducedIndex = manifest.versions.findIndex(item => item.version === introducedIn);
      if (introducedIndex < 0) throw new Error(`Prompt role introduction is unavailable: ${id}`);
      if (selectedIndex >= introducedIndex && !prompts[id]) {
        throw new Error(`Prompt role is missing: ${id}`);
      }
    }
  }
  const capabilities = manifest.capabilities;
  if (manifest.schemaVersion >= 2
    && (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities))) {
    throw new Error("Prompt capabilities are invalid");
  }
  for (const capability of requiredCapabilities) {
    const introducedIn = capabilities?.[capability];
    const introducedIndex = manifest.versions.findIndex(item => item.version === introducedIn);
    if (introducedIndex < 0 || selectedIndex < introducedIndex) {
      throw new Error(`Prompt catalog capability is unavailable: ${capability}`);
    }
  }
  if (manifest.schemaVersion >= 2 && !allowHistorical) {
    const structuredVersion = capabilities?.structuredWorkingContext;
    const structuredIndex = manifest.versions.findIndex(item => item.version === structuredVersion);
    if (structuredIndex < 0 || selectedIndex < structuredIndex) {
      throw new Error("Prompt catalog capability is unavailable: structuredWorkingContext");
    }
  }
  return Object.freeze({
    version,
    sha256,
    prompts: Object.freeze(prompts),
    rolePromptIds: Object.freeze({ ...(rolePromptIds || {}) }),
    capabilities: Object.freeze({ ...(capabilities || {}) })
  });
}
