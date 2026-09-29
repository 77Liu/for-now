export function createKeepsakeHttp({
  segment,
  records,
  remove,
  sendTrashResult,
  bodyJson,
  sendJson,
  requestBinding,
  present = value => value,
  getOriginal = null,
  media = null,
  mediaBodyMaxBytes
}) {
  async function handle(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/keepsakes/segment") {
      const input = await bodyJson(req);
      try {
        sendJson(res, 200, { ...await segment(input), ...requestBinding(input) });
      } catch (error) {
        const status = /请选择|图片格式|图片大小|不支持/.test(error.message) ? 400 : 502;
        sendJson(res, status, { error: error.message });
      }
    } else if (req.method === "POST" && url.pathname === "/api/keepsakes") {
      const input = await bodyJson(req, mediaBodyMaxBytes);
      const result = media && input.image && input.alphaMask
        ? await media.create(input)
        : await records.create(input);
      if (result.error) sendJson(res, 400, { error: result.error });
      else sendJson(res, 201, present(result.value));
    } else if (req.method === "PATCH" && /^\/api\/keepsakes\/[^/]+$/.test(url.pathname)) {
      const input = await bodyJson(req, mediaBodyMaxBytes);
      const result = media && input.alphaMask
        ? await media.update(url.pathname.split("/")[3], input)
        : await records.update(url.pathname.split("/")[3], input);
      if (result.missing) sendJson(res, 404, { error: "这件小物不存在" });
      else if (result.conflict) sendJson(res, 409, { error: "小物图片已经变化，请重新打开后再编辑", code: "VERSION_CONFLICT" });
      else if (result.error) sendJson(res, 400, { error: result.error });
      else sendJson(res, 200, present(result.value));
    } else if (getOriginal && req.method === "GET" && /^\/api\/keepsakes\/[^/]+\/original$/.test(url.pathname)) {
      const result = await getOriginal(url.pathname.split("/")[3]);
      if (!result) sendJson(res, 404, { error: "这件小物不存在或原图不可用" });
      else sendJson(res, 200, result);
    } else if (req.method === "DELETE" && /^\/api\/keepsakes\/[^/]+$/.test(url.pathname)) {
      await sendTrashResult(res, await remove(url.pathname.split("/")[3]), "这件小物不存在");
    } else return false;
    return true;
  }
  return { handle };
}
