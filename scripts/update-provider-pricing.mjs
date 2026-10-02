import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRICING_SOURCES = Object.freeze({
  deepseek: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
  volcengineSpeech: "https://docs.volcengine.com/docs/6561/1359370?lang=zh",
  volcengineOcr: "https://www.volcengine.com/docs/86081/1660260",
  volcengineDocument: "https://www.volcengine.com/docs/86081/1804813",
  aliyunSegmentation: "https://help.aliyun.com/zh/viapi/product-overview/billing-is-introduced-1",
  aliyunOss: "https://www.aliyun.com/price/detail/oss"
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(ROOT, "src/modules/ai/provider-pricing.mjs");

export function normalizeOfficialPage(source) {
  return String(source || "")
    .replace(/\\u([0-9a-f]{4})/gi, (_, value) => String.fromCharCode(Number.parseInt(value, 16)))
    .replace(/\\(["/\\])/g, "$1")
    .replace(/<script[^>]*>/gi, " ")
    .replace(/<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#xA0;|&#160;/gi, " ")
    .replace(/&times;/gi, "×")
    .replace(/&quot;/gi, "\"")
    .replace(/&amp;/gi, "&")
    .replace(/\\[nrt]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function finitePrice(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} 未解析到有效正数`);
  return number;
}

function requireScope(text, start, end = "", label = start) {
  const startIndex = text.indexOf(start);
  if (startIndex < 0) throw new Error(`${label} 缺少起始标记`);
  const endIndex = end ? text.indexOf(end, startIndex + start.length) : -1;
  return text.slice(startIndex, endIndex > startIndex ? endIndex : startIndex + 5000);
}

function priceAfter(scope, label, unitPattern, maxLength = 500) {
  const labelIndex = scope.indexOf(label);
  if (labelIndex < 0) throw new Error(`缺少 ${label}`);
  const match = scope.slice(labelIndex, labelIndex + maxLength).match(new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*元\\s*[/／]\\s*${unitPattern}`, "i"));
  return finitePrice(match?.[1], label);
}

export function parseDeepSeekPricing(source) {
  const text = normalizeOfficialPage(source);
  const scope = requireScope(text, "模型 deepseek-flash", "(1) 模型名", "DeepSeek 价格表");
  const versions = scope.match(/模型版本\s+(DeepSeek-[^\s]+)\s+(DeepSeek-[^\s]+)/);
  const prices = scope.match(
    /百万tokens输入\s*（?缓存命中）?\s*空闲时段\s*([0-9.]+)元\s*([0-9.]+)元\s*高峰时段\s*([0-9.]+)元\s*([0-9.]+)元\s*百万tokens输入\s*（?缓存未命中）?\s*空闲时段\s*([0-9.]+)元\s*([0-9.]+)元\s*高峰时段\s*([0-9.]+)元\s*([0-9.]+)元\s*百万tokens输出\s*空闲时段\s*([0-9.]+)元\s*([0-9.]+)元\s*高峰时段\s*([0-9.]+)元\s*([0-9.]+)元/
  );
  if (!versions || !prices) throw new Error("DeepSeek 模型版本或价格矩阵不完整");
  const values = prices.slice(1).map((value, index) => finitePrice(value, `DeepSeek 价格 ${index + 1}`));
  return {
    currency: "CNY",
    unitTokens: 1_000_000,
    timezone: "Asia/Shanghai",
    peakSchedule: "周一至周五（不含中国法定节假日）09:00-12:00、14:00-18:00",
    models: {
      "deepseek-flash": {
        label: "DeepSeek Flash",
        version: versions[1],
        offPeak: { cacheHit: values[0], cacheMiss: values[4], output: values[8] },
        peak: { cacheHit: values[2], cacheMiss: values[6], output: values[10] }
      },
      "deepseek-v4-pro": {
        label: "DeepSeek Pro",
        version: versions[2],
        offPeak: { cacheHit: values[1], cacheMiss: values[5], output: values[9] },
        peak: { cacheHit: values[3], cacheMiss: values[7], output: values[11] }
      }
    }
  };
}

export function parseVolcengineSpeechPricing(source) {
  const text = normalizeOfficialPage(source);
  const scope = requireScope(text, "按调用后付费", "说明", "火山语音后付费表");
  return {
    currency: "CNY",
    services: {
      seedTts2: {
        label: "豆包语音合成模型2.0",
        price: priceAfter(scope, "豆包语音合成模型2.0", "万字符"),
        unit: "10000_characters"
      },
      seedAsr2Streaming: {
        label: "豆包流式语音识别模型2.0",
        price: priceAfter(scope, "豆包流式语音识别模型2.0", "小时"),
        unit: "audio_hour"
      },
      seedAsr2File: {
        label: "豆包录音文件识别模型2.0",
        price: priceAfter(scope, "豆包录音文件识别模型2.0", "小时"),
        unit: "audio_hour"
      }
    }
  };
}

export function parseVolcengineOcrPricing(source) {
  const text = normalizeOfficialPage(source);
  const scope = requireScope(text, "OCRNormal", "", "火山 OCRNormal 价格");
  const match = scope.match(/(?:0\s*[-~～至]\s*50[,\s]?000|不超过\s*5\s*万)[\s\S]{0,300}?([0-9]+(?:\.[0-9]+)?)\s*元\s*[/／]\s*次/);
  return {
    currency: "CNY",
    services: {
      ocrNormalFirstTier: {
        label: "通用文字识别 OCRNormal（不超过 5 万次）",
        price: finitePrice(match?.[1], "火山 OCRNormal 首档"),
        unit: "call"
      }
    }
  };
}

export function parseVolcengineDocumentPricing(source) {
  const text = normalizeOfficialPage(source);
  const scope = requireScope(text, "智能文档解析", "", "火山智能文档解析价格");
  const match = scope.match(/([0-9]+(?:\.[0-9]+)?)\s*元\s*[/／]\s*页/);
  return {
    currency: "CNY",
    services: {
      intelligentDocumentParsing: {
        label: "智能文档解析",
        price: finitePrice(match?.[1], "火山智能文档解析"),
        unit: "page"
      }
    }
  };
}

export function parseAliyunSegmentationPricing(source) {
  const text = normalizeOfficialPage(source);
  const pattern = /按量付费\s+调用量\s+按量付费\s+QPS\s*限制\s+无限制\s+([0-9]+(?:\.[0-9]+)?)\s*元\s*[/／]\s*次/;
  let offset = -1, match = null;
  while ((offset = text.indexOf("通用高清分割", offset + 1)) >= 0 && !match) {
    match = text.slice(offset, offset + 5000).match(pattern);
  }
  return {
    currency: "CNY",
    services: {
      segmentHdCommonImage: {
        label: "通用高清分割",
        price: finitePrice(match?.[1], "阿里云通用高清分割按量价"),
        unit: "call"
      }
    }
  };
}

export function parseAliyunOssPricing(source) {
  const text = normalizeOfficialPage(source);
  const discountScope = requireScope(text, "官网折扣价指的是商品", "", "阿里云 OSS 官网折扣价");
  const pattern = /数据存储（本地冗余存储）[\s\S]{0,120}?([0-9]+(?:\.[0-9]+)?)\s*元\s*[/／]\s*GB\s*[/／]\s*月/;
  return {
    currency: "CNY",
    regionScope: "中国内地公共云",
    services: {
      standardLrsList: {
        label: "标准型本地冗余存储目录价",
        price: finitePrice(text.match(pattern)?.[1], "阿里云 OSS 目录价"),
        unit: "gb_month"
      },
      standardLrsWebsiteDiscount: {
        label: "标准型本地冗余存储官网折扣价",
        price: finitePrice(discountScope.match(pattern)?.[1], "阿里云 OSS 官网折扣价"),
        unit: "gb_month"
      }
    },
    billingNote: "仅作公开价格参考；实际账单受资源包、请求、流量与账户合同影响。"
  };
}

export function buildPricingSnapshot(pages, retrievedAt = new Date().toISOString()) {
  const checkedAt = retrievedAt.slice(0, 10);
  const deepseek = parseDeepSeekPricing(pages.deepseek);
  const volcengineSpeech = parseVolcengineSpeechPricing(pages.volcengineSpeech);
  const volcengineOcr = parseVolcengineOcrPricing(pages.volcengineOcr);
  const volcengineDocument = parseVolcengineDocumentPricing(pages.volcengineDocument);
  const aliyunSegmentation = parseAliyunSegmentationPricing(pages.aliyunSegmentation);
  const aliyunOss = parseAliyunOssPricing(pages.aliyunOss);
  return {
    schemaVersion: 1,
    retrievedAt,
    deepseek: { source: PRICING_SOURCES.deepseek, checkedAt, ...deepseek },
    volcengineSpeech: { source: PRICING_SOURCES.volcengineSpeech, checkedAt, ...volcengineSpeech },
    volcengineVision: {
      sources: { ocr: PRICING_SOURCES.volcengineOcr, document: PRICING_SOURCES.volcengineDocument },
      checkedAt,
      currency: "CNY",
      services: { ...volcengineOcr.services, ...volcengineDocument.services }
    },
    aliyunSegmentation: { source: PRICING_SOURCES.aliyunSegmentation, checkedAt, ...aliyunSegmentation },
    aliyunOss: { source: PRICING_SOURCES.aliyunOss, checkedAt, ...aliyunOss }
  };
}

export function validatePricingSnapshot(snapshot) {
  const prices = [
    ...Object.values(snapshot.deepseek.models).flatMap(model => [
      model.offPeak.cacheHit, model.offPeak.cacheMiss, model.offPeak.output,
      model.peak.cacheHit, model.peak.cacheMiss, model.peak.output
    ]),
    ...Object.values(snapshot.volcengineSpeech.services).map(item => item.price),
    ...Object.values(snapshot.volcengineVision.services).map(item => item.price),
    ...Object.values(snapshot.aliyunSegmentation.services).map(item => item.price),
    ...Object.values(snapshot.aliyunOss.services).map(item => item.price)
  ];
  if (prices.length !== 20 || prices.some(price => !Number.isFinite(price) || price <= 0)) {
    throw new Error("官方价格快照字段不完整，拒绝写入");
  }
  return snapshot;
}

async function fetchOfficialPages() {
  const entries = await Promise.all(Object.entries(PRICING_SOURCES).map(async ([key, url]) => {
    const response = await fetch(url, {
      headers: { "user-agent": "personal-growth-tracker-pricing-audit/1.0" },
      signal: AbortSignal.timeout(20_000)
    });
    const content = await response.text();
    if (!response.ok) throw new Error(`${key} 获取失败：HTTP ${response.status}`);
    if (/Please wait|_wafchallengeid|错误码css|You need to enable JavaScript to run this app/.test(content)) {
      throw new Error(`${key} 官方页面未返回可解析正文`);
    }
    return [key, content];
  }));
  return Object.fromEntries(entries);
}

async function readOfficialPageDirectory(directory) {
  const entries = await Promise.all(Object.keys(PRICING_SOURCES).map(async key => {
    const candidates = [".html", ".md", ".txt"].map(extension => path.join(directory, `${key}${extension}`));
    for (const file of candidates) {
      try {
        return [key, await fs.readFile(file, "utf8")];
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    throw new Error(`来源目录缺少 ${key}.html/.md/.txt`);
  }));
  return Object.fromEntries(entries);
}

function moduleSource(snapshot) {
  return `// Generated by scripts/update-provider-pricing.mjs after strict official-source validation.\nexport const OFFICIAL_PROVIDER_PRICING = Object.freeze(${JSON.stringify(snapshot, null, 2)});\n`;
}

async function run() {
  const args = new Set(process.argv.slice(2));
  const fixtureFlag = process.argv.indexOf("--fixture");
  const fixturePath = fixtureFlag >= 0 ? process.argv[fixtureFlag + 1] : "";
  const sourceDirFlag = process.argv.indexOf("--source-dir");
  const sourceDir = sourceDirFlag >= 0 ? process.argv[sourceDirFlag + 1] : "";
  if (args.has("--write") && fixturePath) throw new Error("夹具模式禁止写入正式价格快照");
  if (fixturePath && sourceDir) throw new Error("--fixture 与 --source-dir 不能同时使用");
  const pages = fixturePath
    ? JSON.parse(await fs.readFile(path.resolve(fixturePath), "utf8")).pages
    : sourceDir
      ? await readOfficialPageDirectory(path.resolve(sourceDir))
      : await fetchOfficialPages();
  const snapshot = validatePricingSnapshot(buildPricingSnapshot(pages));
  if (args.has("--write")) {
    const temporary = `${TARGET}.${process.pid}.tmp`;
    await fs.writeFile(temporary, moduleSource(snapshot), { encoding: "utf8", mode: 0o644 });
    await fs.rename(temporary, TARGET);
    console.log(`官方价格快照已更新：${path.relative(ROOT, TARGET)}`);
  } else {
    console.log(`官方价格解析通过：${Object.keys(PRICING_SOURCES).length} 个来源，未写文件`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) run().catch(error => {
  console.error(`价格更新失败，现有快照保持不变：${error.message}`);
  process.exitCode = 1;
});
