const KIB = 1024;

export const KEEPSAKE_DERIVATIVE_PROFILES = Object.freeze({
  thumb: Object.freeze({ maxWidth: 720, maxBytes: 160 * KIB, quality: 80, minQuality: 78, masked: true }),
  display: Object.freeze({ maxWidth: 1600, maxBytes: 400 * KIB, quality: 84, minQuality: 82, masked: true }),
  edit: Object.freeze({ maxWidth: 1600, maxBytes: 450 * KIB, quality: 84, minQuality: 78, masked: false }),
  alphaMask: Object.freeze({ maxWidth: 1600, maxBytes: 120 * KIB, quality: 90, minQuality: 78, alphaOnly: true })
});

let sharpModule;

async function sharp() {
  try {
    sharpModule ||= import("sharp");
    return (await sharpModule).default;
  } catch (error) {
    throw Object.assign(
      new Error("服务端图片派生需要安装 sharp 依赖"),
      { code: "IMAGE_PROCESSOR_UNAVAILABLE", statusCode: 503, cause: error }
    );
  }
}

export function createSharpImageProcessor() {
  return {
    async metadata(data) {
      return (await sharp())(data, { failOn: "error" }).metadata();
    },
    async encode({ source, alphaMask, kind, width, height, quality }) {
      const sharpFactory = await sharp();
      const resize = { width, height, fit: "fill", withoutEnlargement: true };
      if (kind === "alphaMask") {
        const extracted = await sharpFactory(alphaMask, { failOn: "error" })
          .rotate()
          .resize(resize)
          .ensureAlpha()
          .extractChannel("alpha")
          .raw()
          .toBuffer({ resolveWithObject: true });
        const rgba = Buffer.alloc(extracted.info.width * extracted.info.height * 4, 255);
        for (let index = 0, pixel = 0; index < extracted.data.length; index += 1, pixel += 4) {
          rgba[pixel + 3] = extracted.data[index];
        }
        return sharpFactory(rgba, {
          raw: { width: extracted.info.width, height: extracted.info.height, channels: 4 }
        }).webp({ quality, alphaQuality: quality, smartSubsample: true }).toBuffer();
      }
      let pipeline = sharpFactory(source, { failOn: "error" })
        .rotate()
        .resize(resize)
        .ensureAlpha();
      if (alphaMask) {
        const maskLayer = await sharpFactory(alphaMask, { failOn: "error" })
          .rotate()
          .resize(resize)
          .ensureAlpha()
          .png()
          .toBuffer();
        pipeline = pipeline.composite([{ input: maskLayer, blend: "dest-in" }]);
      }
      return pipeline.webp({ quality, alphaQuality: quality, smartSubsample: true }).toBuffer();
    }
  };
}

function orientedDimensions(metadata) {
  const width = Number(metadata?.width), height = Number(metadata?.height);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw Object.assign(new Error("无法读取原图尺寸"), { code: "INVALID_IMAGE_DIMENSIONS" });
  }
  return [5, 6, 7, 8].includes(Number(metadata.orientation))
    ? { width: height, height: width }
    : { width, height };
}

function dimensionsFor(source, maxWidth) {
  const scale = Math.min(1, maxWidth / Math.max(source.width, source.height));
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale))
  };
}

function matchingAspectRatio(source, mask) {
  const left = source.width * mask.height;
  const right = source.height * mask.width;
  return Math.abs(left - right) / Math.max(left, right) <= 0.005;
}

function nextWidth(width, bytes, targetBytes) {
  const factor = Math.min(0.8, Math.sqrt(targetBytes / Math.max(1, bytes)) * 0.94);
  const estimated = Math.floor(width * factor);
  return Math.max(1, Math.min(width - 1, estimated));
}

async function createDerivative(kind, profile, {
  original,
  alphaMask,
  sourceDimensions,
  processor
}) {
  const targetBytes = Math.min(profile.maxBytes, original.length - 1);
  if (targetBytes < 1) {
    throw Object.assign(new Error("原图过小，无法生成严格更小的派生图"), { code: "IMAGE_DERIVATIVE_NOT_SMALLER" });
  }
  let { width, height } = dimensionsFor(sourceDimensions, profile.maxWidth);
  let quality = profile.quality;
  let data;
  let resizeAttempts = 0;
  for (;;) {
    data = await processor.encode({
      source: original,
      alphaMask: profile.masked || profile.alphaOnly ? alphaMask : null,
      kind,
      width,
      height,
      quality,
      autoOrient: true,
      stripMetadata: true
    });
    if (!Buffer.isBuffer(data) || !data.length) {
      throw Object.assign(new Error(`图片派生失败：${kind} 输出为空`), { code: "IMAGE_DERIVATIVE_INVALID" });
    }
    if (data.length <= targetBytes) break;
    if (width > 1) {
      resizeAttempts += 1;
      const reducedWidth = resizeAttempts >= 16 ? 1 : nextWidth(width, data.length, targetBytes);
      height = Math.max(1, Math.min(sourceDimensions.height, Math.round(sourceDimensions.height * reducedWidth / sourceDimensions.width)));
      width = reducedWidth;
      continue;
    }
    if (quality > profile.minQuality) {
      quality = Math.max(profile.minQuality, quality - 2);
      continue;
    }
    throw Object.assign(
      new Error(`无法在质量下限内生成合规的 ${kind} 派生图`),
      { code: "IMAGE_DERIVATIVE_LIMIT_EXCEEDED", kind }
    );
  }
  return {
    data,
    mimeType: "image/webp",
    extension: "webp",
    width,
    height,
    quality,
    bytes: data.length
  };
}

export async function createKeepsakeImageDerivatives({
  original,
  alphaMask,
  processor = createSharpImageProcessor()
}) {
  if (!Buffer.isBuffer(original) || !original.length || !Buffer.isBuffer(alphaMask) || !alphaMask.length) {
    throw new TypeError("Original image and alpha mask buffers are required");
  }
  const sourceDimensions = orientedDimensions(await processor.metadata(original));
  const maskDimensions = orientedDimensions(await processor.metadata(alphaMask));
  if (!matchingAspectRatio(sourceDimensions, maskDimensions)) {
    throw Object.assign(new Error("Alpha 蒙版宽高比必须与原图一致"), { code: "ALPHA_MASK_DIMENSION_MISMATCH" });
  }
  const output = {};
  for (const [kind, profile] of Object.entries(KEEPSAKE_DERIVATIVE_PROFILES)) {
    output[kind] = await createDerivative(kind, profile, {
      original,
      alphaMask,
      sourceDimensions,
      processor
    });
  }
  return output;
}
