import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const registryPath = path.join(ROOT, "knowledge/module-boundaries.json");
const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
assert.equal(registry.version, 1, "Unsupported module boundary registry version");
assert.ok(Array.isArray(registry.modules) && registry.modules.length, "Module registry is empty");
assert.equal(new Set(registry.modules.map(module => module.id)).size, registry.modules.length, "Duplicate module IDs");

const normalized = value => value.split(path.sep).join("/");
const absolute = value => path.resolve(ROOT, value);
const exists = async value => Boolean(await fs.stat(value).catch(() => null));

for (const module of registry.modules) {
  assert.ok(module.id && module.root && module.publicEntry, "Each module needs id, root and publicEntry");
  assert.ok(await exists(absolute(module.root)), `Missing module root: ${module.root}`);
  assert.ok(await exists(absolute(module.publicEntry)), `Missing public entry: ${module.publicEntry}`);
  assert.ok(module.tests?.length, `Module has no tests: ${module.id}`);
  for (const id of module.allowedDependencies) assert.ok(registry.modules.some(item => item.id === id), `Unknown dependency: ${module.id} -> ${id}`);
  for (const test of module.tests || []) assert.ok(await exists(absolute(test)), `Missing module test: ${test}`);
}
for (const exception of registry.migrationExceptions || []) {
  assert.ok(await exists(absolute(exception.path)), `Missing migration exception path: ${exception.path}`);
  assert.ok(exception.owner && exception.removeWhen, `Incomplete migration exception: ${exception.path}`);
}

const sourceFiles = [];
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) sourceFiles.push(file);
  }
}
if (await exists(path.join(ROOT, "src"))) await walk(path.join(ROOT, "src"));
if (await exists(path.join(ROOT, "public/frontend"))) await walk(path.join(ROOT, "public/frontend"));
for (const file of ["server.mjs", "public/app.js", ...await fs.readdir(path.join(ROOT, "scripts")).then(names => names.filter(name => name.endsWith(".mjs")).map(name => `scripts/${name}`))]) {
  sourceFiles.push(absolute(file));
}

const modules = registry.modules.map(module => ({
  ...module,
  rootAbsolute: absolute(module.root),
  entryAbsolute: absolute(module.publicEntry)
}));
const dependencyGraph = new Map(modules.map(module => [module.id, new Set()]));
const routeOwners = new Map();

for (const module of modules) {
  for (const route of module.owns?.routes || []) {
    assert.ok(!routeOwners.has(route), `Route has multiple owners: ${route}`);
    routeOwners.set(route, module.id);
  }
}

for (const file of sourceFiles) {
  const source = await fs.readFile(file, "utf8");
  const importerModule = modules.find(module => file === module.entryAbsolute || file.startsWith(`${module.rootAbsolute}${path.sep}`));
  if ((file === absolute("server.mjs") || file.startsWith(absolute("src/") + path.sep)) && importerModule?.id !== "config") {
    assert.ok(!/\bprocess\s*(?:\.\s*env|\[\s*["']env["']\s*\])/.test(source), `Runtime environment access bypasses config: ${normalized(path.relative(ROOT, file))}`);
  }
  if (file.startsWith(absolute("src/") + path.sep) || file.startsWith(absolute("public/frontend/") + path.sep)) {
    assert.ok(importerModule, `Unregistered module source: ${normalized(path.relative(ROOT, file))}`);
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  }
  if ((importerModule?.id.startsWith("frontend.") || file === absolute("public/app.js")) && importerModule?.id !== "frontend.api") {
    assert.ok(!/\bfetch\s*\(|\b(?:globalThis|window)\.fetch\b/.test(source), `Frontend request bypasses API module: ${normalized(path.relative(ROOT, file))}`);
  }
  if (importerModule?.type === "domain") {
    assert.ok(!/\bfetch\s*\(|\bglobalThis\.fetch\b/.test(source), `Domain performs network I/O: ${normalized(path.relative(ROOT, file))}`);
  }
  const imports = [
    ...source.matchAll(/\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)
  ].map(match => match[1]);
  for (const specifier of imports) {
    if (importerModule?.type === "domain" && !specifier.startsWith(".")) {
      assert.ok(specifier.startsWith("node:") && !/^node:(?:fs|http|https|net|tls|child_process|dgram)(?:\/|$)/.test(specifier), `Domain imports an I/O adapter or external SDK: ${normalized(path.relative(ROOT, file))} -> ${specifier}`);
    }
    if (!specifier.startsWith(".")) continue;
    let target = path.resolve(path.dirname(file), specifier);
    if (!path.extname(target)) target += ".mjs";
    assert.ok(await exists(target), `Missing import: ${normalized(path.relative(ROOT, file))} -> ${specifier}`);
    const targetModule = modules.find(module => target === module.entryAbsolute || target.startsWith(`${module.rootAbsolute}${path.sep}`));
    if (!targetModule) continue;
    if (!importerModule || importerModule.id !== targetModule.id) {
      assert.equal(target, targetModule.entryAbsolute, `Deep import into ${targetModule.id}: ${normalized(path.relative(ROOT, file))} -> ${normalized(path.relative(ROOT, target))}`);
    }
    if (importerModule && importerModule.id !== targetModule.id) {
      assert.ok(importerModule.allowedDependencies.includes(targetModule.id), `${importerModule.id} cannot depend on ${targetModule.id}`);
      dependencyGraph.get(importerModule.id).add(targetModule.id);
    }
    if (importerModule?.type === "shared") assert.ok(!["domain", "page", "feature"].includes(targetModule.type), `Shared module ${importerModule.id} cannot depend on ${targetModule.type} ${targetModule.id}`);
  }
}

const visiting = new Set();
const visited = new Set();
function visit(id) {
  if (visiting.has(id)) throw new Error(`Module dependency cycle detected at ${id}`);
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of dependencyGraph.get(id) || []) visit(dependency);
  visiting.delete(id);
  visited.add(id);
}
for (const module of modules) visit(module.id);

console.log(`Module boundary checks passed: ${modules.length} active modules, ${routeOwners.size} owned routes, no deep imports or cycles.`);
