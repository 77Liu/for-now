const SERVER_HANDLER_ORDER = Object.freeze([
  "health-readiness",
  "local-test-proxy",
  "admin",
  "auth",
  "owner",
  "v1",
  "legacy",
  "attachment",
  "static"
]);

const EXCEPTION_DEADLINE = Object.freeze({ server: 4, browser: 6, bootstrap: 3 });
const ENTRYPOINT_IDENTITIES = Object.freeze({
  server: Object.freeze({
    path: "server.mjs",
    requiredBindings: Object.freeze({
      "./src/app/index.mjs": ["createServerRuntime"]
    }),
    requiredCalls: ["runtime.start"],
    requiredFactoryUses: [{
      specifier: "./src/app/index.mjs",
      imported: "createServerRuntime",
      result: "runtime",
      method: "start",
      directScope: "top-level",
      dependencies: []
    }],
    compositionApi: Object.freeze({
      factory: "createServerRuntime",
      factorySpecifier: "./src/app/index.mjs",
      resultBinding: "runtime",
      parameters: ["rootUrl", "processRef?"],
      methods: ["start", "ready", "stop"],
      httpFactory: "createHttpApplication",
      httpMembers: ["handle", "routeIds"]
    }),
    requiredForbiddenRules: [
      { id: "server.dynamic-code", kind: "identifier", values: ["eval", "Function", "Reflect"] },
      { id: "server.computed-global", kind: "syntax", values: ["computed-global-access"] }
    ]
  }),
  browser: Object.freeze({
    path: "public/frontend/app/runtime.mjs",
    requiredBindings: Object.freeze({
      "../feature-registry/index.mjs": ["createFeatureRegistry"],
      "./application.mjs": ["createBrowserApplication"]
    }),
    requiredCalls: ["application.start"],
    requiredFactoryUses: [{
      specifier: "./application.mjs",
      imported: "createBrowserApplication",
      result: "application",
      method: "start",
      directScope: "startApplication",
      dependencies: ["featureRegistry"]
    }, {
      specifier: "../feature-registry/index.mjs",
      imported: "createFeatureRegistry",
      result: "featureRegistry",
      method: null,
      directScope: "startApplication",
      dependencies: []
    }],
    pageCatalog: Object.freeze({
      specifier: "../pages/index.mjs",
      export: "viewSections"
    }),
    compositionApi: Object.freeze({
      factory: "createBrowserApplication",
      factorySpecifier: "./application.mjs",
      resultBinding: "application",
      methods: ["start", "resetSession", "stop"],
      featureRegistryFactory: "createFeatureRegistry",
      featureRegistryMethods: ["enter", "leave", "notifyState", "resetSession", "stop"]
    }),
    requiredForbiddenRules: [
      { id: "browser.dynamic-code", kind: "identifier", values: ["eval", "Function", "Reflect"] },
      { id: "browser.computed-global", kind: "syntax", values: ["computed-global-access"] }
    ]
  }),
  bootstrap: Object.freeze({
    path: "public/app.js",
    requiredBindings: Object.freeze({}),
    requiredCalls: ["startOpening", "startApplication"],
    requiredFactoryUses: [],
    requiredForbiddenRules: [
      { id: "bootstrap.dynamic-code", kind: "identifier", values: ["eval", "Function", "Reflect"] },
      { id: "bootstrap.computed-global", kind: "syntax", values: ["computed-global-access"] }
    ]
  })
});

export const ENTRYPOINT_POLICY_KINDS = new Set(["server", "browser", "bootstrap"]);

function reject(message) {
  throw new Error(message);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) reject(`${label} must be a non-empty string`);
}

function stringArray(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    reject(`${label} must be ${nonEmpty ? "a non-empty" : "an"} array`);
  }
  for (let index = 0; index < value.length; index += 1) nonEmptyString(value[index], `${label}[${index}]`);
  if (new Set(value).size !== value.length) reject(`${label} must not contain duplicates`);
}

function sameContract(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && actual.every((value, index) => sameContract(value, expected[index]));
  }
  if (record(expected)) {
    if (!record(actual) || Object.keys(actual).length !== Object.keys(expected).length) return false;
    return Object.entries(expected).every(([key, value]) => sameContract(actual[key], value));
  }
  return actual === expected;
}

export function isFrozenServerHandlerOrder(order) {
  return order.length === SERVER_HANDLER_ORDER.length
    && order.every((value, index) => value === SERVER_HANDLER_ORDER[index]);
}

export function validatePolicyRequirements(policy, label) {
  if (!record(policy.requiredBindings)) reject(`${label}.requiredBindings must be an object`);
  for (const [specifier, bindings] of Object.entries(policy.requiredBindings)) {
    nonEmptyString(specifier, `${label}.requiredBindings key`);
    stringArray(bindings, `${label}.requiredBindings[${JSON.stringify(specifier)}]`, { nonEmpty: true });
  }
  stringArray(policy.requiredCalls, `${label}.requiredCalls`, { nonEmpty: true });
  if (!Array.isArray(policy.requiredFactoryUses)) reject(`${label}.requiredFactoryUses must be an array`);
  for (let index = 0; index < policy.requiredFactoryUses.length; index += 1) {
    const use = policy.requiredFactoryUses[index];
    const useLabel = `${label}.requiredFactoryUses[${index}]`;
    if (!record(use)) reject(`${useLabel} must be an object`);
    for (const field of ["specifier", "imported", "result", "directScope"]) {
      nonEmptyString(use[field], `${useLabel}.${field}`);
    }
    if (use.method !== null) nonEmptyString(use.method, `${useLabel}.method`);
    stringArray(use.dependencies, `${useLabel}.dependencies`);
  }
}

export function requiredContractViolations(policy, surface) {
  const violations = [];
  const directScopeMatches = (candidate, expected) => expected === "top-level"
    ? candidate.scope === "" && candidate.directStatement
    : candidate.functionName === expected
      && candidate.scope === candidate.functionScope
      && candidate.functionExported
      && candidate.functionTopLevel
      && candidate.directStatement;
  for (const [specifier, requiredBindings] of Object.entries(policy.requiredBindings)) {
    const importedBindings = surface.imports
      .filter(imported => !imported.dynamic && imported.specifier === specifier)
      .flatMap(imported => imported.bindings);
    for (const binding of requiredBindings) {
      if (!importedBindings.some(imported => imported.imported === binding)) {
        violations.push({
          ruleId: "import-bindings",
          line: 1,
          detail: `required binding is missing from ${JSON.stringify(specifier)}: ${JSON.stringify(binding)}`
        });
      }
    }
  }
  const calls = new Set(surface.calls.map(call => call.name));
  for (const required of policy.requiredCalls) {
    if (!calls.has(required)) {
      violations.push({ ruleId: "calls", line: 1, detail: `required call is missing: ${JSON.stringify(required)}` });
    }
  }
  const resolvedUses = policy.requiredFactoryUses.map(use => {
    const importedBinding = surface.imports
      .filter(imported => !imported.dynamic && imported.specifier === use.specifier)
      .flatMap(imported => imported.bindings)
      .find(binding => binding.imported === use.imported);
    const localName = importedBinding?.local;
    const bindingOccurrences = surface.identifiers.filter(identifier => identifier.name === localName).length;
    const assignment = surface.factoryAssignments.find(candidate => (
      candidate.factory === localName
      && candidate.result === use.result
      && directScopeMatches(candidate, use.directScope)
    ));
    return {
      use,
      importedBinding,
      bindingOccurrences,
      assignment,
      validAssignment: Boolean(importedBinding && bindingOccurrences === 2 && assignment)
    };
  });
  for (const resolved of resolvedUses) {
    const { use, assignment } = resolved;
    const dependenciesReady = assignment && use.dependencies.every(dependency => {
      const dependencyUse = resolvedUses.find(candidate => candidate.use.result === dependency);
      return dependencyUse?.validAssignment
        && dependencyUse.assignment.scope === assignment.scope
        && dependencyUse.assignment.index < assignment.index
        && assignment.argumentsUsed.includes(dependency);
    });
    if (!resolved.validAssignment || !dependenciesReady) {
      violations.push({
        ruleId: "factory-use",
        line: 1,
        detail: `required factory assignment is missing: ${use.result}=${use.imported}()`
      });
    } else if (use.method && !surface.calls.some(call => (
      call.name === `${use.result}.${use.method}`
      && call.scope === assignment.scope
      && call.index > assignment.index
      && call.directStatement
    ))) {
      violations.push({
        ruleId: "factory-use",
        line: 1,
        detail: `required factory lifecycle call is missing: ${use.result}.${use.method}()`
      });
    }
  }
  return violations;
}

export function validateEntrypointExceptions(registry, policies, gate, reservedRuleIds) {
  const exceptions = registry.entrypointMigrationExceptions ?? [];
  if (!Array.isArray(exceptions)) reject("Registry entrypointMigrationExceptions must be an array");
  if (gate === "G7" && exceptions.length) reject("Entrypoint migration exceptions must be empty at G7");
  const policyByPath = new Map(policies.map(policy => [policy.path, policy]));
  const keys = new Set();
  for (let index = 0; index < exceptions.length; index += 1) {
    const exception = exceptions[index];
    const label = `entrypointMigrationExceptions[${index}]`;
    if (!record(exception)) reject(`${label} must be an object`);
    for (const field of ["path", "ruleId", "owner", "removeWhen", "deleteByGate", "sourceSha256"]) {
      nonEmptyString(exception[field], `${label}.${field}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(exception.sourceSha256)) {
      reject(`${label}.sourceSha256 must be a lowercase SHA-256 digest`);
    }
    const policy = policyByPath.get(exception.path);
    if (!policy) reject(`${label}.path has no entrypoint policy: ${exception.path}`);
    if (!reservedRuleIds.has(exception.ruleId) && !policy.ruleIds.has(exception.ruleId)) {
      reject(`${label}.ruleId is unknown for ${exception.path}: ${exception.ruleId}`);
    }
    if (!/^G[0-7]$/u.test(exception.deleteByGate)) {
      reject(`${label}.deleteByGate must be one of G0 through G7`);
    }
    if (Number(exception.deleteByGate.slice(1)) > EXCEPTION_DEADLINE[policy.kind]) {
      reject(`${label}.deleteByGate exceeds the ${policy.kind} deadline G${EXCEPTION_DEADLINE[policy.kind]}`);
    }
    if (Number(gate.slice(1)) >= Number(exception.deleteByGate.slice(1))) {
      reject(`${label} expired at ${exception.deleteByGate}: ${exception.path} ${exception.ruleId}`);
    }
    if (exception.ruleId === "lines.hard") {
      if (!Number.isSafeInteger(exception.maxValue) || exception.maxValue <= policy.lineLimits.hard) {
        reject(`${label}.maxValue must be an integer above the policy hard line limit`);
      }
      if (exception.allowlist != null || exception.maxMatches != null) {
        reject(`${label} must use only maxValue for lines.hard`);
      }
    } else {
      if (!Array.isArray(exception.allowlist) || exception.allowlist.length === 0) {
        reject(`${label}.allowlist must be a non-empty array`);
      }
      if (exception.maxValue != null || exception.maxMatches != null) {
        reject(`${label} must use detail/count allowlist entries`);
      }
      const details = new Set();
      for (let allowIndex = 0; allowIndex < exception.allowlist.length; allowIndex += 1) {
        const allowed = exception.allowlist[allowIndex];
        const allowLabel = `${label}.allowlist[${allowIndex}]`;
        if (!record(allowed)) reject(`${allowLabel} must be an object`);
        nonEmptyString(allowed.detail, `${allowLabel}.detail`);
        if (!Number.isSafeInteger(allowed.count) || allowed.count < 1) {
          reject(`${allowLabel}.count must be a positive integer`);
        }
        if (details.has(allowed.detail)) reject(`${label}.allowlist must not contain duplicate details`);
        details.add(allowed.detail);
      }
    }
    const key = `${exception.path}\0${exception.ruleId}`;
    if (keys.has(key)) reject(`Duplicate entrypoint migration exception: ${exception.path} ${exception.ruleId}`);
    keys.add(key);
  }
  return exceptions;
}

export function validateEntrypointCrossContracts(policies, registryInventory) {
  for (const [kind, identity] of Object.entries(ENTRYPOINT_IDENTITIES)) {
    const matches = policies.filter(policy => policy.kind === kind);
    if (matches.length !== 1) reject(`Registry must define exactly one ${kind} entrypoint policy`);
    const [policy] = matches;
    if (policy.path !== identity.path) {
      reject(`${kind} entrypoint policy must target ${identity.path}`);
    }
    if (!sameContract(policy.requiredBindings, identity.requiredBindings)) {
      reject(`${kind} entrypoint policy must define the frozen required bindings`);
    }
    if (!sameContract(policy.requiredCalls, identity.requiredCalls)) {
      reject(`${kind} entrypoint policy must define the frozen required calls`);
    }
    if (!sameContract(policy.requiredFactoryUses, identity.requiredFactoryUses)) {
      reject(`${kind} entrypoint policy must define the frozen factory lifecycle`);
    }
    for (const requiredRule of identity.requiredForbiddenRules) {
      const actualRule = policy.forbiddenRules.find(rule => rule.id === requiredRule.id);
      if (!sameContract(actualRule, requiredRule)) {
        reject(`${kind} entrypoint policy must define frozen rule ${requiredRule.id}`);
      }
    }
    if (identity.pageCatalog && !sameContract(policy.pageCatalog, identity.pageCatalog)) {
      reject(`${kind} entrypoint policy must use the frozen page catalog`);
    }
    if (identity.compositionApi && !sameContract(policy.compositionApi, identity.compositionApi)) {
      reject(`${kind} entrypoint policy must define the frozen composition API`);
    }
  }
  const routed = new Set();
  for (const policy of policies.filter(item => item.kind === "server")) {
    for (const moduleId of policy.routeOwnerModules) {
      const module = registryInventory.modulesById.get(moduleId);
      for (const route of module.owns.routes) {
        if (routed.has(route)) reject(`Route owner module is assigned more than once: ${moduleId}`);
        routed.add(route);
      }
    }
  }
  const missing = [...registryInventory.routeOwners.keys()].filter(route => !routed.has(route));
  if (missing.length) reject(`Owned routes are missing from routeOwnerModules: ${missing.join(", ")}`);
}
