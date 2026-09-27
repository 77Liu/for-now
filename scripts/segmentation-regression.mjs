import assert from "node:assert/strict";
import { segmentKeepsakePixels } from "../public/keepsake-segmentation.js";

const width = 96, height = 72, data = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4, texture = (x + y) % 5;
    data[offset] = 112 + texture; data[offset + 1] = 116 + texture; data[offset + 2] = 112 + texture; data[offset + 3] = 255;
    const left = 30 - (y - 12) * .08, right = 65 + (y - 12) * .1;
    if (y >= 12 && y <= 61 && x >= left && x <= right) {
      data[offset] = 236; data[offset + 1] = 232; data[offset + 2] = 220;
    }
    if ((x - 69) ** 2 + (y - 38) ** 2 <= 9 ** 2) {
      data[offset] = 202; data[offset + 1] = 132; data[offset + 2] = 105;
    }
  }
}

const result = segmentKeepsakePixels({ width, height, data }, {
  subjectBox: [250, 120, 830, 900],
  foregroundPoints: [[500, 250], [500, 700], [720, 530]],
  backgroundPoints: [[30, 30], [500, 30], [970, 30], [30, 500], [970, 500], [30, 970], [500, 970], [970, 970]]
});
const alpha = (x, y) => result.data[(y * width + x) * 4 + 3];
assert.ok(alpha(48, 30) > 220, "票据内部应保留");
assert.ok(alpha(69, 38) > 180, "接触手指应保留");
assert.ok(alpha(4, 4) < 20, "图像边角应透明");
assert.ok(alpha(22, 35) < 80, "主体范围内的背景不应被矩形保留");
const opaque = Array.from({ length: width * height }, (_, index) => result.data[index * 4 + 3] > 127).filter(Boolean).length;
assert.ok(opaque > width * height * .18 && opaque < width * height * .55, "蒙版面积应接近主体而不是方框");
console.log("Keepsake segmentation regression passed.");
