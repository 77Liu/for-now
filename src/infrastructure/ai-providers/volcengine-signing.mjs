import crypto from "node:crypto";

const ALGORITHM = "HMAC-SHA256";

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => crypto.createHmac("sha256", key).update(value).digest();
const encode = value => encodeURIComponent(String(value))
  .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

export function volcengineTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export function canonicalQuery(params = {}) {
  return Object.entries(params)
    .flatMap(([key, value]) => Array.isArray(value)
      ? value.map(item => [key, item])
      : [[key, value]])
    .filter(([, value]) => value != null)
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function signVolcengineRequest({
  method = "POST",
  pathname = "/",
  params = {},
  body = "",
  headers = {},
  accessKeyId,
  secretAccessKey,
  sessionToken = "",
  region = "cn-north-1",
  service = "cv",
  date = new Date()
}) {
  if (!accessKeyId || !secretAccessKey) throw new Error("火山视觉访问密钥尚未配置");
  const timestamp = volcengineTimestamp(date);
  const shortDate = timestamp.slice(0, 8);
  const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key.toLowerCase(),
    String(value).trim().replace(/\s+/g, " ")
  ]));
  normalizedHeaders["x-date"] = timestamp;
  if (sessionToken) normalizedHeaders["x-security-token"] = sessionToken;
  const signedHeaderNames = Object.keys(normalizedHeaders).sort();
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalHeaders = `${signedHeaderNames.map(name => `${name}:${normalizedHeaders[name]}`).join("\n")}\n`;
  const query = canonicalQuery(params);
  const canonicalRequest = [
    method.toUpperCase(),
    pathname || "/",
    query,
    canonicalHeaders,
    signedHeaders,
    sha256(body)
  ].join("\n");
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = [ALGORITHM, timestamp, credentialScope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(secretAccessKey, shortDate), region), service), "request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    query,
    headers: {
      ...normalizedHeaders,
      authorization: `${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    },
    canonicalRequest,
    stringToSign,
    signature
  };
}
