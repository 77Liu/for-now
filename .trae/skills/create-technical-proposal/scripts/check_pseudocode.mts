/**
 * 使用 Node 24 解析类 TS 语法。
 * 建立时间：2026-10-21；状态：active。
 * 边界：仅解析、不执行；不要求辅助类型或函数已实现。
 */
import * as nodeModule from "node:module";
// 项目现有Node类型包较旧；限定Node 24此API签名，不扩大为any或升级依赖。
const { stripTypeScriptTypes } = nodeModule as typeof nodeModule & {
  stripTypeScriptTypes(source: string, options: { mode: "transform" }): string;
};
import { readFileSync } from "node:fs";
try {
  stripTypeScriptTypes(readFileSync(0, "utf8"), { mode: "transform" });
  console.log("[]");
} catch (error) {
  if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ERR_INVALID_TYPESCRIPT_SYNTAX") throw error;
  console.log(JSON.stringify([{ line: 1, message: (error as Error).message }]));
}
