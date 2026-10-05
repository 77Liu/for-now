#!/usr/bin/env node
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ENTRYPOINT_POLICY_KINDS,
  isFrozenServerHandlerOrder,
  requiredContractViolations,
  validateEntrypointCrossContracts,
  validateEntrypointExceptions,
  validatePolicyRequirements
} from "./lib/entrypoint-contract-validation.mjs";
import { analyzeEntrypointSource } from "./lib/entrypoint-source-analysis.mjs";

const SCRIPT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RESERVED_RULE_IDS = new Set(["imports", "import-bindings", "calls", "factory-use", "exports", "dynamic-import-literal", "lines.hard"]);
const SYNTAX_KINDS = new Set([
  "arrow-function",
  "class",
  "function",
  "new",
  "regex-literal",
  "computed-global-access",
  "template-literal",
  "variable-declaration"
]);

function reject(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    root: SCRIPT_ROOT,
    registry: "knowledge/module-boundaries.json",
    gate: String(process.env.ENTRYPOINT_GATE || "G3")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node scripts/check-entrypoints.mjs [--root PATH] [--registry PATH] [--gate G0..G7]\n");
      process.exit(0);
    }
    const equals = /^(--root|--registry|--gate)=(.*)$/u.exec(argument);
    const name = equals?.[1] || argument;
    if (!["--root", "--registry", "--gate"].includes(name)) reject(`Unknown argument: ${argument}`);
    const value = equals ? equals[2] : argv[++index];
    if (!value) reject(`${name} requires a value`);
    options[name.slice(2)] = value;
  }
  options.root = path.resolve(options.root);
  options.registry = path.resolve(options.root, options.registry);
  const registryRelative = path.relative(options.root, options.registry);
  if (registryRelative === ".." || registryRelative.startsWith(`..${path.sep}`) || path.isAbsolute(registryRelative)) reject("--registry escapes --root");
  if (!/^G[0-7]$/u.test(options.gate)) reject("--gate must be one of G0 through G7");
  return options;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) reject(`${label} must be a non-empty string`);
  return value;
}

function stringArray(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    reject(`${label} must be ${nonEmpty ? "a non-empty" : "an"} array`);
  }
  for (let index = 0; index < value.length; index += 1) nonEmptyString(value[index], `${label}[${index}]`);
  if (new Set(value).size !== value.length) reject(`${label} must not contain duplicates`);
  return value;
}

function repositoryPath(root, value, label) {
  nonEmptyString(value, label);
  if (path.isAbsolute(value)) reject(`${label} must be relative to --root`);
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    reject(`${label} escapes --root`);
  }
  return absolute;
}

function relativeImportPath(root, importer, specifier, label) {
  const pathname = specifier.split(/[?#]/u, 1)[0];
  const absolute = path.resolve(path.dirname(importer), pathname);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    reject(`${label} escapes --root`);
  }
  return absolute;
}

async function requireFile(root, file, label, { rejectSymlink = false } = {}) {
  const linkStat = await fs.lstat(file).catch(() => null);
  if (!linkStat) reject(`${label} does not exist: ${file}`);
  if (rejectSymlink && linkStat.isSymbolicLink()) reject(`${label} must not be a symbolic link`);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) reject(`${label} does not exist: ${file}`);
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  const relative = path.relative(realRoot, realFile);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    reject(`${label} resolves outside --root`);
  }
  if (rejectSymlink) {
    const expectedReal = path.resolve(realRoot, path.relative(root, file));
    if (realFile !== expectedReal) reject(`${label} path must not contain symbolic links`);
  }
}

async function validateRule(rule, label, knownIds) {
  if (!record(rule)) reject(`${label} must be an object`);
  nonEmptyString(rule.id, `${label}.id`);
  if (RESERVED_RULE_IDS.has(rule.id) || knownIds.has(rule.id)) reject(`${label}.id must be unique and non-reserved`);
  knownIds.add(rule.id);
  if (!["identifier", "call", "literal", "syntax"].includes(rule.kind)) {
    reject(`${label}.kind must be identifier, call, literal, or syntax`);
  }
  stringArray(rule.values, `${label}.values`, { nonEmpty: true });
  if (rule.kind === "syntax" && rule.values.some(value => !SYNTAX_KINDS.has(value))) {
    reject(`${label}.values contains an unsupported syntax kind`);
  }
  if (rule.kind === "literal") {
    const match = rule.match ?? "exact";
    const flags = rule.flags ?? "u";
    if (!["exact", "includes", "startsWith", "endsWith", "regex"].includes(match)) {
      reject(`${label}.match is unsupported`);
    }
    if (!/^(?!.*(.).*\1)[imsu]*$/u.test(flags)) reject(`${label}.flags must contain unique i, m, s, or u flags`);
    if (match === "regex") {
      for (const value of rule.values) {
        try {
          new RegExp(value, flags);
        } catch (error) {
          reject(`${label} has invalid regular expression ${JSON.stringify(value)}: ${error.message}`);
        }
      }
    }
  } else if (rule.match != null || rule.flags != null) {
    reject(`${label}.match and .flags are only valid for literal rules`);
  }
}

async function validatePolicy(root, policy, index, paths, registryInventory) {
  const label = `entrypointPolicies[${index}]`;
  if (!record(policy)) reject(`${label} must be an object`);
  if (!ENTRYPOINT_POLICY_KINDS.has(policy.kind)) reject(`${label}.kind must be server, browser, or bootstrap`);
  const entryPath = nonEmptyString(policy.path, `${label}.path`);
  if (paths.has(entryPath)) reject(`Entrypoint policy path must be unique: ${entryPath}`);
  paths.add(entryPath);
  const entryAbsolute = repositoryPath(root, entryPath, `${label}.path`);
  await requireFile(root, entryAbsolute, `${label}.path`, { rejectSymlink: true });
  if (policy.sourceSha256 != null && !/^[a-f0-9]{64}$/u.test(policy.sourceSha256)) {
    reject(`${label}.sourceSha256 must be a lowercase SHA-256 digest`);
  }
  if (policy.kind === "bootstrap" && !policy.sourceSha256) {
    reject(`${label}.sourceSha256 is required for the bootstrap policy`);
  }
  stringArray(policy.allowedImports, `${label}.allowedImports`);
  stringArray(policy.requiredImports, `${label}.requiredImports`, { nonEmpty: true });
  stringArray(policy.allowedExports, `${label}.allowedExports`);
  stringArray(policy.requiredExports, `${label}.requiredExports`);
  for (const specifier of policy.requiredImports) {
    if (!policy.allowedImports.includes(specifier)) reject(`${label}.requiredImports must be a subset of allowedImports`);
  }
  for (const exported of policy.requiredExports) {
    if (!policy.allowedExports.includes(exported)) reject(`${label}.requiredExports must be a subset of allowedExports`);
  }
  validatePolicyRequirements(policy, label);
  if (!record(policy.lineLimits)) reject(`${label}.lineLimits must be an object`);
  const { soft, hard } = policy.lineLimits;
  if (!Number.isSafeInteger(soft) || soft < 1 || !Number.isSafeInteger(hard) || hard < soft) {
    reject(`${label}.lineLimits must contain positive integers with soft <= hard`);
  }
  if (!Array.isArray(policy.forbiddenRules)) reject(`${label}.forbiddenRules must be an array`);
  const ruleIds = new Set();
  for (let ruleIndex = 0; ruleIndex < policy.forbiddenRules.length; ruleIndex += 1) {
    await validateRule(policy.forbiddenRules[ruleIndex], `${label}.forbiddenRules[${ruleIndex}]`, ruleIds);
  }
  stringArray(policy.tests, `${label}.tests`, { nonEmpty: true });
  for (let testIndex = 0; testIndex < policy.tests.length; testIndex += 1) {
    const test = repositoryPath(root, policy.tests[testIndex], `${label}.tests[${testIndex}]`);
    await requireFile(root, test, `${label}.tests[${testIndex}]`);
  }
  for (let importIndex = 0; importIndex < policy.allowedImports.length; importIndex += 1) {
    const specifier = policy.allowedImports[importIndex];
    if (!specifier.startsWith(".")) continue;
    const target = relativeImportPath(root, entryAbsolute, specifier, `${label}.allowedImports[${importIndex}]`);
    await requireFile(root, target, `${label}.allowedImports[${importIndex}]`);
  }
  if (policy.kind === "server") {
    stringArray(policy.handlerOrder, `${label}.handlerOrder`, { nonEmpty: true });
    stringArray(policy.routeOwnerModules, `${label}.routeOwnerModules`, { nonEmpty: true });
    if (policy.pageFeatureDescriptors != null) reject(`${label}.pageFeatureDescriptors is only valid for browser policies`);
    if (policy.pageCatalog != null) reject(`${label}.pageCatalog is only valid for browser policies`);
    if (!isFrozenServerHandlerOrder(policy.handlerOrder)) {
      reject(`${label}.handlerOrder must match the frozen server handler order`);
    }
    for (let moduleIndex = 0; moduleIndex < policy.routeOwnerModules.length; moduleIndex += 1) {
      const id = policy.routeOwnerModules[moduleIndex];
      const module = registryInventory.modulesById.get(id);
      if (!module) reject(`${label}.routeOwnerModules[${moduleIndex}] names an unknown module`);
      if (!module.owns.routes.length) {
        reject(`${label}.routeOwnerModules[${moduleIndex}] names a module without routes`);
      }
    }
  } else if (policy.kind === "browser") {
    if (!Array.isArray(policy.pageFeatureDescriptors) || policy.pageFeatureDescriptors.length === 0) {
      reject(`${label}.pageFeatureDescriptors must be a non-empty array for browser policies`);
    }
    stringArray(policy.expectedPages, `${label}.expectedPages`, { nonEmpty: true });
    if (!record(policy.pageCatalog)) reject(`${label}.pageCatalog must be an object`);
    const pageCatalogSpecifier = nonEmptyString(
      policy.pageCatalog.specifier,
      `${label}.pageCatalog.specifier`
    );
    const pageCatalogExport = nonEmptyString(
      policy.pageCatalog.export,
      `${label}.pageCatalog.export`
    );
    if (!policy.requiredImports.includes(pageCatalogSpecifier)) {
      reject(`${label}.pageCatalog.specifier must be listed in requiredImports`);
    }
    if (!pageCatalogSpecifier.startsWith(".")) {
      reject(`${label}.pageCatalog.specifier must be relative`);
    }
    const pageCatalogAbsolute = relativeImportPath(
      root,
      entryAbsolute,
      pageCatalogSpecifier,
      `${label}.pageCatalog.specifier`
    );
    await requireFile(root, pageCatalogAbsolute, `${label}.pageCatalog.specifier`);
    if (policy.handlerOrder != null) reject(`${label}.handlerOrder is only valid for server policies`);
    if (policy.routeOwnerModules != null) reject(`${label}.routeOwnerModules is only valid for server policies`);
    const pages = new Set();
    for (let descriptorIndex = 0; descriptorIndex < policy.pageFeatureDescriptors.length; descriptorIndex += 1) {
      const descriptor = policy.pageFeatureDescriptors[descriptorIndex];
      const descriptorLabel = `${label}.pageFeatureDescriptors[${descriptorIndex}]`;
      if (!record(descriptor)) reject(`${descriptorLabel} must be an object`);
      nonEmptyString(descriptor.page, `${descriptorLabel}.page`);
      nonEmptyString(descriptor.feature, `${descriptorLabel}.feature`);
      nonEmptyString(descriptor.specifier, `${descriptorLabel}.specifier`);
      if (pages.has(descriptor.page)) reject(`${label}.pageFeatureDescriptors must not contain duplicate pages`);
      pages.add(descriptor.page);
      const feature = registryInventory.modulesById.get(descriptor.feature);
      if (!feature || feature.type !== "feature") {
        reject(`${descriptorLabel}.feature must name a registered feature module`);
      }
      if (!policy.requiredImports.includes(descriptor.specifier)) {
        reject(`${descriptorLabel}.specifier must be listed in requiredImports`);
      }
      if (!descriptor.specifier.startsWith(".")) reject(`${descriptorLabel}.specifier must be relative`);
      const target = relativeImportPath(root, entryAbsolute, descriptor.specifier, `${descriptorLabel}.specifier`);
      if (target !== feature.entryAbsolute) {
        reject(`${descriptorLabel}.specifier must resolve to the public entry of ${descriptor.feature}`);
      }
    }
    const missingPages = policy.expectedPages.filter(page => !pages.has(page));
    const unexpectedPages = [...pages].filter(page => !policy.expectedPages.includes(page));
    if (missingPages.length || unexpectedPages.length) {
      reject(`${label}.pageFeatureDescriptors do not match expectedPages; missing=${missingPages.join(",")} unexpected=${unexpectedPages.join(",")}`);
    }
    const pageCatalog = await import(pathToFileURL(pageCatalogAbsolute).href);
    const livePages = pageCatalog[pageCatalogExport];
    if (!record(livePages)) reject(`${label}.pageCatalog export must be an object`);
    const catalogPages = Object.keys(livePages);
    const missingCatalogPages = policy.expectedPages.filter(page => !catalogPages.includes(page));
    const unexpectedCatalogPages = catalogPages.filter(page => !policy.expectedPages.includes(page));
    if (missingCatalogPages.length || unexpectedCatalogPages.length) {
      reject(`${label}.expectedPages do not match the live page catalog; missing=${missingCatalogPages.join(",")} unexpected=${unexpectedCatalogPages.join(",")}`);
    }
  } else {
    if (policy.handlerOrder != null || policy.routeOwnerModules != null) {
      reject(`${label} bootstrap policy must not define server handler fields`);
    }
    if (
      policy.expectedPages != null
      || policy.pageCatalog != null
      || policy.pageFeatureDescriptors != null
    ) {
      reject(`${label} bootstrap policy must not define browser page fields`);
    }
  }
  return { ...policy, entryAbsolute, ruleIds };
}

async function inventory(root, registry) {
  if (!Array.isArray(registry.modules)) reject("Registry modules must be an array");
  const modulesById = new Map();
  const routeOwners = new Map();
  for (let index = 0; index < registry.modules.length; index += 1) {
    const module = registry.modules[index];
    const label = `modules[${index}]`;
    if (!record(module)) reject(`${label} must be an object`);
    nonEmptyString(module.id, `${label}.id`);
    nonEmptyString(module.type, `${label}.type`);
    if (modulesById.has(module.id)) reject(`Duplicate module id: ${module.id}`);
    stringArray(module.allowedDependencies, `${label}.allowedDependencies`);
    const entryAbsolute = repositoryPath(root, module.publicEntry, `${label}.publicEntry`);
    await requireFile(root, entryAbsolute, `${label}.publicEntry`);
    modulesById.set(module.id, { ...module, entryAbsolute });
    for (const route of module?.owns?.routes || []) {
      nonEmptyString(route, "Module owned route");
      if (routeOwners.has(route)) reject(`Route has multiple owners: ${route}`);
      routeOwners.set(route, module.id);
    }
  }
  for (const module of modulesById.values()) {
    for (const dependency of module.allowedDependencies) {
      if (!modulesById.has(dependency)) reject(`Unknown module dependency: ${module.id} -> ${dependency}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(id) {
    if (visiting.has(id)) {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(" -> ");
      reject(`Module dependency cycle detected: ${cycle}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of modulesById.get(id).allowedDependencies) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of modulesById.keys()) visit(id);
  return {
    moduleCount: registry.modules.length,
    routeCount: routeOwners.size,
    modulesById,
    routeOwners
  };
}

async function inspectPolicy(root, policy) {
  const source = await fs.readFile(policy.entryAbsolute, "utf8");
  const sourceSha256 = crypto.createHash("sha256").update(source).digest("hex");
  const analysis = analyzeEntrypointSource(source, policy.path, policy.forbiddenRules);
  const { surface, violations } = analysis;
  for (const imported of surface.imports) {
    if (!policy.allowedImports.includes(imported.specifier)) {
      violations.push({
        ruleId: "imports",
        line: imported.line,
        detail: `import is not allowlisted: ${JSON.stringify(imported.specifier)}`
      });
    }
  }
  const importedSpecifiers = new Set(surface.imports.map(imported => imported.specifier));
  for (const required of policy.requiredImports) {
    if (!importedSpecifiers.has(required)) {
      violations.push({ ruleId: "imports", line: 1, detail: `required import is missing: ${JSON.stringify(required)}` });
    }
  }
  violations.push(...requiredContractViolations(policy, surface));
  for (const exported of surface.exports) {
    if (!policy.allowedExports.includes(exported.name)) {
      violations.push({
        ruleId: "exports",
        line: exported.line,
        detail: `export is not allowlisted: ${JSON.stringify(exported.name)}`
      });
    }
  }
  const exportedNames = new Set(surface.exports.map(exported => exported.name));
  for (const required of policy.requiredExports) {
    if (!exportedNames.has(required)) {
      violations.push({ ruleId: "exports", line: 1, detail: `required export is missing: ${JSON.stringify(required)}` });
    }
  }
  for (const imported of surface.nonLiteralImports) {
    violations.push({
      ruleId: "dynamic-import-literal",
      line: imported.line,
      detail: imported.detail || "dynamic import specifier must be a single string or no-substitution template literal"
    });
  }
  const lines = analysis.lineCount;
  const warnings = [];
  if (lines > policy.lineLimits.hard) {
    violations.push({
      ruleId: "lines.hard",
      line: 1,
      detail: `${lines} lines exceeds hard limit ${policy.lineLimits.hard}`,
      value: lines
    });
  } else if (lines > policy.lineLimits.soft) {
    warnings.push(`${policy.path}: ${lines} lines exceeds soft limit ${policy.lineLimits.soft}`);
  }
  return { sourceSha256, violations, warnings };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await requireFile(options.root, options.registry, "--registry", { rejectSymlink: true });
  const registry = JSON.parse(await fs.readFile(options.registry, "utf8"));
  if (!record(registry)) reject("Registry root must be an object");
  if (!Array.isArray(registry.entrypointPolicies) || registry.entrypointPolicies.length === 0) {
    reject("Registry must define a non-empty entrypointPolicies array");
  }
  const counts = await inventory(options.root, registry);
  const paths = new Set();
  const policies = [];
  for (let index = 0; index < registry.entrypointPolicies.length; index += 1) {
    policies.push(await validatePolicy(
      options.root,
      registry.entrypointPolicies[index],
      index,
      paths,
      counts
    ));
  }
  validateEntrypointCrossContracts(policies, counts);
  const exceptions = validateEntrypointExceptions(
    registry,
    policies,
    options.gate,
    RESERVED_RULE_IDS
  );
  const violationsByKey = new Map();
  const sourceHashes = new Map();
  const warnings = [];
  for (const policy of policies) {
    const result = await inspectPolicy(options.root, policy);
    if (policy.sourceSha256 && policy.sourceSha256 !== result.sourceSha256) {
      reject(`${policy.path} does not match its frozen sourceSha256`);
    }
    sourceHashes.set(policy.path, result.sourceSha256);
    warnings.push(...result.warnings);
    for (const violation of result.violations) {
      const key = `${policy.path}\0${violation.ruleId}`;
      const current = violationsByKey.get(key) || [];
      current.push({ ...violation, path: policy.path });
      violationsByKey.set(key, current);
    }
  }
  const excepted = new Set();
  for (let index = 0; index < exceptions.length; index += 1) {
    const exception = exceptions[index];
    const key = `${exception.path}\0${exception.ruleId}`;
    const matches = violationsByKey.get(key) || [];
    const label = `entrypointMigrationExceptions[${index}]`;
    if (matches.length === 0) reject(`${label} is stale: ${exception.path} ${exception.ruleId}`);
    if (exception.sourceSha256 !== sourceHashes.get(exception.path)) {
      reject(`${label}.sourceSha256 does not match the current entrypoint source`);
    }
    if (exception.ruleId === "lines.hard") {
      if (matches[0].value > exception.maxValue) {
        reject(`${label} value ${matches[0].value} exceeds maxValue ${exception.maxValue}`);
      }
    } else {
      const actual = new Map();
      for (const match of matches) actual.set(match.detail, (actual.get(match.detail) || 0) + 1);
      const allowed = new Map(exception.allowlist.map(item => [item.detail, item.count]));
      for (const [detail, count] of actual) {
        if (!allowed.has(detail)) reject(`${label} does not allow violation detail ${JSON.stringify(detail)}`);
        if (allowed.get(detail) !== count) {
          reject(`${label} detail ${JSON.stringify(detail)} matched ${count}, expected exactly ${allowed.get(detail)}`);
        }
      }
      for (const [detail, count] of allowed) {
        if (actual.get(detail) !== count) {
          reject(`${label} allowlist detail ${JSON.stringify(detail)} is stale or changed`);
        }
      }
    }
    excepted.add(key);
  }
  const failures = [...violationsByKey.entries()]
    .filter(([key]) => !excepted.has(key))
    .flatMap(([, values]) => values);
  if (failures.length) {
    reject(failures.map(item => `${item.path}:${item.line} [${item.ruleId}] ${item.detail}`).join("\n"));
  }
  for (const warning of warnings) process.stderr.write(`entrypoint check warning: ${warning}\n`);
  process.stdout.write(
    `Entrypoint checks passed at ${options.gate}: ${policies.length} policies, `
    + `${counts.moduleCount} modules, ${counts.routeCount} owned routes, `
    + `${exceptions.length} active migration exceptions.\n`
  );
}

main().catch(error => {
  process.stderr.write(`entrypoint check failed: ${error.message}\n`);
  process.exitCode = 1;
});
