import { createReasoningDisclosure } from "../ui/index.mjs";

const IMAGE_UI = Object.freeze({
  cover: Object.freeze({
    input: "#book-cover-image",
    preview: "#book-cover-preview",
    box: "#book-cover-upload-box",
    title: "#book-cover-upload-title",
    hint: "#book-cover-upload-hint",
    remove: "#book-cover-remove",
    emptyTitle: "选择、粘贴或拖入封面",
    emptyHint: "PNG / JPEG / WebP · 不超过 8 MB"
  }),
  recognition: Object.freeze({
    input: "#book-recognition-image",
    preview: "#book-recognition-preview",
    box: "#book-recognition-upload-box",
    title: "#book-recognition-upload-title",
    hint: "#book-recognition-upload-hint",
    remove: "#book-recognition-remove",
    emptyTitle: "选择、粘贴或拖入识别图",
    emptyHint: "PNG / JPEG / WebP · 不超过 8 MB"
  })
});

const formatBytes = value => value < 1024
  ? `${value} B`
  : value < 1048576
    ? `${(value / 1024).toFixed(1)} KB`
    : `${(value / 1048576).toFixed(1)} MB`;

const abortFailure = () => new DOMException("Library feature context changed", "AbortError");

export function createLibraryMedia({
  data,
  media,
  platform,
  state,
  libraryView,
  createTicket,
  isCurrent,
  isSameSession
} = {}) {
  let revision = 0;
  let pasteTarget = "recognition";
  let reasoning = null;
  const files = { cover: null, recognition: null };
  const previewUrls = { cover: "", recognition: "" };
  const query = selector => libraryView.query(selector);

  function updateSwapButton() {
    const button = query("#book-image-swap");
    const cover = query("#book-cover-preview");
    const recognition = query("#book-recognition-preview");
    if (button) button.disabled = !cover || !recognition || cover.hidden || recognition.hidden;
  }

  function revoke(role) {
    if (previewUrls[role]) platform.objectUrls.revokeObjectURL(previewUrls[role]);
    previewUrls[role] = "";
  }

  function resetImage(role, { existingPath = "" } = {}) {
    revision += 1;
    const ui = IMAGE_UI[role];
    revoke(role);
    files[role] = null;
    const input = query(ui.input);
    const box = query(ui.box);
    const preview = query(ui.preview);
    if (input) input.value = "";
    box?.classList.remove("has-image", "dragging");
    if (preview) {
      if (existingPath) {
        preview.src = existingPath;
        preview.hidden = false;
        query(ui.title).textContent = "当前封面";
        query(ui.hint).textContent = "选择新图片即可替换";
        box?.classList.add("has-image");
        query(ui.remove).hidden = false;
      } else {
        preview.hidden = true;
        preview.removeAttribute("src");
        query(ui.title).textContent = ui.emptyTitle;
        query(ui.hint).textContent = ui.emptyHint;
        query(ui.remove).hidden = true;
      }
    }
    if (role === "recognition") {
      const parse = query("#parse-book");
      if (parse) parse.disabled = true;
    }
    updateSwapButton();
  }

  function setImage(role, supplied, source = "已选择") {
    revision += 1;
    const ui = IMAGE_UI[role];
    const status = query("#book-parse-status");
    let file;
    try {
      [file] = media.validateImages([supplied]);
    } catch (error) {
      if (status) status.textContent = error.message;
      return false;
    }
    revoke(role);
    files[role] = file;
    previewUrls[role] = platform.objectUrls.createObjectURL(file);
    const preview = query(ui.preview);
    preview.src = previewUrls[role];
    preview.hidden = false;
    query(ui.title).textContent = file.name || "剪贴板图片";
    query(ui.hint).textContent =
      `${source} · ${formatBytes(file.size)} · 点击可重新选择`;
    query(ui.box).classList.add("has-image");
    query(ui.remove).hidden = false;
    if (role === "recognition") {
      query("#parse-book").disabled = false;
      status.textContent = "识别图已就绪，可以回填书目信息。";
    } else {
      status.textContent = "新封面已就绪，将在保存书目时上传。";
    }
    updateSwapButton();
    return true;
  }

  const targetCurrent = ticket => Boolean(
    isCurrent(ticket)
    && ticket.revision === revision
    && ticket.bookId === state.editingBookId
    && ticket.file === files.recognition
  );

  function invalidateRecognition() {
    reasoning?.dispose();
    reasoning = null;
    revision += 1;
    const parse = query("#parse-book");
    if (parse) parse.disabled = !files.recognition;
    return revision;
  }

  function resume() {
    invalidateRecognition();
    const status = query("#book-parse-status");
    if (status?.textContent === "正在识别并查询书目…") {
      status.textContent = files.recognition
        ? "识别图已就绪，可以回填书目信息。"
        : "";
    }
    updateSwapButton();
  }

  async function recognize(button = query("#parse-book")) {
    const file = files.recognition || query("#book-recognition-image")?.files?.[0];
    const status = query("#book-parse-status");
    if (!file) {
      if (status) status.textContent = "请先选择、粘贴或拖入一张识别图。";
      return false;
    }
    const inputVersion = ++revision;
    const requestId = platform.createRequestId();
    const targetId = state.editingBookId || "book-draft";
    const ticket = {
      ...createTicket(),
      revision: inputVersion,
      bookId: state.editingBookId,
      file,
      requestId,
      targetId
    };
    button.disabled = true;
    status.textContent = "正在识别并查询书目…";
    try {
      const images = await media.imageDataUrls([file]);
      if (!targetCurrent(ticket)) return false;
      const result = await data.request("/api/images/parse", {
        method: "POST",
        body: JSON.stringify({
          requestId,
          targetId,
          inputVersion,
          kind: "book",
          images
        })
      });
      if (!targetCurrent(ticket)) {
        if (isCurrent(ticket) && ticket.bookId === state.editingBookId) {
          status.textContent = "识别已完成，但当前书目已经变化，未自动回填。";
        }
        return false;
      }
      if ((result.requestId && result.requestId !== requestId)
          || (result.targetId && result.targetId !== targetId)
          || (Object.hasOwn(result, "inputVersion")
            && Number(result.inputVersion) !== inputVersion)) {
        status.textContent = "识别已完成，但当前书目已经变化，未自动回填。";
        return false;
      }
      for (const key of ["title", "author", "publisher", "isbn", "description"]) {
        query(`#book-${key}`).value = result[key] || "";
      }
      status.textContent = result.verification || "识别完成，请确认书目信息。";
      reasoning?.dispose();
      const host = query("#book-recognition-reasoning");
      if (host) {
        reasoning = createReasoningDisclosure({ host, isCurrent: () => targetCurrent(ticket) });
        reasoning.replace(result);
      }
      return true;
    } catch (error) {
      if (targetCurrent(ticket)) status.textContent = error.message;
      return false;
    } finally {
      if (targetCurrent(ticket) && button.isConnected !== false) button.disabled = false;
    }
  }

  async function currentCoverFile(ticket) {
    if (files.cover) return files.cover;
    const imagePath = query("#book-image-path")?.value;
    if (!imagePath) return null;
    const blob = await media.readBlob(imagePath);
    if (!isCurrent(ticket) || ticket.revision !== revision) throw abortFailure();
    const name = decodeURIComponent(imagePath.split("/").pop() || "current-cover");
    return platform.createFile(blob, name, blob.type || "image/jpeg");
  }

  async function swap(button = query("#book-image-swap")) {
    const recognitionFile = files.recognition;
    if (!recognitionFile) return false;
    button.disabled = true;
    const ticket = { ...createTicket(), revision };
    try {
      const coverFile = await currentCoverFile(ticket);
      if (!coverFile || !isCurrent(ticket) || ticket.revision !== revision) return false;
      query("#book-image-path").value = "";
      setImage("cover", recognitionFile, "交换后作为封面");
      setImage("recognition", coverFile, "交换后用于识别");
      pasteTarget = "recognition";
      query("#book-parse-status").textContent = "封面与识别图已交换。";
      return true;
    } catch (error) {
      if (isCurrent(ticket)) query("#book-parse-status").textContent = error.message;
      return false;
    } finally {
      if (isCurrent(ticket)) updateSwapButton();
    }
  }

  async function uploadCover(requestId, ticket) {
    const existingPath = query("#book-image-path")?.value || "";
    if (!files.cover) {
      return { imagePath: existingPath, uploadedPath: "", uploadRequestId: "" };
    }
    query("#book-parse-status").textContent = "正在上传封面…";
    const uploadRequestId = `${requestId}:cover`;
    const [image] = await media.imageDataUrls([files.cover]);
    if (!isCurrent(ticket)) throw abortFailure();
    const [uploadedPath] = await media.uploadOriginalImages([image], uploadRequestId);
    if (!isCurrent(ticket)) {
      if (isSameSession(ticket)) {
        await media.discardUploadedImagePath(uploadedPath, uploadRequestId);
      }
      throw abortFailure();
    }
    return { imagePath: uploadedPath, uploadedPath, uploadRequestId };
  }

  async function discardUpload(uploadedPath, uploadRequestId, ticket) {
    if (!uploadedPath || !uploadRequestId || !isSameSession(ticket)) return false;
    return media.discardUploadedImagePath(uploadedPath, uploadRequestId);
  }

  function resetSession() {
    reasoning?.dispose();
    reasoning = null;
    revision += 1;
    pasteTarget = "recognition";
    for (const role of Object.keys(IMAGE_UI)) {
      revoke(role);
      files[role] = null;
    }
    resetImage("cover");
    resetImage("recognition");
  }

  return Object.freeze({
    file: role => files[role] || null,
    previewUrl: role => previewUrls[role],
    pasteTarget: () => pasteTarget,
    setPasteTarget: role => {
      if (IMAGE_UI[role]) pasteTarget = role;
    },
    resetImage,
    setImage,
    invalidateRecognition,
    resume,
    recognize,
    swap,
    uploadCover,
    discardUpload,
    resetSession,
    updateSwapButton
  });
}
