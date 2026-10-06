const MASK_ALPHA_THRESHOLD = 20;

function copyImageData(imageData, createImageData) {
  return createImageData(
    imageData.width,
    imageData.height,
    new Uint8ClampedArray(imageData.data)
  );
}

export function dilatedKeepsakeMask(imageData, radius, createImageData) {
  const { width, height, data } = imageData;
  const rounded = Math.max(0, Math.round(radius));
  if (!rounded) return copyImageData(imageData, createImageData);
  const stride = width + 1;
  const integral = new Uint32Array((height + 1) * stride);
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      row += data[(y * width + x) * 4 + 3] > MASK_ALPHA_THRESHOLD ? 1 : 0;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const output = createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - rounded);
    const bottom = Math.min(height - 1, y + rounded);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - rounded);
      const right = Math.min(width - 1, x + rounded);
      const count = integral[(bottom + 1) * stride + right + 1]
        - integral[top * stride + right + 1]
        - integral[(bottom + 1) * stride + left]
        + integral[top * stride + left];
      if (!count) continue;
      const index = (y * width + x) * 4;
      output.data[index] = 255;
      output.data[index + 1] = 255;
      output.data[index + 2] = 255;
      output.data[index + 3] = 255;
    }
  }
  return output;
}

export function softenedKeepsakeMask(imageData, radius, createImageData) {
  const { width, height, data } = imageData;
  const rounded = Math.max(1, Math.round(radius || 1));
  const stride = width + 1;
  const integral = new Uint32Array((height + 1) * stride);
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      row += data[(y * width + x) * 4 + 3];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const output = createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - rounded);
    const bottom = Math.min(height - 1, y + rounded);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - rounded);
      const right = Math.min(width - 1, x + rounded);
      const count = (bottom - top + 1) * (right - left + 1);
      const alpha = Math.round((
        integral[(bottom + 1) * stride + right + 1]
        - integral[top * stride + right + 1]
        - integral[(bottom + 1) * stride + left]
        + integral[top * stride + left]
      ) / count);
      const index = (y * width + x) * 4;
      output.data[index] = 255;
      output.data[index + 1] = 255;
      output.data[index + 2] = 255;
      output.data[index + 3] = alpha;
    }
  }
  return output;
}

export function createKeepsakeCanvas({
  state,
  platform
} = {}) {
  if (!state?.editor) throw new TypeError("Keepsake canvas requires editor state");
  for (const name of [
    "loadImage", "requestFrame", "cancelFrame", "createCanvas", "createImageData"
  ]) {
    if (typeof platform?.[name] !== "function") {
      throw new TypeError(`Keepsake canvas platform requires ${name}`);
    }
  }
  const createCanvas = (width, height) => {
    const canvas = platform.createCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
  const createImageData = platform.createImageData;
  const editor = state.editor;

  function imageData(canvas) {
    return canvas.getContext("2d", { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height);
  }

  function cancelRender() {
    if (editor.renderFrame) platform.cancelFrame(editor.renderFrame);
    editor.renderFrame = 0;
  }

  function reset() {
    cancelRender();
    editor.segmentGeneration += 1;
    editor.understandingGeneration += 1;
    editor.file = null;
    editor.sourceDataUrl = "";
    editor.sourceImage = null;
    editor.sourceCanvas = null;
    editor.maskCanvas = null;
    editor.autoBase = null;
    editor.history = [];
    editor.mode = "keep";
    editor.drawing = false;
    editor.lastPoint = null;
    editor.source = "manual";
    editor.originalPath = "";
    editor.cutoutPath = "";
    editor.mediaDirty = false;
  }

  function scheduleRender(render) {
    if (editor.renderFrame) return editor.renderFrame;
    let fired = false;
    const frame = platform.requestFrame(() => {
      fired = true;
      editor.renderFrame = 0;
      render();
    });
    if (!fired) editor.renderFrame = frame;
    return frame;
  }

  function pushHistory() {
    if (!editor.maskCanvas) return false;
    editor.history.push(imageData(editor.maskCanvas));
    if (editor.history.length > 12) editor.history.shift();
    return true;
  }

  function undo() {
    const previous = editor.history.pop();
    if (!previous || !editor.maskCanvas) return false;
    editor.segmentGeneration += 1;
    editor.maskCanvas.getContext("2d").putImageData(previous, 0, 0);
    editor.mediaDirty = true;
    return true;
  }

  function cutoutCanvas() {
    if (!editor.sourceCanvas || !editor.maskCanvas) return null;
    const cutout = createCanvas(editor.sourceCanvas.width, editor.sourceCanvas.height);
    const context = cutout.getContext("2d");
    context.drawImage(editor.sourceCanvas, 0, 0);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(editor.maskCanvas, 0, 0);
    context.globalCompositeOperation = "source-over";
    return cutout;
  }

  function paintMaskOverlay(target, mask) {
    const overlay = createCanvas(mask.width, mask.height);
    const context = overlay.getContext("2d");
    context.fillStyle = "#55b98a";
    context.fillRect(0, 0, overlay.width, overlay.height);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(mask, 0, 0);
    target.drawImage(overlay, 0, 0);
  }

  function render(editCanvas, previewCanvas, backgroundOpacityPct) {
    if (!editor.sourceCanvas || !editor.maskCanvas || !editCanvas || !previewCanvas) {
      return false;
    }
    for (const canvas of [editCanvas, previewCanvas]) {
      if (canvas.width !== editor.sourceCanvas.width
          || canvas.height !== editor.sourceCanvas.height) {
        canvas.width = editor.sourceCanvas.width;
        canvas.height = editor.sourceCanvas.height;
      }
    }
    const editContext = editCanvas.getContext("2d");
    editContext.clearRect(0, 0, editCanvas.width, editCanvas.height);
    editContext.drawImage(editor.sourceCanvas, 0, 0);
    editContext.save();
    editContext.globalAlpha = 0.48;
    paintMaskOverlay(editContext, editor.maskCanvas);
    editContext.restore();
    const previewContext = previewCanvas.getContext("2d");
    previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    previewContext.save();
    previewContext.globalAlpha = Math.max(
      0,
      Math.min(30, Number(backgroundOpacityPct) || 0)
    ) / 100;
    previewContext.drawImage(editor.sourceCanvas, 0, 0);
    previewContext.restore();
    previewContext.drawImage(cutoutCanvas(), 0, 0);
    return true;
  }

  function applyExpansion(value) {
    if (!editor.autoBase || !editor.maskCanvas) return false;
    const maximum = Math.max(editor.maskCanvas.width, editor.maskCanvas.height);
    const radius = Math.round(maximum * Number(value) / 1000);
    const expanded = dilatedKeepsakeMask(editor.autoBase, radius, createImageData);
    const softened = softenedKeepsakeMask(
      expanded,
      Math.max(1, Math.round(maximum / 800)),
      createImageData
    );
    editor.maskCanvas.getContext("2d").putImageData(softened, 0, 0);
    editor.mediaDirty = true;
    return true;
  }

  function workingDataUrl(maxSide, type, quality) {
    if (!editor.sourceCanvas) return "";
    const source = editor.sourceCanvas;
    const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas = createCanvas(width, height);
    canvas.getContext("2d").drawImage(source, 0, 0, width, height);
    return canvas.toDataURL(type, quality);
  }

  async function maskFromCutout(target, cutoutUrl, isValid, requireActiveTarget = true) {
    const cutout = await platform.loadImage(cutoutUrl);
    if (!isValid() || (requireActiveTarget && target !== editor.maskCanvas)) return false;
    const temp = createCanvas(target.width, target.height);
    const context = temp.getContext("2d", { willReadFrequently: true });
    context.drawImage(cutout, 0, 0, temp.width, temp.height);
    const sourceData = context.getImageData(0, 0, temp.width, temp.height);
    const maskData = createImageData(temp.width, temp.height);
    for (let index = 0; index < sourceData.data.length; index += 4) {
      const alpha = sourceData.data[index + 3];
      maskData.data[index] = alpha;
      maskData.data[index + 1] = alpha;
      maskData.data[index + 2] = alpha;
      maskData.data[index + 3] = alpha;
    }
    target.getContext("2d").putImageData(maskData, 0, 0);
    return true;
  }

  async function prepare({
    dataUrl,
    file = null,
    cutoutUrl = "",
    mediaDirty = true,
    generation,
    isValid = () => true
  }) {
    const image = await platform.loadImage(dataUrl);
    if (!isValid() || generation !== editor.segmentGeneration) return false;
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const sourceCanvas = createCanvas(width, height);
    const maskCanvas = createCanvas(width, height);
    sourceCanvas.getContext("2d").drawImage(image, 0, 0, width, height);
    if (cutoutUrl && !await maskFromCutout(maskCanvas, cutoutUrl, () => (
      isValid() && generation === editor.segmentGeneration
    ), false)) return false;
    if (!isValid() || generation !== editor.segmentGeneration) return false;
    Object.assign(editor, {
      file,
      sourceDataUrl: dataUrl,
      sourceImage: image,
      sourceCanvas,
      maskCanvas,
      autoBase: null,
      history: [],
      source: "manual",
      mediaDirty
    });
    return true;
  }

  async function applySegmentedMask(cutoutUrl, generation, isValid, expansion) {
    const target = editor.maskCanvas;
    if (!target || !await maskFromCutout(target, cutoutUrl, () => (
      isValid() && generation === editor.segmentGeneration
    ))) return false;
    editor.autoBase = imageData(target);
    editor.source = "auto";
    editor.mediaDirty = true;
    applyExpansion(expansion);
    return true;
  }

  function hasSubject() {
    const data = editor.maskCanvas ? imageData(editor.maskCanvas).data : null;
    if (!data) return false;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] > MASK_ALPHA_THRESHOLD) return true;
    }
    return false;
  }

  function clearMask() {
    if (!editor.maskCanvas) return false;
    editor.segmentGeneration += 1;
    pushHistory();
    editor.maskCanvas.getContext("2d")
      .clearRect(0, 0, editor.maskCanvas.width, editor.maskCanvas.height);
    editor.autoBase = null;
    editor.source = "manual";
    editor.mediaDirty = true;
    return true;
  }

  function point(event, display) {
    const rect = display.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * display.width / rect.width,
      y: (event.clientY - rect.top) * display.height / rect.height
    };
  }

  function paint(from, to, display, brushSize) {
    if (!editor.maskCanvas || !from || !to) return false;
    const context = editor.maskCanvas.getContext("2d");
    const scale = editor.maskCanvas.width / display.getBoundingClientRect().width;
    const size = Number(brushSize) * scale;
    context.save();
    context.globalCompositeOperation = editor.mode === "erase"
      ? "destination-out"
      : "source-over";
    context.strokeStyle = "#fff";
    context.fillStyle = "#fff";
    context.lineWidth = size;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.beginPath();
    context.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    editor.source = "manual";
    editor.mediaDirty = true;
    return true;
  }

  return Object.freeze({
    reset,
    cancelRender,
    scheduleRender,
    pushHistory,
    undo,
    render,
    applyExpansion,
    prepare,
    applySegmentedMask,
    hasSubject,
    clearMask,
    point,
    paint,
    beginSegmentation: () => ++editor.segmentGeneration,
    invalidateSegmentation: () => ++editor.segmentGeneration,
    beginUnderstanding: () => ++editor.understandingGeneration,
    segmentationDataUrl: () => workingDataUrl(1600, "image/jpeg", 0.9),
    understandingDataUrl: () => workingDataUrl(1200, "image/jpeg", 0.88),
    alphaMaskDataUrl: () => editor.maskCanvas?.toDataURL("image/png") || "",
    editor: () => editor
  });
}
