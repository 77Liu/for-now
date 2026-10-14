/**
 * 日压缩与历史补充处理请求的短来源别名。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：映射仅存本次 work；内部哈希/主键不改，解码后继续原引用/许可/精确引文校验。
 */
/** 本次处理请求实际提供的来源别名目录。 @since unreleased */
export interface CompressionSourceAliases {
  modelInput: unknown;
  sources: { alias: string; sourceId: string }[];
}
const invalidSource = "invalid-model-source-reference";

function transform(value: unknown, source: (value: string) => string, outbound: boolean): unknown {
  if (Array.isArray(value)) return value.map(child => transform(child, source, outbound));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // 这些是处理输入的内部定位元数据，不是模型引用身份；原 work 保留完整值。
    if (outbound && ["recordId", "rootId", "targetKey"].includes(key)) continue;
    if (key === "sourceId" && typeof child === "string") result[key] = source(child);
    else if ((key === "sourceIds" || key === "derivedFrom") && Array.isArray(child)) {
      result[key] = child.map(item => typeof item === "string" ? source(item) : invalidSource)
        .filter(item => key !== "derivedFrom" || item !== invalidSource);
    } else result[key] = transform(child, source, outbound);
  }
  return result;
}

/** 编码实际输入中的来源为 r1/r2；不增加来源、不强加随机参考数量。 @since unreleased */
export function prepareCompressionSourceAliases(input: Record<string, unknown>): CompressionSourceAliases {
  const rows = Array.isArray(input.sourceManifest) ? input.sourceManifest
    : Array.isArray(input.userSources) ? input.userSources : [];
  const ids = [...new Set(rows.flatMap(row => row && typeof row === "object"
    && typeof row.sourceId === "string" ? [row.sourceId] : []))];
  const sources = ids.map((sourceId, index) => ({ alias: `r${index + 1}`, sourceId }));
  const aliases = new Map(sources.map(row => [row.sourceId, row.alias]));
  return { sources, modelInput: transform(input, value => aliases.get(value) || invalidSource, true) };
}

/** 只解码本请求已提供的别名；未知或直接返回的内部身份交原校验器拒绝。 @since unreleased */
export function decodeCompressionSourceAliases(value: unknown, aliases: CompressionSourceAliases): unknown {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return value; }
  }
  const sourceIds = new Map(aliases.sources.map(row => [row.alias, row.sourceId]));
  return transform(parsed, source => sourceIds.get(source) || invalidSource, false);
}
