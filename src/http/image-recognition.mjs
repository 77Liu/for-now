const SUPPORTED_IMAGE_KINDS = new Set([
  "sleep",
  "heartRate",
  "weight",
  "exercise",
  "book"
]);

export function createImageRecognitionHttp({
  parseImage,
  parseBook,
  bodyJson,
  sendJson,
  requestBinding = () => ({})
}) {
  if (typeof parseImage !== "function" || typeof parseBook !== "function") {
    throw new TypeError("Image recognition HTTP requires health and book parsers");
  }
  if (typeof bodyJson !== "function" || typeof sendJson !== "function") {
    throw new TypeError("Image recognition HTTP requires JSON adapters");
  }

  async function handle(req, res, url) {
    if (req.method !== "POST" || url.pathname !== "/api/images/parse") return false;
    const input = await bodyJson(req);
    const kind = SUPPORTED_IMAGE_KINDS.has(input.kind) ? input.kind : "";
    if (!kind) {
      sendJson(res, 400, { error: "截图类型无效" });
      return true;
    }
    try {
      const parsed = kind === "book"
        ? await parseBook(input)
        : await parseImage(input, kind);
      sendJson(res, 200, { ...parsed, ...requestBinding(input) });
    } catch (error) {
      if (!/图片|截图|支持|大小/.test(error.message)) throw error;
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  return { handle };
}
