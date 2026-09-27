const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

const normalizedPoint = point => {
  const x = Number(Array.isArray(point) ? point[0] : point?.x);
  const y = Number(Array.isArray(point) ? point[1] : point?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? [clamp(x, 0, 1000), clamp(y, 0, 1000)] : null;
};

export function defaultKeepsakeHints() {
  return {
    subjectBox: [170, 90, 830, 930],
    foregroundPoints: [[500, 500], [500, 320], [500, 680], [380, 500], [620, 500]],
    backgroundPoints: [[25, 25], [500, 25], [975, 25], [25, 500], [975, 500], [25, 975], [500, 975], [975, 975]]
  };
}

function prepareHints(hints = {}) {
  const fallback = defaultKeepsakeHints();
  const foregroundPoints = (Array.isArray(hints.foregroundPoints) ? hints.foregroundPoints : []).map(normalizedPoint).filter(Boolean);
  const rawBackgroundPoints = (Array.isArray(hints.backgroundPoints) ? hints.backgroundPoints : []).map(normalizedPoint).filter(Boolean);
  const rawBox = Array.isArray(hints.subjectBox) ? hints.subjectBox.map(Number) : [];
  let subjectBox = rawBox.length === 4 && rawBox.every(Number.isFinite)
    ? [clamp(Math.min(rawBox[0], rawBox[2]), 0, 1000), clamp(Math.min(rawBox[1], rawBox[3]), 0, 1000), clamp(Math.max(rawBox[0], rawBox[2]), 0, 1000), clamp(Math.max(rawBox[1], rawBox[3]), 0, 1000)]
    : fallback.subjectBox;
  if (foregroundPoints.length) subjectBox = [
    clamp(Math.min(subjectBox[0], ...foregroundPoints.map(point => point[0])) - 20, 0, 1000),
    clamp(Math.min(subjectBox[1], ...foregroundPoints.map(point => point[1])) - 20, 0, 1000),
    clamp(Math.max(subjectBox[2], ...foregroundPoints.map(point => point[0])) + 20, 0, 1000),
    clamp(Math.max(subjectBox[3], ...foregroundPoints.map(point => point[1])) + 20, 0, 1000)
  ];
  const backgroundPoints = rawBackgroundPoints.filter(([x, y]) => x < subjectBox[0] || x > subjectBox[2] || y < subjectBox[1] || y > subjectBox[3]);
  return {
    subjectBox,
    foregroundPoints: foregroundPoints.length ? foregroundPoints : fallback.foregroundPoints,
    backgroundPoints: backgroundPoints.length >= 4 ? backgroundPoints : fallback.backgroundPoints
  };
}

function pixelPoint(point, width, height) {
  return [clamp(Math.round(point[0] / 1000 * (width - 1)), 0, width - 1), clamp(Math.round(point[1] / 1000 * (height - 1)), 0, height - 1)];
}

function colorAt(data, index) {
  const offset = index * 4;
  return [data[offset] / 255, data[offset + 1] / 255, data[offset + 2] / 255];
}

function colorDistanceValues(r, g, b, sample) {
  const dr = r - sample[0], dg = g - sample[1], db = b - sample[2];
  const luminance = (r * .299 + g * .587 + b * .114) - (sample[0] * .299 + sample[1] * .587 + sample[2] * .114);
  return dr * dr + dg * dg + db * db + luminance * luminance * .65;
}

function patchPrototype(imageData, point, radius) {
  const { width, height, data } = imageData;
  const [cx, cy] = pixelPoint(point, width, height);
  let red = 0, green = 0, blue = 0, weight = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y += 1) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x += 1) {
      const distance = Math.hypot(x - cx, y - cy), sampleWeight = Math.max(.2, radius + 1 - distance);
      const offset = (y * width + x) * 4;
      red += data[offset] / 255 * sampleWeight;
      green += data[offset + 1] / 255 * sampleWeight;
      blue += data[offset + 2] / 255 * sampleWeight;
      weight += sampleWeight;
    }
  }
  return [red / weight, green / weight, blue / weight];
}

function minimumColorDistance(r, g, b, prototypes) {
  let best = Infinity;
  for (const sample of prototypes) best = Math.min(best, colorDistanceValues(r, g, b, sample));
  return best;
}

function markSeedDisks(target, points, width, height, radius) {
  for (const point of points) {
    const [cx, cy] = pixelPoint(point, width, height);
    for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y += 1) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) target[y * width + x] = 1;
      }
    }
  }
}

function retainSeededComponents(labels, seeds, width, height) {
  const output = new Uint8Array(labels.length), queue = new Int32Array(labels.length);
  let head = 0, tail = 0;
  for (let index = 0; index < labels.length; index += 1) {
    if (labels[index] && seeds[index] && !output[index]) {
      output[index] = 1;
      queue[tail++] = index;
    }
  }
  while (head < tail) {
    const index = queue[head++], x = index % width, y = Math.floor(index / width);
    if (x > 0 && labels[index - 1] && !output[index - 1]) { output[index - 1] = 1; queue[tail++] = index - 1; }
    if (x + 1 < width && labels[index + 1] && !output[index + 1]) { output[index + 1] = 1; queue[tail++] = index + 1; }
    if (y > 0 && labels[index - width] && !output[index - width]) { output[index - width] = 1; queue[tail++] = index - width; }
    if (y + 1 < height && labels[index + width] && !output[index + width]) { output[index + width] = 1; queue[tail++] = index + width; }
  }
  return output;
}

function fillEnclosedHoles(labels, width, height) {
  const outside = new Uint8Array(labels.length), queue = new Int32Array(labels.length);
  let head = 0, tail = 0;
  const add = index => {
    if (!labels[index] && !outside[index]) { outside[index] = 1; queue[tail++] = index; }
  };
  for (let x = 0; x < width; x += 1) { add(x); add((height - 1) * width + x); }
  for (let y = 1; y + 1 < height; y += 1) { add(y * width); add(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++], x = index % width, y = Math.floor(index / width);
    if (x > 0) add(index - 1);
    if (x + 1 < width) add(index + 1);
    if (y > 0) add(index - width);
    if (y + 1 < height) add(index + width);
  }
  const output = new Uint8Array(labels);
  const visited = new Uint8Array(outside), maxHole = Math.max(4, Math.round(labels.length * .003));
  for (let start = 0; start < labels.length; start += 1) {
    if (labels[start] || visited[start]) continue;
    head = 0; tail = 0; visited[start] = 1; queue[tail++] = start;
    while (head < tail) {
      const index = queue[head++], x = index % width, y = Math.floor(index / width);
      const addHole = neighbor => {
        if (!labels[neighbor] && !visited[neighbor]) { visited[neighbor] = 1; queue[tail++] = neighbor; }
      };
      if (x > 0) addHole(index - 1);
      if (x + 1 < width) addHole(index + 1);
      if (y > 0) addHole(index - width);
      if (y + 1 < height) addHole(index + width);
    }
    if (tail <= maxHole) for (let offset = 0; offset < tail; offset += 1) output[queue[offset]] = 1;
  }
  return output;
}

function featheredMask(labels, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let coverage = 0, samples = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const py = y + dy;
        if (py < 0 || py >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const px = x + dx;
          if (px < 0 || px >= width) continue;
          coverage += labels[py * width + px];
          samples += 1;
        }
      }
      const offset = (y * width + x) * 4, alpha = Math.round(255 * coverage / samples);
      rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 255;
      rgba[offset + 3] = alpha;
    }
  }
  return { width, height, data: rgba };
}

export function segmentKeepsakePixels(imageData, rawHints = {}) {
  const { width, height, data } = imageData, hints = prepareHints(rawHints);
  const radius = Math.max(1, Math.round(Math.min(width, height) * .012));
  const foregroundPrototypes = hints.foregroundPoints.map(point => patchPrototype(imageData, point, radius));
  const backgroundPrototypes = hints.backgroundPoints.map(point => patchPrototype(imageData, point, radius));
  const foregroundSeeds = new Uint8Array(width * height), backgroundSeeds = new Uint8Array(width * height);
  markSeedDisks(foregroundSeeds, hints.foregroundPoints, width, height, radius);
  markSeedDisks(backgroundSeeds, hints.backgroundPoints, width, height, radius);
  const box = [hints.subjectBox[0] / 1000 * width, hints.subjectBox[1] / 1000 * height, hints.subjectBox[2] / 1000 * width, hints.subjectBox[3] / 1000 * height];
  const unary = new Float32Array(width * height);
  let labels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x, offset = index * 4, r = data[offset] / 255, g = data[offset + 1] / 255, b = data[offset + 2] / 255;
      const foregroundDistance = minimumColorDistance(r, g, b, foregroundPrototypes);
      const backgroundDistance = minimumColorDistance(r, g, b, backgroundPrototypes);
      const outsideX = x < box[0] ? (box[0] - x) / width : x > box[2] ? (x - box[2]) / width : 0;
      const outsideY = y < box[1] ? (box[1] - y) / height : y > box[3] ? (y - box[3]) / height : 0;
      const prior = outsideX || outsideY ? -.22 - Math.hypot(outsideX, outsideY) * 2.2 : -.035;
      unary[index] = clamp((backgroundDistance - foregroundDistance) * 4.4 + prior, -2.5, 2.5);
      labels[index] = unary[index] > 0 ? 1 : 0;
    }
  }
  for (let pass = 0; pass < 5; pass += 1) {
    const next = new Uint8Array(labels.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (foregroundSeeds[index] || backgroundSeeds[index]) { next[index] = foregroundSeeds[index] ? 1 : 0; continue; }
        const currentColor = colorAt(data, index);
        let vote = 0;
        for (const neighbor of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) {
          if (neighbor < 0) continue;
          const neighborColor = colorAt(data, neighbor);
          const edge = colorDistanceValues(currentColor[0], currentColor[1], currentColor[2], neighborColor);
          vote += (labels[neighbor] ? 1 : -1) / (1 + edge * 28);
        }
        next[index] = unary[index] + vote * .24 > 0 ? 1 : 0;
      }
    }
    labels = next;
  }
  labels = retainSeededComponents(labels, foregroundSeeds, width, height);
  labels = fillEnclosedHoles(labels, width, height);
  return featheredMask(labels, width, height);
}
