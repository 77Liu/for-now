export function createPersonalContextHttp({ readStore, project }) {
  if (typeof readStore !== "function" || typeof project !== "function") {
    throw new TypeError("Personal context HTTP requires a store reader and projector");
  }

  async function handleV1(req, res, url, v1) {
    if (req.method !== "GET" || url.pathname !== "/api/v1/personal-context") return false;
    const { overview } = project(await readStore());
    return v1.success(res, 200, overview);
  }

  return { handleV1 };
}
