import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const parseJson = (text, file) => {
  try { return JSON.parse(text); }
  catch { throw new Error(`Prompt catalog JSON is invalid: ${file}`); }
};

export async function loadPromptCatalog({ rootDir, requestedVersion = "" }) {
  const directory = path.join(rootDir, "prompts");
  const manifestFile = path.join(directory, "manifest.json");
  const manifest = parseJson(await fs.readFile(manifestFile, "utf8"), manifestFile);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.versions)) throw new Error("Prompt manifest schema is unsupported");
  const version = String(requestedVersion || manifest.activeVersion || "");
  const selected = manifest.versions.find(item => item.version === version);
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
  for (const id of manifest.requiredPromptIds || []) if (!prompts[id]) throw new Error(`Required prompt is missing: ${id}`);
  return Object.freeze({ version, sha256, prompts: Object.freeze(prompts) });
}
