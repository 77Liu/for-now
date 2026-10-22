/**
 * 校验服务端与浏览器分页产物来自同一次构建。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：只检查本机发布制品，不执行浏览器模块或连接数据库。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

/** 分页启用时由启动入口核对复制产物；缺失或字节不一致拒绝启动。 @since unreleased */
export async function assertThoughtPagingBuildContract(rootDir: string): Promise<void> {
  const backend = path.join(rootDir, ".build/typescript/backend/shared/thought-pagination/index.mjs");
  const frontend = path.join(rootDir, "public/generated/thought-pagination-config.mjs");
  try {
    const backendSource = await readFile(backend);
    const frontendSource = await readFile(frontend);
    if (!backendSource.equals(frontendSource)) {
      throw new Error("Thought pagination artifacts differ");
    }
  } catch (cause) {
    throw Object.assign(new Error("思绪分页构建产物不一致，请重新完整构建"), {
      code: "THOUGHT_PAGING_CONFIG_MISMATCH",
      cause
    });
  }
}
