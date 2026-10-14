/**
 * 离线业务引用映射；保留正文与协议身份。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：仅改写显式身份字段与 URL 路径段，账户隔离由队列仓储负责。
 */
/** 账户与创建操作共同绑定的身份映射，禁止仅按临时字符串识别依赖。 @since unreleased */
export interface BusinessIdMapping {
  accountId: string;
  operationId: string;
  provisionalId: string;
  canonicalId: string;
}
const referenceFields = new Set(["targetId", "rootId", "parentId", "relatedTo", "answerId", "thoughtId", "bookId",
  "quoteId", "captureId", "journalId", "annotationId", "replyId", "remarkId", "followUpId", "resourceId"]);

/** 仅改写声明依赖该创建操作的 JSON Pointer；正文与协议字段不能被声明。 @since unreleased */
export function remapBusinessReferences(value: unknown, mapping: BusinessIdMapping, pointers: string[] = []): unknown {
  const result = structuredClone(value);
  for (const pointer of pointers) {
    if (!pointer.startsWith("/")) throw new TypeError("业务依赖字段需要 JSON Pointer");
    const keys = pointer.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (keys.some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw new TypeError("业务依赖字段无效");
    const leaf = keys.at(-1) || "", container = keys.at(-2) || "";
    if (!referenceFields.has(leaf) && !(leaf === "id" && ["sourceRef", "targetRef", "resourceRef"].includes(container))) {
      throw new TypeError("业务依赖不能指向正文或协议字段");
    }
    let row = result as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) {
      if (!row || typeof row !== "object" || !Object.hasOwn(row, key)) { row = {}; break; }
      row = row[key] as Record<string, unknown>;
    }
    if (row && typeof row === "object" && row[leaf] === mapping.provisionalId) row[leaf] = mapping.canonicalId;
  }
  return result;
}

/** 仅改写声明属于该创建操作的 URL 路径位置，保留其他同名身份和查询。 @since unreleased */
export function remapBusinessUrl(url: string, mapping: BusinessIdMapping, segments: number[] = []): string {
  const [path, ...query] = url.split("?");
  return path.split("/").map((segment, index) => segments.includes(index) && segment === mapping.provisionalId ? mapping.canonicalId : segment).join("/")
    + (query.length ? `?${query.join("?")}` : "");
}
