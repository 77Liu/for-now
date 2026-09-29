export function createExportHttp({ createExport, snapshot, attachmentInventory = null }) {
  async function handleV1(req, res, url, v1) {
    if (req.method !== "GET" || url.pathname !== "/api/v1/exports/account") return false;
    const format = url.searchParams.get("format") || "manifest";
    if (!["manifest", "json", "markdown", "md"].includes(format)) {
      return v1.error(res, 400, "导出格式只能是 manifest、json 或 markdown", "INVALID_EXPORT_FORMAT");
    }
    const source = await snapshot();
    const accountExport = createExport(attachmentInventory
      ? { ...source, attachmentInventory: await attachmentInventory(source) }
      : source);
    const data = format === "manifest"
      ? accountExport.manifest
      : accountExport.files[format === "md" ? "markdown" : format];
    return v1.success(res, 200, data);
  }

  return { handleV1 };
}
