/**
 * 业务短 ID 的共享格式与随机字节编码。
 * 建立时间：2026-10-14
 * 状态：active
 * 边界：仅规定新业务身份格式；不改变历史 UUID、认证和协议身份。
 */
export const BUSINESS_ID_BYTES = 12;
export const BUSINESS_ID_LENGTH = 16;
export const BUSINESS_ID_ATTEMPTS = 8;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 判断新业务身份格式；历史 UUID 读取不依赖此检查。 @since unreleased */
export function isBusinessId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16}$/.test(value);
}

/** 判断支持临时身份回执的正式创建路径；状态流转不属于创建。 @since unreleased */
export function isBusinessCreationPath(method: string, pathname: string): boolean {
  return method === "POST" && /^\/api\/v1\/(captures|journals|books|quotes|keepsakes|checkins|daily-records|actions|habits|thought-chains|feedback|validation-ledger)(\/[^/]+\/(remarks|follow-ups|annotations|notes|replies|checkins))?$/.test(pathname);
}

/** 将恰好 12 个随机字节编码为无填充 base64url；随机性由调用方保证。 @since unreleased */
export function encodeBusinessId(bytes: Uint8Array): string {
  if (bytes.length !== BUSINESS_ID_BYTES) throw new TypeError("业务 ID 需要 12 个随机字节");
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const bits = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    result += alphabet[(bits >>> 18) & 63] + alphabet[(bits >>> 12) & 63]
      + alphabet[(bits >>> 6) & 63] + alphabet[bits & 63];
  }
  return result;
}
