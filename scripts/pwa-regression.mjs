import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicPath = (...parts) => path.join(ROOT, "public", ...parts);

const manifest = JSON.parse(await fs.readFile(publicPath("manifest.webmanifest"), "utf8"));
assert.equal(manifest.display, "standalone");
assert.deepEqual(
  manifest.icons.map(icon => [icon.src, icon.sizes, icon.type]),
  [
    ["assets/icons/icon-192.png", "192x192", "image/png"],
    ["assets/icons/icon-512.png", "512x512", "image/png"]
  ]
);

for (const [file, expectedSize] of [
  ["assets/icons/apple-touch-icon.png", 180],
  ["assets/icons/icon-192.png", 192],
  ["assets/icons/icon-512.png", 512]
]) {
  const image = await fs.readFile(publicPath(file));
  assert.equal(image.subarray(1, 4).toString(), "PNG");
  assert.equal(image.readUInt32BE(16), expectedSize);
  assert.equal(image.readUInt32BE(20), expectedSize);
}

const html = await fs.readFile(publicPath("index.html"), "utf8");
assert.match(html, /rel="apple-touch-icon"[^>]+apple-touch-icon\.png/);
assert.match(html, /navigator\.serviceWorker\.register\(["']service-worker\.js["']/);

const worker = await fs.readFile(publicPath("service-worker.js"), "utf8");
assert.match(worker, /const CACHE_VERSION\s*=\s*["'][^"']+["']/);
const assetSet = name => {
  const source = worker.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`))?.[1] || "";
  return new Set([...source.matchAll(/["']([^"']+)["']/g)].map(match => match[1]));
};
const shellAssets = assetSet("SHELL_ASSETS");
const katexAssets = assetSet("KATEX_ASSETS");
const backgroundAssets = assetSet("HOME_BACKGROUND_ASSETS");
for (const asset of [
  "./",
  "index.html",
  "drift.css",
  "app.js",
  "frontend/app/runtime.mjs",
  "frontend/sync/index.mjs",
  "frontend/styles/application.css"
]) assert.ok(shellAssets.has(asset), `预缓存缺少 ${asset}`);
for (const asset of [
  "vendor/katex/katex.min.css",
  "vendor/katex/katex.min.js",
  "assets/home-v0.2/desktop-background.png",
  "assets/home-v0.2/mobile-background.png",
  "assets/home-v0.2/desktop-background.d55ffa4f0582.webp",
  "assets/home-v0.2/mobile-background.788fb03c2ae3.webp",
  "assets/home-v0.2/desktop-background.1408885ed7d3.avif",
  "assets/home-v0.2/mobile-background.0549e6676ea3.avif"
]) {
  const assets = asset.startsWith("vendor/katex/") ? katexAssets : backgroundAssets;
  assert.ok(assets.has(asset), `静态资源闭包缺少 ${asset}`);
  assert.equal(shellAssets.has(asset), false, `资源必须由独立缓存策略管理: ${asset}`);
}
for (const asset of [...katexAssets, ...backgroundAssets]) {
  await fs.access(publicPath(asset));
}
for (const asset of [...backgroundAssets].filter(value => /\.(?:webp|avif)$/.test(value))) {
  const image = await fs.readFile(publicPath(asset));
  const expectedHash = path.basename(asset).split(".").at(-2);
  assert.equal(crypto.createHash("sha256").update(image).digest("hex").startsWith(expectedHash), true, `背景指纹不匹配: ${asset}`);
  assert.ok(image.length <= 32 * 1024, `背景派生超过 32 KiB: ${asset}`);
  if (asset.endsWith(".webp")) {
    assert.equal(image.subarray(0, 4).toString(), "RIFF");
    assert.equal(image.subarray(8, 12).toString(), "WEBP");
  } else {
    assert.equal(image.subarray(4, 12).toString(), "ftypavif");
  }
}
const katexStyles = await fs.readFile(publicPath("vendor/katex/katex.min.css"), "utf8");
const katexFonts = new Set([...katexStyles.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g)].map(match => `vendor/katex/fonts/${match[1]}`));
for (const font of katexFonts) assert.ok(katexAssets.has(font), `KaTeX 延迟闭包缺少 ${font}`);

const dependencies = source => [
  ...source.matchAll(/\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s*)?["']([^"']+)["']/g),
  ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)
].map(match => match[1]);
const pendingModules = [...shellAssets].filter(asset => /\.(?:m?js)$/.test(asset));
const visitedModules = new Set();
while (pendingModules.length) {
  const asset = pendingModules.pop();
  if (visitedModules.has(asset)) continue;
  visitedModules.add(asset);
  const source = await fs.readFile(publicPath(asset), "utf8");
  for (const specifier of dependencies(source)) {
    if (!specifier.startsWith(".")) continue;
    const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(asset), specifier));
    assert.ok(shellAssets.has(dependency), `预缓存模块闭包缺少 ${dependency}（由 ${asset} 引用）`);
    if (/\.(?:m?js)$/.test(dependency)) pendingModules.push(dependency);
  }
}
assert.match(worker, /cache\.addAll\(\[\.\.\.SHELL_ASSETS,\s*\.\.\.KATEX_ASSETS\]\)/);
assert.match(worker, /event\.respondWith\(cacheOnUse\(request\)\)/);
assert.match(worker, /request\.mode\s*===\s*["']navigate["']/);
assert.match(worker, /cache\.match\(["']\.\/["']\)/);
for (const boundary of ["/api/", "/attachments/", "/auth/", "/ai/"]) {
  assert.ok(worker.includes(JSON.stringify(boundary)), `联网排除边界缺少 ${boundary}`);
}
assert.match(worker, /if\s*\(\s*isNetworkOnly\(url\)\s*\)\s*return/);

console.log(`PWA contracts passed: install icons, ${visitedModules.size} cached modules, offline KaTeX closure, deferred backgrounds, navigation fallback, and private/network-only exclusions.`);
