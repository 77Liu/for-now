import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, "public");
const BUDGET = Object.freeze({
  blockingStyleRequests: 2,
  blockingStyleBytes: 250 * 1024,
  entryModuleCount: 23,
  entryModuleBytes: 724 * 1024
});

const normalizeAsset = asset => path.posix.normalize(asset.replace(/^\.?\//, ""));
const publicFile = asset => path.join(PUBLIC, ...normalizeAsset(asset).split("/"));
const fileBytes = async asset => (await fs.stat(publicFile(asset))).size;

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] || "";
}

async function blockingStyleClosure(html) {
  const pending = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map(match => match[0])
    .filter(tag => attribute(tag, "rel").split(/\s+/).includes("stylesheet"))
    .map(tag => attribute(tag, "href"))
    .filter(Boolean);
  const assets = new Set();
  let bytes = 0;

  while (pending.length) {
    const asset = normalizeAsset(pending.pop());
    if (assets.has(asset)) continue;
    assets.add(asset);
    const source = await fs.readFile(publicFile(asset), "utf8");
    bytes += await fileBytes(asset);
    for (const match of source.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?/gi)) {
      pending.push(path.posix.join(path.posix.dirname(asset), match[1]));
    }
  }
  return { assets: [...assets].sort(), bytes };
}

const moduleDependencies = source => [
  ...source.matchAll(/\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s*)?["']([^"']+)["']/g),
  ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)
].map(match => match[1]);

async function moduleClosure(entry) {
  const pending = [entry];
  const assets = new Set();
  let bytes = 0;

  while (pending.length) {
    const asset = normalizeAsset(pending.pop());
    if (assets.has(asset)) continue;
    assets.add(asset);
    const source = await fs.readFile(publicFile(asset), "utf8");
    bytes += await fileBytes(asset);
    for (const specifier of moduleDependencies(source)) {
      if (!specifier.startsWith(".")) continue;
      pending.push(path.posix.join(path.posix.dirname(asset), specifier));
    }
  }
  return { assets: [...assets].sort(), bytes };
}

const html = await fs.readFile(publicFile("index.html"), "utf8");
const styles = await blockingStyleClosure(html);
const modules = await moduleClosure("app.js");

assert.ok(
  styles.assets.length <= BUDGET.blockingStyleRequests,
  `首屏阻塞样式请求 ${styles.assets.length} 超过预算 ${BUDGET.blockingStyleRequests}: ${styles.assets.join(", ")}`
);
assert.ok(
  styles.bytes <= BUDGET.blockingStyleBytes,
  `首屏阻塞样式 ${styles.bytes} B 超过预算 ${BUDGET.blockingStyleBytes} B`
);
assert.ok(
  modules.assets.length <= BUDGET.entryModuleCount,
  `入口模块闭包 ${modules.assets.length} 个超过预算 ${BUDGET.entryModuleCount}`
);
assert.ok(
  modules.bytes <= BUDGET.entryModuleBytes,
  `入口模块闭包 ${modules.bytes} B 超过预算 ${BUDGET.entryModuleBytes} B`
);

console.log(
  `Web first-screen budgets passed: ${styles.assets.length} blocking styles / ${styles.bytes} B; ` +
  `${modules.assets.length} entry modules / ${modules.bytes} B.`
);
