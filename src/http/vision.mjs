export function createVisionHttp({
  vision,
  ocrGate,
  documentGate,
  auditCall = async (_details, invoke) => invoke(),
  bodyJson,
  sendJson,
  uploadBodyMaxBytes
}) {
  if (!vision || typeof vision.recognizeText !== "function" || typeof vision.parseDocument !== "function") {
    throw new TypeError("Vision HTTP requires a provider");
  }

  async function withGate(gate, operation) {
    const release = await gate.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/vision/status") {
      sendJson(res, 200, { configured: vision.configured, ocr: "OCRNormal", document: "OCRPdf-v3" });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/vision/ocr") {
      const input = await bodyJson(req, uploadBodyMaxBytes);
      const parsed = vision.parseImageDataUrl(input.image);
      sendJson(res, 200, await auditCall({
        provider: "volcengine",
        service: "vision",
        scene: "visionOcr",
        action: "OCRNormal",
        request: { imageBytes: parsed.data.length, mimeType: parsed.mimeType },
        modality: "vision",
        imageCount: 1,
        imageBytes: parsed.data.length,
        unitType: "image",
        units: 1,
        costKnown: false,
        costSource: "Volcengine billing not configured"
      }, () => withGate(ocrGate, () => vision.recognizeText(parsed))));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/vision/document") {
      const input = await bodyJson(req, uploadBodyMaxBytes);
      const parsed = vision.parseDocumentDataUrl(input.document);
      sendJson(res, 200, await auditCall({
        provider: "volcengine",
        service: "vision",
        scene: "documentParsing",
        action: "OCRPdf",
        request: { documentBytes: parsed.data.length, mimeType: parsed.mimeType },
        modality: "document",
        unitType: "document",
        units: 1,
        costKnown: false,
        costSource: "Volcengine billing not configured"
      }, () => withGate(documentGate, () => vision.parseDocument(parsed))));
      return true;
    }
    return false;
  }

  return { handle };
}
