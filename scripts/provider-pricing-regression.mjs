import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICIAL_PROVIDER_PRICING, resolveOfficialProviderPricing } from "../src/modules/ai/index.mjs";
import {
  buildPricingSnapshot,
  parseDeepSeekPricing,
  parseVolcengineFlashAsrPricing,
  validatePricingSnapshot
} from "./update-provider-pricing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(await fs.readFile(path.join(root, "scripts/fixtures/provider-pricing-pages.json"), "utf8"));
const snapshot = validatePricingSnapshot(buildPricingSnapshot(fixture.pages, "2026-10-02T10:29:05Z"));

assert.deepEqual(snapshot.deepseek.models, OFFICIAL_PROVIDER_PRICING.deepseek.models);
assert.deepEqual(snapshot.volcengineSpeech.services, OFFICIAL_PROVIDER_PRICING.volcengineSpeech.services);
assert.deepEqual(snapshot.volcengineFlashAsr.services, OFFICIAL_PROVIDER_PRICING.volcengineFlashAsr.services);
const flashCost = resolveOfficialProviderPricing({ provider: "volcengine", service: "speech", action: "flashAsr", units: 3600000 });
assert.equal(flashCost.costCny, 4.5);
assert.equal(flashCost.unitType, "audioMillisecond");
assert.match(flashCost.costSource, /Billinginstructions-21/);
assert.equal(resolveOfficialProviderPricing({ provider: "volcengine", service: "speech", action: "streamingAsr", units: 3600000 }).costCny, 1);
assert.equal(resolveOfficialProviderPricing({ provider: "volcengine", service: "speech", action: "fileAsr", units: 3600000 }).costCny, 0.8);
assert.throws(() => parseVolcengineFlashAsrPricing(fixture.pages.volcengineFlashAsr.replace("4.5元", "待定")), /未解析到有效正数/);

assert.deepEqual(snapshot.volcengineVision.services, OFFICIAL_PROVIDER_PRICING.volcengineVision.services);
assert.deepEqual(snapshot.aliyunSegmentation.services, OFFICIAL_PROVIDER_PRICING.aliyunSegmentation.services);
assert.deepEqual(snapshot.aliyunOss.services, OFFICIAL_PROVIDER_PRICING.aliyunOss.services);
assert.throws(
  () => parseDeepSeekPricing(fixture.pages.deepseek.replace("27.0元", "待定")),
  /价格矩阵不完整/
);
assert.throws(
  () => validatePricingSnapshot({
    ...snapshot,
    volcengineSpeech: {
      ...snapshot.volcengineSpeech,
      services: { ...snapshot.volcengineSpeech.services, seedTts2: { price: 0 } }
    }
  }),
  /字段不完整/
);

console.log("Provider pricing regression passed.");
