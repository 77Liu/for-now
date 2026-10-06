import { promises as fs } from "node:fs";
import path from "node:path";

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg"
});

export const contentTypeFor = name => (
  MIME_TYPES[path.extname(name).toLowerCase()] || "application/octet-stream"
);

export function createStaticHttp({
  publicDir,
  basePath,
  isApplicationRoutePath,
  sendJson
}) {
  const indexFile = path.join(publicDir, "index.html");

  return {
    async handle(req, res, url, context) {
      const applicationRoute = ["GET", "HEAD"].includes(req.method || "GET")
        && isApplicationRoutePath(url.pathname);
      if (applicationRoute && !context.basePathMatched) {
        return sendJson(res, 404, { error: "Not found", code: "NOT_FOUND" });
      }
      const relative = applicationRoute
        ? "index.html"
        : url.pathname.replace(/^\/+/, "");
      const file = path.resolve(publicDir, relative);
      if (!file.startsWith(`${publicDir}${path.sep}`) && file !== indexFile) {
        return sendJson(res, 403, { error: "Forbidden" });
      }
      let data = await fs.readFile(file);
      if (file === indexFile && basePath !== "/") {
        const baseHref = `${basePath}/`
          .replaceAll("&", "&amp;")
          .replaceAll("\"", "&quot;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
        data = Buffer.from(
          data.toString("utf8")
            .replace('<base href="/">', `<base href="${baseHref}">`)
        );
      }
      res.writeHead(200, {
        "content-type": contentTypeFor(file),
        "cache-control": "no-store"
      });
      res.end(req.method === "HEAD" ? undefined : data);
      return true;
    }
  };
}
