/**
 * 从源码或编译入口定位项目根目录，不依赖终端工作目录。
 * 建立时间：2026-10-15
 * 状态：active
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 向上查找本项目 package.json；支持迁移后的目录和 .build 下的入口。 */
export function projectRoot(moduleUrl: string): string {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)
      && JSON.parse(readFileSync(manifest, "utf8")).name === "personal-growth-tracker") return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("未找到个人成长追踪项目根目录");
    directory = parent;
  }
}
