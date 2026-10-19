/**
 * 为分页和阅读状态真实浏览器验收暂留隔离 PostgreSQL 应用。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：仅由隔离 PG 套件显式启用；不输出会话、凭据或真实用户资料。
 */
import { promises as fs } from "node:fs";
import type { RecordEntity } from "../src/shared/persistence/record-command-types.mjs";

/** 写入合成页面夹具，等待浏览器验证回执；超时仍由外层 finally 清理进程。 @since unreleased */
export async function holdThoughtBrowserProbe({ base, username, seed }: {
  base: string;
  username: string;
  seed(thoughts: RecordEntity[]): Promise<() => Promise<void>>;
}): Promise<void> {
  const output = process.env.THOUGHT_BROWSER_PROBE;
  if (!output) return;
  if (!/^http:\/\/127\.0\.0\.1:\d+\/now$/u.test(base)) throw new Error("Browser probe requires isolated loopback app");
  const thoughts = Array.from({ length: 141 }, (_, index) => ({
    id: `browser-thought-${String(index).padStart(4, "0")}`,
    type: "question",
    content: `浏览器分页验收 ${index}：保持锚点和阅读状态`,
    version: 1,
    createdAt: new Date(Date.UTC(2026, 9, 18, 8, 0, index)).toISOString(),
    occurredAt: new Date(Date.UTC(2026, 9, 18, 8, 0, index)).toISOString(),
    occurredOn: "2026-10-18",
    tags: ["浏览器验收"],
    disposition: "kept",
    annotations: [],
    annotationDrift: [],
    remarks: [],
    followUps: index === 140 ? [0, 1].map(followIndex => ({
      id: `browser-follow-${followIndex}`,
      question: `阅读状态追问 ${followIndex}：保持当前开合`,
      answer: `阅读状态回答 ${followIndex}：${"逐段阅读并保留位置。\n\n".repeat(15)}`,
      version: 1,
      createdAt: "2026-10-18T08:03:00.000Z"
    })) : []
  }));
  const dispose = await seed(thoughts);
  const deadline = Date.now() + 20 * 60 * 1000;
  try {
    await fs.writeFile(output, JSON.stringify({ base, username, fixtureRoots: thoughts.length }), { mode: 0o600, flag: "wx" });
    while (Date.now() < deadline) {
      if (await fs.stat(`${output}.continue`).then(() => true, () => false)) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("Isolated thought browser probe timed out");
  } finally {
    await dispose();
  }
}
