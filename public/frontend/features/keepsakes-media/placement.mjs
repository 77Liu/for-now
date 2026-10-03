export const KEEPSAKE_ALPHA_THRESHOLD = 16;
export const KEEPSAKE_BOUNDS_PADDING_RATIO = 0.04;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`Keepsake ${name} must be a positive integer`);
  }
  return number;
}

function boundedRegion(component, width, height, paddingRatio) {
  const rawWidth = component.maximumX - component.minimumX + 1;
  const rawHeight = component.maximumY - component.minimumY + 1;
  const padding = Math.max(2, Math.round(Math.max(rawWidth, rawHeight) * paddingRatio));
  const x = Math.max(0, component.minimumX - padding);
  const y = Math.max(0, component.minimumY - padding);
  const right = Math.min(width, component.maximumX + 1 + padding);
  const bottom = Math.min(height, component.maximumY + 1 + padding);
  return Object.freeze({
    x,
    y,
    width: right - x,
    height: bottom - y,
    right,
    bottom
  });
}

export function scanKeepsakeAlpha(imageData, {
  alphaThreshold = KEEPSAKE_ALPHA_THRESHOLD,
  paddingRatio = KEEPSAKE_BOUNDS_PADDING_RATIO
} = {}) {
  const width = positiveInteger(imageData?.width, "image width");
  const height = positiveInteger(imageData?.height, "image height");
  const data = imageData?.data;
  if (!data || data.length !== width * height * 4) {
    throw new TypeError("Keepsake image data must contain one RGBA value per source pixel");
  }
  const threshold = Math.round(Number(alphaThreshold));
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw new RangeError("Keepsake alphaThreshold must be between 0 and 255");
  }
  const normalizedPadding = clamp(Number(paddingRatio) || 0, 0, 0.2);
  const foreground = new Uint8Array(width * height);
  let foregroundCount = 0;
  let opaque = true;
  for (let index = 0; index < foreground.length; index += 1) {
    const alpha = Number(data[index * 4 + 3]);
    if (alpha !== 255) opaque = false;
    if (alpha >= threshold) {
      foreground[index] = 1;
      foregroundCount += 1;
    }
  }
  if (!foregroundCount) {
    return Object.freeze({
      status: "transparent",
      sourceWidth: width,
      sourceHeight: height,
      bounds: null,
      rawBounds: null,
      centroid: null,
      components: Object.freeze({ total: 0, retained: 0 })
    });
  }
  if (opaque) {
    const bounds = Object.freeze({ x: 0, y: 0, width, height, right: width, bottom: height });
    return Object.freeze({
      status: "opaque",
      sourceWidth: width,
      sourceHeight: height,
      bounds,
      rawBounds: bounds,
      centroid: Object.freeze({ x: width / 2, y: height / 2 }),
      components: Object.freeze({ total: 1, retained: 1 })
    });
  }

  const visited = new Uint8Array(foreground.length);
  const components = [];
  const neighbors = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
  for (let start = 0; start < foreground.length; start += 1) {
    if (!foreground[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    const component = {
      pixels: 0,
      alphaWeight: 0,
      weightedX: 0,
      weightedY: 0,
      minimumX: width,
      minimumY: height,
      maximumX: -1,
      maximumY: -1,
      touchesEdge: false
    };
    while (stack.length) {
      const index = stack.pop();
      const x = index % width;
      const y = Math.floor(index / width);
      const alpha = Number(data[index * 4 + 3]);
      component.pixels += 1;
      component.alphaWeight += alpha;
      component.weightedX += x * alpha;
      component.weightedY += y * alpha;
      component.minimumX = Math.min(component.minimumX, x);
      component.minimumY = Math.min(component.minimumY, y);
      component.maximumX = Math.max(component.maximumX, x);
      component.maximumY = Math.max(component.maximumY, y);
      component.touchesEdge ||= x === 0 || y === 0 || x === width - 1 || y === height - 1;
      for (const [dx, dy] of neighbors) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
        const next = nextY * width + nextX;
        if (!foreground[next] || visited[next]) continue;
        visited[next] = 1;
        stack.push(next);
      }
    }
    components.push(component);
  }

  const primary = [...components].sort((left, right) => right.alphaWeight - left.alphaWeight)[0];
  const minimumSecondaryPixels = Math.max(4, Math.ceil(primary.pixels * 0.015));
  const retained = components.filter(component => (
    component === primary
    || (component.pixels >= minimumSecondaryPixels && !(component.touchesEdge && component.pixels < primary.pixels * 0.08))
  ));
  const combined = retained.reduce((result, component) => ({
    pixels: result.pixels + component.pixels,
    alphaWeight: result.alphaWeight + component.alphaWeight,
    weightedX: result.weightedX + component.weightedX,
    weightedY: result.weightedY + component.weightedY,
    minimumX: Math.min(result.minimumX, component.minimumX),
    minimumY: Math.min(result.minimumY, component.minimumY),
    maximumX: Math.max(result.maximumX, component.maximumX),
    maximumY: Math.max(result.maximumY, component.maximumY)
  }), {
    pixels: 0,
    alphaWeight: 0,
    weightedX: 0,
    weightedY: 0,
    minimumX: width,
    minimumY: height,
    maximumX: -1,
    maximumY: -1
  });
  const rawBounds = Object.freeze({
    x: combined.minimumX,
    y: combined.minimumY,
    width: combined.maximumX - combined.minimumX + 1,
    height: combined.maximumY - combined.minimumY + 1,
    right: combined.maximumX + 1,
    bottom: combined.maximumY + 1
  });
  return Object.freeze({
    status: "cutout",
    sourceWidth: width,
    sourceHeight: height,
    rawBounds,
    bounds: boundedRegion(combined, width, height, normalizedPadding),
    centroid: Object.freeze({
      x: combined.weightedX / combined.alphaWeight,
      y: combined.weightedY / combined.alphaWeight
    }),
    components: Object.freeze({ total: components.length, retained: retained.length })
  });
}

export function keepsakePlacementCss(analysis, {
  minimumRatio = 0.68,
  maximumRatio = 1.8
} = {}) {
  if (!analysis?.bounds || !analysis.sourceWidth || !analysis.sourceHeight) return null;
  const bounds = { ...analysis.bounds };
  if (analysis.status === "cutout" && analysis.rawBounds && analysis.centroid) {
    const minimumX = Math.max(0, analysis.rawBounds.right - bounds.width);
    const maximumX = Math.min(analysis.rawBounds.x, analysis.sourceWidth - bounds.width);
    const minimumY = Math.max(0, analysis.rawBounds.bottom - bounds.height);
    const maximumY = Math.min(analysis.rawBounds.y, analysis.sourceHeight - bounds.height);
    bounds.x = clamp(analysis.centroid.x - bounds.width / 2, minimumX, maximumX);
    bounds.y = clamp(analysis.centroid.y - bounds.height / 2, minimumY, maximumY);
  }
  const ratio = clamp(bounds.width / bounds.height, minimumRatio, maximumRatio);
  const scale = Math.min(ratio / bounds.width, 1 / bounds.height);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return Object.freeze({
    aspectRatio: String(ratio),
    widthPct: analysis.sourceWidth * scale / ratio * 100,
    heightPct: analysis.sourceHeight * scale * 100,
    leftPct: (ratio / 2 - centerX * scale) / ratio * 100,
    topPct: (0.5 - centerY * scale) * 100
  });
}
