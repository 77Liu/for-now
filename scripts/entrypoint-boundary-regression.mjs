import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checker = path.join(root, "scripts/check-entrypoints.mjs");
const sourceAnalysis = path.join(root, "scripts/lib/entrypoint-source-analysis.mjs");
const contractValidation = path.join(root, "scripts/lib/entrypoint-contract-validation.mjs");
const moduleSurface = path.join(root, "scripts/lib/entrypoint-module-surface.mjs");
const scopeAnalysis = path.join(root, "scripts/lib/entrypoint-scope-analysis.mjs");
const staticValues = path.join(root, "scripts/lib/entrypoint-static-values.mjs");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "entrypoint-boundary-regression-"));

const validServerSource = [
  "import { createServerRuntime } from \"./src/app/index.mjs\";",
  "// dangerous(); setTimeout(() => {}, 1); import(\"./bad.mjs\"); export const bad = true;",
  "const note = \"dangerous and setTimeout are documentation here\";",
  "const routePattern = /import\\(\"\\.\\/bad\\.mjs\"\\)|export\\s+const/;",
  "const ratio = 12 / 3 / 2;",
  "const boundary = { value: true, export: true };",
  "if (false) /import\\(\"\\.\\/also-bad\\.mjs\"\\)/.test(\"\");",
  "const matched = true && /^\\/attachments\\/[\\w.-]+$/.test(\"/attachments/a.png\");",
  "const runtime = createServerRuntime({});",
  "runtime.start();",
  "void note; void routePattern; void ratio; void boundary; void matched;",
  "export const start = () => {};",
  ""
].join("\n");

const validBrowserSource = [
  "import { createBrowserApplication } from \"./application.mjs\";",
  "import { createFeatureRegistry } from \"../feature-registry/index.mjs\";",
  "import * as pageFeatures from \"../features/index.mjs\";",
  "import { viewSections } from \"../pages/index.mjs\";",
  "export function startApplication() {",
  "  const featureRegistry = createFeatureRegistry();",
  "  const application = createBrowserApplication({ featureRegistry });",
  "  return application.start();",
  "}",
  "void pageFeatures; void viewSections;",
  ""
].join("\n");

const validBootstrapSource = [
  "import(\"./frontend/opening/index.mjs\").then(({ startOpening }) => startOpening());",
  "import(\"./frontend/app/index.mjs\").then(({ startApplication }) => startApplication());",
  ""
].join("\n");

const frozenHandlerOrder = [
  "health-readiness",
  "local-test-proxy",
  "admin",
  "auth",
  "owner",
  "v1",
  "legacy",
  "attachment",
  "static"
];

function forbiddenRules(values = ["dangerous"]) {
  return [
    { id: "no-dangerous-identifier", kind: "identifier", values },
    { id: "no-timer-call", kind: "call", values: ["setTimeout"] },
    { id: "no-api-literal", kind: "literal", values: ["/api/"], match: "includes" }
  ];
}

const serverRequiredRules = [
  { id: "server.dynamic-code", kind: "identifier", values: ["eval", "Function", "Reflect"] },
  { id: "server.computed-global", kind: "syntax", values: ["computed-global-access"] }
];

const browserRequiredRules = [
  { id: "browser.dynamic-code", kind: "identifier", values: ["eval", "Function", "Reflect"] },
  { id: "browser.computed-global", kind: "syntax", values: ["computed-global-access"] }
];

function serverPolicy(overrides = {}) {
  const { forbiddenRules: additionalRules = forbiddenRules(), ...values } = overrides;
  return {
    kind: "server",
    path: "server.mjs",
    allowedImports: ["./src/app/index.mjs"],
    requiredImports: ["./src/app/index.mjs"],
    requiredBindings: { "./src/app/index.mjs": ["createServerRuntime"] },
    requiredCalls: ["runtime.start"],
    requiredFactoryUses: [{
      specifier: "./src/app/index.mjs",
      imported: "createServerRuntime",
      result: "runtime",
      method: "start",
      directScope: "top-level",
      dependencies: []
    }],
    allowedExports: ["start"],
    requiredExports: ["start"],
    compositionApi: {
      factory: "createServerRuntime",
      factorySpecifier: "./src/app/index.mjs",
      resultBinding: "runtime",
      parameters: ["rootUrl", "processRef?"],
      methods: ["start", "ready", "stop"],
      httpFactory: "createHttpApplication",
      httpMembers: ["handle", "routeIds"]
    },
    lineLimits: { soft: 20, hard: 30 },
    forbiddenRules: [...serverRequiredRules, ...additionalRules],
    tests: ["scripts/entry-test.mjs"],
    handlerOrder: frozenHandlerOrder,
    routeOwnerModules: ["app", "server.other"],
    ...values
  };
}

function browserPolicy(overrides = {}) {
  return {
    kind: "browser",
    path: "public/frontend/app/runtime.mjs",
    allowedImports: ["./application.mjs", "../feature-registry/index.mjs", "../features/index.mjs", "../pages/index.mjs"],
    requiredImports: ["./application.mjs", "../feature-registry/index.mjs", "../features/index.mjs", "../pages/index.mjs"],
    requiredBindings: {
      "./application.mjs": ["createBrowserApplication"],
      "../feature-registry/index.mjs": ["createFeatureRegistry"]
    },
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
    allowedExports: ["startApplication"],
    requiredExports: ["startApplication"],
    compositionApi: {
      factory: "createBrowserApplication",
      factorySpecifier: "./application.mjs",
      resultBinding: "application",
      methods: ["start", "resetSession", "stop"],
      featureRegistryFactory: "createFeatureRegistry",
      featureRegistryMethods: ["enter", "leave", "notifyState", "resetSession", "stop"]
    },
    lineLimits: { soft: 10, hard: 20 },
    forbiddenRules: browserRequiredRules,
    tests: ["scripts/entry-test.mjs"],
    expectedPages: ["home"],
    pageCatalog: {
      specifier: "../pages/index.mjs",
      export: "viewSections"
    },
    pageFeatureDescriptors: [{
      page: "home",
      feature: "frontend.feature.home",
      specifier: "../features/index.mjs"
    }],
    ...overrides
  };
}

function bootstrapPolicy(overrides = {}) {
  return {
    kind: "bootstrap",
    path: "public/app.js",
    sourceSha256: "fixture",
    allowedImports: ["./frontend/opening/index.mjs", "./frontend/app/index.mjs"],
    requiredImports: ["./frontend/opening/index.mjs", "./frontend/app/index.mjs"],
    requiredBindings: {},
    requiredCalls: ["startOpening", "startApplication"],
    requiredFactoryUses: [],
    allowedExports: [],
    requiredExports: [],
    lineLimits: { soft: 5, hard: 10 },
    forbiddenRules: [
      { id: "bootstrap.network", kind: "identifier", values: ["fetch"] },
      { id: "bootstrap.timer", kind: "identifier", values: ["setTimeout"] },
      { id: "bootstrap.dynamic-code", kind: "identifier", values: ["eval", "Function", "Reflect"] },
      { id: "bootstrap.computed-global", kind: "syntax", values: ["computed-global-access"] }
    ],
    tests: ["scripts/entry-test.mjs"],
    ...overrides
  };
}

function modules() {
  return [
    {
      id: "app",
      type: "application",
      publicEntry: "src/app/index.mjs",
      allowedDependencies: [],
      owns: { routes: ["GET /one", "POST /two"] }
    },
    {
      id: "server.other",
      type: "application",
      publicEntry: "src/server/other/index.mjs",
      allowedDependencies: ["app"],
      owns: { routes: ["GET /three"] }
    },
    {
      id: "frontend.feature.home",
      type: "feature",
      publicEntry: "public/frontend/features/index.mjs",
      allowedDependencies: [],
      owns: { routes: [] }
    }
  ];
}

function registry(overrides = {}) {
  return {
    version: 1,
    modules: modules(),
    entrypointPolicies: [serverPolicy(), browserPolicy(), bootstrapPolicy()],
    entrypointMigrationExceptions: [],
    ...overrides
  };
}

async function fixture(name, {
  serverSource = validServerSource,
  browserSource = validBrowserSource,
  bootstrapSource = validBootstrapSource,
  registryValue = registry(),
  extraFiles = {}
} = {}) {
  const directory = path.join(temporary, name);
  await fs.mkdir(path.join(directory, "scripts/lib"), { recursive: true });
  await fs.mkdir(path.join(directory, "knowledge"), { recursive: true });
  await fs.mkdir(path.join(directory, "src/app"), { recursive: true });
  await fs.mkdir(path.join(directory, "src/server/other"), { recursive: true });
  await fs.mkdir(path.join(directory, "public/frontend/app"), { recursive: true });
  await fs.mkdir(path.join(directory, "public/frontend/feature-registry"), { recursive: true });
  await fs.mkdir(path.join(directory, "public/frontend/features"), { recursive: true });
  await fs.mkdir(path.join(directory, "public/frontend/opening"), { recursive: true });
  await fs.mkdir(path.join(directory, "public/frontend/pages"), { recursive: true });
  await fs.copyFile(checker, path.join(directory, "scripts/check-entrypoints.mjs"));
  await fs.copyFile(sourceAnalysis, path.join(directory, "scripts/lib/entrypoint-source-analysis.mjs"));
  await fs.copyFile(contractValidation, path.join(directory, "scripts/lib/entrypoint-contract-validation.mjs"));
  await fs.copyFile(moduleSurface, path.join(directory, "scripts/lib/entrypoint-module-surface.mjs"));
  await fs.copyFile(scopeAnalysis, path.join(directory, "scripts/lib/entrypoint-scope-analysis.mjs"));
  await fs.copyFile(staticValues, path.join(directory, "scripts/lib/entrypoint-static-values.mjs"));
  await fs.writeFile(path.join(directory, "scripts/entry-test.mjs"), "export {};\n");
  await fs.writeFile(path.join(directory, "src/app/index.mjs"), "export const createServerRuntime = () => {};\n");
  await fs.writeFile(path.join(directory, "src/app/internal.mjs"), "export const internal = true;\n");
  await fs.writeFile(path.join(directory, "src/server/other/index.mjs"), "export {};\n");
  await fs.writeFile(
    path.join(directory, "public/frontend/feature-registry/index.mjs"),
    "export const createFeatureRegistry = () => {};\n"
  );
  await fs.writeFile(
    path.join(directory, "public/frontend/features/index.mjs"),
    "export const mount = () => {};\n"
  );
  await fs.writeFile(
    path.join(directory, "public/frontend/pages/index.mjs"),
    "export const viewSections = Object.freeze({ home: \"home\" });\n"
  );
  await fs.writeFile(
    path.join(directory, "public/frontend/app/application.mjs"),
    "export const createBrowserApplication = () => {};\n"
  );
  await fs.writeFile(path.join(directory, "public/frontend/app/index.mjs"), "export const start = () => {};\n");
  await fs.writeFile(path.join(directory, "public/frontend/opening/index.mjs"), "export const startOpening = () => {};\n");
  await fs.writeFile(path.join(directory, "server.mjs"), serverSource);
  await fs.writeFile(path.join(directory, "public/frontend/app/runtime.mjs"), browserSource);
  await fs.writeFile(path.join(directory, "public/app.js"), bootstrapSource);
  for (const [relative, contents] of Object.entries(extraFiles)) {
    const target = path.join(directory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  const registryDocument = structuredClone(registryValue);
  const sourceByPath = {
    "server.mjs": serverSource,
    "public/frontend/app/runtime.mjs": browserSource,
    "public/app.js": bootstrapSource
  };
  for (const policy of registryDocument.entrypointPolicies || []) {
    if (policy.sourceSha256 === "fixture") {
      policy.sourceSha256 = crypto.createHash("sha256")
        .update(sourceByPath[policy.path] || "")
        .digest("hex");
    }
  }
  for (const exceptionValue of registryDocument.entrypointMigrationExceptions || []) {
    if (!Object.hasOwn(exceptionValue, "sourceSha256")) {
      exceptionValue.sourceSha256 = crypto.createHash("sha256")
        .update(sourceByPath[exceptionValue.path] || "")
        .digest("hex");
    }
  }
  await fs.writeFile(
    path.join(directory, "knowledge/module-boundaries.json"),
    `${JSON.stringify(registryDocument, null, 2)}\n`
  );
  return directory;
}

function run(directory, gate = "G3", registryPath = "knowledge/module-boundaries.json") {
  return spawnSync(process.execPath, [
    path.join(directory, "scripts/check-entrypoints.mjs"),
    "--root",
    directory,
    "--registry",
    registryPath,
    "--gate",
    gate
  ], { cwd: directory, encoding: "utf8" });
}

async function expectFailure(name, options, pattern, gate = "G3") {
  const directory = await fixture(name, options);
  const result = run(directory, gate);
  assert.equal(result.status, 1, `${name} unexpectedly passed:\n${result.stdout}`);
  assert.match(result.stderr, pattern);
}

const exception = (ruleId, extra = {}) => ({
  path: "server.mjs",
  ruleId,
  owner: "entrypoint-owner",
  removeWhen: "entry is composition-only",
  deleteByGate: "G4",
  ...extra
});

const lineCount = source => source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length;

try {
  {
    const directory = await fixture("valid");
    const result = run(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3 policies, 3 modules, 3 owned routes, 0 active migration exceptions/);
    assert.equal(result.stderr, "");
  }

  {
    const directory = await fixture("valid-assigned-lifecycle", {
      browserSource: validBrowserSource.replace(
        "  return application.start();",
        "  const startPromise = application.start();\n  return startPromise;"
      )
    });
    const result = run(directory);
    assert.equal(result.status, 0, result.stderr);
  }

  {
    const directory = await fixture("server-entry-without-exports", {
      serverSource: validServerSource.replace(
        "export const start = () => {};",
        "void runtime;"
      ),
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({ allowedExports: [], requiredExports: [] }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    });
    const result = run(directory);
    assert.equal(result.status, 0, result.stderr);
  }

  await expectFailure(
    "missing-policies",
    { registryValue: registry({ entrypointPolicies: undefined }) },
    /non-empty entrypointPolicies array/
  );

  {
    const directory = await fixture("external-registry");
    const outside = path.join(temporary, "outside-registry.json");
    await fs.writeFile(outside, `${JSON.stringify(registry(), null, 2)}\n`);
    const result = run(directory, "G3", outside);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /--registry escapes --root/);
  }

  {
    const directory = await fixture("symlink-registry");
    const outside = path.join(temporary, "outside-registry-link.json");
    await fs.writeFile(outside, `${JSON.stringify(registry(), null, 2)}\n`);
    const registryFile = path.join(directory, "knowledge/module-boundaries.json");
    await fs.rm(registryFile);
    await fs.symlink(outside, registryFile);
    const result = run(directory);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /--registry must not be a symbolic link/);
  }

  await expectFailure(
    "missing-kind-policy",
    { registryValue: registry({ entrypointPolicies: [serverPolicy()] }) },
    /exactly one browser entrypoint policy/
  );

  await expectFailure(
    "substituted-entrypoint-path",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({ path: "alternate-server.mjs" }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      }),
      extraFiles: { "alternate-server.mjs": validServerSource }
    },
    /server entrypoint policy must target server\.mjs/
  );

  await expectFailure(
    "changed-composition-api",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({
            compositionApi: {
              factory: "createReplacementRuntime",
              parameters: ["rootUrl", "processRef?"],
              methods: ["start", "ready", "stop"],
              httpFactory: "createHttpApplication",
              httpMembers: ["handle", "routeIds"]
            }
          }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /server entrypoint policy must define the frozen composition API/
  );

  await expectFailure(
    "removed-required-bindings",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({ requiredBindings: {} }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /server entrypoint policy must define the frozen required bindings/
  );

  await expectFailure(
    "removed-required-calls",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({ requiredCalls: [] }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /requiredCalls must be a non-empty array/
  );

  await expectFailure(
    "changed-required-calls",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({ requiredCalls: ["createServerRuntime"] }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /server entrypoint policy must define the frozen required calls/
  );

  await expectFailure(
    "changed-required-factory-use",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({
            requiredFactoryUses: [{
              specifier: "./src/app/index.mjs",
              imported: "createServerRuntime",
              result: "other",
              method: "start",
              directScope: "top-level",
              dependencies: []
            }]
          }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /server entrypoint policy must define the frozen factory lifecycle/
  );

  await expectFailure(
    "removed-core-forbidden-rule",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy(),
          browserPolicy(),
          {
            ...bootstrapPolicy(),
            forbiddenRules: bootstrapPolicy().forbiddenRules.filter(
              rule => rule.id !== "bootstrap.dynamic-code"
            )
          }
        ]
      })
    },
    /bootstrap entrypoint policy must define frozen rule bootstrap\.dynamic-code/
  );

  await expectFailure(
    "duplicate-policy",
    { registryValue: registry({ entrypointPolicies: [serverPolicy(), serverPolicy(), browserPolicy()] }) },
    /policy path must be unique/
  );

  await expectFailure(
    "deep-import",
    {
      serverSource: [
        "import { internal } from \"./src/app/internal.mjs\";",
        "export { internal as start };",
        ""
      ].join("\n")
    },
    /\[imports\].*internal\.mjs/
  );

  await expectFailure(
    "missing-required-import",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({
            allowedImports: ["./src/app/index.mjs", "./src/app/required.mjs"],
            requiredImports: ["./src/app/index.mjs", "./src/app/required.mjs"]
          }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      }),
      extraFiles: { "src/app/required.mjs": "export {};\n" }
    },
    /\[imports\].*required import is missing/
  );

  await expectFailure(
    "missing-required-binding",
    {
      serverSource: validServerSource.replaceAll("createServerRuntime", "createReplacementRuntime")
    },
    /\[import-bindings\].*required binding is missing/
  );

  await expectFailure(
    "missing-required-call",
    {
      serverSource: validServerSource.replace("runtime.start();", "void runtime;")
    },
    /\[calls\].*required call is missing: "runtime\.start"/
  );

  await expectFailure(
    "factory-wrong-result-binding",
    {
      serverSource: validServerSource.replace(
        "const runtime = createServerRuntime({});",
        "const other = createServerRuntime({}); const runtime = {};"
      )
    },
    /\[factory-use\].*runtime=createServerRuntime/
  );

  await expectFailure(
    "factory-shadowed-import",
    {
      serverSource: validServerSource
        .replace(
          "import { createServerRuntime } from \"./src/app/index.mjs\";",
          "import { createServerRuntime as importedRuntime } from \"./src/app/index.mjs\";\nfunction createServerRuntime() { return { start() {} }; }"
        )
    },
    /\[factory-use\].*runtime=createServerRuntime/
  );

  await expectFailure(
    "server-factory-nested-dead-code",
    {
      serverSource: validServerSource.replace(
        "const runtime = createServerRuntime({});\nruntime.start();",
        "if (false) { const runtime = createServerRuntime({}); runtime.start(); }"
      )
    },
    /\[factory-use\].*runtime=createServerRuntime/
  );

  await expectFailure(
    "server-factory-after-unconditional-throw",
    {
      serverSource: validServerSource.replace(
        "const runtime = createServerRuntime({});",
        "throw new Error(\"unreachable\");\nconst runtime = createServerRuntime({});"
      )
    },
    /\[factory-use\].*runtime=createServerRuntime/
  );

  await expectFailure(
    "server-lifecycle-short-circuited",
    {
      serverSource: validServerSource.replace(
        "runtime.start();",
        "false && runtime.start();"
      )
    },
    /\[factory-use\].*runtime\.start/
  );

  await expectFailure(
    "browser-factory-missing-registry-argument",
    {
      browserSource: validBrowserSource.replace(
        "const application = createBrowserApplication({ featureRegistry });",
        "const application = createBrowserApplication({});"
      )
    },
    /\[factory-use\].*application=createBrowserApplication/
  );

  await expectFailure(
    "browser-factory-null-registry-argument",
    {
      browserSource: validBrowserSource.replace(
        "const application = createBrowserApplication({ featureRegistry });",
        "const application = createBrowserApplication({ featureRegistry: null });"
      )
    },
    /\[factory-use\].*application=createBrowserApplication/
  );

  await expectFailure(
    "browser-factory-wrong-registry-source",
    {
      browserSource: validBrowserSource.replace(
        "const featureRegistry = createFeatureRegistry();",
        "const featureRegistry = otherFactory(); { const featureRegistry = createFeatureRegistry(); }"
      )
    },
    /\[factory-use\].*application=createBrowserApplication/
  );

  await expectFailure(
    "browser-lifecycle-before-assignment",
    {
      browserSource: validBrowserSource.replace(
        "  const application = createBrowserApplication({ featureRegistry });\n  return application.start();",
        "  application.start();\n  const application = createBrowserApplication({ featureRegistry });\n  return application;"
      )
    },
    /\[factory-use\].*application\.start/
  );

  await expectFailure(
    "browser-lifecycle-wrong-scope",
    {
      browserSource: validBrowserSource.replace(
        "  return application.start();",
        "  function boot() { return application.start(); }\n  return boot();"
      )
    },
    /\[factory-use\].*application\.start/
  );

  await expectFailure(
    "browser-factory-nested-dead-code",
    {
      browserSource: validBrowserSource.replace(
        "  const featureRegistry = createFeatureRegistry();\n  const application = createBrowserApplication({ featureRegistry });\n  return application.start();",
        "  if (false) {\n    const featureRegistry = createFeatureRegistry();\n    const application = createBrowserApplication({ featureRegistry });\n    return application.start();\n  }"
      )
    },
    /\[factory-use\].*application=createBrowserApplication/
  );

  await expectFailure(
    "browser-factory-nested-same-name-function",
    {
      browserSource: validBrowserSource.replace(
        "  const featureRegistry = createFeatureRegistry();\n  const application = createBrowserApplication({ featureRegistry });\n  return application.start();",
        "  function startApplication() {\n    const featureRegistry = createFeatureRegistry();\n    const application = createBrowserApplication({ featureRegistry });\n    return application.start();\n  }"
      )
    },
    /\[factory-use\].*application=createBrowserApplication/
  );

  await expectFailure(
    "browser-factory-after-return",
    {
      browserSource: validBrowserSource.replace(
        "  const featureRegistry = createFeatureRegistry();",
        "  return;\n  const featureRegistry = createFeatureRegistry();"
      )
    },
    /\[factory-use\].*featureRegistry=createFeatureRegistry/
  );

  for (const [name, exit] of [
    ["browser-factory-after-bare-block-return", "{ return; }"],
    ["browser-factory-after-try-return", "try { return; } finally {}"],
    ["browser-factory-after-constant-throw", "if (true) { throw new Error(\"unreachable\"); }"],
    ["browser-factory-after-asi-return", "return void 0\n  {}"],
    ["browser-factory-after-asi-throw", "throw new Error(\"unreachable\")\n  {}"]
  ]) {
    await expectFailure(
      name,
      {
        browserSource: validBrowserSource.replace(
          "  const featureRegistry = createFeatureRegistry();",
          `  ${exit}\n  const featureRegistry = createFeatureRegistry();`
        )
      },
      /\[factory-use\].*featureRegistry=createFeatureRegistry/
    );
  }

  await expectFailure(
    "browser-lifecycle-short-circuited",
    {
      browserSource: validBrowserSource.replace(
        "  return application.start();",
        "  false && application.start();"
      )
    },
    /\[factory-use\].*application\.start/
  );

  await expectFailure(
    "invalid-export",
    {
      serverSource: validServerSource.replace(
        "export const start = () => {};",
        "export const start = () => {}, leaked = true;"
      )
    },
    /\[exports\].*"leaked"/
  );

  await expectFailure(
    "missing-required-export",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({ allowedExports: ["start", "boot"], requiredExports: ["start", "boot"] }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /\[exports\].*required export is missing: "boot"/
  );

  await expectFailure(
    "nonliteral-import",
    {
      serverSource: validServerSource.replace(
        "const ratio = 12 / 3 / 2;",
        "const target = \"./src/app/index.mjs\"; void import(target);"
      )
    },
    /\[dynamic-import-literal\]/
  );

  await expectFailure(
    "dynamic-import-before-block",
    {
      serverSource: validServerSource.replace(
        "const ratio = 12 / 3 / 2;",
        "{ import(\"./forbidden.mjs\") {} }"
      )
    },
    /\[imports\].*forbidden\.mjs/
  );

  for (const [name, source] of [
    ["member-import", "loader.import(target);"],
    ["optional-member-import", "loader?.import?.(target);"],
    ["escaped-member-import", "loader.\\u0069mport(target);"],
    ["escaped-optional-member-import", "loader?.\\u0069mport?.(target);"],
    ["parenthesized-member-import", "(loader.import)(target);"],
    ["parenthesized-optional-member-import", "(loader?.import)?.(target);"],
    ["computed-member-import", "loader[\"im\" + \"port\"](target);"],
    ["aliased-member-import", "const load = loader.import; load(target);"],
    ["member-import-call", "loader.import.call(loader, target);"]
  ]) {
    await expectFailure(
      name,
      {
        serverSource: validServerSource.replace(
          "const ratio = 12 / 3 / 2;",
          `const target = "./module.mjs"; const loader = {}; ${source}`
        )
      },
      /\[dynamic-import-literal\].*indirect import methods are forbidden/
    );
  }

  for (const [name, expression] of [
    ["computed-global-dynamic-code", "globalThis[String.fromCharCode(82, 101, 102, 108, 101, 99, 116)]"],
    ["optional-computed-global", "globalThis?.[name]"],
    ["parenthesized-computed-global", "(globalThis)[name]"],
    ["parenthesized-optional-computed-global", "(globalThis)?.[name]"]
  ]) {
    await expectFailure(
      name,
      {
        serverSource: validServerSource.replace(
          "const ratio = 12 / 3 / 2;",
          `const name = "fetch"; const reflect = ${expression}; void reflect;`
        ),
        registryValue: registry({
          entrypointPolicies: [
            serverPolicy({
              forbiddenRules: [{
                id: "no-computed-global",
                kind: "syntax",
                values: ["computed-global-access"]
              }]
            }),
            browserPolicy(),
            bootstrapPolicy()
          ]
        })
      },
      /\[no-computed-global\].*forbidden syntax computed-global-access/
    );
  }

  for (const [name, source] of [
    ["reflective-import", "Reflect.get(loader, \"import\")(target);"],
    ["evaluated-import", "eval(\"import(target)\");"],
    ["function-import", "Function(\"target\", \"return import(target)\")(target);"]
  ]) {
    await expectFailure(
      name,
      {
        serverSource: validServerSource.replace(
          "const ratio = 12 / 3 / 2;",
          `const target = "./module.mjs"; const loader = {}; ${source}`
        ),
        registryValue: registry({
          entrypointPolicies: [
            serverPolicy({
              forbiddenRules: [{
                id: "no-dynamic-code",
                kind: "identifier",
                values: ["eval", "Function", "Reflect"]
              }]
            }),
            browserPolicy(),
            bootstrapPolicy()
          ]
        })
      },
      /\[no-dynamic-code\]/
    );
  }

  await expectFailure(
    "escaped-forbidden-syntax",
    {
      serverSource: validServerSource.replace(
        "const ratio = 12 / 3 / 2;",
        "const \\u0064angerous = \"\\x2fapi\\u002fstate\"; globalThis[\"set\\x54imeout\"](() => {}, 1);"
      )
    },
    /\[no-dangerous-identifier\][\s\S]*\[no-timer-call\][\s\S]*\[no-api-literal\]/
  );

  await expectFailure(
    "forbidden-identifier-alias",
    {
      serverSource: validServerSource.replace(
        "const ratio = 12 / 3 / 2;",
        "const schedule = setTimeout; void schedule;"
      ),
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({
            forbiddenRules: [{
              id: "no-timer-reference",
              kind: "identifier",
              values: ["setTimeout"]
            }]
          }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /\[no-timer-reference\].*forbidden identifier "setTimeout"/
  );

  await expectFailure(
    "forbidden-computed-identifier",
    {
      serverSource: validServerSource.replace(
        "const ratio = 12 / 3 / 2;",
        "const schedule = globalThis[(\"set\" + \"Timeout\")]; void schedule;"
      ),
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({
            forbiddenRules: [{
              id: "no-timer-reference",
              kind: "identifier",
              values: ["setTimeout"]
            }]
          }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /\[no-timer-reference\].*forbidden identifier "setTimeout"/
  );

  await expectFailure(
    "forbidden-template-computed-identifier",
    {
      serverSource: validServerSource.replace(
        "const ratio = 12 / 3 / 2;",
        "const request = globalThis[`${`${\"fe\"}`}tch`]; void request;"
      ),
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({
            forbiddenRules: [{
              id: "no-network-reference",
              kind: "identifier",
              values: ["fetch"]
            }]
          }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /\[no-network-reference\].*forbidden identifier "fetch"/
  );

  await expectFailure(
    "concatenated-api-path",
    {
      serverSource: validServerSource.replace(
        "const ratio = 12 / 3 / 2;",
        "const endpoint = \"/api\" + \"/state\"; void endpoint;"
      ),
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({
            forbiddenRules: [{
              id: "no-api-prefix",
              kind: "literal",
              values: ["^/api(?:/|$)"],
              match: "regex"
            }]
          }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /\[no-api-prefix\]/
  );

  for (const [name, expression] of [
    ["split-api-path", "\"/\" + \"api/state\""],
    ["static-template-api-path", "`/${\"api\"}/state`"]
  ]) {
    await expectFailure(
      name,
      {
        serverSource: validServerSource.replace(
          "const ratio = 12 / 3 / 2;",
          `const endpoint = ${expression}; void endpoint;`
        ),
        registryValue: registry({
          entrypointPolicies: [
            serverPolicy({
              forbiddenRules: [{
                id: "no-api-prefix",
                kind: "literal",
                values: ["^/api(?:/|$)"],
                match: "regex"
              }]
            }),
            browserPolicy(),
            bootstrapPolicy()
          ]
        })
      },
      /\[no-api-prefix\]/
    );
  }

  {
    const directory = await fixture("escaped-import", {
      serverSource: validServerSource.replace(
        "./src/app/index.mjs",
        "./src/\\u0061pp/index.mjs"
      )
    });
    const result = run(directory);
    assert.equal(result.status, 0, result.stderr);
  }

  await expectFailure(
    "relative-import-escape",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({
            allowedImports: ["../outside.mjs"],
            requiredImports: ["../outside.mjs"],
            requiredBindings: { "../outside.mjs": ["createServerRuntime"] }
          }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /allowedImports\[0\] escapes --root/
  );

  {
    const outside = path.join(temporary, "outside-entry.mjs");
    await fs.writeFile(outside, validServerSource);
    const directory = await fixture("symlink-entry");
    const entry = path.join(directory, "server.mjs");
    await fs.rm(entry);
    await fs.symlink(outside, entry);
    const result = run(directory);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /entrypointPolicies\[0\]\.path must not be a symbolic link/);
  }

  {
    const outside = path.join(temporary, "outside-module.mjs");
    await fs.writeFile(outside, "export const createServerRuntime = () => {};\n");
    const directory = await fixture("symlink-module");
    const moduleEntry = path.join(directory, "src/app/index.mjs");
    await fs.rm(moduleEntry);
    await fs.symlink(outside, moduleEntry);
    const result = run(directory);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /modules\[0\]\.publicEntry resolves outside --root/);
  }

  {
    const directory = await fixture("symlink-entry-parent");
    const appDirectory = path.join(directory, "public/frontend/app");
    const linkedDirectory = path.join(directory, "public/frontend/app-real");
    await fs.rename(appDirectory, linkedDirectory);
    await fs.symlink("app-real", appDirectory);
    const result = run(directory);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /entrypointPolicies\[1\]\.path path must not contain symbolic links/);
  }

  await expectFailure(
    "handler-order",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({ handlerOrder: ["primary", "primary"] }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /handlerOrder must not contain duplicates/
  );

  await expectFailure(
    "invented-handler-order",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({ handlerOrder: ["invented-handler-name"] }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /handlerOrder must match the frozen server handler order/
  );

  await expectFailure(
    "handler-unknown-route-owner",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({
            routeOwnerModules: ["app", "missing"]
          }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /names an unknown module/
  );

  await expectFailure(
    "handler-route-gap",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({
            routeOwnerModules: ["app"]
          }),
          browserPolicy(),
          bootstrapPolicy()
        ]
      })
    },
    /Owned routes are missing from routeOwnerModules: GET \/three/
  );

  await expectFailure(
    "unknown-feature",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy(),
          browserPolicy({
            pageFeatureDescriptors: [{
              page: "home",
              feature: "frontend.feature.missing",
              specifier: "../features/index.mjs"
            }]
          }),
          bootstrapPolicy()
        ]
      })
    },
    /must name a registered feature module/
  );

  await expectFailure(
    "page-descriptor-gap",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy(),
          browserPolicy({ expectedPages: ["home", "settings"] }),
          bootstrapPolicy()
        ]
      })
    },
    /pageFeatureDescriptors do not match expectedPages; missing=settings/
  );

  await expectFailure(
    "page-catalog-mismatch",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy(),
          browserPolicy({
            expectedPages: ["phantom-page"],
            pageFeatureDescriptors: [{
              page: "phantom-page",
              feature: "frontend.feature.home",
              specifier: "../features/index.mjs"
            }]
          }),
          bootstrapPolicy()
        ]
      })
    },
    /expectedPages do not match the live page catalog/
  );

  await expectFailure(
    "page-catalog-substitution",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy(),
          browserPolicy({
            allowedImports: ["./application.mjs", "../feature-registry/index.mjs", "../features/index.mjs", "../pages/index.mjs", "../pages/alternate.mjs"],
            requiredImports: ["./application.mjs", "../feature-registry/index.mjs", "../features/index.mjs", "../pages/index.mjs", "../pages/alternate.mjs"],
            pageCatalog: {
              specifier: "../pages/alternate.mjs",
              export: "viewSections"
            }
          }),
          bootstrapPolicy()
        ]
      }),
      extraFiles: {
        "public/frontend/pages/alternate.mjs": "export const viewSections = { home: \"home\" };\n"
      }
    },
    /browser entrypoint policy must use the frozen page catalog/
  );

  await expectFailure(
    "bootstrap-boundary",
    {
      bootstrapSource: `${validBootstrapSource}const later = setTimeout; void later;\n`
    },
    /\[bootstrap\.timer\].*forbidden identifier "setTimeout"/
  );

  await expectFailure(
    "bootstrap-computed-network",
    {
      bootstrapSource: `${validBootstrapSource}void globalThis["fetch"]("/state");\n`
    },
    /\[bootstrap\.network\].*forbidden identifier "fetch"/
  );

  await expectFailure(
    "bootstrap-source-fingerprint-changed",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy(),
          browserPolicy(),
          bootstrapPolicy({ sourceSha256: "0".repeat(64) })
        ]
      })
    },
    /public\/app\.js does not match its frozen sourceSha256/
  );

  await expectFailure(
    "bootstrap-source-fingerprint-missing",
    {
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy(),
          browserPolicy(),
          bootstrapPolicy({ sourceSha256: undefined })
        ]
      })
    },
    /sourceSha256 is required for the bootstrap policy/
  );

  await expectFailure(
    "module-cycle",
    {
      registryValue: registry({
        modules: modules().map(module => module.id === "app"
          ? { ...module, allowedDependencies: ["server.other"] }
          : module)
      })
    },
    /Module dependency cycle detected: app -> server\.other -> app/
  );

  await expectFailure(
    "hard-lines",
    { serverSource: `${validServerSource}${"void 0;\n".repeat(30)}` },
    /\[lines\.hard\].*exceeds hard limit 30/
  );

  await expectFailure(
    "exception-missing-field",
    {
      serverSource: `${validServerSource}dangerous();\n`,
      registryValue: registry({
        entrypointMigrationExceptions: [{
          path: "server.mjs",
          ruleId: "no-dangerous-identifier",
          removeWhen: "entry is composition-only",
          deleteByGate: "G4",
          allowlist: [{ detail: "forbidden identifier \"dangerous\"", count: 1 }]
        }]
      })
    },
    /entrypointMigrationExceptions\[0\]\.owner must be a non-empty string/
  );

  await expectFailure(
    "global-exception-not-reused",
    {
      serverSource: `${validServerSource}dangerous();\n`,
      registryValue: registry({
        migrationExceptions: [{
          path: "server.mjs",
          ruleId: "no-dangerous-identifier",
          owner: "wrong-registry",
          removeWhen: "never",
          maxMatches: 1
        }]
      })
    },
    /\[no-dangerous-identifier\]/
  );

  await expectFailure(
    "expired-exception",
    {
      serverSource: `${validServerSource}dangerous();\n`,
      registryValue: registry({
        entrypointMigrationExceptions: [
          exception("no-dangerous-identifier", {
            deleteByGate: "G3",
            allowlist: [{ detail: "forbidden identifier \"dangerous\"", count: 1 }]
          })
        ]
      })
    },
    /expired at G3/
  );

  await expectFailure(
    "exception-exceeds-policy-deadline",
    {
      serverSource: `${validServerSource}dangerous();\n`,
      registryValue: registry({
        entrypointMigrationExceptions: [
          exception("no-dangerous-identifier", {
            deleteByGate: "G6",
            allowlist: [{ detail: "forbidden identifier \"dangerous\"", count: 1 }]
          })
        ]
      })
    },
    /deleteByGate exceeds the server deadline G4/
  );

  await expectFailure(
    "stale-exception",
    {
      registryValue: registry({
        entrypointMigrationExceptions: [
          exception("no-dangerous-identifier", {
            allowlist: [{ detail: "forbidden identifier \"dangerous\"", count: 1 }]
          })
        ]
      })
    },
    /is stale/
  );

  {
    const value = registry({
      entrypointMigrationExceptions: [
        exception("no-dangerous-identifier", {
          allowlist: [{ detail: "forbidden identifier \"dangerous\"", count: 1 }]
        })
      ]
    });
    const directory = await fixture("active-exception", {
      serverSource: `${validServerSource}dangerous();\n`,
      registryValue: value
    });
    const result = run(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 active migration exceptions/);
  }

  await expectFailure(
    "exception-source-fingerprint-changed",
    {
      serverSource: `dangerous();\n${validServerSource}`,
      registryValue: registry({
        entrypointMigrationExceptions: [
          exception("no-dangerous-identifier", {
            sourceSha256: crypto.createHash("sha256")
              .update(`${validServerSource}dangerous();\n`)
              .digest("hex"),
            allowlist: [{ detail: "forbidden identifier \"dangerous\"", count: 1 }]
          })
        ]
      })
    },
    /sourceSha256 does not match/
  );

  await expectFailure(
    "exception-same-count-replacement",
    {
      serverSource: `${validServerSource}hazardous();\n`,
      registryValue: registry({
        entrypointPolicies: [
          serverPolicy({ forbiddenRules: forbiddenRules(["dangerous", "hazardous"]) }),
          browserPolicy(),
          bootstrapPolicy()
        ],
        entrypointMigrationExceptions: [
          exception("no-dangerous-identifier", {
            allowlist: [{ detail: "forbidden identifier \"dangerous\"", count: 1 }]
          })
        ]
      })
    },
    /does not allow violation detail "forbidden identifier \\"hazardous\\""/
  );

  await expectFailure(
    "exception-growth",
    {
      serverSource: `${validServerSource}dangerous(); dangerous();\n`,
      registryValue: registry({
        entrypointMigrationExceptions: [
          exception("no-dangerous-identifier", {
            allowlist: [{ detail: "forbidden identifier \"dangerous\"", count: 1 }]
          })
        ]
      })
    },
    /matched 2, expected exactly 1/
  );

  {
    const source = `${validServerSource}${"void 0;\n".repeat(30)}`;
    const maxValue = lineCount(source);
    const value = registry({
      entrypointMigrationExceptions: [exception("lines.hard", { maxValue })]
    });
    const directory = await fixture("line-max-value", { serverSource: source, registryValue: value });
    const result = run(directory);
    assert.equal(result.status, 0, result.stderr);
    await expectFailure(
      "line-max-value-growth",
      { serverSource: `${source}void 1;\n`, registryValue: value },
      new RegExp(`value ${maxValue + 1} exceeds maxValue ${maxValue}`)
    );
  }

  await expectFailure(
    "g7-exception",
    {
      serverSource: `${validServerSource}dangerous();\n`,
      registryValue: registry({
        entrypointMigrationExceptions: [
          exception("no-dangerous-identifier", {
            deleteByGate: "G7",
            allowlist: [{ detail: "forbidden identifier \"dangerous\"", count: 1 }]
          })
        ]
      })
    },
    /must be empty at G7/,
    "G7"
  );

  console.log(
    "Entrypoint boundary regression passed: exact exceptions, required surfaces, handler/page contracts, "
    + "route ownership, dependency cycles, escaped tokens, regex/division boundaries, computed calls, and path containment."
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
