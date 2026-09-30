import assert from "node:assert/strict";
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
for (const asset of [
  "./",
  "index.html",
  "styles.css",
  "drift.css",
  "app.js",
  "frontend/app/runtime.mjs",
  "frontend/styles/application.css",
  "assets/home-v0.2/desktop-background.png",
  "assets/home-v0.2/mobile-background.png"
]) assert.ok(worker.includes(JSON.stringify(asset)), `预缓存缺少 ${asset}`);
assert.match(worker, /request\.mode\s*===\s*["']navigate["']/);
assert.match(worker, /cache\.match\(["']\.\/["']\)/);
for (const boundary of ["/api/", "/attachments/", "/auth/", "/ai/"]) {
  assert.ok(worker.includes(JSON.stringify(boundary)), `联网排除边界缺少 ${boundary}`);
}
assert.match(worker, /if\s*\(\s*isNetworkOnly\(url\)\s*\)\s*return/);

console.log("PWA contracts passed: install icons, registration, versioned shell cache, navigation fallback, and private/network-only exclusions.");
