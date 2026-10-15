/**
 * 项目相对路径和地图文档跳转回归。
 * 建立时间：2026-10-15
 * 状态：active
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAPS = [
  "README.md",
  "README-TODO.md",
  "SOP/README.md",
  "one-mistake-one-rule.md",
  "docs/technical-proposals/评审索引.md"
];
const TEXT_FILE = /\.(?:command|css|html|js|json|jsonl|md|mjs|mts|sh|svg|ts|txt|xml|ya?ml)$/u;
// v0.5.13-v0.5.15 在路径规则生效前已封存，内容和摘要不可为迁移而改写。
const IMMUTABLE_CONTROL_HISTORY = /^coordination\/versions\/v0\.5\.(?:13|14|15)\/(?:events\.jsonl|terminal\.json)$/u;
const ROOT_LINE = /^所在根目录：`[^`\n]+`。/mu;

function listedFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: ROOT,
    encoding: "utf8"
  }).split("\0").filter(Boolean);
}

function githubSlug(value) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/<[^>]*>/gu, "")
    .replace(/[`*_~[\]()]/gu, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

function headings(file) {
  const result = new Set();
  const counts = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!match) continue;
    const base = githubSlug(match[1]);
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    result.add(count ? `${base}-${count}` : base);
  }
  return result;
}

function localTarget(map, rawTarget) {
  const decoded = decodeURIComponent(rawTarget.replace(/^<|>$/gu, ""));
  const [filePart, anchor = ""] = decoded.split("#", 2);
  if (!filePart) return { file: path.join(ROOT, map), anchor };
  return { file: path.resolve(path.dirname(path.join(ROOT, map)), filePart), anchor };
}

const files = listedFiles().filter(file => TEXT_FILE.test(file) && existsSync(path.join(ROOT, file)));
for (const file of files) {
  if (IMMUTABLE_CONTROL_HISTORY.test(file)) continue;
  const source = readFileSync(path.join(ROOT, file), "utf8");
  const inspected = file === "PROJECT_RULES.md" ? source.replace(ROOT_LINE, "") : source;
  assert.doesNotMatch(inspected, /(?:file:\/\/)?\/Users\/[A-Za-z0-9._-]+\//u, `${file} contains a user-directory absolute path`);
  assert.doesNotMatch(inspected, /Documents\/Codex\/个人成长追踪/u, `${file} contains the retired project root`);
}

for (const map of MAPS) {
  const mapFile = path.join(ROOT, map);
  assert.ok(existsSync(mapFile), `${map} is missing`);
  const source = readFileSync(mapFile, "utf8");
  for (const match of source.matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu)) {
    const target = match[2];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(target)) continue;
    const resolved = localTarget(map, target);
    assert.ok(existsSync(resolved.file), `${map} -> ${target} is missing`);
    assert.ok(statSync(resolved.file).isFile() || statSync(resolved.file).isDirectory(), `${map} -> ${target} is not a file or directory`);
    if (resolved.anchor && statSync(resolved.file).isFile() && path.extname(resolved.file).toLowerCase() === ".md") {
      assert.ok(headings(resolved.file).has(resolved.anchor), `${map} -> ${target} has a missing anchor`);
    }
  }
}

console.log(`Project paths passed: ${files.length} maintained text files and ${MAPS.length} map documents.`);
