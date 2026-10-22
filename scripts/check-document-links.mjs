import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const result = spawnSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024
});
if (result.status !== 0) throw new Error(result.stderr.trim() || "git ls-files failed");

const tracked = result.stdout.split("\0").filter(Boolean);
const trackedSet = new Set(tracked);
const documents = tracked.filter(file => /\.(?:md|html?)$/iu.test(file));
const failures = [];
const external = new Set();
const runtimeUrls = new Set();

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

function stripCode(content) {
  const lines = content.split("\n");
  let fence = null;
  return lines.map(line => {
    const marker = /^\s*(```+|~~~+)/u.exec(line)?.[1] ?? null;
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      return "";
    }
    if (fence) return "";
    return line.replace(/`[^`\n]*`/gu, "");
  }).join("\n");
}

function linkTarget(raw) {
  const value = raw.trim();
  if (value.startsWith("<")) {
    const end = value.indexOf(">");
    return end < 0 ? value : value.slice(1, end);
  }
  return value.split(/\s+(?=["'])/u, 1)[0];
}

function linksIn(content) {
  const stripped = stripCode(content);
  const links = [];
  const patterns = [
    /!?\[[^\]\n]*\]\(([^)\n]+)\)/gu,
    /^\s*\[[^\]\n]+\]:\s*(\S+)/gmu,
    /\b(?:href|src)\s*=\s*["']([^"']+)["']/giu
  ];
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      links.push({ target: linkTarget(match[1]), line: lineOf(stripped, match.index) });
    }
  }
  return links;
}

function markdownSlug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/gu, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/gu, "-");
}

function anchorsIn(content) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of stripCode(content).split("\n")) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!heading) continue;
    const base = markdownSlug(heading[1]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  for (const match of content.matchAll(/\b(?:id|name)=["']([^"']+)["']/giu)) anchors.add(match[1]);
  return anchors;
}

async function trackedTarget(relative, source, line) {
  const absolute = path.resolve(root, relative);
  const inside = path.relative(root, absolute);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
    failures.push(`${source}:${line}: 链接越出项目目录：${relative}`);
    return null;
  }
  if (inside === "reports" || inside.startsWith(`reports${path.sep}`)) {
    failures.push(`${source}:${line}: 正式文档不得链接已忽略的 reports/：${relative}`);
    return null;
  }
  let targetStat;
  try {
    targetStat = await stat(absolute);
  } catch {
    failures.push(`${source}:${line}: 目标不存在：${relative}`);
    return null;
  }
  const normalized = inside.split(path.sep).join("/");
  if (targetStat.isDirectory()) {
    if (!tracked.some(file => file.startsWith(`${normalized}/`))) {
      failures.push(`${source}:${line}: 目标目录没有已跟踪内容：${relative}`);
      return null;
    }
  } else if (!trackedSet.has(normalized)) {
    failures.push(`${source}:${line}: 目标未被 Git 跟踪：${relative}`);
    return null;
  }
  return { absolute, normalized, stat: targetStat };
}

for (const source of documents) {
  const content = await readFile(path.join(root, source), "utf8");
  for (const { target, line } of linksIn(content)) {
    if (!target) {
      failures.push(`${source}:${line}: 空链接`);
      continue;
    }
    if (/^(?:https?):\/\//iu.test(target)) {
      const hostname = new URL(target).hostname;
      if (["127.0.0.1", "localhost", "::1"].includes(hostname)) runtimeUrls.add(target);
      else external.add(target);
      continue;
    }
    if (/^(?:mailto|tel|data):/iu.test(target)) continue;
    if (/\.html?$/iu.test(source) && target.startsWith("/")) continue;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target)
      || target.startsWith("/")
      || target.startsWith("~/")
      || /^[A-Za-z]:[\\/]/u.test(target)) {
      failures.push(`${source}:${line}: 项目链接必须是相对链接：${target}`);
      continue;
    }

    const hashIndex = target.indexOf("#");
    const queryIndex = target.indexOf("?");
    const pathEnd = [hashIndex, queryIndex].filter(index => index >= 0).reduce(
      (lowest, index) => Math.min(lowest, index),
      target.length
    );
    let pathname = target.slice(0, pathEnd);
    const fragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : "";
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      failures.push(`${source}:${line}: 链接编码无效：${target}`);
      continue;
    }
    const relative = pathname
      ? path.join(path.dirname(source), pathname)
      : source;
    const resolved = await trackedTarget(relative, source, line);
    if (!resolved || !fragment || resolved.stat.isDirectory()) continue;

    let decodedFragment;
    try {
      decodedFragment = decodeURIComponent(fragment);
    } catch {
      failures.push(`${source}:${line}: 锚点编码无效：${target}`);
      continue;
    }
    const lineReference = /^L(\d+)(?:-L?(\d+))?$/u.exec(decodedFragment);
    const targetContent = await readFile(resolved.absolute, "utf8");
    if (lineReference) {
      const lastLine = Number(lineReference[2] ?? lineReference[1]);
      const lines = targetContent.split("\n").length;
      if (lastLine > lines) failures.push(`${source}:${line}: 行号超出目标文件：${target}`);
    } else if (/\.md$/iu.test(resolved.normalized)
      && !anchorsIn(targetContent).has(decodedFragment)) {
      failures.push(`${source}:${line}: Markdown 锚点不存在：${target}`);
    }
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

let protectedResponses = 0;
if (process.argv.includes("--external")) {
  const urls = [...external];
  const externalFailures = [];
  const protectedNotFoundHosts = new Set(["my.feishu.cn"]);
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      try {
        let response = await fetch(url, {
          method: "HEAD",
          redirect: "follow",
          signal: AbortSignal.timeout(15_000)
        });
        if ([405, 501].includes(response.status)) {
          response = await fetch(url, {
            headers: { Range: "bytes=0-0" },
            redirect: "follow",
            signal: AbortSignal.timeout(15_000)
          });
        }
        const protectedNotFound = response.status === 404
          && protectedNotFoundHosts.has(new URL(url).hostname);
        if (protectedNotFound || [401, 403, 429].includes(response.status)) protectedResponses++;
        if ((!protectedNotFound && response.status === 404)
          || response.status === 410
          || response.status >= 500) {
          externalFailures.push(`${response.status} ${url}`);
        }
      } catch (error) {
        externalFailures.push(`${error.name}: ${url}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
  if (externalFailures.length) {
    process.stderr.write(`${externalFailures.join("\n")}\n`);
    process.exit(1);
  }
}

process.stdout.write(
  `文档链接检查通过：${documents.length} 个文档，${external.size} 个外部链接，`
  + `${runtimeUrls.size} 个环回运行入口`
  + (process.argv.includes("--external") ? `，${protectedResponses} 个鉴权或限流响应` : "")
  + "。\n"
);
