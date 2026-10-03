import assert from "node:assert/strict";

const {
  KEEPSAKE_ALPHA_THRESHOLD,
  KEEPSAKE_BOUNDS_PADDING_RATIO,
  keepsakePlacementCss,
  scanKeepsakeAlpha
} = await import("../public/frontend/features/index.mjs");

function pixels(width, height, alphaAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[(y * width + x) * 4 + 3] = alphaAt(x, y);
    }
  }
  return { width, height, data };
}

assert.equal(KEEPSAKE_ALPHA_THRESHOLD, 16);
assert.equal(KEEPSAKE_BOUNDS_PADDING_RATIO, 0.04);

const analysis = scanKeepsakeAlpha(pixels(100, 80, (x, y) => {
  if ((x === 0 && y === 0) || (x === 99 && y === 79)) return 255;
  return x >= 30 && x <= 69 && y >= 20 && y <= 59 ? 255 : 0;
}));
assert.equal(analysis.status, "cutout");
assert.deepEqual(analysis.rawBounds, {
  x: 30,
  y: 20,
  width: 40,
  height: 40,
  right: 70,
  bottom: 60
});
assert.deepEqual(analysis.bounds, {
  x: 28,
  y: 18,
  width: 44,
  height: 44,
  right: 72,
  bottom: 62
});
assert.deepEqual(analysis.components, { total: 3, retained: 1 });
assert.deepEqual(analysis.centroid, { x: 49.5, y: 39.5 });

const placement = keepsakePlacementCss(analysis);
assert.equal(placement.aspectRatio, "1");
assert.ok(Math.abs(placement.widthPct - 227.2727) < 0.001);
assert.ok(Math.abs(placement.heightPct - 181.8181) < 0.001);
assert.ok(Math.abs(placement.leftPct + 62.5) < 0.001);
assert.ok(Math.abs(placement.topPct + 39.7727) < 0.001);

const opaque = scanKeepsakeAlpha(pixels(8, 6, () => 255));
assert.equal(opaque.status, "opaque");
assert.equal(keepsakePlacementCss(opaque).aspectRatio, String(8 / 6));

const transparent = scanKeepsakeAlpha(pixels(3, 2, () => 0));
assert.equal(transparent.status, "transparent");
assert.equal(keepsakePlacementCss(transparent), null);

assert.throws(
  () => scanKeepsakeAlpha({ width: 2, height: 2, data: new Uint8Array(3) }),
  /one RGBA value/
);

console.log("Keepsake placement checks passed: connected-component noise filtering, padded bounds, centering and fallback.");
