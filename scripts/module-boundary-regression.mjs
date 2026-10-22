import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "module-boundary-regression-"));
const checkerFiles = [
  "scripts/check-modules.mjs",
  "scripts/lib/entrypoint-module-surface.mjs",
  "scripts/lib/entrypoint-scope-analysis.mjs",
  "scripts/lib/entrypoint-source-analysis.mjs",
  "scripts/lib/entrypoint-static-values.mjs"
];

async function write(relative, value) {
  const file = path.join(temporary, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

function run() {
  return spawnSync(process.execPath, [path.join(temporary, "scripts/check-modules.mjs")], {
    cwd: temporary,
    encoding: "utf8"
  });
}

function expectFailure(result, pattern) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, pattern);
}

try {
  for (const relative of checkerFiles) {
    await write(relative, await fs.readFile(path.join(ROOT, relative), "utf8"));
  }
  await fs.symlink(
    path.join(ROOT, "node_modules"),
    path.join(temporary, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await write("fixture.ts", "export {};\n");
  const fixtureTsconfig = JSON.stringify({
    compilerOptions: { noEmit: true, skipLibCheck: true },
    files: ["fixture.ts"]
  });
  await write("tsconfig.ai-migrations.json", fixtureTsconfig);
  await write("tsconfig.thought-db-regression.json", fixtureTsconfig);
  await write("server.mjs", "export {};\n");
  await write("admin-snapshot.mjs", "export {};\n");
  await write("public/app.js", "export {};\n");
  const inlineRuntimeScript = [
    'window.__runtime = import(new URL("frontend/app/runtime.mjs", document.baseURI).href);',
    'window.__kernel = import(new URL("frontend/app/runtime/kernel.mjs", document.baseURI).href);'
  ].join("\n");
  await write(
    "public/index.html",
    `<script>${inlineRuntimeScript}</script>\n`
  );
  await write("public/service-worker.js", "export {};\n");
  await write("src/app/index.mjs", "export const publicValue = true;\n");
  await write("src/app/internal.mjs", "export const privateValue = true;\n");
  await write(
    "src/feature/index.mjs",
    "import { publicValue } from \"../app/index.mjs\";\nexport { publicValue };\n"
  );
  await write(
    "scripts/app-regression.mjs",
    "import { publicValue } from \"../src/app/index.mjs\";\nvoid publicValue;\n"
  );
  await write("scripts/feature-regression.mjs", "import \"../src/feature/index.mjs\";\n");
  const registryValue = {
    version: 1,
    inlineRuntimeBootstrapSha256: crypto.createHash("sha256")
      .update(inlineRuntimeScript)
      .digest("hex"),
    modules: [{
      id: "app",
      type: "application",
      root: "src/app",
      publicEntry: "src/app/index.mjs",
      allowedDependencies: [],
      owns: { routes: [] },
      tests: ["scripts/app-regression.mjs"]
    }, {
      id: "feature",
      type: "application",
      root: "src/feature",
      publicEntry: "src/feature/index.mjs",
      allowedDependencies: ["app"],
      owns: { routes: [] },
      tests: ["scripts/feature-regression.mjs"]
    }],
    migrationExceptions: []
  };
  await write("knowledge/module-boundaries.json", `${JSON.stringify(registryValue, null, 2)}\n`);

  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);

  await write(
    "src/feature/index.mjs",
    "const target = \"../app/internal.mjs\";\nexport const load = () => import(target);\n"
  );
  expectFailure(run(), /Non-literal or indirect import in src\/feature\/index\.mjs/);

  await write(
    "src/feature/index.mjs",
    "export const load = () => import(\"../app/internal.mjs\");\n"
  );
  expectFailure(run(), /Deep import into app/);

  await write(
    "src/feature/index.mjs",
    "export { publicValue } from \"../app/index.mjs\";\n"
  );
  await write(
    "scripts/app-regression.mjs",
    "import { privateValue } from \"../src/app/internal.mjs\";\nvoid privateValue;\n"
  );
  expectFailure(run(), /Deep import into app/);

  await write(
    "scripts/app-regression.mjs",
    "import { publicValue } from \"../src/app/index.mjs\";\nvoid publicValue;\n"
  );
  await write(
    "src/feature/index.mjs",
    "const target = \"../app/internal.mjs\";\nexport const load = () => eval(\"import(target)\");\n"
  );
  expectFailure(run(), /Dynamic code is forbidden in src\/feature\/index\.mjs/);

  await write(
    "src/feature/index.mjs",
    "export { publicValue } from \"../app/index.mjs\";\n"
  );
  registryValue.modules[0].tests = ["scripts/nested/app-regression.mjs"];
  await write("knowledge/module-boundaries.json", `${JSON.stringify(registryValue, null, 2)}\n`);
  await write(
    "scripts/nested/app-regression.mjs",
    "import { privateValue } from \"../../src/app/internal.mjs\";\nvoid privateValue;\n"
  );
  expectFailure(run(), /Deep import into app/);

  await write(
    "scripts/nested/app-regression.mjs",
    "const target = \"../../src/app/internal.mjs\";\nvoid import(target);\n"
  );
  expectFailure(run(), /Non-literal or indirect import in scripts\/nested\/app-regression\.mjs/);

  await write(
    "scripts/nested/app-regression.mjs",
    "import { publicValue } from \"../../src/app/index.mjs\";\nvoid publicValue;\n"
  );
  await write("public/service-worker.js", "eval(\"import('/private.mjs')\");\n");
  expectFailure(run(), /Dynamic code is forbidden in public\/service-worker\.js/);

  await write(
    "public/service-worker.js",
    "(()=>{}).constructor(\"return import('/private.mjs')\")();\n"
  );
  expectFailure(run(), /Dynamic code is forbidden in public\/service-worker\.js/);

  await write(
    "public/service-worker.js",
    "const DynamicFunction = (()=>{}).constructor;\nDynamicFunction(\"return import('/private.mjs')\")();\n"
  );
  expectFailure(run(), /Dynamic code is forbidden in public\/service-worker\.js/);

  await write(
    "public/service-worker.js",
    "(()=>{})[\"constr\" + \"uctor\"](\"return import('/private.mjs')\")();\n"
  );
  expectFailure(run(), /Dynamic code is forbidden in public\/service-worker\.js/);

  await write("public/service-worker.js", "export {};\n");
  await write(
    "admin-snapshot.mjs",
    "Reflect.get(globalThis, \"eval\")(\"import('/private.mjs')\");\n"
  );
  expectFailure(run(), /Dynamic code is forbidden in admin-snapshot\.mjs/);

  await write("admin-snapshot.mjs", "export {};\n");
  await write(
    "public/index.html",
    '<script>window.__runtime = import(new URL("frontend/app/runtime.mjs", document.baseURI).href); window.__kernel = import(new URL("frontend/app/runtime/kernel.mjs", document.baseURI).href); const target = "./private.mjs"; void import(target);</script>\n'
  );
  expectFailure(run(), /only the frozen runtime prefetch import/);

  await write(
    "public/index.html",
    '<script>window.__runtime = import(new URL("frontend/app/runtime.mjs", document.baseURI).href); window.__kernel = import(new URL("frontend/app/runtime/kernel.mjs", document.baseURI).href);\n// changed frozen script</script>\n'
  );
  expectFailure(run(), /runtime prefetch script changed/);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

console.log("Module boundary checker regression passed: public entries are enforced and production dynamic imports cannot hide dependencies.");
