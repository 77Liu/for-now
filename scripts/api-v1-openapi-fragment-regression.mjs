import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openApiV1,
  thoughtPaths,
  thoughtComponents,
  thoughtsOpenApiFragment
} from "../src/http/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const pick = (source, names) => Object.fromEntries(names.map(name => [name, source[name]]));
const omit = (source, names) => Object.fromEntries(
  Object.entries(source).filter(([name]) => !names.includes(name))
);

function mergeComponents(base, addition) {
  const merged = { ...base };
  for (const [section, entries] of Object.entries(addition)) {
    merged[section] = { ...(merged[section] || {}), ...entries };
  }
  return merged;
}

function operations(paths) {
  return Object.entries(paths).flatMap(([route, pathItem]) => Object.entries(pathItem)
    .filter(([method]) => HTTP_METHODS.has(method))
    .map(([method, operation]) => ({ route, method, operation })));
}

function collectRefs(value, refs = []) {
  if (!value || typeof value !== "object") return refs;
  if (typeof value.$ref === "string") refs.push(value.$ref);
  for (const nested of Object.values(value)) collectRefs(nested, refs);
  return refs;
}

function resolveRef(document, ref) {
  assert.match(ref, /^#\//, `Only local OpenAPI references are allowed: ${ref}`);
  return ref.slice(2).split("/").reduce((value, encodedPart) => {
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    assert.ok(value && Object.hasOwn(value, part), `Unresolved OpenAPI reference: ${ref}`);
    return value[part];
  }, document);
}

function resolvedParameters(document, route, method) {
  const pathItem = document.paths[route];
  const declared = [...(pathItem.parameters || []), ...(pathItem[method].parameters || [])];
  return declared.map(parameter => parameter.$ref ? resolveRef(document, parameter.$ref) : parameter);
}

assert.deepEqual(Object.keys(thoughtsOpenApiFragment).sort(), ["components", "paths"]);
assert.strictEqual(thoughtsOpenApiFragment.paths, thoughtPaths);
assert.strictEqual(thoughtsOpenApiFragment.components, thoughtComponents);
assert.deepEqual(Object.keys(thoughtPaths).sort(), [
  "/thought-chains",
  "/thought-chains/{id}",
  "/thought-chains/{id}/answers"
]);

const thoughtPathNames = Object.keys(thoughtPaths);
assert.deepEqual(thoughtPaths, pick(openApiV1.paths, thoughtPathNames));

const ownedParameters = ["ThoughtChainId"];
const ownedSchemas = Object.keys(thoughtComponents.schemas);
assert.deepEqual(thoughtComponents, {
  parameters: pick(openApiV1.components.parameters, ownedParameters),
  schemas: pick(openApiV1.components.schemas, ownedSchemas)
});

const baseComponents = {
  ...openApiV1.components,
  parameters: omit(openApiV1.components.parameters, ownedParameters),
  schemas: omit(openApiV1.components.schemas, ownedSchemas)
};
const assembled = {
  ...openApiV1,
  paths: {
    ...omit(openApiV1.paths, thoughtPathNames),
    ...thoughtsOpenApiFragment.paths
  },
  components: mergeComponents(baseComponents, thoughtsOpenApiFragment.components)
};
assert.deepEqual(assembled, openApiV1, "Mechanical fragment merge must preserve the v1 1.0.0 contract");
assert.deepEqual(openApiV1.components.schemas.StatisticsDashboard.required, ["records"]);
assert.match(openApiV1.components.schemas.StatisticsDashboard.properties.ai.description, /Owner-only/);
assert.match(openApiV1.components.schemas.StatisticsDashboard.properties.service.description, /Owner-only/);

const fragmentOperations = operations(thoughtPaths);
assert.equal(fragmentOperations.length, 6);
const assembledOperations = operations(assembled.paths);
const operationIds = assembledOperations.map(({ operation, route, method }) => {
  assert.equal(typeof operation.operationId, "string", `Missing operationId for ${method.toUpperCase()} ${route}`);
  assert.ok(operation.operationId, `Empty operationId for ${method.toUpperCase()} ${route}`);
  return operation.operationId;
});
assert.equal(new Set(operationIds).size, operationIds.length, "OpenAPI operationId values must be unique");

const refs = collectRefs(assembled);
assert.ok(refs.length > 0);
for (const ref of refs) resolveRef(assembled, ref);

const thoughtHttpSource = await fs.readFile(path.join(ROOT, "src/http/thoughts.mjs"), "utf8");
const handleStart = thoughtHttpSource.indexOf("async function handleV1(");
const handleEnd = thoughtHttpSource.indexOf("\n  async function handle(", handleStart);
assert.ok(handleStart >= 0 && handleEnd > handleStart, "Unable to locate the running thought v1 handler");
const handleV1Source = thoughtHttpSource.slice(handleStart, handleEnd);
const runtimeRoutes = [...handleV1Source.matchAll(/if \(req\.method === "([A-Z]+)" && (.+)\) \{/g)].map(match => {
  const [, method, condition] = match;
  const exact = condition.match(/^url\.pathname === "([^"]+)"$/);
  if (exact) return { method: method.toLowerCase(), matches: pathname => pathname === exact[1] };
  const regex = condition.match(/^\/(.+)\/\.test\(url\.pathname\)$/);
  assert.ok(regex, `Unsupported thought v1 route condition: ${condition}`);
  const matcher = new RegExp(regex[1]);
  return { method: method.toLowerCase(), matches: pathname => matcher.test(pathname) };
});
assert.equal(runtimeRoutes.length, 6, "Unexpected number of running thought v1 operations");

const documentedRuntimeKeys = runtimeRoutes.map(runtimeRoute => {
  const matches = fragmentOperations.filter(({ route, method }) => (
    method === runtimeRoute.method
    && runtimeRoute.matches(`/api/v1${route.replace("{id}", "contract-id")}`)
  ));
  assert.equal(matches.length, 1, "Each running thought v1 route must have one fragment operation");
  return `${matches[0].method} ${matches[0].route}`;
});
assert.equal(new Set(documentedRuntimeKeys).size, fragmentOperations.length);

for (const { route, method } of fragmentOperations) {
  const pathname = `/api/v1${route.replace("{id}", "contract-id")}`;
  const matches = runtimeRoutes.filter(runtimeRoute => runtimeRoute.method === method && runtimeRoute.matches(pathname));
  assert.equal(matches.length, 1, `Fragment operation has no running route: ${method.toUpperCase()} ${route}`);
}

for (const [route, method, header] of [
  ["/thought-chains", "post", "Idempotency-Key"],
  ["/thought-chains/{id}/answers", "post", "Idempotency-Key"],
  ["/thought-chains/{id}", "patch", "If-Match"],
  ["/thought-chains/{id}", "delete", "If-Match"]
]) {
  const parameter = resolvedParameters(assembled, route, method)
    .find(candidate => candidate.in === "header" && candidate.name.toLowerCase() === header.toLowerCase());
  assert.ok(parameter, `${method.toUpperCase()} ${route} must declare ${header}`);
  assert.equal(parameter.required, true, `${header} must be required for ${method.toUpperCase()} ${route}`);
}

console.log(`Thought OpenAPI fragment checks passed: ${Object.keys(thoughtPaths).length} paths, ${fragmentOperations.length} operations, ${refs.length} closed references, runtime coverage and write headers.`);
