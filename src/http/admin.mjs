import crypto from "node:crypto";

const ADMIN_SNAPSHOT_PATH = "/api/admin/v1/snapshot";
const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex");

const isDirectLoopbackRequest = req => {
  const remote = String(req.socket?.remoteAddress || "");
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)
    && !req.headers["x-forwarded-for"];
};

const serviceTokenMatches = (req, expectedHash) => {
  if (!expectedHash) return false;
  const match = /^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(String(req.headers.authorization || ""));
  if (!match) return false;
  const actual = Buffer.from(sha256(match[1]), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

export function createAdminHttp({
  serviceTokenHash,
  buildSnapshot,
  snapshotOptions,
  sendJson
}) {
  if (typeof buildSnapshot !== "function") throw new TypeError("Admin HTTP requires buildSnapshot()");
  if (typeof sendJson !== "function") throw new TypeError("Admin HTTP requires sendJson()");
  return {
    async handle(req, res, url) {
      if (url.pathname !== ADMIN_SNAPSHOT_PATH) return false;
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      if (!serviceTokenHash) {
        sendJson(res, 404, { error: "Not found" });
        return true;
      }
      if (!isDirectLoopbackRequest(req)) {
        sendJson(res, 403, { error: "管理员数据接口只允许本机服务访问" });
        return true;
      }
      if (!serviceTokenMatches(req, serviceTokenHash)) {
        sendJson(res, 401, { error: "服务凭据无效" });
        return true;
      }
      sendJson(res, 200, await buildSnapshot(snapshotOptions));
      return true;
    }
  };
}
