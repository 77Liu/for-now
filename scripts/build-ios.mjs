import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const deviceBuild = process.argv.includes("--device");
const buildKind = deviceBuild ? "ios-device" : "ios-simulator";
const sdk = deviceBuild ? "iphoneos" : "iphonesimulator";
const destination = deviceBuild ? "generic/platform=iOS" : "generic/platform=iOS Simulator";
const productDirectory = deviceBuild ? "Release-iphoneos" : "Release-iphonesimulator";
const artifactSuffix = deviceBuild ? "ios-device-unsigned" : "ios-simulator";
const derivedData = path.join(root, "build", buildKind);
const packages = path.join(root, ".xcode-packages");
const appPath = path.join(derivedData, "Build", "Products", productDirectory, "App.app");
const artifactDir = path.join(root, "artifacts", "ios");
const artifactPath = path.join(artifactDir, `cike-${packageJson.version}-${artifactSuffix}.zip`);
const xcodeHome = path.join(root, ".xcode-home");
const xcodeCache = path.join(root, ".xcode-cache");
const apiOrigin = String(process.env.CIKE_IOS_API_ORIGIN || "https://77liu.top/now").replace(/\/+$/, "");
const parsedApiOrigin = new URL(apiOrigin);
const localHttp = parsedApiOrigin.protocol === "http:"
  && ["localhost", "127.0.0.1", "::1"].includes(parsedApiOrigin.hostname)
  && process.env.CIKE_IOS_ALLOW_HTTP_LOCAL === "1";
if (parsedApiOrigin.protocol !== "https:" && !localHttp) {
  throw new Error("CIKE_IOS_API_ORIGIN must use HTTPS unless CIKE_IOS_ALLOW_HTTP_LOCAL=1 targets localhost");
}
const env = {
  ...process.env,
  HOME: xcodeHome,
  CFFIXED_USER_HOME: xcodeHome,
  CLANG_MODULE_CACHE_PATH: path.join(xcodeCache, "clang"),
  SWIFTPM_MODULECACHE_OVERRIDE: path.join(xcodeCache, "swiftpm")
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with code ${code}`)));
  });
}

await Promise.all([
  mkdir(xcodeHome, { recursive: true }),
  mkdir(xcodeCache, { recursive: true }),
  mkdir(packages, { recursive: true }),
  mkdir(artifactDir, { recursive: true })
]);

await run(process.execPath, ["scripts/sync-release-metadata.mjs", "--check"]);
await rm(derivedData, { recursive: true, force: true });
await run("npx", ["cap", "sync", "ios"]);
const nativeIndex = path.join(root, "ios", "App", "App", "public", "index.html");
const html = await readFile(nativeIndex, "utf8");
const markedHtml = html.replace("<html lang=\"zh-CN\">", `<html lang="zh-CN" data-api-origin="${apiOrigin}">`);
if (markedHtml === html) throw new Error("Native index API origin marker was not inserted");
await writeFile(nativeIndex, markedHtml);
await run("xcodebuild", [
  "-quiet",
  "-project", "ios/App/App.xcodeproj",
  "-scheme", "App",
  "-configuration", "Release",
  "-sdk", sdk,
  "-destination", destination,
  "-derivedDataPath", derivedData,
  "-clonedSourcePackagesDirPath", packages,
  "CODE_SIGNING_ALLOWED=NO",
  "build"
]);
await access(appPath);
await rm(artifactPath, { force: true });
await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, artifactPath]);

console.log(`iOS app: ${appPath}`);
console.log(`iOS package: ${artifactPath}`);
