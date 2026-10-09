import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packagePath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");
const publicReleasePath = path.join(root, "public/release-info.js");
const iosReleasePath = path.join(root, "ios/release-version.xcconfig");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function releaseMetadata(packageJson) {
  const releaseVersion = String(packageJson.version || "");
  const numericIdentifier = "(?:0|[1-9]\\d*)";
  const nonNumericIdentifier = "(?:\\d*[A-Za-z-][0-9A-Za-z-]*)";
  const prereleaseIdentifier = `(?:${numericIdentifier}|${nonNumericIdentifier})`;
  const buildIdentifier = "[0-9A-Za-z-]+";
  const versionPattern = new RegExp(
    `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)`
      + `(?:-(${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*))?`
      + `(?:\\+(${buildIdentifier}(?:\\.${buildIdentifier})*))?$`
  );
  if (!versionPattern.test(releaseVersion)) {
    throw new Error(`无效的 package.json version：${releaseVersion || "（空）"}`);
  }

  const iosBuildNumber = packageJson.release?.iosBuildNumber;
  if (!Number.isSafeInteger(iosBuildNumber) || iosBuildNumber < 1) {
    throw new Error("package.json release.iosBuildNumber 必须是正整数");
  }

  return {
    releaseVersion,
    appVersion: releaseVersion.split(/[+-]/, 1)[0],
    cacheVersion: `cike-shell-${releaseVersion}`,
    iosBuildNumber
  };
}

function renderPublicReleaseInfo({ releaseVersion, appVersion, cacheVersion }) {
  return `globalThis.CIKE_RELEASE_INFO = Object.freeze({
  appVersion: ${JSON.stringify(appVersion)},
  releaseVersion: ${JSON.stringify(releaseVersion)},
  cacheVersion: ${JSON.stringify(cacheVersion)}
});

if (typeof document !== "undefined") {
  const updateReleaseLabels = () => {
    document.querySelectorAll("[data-release-version]").forEach(element => {
      element.textContent = \`v\${globalThis.CIKE_RELEASE_INFO.appVersion}\`;
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateReleaseLabels, { once: true });
  } else {
    updateReleaseLabels();
  }
}
`;
}

function renderIosReleaseConfig({ appVersion, iosBuildNumber }) {
  return `APP_MARKETING_VERSION = ${appVersion}\nAPP_BUILD_NUMBER = ${iosBuildNumber}\n`;
}

async function writeReleaseMetadata(packageJson, packageLock) {
  const metadata = releaseMetadata(packageJson);
  if (!packageLock.packages?.[""]) {
    throw new Error("package-lock.json 缺少根 packages[\"\"] 项");
  }
  packageLock.version = metadata.releaseVersion;
  packageLock.packages[""].version = metadata.releaseVersion;

  await Promise.all([
    writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`),
    writeFile(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`),
    writeFile(publicReleasePath, renderPublicReleaseInfo(metadata)),
    writeFile(iosReleasePath, renderIosReleaseConfig(metadata))
  ]);
  console.log(`已同步发行元数据：${metadata.releaseVersion}`);
}

async function checkReleaseMetadata(packageJson, packageLock) {
  const metadata = releaseMetadata(packageJson);
  const expected = [
    ["package-lock.json 根版本", packageLock.version, metadata.releaseVersion],
    ["package-lock.json 包版本", packageLock.packages?.[""]?.version, metadata.releaseVersion],
    ["public/release-info.js", await readFile(publicReleasePath, "utf8"), renderPublicReleaseInfo(metadata)],
    ["ios/release-version.xcconfig", await readFile(iosReleasePath, "utf8"), renderIosReleaseConfig(metadata)]
  ];
  const mismatches = expected
    .filter(([, actual, wanted]) => actual !== wanted)
    .map(([label]) => label);

  if (mismatches.length) {
    throw new Error(`发行元数据过期，请运行 npm run release:sync：${mismatches.join("、")}`);
  }
  console.log(`发行元数据一致：${metadata.releaseVersion}`);
}

const args = process.argv.slice(2);
const [mode, requestedVersion, ...extraArgs] = args;
const packageJson = await readJson(packagePath);
const packageLock = await readJson(lockPath);

if (args.length === 0 || mode === "--sync") {
  if (requestedVersion || extraArgs.length) throw new Error("--sync 不接受参数");
  await writeReleaseMetadata(packageJson, packageLock);
} else if (mode === "--check") {
  if (requestedVersion || extraArgs.length) throw new Error("--check 不接受参数");
  await checkReleaseMetadata(packageJson, packageLock);
} else if (mode === "--set") {
  if (!requestedVersion || extraArgs.length) {
    throw new Error("用法：npm run release:set -- <版本号>");
  }
  const currentVersion = String(packageJson.version || "");
  releaseMetadata({ ...packageJson, version: requestedVersion });
  if (requestedVersion !== currentVersion) {
    packageJson.release.iosBuildNumber += 1;
  }
  packageJson.version = requestedVersion;
  await writeReleaseMetadata(packageJson, packageLock);
} else {
  throw new Error("用法：node scripts/sync-release-metadata.mjs [--sync | --check | --set <版本号>]");
}
